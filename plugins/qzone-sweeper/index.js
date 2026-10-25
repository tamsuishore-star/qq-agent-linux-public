// 空间互动（刷动态 / 点赞 / 评论）—— 插件（QQ Agent 规范，确定性型）
//
// ── 这个插件解决什么 ────────────────────────────────────────────────────
// 项目里原有的 `skills/qzone` 只让机器人**发**自己的说说（好友可见），
// 它一个"看别人的"接口都没有：核心 28 个工具里没有任何空间读接口。
// 于是"去空间逛逛、给朋友点个赞、回一句"这件事在机器人身上是做不到的。
//
// 本插件补上三件事：
//   ① 看 —— get_qzone_feeds（好友动态）→ get_qzone_msg_list（拉出正文与 tid）
//   ② 互动 —— like_qzone / comment_qzone（评论即"回复某条说说"）
//   ③ 节奏 —— 每小时/每日上限、最小间隔、去重，全部落盘硬拦（lib/state.js）
//
// ── 为什么是 plugins/ 而不是 skills/ ─────────────────────────────────────
// 按项目约定（src/skills/manifest.js 的 DIR_KIND 注释）：
//   skills/  = LLM 型：注册工具，用不用、什么时候用由模型判断
//   plugins/ = 确定性型：提供能力或钩子，**条件满足就必然执行**，不经模型
//
// 这个需求里有一半是"必须到点自己发生"的：用户要的是机器人**主动**去刷空间
// （定时那一半），而不是"用户问了才动"。那半只能靠钩子实现 —— 钩子是
// plugins/ 的形态。既然无论如何都要落在这里（一个目录里放一份自包含的实现），
// 就按插件规范来，同时保留工具那半给模型手动调用。所以：
//   · hooks['before-llm-messages']  → 到点了必然注入提醒（确定性的那一半）
//   · registerTool(scan/like/comment/status) → 用户开口时模型自己调（LLM 的那一半）
//   两型在加载器里走同一条 normalizeManifest，功能完全等价，只是语义分类不同。
//
// ── 硬约束落在哪一层（沿用 qzone 技能的"能用代码保证的绝不留给提示词"）──
//   「一天别点太多」「别连着评论」   → lib/state.js 配额 + 间隔，写盘
//   「同一条别评两遍」               → lib/state.js 去重表，写盘
//   「别在别人空间底下发表敏感言论」 → lib/utils.js checkComment，命中即拒
//   「别 @ 群友、别把 QQ 号带出去」  → lib/utils.js stripMentions，写进正文前抹掉
//   「太老的说说别去互动」           → scan 按 maxPostAgeHours 过滤
//   模型只负责"这一条我要不要理、评论写什么"。

import { SweepState } from './lib/state.js';
import {
  htmlToText, oneLine, stripMentions, checkComment, looksEmpty,
  parseIdList, inQuietHours, fmtTime, fmtAgo
} from './lib/utils.js';

const PLUGIN_ID = 'qzone-sweeper';

/** 工具分类统一用 core 里真实存在的那几类（见 src/tool-registry.js 的 CATEGORY_META）。
 *  写不存在的分类不会报错，但设置页的分类开关会变成空档 —— 这里选 query（只读）
 *  和 message（会真的发出去）这两类，语义最准，也都能被用户单独关掉。 */
const CAT_READ = 'query';
const CAT_ACT = 'message';

let cfg = () => ({});
let log = () => {};
let state = null;

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

function num(key, fallback, min, max) {
  const n = Number(cfg()[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 当前生效的规则集（每次调用都重读配置 —— 用户在设置页改完立刻生效）。 */
function rules() {
  return {
    dailyLikeLimit: num('dailyLikeLimit', 8, 0, 200),
    dailyCommentLimit: num('dailyCommentLimit', 3, 0, 50),
    hourlyLimit: num('hourlyLimit', 6, 0, 100),
    cooldownMinutes: num('cooldownMinutes', 60, 0, 1440),
    scanPageSize: num('scanPageSize', 12, 1, 50),
    maxAuthors: num('maxAuthors', 5, 1, 20),
    postsPerAuthor: num('postsPerAuthor', 3, 1, 20),
    maxPostAgeHours: num('maxPostAgeHours', 72, 1, 24 * 30),
    intervalHours: num('intervalHours', 4, 1, 168)
  };
}

function limitSets() {
  const c = cfg();
  return {
    allow: parseIdList(c.allowFriends),
    block: parseIdList(c.blockedFriends),
    banned: String(c.extraBannedWords || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  };
}

/** 这个人允许互动吗？（黑名单优先；白名单非空时只放行白名单） */
function friendAllowed(uin, { allow, block }) {
  const id = String(uin || '');
  if (!id) return false;
  if (block.includes(id)) return false;
  if (allow.length && !allow.includes(id)) return false;
  return true;
}

function selfUin(ctx) {
  const v = ctx?.selfId ?? ctx?.onebot?.selfId ?? '';
  return String(v || '');
}

function callApi(ctx, action, params) {
  const ob = ctx?.onebot;
  if (!ob || typeof ob.call !== 'function') {
    throw new Error('拿不到 OneBot 通道（ctx.onebot），这次没发出去');
  }
  return ob.call(action, params);
}

/* ══════════════════════════════════════════════════════════════════════
   工具一：刷一遍好友动态（只读）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 好友动态接口（get_qzone_feeds）只给 `uin / nickname / time / appid / key / html`，
 * **没有 tid、也没有干净的正文** —— 而 like/comment 恰恰必须要 tid。
 * 所以扫描是两步：
 *   ① 拉动态，取出"最近出现在动态里的几个人"（作者 uin + 昵称）
 *   ② 对每个人调 get_qzone_msg_list，拿到他最近的说说（tid + content + 图片数 + 评论数）
 * 第二步每人一次接口调用，所以 maxAuthors 必须有上限（默认 5）。
 *
 * 这也是为什么"分页"只翻第一页：feeds 的深翻页要靠时间游标，上游明确标了
 * 未实现（见 snowluma 的 get_qzone_feeds 注释）。硬翻第二页会拿到重复内容，
 * 不如老实只扫第一页，把 maxAuthors 调大反而更有效。
 */
async function doScan(ctx, args = {}) {
  const r = rules();
  const pageSize = Math.min(Math.max(Number(args?.limit ?? args?.pageSize) || r.scanPageSize, 1), 50);
  const maxAuthors = Math.min(Math.max(Number(args?.authors) || r.maxAuthors, 1), 20);
  const perAuthor = r.postsPerAuthor;
  const since = Date.now() - r.maxPostAgeHours * 3600000;
  const me = selfUin(ctx);
  const sets = limitSets();

  const errors = [];

  // ① 好友动态
  let feeds = [];
  try {
    const resp = await callApi(ctx, 'get_qzone_feeds', { page_num: 1, count: pageSize });
    feeds = Array.isArray(resp?.feeds) ? resp.feeds : [];
  } catch (e) {
    return err(`拉好友动态失败：${e?.message ?? e}。`
      + '（常见原因：QQ 没登录 / 空间 Cookie 失效 / 网络不通。别重试太多次，如实跟用户说这次没拿到。）');
  }

  // 作者去重，保持动态里的先后顺序（越靠前越新）
  const authors = [];
  const seenAuthors = new Set();
  for (const f of feeds) {
    const uin = String(f?.uin ?? '');
    if (!uin || seenAuthors.has(uin)) continue;
    seenAuthors.add(uin);
    authors.push({ uin, nickname: String(f?.nickname || '').trim() });
  }

  const skipped = [];
  const picked = [];
  for (const a of authors) {
    if (a.uin === me) { skipped.push({ ...a, why: '这条是机器人自己发的' }); continue; }
    if (!friendAllowed(a.uin, sets)) { skipped.push({ ...a, why: '不在允许名单里（或被拉黑）' }); continue; }
    if (picked.length >= maxAuthors) break;
    picked.push(a);
  }

  // ② 逐人展开说说
  const posts = [];
  const seenTid = new Set();
  for (const a of picked) {
    let resp = null;
    try {
      resp = await callApi(ctx, 'get_qzone_msg_list', { target_uin: Number(a.uin), pos: 0, num: perAuthor });
    } catch (e) {
      errors.push(`${a.nickname || a.uin}：${String(e?.message ?? e).slice(0, 120)}`);
      continue;
    }
    const list = Array.isArray(resp?.msglist) ? resp.msglist : [];
    for (const p of list) {
      const tid = String(p?.tid ?? '');
      if (!tid || seenTid.has(tid)) continue;
      seenTid.add(tid);

      const ts = Number(p?.time) || 0;
      const ageMs = ts ? Date.now() - ts * 1000 : Number.POSITIVE_INFINITY;
      if (ageMs > r.maxPostAgeHours * 3600000) continue;
      if (p?.is_private === true) continue;            // 仅自己可见的，别去打扰

      const content = htmlToText(p?.content).slice(0, 600);
      posts.push({
        postId: tid,
        targetUin: a.uin,
        author: a.nickname || a.uin,
        内容: content || '（这条只有图片或表情，没有文字）',
        图片数: Array.isArray(p?.images) ? p.images.length : 0,
        评论数: Number(p?.comment_num) || 0,
        发表时间: fmtTime(ts),
        多久以前: fmtAgo(ts),
        abstime: ts,
        是机器人自己发的: false,
        赞过了: state.hasLiked(tid),
        评过了: state.hasCommented(tid)
      });
    }
  }

  posts.sort((x, y) => (y.abstime || 0) - (x.abstime || 0));
  const out = posts.slice(0, Math.min(Math.max(Number(args?.limit) || 15, 1), 40));

  state.markScan();

  return ok({
    拉取到: out.length,
    看了几个人: picked.length,
    还有更多人没展开: authors.length > picked.length,
    说说: out,
    跳过的人: skipped.slice(0, 8),
    接口报错: errors.length ? errors : undefined,
    note: '以上是好友动态的**只读**结果，你什么都还没做。'
      + '挑你真读懂了、有话可说的再用 qzone-sweeper__like / qzone-sweeper__comment 动手（评论要带上 postId 和 targetUin）。'
      + '如果用户只是让你「看看」，就把有意思的念给他听，**不要**顺手把赞点掉。'
      + '拿不准、或者内容看不懂，什么都不做也完全可以。'
      + (errors.length ? '有几个人没拉到（见「接口报错」），别为这个重试，跳过他们继续。' : '')
  });
}

/* ══════════════════════════════════════════════════════════════════════
   工具二：点赞
   ══════════════════════════════════════════════════════════════════════ */

async function doLike(ctx, args = {}) {
  const tid = String(args?.postId ?? '').trim();
  const targetUin = String(args?.targetUin ?? '').trim();
  if (!tid) return err('缺少 postId（说说 id）。先用 qzone-sweeper__scan 拉一遍，postId 在结果里。');
  if (!targetUin) return err('缺少 targetUin（说说作者的 QQ 号）。评论/点赞必须带上作者 QQ，否则会点到机器人自己空间上。');
  if (targetUin === selfUin(ctx)) return err('这是机器人自己发的说说，不用点赞。');

  const sets = limitSets();
  if (!friendAllowed(targetUin, sets)) return err('这个人不在允许互动的名单里（或被拉黑了），跳过。');

  if (state.hasLiked(tid)) {
    return ok({ alreadyDone: true, note: '这条说说之前已经点过赞了，不要重复点。跟用户说一句点过了就行。' });
  }

  const r = rules();
  const gate = state.canAct({ ...r, kind: 'like' });
  if (!gate.ok) {
    return err(`现在不能点赞：${gate.reason}（这是硬性频率限制，别换个说法重试，如实说一句就行。）`);
  }

  try {
    await callApi(ctx, 'like_qzone', {
      tid,
      target_uin: Number(targetUin),
      abstime: Number(args?.abstime) || 0
    });
  } catch (e) {
    state.markFail();
    return err(`点赞失败：${String(e?.message ?? e).slice(0, 200)}（可能是说说已被删、或权限变了。别连着重试。）`);
  }

  state.record({ kind: 'like', postId: tid, targetUin, author: String(args?.author || '') });
  const after = state.snapshot(r);
  log(`[${PLUGIN_ID}] 点赞 tid=${tid} 作者=${targetUin} 今日累计 ${after.todayLikes} 个`);

  return ok({
    liked: true,
    作者: String(args?.author || targetUin),
    今日已点赞: after.todayLikes,
    今日评论: after.todayComments,
    note: '赞已经点上去了。跟用户带一句就行（比如「给谁谁点了个赞」），别播报式汇报，也别继续补消息。'
  });
}

/* ══════════════════════════════════════════════════════════════════════
   工具三：评论（= 回复某条说说）
   ══════════════════════════════════════════════════════════════════════ */

async function doComment(ctx, args = {}) {
  const tid = String(args?.postId ?? '').trim();
  const targetUin = String(args?.targetUin ?? '').trim();
  if (!tid) return err('缺少 postId（说说 id）。先用 qzone-sweeper__scan 拉一遍。');
  if (!targetUin) return err('缺少 targetUin（说说作者的 QQ 号）。不带作者 QQ 会评论到机器人自己空间上。');
  if (targetUin === selfUin(ctx)) return err('这是机器人自己发的说说，不要自己去评论自己。');

  const sets = limitSets();
  if (!friendAllowed(targetUin, sets)) return err('这个人不在允许互动的名单里（或被拉黑了），跳过。');

  if (state.hasCommented(tid)) {
    return ok({ alreadyDone: true, note: '这条说说之前已经评过了，不要重复评论。跟用户说一句评过了就行。' });
  }

  // ① 抹掉 @ 与裸 QQ 号：这是**别人的**空间，不能把群里的 @ 或群友 QQ 号带出去
  const raw = String(args?.content ?? '').trim();
  if (!raw) return err('评论是空的，写一句再发。');
  const content = stripMentions(raw);
  if (!content) return err('这条评论抹掉 @ 和 QQ 号之后就没内容了，重写一句正常的话。');

  // ② 内容闸门（硬拦，不区分来源）
  const safe = checkComment(content, sets.banned);
  if (!safe.ok) return err(safe.reason);

  // ③ 频率闸门
  const r = rules();
  const gate = state.canAct({ ...r, kind: 'comment' });
  if (!gate.ok) {
    return err(`现在不能评论：${gate.reason}（这是硬性频率限制，别换个说法重试，如实说一句就行。想让他别错过这条，可以只点赞。）`);
  }

  try {
    await callApi(ctx, 'comment_qzone', {
      tid,
      content,
      target_uin: Number(targetUin)
    });
  } catch (e) {
    state.markFail();
    return err(`评论失败：${String(e?.message ?? e).slice(0, 200)}（可能是说说已删、或对方设了限制。别连着重试。）`);
  }

  state.record({ kind: 'comment', postId: tid, targetUin, author: String(args?.author || ''), content });
  const after = state.snapshot(r);
  log(`[${PLUGIN_ID}] 评论 tid=${tid} 作者=${targetUin} 内容="${oneLine(content, 40)}" 今日评论 ${after.todayComments} 条`);

  const changed = content !== raw;
  return ok({
    commented: true,
    发出的评论: content,
    作者: String(args?.author || targetUin),
    今日已评论: after.todayComments,
    今日已点赞: after.todayLikes,
    note: '评论已经发出去了。简短说一句就好，**不要**复述评论内容、也不要播报「我评论了谁」。'
      + (changed ? '（正文里的 @ 或 QQ 号已被自动抹掉，这是有意的 —— 别人的空间里不该出现群里的人。）' : '')
      + (looksEmpty(content) ? '另外：这句评论偏空（像「真不错」这种放之四海皆准的话）。已经发出去了不用改，但下次要接住那条说说的具体内容。' : '')
  });
}

/* ══════════════════════════════════════════════════════════════════════
   工具四：查状态
   ══════════════════════════════════════════════════════════════════════ */

function doStatus(args = {}) {
  const r = rules();
  const s = state.snapshot(r);
  const n = Math.min(Math.max(Number(args?.history) || 5, 0), 20);
  const kindLabel = { like: '点赞', comment: '评论' };
  return ok({
    今天动作数: s.todayActions,
    今天点赞: `${s.todayLikes} / ${r.dailyLikeLimit}`,
    今天评论: `${s.todayComments} / ${r.dailyCommentLimit}`,
    这一小时动作数: `${s.hourActions} / ${r.hourlyLimit}`,
    现在能点赞: s.canLike ? '可以' : s.likeReason,
    现在能评论: s.canComment ? '可以' : s.commentReason,
    上次刷动态: s.lastScanAt ? fmtAgo(s.lastScanAt) : '还没刷过',
    上次动作: s.lastActionAt ? fmtAgo(s.lastActionAt) : '还没动过手',
    自动去刷: cfg().autoScan === true ? `开（每 ${r.intervalHours} 小时）` : '关',
    最近记录: n ? state.recent(n).map((h) => ({
      时间: fmtTime(h.ts),
      类型: kindLabel[h.kind] || h.kind,
      对象: h.author || h.targetUin,
      内容: h.kind === 'comment' ? oneLine(h.content, 40) : ''
    })) : []
  });
}

/* ══════════════════════════════════════════════════════════════════════
   技能契约
   ══════════════════════════════════════════════════════════════════════ */

export function setup(api) {
  cfg = () => (typeof api.config === 'function' ? (api.config() || {}) : {});
  log = (...a) => { try { api.log(...a); } catch { /* 日志失败不影响主流程 */ } };
  state = new SweepState();

  // 注意：工具 id 里**不要**自己拼前缀，上游会自动加 `qzone-sweeper__`。
  // 也**必须**给 name —— 上游 registerTool 对缺 name 直接抛错，整个 setup 会中断。
  api.registerTool({
    id: 'scan',
    name: '刷一遍空间动态',
    description: '拉取 QQ 空间好友动态：返回最近发说说的好友、他们的说说正文、postId（说说 id）、作者 QQ、评论数、几张图、多久以前发的，以及你自己是否已经赞过/评过。'
      + '**这个工具只读，不会点赞也不会评论**，扫完你才有 postId 去调 like / comment。'
      + '用户说「去空间看看」「刷刷空间」「朋友们发啥了」时用它。'
      + '注意：拿到的内容是**别人的**说说，评论前先读懂它在说什么，看不懂就别评。',
    category: CAT_READ,
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回几条说说，默认 15，上限 40' },
        authors: { type: 'integer', description: '最多展开几个好友的说说，默认跟随设置（5）。调大更全但更慢' }
      }
    },
    async execute(ctx, args) {
      try {
        return await doScan(ctx, args);
      } catch (e) {
        return err(`刷动态失败：${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'like',
    name: '给说说点赞',
    description: '给好友的一条说说点赞（就在 QQ 空间里，对方能看到）。'
      + 'postId 和 targetUin 都必须来自 qzone-sweeper__scan 的返回 —— 少了 targetUin 会点到机器人自己空间上。'
      + '同一条只会点一次，每日有上限，超了工具会拒绝（那是硬限制，别重试）。'
      + '用户明说「给谁点个赞」或者你读完动态真觉得这条不错时用它。',
    category: CAT_ACT,
    icon: '👍',
    parameters: {
      type: 'object',
      properties: {
        postId: { type: 'string', description: '说说 id，取 scan 返回里的 postId' },
        targetUin: { type: 'string', description: '说说作者的 QQ 号，取 scan 返回里的 targetUin（必填）' },
        author: { type: 'string', description: '作者昵称，可选，只用于回执和记录' },
        abstime: { type: 'integer', description: '说说发表时间（unix 秒），scan 返回里有，传上更可靠' }
      },
      required: ['postId', 'targetUin']
    },
    async execute(ctx, args) {
      try {
        return await doLike(ctx, args);
      } catch (e) {
        return err(`点赞失败：${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'comment',
    name: '评论（回复）一条说说',
    description: '在好友的一条说说下面发一条评论 —— 这就是「回复他这条说说」。'
      + 'content 要**你自己写**：一到两句、口语、接住那条说说具体说的内容（它讲的那件事/那张图/那个梗）。'
      + '不要写「真不错」「支持」这种空话，也不要写成小作文或报告。看不懂就别评，点赞或不理都行。'
      + '正文里不要 @ 任何人、不要写群号 QQ 号（会被自动抹掉）；不要提群聊和群友。'
      + '命中时政/辱骂/违法内容会被拒绝；同一条不会评第二遍；每日有上限。',
    category: CAT_ACT,
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        postId: { type: 'string', description: '说说 id，取 scan 返回里的 postId' },
        targetUin: { type: 'string', description: '说说作者的 QQ 号，取 scan 返回里的 targetUin（必填）' },
        content: { type: 'string', description: '评论正文，你自己的口吻、一到两句、贴合那条说说' },
        author: { type: 'string', description: '作者昵称，可选，只用于回执和记录' },
        abstime: { type: 'integer', description: '说说发表时间（unix 秒），可选' }
      },
      required: ['postId', 'targetUin', 'content']
    },
    async execute(ctx, args) {
      try {
        return await doComment(ctx, args);
      } catch (e) {
        return err(`评论失败：${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'status',
    name: '查看空间互动状态',
    description: '查看今天点了几个赞、评了几条、还能不能继续、上次刷动态和上次动手是什么时候、开了自动去刷没有。'
      + '用户问「你今天逛空间了吗」「你赞了几个」时用它。',
    category: CAT_READ,
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        history: { type: 'integer', description: '列出最近几条互动记录，默认 5，最多 20' }
      }
    },
    async execute(ctx, args) {
      try {
        return doStatus(args);
      } catch (e) {
        return err(`查询失败：${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  });

  log(`[${PLUGIN_ID}] 已就绪（工具：${PLUGIN_ID}__scan / __like / __comment / __status；自动去刷：${cfg().autoScan === true ? '开' : '关'}）`);
}

/** 生命周期：热重载时上游会先 deactivate 再 dispose，这里只需把捕获的引用放掉。 */
export function dispose() {
  cfg = () => ({});
  log = () => {};
  state = null;
}

/**
 * 到点了就往这一轮的消息尾巴上贴一句提醒。
 *
 * ── 为什么用钩子而不是自己起定时器 ────────────────────────────────────────
 * 技能/插件的钩子只在"机器人本来就要跑一轮"时被调用，没有独立定时器。
 * 想"到点自己去刷"有两条路：
 *   ① 自己 setInterval + 直接调 OneBot —— 但那会在**用户毫不知情**的时候
 *      替机器人做社交动作，而且绕过了整轮对话的上下文（它不知道刚才聊了啥）。
 *   ② 借用现有唤醒：每轮检查一次"是不是该去逛逛了"，是就往上下文里塞一句提醒，
 *      让模型在**下一轮正常对话里**顺手完成。
 * 选 ②（qzone 技能的发说说提醒也是同一套路）：动作永远发生在模型看得见上下文
 * 的那一轮里，也永远走工具 —— 配额、去重、内容闸门一个都不会被绕过。
 *
 * ── 节流 ────────────────────────────────────────────────────────────────
 * 群里消息密的时候一轮对话会触发很多次 before-llm-messages。所以这里有三道闸：
 * 间隔没到不提醒、免打扰时段不提醒、上一次提醒太近不提醒。
 */
export const hooks = {
  async 'before-llm-messages'(ctx) {
    if (!state) return;
    const c = cfg();
    if (c.enabled === false) return;

    // 默认**不自动**去刷别人空间：那是会被真人看见的社交动作。
    // 想让它自己逛，用户必须在设置里打开「自己定时去刷」。
    if (c.autoScan !== true) return;

    const r = rules();
    if (inQuietHours(c.quietHours)) return;

    // 只在允许的会话里提醒（留空 = 跟随发送白名单，这里不重复判白名单）
    const allowGroups = parseIdList(c.allowGroups);
    const key = String(ctx?.chatKey || '');
    if (allowGroups.length) {
      const chatId = String(ctx?.chatId || key.replace(/^[a-z]+:/i, ''));
      if (!allowGroups.includes(chatId)) return;
    }

    const now = Date.now();
    if (state.data.lastNudgeAt && now - state.data.lastNudgeAt < r.intervalHours * 3600000) return;

    // 配额已经用光就别提醒 —— 提醒了模型也动不了手，白烧上下文
    const s = state.snapshot(r);
    if (!s.canLike && !s.canComment) return;

    const messages = Array.isArray(ctx?.messages) ? ctx.messages : null;
    if (!messages?.length) return;
    const last = messages[messages.length - 1];
    if (!last || typeof last.content !== 'string') return;

    state.markNudge();

    const nudge = '\n\n[系统提示·没人要求你做任何事] 你有一阵子没去 QQ 空间看朋友们的动态了。'
      + '想去的话：先调 ' + PLUGIN_ID + '__scan 拉一遍好友动态，读一遍大家发了什么；'
      + '遇到你真觉得好的、或者你真有话可说的，用 ' + PLUGIN_ID + '__like 点赞、'
      + PLUGIN_ID + '__comment 评一句（评论要接住那条说说具体说的内容，别写「真不错」这种空话）。'
      + `今天还能点 ${r.dailyLikeLimit - s.todayLikes} 个赞、评 ${r.dailyCommentLimit - s.todayComments} 条。`
      + '**注意：这是别人的空间，不是群聊** —— 评论里不要提群里的事、不要提任何群友、不要 @ 任何人。'
      + '看不懂的内容就不要评。不想去、或者这批消息里你正忙着回别人的事，那就当没看见这条提醒，什么都没发生。'
      + '（这条只是提醒，去不去你自己判断。）';

    last.content += nudge;
    log(`[${PLUGIN_ID}] 已注入逛空间提醒（今日 赞${s.todayLikes} 评${s.todayComments}）`);
  }
};

/**
 * 对外能力（软依赖用）。
 *
 * 插件目录在加载时会做语义检查（src/plugin-loader.js 的 lintKindPlacement）：
 * 一个 plugins/ 下的条目如果既没有 providers 也没有 hooks，会打出
 * 「没有任何代码会去调用它」的警告。本插件的 hook 才是主入口，能力是附带的，
 * 但既然要对外提供，就让它是**真能用的**而不是空占位 —— hasCapability 会
 * 过滤掉 provider 为 null 的占位，只登记不实现等于骗人。
 *
 * 目前提供两个只读查询，别的技能/插件要判断"现在适不适合麻烦它去逛空间"时可用：
 *   qzone.sweeper-status  当前配额与上次动作时间
 *   qzone.sweeper-can-act 给一个 kind（like/comment）回答现在能不能动手
 */
export const providers = {
  'qzone.sweeper-status': () => (state ? state.snapshot(rules()) : null),
  'qzone.sweeper-can-act': ({ kind = 'like' } = {}) => (state ? state.canAct({ ...rules(), kind }) : { ok: false, reason: '未初始化' })
};

/** 给测试/排障用：把纯函数暴露出去，不打网络、不碰宿主。 */
export const internals = {
  htmlToText, stripMentions, checkComment, looksEmpty,
  parseIdList, inQuietHours, fmtTime, fmtAgo, rules,
  // 允许自检脚本注入状态目录与配置，把"配额/去重/内容闸门"这些分支跑一遍。
  // 生产路径不会碰这些函数（只有导入本模块的测试会调）。
  __setState: (s) => { state = s; },
  __setConfig: (c) => { cfg = () => (c || {}); },
  __scan: (ctx, args) => doScan(ctx, args),
  __like: (ctx, args) => doLike(ctx, args),
  __comment: (ctx, args) => doComment(ctx, args),
  __status: (args) => doStatus(args)
};
