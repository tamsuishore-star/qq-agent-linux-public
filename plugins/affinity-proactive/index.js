/**
 * affinity-proactive —— 好感度主动开话题（确定性型 / plugins/）
 *
 * 与 skills/affinity 成对：技能负责"好感度是多少、该用什么态度"，本插件负责
 * "她什么时候自己冒一句"。判据见 src/skills/manifest.js 的 DIR_KIND：
 * 「到点该不该主动说话」是机械调度，不需要模型判断 → 放插件（定时器）。
 *
 * ── 流程（每 scanIntervalSec 扫一轮）───────────────────────────────────────
 *   对每个「白名单内 + 有好感度记录」的会话：
 *     ① 到点没？（nextCheckAt）没到就跳过；到了先按等级重新随机下一次检查时间
 *     ② 静默时段（默认 0~8 点北京）→ 不发，只重新排期
 *     ③ 距上次互动太近（idleMinMs）→ 跳过
 *     ④ 有未读消息 → 跳过（别抢在回复前面开口）
 *     ⑤ 掷概率（等级表；连续 3 天不互动则概率减半）→ 没中就等下一轮
 *     ⑥ 中了：调 chatCompletion 现场生成一句 → 发出去（先走技能提供的
 *        affinity.send 能力 = 核心发送队列；拿不到就 OneBot HTTP + 归档兜底）
 *
 * ── 等级参数（文档 §十二，刻意为之：越高越自然、越不靠频率）──────────────
 *   0 陌生观众：1~2h，p=0.02   1 眼熟面孔：45~90m，p=0.05
 *   2 说得上话：30~90m，p=0.10 3 愿意搭理：30~60m，p=0.25
 *   4 记在心上：1~2h，p=0.15   5 留了位置：1.5~3h，p=0.08
 *
 * ── 踩坑备忘 ─────────────────────────────────────────────────────────────
 *   · hook 的 ctx 没有发送通道 —— 只能从 before-context 顺手捡 store（归档用）。
 *     真正的发送优先走技能能力 affinity.send（核心 SendQueue：限频/去重/留档）。
 *   · 插件不能 import 技能的 engine（跨目录、破坏"能力解耦"）→ 等级阈值/北京时间
 *     这几个纯常量直接在本文件冗余一份（很短，也稳定）。
 *   · 只有"有好感度记录"的会话才主动 —— 不给陌生会话冷启动发消息。
 *   · 好感度存档 v2 起是**按人全局唯一**（同一 QQ 号跨群/私聊一份），本插件只在
 *     「该会话的成员」里挑主动对象；读档同时兼容旧 v1（按会话分裂）布局。
 *   · 白名单口径与设置页 test-send 完全一致：deny 优先；allow 非空必须在名单内；
 *     全空时必须显式开 allowAllWhenEmpty。
 *
 * 存档：data/affinity-proactive.json（本插件私有，原子写）。
 *   { version, chats: { [chatKey]: { nextCheckAt, lastSentAt, lastSentUid, sheInit:{dayKey,uid,at} } } }
 * 「她主动找过谁」写在 sheInit 里，技能读它结算「当天首次互动 +1」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';
import { escapeCqText } from '../../src/util.js';

const BUILD_TAG = 'v1.1.0';
const STORE = path.join(DATA_DIR, 'affinity-proactive.json');
const AFFINITY_STORE = path.join(DATA_DIR, 'affinity.json');

/** 等级阈值（与 skills/affinity/engine.js 的 LEVELS 保持一致）。 */
const LEVEL_MINS = [0, 20, 50, 90, 140, 200];
const LEVEL_NAMES = ['陌生', '面熟', '熟络', '亲近', '交心', '挚友'];

/** 主动参数表（文档 §十二）。 */
const PROACTIVE_TABLE = [
  { min: 3600000, max: 7200000, p: 0.02 },
  { min: 2700000, max: 5400000, p: 0.05 },
  { min: 1800000, max: 5400000, p: 0.10 },
  { min: 1800000, max: 3600000, p: 0.25 },
  { min: 3600000, max: 7200000, p: 0.15 },
  { min: 5400000, max: 10800000, p: 0.08 }
];

/** 主动生成时给模型的等级语气简表（与技能里的态度段同源，压缩）。 */
const ATTITUDE_BRIEF = [
  '礼貌、简短、有距离但不冷；几乎不主动；不接玩笑；私人问题模糊带过',
  '稍微放松、多给半句；极少主动（出现时可能先说"来了"）；能接一句玩笑但不追',
  '自然友好、接得住话；偶尔主动但话说一半；顺手逗一下；允许绕着说',
  '明显放松、有温度但不黏；会主动分享日常；偶尔泄露一点真实情绪',
  '亲近自然、偶尔柔软；会记挂对方；做具体的小事而不是只说',
  '真实坦率、不端着；可以只是一句"嗯"，也可以忽然说一句重的；稀有但真诚'
];

const DEFAULTS = { enabled: true, scanIntervalSec: 60, quietStartHour: 0, quietEndHour: 8, idleMinMs: 600000, maxTokens: 160 };

let api = null;
let fetchRef = null;
let timer = null;
let bootTimer = null;
let storeRef = null;            // before-context 顺手捡的 ChatStore
let warnedNoStore = false;
let proCache = { file: '', mtimeMs: 0, state: null };
let affCache = { file: '', mtimeMs: 0, data: null };
const BJ_OFFSET_MS = 8 * 3600 * 1000;

/* ───────────────────────────── 设置 ───────────────────────────── */

function settings() {
  const raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}
const enabled = () => settings().enabled !== false;

/* ───────────────────────────── 小工具 ───────────────────────────── */

const randBetween = (a, b) => a + Math.random() * Math.max(0, b - a);
const dayKeyOf = (ts = Date.now()) => {
  const d = new Date(ts + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
const hourOf = (ts = Date.now()) => new Date(ts + BJ_OFFSET_MS).getUTCHours();
const levelOf = (score) => {
  let lv = 0;
  for (let i = 0; i < LEVEL_MINS.length; i++) if ((Number(score) || 0) >= LEVEL_MINS[i]) lv = i;
  return lv;
};

/** 静默时段：跨零点（start > end）也成立。 */
function inQuietHours(hour, s) {
  const a = Math.max(0, Math.min(23, Math.round(Number(s.quietStartHour) || 0)));
  const b = Math.max(0, Math.min(23, Math.round(Number(s.quietEndHour) || 0)));
  if (a === b) return false;
  return a < b ? (hour >= a && hour < b) : (hour >= a || hour < b);
}

/** 白名单口径：与设置页 test-send 一致。 */
function inWhitelist(chatKey, cfg) {
  const m = /^(group|private):(\d+)$/.exec(String(chatKey || ''));
  if (!m) return false;
  const kind = m[1];
  const id = m[2];
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(id)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(id);
  return cfg.allowAllWhenEmpty === true;
}

/* ───────────────────────────── 存档 I/O ───────────────────────────── */

function readPro() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(STORE).mtimeMs; } catch { /* 没文件 */ }
  if (proCache.state && proCache.file === STORE && proCache.mtimeMs === mtimeMs) return proCache.state;
  let state = { version: 1, chats: {} };
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (j && typeof j === 'object' && j.chats && typeof j.chats === 'object') state = { version: Number(j.version) || 1, chats: j.chats };
  } catch { /* 首次运行或文件坏了 */ }
  proCache = { file: STORE, mtimeMs, state };
  return state;
}

function writePro(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    state.savedAt = Date.now();
    const tmp = `${STORE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STORE);
    proCache = { file: '', mtimeMs: 0, state: null };
    return true;
  } catch (e) { api?.warn?.(`主动开话题存档写入失败：${e?.message ?? e}`); return false; }
}

/**
 * 只读技能的好感度存档（mtime 缓存），**v1/v2 都认**：
 *   v2（当前）：{ users: {uid: 记录}, chats: {chatKey: {members:{uid:1}}} }  ← 人是全局的
 *   v1（旧）  ：{ chats: {chatKey: {users: {uid: 记录}}} }                   ← 按会话分裂
 * 返回统一形状 { users: {uid: 记录}, chats: {chatKey: {members: [uid...]}} }。
 */
function readAffinity() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(AFFINITY_STORE).mtimeMs; } catch { /* 没文件 */ }
  if (affCache.data && affCache.file === AFFINITY_STORE && affCache.mtimeMs === mtimeMs) return affCache.data;
  const users = {};
  const chats = {};
  try {
    const j = JSON.parse(fs.readFileSync(AFFINITY_STORE, 'utf8'));
    if (j && typeof j === 'object') {
      for (const [uid, u] of Object.entries(j.users || {})) {
        if (u && typeof u === 'object') users[String(uid)] = u;
      }
      for (const [ck, cv] of Object.entries(j.chats || {})) {
        if (!cv || typeof cv !== 'object') continue;
        const members = new Set(Object.keys((cv.members && typeof cv.members === 'object') ? cv.members : {}));
        for (const [uid, u] of Object.entries((cv.users && typeof cv.users === 'object') ? cv.users : {})) {
          const id = String(uid);
          members.add(id);
          if (!u || typeof u !== 'object') continue;
          const prev = users[id];
          // v1 同一人多份记录：与 engine.migrateState 同口径 —— 取分数高的那份
          if (!prev || (Number(u.score) || 0) > (Number(prev.score) || 0)) users[id] = u;
        }
        chats[ck] = { members: [...members] };
      }
    }
  } catch { /* 技能还没写过 */ }
  const data = { users, chats };
  affCache = { file: AFFINITY_STORE, mtimeMs, data };
  return data;
}

/** 选主动对象：从**本会话成员**里挑分数最高者；并列取最近互动的人。 */
function pickTarget(users, members) {
  let best = null;
  for (const raw of members || []) {
    const uid = String(raw);
    const u = users[uid];
    if (!u || typeof u !== 'object') continue;
    const score = Number(u.score) || 0;
    const last = Number(u.lastInteractionAt) || 0;
    if (!best || score > best.score || (score === best.score && last > best.lastInteractionAt)) {
      best = { uid, user: u, score, lastInteractionAt: last };
    }
  }
  return best;
}

/* ───────────────────────────── 生成 ───────────────────────────── */

const GENERATION_PERSONA =
  '你是小助手：科洛列夫茨基剧团首席女高音，水妖一族最后的舞台歌者，呼啸社成员（这层身份不随便说）。'
  + '性格：温柔是底色（有分寸、会顺手做小事、不追问不说教），幽默是默认语气（顺手碰一下有趣的地方，一句就收）。'
  + '说话短句优先、自然、多带语气词（呢/啊/哦/吗/吧/呀/了），不客服腔、不阴阳、不故意让人难堪。'
  + '有自己的生活（排练、演出、练声、休息），不靠频繁说话刷存在感。';

async function generate(chatKey, uid, user, level) {
  const s = settings();
  const llm = await import('../../src/llm.js');
  const recent = (storeRef && typeof storeRef.recent === 'function') ? storeRef.recent(chatKey, { limit: 12, includeSelf: true }) : [];
  const who = (m) => (m.self ? '小助手' : (m.senderName || `QQ:${m.senderId}`));
  const transcript = recent.map((m) => `${who(m)}：${String(m.text || '').slice(0, 120)}`).join('\n');

  const system = `${GENERATION_PERSONA}\n\n`
    + `现在你和对方的熟络程度：Lv${level}「${LEVEL_NAMES[level]}」——语气表现为：${ATTITUDE_BRIEF[level]}。\n\n`
    + '要求：\n'
    + '· 只输出你要发的**这一条**消息（1~3 句，短句优先），不要解释、不要旁白、不要引号。\n'
    + '· 像自然想起对方、随口说一句；可以是分享日常、问一句、记挂对方、或一个轻轻的玩笑。\n'
    + '· 不给对方压力，不追问隐私，不提好感度/等级/系统，也不要 @ 谁。\n'
    + '· 如果没有必要开口，就只输出一个「-」（表示这次不说）。';

  const userMsg = `【最近的对话（可能为空）】\n${transcript || '(还没有聊过)'}\n\n现在你想主动说点什么？只输出消息本身。`;

  const res = await llm.chatCompletion({
    messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
    temperature: 0.9,
    maxTokens: Math.max(40, Math.min(400, Number(s.maxTokens) || 160))
  });
  const raw = res?.message?.content;
  let text = Array.isArray(raw) ? raw.map((p) => p?.text ?? '').join('') : String(raw ?? '');
  text = text.trim().replace(/^["“'']+|["”'']+$/g, '').trim();
  if (text === '-' || text === '——' || !text) return '';
  return text.slice(0, 300);
}

/* ───────────────────────────── 发送 ───────────────────────────── */

/** OneBot HTTP 直发（技能能力不可用时的兜底，范式同 reminder 插件）。 */
async function onebotSend(chatKey, text) {
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) throw new Error(`会话键不合法：${chatKey}`);
  const cfg = getConfig()?.snowluma || {};
  const base = String(cfg.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.httpAccessToken || cfg.accessToken || '');
  const res = await fetchRef(`${base}/${m[1] === 'private' ? 'send_private_msg' : 'send_group_msg'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(m[1] === 'private'
      ? { user_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }
      : { group_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`OneBot HTTP ${res.status}`);
}

async function send(chatKey, text) {
  // 优先走技能能力（核心 SendQueue：限频/去重/留档 + 通知界面刷新）
  try {
    const cap = api?.capability?.('affinity.send', { chatKey, text });
    const r = cap && typeof cap.then === 'function' ? await cap : cap;
    if (r && r.ok) return { ok: true, via: r.via || 'sender' };
  } catch (e) {
    api?.warn?.(`affinity.send 能力调用失败，转 HTTP 兜底：${e?.message ?? e}`);
  }
  // 兜底：OneBot HTTP + 手动归档（否则模型下一轮看不到自己说过这句）
  if (!fetchRef) return { ok: false, reason: '没有可用发送通道（技能未捕获 sender，且无 web_fetch 权限）' };
  try {
    await onebotSend(chatKey, text);
    try { storeRef?.appendSelf?.(chatKey, { text, ts: Date.now() }); } catch { /* 归档失败不致命 */ }
    return { ok: true, via: 'http' };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/* ───────────────────────────── 主循环 ───────────────────────────── */

async function fire(chatKey, uid, user, level, st, now) {
  try {
    const text = await generate(chatKey, uid, user, level);
    if (!text) { api?.log?.(`主动开话题跳过（模型判断没必要说）：${chatKey}`); return; }
    const sent = await send(chatKey, text);
    if (!sent.ok) {
      st.nextCheckAt = now + 10 * 60000;   // 发送失败：10 分钟后再试，别死循环
      api?.warn?.(`主动开话题发送失败（${chatKey}）：${sent.reason}`);
      return;
    }
    st.lastSentAt = Date.now();
    st.lastSentUid = uid;
    st.sheInit = { dayKey: dayKeyOf(now), uid, at: Date.now() };  // 供技能结算"当天首次互动+1"
    api?.log?.(`主动开话题 → ${chatKey}（Lv${level} ${LEVEL_NAMES[level]}，${sent.via}）：${text.slice(0, 40)}`);
  } catch (e) {
    st.nextCheckAt = now + 15 * 60000;
    api?.warn?.(`主动开话题失败（${chatKey}）：${e?.message ?? e}`);
  }
}

export async function scanOnce() {
  if (!enabled()) return { checked: 0, fired: 0 };
  if (!storeRef) {
    if (!warnedNoStore) { api?.warn?.('还没有捕获到消息存档（等任意会话跑过一次即可），本轮跳过'); warnedNoStore = true; }
    return { checked: 0, fired: 0, reason: 'no-store' };
  }
  const cfg = getConfig() || {};
  const s = settings();
  const now = Date.now();
  const quiet = inQuietHours(hourOf(now), s);
  const { users, chats } = readAffinity();
  const pro = readPro();
  let checked = 0, fired = 0, changed = false;

  for (const [chatKey, c] of Object.entries(chats)) {
    if (!inWhitelist(chatKey, cfg)) continue;
    const pick = pickTarget(users, c?.members);   // 好感度是全局的，但只从本会话的人里挑
    if (!pick) continue;
    checked += 1;

    // 等级以存档里的 level 为准（"7 天不互动不降级"靠它跨重启保留），档没有才按分数推
    const rawLv = pick.user?.level;
    const level = (rawLv === undefined || rawLv === null || rawLv === '')
      ? levelOf(pick.score)
      : Math.max(0, Math.min(5, Math.round(Number(rawLv) || 0)));
    const table = PROACTIVE_TABLE[level] || PROACTIVE_TABLE[0];
    const st = pro.chats[chatKey] || (pro.chats[chatKey] = { nextCheckAt: 0, lastSentAt: 0, lastSentUid: '' });
    if (!st.nextCheckAt) { st.nextCheckAt = now + randBetween(table.min, table.max); changed = true; continue; }
    if (now < st.nextCheckAt) continue;

    // 到点：先重新排下一次检查（无论这轮发不发，避免卡在"已到点"反复触发）
    st.nextCheckAt = now + randBetween(table.min, table.max);
    changed = true;
    if (quiet) continue;                                        // 静默期只排期
    const lastInter = Number(pick.lastInteractionAt) || 0;
    if (lastInter > 0 && now - lastInter < Math.max(0, Number(s.idleMinMs) || 0)) continue;   // 刚聊完
    try { if ((storeRef.getChatMeta(chatKey)?.unread || 0) > 0) continue; } catch { /* 查不到就放行 */ }

    let p = table.p;
    if (lastInter > 0 && now - lastInter >= 3 * 86400000) p /= 2;   // 连续 3 天不互动：频率降低
    if (Math.random() >= p) continue;

    await fire(chatKey, pick.uid, pick.user, level, st, now);
    fired += 1;
    changed = true;
  }
  if (changed) writePro(pro);
  return { checked, fired, quiet };
}

/* ───────────────────────────── 生命周期 ───────────────────────────── */

export function setup(a) {
  api = a;
  fetchRef = a.fetch;   // 清单已声明 web_fetch
  a.log(`好感度主动开话题已加载（${BUILD_TAG}）｜存档 ${STORE}`);
}

export function available() {
  return enabled();
}

export function activate() {
  if (!enabled()) return;
  const everySec = Math.max(15, Number(settings().scanIntervalSec) || 60);
  timer = setInterval(() => { scanOnce().catch(() => {}); }, everySec * 1000);
  timer.unref?.();
  bootTimer = setTimeout(() => { scanOnce().catch(() => {}); }, 30 * 1000);
  bootTimer.unref?.();
  api?.log?.(`好感度主动开话题已启用：每 ${everySec} 秒扫描`);
}

export function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

/* ───────────────────────────── 钩子 / 状态面板 ───────────────────────────── */

export const hooks = {
  /** 顺手捡消息存档（before-context 的 ctx 里有 store；hook ctx 没有 sender）。 */
  async 'before-context'(ctx = {}) {
    if (ctx.store) storeRef = ctx.store;
  }
};

export const providers = {
  'status.affinity-proactive': () => {
    if (!enabled()) return null;
    const pro = readPro();
    const { chats } = readAffinity();
    const keys = Object.keys(chats);
    if (!keys.length) return null;
    const now = Date.now();
    const scheduled = Object.entries(pro.chats || {})
      .filter(([ck]) => chats[ck])
      .map(([, v]) => Number(v.nextCheckAt) || 0)
      .filter((t) => t > 0)
      .sort((a, b) => a - b);
    const next = scheduled[0];
    return {
      icon: '💗',
      title: '主动开话题',
      priority: 58,
      lines: [
        ['会话', `${keys.length} 个有好感度记录`],
        ['下次检查', next ? new Date(next).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '待排期'],
        ['静默时段', `${settings().quietStartHour}~${settings().quietEndHour} 点`]
      ]
    };
  }
};

// 给测试用的出口
export const internals = { scanOnce, settings, inWhitelist, inQuietHours, levelOf, pickTarget, readAffinity, generate, send };
