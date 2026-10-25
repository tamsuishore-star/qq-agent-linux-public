// 发 QQ 空间技能（LLM 型）—— 把群友要求的内容发成一条说说。
//
// ── 设计要点 ──────────────────────────────────────────────────────────────
//   · 走协议端原生接口 send_qzone_msg，不需要浏览器 / 鼠标 / 外部程序
//   · 与「记忆互通」插件（memory-sync）联动，这是本技能最关键的一段逻辑：
//       记忆插件**没生效** → 正文加前缀【当前群名 / 对方昵称】
//       记忆插件**生效**   → 发原文，不加前缀
//     判定是运行时查询（不是配置项）—— 用户随时把记忆插件关掉/打开，
//     前缀行为跟着变，不需要改这个技能的任何设置。
//
//     双重判定，两个都查：
//       a) api.isSkillActive('memory-sync')  —— 插件是否被启用
//       b) api.hasCapability('memory.shared-store') —— 共享记忆存储是否真的在
//     任一为假就按"没互通"处理（保守：宁可多一个前缀，也不要漏掉归属）。
//     同时这也是 memory-sync 那个自建能力的**消费方** —— 没有这一句，
//     它就会被审计判为孤儿能力（文档 §5）。
//   · 前缀取的是**当前会话**的名字（群聊取群名、私聊取对方昵称），
//     永远不是"群里某个人"的名字 —— 空间归属跟随会话，不跟随发言人。
//   · 配置一律执行时用 cfg() 现读（setup 时快照会导致改了设置不生效）
//   · available() 是同步函数（异步探测走的不是这条链）

const BUILD_TAG = 'v1.0.0';

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let isSkillActive = () => false;
let hasCapability = () => false;

/** 记忆互通插件的 id —— 前缀兼容逻辑就是围绕它转的。 */
const MEMORY_SYNC_ID = 'memory-sync';
/** 记忆互通插件提供的能力名（共享记忆存储）。 */
const MEMORY_STORE_CAP = 'memory.shared-store';

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  isSkillActive = api.isSkillActive || (() => false);
  hasCapability = api.hasCapability || (() => false);

  api.registerTool({
    id: 'qzone_post',
    name: '发 QQ 空间',
    description:
      '把一段文字发成一条 QQ 空间说说。当群友说「发个空间」「发条说说」「发空间」「投稿空间」「发个动态」时使用；'
      + '内容是群友要发的原文，不要自己发挥、不要加话题或表情。'
      + '群友没明确要求发空间时不要调用这个工具。'
      + 'content 传要发的正文（不含前缀，前缀由本工具按当前会话自动处理）；'
      + 'images 只在群友明确给了图片地址时才填。',
    category: 'media',
    icon: '🌟',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '要说说的正文。原样保留群友的措辞，不要改写、不要补充解释。不要自己加【】前缀。'
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：图片地址数组。仅当群友明确提供了图片链接时才填，最多 9 张。'
        }
      },
      required: ['content']
    },

    async execute(ctx, args) {
      const settings = readSettings();

      // ── 1) 参数校验：模型可能给空值、超长、越界 ──────────────────────────
      const raw = String(args?.content ?? '').trim();
      if (!raw) return fail('没给正文：请把要发到空间的那段文字放进 content。');
      if (raw.length > settings.maxChars) {
        return fail(`正文太长（${raw.length} 字，上限 ${settings.maxChars} 字），请压缩后再发。`);
      }

      const images = settings.allowImages ? normalizeImages(args?.images) : [];
      if (!settings.allowImages && Array.isArray(args?.images) && args.images.length) {
        warn('群友给了图片地址，但「允许带图片」没开，本次只发了文字。');
      }

      // ── 2) 演练模式：只回正文，**不碰任何外部接口** ──────────────────────
      // 放在前缀解析之前是刻意的：演练模式要能在协议端没连上、群号不存在时
      // 也能用（调 get_group_info 取群名属于外部请求，演练模式一次都不该发）。
      if (settings.dryRun) {
        const who = memorySharedForPreview(ctx);
        const preview = who === null
          ? raw
          : `【${who}】${raw}`;
        return {
          content:
            `【演练模式】本来要发这条说说（正文 ${preview.length} 字）：\n\n${preview}\n\n`
            + (who === null
              ? '（记忆互通已生效，实际发送时不加前缀。）'
              : '（记忆互通未生效，括号里是前缀占位；实际发送时会换成当前会话的真实群名/昵称。）')
            + '\n没有真的发出，也没有请求任何接口。'
        };
      }

      // ── 3) 处理前缀（与记忆互通插件联动）─────────────────────────────────
      let prefix = '';
      let prefixReason = '';
      const memoryShared = safeIsSkillActive(ctx);

      if (!memoryShared) {
        const who = await resolveChatLabel(ctx);
        if (who) {
          prefix = `【${who}】`;
          prefixReason = `记忆互通未生效，已按当前会话加上前缀 ${prefix}`;
        } else {
          prefixReason = '记忆互通未生效，但没能取到会话名称，本次按原文发送';
          warn(prefixReason);
        }
      } else {
        prefixReason = '记忆互通已生效，按原文发送（不加前缀）';
      }

      const body = `${prefix}${raw}`;

      // ── 4) 真发：唯一的写操作，失败必须让模型看见 ────────────────────────
      const params = { content: body, ugc_right: settings.ugcRight };
      if (images.length) params.images = images;

      try {
        await ctx.onebot.call('send_qzone_msg', params);
      } catch (error) {
        // error 文本只进日志，不进群（可能含内部细节）；群里给一句人话。
        log(`发说说失败：${describeError(error)}  正文=${JSON.stringify(body).slice(0, 200)}`);
        return fail(`发空间失败：${humanizeError(error)}。可以稍后重试，或让管理员看控制台日志。`);
      }

      log(`已发说说（${body.length} 字，${prefixReason}）`);

      return {
        content:
          `已发到 QQ 空间（共 ${body.length} 字）。${prefixReason}。`
          + '不要再把正文复述一遍发到群里，也不必再调发送类工具——一句话告诉群友发好了即可。'
      };
    }
  });

  log(`发 QQ 空间技能已加载（${BUILD_TAG}）`);
}

// ── 前缀相关 ──────────────────────────────────────────────────────────────

/**
 * 记忆互通此刻是否生效 —— 双闸判定，任一为假都按"没互通"处理。
 *
 * 包一层 try/catch：查询本身出问题不该让整个工具失败，
 * 失败时按"没互通"处理（更保守：宁可加前缀，也不要漏掉归属）。
 */
function safeIsSkillActive(ctx) {
  let active = false;
  try {
    active = Boolean(isSkillActive(MEMORY_SYNC_ID, ctx));
  } catch (error) {
    warn(`查询记忆互通启用状态失败：${describeError(error)}`);
    return false;
  }
  if (!active) return false;

  try {
    if (!hasCapability(MEMORY_STORE_CAP)) {
      warn(`记忆互通插件已启用，但能力 ${MEMORY_STORE_CAP} 没有提供者，按未互通处理`);
      return false;
    }
  } catch (error) {
    warn(`查询共享记忆能力失败：${describeError(error)}`);
    return false;
  }
  return true;
}

/**
 * 演练模式用的前缀预览：不发任何外部请求，所以取不到真实群名/昵称。
 * 返回 null 表示"记忆已互通，不加前缀"；返回字符串表示会加上的前缀占位。
 */
function memorySharedForPreview(ctx) {
  if (safeIsSkillActive(ctx)) return null;
  const kind = String(ctx?.kind || '');
  if (kind === 'group') return '群名';
  if (kind === 'private') return '对方昵称';
  return '会话名';
}

/**
 * 当前会话的显示名：群聊取群名，私聊取对方昵称。
 *
 * ⚠️ 语义要点：取的是**会话本身**的名字，不是消息发送人的名字。
 * 群里某个人让机器人发空间，前缀仍然是这个群的名字 —— 空间归属跟着会话走。
 *
 * 取不到就返回空串（调用方会退化成"不加前缀"），绝不抛错。
 */
async function resolveChatLabel(ctx) {
  const kind = String(ctx?.kind || '');
  const chatId = String(ctx?.chatId || '');

  if (kind === 'group') {
    // 群名优先从 OneBot 查；查不到就退回群号
    try {
      const info = await ctx.onebot.call('get_group_info', { group_id: Number(chatId) });
      const name = pickFirst(info, ['group_name', 'groupName', 'name']);
      if (name) return String(name).trim();
    } catch (error) {
      warn(`取群名失败（群 ${chatId}），退回群号：${describeError(error)}`);
    }
    return chatId ? `群${chatId}` : '';
  }

  if (kind === 'private') {
    try {
      const info = await ctx.onebot.call('get_stranger_info', { user_id: Number(chatId) });
      const name = pickFirst(info, ['nickname', 'nick', 'name']);
      if (name) return String(name).trim();
    } catch (error) {
      warn(`取私聊昵称失败（QQ ${chatId}），退回 QQ 号：${describeError(error)}`);
    }
    return chatId || '';
  }

  // 未知渠道（未来可能出现）：不猜名称，退化成不加前缀
  warn(`未知会话类型 kind=${JSON.stringify(kind)}，本次不加前缀`);
  return '';
}

/** 从对象里按候选键顺序取第一个非空字符串。返回 null 表示都没有。 */
function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// ── 配置与参数 ────────────────────────────────────────────────────────────

const DEFAULT_MAX_CHARS = 1000;
const MIN_MAX_CHARS = 20;
const MAX_MAX_CHARS = 5000;
const ALLOWED_UGC_RIGHT = [1, 4, 16];

/** 每次执行现读（用户改完设置立刻生效）。 */
function readSettings() {
  const c = cfg() || {};
  const ugc = Number(c.ugcRight);
  return {
    maxChars: clamp(Number(c.maxChars) || DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS),
    ugcRight: ALLOWED_UGC_RIGHT.includes(ugc) ? ugc : 1,
    allowImages: c.allowImages === true,
    dryRun: c.dryRun === true
  };
}

/** 图片地址：只接受 http(s) 字符串，去重、截断到 9 张。 */
function normalizeImages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    const url = String(item ?? '').trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (out.includes(url)) continue;
    out.push(url);
    if (out.length >= 9) break;
  }
  return out;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

// ── 返回值与错误 ──────────────────────────────────────────────────────────

/** 失败一律走 isError（不抛错）—— 抛错会被上层兜成通用错误，模型拿不到有用信息。 */
function fail(message) {
  return { content: message, isError: true };
}

function describeError(error) {
  if (!error) return '未知错误';
  return String(error.message || error);
}

/** 给模型/群里看的错误文案：去掉可能含内部细节的部分。 */
function humanizeError(error) {
  const text = describeError(error);
  if (/timeout|timed out|超时/i.test(text)) return '接口超时了';
  if (/retcode|HTTP \d{3}/i.test(text)) return '协议端返回了错误';
  if (/network|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(text)) return '连不上协议端';
  return '协议端拒绝了这次发表';
}

export function available() {
  return { ok: true };
}
