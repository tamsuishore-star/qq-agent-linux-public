// 投喂 / 赞助 / 充值 —— 关键词触发，机器人回一句感谢 + 额度充值链接。
//
// ── 为什么做成「技能（skills/，LLM 型）」而不是「插件（plugins/，确定性型）」──
// 触发条件确实能写死（关键词命中），但**回应不能写死**：
//   · 得先判断这句话到底是不是在问充值（「别充值了，浪费钱」也含「充值」两个字）；
//   · 感谢语要贴在对方那句话说出来的语气上（开玩笑的投喂 vs 真问怎么充，回法不一样）；
//   · 群友可能换着花样问（「怎么给你发额度」「能打赏吗」「你这要钱吗」），
//     关键词漏一个就永远不触发。
// 这三件事都要"理解人话"，所以按文档判据走 LLM 型（skills/）。
//
// ── 两条路，缺一条就会漏 ──────────────────────────────────────────────────
// ① 确定性注入（hooks['before-llm-messages']，主动作）
//    本轮消息里命中关键词 → 往这次请求的最后一条 user 消息尾部追加一段【充值支持】块，
//    把链接和感谢语**直接喂到模型眼前**。这条路不依赖模型"想起来调工具"，
//    是"一定会看到"的那条 —— 群里没人被 @ 的随机响应档位下也能生效。
// ② 工具兜底（api.registerTool('support_topup')）
//    关键词没命中、但模型自己判断出对方在要链接时（换着花样问的那种），可以调工具拿链接。
//
// ⚠️ 为什么不能用 manifest.prompt 常驻注入？
//    常驻提示词里如果写了链接，模型就有可能在完全没人问的时候把链接甩出来打广告。
//    README 的默认人设明确禁止这种"有求必应/主动安利"，所以链接只在命中那一轮出现。
//
// ⚠️ 在提示词里"告诉模型链接"和"让模型一定发出去"是两件事。
//    模型只把上下文里**显眼且具体**的东西当真：抽象授权（"你有充值链接可以用"）
//    它只会点头然后什么都不做。所以注入块里给的是可直接照抄的成句。

// ⚠️ 一定要显式 import fs / path。不能靠 ctx.fs 之类"也许存在"的东西：
//    顶层的 ReferenceError 会让这份技能**整个加载失败**（那种坏法很难查）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

// ── 本地收款码支持 ───────────────────────────────────────────────────────
//
// 为什么"本地图片"这条路要单独写（而不是让模型调 send_image 就行）：
//   · 核心的 send_image **工具**明确拒绝本地路径（tools.js：'本地文件路径不能发
//     （那会暴露宿主文件系统）'）。那是防"模型拿路径去读磁盘上任意文件"的闸门 ——
//     群里任何人都可能用话术骗它把配置、密钥文件发出去，所以这个闸门不能拆。
//   · 但**发图本身**完全支持本地文件：sender.sendImage(chatKey, { file }) 会传
//     file:/// 让协议端自己读磁盘（body 从 MB 级降到几十字节），失败还自动回退 base64。
//     也就是说受限的只有"模型能传任意路径"这件事，不是"发不了本地图"。
// 所以这里的做法是：**路径只来自管理员在设置里填的那一格**，模型从头到尾碰不到路径 ——
// 闸门没动，滥用面为零，而收款码照样发得出去。
//
// 另外会把图片复制一份到机器人自己的 data/sticker-images/ 受控目录：
// 那边是核心认可的本地图目录（send_sticker 只允许发这个目录里的文件），
// 而且你把原图挪走/删掉也不影响以后发送。

const SKILL_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let DATA_DIR = '';
try {
  const mod = await import(pathToFileURL(path.join(SKILL_APP_ROOT, 'src', 'config.js')).href);
  DATA_DIR = String(mod.DATA_DIR || '');
} catch (error) {
  // 取不到就按核心的算法自己算一份（QQ_AGENT_PROFILE=n → data-n/）。
  const p = String(process.env.QQ_AGENT_PROFILE ?? '').trim();
  DATA_DIR = process.env.QQ_AGENT_DATA_DIR
    || path.join(SKILL_APP_ROOT, `data${/^\d+$/.test(p) ? `-${p}` : ''}`);
  warn?.(`读不到核心的 DATA_DIR，已按默认算法兜底：${DATA_DIR}（${error?.message ?? error}）`);
}
const LOCAL_IMAGE_DIR = path.join(DATA_DIR, 'sticker-images');

/** 按字节魔数判断图片类型（不靠扩展名 —— 扩展名可以随便改）。 */
function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { ext: '.png', mime: 'image/png' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buffer.subarray(0, 6).toString('latin1').startsWith('GIF8')) return { ext: '.gif', mime: 'image/gif' };
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return { ext: '.bmp', mime: 'image/bmp' };
  return null;
}

/**
 * 读管理员配置的那一张本地图片。
 *
 * ⚠️ 这里的路径**只来自 config**，绝不接受任何来自模型/群消息的输入 ——
 * 这正是它与被核心拒绝的"send_image 收任意本地路径"之间的本质区别。
 * @returns {{ok: true, file: string, dataUrl: string, mime: string, kb: number, copied: boolean}
 *          | {ok: false, reason: string, detail: string}}
 *          reason = **可以给模型看**的短原因（不含任何磁盘路径）
 *          detail = 带给管理员看的完整信息（含路径与错误码，只进日志/排障状态）
 */
function readLocalImage({ copy = false } = {}) {
  const rawPath = String(cfg()?.localImagePath ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
  if (!rawPath) return { ok: false, reason: 'empty', detail: 'localImagePath 为空' };

  let stat;
  try {
    stat = fs.statSync(rawPath);
  } catch (error) {
    return {
      ok: false,
      reason: '那个文件找不到',
      detail: `找不到这个文件路径：${rawPath}（${error?.code ?? error?.message ?? error}）`
    };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: '那个路径不是文件', detail: `这个路径不是文件：${rawPath}` };
  }

  const maxMB = Math.max(0.2, Math.min(20, Number(cfg()?.localImageMaxMB) || 4));
  const kb = Math.round(stat.size / 1024);
  if (stat.size > maxMB * 1024 * 1024) {
    return {
      ok: false,
      reason: `那张图 ${kb}KB，超过上限 ${maxMB}MB`,
      detail: `${rawPath} 体积 ${kb}KB，超过上限 ${maxMB}MB（可在技能设置里调大 localImageMaxMB）`
    };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(rawPath);
  } catch (error) {
    return {
      ok: false,
      reason: '那个文件读不出来',
      detail: `读不到这个文件（${error?.code ?? error?.message ?? error}）—— 权限或被占用？路径：${rawPath}`
    };
  }
  const kind = sniffImage(buffer);
  if (!kind) {
    return {
      ok: false,
      reason: '那个文件按内容看不是图片',
      detail: `${rawPath} 按字节看不是图片（只认 png/jpg/gif/webp/bmp）`
    };
  }

  // 复制到受控目录：原图挪走/删掉都不影响以后发送，也符合核心"本地图只在
  // data/sticker-images/ 里发"的既有约定。
  let file = rawPath;
  let copied = false;
  if (copy) {
    try {
      fs.mkdirSync(LOCAL_IMAGE_DIR, { recursive: true });
      const target = path.join(LOCAL_IMAGE_DIR, `support-topup-pay${kind.ext}`);
      fs.copyFileSync(rawPath, target);
      file = target;
      copied = true;
    } catch (error) {
      // 复制失败不致命：原路径照样能用（sendImage 支持任意可读路径 + base64 回退）
      warn?.(`复制收款码到受控目录失败，改用原路径发送：${error?.message ?? error}`);
    }
  }
  return { ok: true, file, dataUrl: `base64://${buffer.toString('base64')}`, mime: kind.mime, kb, copied };
}

/**
 * 代码级兜底默认值 —— 与 skill.json 的 settings 保持一致。
 *
 * 为什么要有这一层（实测踩到的坑）：应用合并配置用的是
 * `getSkillConfig(id, manifest.settings)`，而它的合并是 **undefined 才回退**。
 * 用户在设置弹窗里把「触发关键词」清空保存，得到的是空串而不是缺省，
 * 于是关键词表变成空的 → matchTurn 永远不命中 → **整条注入链静默失效**
 * （不报错、不崩、就是没反应，最难查的那一类）。
 * 兜底一条空串不该让功能消失：清空 = 回到默认词表，而不是"关闭功能"。
 */
const DEFAULTS = {
  keywords: '投喂,大白饭,赞助,充值',
  thankYou: '谢谢投喂，我会继续努力哒～'
};

/** 取配置项，空串/空白按"没填"处理，回落到默认值。 */
function setting(key) {
  const v = cfg()?.[key];
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || DEFAULTS[key] || '';
}

/** 只关心本轮的"新消息"，不关心历史上下文 —— 老早提过一次不该一直被追着发链接。 */
function triggerList(ctx) {
  const raw = ctx?.triggerEntries;
  if (Array.isArray(raw)) return raw.filter((e) => e && typeof e === 'object');
  return [];
}

/** 关键词表：逗号/顿号/空格/竖线都当分隔符；去重、去空。 */
function keywordList() {
  return [...new Set(
    setting('keywords').split(/[,，、;；|\s]+/).map((s) => s.trim()).filter(Boolean)
  )];
}

/**
 * 本轮命中的消息。
 * 只看**别人**发的（e.self 是机器人自己发的），自己说过的「充值」不该触发自己。
 */
function matchTurn(ctx) {
  const words = keywordList();
  if (!words.length) return { hit: false, words: [], hits: [] };
  const hits = [];
  for (const entry of triggerList(ctx)) {
    if (entry.self) continue;
    const text = String(entry.text ?? entry.content ?? '');
    if (!text) continue;
    const matched = words.filter((w) => text.includes(w));
    if (matched.length) {
      hits.push({ who: String(entry.senderName || entry.sender || ''), text, matched });
    }
  }
  return { hit: hits.length > 0, words, hits };
}

/**
 * 收款信息：优先级 本地图片 > 网址 > 纯文字。
 *
 * 形态：
 *   fromLocal  管理员的**本地图片**（设置里填的路径，只在管理员那一格，模型碰不到）
 *   image      网络图片直链
 *   link       网页链接（支付宝收款短链之类）
 *   text       一句纯文字说明（「微信搜 138xxxx」）
 *   none       还没填
 *
 * 只认 http(s) 的老写法会把纯文字**静默丢掉** —— 用户填了「微信搜 xxx」，
 * 界面上看着填好了，机器人却一个字都发不出去，最难查的那类故障。
 * 所以这里改成：是 http(s) 就带出去，不是也照样带出去（当文字用）。
 */
function payInfo() {
  // 本地图片优先：填了这一格就说明管理员就是要发这一张。
  const localPath = String(cfg()?.localImagePath ?? '').trim();
  if (localPath) {
    const got = readLocalImage();
    if (got.ok) return { mode: 'fromLocal', value: got.file, local: got };
    // 路径填了但读不出来：**不静默退回网址**，而是把原因带出去让人看见。
    // （静默回退会让"图没发出来"变成"发了个别的"，更难查）
    // ⚠️ 只带 reason（不含路径）—— 磁盘路径不该进提示词、更不该有机会被念进群里。
    return { mode: 'localError', value: localPath, reason: got.reason, detail: got.detail };
  }

  const raw = String(cfg()?.rechargeUrl ?? '').trim();
  if (!raw) return { mode: 'none', value: '' };
  // 顺手剜掉复制粘贴时带上的首尾引号和括号
  const v = raw.replace(/^[<（(“"'\s]+/, '').replace(/[>）)”"'\s]+$/, '').trim();
  if (!v) return { mode: 'none', value: '' };
  if (/^https?:\/\//i.test(v)) {
    // 图片直链 → 单独发一张图（文字里再贴一遍长 URL 很丑）
    return { mode: /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(v) ? 'image' : 'link', value: v };
  }
  return { mode: 'text', value: v };
}

function thankYou() {
  return setting('thankYou');
}

/** 给模型看的注入块。收款方式没配好时也给一块 —— 让它**照实说**，而不是编一个出来。 */
function buildBlock(hits) {
  const pay = payInfo();
  const thanks = thankYou();
  const who = [...new Set(hits.map((h) => h.who).filter(Boolean))].join('、');
  const said = hits.map((h) => h.text).join(' / ').slice(0, 200);
  const head = '\n\n【投喂请求】'
    + (who ? `群里 ${who} ` : '')
    + `刚说到和「${[...new Set(hits.flatMap((h) => h.matched))].join('、')}」有关的事`
    + (said ? `（原话：${said}）` : '')
    + '。\n';

  const common = '处理方式（这是打招呼的场合，别端着）：\n'
    + `- 感谢语照这个来（可以按群里的语气微调一两个字）：${thanks}\n`
    + '- 一条消息说完就结束，不要分好几条、不要重复发。\n'
    + '- 收款信息一律以上面这句里的为准，**不要自己编**任何账号、金额、优惠或活动信息。\n'
    + '- 这是**群友自愿打赏**，不是商品：不要承诺任何回报、不要报价格、不要催。'
    + '对方追问细节而你不知道的，就说以收款页面为准。\n'
    + '- 如果对方只是在开玩笑、或者明确表示「不充 / 没钱」，就正常接话、别硬塞收款码 ——'
    + '这种时候发出来像在讨钱，反而招人烦。';

  if (pay.mode === 'none') {
    // 没配收款方式时也把"怎么说"和"别催"给出去：
    // 越是没东西可发，越不能让模型自由发挥（它可能顺口编一个收款账号出来）。
    return head + '但**收款方式还没配置**（管理员要去「投喂/赞助/充值」技能设置里填）。\n'
      + '照实说投喂入口还没弄好、让对方稍后再问一句就行，'
      + '**绝对不要自己编一个链接、收款码或账号出来**。\n'
      + common;
  }

  if (pay.mode === 'localError') {
    // 填了本地路径但图读不出来 —— 明确说出原因，别让机器人瞎猜、更别静默退回别的形态。
    return head + '但**管理员配置的本地收款码读不出来**：' + String(pay.reason || '未知原因') + '\n'
      + '照实说投喂入口暂时有问题、让对方稍后再问一句就行，'
      + '**绝对不要自己编一个链接、收款码或账号出来**。\n'
      + common;
  }

  if (pay.mode === 'fromLocal') {
    // 本地图这条路**不让模型碰路径**：填路径是管理员的事，发图是执行的事。
    return head
      + `- 先用 send_message 发一条感谢（内容：${thanks}）。\n`
      + '- 收款码是管理员配置的**本地图片**，已经由系统准备好，调用 support_topup（不带参数）即可，'
      + '它会返回 imageFile；把 imageFile 原样交给发送环节。\n'
      + '- 收款码图片**不要**用 send_image 发：那个工具只认网上 http(s) 直链，本地路径会被它拒绝。\n'
      + '- 你不需要、也拿不到任何磁盘路径，不要自己拼路径。\n'
      + common;
  }

  if (pay.mode === 'image') {
    return head
      + `- 先用 send_message 发一条感谢（内容：${thanks}），再单独发一张收款码图片。\n`
      + `- 收款码图片地址（照抄，不要改动）：${pay.value}\n`
      + `- 发图用 send_image，url 参数填上面这个地址；**不要**把这一长串地址当文字发出去。\n`
      + common;
  }
  if (pay.mode === 'link') {
    return head
      + `- 用 send_message 发一条，内容 = 一句感谢 + 这个收款链接，链接**原样照抄**：${pay.value}\n`
      + common;
  }
  // text：纯文字收款说明，直接照发
  return head
    + `- 用 send_message 发一条，内容 = 一句感谢 + 这段收款说明，**原样照抄**：${pay.value}\n`
    + `- 这是文字说明不是网址，不要给它加 http:// 之类的前缀，也不要改里面的账号/数字。\n`
    + common;
}

/** 把块追加到最后一条 user 消息的尾部（与 share-card / moderation 同一套做法）。 */
function injectInto(messages, block) {
  if (!block || !Array.isArray(messages) || !messages.length) return false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { m.content = `${m.content}${block}`; return true; }
    if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
  }
  return false;
}

/**
 * before-llm-messages 钩子：确定性注入。
 *
 * 为什么不在 before-context 里做：那个钩子跑在提示词组装**之前**，
 * 拿不到最终发给模型的 messages 数组，注入进去也没人看。
 */
async function onBeforeLlmMessages(ctx) {
  try {
    if (cfg()?.injectIntoPrompt === false) return;
    const turn = matchTurn(ctx);
    if (!turn.hit) return;
    // 每轮只提醒一次：同一次处理里模型可能被连续唤醒（处理期间又来消息），
    // 重复注入会让它以为"群里一直在催"，然后重复发链接。
    if (cfg()?.onlyOncePerTurn !== false) {
      const key = String(ctx?.sessionId ?? '');
      if (key && reminded.has(key)) return;
      if (key) {
        reminded.add(key);
        // 别让这个集合跟着会话数无限长：只留最近 200 个 id。
        if (reminded.size > 200) reminded.delete(reminded.values().next().value);
      }
    }
    const block = buildBlock(turn.hits);
    if (injectInto(ctx?.messages, block)) {
      log('命中「%s」→ 已注入充值支持块（会话 %s）',
        turn.hits.flatMap((h) => h.matched).join('、'), ctx?.sessionId || '?');
    }
  } catch (error) {
    warn('充值支持注入失败：' + String(error?.message || error));
  }
}

export const hooks = {
  'before-llm-messages': onBeforeLlmMessages
};

/**
 * 给排障看的运行状态（UI/日志用，模型看不到）。
 * 顺手把"链接到底配没配"这件事做成可查的 —— 静默失效最难查的就是这类。
 */
export const providers = {
  'support-topup.status': () => {
    const pay = payInfo();
    return {
      ok: true,
      configured: pay.mode !== 'none' && pay.mode !== 'localError',
      // mode 让排障一眼看出收到的是什么形态：
      //   fromLocal = 本地图片（管理员填的路径）
      //   image/link = 网址形态 / text = 纯文字收款说明
      //   none = 还没填 / localError = 填了本地路径但读不出来
      mode: pay.mode,
      keywords: keywordList(),
      // 本地路径形态下值就是路径，不是收款凭据，可以放心显示在排障信息里
      pay: pay.value,
      reason: pay.reason || '',
      // detail：含磁盘路径的完整原因，**只给管理员看**（状态视图/排障），不进提示词
      detail: pay.detail || '',
      injectedThisRun: reminded.size
    };
  }
};

/**
 * 自检：没配收款方式时**不让整个技能变成不可用**。
 *
 * 这里故意返回 ok：收款方式只是"还没填"，不是"这功能坏了"。
 * 若在这里报不可用，技能会变成灰色「依赖未就绪」，用户反而看不出真正原因
 * （真正原因是"没填"，注入块里会照实告诉机器人）。
 */
export function available() {
  return { ok: true };
}

/**
 * 发那张**本地**收款码。
 *
 * 为什么由工具直接调 ctx.sender.sendImage 而不是让模型去调 send_image：
 *   1. 模型拿不到、也不该拿到磁盘路径（这正是核心拦住 send_image 本地路径的原因）；
 *   2. 录进会话记录里，控制台的「会话」页能看到这张图确实发出去了。
 *
 * sendImage 的契约：`file` 走 file:/// 让协议端自己读磁盘（最快），
 * 读不到就自动回退 `dataUrl`（base64 内联）—— 两级都在核心内部完成。
 */
async function sendLocalPayImage(ctx) {
  if (!ctx?.sender || typeof ctx.sender.sendImage !== 'function') {
    return { ok: false, reason: '当前上下文拿不到发送能力（ctx.sender 缺失）' };
  }
  const got = readLocalImage({ copy: true });
  if (!got.ok) {
    // 完整原因（含路径）只进日志给管理员看，不进给模型的内容
    warn?.('本地收款码读不出来：' + (got.detail || got.reason));
    return { ok: false, reason: got.reason };
  }

  try {
    const r = await ctx.sender.sendImage(ctx.chatKey, { file: got.file, dataUrl: got.dataUrl }, { note: '投喂收款码' });
    try {
      ctx.session?.sent?.push({ type: 'image', text: '[图片:投喂收款码]', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
      ctx.emit?.('session-update', ctx.session?.id);
    } catch { /* 留档失败不影响已发出的图 */ }
    return { ok: true, messageId: r?.message_id ?? null, kb: got.kb, file: got.file, copied: got.copied };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 只提醒一次的会话 id 集合（进程内，热重载时随模块一起重建）。 */
const reminded = new Set();

export function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = api?.log || (() => {});
  warn = api?.warn || (() => {});

  api.registerTool({
    id: 'support_topup',
    name: '投喂收款信息',
    category: 'messaging',
    icon: '🎁',
    description: '取机器人的投喂/赞助收款信息和感谢语。'
      + '只在有人明确问到投喂/赞助/打赏、或想给机器人送点东西时用；'
      + '没人提到就别主动发，也不要拿它打广告或讨赏。'
      + '返回 result=ok 时，把 replyText 用 send_message 发出去即可；'
      + '若返回 imageUrl，那是网上直链，再用 send_image 补发那张码。'
      + '若 mode=fromLocal，收款码是**本地图片**、已由本工具直接发出（结果写在 imageSent 里），'
      + '你只要发 replyText 就行 —— 本地图不要用 send_image，它只认 http(s) 直链。'
      + 'result=not-configured 表示管理员还没填收款方式；result=image-failed 表示本地图读取或发送失败，'
      + '这两种情况都照实说入口还在弄，不要自己编账号、链接或收款码。',
    parameters: {
      type: 'object',
      properties: {
        amount: {
          type: 'string',
          description: '可选。对方提到的金额（比如「10 块」），仅用于你自己调整措辞，不会写进收款信息。'
        }
      }
    },
    async execute(ctx, args) {
      const pay = payInfo();
      const amount = String(args?.amount ?? '').trim();
      const suffix = amount ? `（对方提到：${amount}）` : '';
      const ethics = '这是群友自愿打赏，不是商品：不要承诺回报、不要报价、不要催。';

      if (pay.mode === 'none') {
        return {
          content: JSON.stringify({
            result: 'not-configured',
            replyText: '投喂入口还没弄好，稍后再问一句～',
            note: '管理员还没在「投喂/赞助/充值」技能设置里填收款方式。照实说，不要编链接、账号或收款码。' + suffix
          })
        };
      }

      if (pay.mode === 'localError') {
        return {
          content: JSON.stringify({
            result: 'image-failed',
            reason: pay.reason,
            replyText: '投喂入口暂时有点问题，稍后再问一句～',
            note: `管理员配置的本地收款码读不出来：${pay.reason}。照实说，不要编收款码。${suffix}`
          })
        };
      }

      const out = { result: 'ok', mode: pay.mode, thanks: thankYou(), note: '' };

      if (pay.mode === 'fromLocal') {
        // 直接发图，不让模型碰路径
        const sent = await sendLocalPayImage(ctx);
        out.replyText = thankYou();
        out.imageSent = sent.ok;
        out.note = sent.ok
          ? `收款码图片（本地图，约 ${sent.kb}KB）已由工具自动发出，你**不要再发图**，只把 replyText 用 send_message 发出去。`
          : `本地收款码发送失败：${sent.reason}。照实说入口暂时有问题，不要编收款码。`;
        out.note += ethics + suffix;
      } else if (pay.mode === 'image') {
        out.replyText = thankYou();
        out.imageUrl = pay.value;
        out.note = '另用 send_image 单独补发收款码图片，url 参数照抄 imageUrl，不要把这串地址当文字发。'
          + ethics + suffix;
      } else if (pay.mode === 'link') {
        out.replyText = `${thankYou()}\n收款链接：${pay.value}`;
        out.pay = pay.value;
        out.note = '链接原样照抄。' + ethics + suffix;
      } else {
        out.replyText = `${thankYou()}\n${pay.value}`;
        out.pay = pay.value;
        out.note = '这段是纯文字收款说明，原样照抄，不要加 http:// 之类的前缀、也不要改里面的账号或数字。'
          + ethics + suffix;
      }
      return { content: JSON.stringify(out) };
    }
  });
}
