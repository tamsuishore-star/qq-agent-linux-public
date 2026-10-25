// 群管理技能：把机器人已经有的管理员权限交给 AI 使用，并且让它在**没有人叫它**的
// 情况下也可能自己动手。
//
// 为什么需要它：机器人本身在群里就是管理员（role=admin），协议端（snowluma/NapCat）
// 也支持 set_group_ban / set_group_kick / delete_msg，但**核心的 28 个工具里一个
// 群管理能力都没有**。所以模型被要求"禁言他"时，它没有工具可调，只能嘴上答应或者
// 说做不到 —— 表现就是"从来没成功过"。
//
// 工具拿不到 api.onebot（Skill API 是白名单，只给 config/log/fetch/utils），
// 但工具执行时的 ctx 是完整上下文，里面有 ctx.onebot，所以直接 ctx.onebot.call()
// 调 OneBot 接口。这是本技能能成立的唯一支点。
//
// ── 自主性是怎么保证的（三层，缺一层就退化成"叫才干"）──
// 1. 架构层：群聊是全响应档位（contextTier=4），每条消息都会真正唤醒模型跑一轮，
//    它本来就有"自己决定要不要动手"的机会 —— 不需要有人专门叫它。
// 2. 提示词层：见 prompts.js 的 BOLD / CONSERVATIVE 两版，由「动手风格」一键切换。
//    胆大版写得**敢动手**（被惹到就动手，不用理由充分、不用先问），不是"动手是最后
//    手段"那种克制写法。模型只对上下文里显眼且具体的东西有反应，抽象授权（"你是
//    管理员，可以禁言"）它只会点头然后什么也不做 —— 所以两版都给了具体场景。
// 3. 确定性层：本文件的 hooks['before-llm-messages']。检测到刷屏/复读时，往这次请求里
//    塞一句"现在可以考虑动手"的提醒。**只提醒、不代替它决定** —— 推一把，动不动手
//    仍然是模型看上下文自己判断。这一层解决的是"模型没注意到"的漏判，不是替它做决定。
//
// ── 安全边界（硬约束，不靠模型自觉）──
// · 群主 / 群内其他管理员：踢不动也禁不了，动手前先查 role 直接拒。
// · 禁言时长强制夹到 maxMuteSeconds，模型要 10 小时也只给 10 分钟。
// · 踢人由配置 allowKick 控制（默认关，开了才踢得动）。
// · 不能禁言/踢机器人自己。
//
// 设计取向：这是给"AI 群友"整活用的，不是严肃的群管理工具。默认禁言 1 分钟 ——
// 短到被禁的人骂一句就过去了，长到确实能表达态度。

import { moderationPrompt, KICK_LABEL } from './prompts.js';

let cfg = () => ({});
let log = () => {};

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

/** 正整数字符串 → 数字；非法返回 null。 */
function toId(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function maxMuteSeconds() {
  const n = Number(cfg().maxMuteSeconds);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600;
}

function defaultMuteSeconds() {
  const n = Number(cfg().defaultMuteSeconds);
  if (!Number.isFinite(n) || n < 0) return 60;
  return Math.min(Math.floor(n), maxMuteSeconds());
}

/** 人类可读时长："3 分 20 秒" / "45 秒"。 */
function humanDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
}

/**
 * ★ 本机补丁 2026-10-19：**我在这个群是不是管理员**。
 *   起因（用户实测）：机器人在某个群**不是管理员**，她却说「一分钟，自己冷静下」、
 *   「哦，你也是管理」「那算了，惹不起」—— 明明没有禁言能力却装得像能动手 ✗
 *   返回：'owner' / 'admin' / 'member' / ''（查不到）。空了就按"不确定"处理，不拦。
 */
async function selfRoleIn(ctx, groupId) {
  try {
    const info = await memberOf(ctx, groupId, ctx.selfId ?? ctx.onebot?.selfId);
    return String(info?.role ?? '').trim().toLowerCase();
  } catch { return ''; }
}

/** 没有管理权限时给模型的话：既说清事实，也明确"别再提这类话"。 */
function selfAdminGuard(role) {
  if (!role || role === 'admin' || role === 'owner') return null;
  const who = role === 'member' ? '普通成员' : role;
  return err(`我在这个群不是管理员（我在群里的身份是 ${who}），禁言/踢人/撤回都做不到。`
    + '别再在聊天里提「禁言你」「冷静一分钟」「踢了你」这类话，也别摆管理员的架子。');
}

/** 查群成员；拿不到返回 null（调用方自行决定怎么退化）。 */
async function memberOf(ctx, groupId, userId) {
  try {
    const data = await ctx.onebot.call('get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: true
    });
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * 目标是否受保护（群主 / 管理员 / 机器人自己）。
 * 返回 null = 可以动手；返回字符串 = 拒绝理由。
 *
 * 查不到成员信息时**放行**：QQ 服务端自己也会拦，没必要因为查询失败就假装没权限。
 */
function protectedReason(info, targetId, selfId) {
  if (String(targetId) === String(selfId)) return '那是你自己，不行';
  if (!info) return null;
  const role = String(info.role ?? '').trim();
  if (role === 'owner') return '对方是群主，你和群主都动不了他';
  if (role === 'admin') return '对方也是管理员，管理员之间动不了手';
  return null;
}

function groupIdOf(ctx) {
  if (ctx.kind !== 'group') return null;
  return toId(ctx.chatId ?? String(ctx.chatKey || '').split(':')[1]);
}

/** 留档 + 通知会话刷新（失败不影响动作本身）。 */
function record(ctx, label) {
  try {
    ctx.store?.appendSelf?.(ctx.chatKey, { text: label, ts: Date.now(), mid: null });
    ctx.session?.sent?.push({ type: 'system', text: label });
    ctx.emit?.('session-update', ctx.session?.id);
  } catch { /* 留档失败不影响动作 */ }
}

// ── 刷屏检测（确定性层）──────────────────────────────────────────────────
//
// 只做**信号检测**，不代替模型决定。两个信号，任一命中就提醒一句：
//   · 复读：同一个人把同一条消息发了 repeatCount 次以上
//   · 刷屏：同一个人在 windowMs 内发了 floodCount 条以上
//
// 为什么用"同一个人"而不是"全群"：群里几个人正常聊天也会很快超过阈值，
// 按全群算会把正常聊天误报成刷屏，那这个提醒就变成噪声，反而干扰模型判断。
const norm = (s) => String(s ?? '').replace(/\s+/g, '').slice(0, 40);

// ★ 本机补丁 2026-10-05：图片按【文件标识】去重，不再只按文本。
//
// 原来的 bug（实测 group:123456789）：存档里所有图片的 text 都归一化成 "[图片]"，
// 于是四张**完全不同的图**在这个 key 里是同一句话，被判成"复读"：
//   `${m.senderId}|${norm(m.text)}`  →  "123456789|[图片]"
// 实测 10-04 16:43~16:47 连发几张图就被连报 3 次"复读 4 次"。
// 而每条 media 都带唯一的 file（"6914D440…jpg" / "61A48A2E…jpg"…），
// 相邻 29 条里 file 无一相同 —— 用它才能真正区分"是不是同一张图"。
// 顺带把 summary（[动画表情] / [图片]）带上，日志里能看出是什么类型。
function msgKey(m) {
  const media = Array.isArray(m?.media) ? m.media : [];
  if (media.length) {
    const ids = media.map((x) => String(x?.file || x?.url || x?.summary || '?')).join(',');
    return 'media:' + ids.slice(0, 120);
  }
  return 'text:' + norm(m?.text);
}

function detectSpam(recent) {
  const msgs = (Array.isArray(recent) ? recent : [])
    .filter((m) => m && !m.self && m.senderId && (norm(m.text) || (Array.isArray(m.media) && m.media.length)))
    .slice(-12);
  if (msgs.length < 2) return [];

  const repeatCount = Math.max(2, Number(cfg().repeatCount) || 3);
  const floodCount = Math.max(3, Number(cfg().floodCount) || 5);
  const windowMs = Math.max(1000, Number(cfg().floodWindowSec) || 20) * 1000;

  const hits = [];
  // 复读
  const byText = new Map();
  for (const m of msgs) {
    const key = `${m.senderId}|${msgKey(m)}`;
    const arr = byText.get(key) || [];
    arr.push(m);
    byText.set(key, arr);
  }
  for (const arr of byText.values()) {
    if (arr.length >= repeatCount) {
      const last = arr[arr.length - 1];
      hits.push({ kind: '复读', who: last.senderName || String(last.senderId), userId: last.senderId, times: arr.length });
    }
  }
  // 刷屏
  const bySender = new Map();
  for (const m of msgs) {
    const arr = bySender.get(String(m.senderId)) || [];
    arr.push(m);
    bySender.set(String(m.senderId), arr);
  }
  for (const arr of bySender.values()) {
    const last = arr[arr.length - 1];
    const windowed = arr.filter((m) => Number(last.ts) - Number(m.ts) <= windowMs);
    if (windowed.length >= floodCount) {
      hits.push({ kind: '刷屏', who: last.senderName || String(last.senderId), userId: last.senderId, times: windowed.length });
    }
  }
  // 同一个人同时命中两条就合并，别塞两句重复的提醒
  const merged = new Map();
  for (const h of hits) {
    const prev = merged.get(String(h.userId));
    if (prev) prev.times = Math.max(prev.times, h.times);
    else merged.set(String(h.userId), h);
  }
  return [...merged.values()];
}

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});

  // ── 禁言 ──────────────────────────────────────────────────────────────
  api.registerTool({
    id: 'mute_member',
    name: '禁言群友',
    description: '禁言一个群友（真禁言，对方立刻发不出消息）。有人刷屏、复读、发广告，或者嘴上跟你对线把你惹到了，就动手——不用先问、不用预告、不用等谁批准。targetUserId 必须是数字 QQ 号：不知道就先调 get_recent_messages 或 get_active_members 查。seconds 一般不用传（默认 60）。群主和其他管理员禁不了，工具会直接拒绝。禁言完正常接话即可，不用道歉，也不用播报"我禁言了你"。',
    category: 'messaging',
    icon: '🔇',
    parameters: {
      type: 'object',
      properties: {
        targetUserId: { type: ['integer', 'string'], description: '要禁言的群友 QQ 号（数字）' },
        seconds: { type: ['integer', 'string'], description: '禁言秒数，默认 60。别超过 600，超了会被自动压到上限' },
        reason: { type: 'string', description: '可选：为什么禁言，一句话（只写进日志，不会发给群友）' }
      },
      required: ['targetUserId']
    },
    async execute(ctx, args) {
      try {
        const groupId = groupIdOf(ctx);
        if (!groupId) return err('禁言只能在群聊里用');
        const target = toId(args.targetUserId);
        if (!target) return err(`targetUserId 必须是数字 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。先用 get_recent_messages 查对方的 QQ 号。`);

        const cap = maxMuteSeconds();
        const asked = args.seconds === undefined || args.seconds === null || String(args.seconds).trim() === ''
          ? defaultMuteSeconds()
          : Math.floor(Number(args.seconds));
        if (!Number.isFinite(asked) || asked < 0) return err(`seconds 必须是不小于 0 的数字（收到：${JSON.stringify(args.seconds)}）`);
        const seconds = Math.min(asked, cap);
        const clamped = seconds < asked;

        // ★ 先确认自己有没有管理权限（没有就别装能动手）
        {
          const myRole = await selfRoleIn(ctx, groupId);
          const deny = selfAdminGuard(myRole);
          if (deny) return deny;
        }
        const info = await memberOf(ctx, groupId, target);
        const blocked = protectedReason(info, target, ctx.selfId);
        if (blocked) return err(`${blocked}。这次不动手。`);

        await ctx.onebot.call('set_group_ban', { group_id: groupId, user_id: target, duration: seconds });

        const who = info?.card || info?.nickname || String(target);
        const secondsText = humanDuration(seconds);
        record(ctx, seconds > 0 ? `[禁言:${who} ${secondsText}]` : `[解禁:${who}]`);
        log(`[moderation] 禁言 ${who}(${target}) ${seconds}s${args.reason ? ` 理由：${args.reason}` : ''}${clamped ? `（请求 ${asked}s 已压到上限 ${cap}s）` : ''}`);

        return ok({
          muted: seconds > 0,
          target: who,
          targetUserId: target,
          seconds,
          ...(clamped ? { note: `请求的 ${asked} 秒超过上限，已压到 ${cap} 秒。` } : {}),
          hint: seconds > 0
            ? `已禁言 ${who} ${secondsText}。接着正常说话就行，不用道歉，也别播报"我禁言了你"。`
            : `已解除 ${who} 的禁言。`
        });
      } catch (error) {
        return err(`禁言失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 撤回 ──────────────────────────────────────────────────────────────
  api.registerTool({
    id: 'recall_message',
    name: '撤回消息',
    description: '撤回一条消息。messageId 就是聊天记录/工具返回里的 #数字（get_recent_messages 的 messageId 字段）。自己说错话、发重复了、话题过去了，都可以撤自己的，不用等谁批准；别人的消息只在明显是垃圾（广告、刷屏）时才撤。QQ 只允许撤 2 分钟内的消息，超时会失败——失败就说明太久了，不用重试。',
    category: 'messaging',
    icon: '↩️',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '要撤回的消息 id（聊天记录里的 #数字）' },
        reason: { type: 'string', description: '可选：为什么撤回，一句话（只写进日志）' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        if (ctx.kind !== 'group') return err('撤回目前只在群聊里支持');
        const raw = String(args.messageId ?? '').trim().replace(/^#/, '');
        if (!/^-?\d+$/.test(raw) || Number(raw) === 0) {
          return err(`messageId 必须是消息 id（聊天记录里的 #数字），收到：${JSON.stringify(args.messageId)}`);
        }
        const mid = raw;

        // 判断是不是自己发的：查得到就查，查不到按"别人的消息"从严处理。
        let ownerId = null;
        try {
          const detail = await ctx.onebot.getMsg(mid);
          ownerId = detail?.sender?.user_id != null ? String(detail.sender.user_id) : null;
        } catch { /* 查不到就当不确定 */ }
        const isMine = ownerId !== null && String(ownerId) === String(ctx.selfId);
        if (!isMine && cfg().recallOthers === false) {
          return err('撤回别人的消息这个权限被关掉了，你只能撤自己发的。');
        }

        await ctx.onebot.call('delete_msg', { message_id: Number(mid) });

        // ── 撤回后清掉发送去重指纹 ────────────────────────────────────────
        //
        // 为什么必须做（实测踩到的静默丢失）：sender.js 有一道"8000ms 内发过相同
        // 文本就跳过"的去重闸。**撤回不会清掉那道闸的指纹** —— 于是"撤回自己刚发的
        // 消息、再重发一遍"这个完全正常的操作，会被去重当成重复而静默跳过：
        // 消息在群里根本不出现，而工具却回报"已发送"。
        //
        // 实测现场（group:908690038）：
        //   11:57:41.337 首条发出（记指纹）
        //   11:57:44/45  撤回两条（指纹仍在）
        //   11:57:49.2   重发第 1 条 → 距首条 7.9 秒，落在 8 秒窗口内 → 被吞
        //   11:57:49.6   重发第 2 条 → 8.5 秒，出窗口 → 发成功
        // 结果：群里只剩"撤回"两条系统提示，重发只到了一条。
        //
        // ⚠️ 这里是绕过私有字段（sender.js 的 recentSent 是 #private，没有公开的
        //    清除入口）。之所以破例：修 sender.js 属于核心改动、**必须重启**才生效，
        //    而这个 bug 正在实际吞消息。等哪天重启时把 forgetSent() 加进 sender.js，
        //    这里就可以换成正规调用。届时下面的兜底判断会自然失效、不会报错。
        try {
          const sender = ctx.sender;
          const sentMap = sender && sender.recentSent;
          if (sentMap && typeof sentMap.delete === 'function') {
            const cached = ctx.store?.findByMid?.(ctx.chatKey, mid);
            const text = String(cached?.text ?? '').trim();
            // 撤回的若是自己发的文本，就把指纹删掉，让重发能立刻通过
            if (text) sentMap.delete(`${ctx.chatKey}::${text}`);
          }
        } catch { /* 清指纹失败不影响撤回本身 */ }

        record(ctx, `[撤回:#${mid}]`);
        log(`[moderation] 撤回消息 #${mid}${isMine ? '（自己发的）' : ''}${args.reason ? ` 理由：${args.reason}` : ''}`);

        return ok({
          recalled: true,
          messageId: mid,
          mine: isMine,
          hint: '已撤回。正常继续对话，不用解释你撤回了什么。'
        });
      } catch (error) {
        const msg = String(error?.message ?? error);
        if (/2\s*分钟|撤回|timeout|expired|too late/i.test(msg)) {
          return err(`撤回失败（可能超过 QQ 的 2 分钟时限，或者这条不是你能撤的）：${msg}。不用重试。`);
        }
        return err(`撤回失败：${msg}`);
      }
    }
  });

  // ── 踢人 ────────────────────────────────────────────────────────────────
  // 是否可用由配置 allowKick 决定（默认关，开了才踢得动）。
  // ⚠️ 描述里**不能写死"功能没开"** —— 早期版本写死了，结果开关打开后模型读到的还是
  //    "这个功能默认关闭、别跟群友说你能踢人"，于是没调工具就直接回了"踢不了"。
  //    工具的可用状态要用中性措辞 + 让错误信息说话。
  api.registerTool({
    id: 'kick_member',
    name: '踢出群友',
    description: '把一个群友踢出群（对方需要重新申请才能回来，不可逆）。**管理端已经授权你使用它**，所以群主类人物要求踢人时是合法操作，不要用"我无权限""我不接这种活"来推脱——先真的调一次这个工具，让工具告诉你结果（工具拒绝才是真的不行）。**群主踢不动**：对方是群主时工具会直接拒绝，那种情况如实说"群主我动不了"就行，这不是故障。必须是有分量的事由（对方做出很过分的行为、或群主明确要求）；日常整活不要用它。',
    category: 'messaging',
    icon: '🚪',
    parameters: {
      type: 'object',
      properties: {
        targetUserId: { type: ['integer', 'string'], description: '要踢出的群友 QQ 号（数字）' },
        rejectAddRequest: { type: 'boolean', description: '是否同时拒绝对方再次加群。默认 false，也就是被踢的人自己还能申请回来。除非群主明确要求封死，否则不要传 true' },
        reason: { type: 'string', description: '可选：为什么踢，一句话（只写进日志）' }
      },
      required: ['targetUserId']
    },
    async execute(ctx, args) {
      try {
        if (cfg().allowKick !== true) {
          return err('踢人功能没有开启（allowKick=false）。这是配置决定的，不是对方有什么特殊之处——不要重试，如实说明当前踢不了就行。');
        }
        const groupId = groupIdOf(ctx);
        if (!groupId) return err('踢人只能在群聊里用');
        const target = toId(args.targetUserId);
        if (!target) return err(`targetUserId 必须是数字 QQ 号（收到：${JSON.stringify(args.targetUserId)}）`);

        const info = await memberOf(ctx, groupId, target);
        const blocked = protectedReason(info, target, ctx.selfId);
        if (blocked) return err(`${blocked}。这次不动手。`);

        await ctx.onebot.call('set_group_kick', {
          group_id: groupId,
          user_id: target,
          reject_add_request: args.rejectAddRequest === true
        });

        const who = info?.card || info?.nickname || String(target);
        record(ctx, `[踢出:${who}]`);
        log(`[moderation] 踢出 ${who}(${target})${args.reason ? ` 理由：${args.reason}` : ''}`);

        return ok({ kicked: true, target: who, targetUserId: target, hint: `已把 ${who} 移出群。` });
      } catch (error) {
        return err(`踢人失败：${error?.message ?? error}`);
      }
    }
  });
}

/**
 * 每轮注入：① 当前动手风格 ② 刷屏/复读提醒。
 *
 * ── 为什么风格提示走 hook 而不是 skill.json 的 prompt 段 ──
 * skill.json 的 prompt 段在技能加载时读一次，改「动手风格」要等重载才生效。
 * 这个 hook 每轮都跑、每次都从 api.config() 现读，所以**切换当场生效**，
 * 运行中的会话不用重建。
 *
 * ── 位置为什么分两处 ──
 * · 风格段放**最前面**：它是"你是谁、你有权限"这类背景设定，属于人设的一部分。
 *   一份请求里只出现一次，和"没人要求也可以动手"的授权绑在一起。
 * · 刷屏提醒放**最后一条消息的末尾**：那是"现在该考虑的事"，必须贴着模型要回应的
 *   内容才不会被当成背景信息忽略掉。
 *
 * 刷屏提醒的措辞刻意留了余地（"不想管也行"）：它的职责是把模型没注意到的情况推到
 * 眼前，动不动手仍由模型判断。写成命令式就变成规则引擎了 —— 那与"AI 自主"是两回事，
 * 想要那种可靠性就该做确定性自动禁言，而不是把提示词写成命令。
 */
export const hooks = {
  // ★ 2026-10-21：机器人**不是管理员**时，禁言/踢人/撤回类工具直接拒绝调用，并明确告诉它别试。
  'before-tool': async (ctx = {}) => {
    try {
      const name = String(ctx?.toolName || '');
      if (!/__(mute_member|kick_member|recall_message|set_group_ban|set_group_kick)$/.test(name)) return undefined;
      const chatKey = String(ctx?.chatKey || '');
      const m = chatKey.match(/^group:(\d+)$/);
      if (!m) return undefined;
      const chatKeyGroup = m[1];
      const myRole = await selfRoleIn(ctx, chatKeyGroup);
      if (myRole === 'admin' || myRole === 'owner') return undefined;
      const NON_ADMIN_BLOCK = true;
      return { block: true, reason: '机器人不是这个群的管理员（身份：' + (myRole || '未知') + '），禁言/踢人/撤回都做不到。别再尝试这类动作，也别在聊天里提「禁言你」「冷静一分钟」「踢了你」。' };
    } catch { return undefined; }
  },
  // ★ 本机补丁 2026-10-19：没有管理权限时的语气约束（成本最低的一道保险）
  'before-llm-messages': ({ messages }) => {
    try {
      if (!Array.isArray(messages) || !messages.length) return;
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') return;
      const note = '\n\n【关于管理权限】你不是所有群的管理员。禁言/踢人/撤回这些动作，**先调工具让工具告诉你行不行**；'
        + '工具说不行，就别在聊天里提「禁言你」「冷静一分钟」「踢了你」这类话，也别摆管理员架子。';
      if (typeof last.content === 'string') last.content += note;
    } catch { /* 钩子失败不影响主流程 */ }
  },
  async 'before-llm-messages'(ctx) {
    const messages = Array.isArray(ctx?.messages) ? ctx.messages : null;
    if (!messages?.length) return;

    // ① 当前动手风格 + 踢人权（每轮现读配置，所以改完立刻生效、不用重载）
    const style = String(cfg().promptStyle ?? '').trim() === 'conservative' ? 'conservative' : 'bold';
    const kickStanceRaw = String(cfg().kickStance ?? '').trim();
    const kickStance = KICK_LABEL[kickStanceRaw] ? kickStanceRaw : 'normal';
    const head = messages.find((m) => m && typeof m.content === 'string');
    if (head) {
      const title = `【群管理·${style === 'conservative' ? '保守' : '胆大'}版·踢人${KICK_LABEL[kickStance]}】`;
      head.content = `${title}\n${moderationPrompt(style, kickStance)}\n\n${head.content}`;
    }

    // ② 刷屏/复读提醒
    if (cfg().detectSpam === false) return;
    if (ctx?.kind !== 'group') return;

    let recent = [];
    try { recent = ctx.store?.recent?.(ctx.chatKey, { limit: 12 }) || []; } catch { return; }
    const hits = detectSpam(recent);
    if (!hits.length) return;

    const who = hits.map((h) => `${h.who}(QQ:${h.userId}) ${h.kind} ${h.times} 次`).join('；');
    const nudge = `\n\n[系统提示·没人要求你做任何事] 刚检测到：${who}。`
      + '你要是觉得烦，可以自己禁言他一下（mute_member，一两分钟就够），不用等谁批准，也不用预告——动手就行。'
      + '不想管、觉得无所谓，就正常说话或者不理，也完全可以。'
      + '（这条只是提醒你别漏看，动不动手你自己判断。）';

    const last = messages[messages.length - 1];
    if (last && typeof last.content === 'string') last.content += nudge;
    log(`[moderation] 刷屏提醒已注入：${who}`);
  }
};