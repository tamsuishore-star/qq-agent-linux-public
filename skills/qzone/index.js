// QQ 空间技能：让 AI 自己发说说（可见范围可配：所有人/仅好友/仅自己），选题来自网络热点 + 自己的评价，可配表情包。
//
// ── 底层能力从哪来 ──
// 协议端（snowluma / NapCat 系）已经实现了完整的空间动作，包括 `send_qzone_msg`
// （发表说说，走真实 emotion_cgi_publish_v6，images 参数会自动上传图片），
// 并且内部能从 NTQQ 会话取 skey/pskey 自动算 g_tk —— 不需要额外配 Cookie。
// 但核心的 28 个工具里一个空间能力都没有，所以模型被要求发空间时无工具可调。
//
// 工具拿不到 api.onebot（Skill API 是白名单），但工具执行时的 ctx 是完整上下文，
// 里面有 ctx.onebot —— 与群管理技能同一个支点。
//
// ── 隐私：为什么说说绝对不能来自群聊 ──
// 群聊是**半私密**的（就那几个人看），空间是**广播**（可能所有人可见）。把群里的
// 对话写进说说，等于替群友做了"公开"这个决定 —— 这是实打实的隐私泄露。
// 最初版本没防住这点，模型确实写了跟群聊相关的内容。现在三道拦：
//   1. 提示词：明确禁止提及任何群友、任何群聊内容
//   2. 选题来源：只从网络热点来，**不把群聊内容喂给它当选题**
//   3. 代码拦网：mentionsPersonOrChat() 命中"XX说""群里"这类痕迹就拒绝发布
// 第 3 道是粗筛、一定有漏网，所以前两道才是主力。
//
// ── 用户的硬要求，以及它们分别落在哪一层 ──
//   「可见范围可选」      → 设置项 ugcRight ∈ {1 所有人, 4 仅好友, 16 仅自己}，默认 4；工具不暴露该参数
//   「不能跟任何时政相关」 → lib/safe-topic.js 硬拦，发布前校验，命中即拒
//   「游戏/二次元/沙雕」   → lib/hot.js 题材白名单，选题阶段就过滤
//   「一周两三次，别太高」 → lib/state.js 周配额 + 最小间隔 + 冷却，写在磁盘上
//   「不能泄露群里内容」   → 提示词禁令 + 选题隔离 + mentionsPersonOrChat 兜底
//
// 一句话：**能用代码硬保证的，绝不留给提示词**。模型只负责"写什么内容"。

import { QzoneState } from './lib/state.js';
import { checkContent, mentionsPersonOrChat, isAllowedImageUrl } from './lib/safe-topic.js';
import { fetchHotTopics } from './lib/hot.js';
import { pickMemes } from './lib/meme.js';

/** 可见范围：1 所有人 / 4 仅 QQ 好友 / 16 仅自己。默认 4，工具不暴露给模型。 */
const UGC_RIGHT_VALUES = new Set([1, 4, 16]);
const UGC_RIGHT_LABELS = { 1: '所有人可见', 4: '仅 QQ 好友可见', 16: '仅自己可见' };

/** 每次执行现读设置，改完下一条立即生效。 */
function visibility() {
  const n = Number(cfg().ugcRight);
  const value = UGC_RIGHT_VALUES.has(n) ? n : 4;
  return { value, label: UGC_RIGHT_LABELS[value] };
}

/**
 * 把发布结果回执到触发命令的群/私聊。
 * 只在用户明确要求（forced=true）时调用；自动发不打扰会话。
 */
async function reportToOrigin(ctx, text) {
  try {
    const key = ctx?.chatKey;
    if (!key || !ctx?.sender?.sendTextBatch) return false;
    await ctx.sender.sendTextBatch(key, [text]);
    return true;
  } catch (error) {
    log(`[qzone] 回执发送失败：${error?.message ?? error}`);
    return false;
  }
}

// ── 转发自己的空间动态到会话 ───────────────────────────────────────────────

function selfUin(ctx) {
  return String(ctx?.selfId ?? ctx?.onebot?.selfId ?? '');
}

function htmlToText(input) {
  let s = String(input ?? '');
  if (!s) return '';
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n');
  s = s.replace(/<img\b[^>]*>/gi, '[图片]');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

const pad2 = (n) => String(n).padStart(2, '0');
function dayKey(tsSec) {
  const d = new Date(tsSec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtPostTime(tsSec) {
  if (!tsSec) return '时间未知';
  return new Date(tsSec * 1000).toLocaleString('zh-CN', { hour12: false });
}
function postLink(uin, tid) {
  return uin && tid ? `https://user.qzone.qq.com/${uin}/mood/${tid}` : '';
}

/** 拉取自己最近的说说：优先用本技能发布历史（NapCat 不支持 get_qzone_msg_list）。 */
async function fetchMyPosts(ctx, num = 50) {
  const rows = state?.history ? state.history(num) : [];
  return rows.map((p) => {
    const realTid = p.tid ? String(p.tid) : '';
    return {
      tid: realTid || `local-${p.ts}`,
      linkTid: realTid,
      ts: Math.floor((Number(p.ts) || 0) / 1000),
      text: String(p.content || '').slice(0, 800),
      images: p.image ? [String(p.image)] : [],
      isPrivate: String(p.visibility || '').includes('仅自己')
    };
  }).filter((p) => p.ts > 0);
}

/** 把一条动态（正文 + 配图 + 链接）发到当前会话。 */
async function forwardPost(ctx, post) {
  if (!ctx?.chatKey || !ctx?.sender?.sendTextBatch) throw new Error('当前没有可发送的会话');
  const uin = selfUin(ctx);
  const lines = [`📱 QQ空间动态 · ${fmtPostTime(post.ts)}`, '', post.text || '（这条只有图片或表情）'];
  const linkTid = post.linkTid || (/^\d+$/.test(String(post.tid || '')) ? post.tid : '');
  const link = postLink(uin, linkTid);
  if (link) lines.push('', link);
  await ctx.sender.sendTextBatch(ctx.chatKey, [lines.join('\n')]);
  let images = 0;
  for (const url of (post.images || []).slice(0, 6)) {
    try {
      await ctx.sender.sendImage(ctx.chatKey, { url });
      images += 1;
    } catch (error) {
      log(`[qzone] 转发配图失败（${url}）：${error?.message ?? error}`);
    }
  }
  return { images, link };
}

let cfg = () => ({});
let log = () => {};
let fetchImpl = null;
let state = null;

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

function num(key, fallback, min, max) {
  const n = Number(cfg()[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function rules() {
  return {
    maxPerWeek: num('maxPerWeek', 3, 1, 14),
    minGapDays: num('minGapDays', 2, 0, 30),
    cooldownHours: num('cooldownHours', 18, 0, 720)
  };
}

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  fetchImpl = typeof api.fetch === 'function' ? (...a) => api.fetch(...a) : null;
  state = new QzoneState();

  // ── 工具一：找选题（只给网络热点，不给群聊内容）─────────────────────────
  api.registerTool({
    id: 'fetch_qzone_topics',
    name: '找空间选题',
    description: '抓取当前网络热点作为发说说的选题素材。返回的都是已过滤的（只保留游戏/二次元/沙雕搞笑/科技玩梗，时政与社会新闻已剔除）。拿到后挑一个你真有想法的，写成自己的口吻再用 publish_qzone_post 发出。**注意：说说的话题只能来自这里或你自己的念头，不能写群里发生的事、不能提任何群友**。不要照抄标题，也不要罗列多条——挑一条说你自己的看法。没有合适的就如实说今天没什么好发的，别硬凑。',
    category: 'media',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回几条素材，默认 12' }
      }
    },
    async execute(ctx, args) {
      try {
        if (!fetchImpl) return err('本技能缺少网络权限（需要在 skill.json 声明 web_fetch）');
        const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 30);
        const { items, errors } = await fetchHotTopics(fetchImpl, { limit });
        const recent = state.recentTopics(8);
        if (!items.length) {
          return ok({
            found: false,
            errors,
            note: '这次没抓到可用的选题（可能接口抽风，或者热点里没有适合你的题材）。如实说今天没什么好发的，不要编造热点，也不要拿群里的事凑数。'
          });
        }
        return ok({
          count: items.length,
          topics: items.map((i) => ({ 标题: i.title, 简介: i.desc, 来源: i.source, 题材: i.topics })),
          recentPosted: recent,
          errors: errors.length ? errors : undefined,
          note: '挑一条你真有想法的，用你自己的口吻写，别照抄标题、别写成新闻通稿。'
            + '**不要提任何群友、不要写群里聊了什么、不要用群里的事当话题**——这是发到空间给所有好友看的，不是群消息。'
            + (recent.length ? '上面 recentPosted 是你最近发过的，别重复同样的题材。' : '')
            + '写好后调 publish_qzone_post 发布。'
        });
      } catch (error) {
        return err(`抓选题失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 工具二：挑表情包配图 ────────────────────────────────────────────────
  api.registerTool({
    id: 'pick_qzone_meme',
    name: '找配图表情包',
    description: '从表情包图库挑几张候选图，用于给说说配图。可以传 keyword（按图上的文案关键词，如"加班""摸鱼""可爱"）和 category（图库分类，如"DeepSeek娘"）。挑好后把选中那条的 url 传给 publish_qzone_post 的 image 参数。也可以不配图——纯文字说说同样正常。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '按图上文案的关键词筛选，如"摸鱼""加班""可爱"' },
        category: { type: 'string', description: '按图库分类筛选' },
        limit: { type: 'integer', description: '返回几个候选，默认 5' }
      }
    },
    async execute(ctx, args) {
      try {
        if (!fetchImpl) return err('本技能缺少网络权限（需要在 skill.json 声明 web_fetch）');
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
        const r = await pickMemes(fetchImpl, {
          keyword: String(args.keyword || ''),
          category: String(args.category || ''),
          limit
        });
        if (!r.items.length) {
          return ok({ found: false, error: r.error || '没匹配到图', note: '没找到合适的配图，那就发纯文字的说说，不配图也完全没问题。' });
        }
        return ok({
          count: r.items.length,
          total: r.total,
          matched: r.matched,
          candidates: r.items.map((e) => ({ 图上文案: e.title, 分类: e.category, url: e.original })),
          note: '挑一张跟说说内容搭的，把它的 url 传给 publish_qzone_post 的 image 参数。也可以都不选，纯文字发。'
        });
      } catch (error) {
        return err(`找配图失败：${error?.message ?? error}（不配图也能发，直接发纯文字即可）`);
      }
    }
  });

  // ── 工具三：发布说说 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'publish_qzone_post',
    name: '发说说',
    description: '把一段内容发到自己的 QQ 空间（说说）。可见范围由技能设置决定（所有人可见 / 仅 QQ 好友 / 仅自己，默认仅好友），模型不要传该参数。内容必须是游戏、二次元、沙雕搞笑、科技玩梗这类轻松话题，并带上你自己的评价或吐槽。**绝对不能写群里发生的事、不能提任何群友、不能引用群聊内容**（空间是广播、可能所有人可见，写群聊等于泄露别人隐私）。**任何时政、社会新闻、灾难事故、民族宗教内容都会被拒绝**，被拒了不要照原样重试，换个安全话题重写。可选传 image 配一张表情包（先用 pick_qzone_meme 拿 url）。频率限制只拦"你自己想发"的情况；**用户明确要求你发时传 forced=true，不受频率限制**。传了 forced 后，工具会自动把说说内容回执到当前群/私聊，你不用再复述。',
    category: 'media',
    icon: '📮',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文。写成你自己的口吻，100~300 字最合适，最多 1000 字。不要堆话题标签，不要写成新闻通稿，不要提群里的人和事' },
        image: { type: 'string', description: '可选：配图 URL，从 pick_qzone_meme 拿。留空则发纯文字' },
        topicTitle: { type: 'string', description: '这条说说依据的热点标题（如果来自 fetch_qzone_topics）。自己原创的就不传' },
        source: { type: 'string', description: '素材来源，如"B站热门"' },
        mood: { type: 'string', description: '可选：情绪基调，如"吐槽""感慨""整活"' },
        forced: { type: 'boolean', description: '用户**明确要求**你发一条时传 true：这次不受频率限制（不占本周配额、不触发冷却），方便随时测试。你自己想发（没人要求）时必须省略或传 false。' }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      try {
        const content = String(args.content ?? '').trim();
        if (!content) return err('说说正文不能为空');
        if (content.length > 1000) return err(`正文太长了（${content.length} 字），说说最多 1000 字，压缩到 300 字以内更好。`);

        // ① 时政闸门（硬拦）—— 不区分来源，强制发也照查
        const safe = checkContent(content);
        if (!safe.ok) {
          return err(`这条内容里有不能发的东西（命中：「${safe.hit}」）。空间里不能出现任何时政、社会新闻、灾难事故、民族宗教相关的内容。`
            + '请换一个游戏 / 二次元 / 沙雕搞笑 / 科技玩梗的话题重写，不要试图绕开这个词，也不要把这句话再发一次。');
        }

        // ② 隐私闸门（硬拦）—— 同样不区分来源
        const leak = mentionsPersonOrChat(content);
        if (leak) {
          return err(`这条内容提到了人或群聊（「${leak}」），不能发。`
            + `空间是广播（当前可见范围：${visibility().label}），写群里的人和事可能把群友的聊天记录公开出去。`
            + '请改成只谈公共话题（游戏 / 动画 / 梗 / 科技），用自己的口吻写，不要出现任何群友、也不要复述群里聊了什么。');
        }

        // ③ 频率闸门 —— **只在自动发时生效**。
        //    用户明确要求发的（forced）跳过它：否则手动测一次得等两天，功能没法调试。
        const forced = args.forced === true;
        const r = rules();
        const gate = state.canPost(r);
        if (!forced && !gate.allowed) {
          return err(`现在还不能发：${gate.reason} 如果这是用户明确要你发的，请带 forced=true 再调一次；否则不要重试，如实说还没到时候就行。`);
        }

        // ④ 配图校验（白名单域名，防 SSRF / 盗链）
        let image = String(args.image ?? '').trim();
        let imageNote = '';
        if (image && !isAllowedImageUrl(image)) {
          imageNote = '（给的配图地址不在允许的图床白名单里，已忽略，改发纯文字）';
          image = '';
        }

        // ⑤ 发布。带图失败就退纯文字 —— 不能让"配图出了岔子"导致整条说说发不出去。
        const vis = visibility();
        const post = async (withImage) => ctx.onebot.call('send_qzone_msg', {
          content,
          ...(withImage ? { images: [withImage] } : {}),
          ugc_right: vis.value
        });

        let resp = null;
        let attached = false;
        try {
          resp = await post(image || null);
          attached = !!image;
        } catch (e) {
          if (!image) { state.markAttempt(); return err(`发布失败：${e?.message ?? e}`); }
          log(`[qzone] 带图发布失败，退回纯文字：${e?.message ?? e}`);
          imageNote = `（配图上传失败，已改发纯文字：${e?.message ?? e}）`;
          try {
            resp = await post(null);
          } catch (e2) {
            state.markAttempt();
            return err(`发布失败：${e2?.message ?? e2}`);
          }
        }

        const tid = resp?.tid ?? resp?.data?.tid ?? resp?.data?.data?.tid ?? null;
        // counted=false 的（forced）不占周配额、不触发冷却，只留个痕迹便于排查
        state.recordPost({
          content,
          title: args.topicTitle || '',
          tid,
          source: args.source || '',
          mood: args.mood || '',
          image: attached && image ? image : '',
          visibility: vis.label,
          counted: !forced
        });
        state.markAttempt();

        const gateAfter = state.canPost(r);
        const weekNow = forced ? gate.weekCount : gate.weekCount + 1;
        log(`[qzone] 已发说说 长度=${content.length} 配图=${attached ? '有' : '无'} tid=${tid ?? '未知'} `
          + `${forced ? '（用户强制，不计数）' : `本周第 ${weekNow} 条`}`);

        // ⑥ 用户命令触发的发布：把刚发的动态自动转发到当前群/私聊
        let reported = false;
        let forwardedImages = 0;
        if (forced) {
          try {
            const fr = await forwardPost(ctx, {
              tid: tid != null ? String(tid) : '',
              ts: Math.floor(Date.now() / 1000),
              text: content,
              images: attached && image ? [image] : []
            });
            reported = true;
            forwardedImages = fr.images;
          } catch (e) {
            log(`[qzone] 自动转发到会话失败：${e?.message ?? e}`);
          }
        }

        return ok({
          posted: true,
          visibility: vis.label,
          length: content.length,
          withImage: attached,
          forced,
          counted: !forced,
          reportedToChat: reported,
          forwardedImages,
          tid: tid != null ? String(tid) : null,
          weekCount: weekNow,
          maxPerWeek: r.maxPerWeek,
          nextAllowed: gateAfter.nextAllowedAt
            ? new Date(gateAfter.nextAllowedAt).toLocaleString('zh-CN', { hour12: false })
            : null,
          note: (imageNote ? imageNote + ' ' : '')
            + (forced ? '（这条是用户明确要求发的，没占本周配额，也不影响下次自动发的时间。）' : '')
            + (forced
              ? (reported ? '已把说说正文、配图和链接自动转发到当前会话，你不用再复述全文。' : '自动转发失败（不影响空间发布），可以简短告知用户已发布。')
              : '')
            + '已经发出去了。回复里不要复述整段内容，也别播报"我发了条说说"这种机器话，正常接话或简单说一句就行。'
        });
      } catch (error) {
        return err(`发布失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 工具四：列出自己的空间动态（供 AI 判断转发哪一天） ────────────────
  api.registerTool({
    id: 'list_my_qzone_posts',
    name: '查看我的空间动态',
    description: '列出机器人自己最近发过的 QQ 空间动态（含日期、正文摘要、配图数、tid）。用户说“把你前天的说说转发到群里”“转发你最近那条动态”时，先用它确认是哪一条，再调 forward_qzone_post。只读，不会发布或修改。',
    category: 'media',
    icon: '🗂️',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '看最近几天，默认 7，最多 30' },
        limit: { type: 'integer', description: '最多返回几条，默认 10，最多 20' }
      }
    },
    async execute(ctx, args) {
      try {
        const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
        const posts = await fetchMyPosts(ctx, 50);
        const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
        const list = posts
          .filter((p) => p.ts >= cutoff)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, limit)
          .map((p) => ({
            tid: p.tid,
            日期: dayKey(p.ts),
            时间: fmtPostTime(p.ts),
            内容: p.text.slice(0, 200) || '（图片/表情）',
            图片数: p.images.length,
            可见性: p.isPrivate ? '仅自己' : '公开/好友',
            链接: postLink(selfUin(ctx), p.tid)
          }));
        return ok({
          动态: list,
          note: '要转发某条，调 forward_qzone_post，传 tid；也可以传 daysAgo（0今天/1昨天/2前天）或 date（YYYY-MM-DD）。'
        });
      } catch (e) {
        return err(`读取空间动态失败：${e?.message ?? e}`);
      }
    }
  });

  // ── 工具五：转发一条空间动态到当前会话 ───────────────────────────────
  api.registerTool({
    id: 'forward_qzone_post',
    name: '转发空间动态',
    description: '把机器人自己 QQ 空间里的一条动态（正文+配图+链接）转发到当前群/私聊。用户要求“转发你前天的说说”“把你最近的空间动态发到群里”时用。用户指定日期时优先传 date 或 daysAgo；不确定是哪条就先调 list_my_qzone_posts。只转发一条，除非用户明确要求多条。',
    category: 'media',
    icon: '📤',
    parameters: {
      type: 'object',
      properties: {
        tid: { type: 'string', description: '要转发的动态 id（list_my_qzone_posts 返回）' },
        daysAgo: { type: 'integer', description: '0=今天，1=昨天，2=前天……按本地日期匹配；不传则取最近一条' },
        date: { type: 'string', description: 'YYYY-MM-DD，指定某一天；优先于 daysAgo' },
        note: { type: 'string', description: '可选：转发时附一句话' }
      }
    },
    async execute(ctx, args) {
      try {
        const posts = await fetchMyPosts(ctx, 50);
        if (!posts.length) return err('空间里还没有可转发的动态。');
        let target = null;
        const tid = String(args.tid || '').trim();
        if (tid) target = posts.find((p) => p.tid === tid) || null;
        if (!target && args.date) {
          const key = String(args.date).trim();
          target = posts.find((p) => dayKey(p.ts) === key) || null;
        }
        if (!target && args.daysAgo != null) {
          const d = new Date();
          d.setDate(d.getDate() - Number(args.daysAgo));
          const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
          target = posts.find((p) => dayKey(p.ts) === key) || null;
        }
        if (!target) target = posts.sort((a, b) => b.ts - a.ts)[0];
        if (!target) return err('没找到对应的动态。');
        const r = await forwardPost(ctx, target);
        if (args.note) {
          try { await ctx.sender.sendTextBatch(ctx.chatKey, [String(args.note)]); } catch { /* 附言失败不影响转发 */ }
        }
        return ok({
          forwarded: true,
          tid: target.tid,
          日期: dayKey(target.ts),
          时间: fmtPostTime(target.ts),
          配图: r.images,
          链接: r.link,
          note: '已转发到当前会话，不要重复粘贴正文。'
        });
      } catch (e) {
        return err(`转发失败：${e?.message ?? e}`);
      }
    }
  });

  // ── 工具六：查状态 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'qzone_status',
    name: '查看空间状态',
    description: '查看 QQ 空间的发布状态：现在能不能发、下次什么时候能发、最近发过哪些。用户问"你空间发了吗""下次什么时候发""你都发过什么"时用它。',
    category: 'media',
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        history: { type: 'integer', description: '要列出最近几条发布记录，默认 5，最多 20' }
      }
    },
    async execute(ctx, args) {
      try {
        const r = rules();
        const gate = state.canPost(r);
        const n = Math.min(Math.max(Number(args.history) || 5, 0), 20);
        const hist = n ? state.history(n).map((p) => ({
          time: new Date(p.ts).toLocaleString('zh-CN', { hour12: false }),
          话题: p.title || '（原创）',
          来源: p.source || '',
          情绪: p.mood || '',
          计入配额: p.counted !== false,
          tid: p.tid || null,
          摘要: String(p.content || '').slice(0, 60)
        })) : [];
        return ok({
          canPostNow: gate.allowed,
          reason: gate.reason || '现在可以发。',
          weekCount: gate.weekCount,
          maxPerWeek: r.maxPerWeek,
          minGapDays: r.minGapDays,
          nextAllowedAt: gate.nextAllowedAt ? new Date(gate.nextAllowedAt).toLocaleString('zh-CN', { hour12: false }) : null,
          visibility: visibility().label,
          note: '用户明确要求发时传 forced=true 可跳过频率限制（不计数）。',
          recent: hist
        });
      } catch (error) {
        return err(`查询失败：${error?.message ?? error}`);
      }
    }
  });
}

/**
 * 调度层：到点了就提醒模型去发一条说说。
 *
 * 为什么需要它 —— "一周两三次"如果只靠对话触发，就变成"用户想起来才发"，
 * 与"AI 自主发"的诉求不符。技能没有独立定时器，所以反过来利用现有唤醒机制：
 * 群聊每条消息都会跑一轮，这个 hook 每轮检查一次是不是该发了，是就塞一句提醒。
 *
 * ⚠️ 提醒里**刻意把"发空间"和"群里聊天"切开**：
 * 早期版本那句"不想发就正常聊你的天"会让模型把两件事连起来，结果它把群聊内容
 * 写进了说说（泄露群友聊天）。现在的措辞明确要求换个脑子：话题只从网络热点来。
 */
export const hooks = {
  async 'before-llm-messages'(ctx) {
    if (!state) return;
    const messages = Array.isArray(ctx?.messages) ? ctx.messages : null;
    if (!messages?.length) return;

    const r = rules();
    const gate = state.canPost(r);
    if (!gate.allowed) return;

    // 节流：短时间内的多轮唤醒只提醒一次，别把上下文刷满
    const now = Date.now();
    const lastNotice = Number(state.data.lastNotice) || 0;
    const noticeGapMs = Math.max(1, num('noticeGapHours', 6, 1, 168)) * 3600000;
    if (now - lastNotice < noticeGapMs) return;
    state.data.lastNotice = now;
    try { state.markAttempt(); } catch { /* 节流失败不影响提醒 */ }

    const recent = state.recentTopics(6);
    const nudge = '\n\n[系统提示·没人要求你做任何事] 你的 QQ 空间有阵子没更新了，'
      + `本周还没发满（上限 ${r.maxPerWeek} 条），现在是发一条的好时机。`
      + '发的话：先调 fetch_qzone_topics 看看网上有什么热点，挑一条你真想吐槽/感慨的，'
      + `写成你自己的口吻（别写成新闻稿），再调 publish_qzone_post 发出去——可见范围由技能设置决定（当前：${visibility().label}），不用你设置。`
      + '想配图就先调 pick_qzone_meme 挑一张表情包，把 url 传给 image 参数。'
      // 这段是隐私防线的关键：明确切断"群聊 → 说说"的联想
      + '**注意：说说的话题只能来自网络热点或你自己的想法，不要写群里刚聊的事、不要提任何群友、不要复述任何人的话。**'
      + '空间是广播（可能所有人可见），把群聊写进去等于替群友做了公开的决定。'
      + '内容只能是游戏、二次元、沙雕搞笑、科技玩梗这类轻松话题，任何时政相关的一律不行。'
      + (recent.length ? `你最近发过这些，别重复：${recent.join('；')}。` : '')
      + '不想发也完全可以，那就当没看见这条提醒。'
      + '（这条只是提醒，发不发你自己判断。）';

    const last = messages[messages.length - 1];
    if (last && typeof last.content === 'string') last.content += nudge;
    log(`[qzone] 已注入发空间提醒（本周 ${gate.weekCount}/${r.maxPerWeek}）`);
  }
};