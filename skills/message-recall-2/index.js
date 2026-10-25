// 消息撤回技能（单条 + 批量）
//
// ── 撤回通路（本机实测确认，OneBot v11 / SnowLuma）──────────────────────────
//   撤回     : ctx.onebot.call('delete_msg', { message_id })
//              SnowLuma 在消息发出时就 cacheMessageMeta(messageId, {targetId, sequence…})，
//              所以只给 message_id 就够；message_id 是 int32 哈希、**可为负数**，
//              参数校验是「非零整数」，负数原样传。
//   聊天记录 : get_group_msg_history / get_friend_msg_history
//              { group_id | user_id, message_id?, count?, reverse_order? }
//              返回 { messages: [完整消息事件…] }，每条含 message_id / message_seq /
//              user_id / sender / message / raw_message / time。
//
// ── 历史 API 的方向语义（本机实测，上游文档没写清）──────────────────────────
//   · 不给锚点                     → 返回**最新** count 条，按时间**升序**（旧 → 新）
//   · 锚点 + reverse_order=false   → 从锚点往**新**取，**含锚点**，升序
//   · 锚点 + reverse_order=true    → 从锚点往**旧**取（这是默认值）
//   所以 「从这条开始往后撤」= 锚点 + reverse_order:false
//        「撤回最近 N 条」    = 不给锚点拿最新一页，不够再以最早那条为锚点往旧翻
//
// ── 身份与 ctx（orchestrator.js:899 实测字段）───────────────────────────────
//   ctx 只有 chatKey / kind / chatId / selfId / selfNickname / botName /
//   onebot / store / memory / stickers / sender / session / reminders /
//   videoReader / emit。**没有** ctx.userId / ctx.senderId / ctx.groupId /
//   ctx.recallMessage / ctx.deleteMessage —— 别假设它们存在。
//   触发者从 ctx.session.trigger 的 senderId 取（与 plugins/owner-identity 同源），
//   兜底用 ctx.store 里最近一条人类发言。
//
// ── 规则 ───────────────────────────────────────────────────────────────────
//   群聊：仅「主人QQ」可触发
//   私聊：由 allowPrivateRecall 开关控制；主人QQ私聊不受开关限制
//   只撤回机器人自己的消息

/** 解析主人QQ名单（兼容中英文逗号、分号、空白分隔）。 */
function parseOwnerList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeId(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/** 模型有时会照抄历史里的本地序号（消息前的 #12），还原成本地序号。 */
function parseLocalSeq(raw) {
  const m = /^#?(\d+)$/.exec(String(raw ?? '').trim());
  return m ? Number(m[1]) : null;
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * QQ 的可撤回窗口约 2 分钟。留一点余量：115 秒。
 *
 * 为什么必须提前判：超时后协议端**仍然返回 ok**（真机实测），
 * 只有事后 get_msg 复核才能发现。提前判是为了省掉必然失败的调用，
 * 并给用户一个准确的原因而不是含糊的「失败」。
 */
const RECALL_WINDOW_MS = 115 * 1000;

/**
 * 撤回后到 get_msg 生效之间的延迟。
 *
 * 真机实测（2026-10-03）：delete_msg 返回后**立刻**查 get_msg，它仍然报 ok/0
 * —— 协议端的消息缓存不是同步失效的。同一批消息：
 *     +0ms → get_msg=ok/0（假的"还在"）   而历史里**已经消失**
 *     +600ms → get_msg=failed/100（正确）
 * 不睡这一下，复核就会把**成功的撤回判成失败**，于是机器人报
 * 「只撤成功一个」而实际上全撤掉了（这就是用户看到的那次故障）。
 */
const VERIFY_DELAY_MS = 600;

/**
 * 解析调用者 QQ 号。来源与 plugins/owner-identity 一致：
 * 触发批条目上的 senderId；拿不到时退回「本会话最近一条人类发言」。
 */
function resolveCallerId(ctx) {
  const entries = ctx?.session?.trigger;
  if (Array.isArray(entries)) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const sid = normalizeId(entries[i]?.senderId);
      if (sid && sid !== 'self') return sid;
    }
  }
  try {
    const recent = ctx?.store?.recent?.(ctx.chatKey, { limit: 30, includeSelf: false }) || [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const sid = normalizeId(recent[i]?.senderId);
      if (sid && sid !== 'self') return sid;
    }
  } catch { /* store 不可用就当拿不到 */ }
  return '';
}

/** 在存档中按 QQ 消息 id 找条目。 */
function findEntryByMid(ctx, mid) {
  const key = normalizeId(mid);
  if (!key) return null;
  try {
    const hit = ctx?.store?.findByMid?.(ctx.chatKey, key);
    if (hit) return hit;
  } catch { /* 退回线性扫描 */ }
  try {
    const recent = ctx?.store?.recent?.(ctx.chatKey, { limit: 400 }) || [];
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i]?.mid != null && String(recent[i].mid).trim() === key) return recent[i];
    }
  } catch { /* ignore */ }
  return null;
}

/** 找机器人自己最后一条「还带 QQ 消息 id」的消息。 */
function findLastSelfEntry(ctx) {
  let recent = [];
  try {
    recent = ctx?.store?.recent?.(ctx.chatKey, { limit: 60 }) || [];
  } catch { return null; }
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m?.self && !m.recalled && m.mid != null && String(m.mid).trim() !== '') return m;
  }
  return null;
}

/** 把用户给的锚点（QQ 消息 id 或本地序号 #N）解析成 QQ 消息 id。 */
function resolveAnchor(ctx, raw) {
  const s = normalizeId(raw);
  if (!s) return { mid: '', entry: null };
  if (/^#?\d+$/.test(s)) {
    const localId = parseLocalSeq(s);
    const byLocal = localId != null ? ctx.store?.findByLocalId?.(ctx.chatKey, localId) : null;
    if (byLocal && byLocal.mid != null) return { mid: String(byLocal.mid), entry: byLocal };
  }
  const entry = findEntryByMid(ctx, s);
  return { mid: entry?.mid != null ? String(entry.mid) : s, entry };
}

/** 取一条消息的文本摘要（历史事件里 message 是段数组，也可能是 CQ 字符串）。 */
function summarizeMessage(m) {
  let text = '';
  if (Array.isArray(m?.message)) {
    text = m.message
      .map((seg) => (seg?.type === 'text' ? String(seg?.data?.text ?? '') : `[${seg?.type ?? '?'}]`))
      .join('');
  } else if (typeof m?.message === 'string') {
    text = m.message.replace(/\[CQ:[^\]]*\]/g, '');
  }
  if (!text) text = String(m?.raw_message ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 24);
}

/**
 * 拉一页聊天记录，返回**按时间升序**的数组。
 * @param {'newer'|'older'} dir  newer = 从锚点往新（含锚点）；older = 从锚点往旧
 */
async function fetchPage(ctx, { dir, anchorMid, count }) {
  const isGroup = ctx.kind === 'group';
  const action = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history';
  const params = isGroup
    ? { group_id: Number(ctx.chatId), count }
    : { user_id: Number(ctx.chatId), count };
  if (anchorMid) {
    params.message_id = Number(anchorMid);
    params.reverse_order = dir === 'older';
  }
  const data = await ctx.onebot.call(action, params);
  const list = Array.isArray(data?.messages) ? data.messages.slice() : [];
  // 明确按时间升序 —— 不依赖协议端返回顺序
  list.sort((a, b) => Number(a?.time ?? 0) - Number(b?.time ?? 0)
    || Number(a?.message_seq ?? 0) - Number(b?.message_seq ?? 0));
  return list;
}

/**
 * 收集要撤回的消息（只收机器人自己的）。
 *
 * 两个方向：
 *   · 有锚点 → 从锚点往**新**翻页，取满 count 条自己的消息
 *   · 无锚点 → 先取最新一页（从新往旧数），不够就以已见到的最早一条为锚点继续往旧翻
 *
 * @returns {Promise<{targets: Array, fetched: number}>} targets 为升序（旧 → 新）
 */
async function collectTargets(ctx, { anchorMid, count, selfId }) {
  const PAGE = 50;
  const MAX_FETCH = 600;      // 最多翻这么多条，避免无界抓取
  const targets = [];
  const seen = new Set();
  let fetched = 0;
  let page = 0;
  let cursorNew = anchorMid || '';   // 有锚点：往新翻的游标
  let cursorOld = '';                // 无锚点：往旧翻的游标

  while (targets.length < count && fetched < MAX_FETCH) {
    let batch;
    if (anchorMid) {
      batch = await fetchPage(ctx, { dir: 'newer', anchorMid: cursorNew, count: PAGE });
    } else if (page === 0) {
      batch = await fetchPage(ctx, { dir: 'older', anchorMid: '', count: PAGE });
    } else {
      if (!cursorOld) break;
      batch = await fetchPage(ctx, { dir: 'older', anchorMid: cursorOld, count: PAGE });
    }
    if (!batch.length) break;
    page++;

    let fresh = 0;
    for (const m of batch) {
      const mid = m?.message_id;
      if (mid == null) continue;
      const key = String(mid);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh++;

      const senderId = normalizeId(m?.user_id ?? m?.sender?.user_id);
      if (senderId !== selfId) continue;
      targets.push({
        message_id: Number(mid),
        mid: key,
        time: Number(m?.time ?? 0) * 1000,
        seq: Number(m?.message_seq ?? 0),
        // 历史事件的 time 是**秒**。算年龄时以协议端时间为准 —— 本机时钟与
        // 腾讯服务器有偏差时，用本地时间会在窗口边界上判错。
        ageMs: Math.max(0, Date.now() - Number(m?.time ?? 0) * 1000),
        text: summarizeMessage(m)
      });
      if (targets.length >= count) break;
    }
    fetched += batch.length;

    // 整页都被见过 = 没有新消息了。锚点已是最新时，往新翻只会反复返回锚点自己，
    // 靠这个判据退出，避免死循环。
    if (!fresh) break;

    // 游标推进：往新翻用本页最后一条，往旧翻用本页第一条。
    // 刻意不动游标当这一页没凑够 —— 下一轮拿到的还是同一页，随即被 !fresh 拦下。
    if (anchorMid) cursorNew = String(batch[batch.length - 1].message_id);
    else cursorOld = String(batch[0].message_id);
  }

  targets.sort((a, b) => a.time - b.time || a.seq - b.seq);
  return { targets: targets.slice(0, count), fetched };
}

/**
 * 撤一条，并**核实真的撤掉了**。
 *
 * 为什么单条也要核实：协议端对超时消息返回 ok 但 QQ 没撤（真机实测），
 * 单条路径一样会谎报成功。查一次 get_msg 的成本远低于让机器人对用户说谎。
 *
 * @param {{mid: string, text: string, ageMs: number, knownAge: boolean}} item
 *   knownAge=false 表示这条来自存档、拿不到准确年龄（存档只有收/发时间），
 *   此时不做提前拒绝，交给 delete_msg + get_msg 复核来判定。
 */
async function recallOne(ctx, item, { callerId = '', api = null } = {}) {
  if (item.knownAge && item.ageMs > RECALL_WINDOW_MS) {
    return {
      content: `撤回失败：这条消息已经发出 ${Math.round(item.ageMs / 1000)} 秒，`
        + '超过了 QQ 约 2 分钟的可撤回窗口，撤不回来了。请如实告诉用户。',
      isError: true
    };
  }
  try {
    await ctx.onebot.call('delete_msg', { message_id: Number(item.mid) });
  } catch (err) {
    return { content: `撤回失败：${err?.message ?? err}`, isError: true };
  }
  // 复核：必须等缓存失效（见 VERIFY_DELAY_MS 的说明），否则会把成功判成失败
  await sleep(VERIFY_DELAY_MS);
  let gone = true;
  try {
    await ctx.onebot.call('get_msg', { message_id: Number(item.mid) });
    gone = false;
  } catch { /* 查不到 = 已撤回 */ }
  if (!gone) {
    return {
      content: `撤回失败：协议端接受了请求，但这条消息并没有真的被撤回`
        + '（多半是已经超出 QQ 约 2 分钟的可撤回时间）。请如实告诉用户撤不掉。',
      isError: true
    };
  }
  try { ctx.store?.markRecalled?.(ctx.chatKey, item.mid); } catch { /* ignore */ }
  api?.log?.(`${ctx.chatKey} 已撤回消息 ${item.mid}（触发者 ${callerId || '未知'}）`);
  return { content: `已撤回消息（ID: ${item.mid}）。` };
}

export function register(api) {
  api.registerTool({
    id: 'recall_message',
    name: '撤回消息',
    description:
      '撤回机器人自己发送的消息。默认撤回最近一条；也可以批量：count 给条数、'
      + 'targetMessageId 给起始消息（用户引用某条消息时用那条消息的ID，或历史里消息前的 #序号）——'
      + '工具会自己去聊天记录里把消息ID抠出来，不需要用户逐条列。'
      + '群聊内只有主人QQ可以触发；私聊是否可用由开关控制。只能撤回机器人自己发的消息。',
    category: 'system',
    icon: '↩️',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          description:
            '要撤回的条数（只数机器人自己发的消息）。不传或传 1 = 只撤一条。'
            + '用户说「撤回最近5条」就传 5；上限由技能设置决定。'
        },
        targetMessageId: {
          type: 'string',
          description:
            '起始消息：从这一条开始往后的 count 条。可传消息ID、历史里消息前的 #序号，'
            + '或用户引用的那条消息的ID。不传 = 从机器人最近一条往前数 count 条。'
        }
      }
    },

    async execute(ctx, args) {
      if (!ctx) return { content: '撤回失败：拿不到会话上下文。', isError: true };

      const cfg = (typeof api.config === 'function' && api.config()) || {};
      const owners = parseOwnerList(cfg.ownerQQ);
      const allowPrivate = cfg.allowPrivateRecall !== false;
      const maxBatch = clamp(cfg.maxBatch, 1, 100, 20);
      const interval = clamp(cfg.recallIntervalMs, 200, 3000, 600);
      const selfId = normalizeId(ctx.selfId);

      const kind = normalizeId(ctx.kind) || (String(ctx.chatKey || '').startsWith('group:') ? 'group' : 'private');
      const isPrivate = kind === 'private';
      const callerId = resolveCallerId(ctx);
      const isOwner = owners.length > 0 && owners.includes(callerId);

      // ── 权限判定（单条与批量共用同一套口径）──
      if (!isPrivate && !isOwner) {
        return {
          content: owners.length === 0
            ? '撤回失败：还没配置「主人QQ账号」，群聊内无法撤回。请在「设置 → 技能 → 消息撤回」里填写主人QQ号码。'
            : `撤回失败：群聊内只有主人QQ可以让机器人撤回消息（当前触发者：${callerId || '未识别'}）。`
              + '请让主人账号操作，或把该QQ加入「主人QQ账号」。',
          isError: true
        };
      }
      if (isPrivate && !isOwner && !allowPrivate) {
        return {
          content: '撤回失败：私聊撤回功能已关闭。请在「设置 → 技能 → 消息撤回」中开启「允许私聊内撤回」。',
          isError: true
        };
      }
      if (!ctx.onebot || typeof ctx.onebot.call !== 'function') {
        return { content: '撤回失败：当前运行环境没有 OneBot 调用通道（ctx.onebot.call）。', isError: true };
      }

      const countArg = args && args.count != null ? Number(args.count) : 1;
      const wantCount = Number.isFinite(countArg) ? Math.trunc(countArg) : 1;
      const rawAnchor = args && args.targetMessageId != null ? String(args.targetMessageId).trim() : '';

      // ── 单条（不带锚点）：沿用最短路径，不查历史，更快更稳 ──
      if (wantCount <= 1 && !rawAnchor) {
        const entry = findLastSelfEntry(ctx);
        if (!entry) {
          return {
            content: '撤回失败：没有找到可撤回的消息（机器人最近没发过带消息ID的消息）。'
              + '请回复要撤回的那条消息，或直接提供消息ID。',
            isError: true
          };
        }
        const mid = String(entry.mid);
        return await recallOne(ctx, { mid, text: entry.text || '', ageMs: 0, knownAge: false }, { callerId, api });
      }

      // ── 批量 ──
      if (wantCount < 1) {
        return { content: '撤回失败：条数必须 ≥ 1。', isError: true };
      }
      if (wantCount > maxBatch) {
        return {
          content: `撤回失败：一次最多撤回 ${maxBatch} 条（当前要求 ${wantCount} 条）。`
            + '可在「设置 → 技能 → 消息撤回 → 单次批量上限」里调整，或分几次撤。',
          isError: true
        };
      }
      if (!Number.isFinite(Number(ctx.chatId)) || Number(ctx.chatId) <= 0) {
        return { content: `撤回失败：拿不到有效的会话ID（chatId=${ctx.chatId}），无法查聊天记录。`, isError: true };
      }
      if (!selfId) {
        return { content: '撤回失败：拿不到机器人自己的QQ号（ctx.selfId 为空），无法辨认自己的消息。', isError: true };
      }

      const anchor = rawAnchor ? resolveAnchor(ctx, rawAnchor) : { mid: '', entry: null };
      if (rawAnchor && !anchor.mid) {
        return { content: `撤回失败：看不懂起始消息「${rawAnchor}」。请引用那条消息，或给出消息ID。`, isError: true };
      }

      // 只撤一条、但指定了具体消息（用户引用某条消息说「撤回这条」）：
      // 直接撤，不去查聊天记录 —— 这是原来就在工作的路径，不该因为改成批量而变脆。
      // 存档里能查到时顺便确认是机器人自己发的；查不到就交给协议端判定
      //（SnowLuma 对非自己的消息会回 not retractable）。
      if (wantCount <= 1 && anchor.mid) {
        if (anchor.entry && !anchor.entry.self) {
          const m = anchor.entry;
          return {
            content: `撤回失败：这条消息是「${normalizeId(m.senderName) || normalizeId(m.senderId) || '别人'}」发的，`
              + '机器人只能撤回自己发的消息。',
            isError: true
          };
        }
        return await recallOne(ctx, { mid: anchor.mid, text: '', ageMs: 0, knownAge: false }, { callerId, api });
      }

      let collected;
      try {
        collected = await collectTargets(ctx, { anchorMid: anchor.mid, count: wantCount, selfId });
      } catch (err) {
        return { content: `撤回失败：读聊天记录出错 —— ${err?.message ?? err}`, isError: true };
      }

      const targets = collected.targets;

      // 兜底：锚点这条本身没被聊天记录覆盖（QQ 的历史窗口很短，很常见的坑）。
      // 只有在**存档能证明这条是机器人自己发的**时才补撤 —— 否则"证明不了"就当成
      // 别人的消息，宁可失败也不要误删群友的消息。
      if (!targets.length && anchor.mid && anchor.entry && anchor.entry.self) {
        return await recallOne(ctx, { mid: anchor.mid, text: '', ageMs: 0, knownAge: false }, { callerId, api });
      }

      if (!targets.length) {
        return {
          content: `撤回失败：从${anchor.mid ? `消息ID ${anchor.mid}` : '最新消息'}开始，`
            + `翻了 ${collected.fetched} 条聊天记录，没有找到机器人自己发送的消息。`
            + '（可能要撤回的消息已经超出聊天记录范围了。）',
          isError: true
        };
      }

      // 循环撤回：每条之间加间隔，别把协议端/桥接端惹毛。
      //
      // ⚠️ 这段是**真机验证过**才敢这么写的（2026-10-03 线上故障）：
      //    QQ 的撤回窗口约 2 分钟。超时之后，SnowLuma 的 delete_msg
      //    **照样返回 `{"status":"ok","retcode":0}`，但 QQ 根本没撤**。
      //    实测 278s / 165s 的消息就是这个表现：协议端说成功、消息纹丝不动。
      //    技能当时信了这个 ok，回了「已撤回 5 条」，机器人就对用户撒了谎。
      //    所以两道防线：
      //      ① 太老的干脆不发（省掉必然失败的调用，并给出准确原因）；
      //      ② 发出去的用 get_msg 复核，**不信协议端的 ok**。
      //    只做 ① 不够 —— 卡在窗口边界上的消息仍会谎报成功。
      const okIds = [];
      const expired = [];
      const failures = [];
      const attempted = [];

      // 第一遍：只发撤回请求，条与条之间留间隔（别把协议端/桥接端惹毛）
      for (const t of targets) {
        if (t.ageMs > RECALL_WINDOW_MS) {
          expired.push(t);
          continue;
        }
        if (attempted.length > 0) await sleep(interval);
        try {
          await ctx.onebot.call('delete_msg', { message_id: t.message_id });
          attempted.push(t);
        } catch (err) {
          failures.push({ mid: t.mid, text: t.text, reason: err?.message ?? String(err) });
        }
      }

      // 第二遍：等缓存失效后再逐条复核。
      // 一条都不删就直接查，协议端还会报「消息在」（真机实测，见 VERIFY_DELAY_MS），
      // 那样会把成功的撤回全判成失败 —— 就是「只撤成功一个」那次故障。
      if (attempted.length) await sleep(VERIFY_DELAY_MS);
      for (const t of attempted) {
        let gone = true;
        try {
          await ctx.onebot.call('get_msg', { message_id: t.message_id });
          gone = false;
        } catch { /* 查不到 = 确实撤掉了，正是期望结果 */ }
        if (gone) {
          okIds.push(t.mid);
          try { ctx.store?.markRecalled?.(ctx.chatKey, t.mid); } catch { /* ignore */ }
        } else {
          failures.push({ mid: t.mid, text: t.text, reason: 'QQ 没有真的撤回（多半已超出可撤回时间）' });
        }
      }

      api.log?.(`${ctx.chatKey} 批量撤回：成功 ${okIds.length} / 超时 ${expired.length} / 失败 ${failures.length}`
        + `（要求 ${targets.length} 条，间隔 ${interval}ms，触发者 ${callerId || '未知'}）`);

      // 全部成功
      if (!failures.length && !expired.length) {
        // 把**实际撤回的那几条**列出来：模型手上有了确切内容，就不会去编
        //「多少分钟前发的」这类数字（2026-10-04 就吃过这个亏）。
        const listed = targets
          .slice(0, 6)
          .map((t) => `· ${String(t.mid)}${t.text ? `「${t.text}」` : ''}`)
          .join('\n');
        return {
          content: `已撤回 ${okIds.length} 条消息（每条间隔 ${interval}ms）。实际撤回的就是这些：\n${listed}`
            + '\n不要再复述这些消息的内容，简短确认即可；也不要补充其它数字。'
        };
      }

      // 一条都没成 → 必须让模型知道。否则它会照旧回一句「撤干净了」，
      // 那正是这次线上故障的表现。
      if (!okIds.length) {
        const ages = expired.length
          ? `它们分别在 ${expired.map((t) => Math.round(t.ageMs / 1000) + ' 秒').join(' / ')} 前发出，已经超出窗口。`
          : '';
        return {
          content: `撤回失败了：${targets.length} 条**一条都没撤掉**。\n`
            + `QQ 只允许撤回约 2 分钟内的消息。${ages}\n`
            + '请如实告诉用户「时间太久，撤不回来了」，**绝对不要说撤回成功**。',
          isError: true
        };
      }

      // 部分成功：如实分开报，别笼统说「全撤了」
      const parts = [`成功 ${okIds.length} 条`];
      if (expired.length) parts.push(`超时撤不掉 ${expired.length} 条`);
      if (failures.length) parts.push(`失败 ${failures.length} 条`);
      const oldest = expired.length ? Math.round(Math.max(...expired.map((t) => t.ageMs)) / 1000) : 0;
      const detail = expired.length
        ? `\n· 其中 ${expired.length} 条已经太老（最久的 ${oldest} 秒前发出），超过 QQ 约 2 分钟的可撤回窗口。`
        : '';
      const why = failures.length
        ? '\n' + failures.slice(0, 2).map((f) => `· ID ${f.mid}${f.text ? `「${f.text}」` : ''}：${f.reason}`).join('\n')
        : '';
      return {
        content: `批量撤回：${parts.join('，')}（共要求 ${targets.length} 条）。${detail}${why}\n`
          + '请如实告诉用户哪几条撤掉了、哪几条因为太旧撤不掉，**不要笼统说「全撤了」**。'
      };
    }
  });
}
