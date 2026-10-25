// 新人进群欢迎（welcome-newcomer）：群里进来新成员 → 自动发一条自定义欢迎语。
//
// 为什么不是 hooks：
//   核心的 5 个 hook（before-context / before-llm-messages / after-response /
//   before-tool / after-tool）只在**已经排定一次模型会话之后**才触发。而「有人进群」
//   是 QQ 的**通知事件**（OneBot: post_type=notice, notice_type=group_increase），
//   它既不是消息、也不会触发任何会话 —— 核心的 handleOneBotEvent 目前只认
//   poke / recall / group_ban 三类 notice，入群通知进来就被丢掉了。
//   所以这里直接接在 OneBotClient 实例的 onEvent 上（每个协议端事件的必经点），
//   全程没有任何模型调用，一分钱 token 不花。
//
// 怎么拿到 OneBotClient 实例：它在 app.js 里 new 出来、没导出，插件拿不到引用。
//   做法是在原型方法上挂三个「捕获点」（call / connect / Orchestrator.onIncoming），
//   任何一个被调用时 this 就是那个实例，拿到后把自己的处理函数包到实例的 onEvent 上。
//   幂等 + 可摘除：热重载时旧模块先 deactivate（还原 onEvent），新模块再 activate 重新包。
//
// 安全边界：
//   · 生效范围：设置里填了「自定义群号白名单」就只认那些群；没填则沿用全局白名单
//     （config.allow/deny，与核心 allowed() 同口径）。全局黑名单永远优先拦截；
//   · 机器人自己进群不欢迎自己；
//   · 走 sender.sendTextBatch：睡眠时段 / 发送限频 / 去重 / 存档全部照常生效；
//   · 关掉插件 = 摘钩子 + 还原 onEvent，不留任何监听。
//
// 测试指令（//欢迎 / //再见）：
//   接在协议端**原始事件**上（onebot.onEvent），比核心 ingestMessage 里的
//   allowed() 白名单门禁更早 —— 所以黑名单里、白名单外的群也能拿它做测试。
//   测试时跳过群名单判定与全部限流（否则"测一次要等 60 分钟"）。
//   指令本身在 onIncoming 处被标已读并拦下，不会去吵模型。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（配置不受影响）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../../src/orchestrator.js';
import { OneBotClient } from '../../src/onebot.js';
// toFileUri：本地路径 → `file:///C:/a/b.png`。裸 Windows 路径（反斜杠+盘符）在
// 各协议端支持不一致，规范里的形式是 file URI，且空格/中文/`#`/`?` 都要编码。
import { toFileUri } from '../../src/sender.js';
import { logger } from '../../src/logger.js';
import { DATA_DIR, getConfig } from '../../src/config.js';

const PLUGIN_ID = 'welcome-newcomer';
const STATE_FILE = path.join(DATA_DIR, 'welcome-newcomer.json');
// 插件自目录（APP_ROOT = resources/app）：填相对路径时的解析基准之一
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

// 原型钩子标记（用 Symbol.for：热重载后是新模块实例，普通 Symbol 会认不出上一次的钩子）
const OB_CALL_KEY = Symbol.for('qq-agent.welcome-newcomer.ob.call');
const OB_CONNECT_KEY = Symbol.for('qq-agent.welcome-newcomer.ob.connect');
const ORCH_KEY = Symbol.for('qq-agent.welcome-newcomer.orch.onIncoming');
// 实例标记：这个 OneBotClient 的 onEvent 已经被我们包过了（防重复包 → 防一条事件发两遍）
const HOOKED = Symbol.for('qq-agent.welcome-newcomer.hooked');
const WRAP_MARK = Symbol.for('qq-agent.welcome-newcomer.wrap');

let api = null;
let onebotRef = null;
let orchRef = null;
let lastFlush = 0;
let armTimer = null;      // 启动自检定时器（30 秒后确认是否已接管事件流）
let imageWarned = false;  // 「开了配图但没填路径」只提示一次
let listWarned = false;   // 「填了群号但一个都没解析出来」只提示一次
let listWarnSig = '';     // 上面那条提示按「原始文本」记，改了内容就再提示一次

const groupState = new Map();   // groupId -> { lastAt, users: Map<userId, ts>, recent: [ts] }
const stats = {
  captured: false,      // 是否已拿到协议端实例（拿到才收得到入群事件）
  joinEvents: 0,        // 收到的入群通知条数
  leaveEvents: 0,
  welcomed: 0,          // 实际发出去的欢迎条数
  farewells: 0,
  images: 0,            // 跟在欢迎语后面的图片数
  skipped: 0,
  blockedByGroup: 0,    // 被「自定义群号白名单」拦下的次数（群号填错了看这里）
  lastBlockedGroup: '', // 最近一次被拦下的群号
  testRuns: 0,          // 测试指令触发次数
  lastTest: '',         // 最近一次测试指令
  previews: 0,          // 私信预览次数
  lastPreview: '',      // 最近一次私信预览的内容
  aiWelcomes: 0,        // AI 成功生成的欢迎语条数
  aiFallbacks: 0,       // AI 失败后回退模板的次数
  fallbackRuns: 0,      // 从会话入口补跑的次数（原始事件那条路还没挂上的"第一条消息"）
  leaveDetected: 0,     // 靠「成员名单比对」兜底检出的退群次数（协议端没上报通知时）
  noticeKinds: {},      // 协议端上报过的通知类型统计（排障：确认事件到底有没有来）
  lastNotice: '',       // 最近一次收到的通知
  lastAt: 0,
  lastGroup: '',
  lastText: '',
  lastImage: '',
  lastError: ''
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function settings() {
  try { return (typeof api?.config === 'function' ? api.config() : null) || {}; }
  catch { return {}; }
}

function debug(msg) {
  if (settings().debugLog !== true) return;
  logger.info(PLUGIN_ID, msg);
}

// ── 生命周期 ────────────────────────────────────────────────────────────

export async function setup(skillApi) {
  api = skillApi;
}

export function available() {
  return { ok: true };
}

export function activate() {
  const ok = install();
  if (ok) {
    const scope = customWhitelist().active ? '自定义群号白名单内生效' : '沿用全局白名单（未填自定义群号）';
    logger.info(PLUGIN_ID, `新人进群欢迎已挂载（0 token，${scope}）`);
  }
  // 自检：协议端实例是在 app 启动时 new 的，插件只能等它下次被调用时"逮到"。
  // 30 秒还没逮到说明这条路上没有流量（机器人完全静默），明确提示，别让人以为装好了其实收不到事件。
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armTimer = null;
    if (!onebotRef) {
      logger.warn(PLUGIN_ID, '还没接管到协议端事件流（30 秒内没有任何消息/API 调用）：'
        + '插件已挂载，等机器人收到第一条消息后会自动接管，届时才会开始发欢迎语。');
    }
  }, 30000);
  armTimer.unref?.();
  startLeavePolling();
}

export function deactivate() {
  clearTimeout(armTimer);
  armTimer = null;
  stopLeavePolling();
  uninstall();
}

export function dispose() {
  stopLeavePolling();
  uninstall();
  groupState.clear();
}

/** 状态查询能力：给控制台/排障用（不是给模型的工具）。 */
export const providers = {
  'welcome-newcomer.status': () => ({
    ...stats,
    whitelist: [...customWhitelist().ids],
    whitelistRaw: String(settings().groupWhitelist ?? ''),
    whitelistMode: customWhitelist().ids.size ? '自定义群号' : '沿用全局白名单',
    capturedAt: stats.captured ? new Date(stats.lastAt || Date.now()).toLocaleString('zh-CN', { hour12: false }) : '',
    groups: [...groupState.entries()].map(([gid, st]) => ({
      group: gid, lastAt: st.lastAt, recent: st.recent.length, users: st.users.size
    }))
  })
};

// ── 捕获 + 挂钩 ─────────────────────────────────────────────────────────

/** 在原型方法上包一层，只为拿到 this（实例）。幂等，可还原。
 *  before 返回 'veto' 时**不调用原方法**（用来拦下测试指令、不让它去吵模型）。 */
function patchMethod(proto, name, key, before) {
  if (!proto || typeof proto[name] !== 'function') return false;
  let rec = proto[key];
  if (!rec) {
    const original = proto[name];
    const wrapped = function (...args) {
      try { if (before(this, args) === 'veto') return; } catch { /* 捕获失败绝不影响原调用 */ }
      return original.apply(this, args);
    };
    rec = { original, wrapped };
    proto[key] = rec;
    proto[name] = wrapped;
  }
  return true;
}

function unpatchMethod(proto, name, key) {
  const rec = proto?.[key];
  if (!rec) return;
  if (proto[name] === rec.wrapped) proto[name] = rec.original;
  delete proto[key];
}

function install() {
  let ok = false;
  ok = patchMethod(OneBotClient?.prototype, 'call', OB_CALL_KEY, (inst) => capture(inst)) || ok;
  patchMethod(OneBotClient?.prototype, 'connect', OB_CONNECT_KEY, (inst) => capture(inst));
  // 每条入站消息的必经点（与 repeat-echo / nsfw-guard 同一种挂法），顺带拿到
  // Orchestrator —— 它身上既有 sender（完整发送管道）也有 onebot。
  ok = patchMethod(Orchestrator?.prototype, 'onIncoming', ORCH_KEY, (inst, args) => {
    if (inst && !orchRef) {
      orchRef = inst;
      logger.info(PLUGIN_ID, '已拿到会话调度器（发送走完整管道：限频/去重/存档）');
    }
    capture(inst?.onebot);
    capture(inst?.sender?.onebot);
    // 兜底：原始事件那条路在"加载后的第一条消息"上是挂不上的（那时还没拿到协议端
    // 实例，onEvent 也就没包上），所以在这里补跑一次。少了这一步，用户第一次发
    // 指令就是"完全没反应"，而且日志里什么都没有。
    try { runFromIncoming(args?.[0], args?.[1]); }
    catch { /* 补跑失败不影响核心逻辑 */ }
    // 测试指令不该吵模型：命中就标已读并拦下这条（不让 onIncoming 排会话）
    try {
      if (vetoTestCommand(inst, args?.[0], args?.[1])) return 'veto';
    } catch { /* 拦不下就算了，最多机器人多回一句 */ }
  }) || ok;
  if (!ok) {
    logger.warn(PLUGIN_ID, '拿不到 OneBotClient / Orchestrator 原型方法，欢迎功能未挂载（应用版本可能变了）');
  }
  return ok;
}

function uninstall() {
  unpatchMethod(OneBotClient?.prototype, 'call', OB_CALL_KEY);
  unpatchMethod(OneBotClient?.prototype, 'connect', OB_CONNECT_KEY);
  unpatchMethod(Orchestrator?.prototype, 'onIncoming', ORCH_KEY);
  unhook(onebotRef);
  orchRef = null;
}

/** 拿到协议端实例 → 把处理函数包到它的 onEvent 上。 */
function capture(inst) {
  if (!inst || typeof inst !== 'object') return;
  if (typeof inst.onEvent !== 'function' && typeof inst.call !== 'function') return;
  if (!onebotRef) onebotRef = inst;
  if (inst[HOOKED]) return;

  const orig = inst.onEvent;
  if (typeof orig !== 'function') return;

  const wrapped = (event) => {
    try { handleEvent(event); }
    catch (error) { logger.warn(PLUGIN_ID, `处理事件出错：${error?.message ?? error}`); }
    return orig(event);
  };
  wrapped[WRAP_MARK] = true;
  inst.onEvent = wrapped;
  inst[HOOKED] = { orig };
  stats.captured = true;
  logger.info(PLUGIN_ID, '已接管协议端事件流：开始接收入群/退群通知');
  flushState(true);
}

/** 还原：只在我们包的那一层还在最外层时才摘，避免误伤别的插件的包层。 */
function unhook(inst) {
  const rec = inst?.[HOOKED];
  if (!rec) return;
  const cur = inst.onEvent;
  if (typeof cur === 'function' && cur[WRAP_MARK] === true) inst.onEvent = rec.orig;
  delete inst[HOOKED];
  stats.captured = false;
}

// ── 事件处理 ────────────────────────────────────────────────────────────

function handleEvent(event) {
  if (!event || typeof event !== 'object') return;
  const s = settings();
  if (s.enabled === false) return;

  // 测试指令：在核心的 allowed() 白名单门禁**之前**就截住（这里是协议端原始事件），
  // 所以黑名单里、白名单外的群一样能测。
  if (event.post_type === 'message' || event.post_type === 'message_sent') {
    tryTestCommand(event).catch((error) => {
      stats.lastError = String(error?.message ?? error);
      logger.warn(PLUGIN_ID, `测试指令执行出错：${stats.lastError}`);
    });
    return;
  }

  if (event.post_type !== 'notice') return;

  const gid = event.group_id != null ? String(event.group_id) : '';
  if (!gid) return;
  noteNotice(event);   // 排障用：协议端到底上报了哪些通知类型，日志里要看得见

  if (event.notice_type === 'group_increase') {
    stats.joinEvents++;
    const uid = String(event.user_id ?? '');
    if (!/^\d+$/.test(uid)) return;
    // 机器人自己被拉进群：不欢迎自己（协议端会把它算成一次 group_increase）
    const selfId = onebotRef?.selfId ? String(onebotRef.selfId) : '';
    if (selfId && uid === selfId) { debug(`群 ${gid}：是自己进群，跳过`); return; }
    fire('join', gid, uid);
    return;
  }

  // 退群/被踢：不同协议端对同一件事的 notice_type 叫法不统一，这里多认几种。
  if (LEAVE_NOTICE_TYPES.has(String(event.notice_type ?? ''))) {
    stats.leaveEvents++;
    const uid = String(event.user_id ?? '');
    if (!/^\d+$/.test(uid)) { logger.warn(PLUGIN_ID, `退群通知里没有有效的成员 QQ（${event.notice_type}），跳过`); return; }
    if (onebotRef?.selfId && uid === String(onebotRef.selfId)) { debug(`群 ${gid}：是自己退群，跳过`); return; }
    // 记一笔：兜底轮询别再把同一个人报一遍
    markLeft(stateOf(gid), uid);
    if (s.farewellEnabled !== true) { debug(`群 ${gid} 收到退群通知，但「退群告别」开关没开，跳过`); return; }
    logger.info(PLUGIN_ID, `收到退群通知（${event.notice_type}${event.sub_type ? `/${event.sub_type}` : ''}）：群 ${gid} 成员 ${uid}`);
    fire('leave', gid, uid);
  }
}

/**
 * 排障用：把协议端上报过的通知类型记下来，每种只打一次日志。
 * 「为什么退群没反应」这类问题，第一步就是要确认事件到底有没有到。
 */
const seenNoticeTypes = new Set();
function noteNotice(event) {
  const type = String(event.notice_type ?? event.sub_type ?? '(未知)');
  stats.noticeKinds[type] = (stats.noticeKinds[type] ?? 0) + 1;
  stats.lastNotice = `${type} 群 ${event.group_id ?? '-'} ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  if (seenNoticeTypes.has(type)) return;
  seenNoticeTypes.add(type);
  logger.info(PLUGIN_ID, `协议端上报通知类型：${type}${event.sub_type ? `（${event.sub_type}）` : ''}`);
}

// 群里"少一个人"这件事，各家协议端的 notice_type 叫法不统一，都认一遍。
const LEAVE_NOTICE_TYPES = new Set([
  'group_decrease', 'group_leave', 'group_exit', 'group_member_decrease', 'group_member_leave'
]);

function fire(kind, gid, uid, opts = {}) {
  // 不 await：入群事件不该阻塞协议端事件分发
  (kind === 'join' ? handleJoin(gid, uid, opts) : handleLeave(gid, uid, opts))
    .catch((error) => {
      stats.lastError = String(error?.message ?? error);
      logger.warn(PLUGIN_ID, `${kind === 'join' ? '欢迎' : '告别'}失败：${stats.lastError}`);
    });
}

// ── 测试指令 ────────────────────────────────────────────────────────────

const TEST_WORDS = { 欢迎: 'join', 欢迎语: 'join', 入群: 'join', 再见: 'leave', 告别: 'leave', 退群: 'leave' };

/** 从协议端原始消息事件里取出纯文本（去掉 @ 段与 CQ 码）。 */
function messageTextOf(event) {
  const segs = event.message;
  if (Array.isArray(segs)) {
    return segs.filter((s) => s?.type === 'text').map((s) => String(s?.data?.text ?? '')).join('').trim();
  }
  return String(event.raw_message ?? event.message ?? '').replace(/\[CQ:[^\]]*\]/g, '').trim();
}

/**
 * 识别测试指令：`//欢迎` / `//再见`，后面最多跟两个号码。
 *   群里：  //欢迎 123456          → 123456 是「模拟谁」的 QQ 号
 *   私信：  //欢迎 324632156       → 324632156 是「拿哪个群当背景」的群号
 *          //欢迎 324632156 123456 → 群号 + 模拟谁的 QQ 号
 * @returns {{ kind: 'join'|'leave', nums: string[] } | null}
 */
export function matchTestCommand(text) {
  const t = String(text ?? '')
    .replace(/／/g, '/')          // 全角斜杠也认（中文输入法下很容易打成 ／／）
    .replace(/^([@＠]\S{0,30}\s*)+/, '')  // 去掉手打的「@昵称」前缀（真 @ 是段、不进文本，这里兜底）
    .trim();
  const m = t.match(/^\/{2}\s*(欢迎语|欢迎|入群|告别|再见|退群)(?:\s+(\d{4,20}))?(?:\s+(\d{4,20}))?\s*$/);
  if (!m) return null;
  return { kind: TEST_WORDS[m[1]], nums: [String(m[2] ?? ''), String(m[3] ?? '')].filter(Boolean) };
}

/** 原始消息事件 → 跑一次欢迎/送别流程（跳过群名单与全部限流）。 */
async function tryTestCommand(event) {
  const s = settings();
  if (s.testCommands === false) return false;
  const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
  // 机器人自己发的（message_sent）不算指令，否则会把自己的输出当输入
  if (!senderId || (onebotRef?.selfId && senderId === String(onebotRef.selfId))) return false;

  const hit = matchTestCommand(messageTextOf(event));
  if (!hit) return false;

  const isPrivate = event.message_type === 'private';
  const gid = String(event.group_id ?? '');
  if (!isPrivate && !gid) return false;
  const chatKey = isPrivate ? `private:${senderId}` : `group:${gid}`;
  // 记一笔"原始事件这条已经处理过了"，防止下面的 onIncoming 兜底再跑一遍
  markHandled(chatKey, messageTextOf(event));
  return runTestCommand({ hit, chatKey, senderId });
}

/**
 * onIncoming 兜底：刚加载 / 刚热重载后的第一条消息，原始事件那条路还没挂上
 * （协议端实例是到这里才拿到的），所以在这里补跑一次指令。
 */
function runFromIncoming(chatKey, entry) {
  const s = settings();
  if (s.enabled === false || s.testCommands === false) return false;
  if (!onebotRef) return false;
  const key = String(chatKey ?? '');
  if (!key.startsWith('private:') && !key.startsWith('group:')) return false;
  const text = String(entry?.text ?? '');
  const hit = matchTestCommand(text);
  if (!hit) return false;
  const senderId = String(entry?.senderId ?? key.split(':')[1] ?? '');
  if (!senderId) return false;
  if (onebotRef?.selfId && senderId === String(onebotRef.selfId)) return false;
  // 原始事件那条已经处理过 → 别再跑一次
  if (wasHandled(key, text)) return false;
  markHandled(key, text);
  stats.fallbackRuns++;
  logger.info(PLUGIN_ID, '[测试] 原始事件那条路还没挂上（刚加载的第一条消息），已从会话入口补跑');
  runTestCommand({ hit, chatKey: key, senderId }).catch((error) => {
    stats.lastError = String(error?.message ?? error);
    logger.warn(PLUGIN_ID, `测试指令执行出错：${stats.lastError}`);
  });
  return true;
}

/** 同一条指令 3 秒内不重复处理（防原始事件 + onIncoming 两条路各跑一遍）。 */
let lastHandled = { key: '', text: '', at: 0 };
function markHandled(key, text) { lastHandled = { key: String(key), text: String(text), at: Date.now() }; }
function wasHandled(key, text) {
  return lastHandled.key === String(key) && lastHandled.text === String(text)
    && Date.now() - lastHandled.at < 3000;
}

/** 真正干活：私信预览 / 群里跑一遍。跳过群名单与全部限流。 */
async function runTestCommand({ hit, chatKey, senderId }) {
  const s = settings();
  const label = hit.kind === 'join' ? '//欢迎（模拟入群）' : '//再见（模拟退群）';

  const isPrivate = String(chatKey).startsWith('private:');

  // ── 私信：默认**只在你自己的私信里预览**，一条都不进群（不打扰群友）──
  if (isPrivate) {
    // 群号只当"背景"用：填 {group} 群名 / {count} 人数、以及取群名片。不填也能预览。
    const gid = String(hit.nums[0] ?? s.testDefaultGroup ?? '').trim();
    const uid = hit.nums[1] || senderId;
    stats.testRuns++;

    if (s.testSendToGroup === true) {
      // 显式打开才真的发到群里（默认关）
      if (!/^\d{4,20}$/.test(gid)) {
        stats.lastTest = `${label} 私信（要发到群但没给群号，未执行）`;
        logger.warn(PLUGIN_ID, '[测试] 开了「真的发到群里」但没给群号，已取消');
        await replyPrivate(senderId, '要真的发到群里，得带上群号：//欢迎 群号（也可再跟一个 QQ 号指定模拟谁）。');
        return true;
      }
      stats.lastTest = `${label} 私信指定群 ${gid} 模拟对象 ${uid}（真的发到群里）`;
      logger.info(PLUGIN_ID, `[测试] ${stats.lastTest} —— 跳过群名单与全部限流`);
      fire(hit.kind, gid, uid, { test: true });
      await replyPrivate(senderId, `[测试] 已真的发到群 ${gid}，去那个群看效果。`);
      return true;
    }

    stats.lastTest = `${label} 私信预览${gid ? `（群背景 ${gid}）` : ''}`;
    logger.info(PLUGIN_ID, `[测试] ${stats.lastTest} —— 只在私信里预览，不进群`);
    await previewInPrivate(hit.kind, gid, uid, senderId);
    return true;
  }

  // ── 群里 ──
  const gid = String(chatKey).split(':')[1] ?? '';
  if (!gid) return false;
  const uid = hit.nums[0] || senderId;
  stats.testRuns++;
  stats.lastTest = `${label} 群 ${gid} 模拟对象 ${uid}${hit.nums[0] ? '' : '（指令发送者本人）'}`;
  logger.info(PLUGIN_ID, `[测试] ${stats.lastTest} —— 跳过群名单与全部限流`);
  fire(hit.kind, gid, uid, { test: true });
  return true;
}

/**
 * 私信预览：把"群里会收到的样子"原样发到你自己的私信里，**一条都不进群**。
 * 群号只用来补 {group}/{count} 和群名片；没给群号就按空值渲染，照样能看效果。
 * @ 在私信里没法真 @，退化成在正文前面写「@昵称」，让你看清大致形态。
 */
async function previewInPrivate(kind, gid, uid, toUid) {
  const s = settings();
  const isJoin = kind === 'join';
  const raw = isJoin ? String(s.welcomeTemplate ?? '') : String(s.farewellTemplate ?? '');
  if (!String(raw).trim()) {
    await replyPrivate(toUid, `[预览] ${isJoin ? '欢迎语' : '告别语'}还是空的，去插件设置里填一条才能看效果。`);
    return;
  }
  const info = gid ? await fetchProfile(gid, uid) : { nick: '', group: '', count: '' };
  let text = '';
  let useAt = false;
  if (isJoin && s.aiEnabled !== false) {
    try { text = await generateWelcome(gid, uid, info); } catch { /* 预览失败回退模板 */ }
  }
  if (!text) {
    ({ text, useAt } = render(pickLine(raw), { ...info, qq: uid }));
  }
  if (!text) {
    await replyPrivate(toUid, '[预览] 渲染出来是空的，检查一下占位符是不是写错了。');
    return;
  }
  const wantAt = isJoin && (useAt || s.atNewcomer !== false);
  const preview = (wantAt ? `@${info.nick || uid} ` : '') + text;
  await replyPrivate(toUid, preview);

  stats.previews++;
  stats.lastPreview = preview;
  logger.info(PLUGIN_ID, `[预览] ${isJoin ? '欢迎' : '告别'}（群背景 ${gid || '无'}）：${preview.slice(0, 60)}`);

  // 配图也一起预览（欢迎才有）；间隔在预览里没必要等，直接跟
  if (isJoin) await deliverImage(`private:${toUid}`, '私信预览', 0);
}

/** 私信回一句（测试反馈用）。 */
async function replyPrivate(uid, text) {
  try {
    // 预览/回执走**直发**，不过发送队列。
    // 队列有 8 秒内容去重 + 每分/每小时配额：连着测两次，第二次会被判成
    // "刚发过一样的内容"静默跳过 —— 表现就是"第一次有反应、之后就没了"。
    // 测试反馈要的是每次都看得到，所以直发；真正的群发送仍然走完整管道。
    if (onebotRef && typeof onebotRef.sendText === 'function') {
      await onebotRef.sendText('private', uid, text);
      return;
    }
    const sender = orchRef?.sender;
    if (sender && typeof sender.sendTextBatch === 'function') {
      await sender.sendTextBatch(`private:${uid}`, [text]);
      return;
    }
    logger.warn(PLUGIN_ID, '私信回执没发出去：拿不到发送通道（协议端实例未捕获）');
  } catch (error) {
    logger.warn(PLUGIN_ID, `私信回执没发出去：${error?.message ?? error}`);
  }
}

/**
 * 测试指令不该让模型开口：在 onIncoming 处命中就标已读 + 拦下（返回 'veto'）。
 * 群聊和私信都拦；只拦指令本身，其它消息完全不受影响。
 */
function vetoTestCommand(orch, chatKey, entry) {
  const s = settings();
  if (s.enabled === false || s.testCommands === false) return false;
  const key = String(chatKey ?? '');
  if (!key.startsWith('group:') && !key.startsWith('private:')) return false;
  if (!entry || entry.self) return false;
  if (!matchTestCommand(entry.text)) return false;
  try {
    orch?.store?.markEntryRead?.(chatKey, entry.id);
    orch?.emit?.('chat-update', chatKey);
  } catch { /* 标不了已读也照样拦，最坏是这条留在未读堆里 */ }
  return true;
}

async function handleJoin(gid, uid, opts = {}) {
  const s = settings();
  if (s.enabled === false) return;
  const isTest = opts?.test === true;

  // 测试指令：优先级高于白名单/黑名单，也跳过下面全部限流（否则测一次要等一小时）
  if (!isTest) {
    const gate = groupGate(gid);
    if (!gate.ok) {
      stats.skipped++;
      if (gate.by === '自定义群号白名单') stats.blockedByGroup++;
      debug(`群 ${gid} 不在${gate.by}里，跳过欢迎`);
      return;
    }
  }

  const now = Date.now();
  const st = stateOf(gid);

  // ── 三道限流闸（先判后发，放弃时不占配额）──
  if (!isTest) {
    const blockMin = Math.max(0, num(s.sameUserBlockMin, 60));
    if (blockMin > 0 && (st.users.get(uid) || 0) + blockMin * 60000 > now) {
      stats.skipped++; debug(`群 ${gid} 的 ${uid} 刚欢迎过（${blockMin} 分钟内不重复）`); return;
    }
    const cd = Math.max(0, num(s.cooldownSec, 30));
    if (cd > 0 && st.lastAt && now - st.lastAt < cd * 1000) {
      stats.skipped++; debug(`群 ${gid} 冷却中（${cd} 秒内不重复欢迎）`); return;
    }
    const maxHour = Math.max(0, num(s.maxPerHour, 6));
    st.recent = st.recent.filter((t) => now - t < 3600000);
    if (maxHour > 0 && st.recent.length >= maxHour) {
      stats.skipped++; debug(`群 ${gid} 本小时已欢迎 ${st.recent.length} 次，达到上限 ${maxHour}`); return;
    }
    // 占位：先占额度再发，防止同一秒的多个事件被并发处理成多条
    st.users.set(uid, now);
    st.lastAt = now;
    st.recent.push(now);
  }

  const raw = String(s.welcomeTemplate ?? '').trim();
  if (!raw) { debug('欢迎语是空的，跳过'); return; }
  const tpl = pickLine(raw);

  const delay = Math.min(60, Math.max(0, num(s.delaySec, 3)));
  if (delay > 0) await sleep(delay * 1000);

  const info = await fetchProfile(gid, uid);
  let text = '';
  let useAt = false;
  if (s.aiEnabled !== false) {
    try { text = await generateWelcome(gid, uid, info); }
    catch (error) { debug(`AI 欢迎语生成失败，回退模板：${error?.message ?? error}`); }
  }
  if (text) {
    stats.aiWelcomes++;
  } else {
    ({ text, useAt } = render(tpl, { ...info, qq: uid }));
    if (s.aiEnabled !== false) stats.aiFallbacks++;
  }
  if (!text) { debug('渲染出来的欢迎语是空的，跳过'); return; }

  const wantAt = useAt || s.atNewcomer !== false;
  await deliver(gid, text, wantAt ? uid : '');

  stats.welcomed++;
  stats.lastAt = Date.now();
  stats.lastGroup = gid;
  stats.lastText = text;
  logger.info(PLUGIN_ID, `欢迎 ${gid} 的 ${info.nick || uid}：${text.slice(0, 40)}`);

  // 图片跟在文字后面：文字已经发出去了，图片这一步失败也不影响欢迎本身
  await deliverImage(`group:${gid}`, gid);
  flushState(true);
}

async function handleLeave(gid, uid, opts = {}) {
  const s = settings();
  const isTest = opts?.test === true;
  const isFallback = opts?.fallback === true;
  // 测试指令直接跑，不看「退群告别」开关（不然测试看着像坏了）
  if (s.enabled === false || (!isTest && s.farewellEnabled !== true)) return;

  const now = Date.now();
  const st = stateOf(gid);
  if (!isTest) {
    const gate = groupGate(gid);
    if (!gate.ok) { debug(`群 ${gid} 不在${gate.by}里，跳过告别`); return; }
    // ⚠️ 冷却/配额必须和"欢迎"分开记：否则刚欢迎完一个人、紧接着有人退群，
    // 告别会被欢迎的冷却闸静默挡掉（实测踩到过）。
    const cd = Math.max(0, num(s.cooldownSec, 30));
    // 兜底检测本来就晚到，再套冷却只会更容易丢，所以只对通知那条路生效
    if (!isFallback && cd > 0 && st.lastLeftAt && now - st.lastLeftAt < cd * 1000) {
      debug(`群 ${gid} 告别冷却中（${cd} 秒内不重复）`); return;
    }
    const maxHour = Math.max(0, num(s.maxPerHour, 6));
    st.recentLeft = (st.recentLeft ?? []).filter((t) => now - t < 3600000);
    if (maxHour > 0 && st.recentLeft.length >= maxHour) {
      debug(`群 ${gid} 本小时已告别 ${st.recentLeft.length} 次，达到上限 ${maxHour}`); return;
    }
    st.lastLeftAt = now;
    st.recentLeft.push(now);
  }

  const raw = String(s.farewellTemplate ?? '').trim();
  if (!raw) {
    if (isTest) logger.warn(PLUGIN_ID, '[测试] 告别语是空的，填一条才能测（设置 → 退群告别 → 告别语）');
    return;
  }
  const info = await fetchInfo(gid, uid);
  const { text } = render(pickLine(raw), { ...info, qq: uid });
  if (!text) return;

  await deliver(gid, text, '');
  stats.farewells++;
  logger.info(PLUGIN_ID, `告别 ${gid} 的 ${info.nick || uid}：${text.slice(0, 40)}`);
  flushState(true);
}

// ── 发送 ────────────────────────────────────────────────────────────────

/**
 * 优先走 Orchestrator 的 sender（完整管道：串行 / 限频 / 去重 / 睡眠闸门 / 存档）。
 * 只捕获到协议端实例时退化为直接发（仍是一次普通发送，只是不进去重与存档）。
 */
async function deliver(gid, text, atUserId) {
  const chatKey = `group:${gid}`;
  const sender = orchRef?.sender;
  if (sender && typeof sender.sendTextBatch === 'function') {
    const r = await sender.sendTextBatch(chatKey, [text], atUserId ? { atUserId } : {});
    if (r?.sent?.[0]?.deduped) logger.info(PLUGIN_ID, `（被发送去重窗口拦下，未真的发出）${gid}`);
    return;
  }
  const ob = onebotRef;
  if (!ob || typeof ob.sendText !== 'function') throw new Error('拿不到发送通道（协议端实例未捕获）');
  await ob.sendText('group', gid, text, atUserId ? { atUserId } : {});
}

// ── 配图 ────────────────────────────────────────────────────────────────

/**
 * 从设置里选出一张本地图片。
 * 支持三种填法（一行一个，随机抽一行）：
 *   ① 单个文件：  D:\图片\welcome.png
 *   ② 整个文件夹：D:\图片\欢迎图        → 里面随机抽一张（认 png/jpg/jpeg/gif/webp/bmp）
 *   ③ 多行混填：  上面两种任意组合，每次随机挑一行 → 每次进群的图不一定一样
 * 相对路径依次按「数据目录 data/」和「项目根目录」解析，填绝对路径最省事。
 */
function pickImage(raw) {
  const lines = String(raw ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return { file: '', reason: '未填写图片路径' };
  // 随机起点轮一遍：某一行填错了也不至于整次不发（退回其它可用行）
  const start = Math.floor(Math.random() * lines.length);
  for (let i = 0; i < lines.length; i++) {
    const target = resolveExisting(lines[(start + i) % lines.length]);
    if (!target) continue;
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) {
        const files = fs.readdirSync(target)
          .filter((n) => IMAGE_EXTS.includes(path.extname(String(n)).toLowerCase()));
        if (!files.length) { debug(`图片文件夹里没有可用图片：${target}`); continue; }
        return { file: path.join(target, files[Math.floor(Math.random() * files.length)]), reason: '' };
      }
      if (!IMAGE_EXTS.includes(path.extname(target).toLowerCase())) {
        debug(`不是图片格式，跳过：${target}`);
        continue;
      }
      return { file: target, reason: '' };
    } catch { /* 读不了就换下一行 */ }
  }
  return { file: '', reason: '路径不存在或不是图片' };
}

/** 小图（≤800KB）备一份 base64，给「file:// 发不出去」当回退。大图不备，宁可失败也不拖超时。 */
function inlineBackup(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 800 * 1024) return '';
    // OneBot 的 base64 形态是 `base64://<纯base64>`，不带 data: 前缀也不需要 mime
    return `base64://${fs.readFileSync(file).toString('base64')}`;
  } catch { return ''; }
}

/** 绝对路径直接用；相对路径依次试 data/ 与项目根。 */
function resolveExisting(input) {
  const s = String(input ?? '').trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  const candidates = path.isAbsolute(s)
    ? [s]
    : [path.join(DATA_DIR, s), path.resolve(APP_ROOT, s)];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 路径非法就跳过 */ }
  }
  return '';
}

/**
 * 发完文字后跟一张图。走 sender.sendImage：限频 / 去重 / 存档都照常生效。
 * @param chatKey  `group:123` 或 `private:456` —— 私信预览也走同一条路。
 * @param where    只用于日志里标明发到哪儿。
 * @param gapOverride 传 0 表示不等间隔（私信预览用）。
 */
async function deliverImage(chatKey, where = chatKey, gapOverride = null) {
  const s = settings();
  if (s.imageEnabled === false) return;
  const raw = String(s.imagePath ?? '').trim();
  if (!raw) {
    // 开了开关却没填路径：只提示一次，不每次进群都刷日志
    if (!imageWarned) {
      imageWarned = true;
      logger.warn(PLUGIN_ID, '配图开关是开的，但没填图片路径 —— 本次只发文字。'
        + '去插件设置里填一个本地图片路径（或文件夹）即可。');
    }
    return;
  }
  const { file, reason } = pickImage(raw);
  if (!file) { logger.warn(PLUGIN_ID, `配图跳过：${reason}`); return; }

  const gap = gapOverride != null
    ? Math.min(30, Math.max(0, num(gapOverride, 0)))
    : Math.min(30, Math.max(0, num(s.imageGapSec, 1.5)));
  if (gap > 0) await sleep(Math.round(gap * 1000));

  const isPrivate = String(chatKey).startsWith('private:');
  const gid = String(chatKey).split(':')[1] ?? '';
  try {
    const sender = orchRef?.sender;
    const canDirect = onebotRef && typeof onebotRef.sendImage === 'function';
    if (isPrivate && canDirect) {
      // 私信预览同样直发：队列的去重会把"连着测第二次"的同一张图拦掉
      try {
        await onebotRef.sendImage('private', gid, toFileUri(file));
      } catch (first) {
        const backup = inlineBackup(file);
        if (!backup) throw first;
        await onebotRef.sendImage('private', gid, backup);
      }
    } else if (sender && typeof sender.sendImage === 'function') {
      // dataUrl 是给 sender 的**回退弹药**：file:// 走不通时（协议端不在同一台机器、
      // 路径读不到）它会自动改用 base64 再发一次。只在图不大时才备，避免把一张
      // 几 MB 的图转成 base64 塞进 HTTP body 反而超时。
      await sender.sendImage(chatKey, { file, dataUrl: inlineBackup(file) }, { note: '欢迎图' });
    } else if (onebotRef && typeof onebotRef.sendImage === 'function') {
      // 退化路径：没有 sender 时直接发（仍走 file URI，只是不去重/不留档）
      await onebotRef.sendImage(isPrivate ? 'private' : 'group', gid, toFileUri(file));
    } else {
      throw new Error('拿不到发送通道（协议端实例未捕获）');
    }
    stats.images++;
    stats.lastImage = file;
    logger.info(PLUGIN_ID, `配图已发 ${where}：${file}`);
  } catch (error) {
    // 常见：去重窗口内同一张图刚发过（连着两个人进群）→ 不是故障，warn 即可
    stats.lastError = String(error?.message ?? error);
    logger.warn(PLUGIN_ID, `配图没发出去（${file}）：${stats.lastError}`);
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────

// ── 生效群判定 ──────────────────────────────────────────────────────────

/**
 * 解析「自定义群号白名单」文本框。
 * 容错很宽：换行 / 逗号 / 分号 / 空格 / 顿号 都能当分隔符，也认
 * `群123456`、`group:123456`、`123456（摸鱼群）` 这些粘贴过来的写法。
 * @returns {{ ids: Set<string>, raw: string, filled: boolean }}
 */
function parseGroupIds(raw) {
  const text = String(raw ?? '');
  const ids = new Set();
  for (const token of text.split(/[\r\n,，;；、|\t ]+/)) {
    if (!token) continue;
    // 取「前面随便带什么、后面跟一串 4~20 位数字」里的那串数字
    const m = token.match(/^\D{0,6}(\d{4,20})/);
    if (m) ids.add(m[1]);
  }
  return { ids, raw: text, filled: text.trim().length > 0 };
}

/**
 * 当前生效的自定义白名单。
 * 填了但一个号都没解析出来 → 明确报一次（群号写错是最容易静默失效的地方），
 * 并且**不启用**名单（退回全局白名单），免得"填了却一条都发不出"还不说原因。
 */
function customWhitelist() {
  const parsed = parseGroupIds(settings().groupWhitelist);
  if (parsed.filled && parsed.ids.size === 0) {
    if (listWarnSig !== parsed.raw) { listWarnSig = parsed.raw; listWarned = false; }
    if (!listWarned) {
      listWarned = true;
      logger.warn(PLUGIN_ID, '自定义群号白名单填了内容，但一个群号都没解析出来 —— '
        + '本次退回「沿用全局白名单」。请一行填一个纯数字群号，例如：324632156');
    }
    return { ids: new Set(), active: false, raw: parsed.raw };
  }
  return { ids: parsed.ids, active: parsed.ids.size > 0, raw: parsed.raw };
}

/**
 * 这个群该不该响应？
 * 优先级：全局黑名单 deny > 自定义群号白名单（填了才算）> 全局白名单 allow。
 * @returns {{ ok: boolean, by: string }}
 */
function groupGate(gid) {
  const id = String(gid);
  const cfg = getConfig() || {};

  // ① 全局黑名单：不管你怎么配，显式拉黑的群永远不打扰
  const deny = cfg.deny?.groups ?? cfg.deny?.group ?? [];
  if (Array.isArray(deny) && deny.map(String).includes(id)) {
    return { ok: false, by: '全局黑名单' };
  }

  // ② 自定义群号白名单：填了就以它为准（这是本插件自己的作用域开关）
  const wl = customWhitelist();
  if (wl.active) {
    const hit = wl.ids.has(id);
    if (!hit) stats.lastBlockedGroup = id;
    return { ok: hit, by: '自定义群号白名单' };
  }

  // ③ 没填自定义名单 → 沿用全局白名单（与核心 allowed() 同口径）
  const allow = cfg.allow?.groups ?? cfg.allow?.group ?? [];
  const inGlobal = Array.isArray(allow) && allow.length
    ? allow.map(String).includes(id)
    : cfg.allowAllWhenEmpty === true;
  return { ok: inGlobal, by: '全局白名单' };
}

function stateOf(gid) {
  let st = groupState.get(gid);
  if (!st) {
    // members：上一次拿到的成员名单（兜底比对用）；leftSeen：已经告别过的人（防重复）
    st = { lastAt: 0, users: new Map(), recent: [], lastLeftAt: 0, recentLeft: [],
           members: null, count: 0, leftSeen: new Map() };
    groupState.set(gid, st);
  }
  return st;
}

/** 记一次"这个人已经告别过了"，30 分钟内不再重复（通知 + 兜底两条路共用）。 */
function markLeft(st, uid) {
  st.leftSeen.set(String(uid), Date.now());
  if (st.leftSeen.size > 200) {
    const now = Date.now();
    for (const [u, t] of st.leftSeen) if (now - t > 1800000) st.leftSeen.delete(u);
  }
}
function recentlyLeft(st, uid) {
  const t = st.leftSeen.get(String(uid));
  return Boolean(t && Date.now() - t < 1800000);
}

// ── 退群兜底检测（协议端不上报退群通知时用）────────────────────────────
// 有些协议端只上报"有人进群"、不上报"有人退群"（或被踢），退群告别就永远不触发，
// 而且日志里干干净净、看不出所以然。这里定期比对成员名单：名单里少了谁，就是谁走了。
// 成本：每个生效群每轮一次 get_group_info（只在人数变化时再拉一次成员名单）。

let pollTimer = null;
let lastPollAt = 0;
const pollWarned = new Map();   // gid → 上次报错时间（报错一小时只提醒一次）

function startLeavePolling() {
  stopLeavePolling();
  pollTimer = setInterval(() => {
    pollLeaves().catch((error) => logger.warn(PLUGIN_ID, `[兜底] 退群检测出错：${error?.message ?? error}`));
  }, 20000);
  pollTimer.unref?.();
  // 启动 15 秒后先建一次基线（基线建好之前的成员变化不算，避免一上来就误报）
  setTimeout(() => { pollLeaves().catch(() => {}); }, 15000).unref?.();
}

function stopLeavePolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  lastPollAt = 0;
}

function targetGroups() {
  const cw = customWhitelist();
  if (cw.active && cw.ids.size) return [...cw.ids];
  const cfg = getConfig() || {};
  const allow = cfg.allow?.groups ?? cfg.allow?.group ?? [];
  return Array.isArray(allow) ? allow.map(String) : [];
}

async function pollLeaves() {
  const s = settings();
  if (s.enabled === false || s.farewellEnabled !== true) return;
  if (s.leaveDetectFallback === false) return;
  const interval = Math.max(0, num(s.leaveDetectIntervalSec, 60));
  if (!interval) return;
  const now = Date.now();
  if (lastPollAt && now - lastPollAt < interval * 1000) return;
  // 还没拿到协议端实例时不要记时间，否则会白等一整个间隔
  if (!onebotRef || typeof onebotRef.call !== 'function') return;
  lastPollAt = now;
  for (const gid of targetGroups().slice(0, 8)) {
    try { await checkGroupLeaves(gid); }
    catch (error) {
      // 协议端不支持 get_group_member_list 时会每轮都失败 —— 一小时只提醒一次，别刷屏
      const last = pollWarned.get(gid) ?? 0;
      if (Date.now() - last > 3600000) {
        pollWarned.set(gid, Date.now());
        logger.warn(PLUGIN_ID, `[兜底] 群 ${gid} 检测失败：${error?.message ?? error}`
          + '（若协议端不支持成员名单接口，兜底会一直无效，退群只能靠协议端通知；可到设置里关掉兜底）');
      } else { debug(`[兜底] 群 ${gid} 检测失败：${error?.message ?? error}`); }
    }
    await sleep(300);
  }
}

async function checkGroupLeaves(gid) {
  const st = stateOf(gid);
  const info = await onebotRef.call('get_group_info', { group_id: Number(gid) });
  const count = Number(info?.member_count ?? 0);
  if (!count) return;
  const prev = st.count;
  st.count = count;

  if (!st.members) { await refreshMembers(gid); return; }   // 首次：只建基线，不告别
  if (count > prev) { await refreshMembers(gid); return; }  // 多了人：进群有通知，这里只更新基线
  if (count === prev) return;

  const ids = await memberIds(gid);
  if (!ids) return;
  const gone = [...st.members].filter((u) => !ids.has(u));
  st.members = ids;
  if (!gone.length) return;
  if (gone.length > 1) {
    logger.info(PLUGIN_ID, `[兜底] 群 ${gid} 少了 ${gone.length} 人（批量退群/踢人），不逐条告别`);
    return;
  }
  if (recentlyLeft(st, gone[0])) return;   // 通知那条路已经告别过了
  markLeft(st, gone[0]);
  stats.leaveDetected++;
  logger.info(PLUGIN_ID, `[兜底] 群 ${gid} 检出 1 人离开：${gone[0]}（协议端没有上报退群通知，靠名单比对发现的）`);
  fire('leave', gid, gone[0], { fallback: true });
}

async function refreshMembers(gid) {
  const ids = await memberIds(gid);
  if (ids) stateOf(gid).members = ids;
}

async function memberIds(gid) {
  const list = await onebotRef.call('get_group_member_list', { group_id: Number(gid) });
  const arr = Array.isArray(list) ? list : (Array.isArray(list?.members) ? list.members : null);
  if (!arr) return null;
  const set = new Set();
  for (const m of arr) {
    const u = String(m?.user_id ?? m?.uin ?? '');
    if (/^\d+$/.test(u)) set.add(u);
  }
  return set.size ? set : null;
}

function pickLine(raw) {
  const lines = String(raw ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return String(raw ?? '');
  return lines[Math.floor(Math.random() * lines.length)];
}

/** 占位符替换。{at} 不进正文 —— @ 是独立的消息段，由发送层挂在最前面。 */
function render(tpl, vars = {}) {
  let useAt = false;
  let text = String(tpl ?? '');
  if (text.includes('{at}')) {
    useAt = true;
    text = text.replace(/\{at\}/g, '');
  }
  text = text
    .replace(/\{nick\}/g, String(vars.nick || vars.qq || ''))
    .replace(/\{qq\}/g, String(vars.qq || ''))
    .replace(/\{group\}/g, String(vars.group || ''))
    .replace(/\{count\}/g, String(vars.count || ''));
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, useAt };
}

/** 取群名片/昵称 + 群名 + 群人数。取不到就留空，绝不能因为取信息失败就不欢迎。 */
async function fetchInfo(gid, uid) {
  const out = { nick: '', group: '', count: '' };
  const ob = onebotRef;
  if (!ob) return out;
  // 两层取法：先走封装方法，没有就直接走底层 call —— 协议端方法名换了也不至于
  // 连欢迎都发不出来（最坏情况是昵称退化成 QQ 号）。
  try {
    const r = typeof ob.getGroupMemberInfo === 'function'
      ? await ob.getGroupMemberInfo(gid, uid)
      : await ob.call('get_group_member_info', { group_id: Number(gid), user_id: Number(uid) });
    const d = r?.data ?? r;
    out.nick = String(d?.card || d?.nickname || d?.nick || '').trim();
  } catch { /* 取不到名字不影响欢迎，下面会退化成 QQ 号 */ }
  try {
    const r = typeof ob.getGroupInfo === 'function'
      ? await ob.getGroupInfo(gid)
      : await ob.call('get_group_info', { group_id: Number(gid) });
    const d = r?.data ?? r;
    out.group = String(d?.group_name || d?.name || '').trim();
    out.count = d?.member_count != null ? String(d.member_count) : '';
  } catch { /* 群信息取不到同理 */ }
  return out;
}

/** 取 QQ 资料（昵称/个性签名/性别年龄/QID），失败就只用群名片。 */
async function fetchProfile(gid, uid) {
  const info = await fetchInfo(gid, uid);
  const out = { ...info, sex: '', age: '', sign: '', qid: '' };
  const ob = onebotRef;
  if (!ob || typeof ob.call !== 'function') return out;
  try {
    const r = await ob.call('get_stranger_info', { user_id: Number(uid) });
    const d = r?.data ?? r;
    out.sex = String(d?.sex || '');
    out.age = d?.age != null ? String(d.age) : '';
    out.sign = String(d?.longNick || d?.long_nick || d?.sign || '').trim();
    out.qid = String(d?.qid || d?.uin || '').trim();
    if (!out.nick) out.nick = String(d?.nickname || d?.nick || '').trim();
  } catch { /* 资料接口不可用不影响欢迎 */ }
  return out;
}

/**
 * 用 AI 生成一句专属欢迎语。
 * 只用 QQ 里可观察到的信息（昵称、群名片、个性签名、群名/人数）；
 * NapCat 不支持读陌生人的空间动态，所以不伪造“看过你空间”。
 * 失败/为空时由调用方回退到模板。
 */
async function generateWelcome(gid, uid, info = null) {
  const s = settings();
  if (s.aiEnabled === false) return '';
  const p = info || await fetchProfile(gid, uid);
  const maxChars = Math.max(20, Math.min(120, num(s.aiMaxChars, 60)));
  const llm = await import('../../src/llm.js');

  const facts = [
    `昵称：${p.nick || uid}`,
    p.sign ? `个性签名：${String(p.sign).slice(0, 80)}` : '',
    (p.sex || p.age) ? `资料：${p.sex || '未知'}${p.age ? ` / ${p.age} 岁` : ''}` : '',
    p.group ? `群名：${p.group}` : '',
    p.count ? `群人数：${p.count}` : ''
  ].filter(Boolean).join('\n');

  const system = '你在一个 QQ 群里，负责给刚进群的新人写一句欢迎语。\n'
    + '要求：只输出这一句欢迎语，不要解释、不要引号、不要 @（发送时会自动 @）。\n'
    + `长度不超过 ${maxChars} 字，自然、有温度、像群友说话；可以化用昵称或个性签名，`
    + '但不要提“我看了你的资料/空间”，不要打探隐私，不要时政、低俗、冒犯或让人尴尬的玩梗。\n'
    + (String(s.aiStyle || '').trim() ? `风格：${String(s.aiStyle).trim()}` : '');
  const userMsg = `新成员资料：\n${facts}\n\n请写一句独一无二的欢迎语。`;

  const res = await llm.chatCompletion({
    messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
    temperature: 0.95,
    maxTokens: Math.max(80, Math.min(600, num(s.aiMaxTokens, 300)))
  });
  const raw = res?.message?.content;
  let text = Array.isArray(raw) ? raw.map((x) => x?.text ?? '').join('') : String(raw ?? '');
  text = text.trim().replace(/^["“'']+|["”'']+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 4) return '';
  return text.slice(0, maxChars);
}

/** 节流写状态文件：看「有没有接管事件流 / 收到几次入群」用。 */
function flushState(force = false) {
  const now = Date.now();
  if (!force && now - lastFlush < 30000) return;
  lastFlush = now;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      savedAt: new Date(now).toLocaleString('zh-CN', { hour12: false }),
      ...stats
    }, null, 1), 'utf8');
  } catch { /* 写不出状态不影响欢迎 */ }
}

/** 自测/排障用：拿到内部引用。 */
export const internals = {
  get onebot() { return onebotRef; },
  get orch() { return orchRef; },
  get stats() { return stats; },
  install, uninstall, render, pickLine, pickImage, resolveExisting,
  parseGroupIds, groupGate, matchTestCommand, messageTextOf, vetoTestCommand, tryTestCommand,
  pollLeaves, memberIds, checkGroupLeaves, runFromIncoming, markLeft
};

