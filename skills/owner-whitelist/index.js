// 主人改白名单 —— 主人在聊天里直接说，就能查看 / 添加 / 删除「聊天白名单」。
//
// ── 靠什么认人（自给自足，不依赖任何其它插件）────────────────────────────────
// 主人 QQ 号填在本技能设置里（configSchema 的 ownerIds），判定只看**号码相等**：
//   · 号码来源：ctx.session.trigger[].senderId —— 协议字段，不是聊天正文。
//     ⚠️ 工具的 ctx 里**没有** senderId / userId（orchestrator.js:899 的实际字段就是这样），
//        别去 ctx.userId 上找；做法与 skills/message-recall-2 的 resolveCallerId() 一致。
//   · 名字、群名片、备注名、以及正文里自称"我是你主人"，一律不作数
//     （展示字段会改也会撞名；自称属于文本，永远进不到这条链路）。
// 不是主人 → 直接拒绝，**连白名单内容都不回**（名单本身就是"机器人在哪儿工作"的情报）。
//
// 说明：这里刻意**不再**软依赖 plugins/owner-identity 的 message.owner-check 能力。
// 那份能力管的是"人设切换 + 发言标记"，与本技能要的"谁能改白名单"是两件事；
// 各存一份名单虽然多填一次，但换来的是：本技能单独可用、行为不看别人脸色。
//
// ── 改的是什么 ─────────────────────────────────────────────────────────────
// 核心配置的 config.allow = { groups: [], private: [] }（设置页里叫「聊天白名单」）。
// 写配置走核心的 updateConfig：改内存里的活配置 + 立刻落盘 → **即时生效、不用重启**
//   （app.js 的 allowed() 每条消息都重读 getConfig()；设置页也写着"模型/人设/白名单即时生效"）。
// deepMerge 对数组是**整体替换**（config.js:434 的 Array.isArray 分支），所以直接传新数组即可。
// 与 plugins/qzone-diary 同款做法 —— 官方插件也是直接 import 核心 config 再 updateConfig。
//
// ── 为什么做成工具，而不是钩子 ─────────────────────────────────────────────
// 钩子 5 秒超时、不能发消息、规范里明确"不得有副作用"；改白名单是写操作，而且还要把结果
// 回给主人 —— 这两件事都只有工具能做（doc/extend_development/plugin-development.md §2）。
// 顺带的好处：主人说"把这个群加进白名单"这类自然语言也能用，不用背固定口令。

let api = null;
let cfg = () => ({});

/** 工具短名（注册后实际 id 是 owner-whitelist__whitelist）。 */
const TOOL_ID = 'whitelist';
/** QQ 号 / 群号形态：5~15 位纯数字（QQ 号从 10000 起发）。 */
const ID_RE = /^\d{5,15}$/;
/** 条数上限：防止模型犯傻一次塞几千条把配置撑爆。 */
const MAX_ENTRIES = 200;
/** kind → config.allow 里的键名。⚠️ 私聊那条键就叫 private，不是 privates。 */
const LIST_KEY = { group: 'groups', private: 'private' };
const KIND_LABEL = { group: '群', private: '私聊' };

const log = (...a) => { try { api?.log?.(...a); } catch { /* 日志失败不影响功能 */ } };

// ── 谁是主人 ───────────────────────────────────────────────────────────────

/**
 * 归一化主人名单：接受数组，或逗号/分号/顿号/空白分隔的字符串（中英文标点都认）。
 * 只保留合法 QQ 号并去重，顺序保持录入顺序（提示词与日志更稳定），非法项直接丢掉。
 */
export function normalizeOwnerIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，;；、\s]+/);
  const out = [];
  for (const item of list) {
    const id = String(item ?? '').trim();
    if (ID_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 本技能设置里生效的主人名单（留空 = 本技能不生效）。 */
export function ownerIds(conf = null) {
  return normalizeOwnerIds((conf || cfg()).ownerIds);
}

/** 解析触发者 QQ 号：取触发批条目上的 senderId（协议字段，与正文无关）。 */
export function resolveCallerId(ctx) {
  const entries = ctx?.session?.trigger;
  if (Array.isArray(entries)) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const sid = String(entries[i]?.senderId ?? '').trim();
      if (sid && sid !== 'self') return sid;
    }
  }
  try {
    const recent = ctx?.store?.recent?.(ctx.chatKey, { limit: 30, includeSelf: false }) || [];
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const sid = String(recent[i]?.senderId ?? '').trim();
      if (sid && sid !== 'self') return sid;
    }
  } catch { /* store 不可用就当拿不到 */ }
  return '';
}

/**
 * 主人闸门：判据只有一条 —— 调用者的 QQ 号在本技能设置的主人名单里。
 * 三种失败要给**不同**的话：没配名单 / 取不到号码 / 不是主人 —— 修法完全不同。
 */
export function checkOwner(callerId) {
  const ids = ownerIds();
  if (!ids.length) {
    return { ok: false, reason: '还没填主人 QQ 号：去「技能 → 主人改白名单 → 主人 QQ 号」填上（多个用逗号分隔），填好就能用。' };
  }
  if (!callerId) {
    return { ok: false, reason: '拿不到这条消息的发送者 QQ 号，没法确认是不是主人。' };
  }
  const id = String(callerId).trim();
  if (!ids.includes(id)) {
    return { ok: false, reason: `只有主人能改聊天白名单（这条消息来自 QQ:${id}，不在主人名单里）。` };
  }
  return { ok: true, callerId: id };
}

// ── 读写核心配置 ───────────────────────────────────────────────────────────

/** 测试注入位（生产为 null）。 */
let injectedOps = null;
let coreOpsPromise = null;

/**
 * 定位核心的 src/config.js。技能可能被放在两处，两条相对路径都试：
 *   resources/app/skills/<id>/index.js → ../../src/config.js
 *   <数据根>/modules/<id>/index.js     → ../../../resources/app/src/config.js
 */
export async function loadCoreOps() {
  const candidates = ['../../src/config.js', '../../../resources/app/src/config.js'];
  const tried = [];
  for (const rel of candidates) {
    try {
      const mod = await import(rel);
      if (typeof mod.getConfig === 'function' && typeof mod.updateConfig === 'function') {
        return {
          getConfig: mod.getConfig,
          updateConfig: mod.updateConfig,
          // 一并带出来：自测用它验证"数组是整体替换"这条假设（纯函数，无副作用）
          deepMerge: typeof mod.deepMerge === 'function' ? mod.deepMerge : null,
          from: rel,
        };
      }
      tried.push(`${rel}（导出不完整）`);
    } catch (error) {
      tried.push(`${rel}（${error?.message ?? error}）`);
    }
  }
  throw new Error(`找不到核心配置模块，两条路径都不通：${tried.join('；')}`);
}

async function configOps() {
  if (injectedOps) return injectedOps;
  if (!coreOpsPromise) coreOpsPromise = loadCoreOps();
  return coreOpsPromise;
}

/** 只读快照：白名单 / 黑名单 / 留空放行。缺字段一律按空处理。 */
export function snapshot(conf) {
  const ids = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  return {
    allow: { groups: ids(conf?.allow?.groups), private: ids(conf?.allow?.private) },
    deny: { groups: ids(conf?.deny?.groups), private: ids(conf?.deny?.private) },
    allowAllWhenEmpty: conf?.allowAllWhenEmpty === true,
  };
}

/** 归一化号码：容忍模型传 "群123456" / "QQ:123456" / " 123456 " 这类写法。 */
export function normalizeId(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return ID_RE.test(digits) ? digits : '';
}

/** 改动前的风险提示（不阻断，只提醒 —— 都要原样转达给主人）。 */
export function warningsFor({ snap, kind, id, action, currentChatId }) {
  const key = LIST_KEY[kind];
  const warns = [];
  const total = snap.allow.groups.length + snap.allow.private.length;
  if (action === 'add') {
    if (snap.deny[key].includes(id)) {
      warns.push(`⚠️ ${id} 在黑名单里，而黑名单优先 —— 光加白名单它也不会得到回应；要真放行得先在「设置 → 聊天白名单」把它从黑名单里去掉。`);
    }
    if (snap.allowAllWhenEmpty && total === 0) {
      warns.push('⚠️ 现在开着「白名单留空时允许所有会话」：这条一加白名单就不空了，机器人会**立刻变成只在白名单里的会话回话**，其它群/私聊静默。');
    }
  }
  if (action === 'remove') {
    if (total === 1 && !snap.allowAllWhenEmpty) {
      warns.push('⚠️ 这是最后一条白名单：移除后名单为空，机器人将不在任何群/私聊里工作（除非去设置里勾上「白名单留空时允许所有会话」）。');
    }
    if (currentChatId && id === currentChatId) {
      warns.push('⚠️ 移除的就是当前这个会话：之后我在这里不会再回话。');
    }
  }
  return warns;
}

const fmtIds = (arr) => {
  if (!arr.length) return '（空）';
  return arr.length <= 50 ? arr.join('、') : `${arr.slice(0, 50).join('、')} …（共 ${arr.length} 个）`;
};

/** 简短现状（每次改完都带一句，主人一眼看到结果）。 */
export function renderBrief(snap) {
  return `当前白名单：群 ${snap.allow.groups.length} 个 / 私聊 ${snap.allow.private.length} 个；`
    + `黑名单：群 ${snap.deny.groups.length} / 私聊 ${snap.deny.private.length}。改动即时生效，不用重启。`;
}

/** 完整名单（list 动作）。 */
export function renderList(snap, ctx) {
  const lines = ['📋 聊天白名单（机器人只在名单内的群/私聊里工作）'];
  lines.push(`群聊（${snap.allow.groups.length}）：${fmtIds(snap.allow.groups)}`);
  lines.push(`私聊（${snap.allow.private.length}）：${fmtIds(snap.allow.private)}`);
  lines.push('— 相关设置（本工具只读不改）—');
  lines.push(`黑名单：群 ${snap.deny.groups.length} / 私聊 ${snap.deny.private.length}`
    + (snap.deny.groups.length + snap.deny.private.length ? '（黑名单优先，在里面的不回应）' : ''));
  lines.push(`白名单留空时允许所有会话：${snap.allowAllWhenEmpty ? '开' : '关'}`);
  const chatKey = String(ctx?.chatKey || '');
  if (chatKey) {
    const [k, id] = chatKey.split(':');
    const key = k === 'group' ? 'groups' : 'private';
    lines.push(`当前会话 ${chatKey}：${snap.allow[key].includes(String(id)) ? '在白名单里' : '不在白名单里'}`);
  }
  return lines.join('\n');
}

// ── 工具主流程 ─────────────────────────────────────────────────────────────

/**
 * 工具的执行体。全程只有一条写路径：ops.updateConfig({ allow: { <key>: 新数组 } })。
 * @returns {Promise<{content: string, isError?: boolean}>}
 */
export async function runWhitelist(ctx, args) {
  const action = String(args?.action ?? 'list').trim().toLowerCase();
  if (!['list', 'add', 'remove'].includes(action)) {
    return { content: `action 只能是 list / add / remove，收到的是「${args?.action}」。`, isError: true };
  }

  // ① 认人 —— 先于一切读配置：不是主人连名单都不给看
  const callerId = resolveCallerId(ctx);
  const gate = checkOwner(callerId);
  if (!gate.ok) {
    log(`拒绝了一次改白名单请求：${gate.reason}`);
    return { content: gate.reason, isError: true };
  }

  // ② 拿核心配置
  let ops;
  try {
    ops = await configOps();
  } catch (error) {
    return { content: `读不到核心配置，没法改白名单：${error?.message ?? error}`, isError: true };
  }
  const snap = snapshot(ops.getConfig());
  if (action === 'list') return { content: renderList(snap, ctx) };

  // ③ 定位目标：不给 target 就是"当前这个会话"
  const chatKey = String(ctx?.chatKey || '');
  const currentKind = String(ctx?.kind || (chatKey.startsWith('group:') ? 'group' : 'private'));
  const currentChatId = String(ctx?.chatId || chatKey.split(':')[1] || '');
  const kind = String(args?.kind || currentKind).trim().toLowerCase();
  if (!LIST_KEY[kind]) {
    return { content: `kind 只能是 group（群）或 private（私聊），收到的是「${args?.kind}」。`, isError: true };
  }
  const rawTarget = String(args?.target ?? '').trim();
  const id = rawTarget ? normalizeId(rawTarget) : normalizeId(currentChatId);
  if (!id) {
    return {
      content: rawTarget
        ? `「${rawTarget}」不像群号或 QQ 号（要 5~15 位纯数字）。`
        : '没给号码，也拿不到当前会话的号码；请直接给出群号 / QQ 号。',
      isError: true,
    };
  }

  const key = LIST_KEY[kind];
  const list = snap.allow[key];

  // ④ 幂等与上限：先判再写，避免无意义的落盘
  if (action === 'add' && list.includes(id)) {
    return { content: `${KIND_LABEL[kind]} ${id} 已经在聊天白名单里了（没有重复添加）。${renderBrief(snap)}` };
  }
  if (action === 'remove' && !list.includes(id)) {
    return { content: `${KIND_LABEL[kind]} ${id} 本来就不在聊天白名单里（没有改动）。${renderBrief(snap)}` };
  }
  if (action === 'add' && list.length >= MAX_ENTRIES) {
    return { content: `白名单已经有 ${list.length} 条，达到上限 ${MAX_ENTRIES} 条，不再自动添加；请去设置页清理。`, isError: true };
  }

  const next = action === 'add' ? [...list, id] : list.filter((x) => x !== id);
  const warns = warningsFor({ snap, kind, id, action, currentChatId });

  // ⑤ 唯一的写路径
  try {
    ops.updateConfig({ allow: { [key]: next } });
  } catch (error) {
    return { content: `写入配置失败（没有改动）：${error?.message ?? error}`, isError: true };
  }
  log(`主人 ${callerId} ${action === 'add' ? '加入' : '移除'}${KIND_LABEL[kind]} ${id}（${list.length} → ${next.length}）`);

  const after = snapshot(ops.getConfig());
  const head = action === 'add'
    ? `✅ 已把${KIND_LABEL[kind]} ${id} 加进聊天白名单。`
    : `✅ 已把${KIND_LABEL[kind]} ${id} 移出聊天白名单。`;
  return { content: [head, renderBrief(after), ...warns].filter(Boolean).join('\n') };
}

// ── 技能生命周期 ───────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  cfg = a?.config || (() => ({}));
  try {
    a.registerTool({
      id: TOOL_ID,
      name: '聊天白名单',
      description:
        '查看 / 添加 / 删除「聊天白名单」——机器人只在白名单里的群和私聊里工作。'
        + '有人要求改白名单时（如「把这个群加进白名单」「把 123456 移出白名单」「白名单里有哪些」）调用本工具；'
        + '主人身份由本工具按设置里的主人 QQ 号自行校验，你不必自己判断，非主人的调用会被拒绝。'
        + '改动即时生效，无需重启。',
      category: 'system',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'remove'],
            description: 'list=查看当前白名单；add=加进白名单；remove=从白名单移除。默认 list。',
          },
          target: {
            type: 'string',
            description: '群号或 QQ 号（5~15 位数字）。省略 = 当前这个会话（群里就是本群群号，私聊就是对方 QQ 号）。',
          },
          kind: {
            type: 'string',
            enum: ['group', 'private'],
            description: 'target 是群号还是 QQ 号。省略 = 跟随当前会话类型。',
          },
        },
        required: ['action'],
      },
      execute: (ctx, args) => runWhitelist(ctx, args),
    });
  } catch (error) {
    log(`工具注册失败：${error?.message ?? error}`);
  }
}

export function available() {
  if (cfg().enabled === false) return { ok: false, reason: '技能设置里的「启用」是关的' };
  if (!ownerIds().length) {
    return { ok: false, reason: '还没填主人 QQ 号 —— 在技能设置里填上（多个用逗号分隔），这个技能才会生效' };
  }
  return { ok: true };
}

// 提示词片段**不在这里导出** —— 规则写在 skill.json 的 prompt.sections 里（id:
// owner-whitelist-rules）。原因：加载器会把清单静态片段与导出的 promptSections() 按 id
// 去重（src/skills/manager.js:470-493），两处都写就等于要维护两份；而"技能没生效就别注入"
// 这件事由加载器的 isActive 统一管（loaded && enabled && available && 依赖满足），
// 静态片段同样受它管，不写动态版反而少一处漂移。

/** 测试与调试入口（正式运行不需要）。 */
export const internals = {
  resolveCallerId, checkOwner, ownerIds, normalizeOwnerIds, snapshot, normalizeId,
  warningsFor, runWhitelist, renderList, renderBrief, loadCoreOps,
  MAX_ENTRIES, TOOL_ID,
  setConfigOps: (ops) => { injectedOps = ops; },
  resetConfigOps: () => { injectedOps = null; coreOpsPromise = null; },
};
