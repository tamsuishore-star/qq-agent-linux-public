// 群友花费统计（确定性型插件 / 放在 plugins/）
//
// ── 干什么 ────────────────────────────────────────────────────────────────
// 群里有人 @机器人 说「金额统计」，就把**这个群**在指定区间内消耗的 token 与
// 折算花费，按"是谁触发了这次运行"分摊到各个群友头上，并把报告直接发回群里，
// 标题里写明统计的是几号到几号。
//
// ── 为什么做成插件（确定性型）──────────────────────────────────────────────
// 触发条件是"@机器人 + 固定关键词"，规则能写死 → 命中必然执行，不交给模型判断。
// 但发消息这一步仍然需要模型配合：钩子（before-context / before-llm-messages /
// before-tool / after-response）能拿到的上下文里**没有** onebot 与 sender，
// 只有工具 execute(ctx) 拿得到 ctx.sender。所以与仓库里的 forward-summary 同套路：
//
//   ① before-context        确定性识别"谁在哪个群要哪个区间"，只记任务，不发消息
//   ② before-llm-messages   把本轮对话压成本任务的一句话指令（模型不再参与闲聊）
//   ③ llm.request-params    把本轮工具列表压到只剩本插件的工具（发完只剩 finish）
//   ④ before-tool           别的工具一律拒绝；没发报告就想 finish 也拒绝
//   ⑤ 工具 execute(ctx)     就地统计 + **直接发送**，模型碰不到数字与文案
//   ⑥ after-response        已发送则清空正文，杜绝再补一句造成重复
//
// 关键点：报告的**数字与文案全部由代码生成**，模型只做"调用工具"和"finish"两个
// 动作，所以既不会算错，也不会被改写。
//
// ── 数据从哪来 ────────────────────────────────────────────────────────────
//   data/sessions/<id>.json（每次运行一个文件，由 src/sessions.js 落盘）
//     chatKey     'group:<群号>'
//     startedAt   本次运行开始时间（也是峰谷计价的依据）
//     model/vendor 实际调用的模型与渠道（与「用量」页同口径）
//     usage       { promptTokens, completionTokens, cachedTokens, totalTokens, calls }
//     trigger[]   触发本次运行的消息条目，含 senderId / senderName / atMe
//   价格与峰谷全部复用核心的 src/model-prices.js —— 所以报告里的钱与
//   「用量」页的金额对得上，不是另算一套。
//
// ── 口径（会印在报告末尾）─────────────────────────────────────────────────
// 机器人的 token 消耗天然是按"会话（一次运行）"计量的，不存在"某人每条消息花了
// 多少"。这里把一次运行的花费归给**触发这次运行的人**：优先取被 @ 的那条消息，
// 没有则取触发批里最早的一条。这是唯一能落到"人"且可复现的口径。
//
// ── 常见坑（都已规避）─────────────────────────────────────────────────────
//   · 工具 id 会被加载器加前缀 + 做 OpenAI 函数名 sanitize，所以只能按返回值引用
//   · 工具自定义分类被关掉 / 工具被单独关掉时要**放弃接管**，否则会卡住模型轮次
//   · 会话文件可能被截断或不存在，任何单个文件读失败都不能让整次统计失败
//   · 零消耗会话（没真正调用过模型的等待/中止会话）不计入，与核心记账口径一致

import fsp from 'node:fs/promises';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';
import { resolveModelPrice, priceAt, modelLabel } from '../../src/model-prices.js';
import { getToolAvailability } from '../../src/tool-registry.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'session-index-cache.json');

const DAY = 86400000;
const TASK_TTL_MS = 6 * 60 * 60 * 1000;   // 任务记忆有效期（防 Map 无限增长）
const READ_CONCURRENCY = 8;              // 同时读几个会话文件
const HARD_MAX_SESSIONS = 2000;
const TOOL_ID_FALLBACK = 'group-cost-report__group_cost_report';   // 加载器加前缀后的形态
const DEFAULT_KEYWORDS = ['金额统计', '花费统计', '花费查询', 'token统计', '用量统计', '消费统计'];

let api = null;
let config = () => ({});
let log = () => {};
let warn = () => {};
let toolId = TOOL_ID_FALLBACK;

/** sessionId -> 本轮统计任务（只在这一次运行内有效） */
const tasks = new Map();

// ───────────────────────────── 设置 ─────────────────────────────

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把设置规整成稳定的形状（设置项缺省/写错都不该让功能消失）。 */
function normalizeSettings(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  // ⚠️ 字段名不能叫 keywords：核心的密文掩码规则是 /key|token|secret|password|cookie/i，
  //    "keywords" 里的 key 会让这个设置被当成密钥，在设置弹窗里显示成 ****** 的密码框。
  //    （这里仍然兼容旧名 keywords，避免手改过配置的用户丢设置。）
  const words = String(c.triggerWords ?? c.keywords ?? '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    triggerWords: words.length ? words : [...DEFAULT_KEYWORDS],
    allowWithoutAt: c.allowWithoutAt === true,
    defaultRange: String(c.defaultRange || 'today').trim().toLowerCase() || 'today',
    topN: clampInt(c.topN, 8, 1, 50),
    maxSessions: clampInt(c.maxSessions, 400, 20, HARD_MAX_SESSIONS),
    footer: c.footer !== false
  };
}

function currentSettings() {
  try { return normalizeSettings(config() || {}); } catch { return normalizeSettings({}); }
}

// ───────────────────────────── 区间解析 ─────────────────────────────

// ⚠️ 不能写 `Number(ts) || Date.now()`：时间戳 0（"全部历史"的左边界）是 falsy，
//    会被当成"没传时间"悄悄变成今天 —— 表现为「金额统计 全部」只统计当天。
function safeTs(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function startOfDay(ts) {
  const d = new Date(safeTs(ts));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function endOfDay(ts) {
  return startOfDay(ts) + DAY - 1;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDay(ts, { withYear = false } = {}) {
  const d = new Date(Number(ts) || Date.now());
  return `${withYear ? `${d.getFullYear()}-` : ''}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 从消息文本里认出区间。认不出就用 defaultKey。 */
function parseRange(text, defaultKey = 'today', now = Date.now()) {
  const s = String(text || '');
  const year = new Date(now).getFullYear();
  const today = startOfDay(now);

  const make = (key, from, to) => {
    const f = startOfDay(from);
    const t = endOfDay(to);
    const crossYear = new Date(f).getFullYear() !== new Date(t).getFullYear();
    const label = f === startOfDay(t) && t - f < DAY
      ? `${fmtDay(f, { withYear: crossYear })}（当天）`
      : `${fmtDay(f, { withYear: crossYear })} ~ ${fmtDay(t, { withYear: crossYear })}`;
    return { key, from: f, to: t, label, fromDay: startOfDay(f), toDay: startOfDay(t) };
  };

  // "全部历史"单独走一条：左边界是 0（不能退化成今天），标题也不该印 1970-01-01
  const makeAll = () => ({ key: 'all', from: 0, to: endOfDay(today), label: '全部历史', fromDay: 0, toDay: startOfDay(today) });

  // 1) 显式日期（优先于关键词：用户写了就是最准的）
  const dates = [];
  for (const m of s.matchAll(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g)) {
    dates.push(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
  }
  for (const m of s.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) {
    dates.push(new Date(year, Number(m[1]) - 1, Number(m[2])).getTime());
  }
  for (const m of s.matchAll(/(?<![\d.:])(\d{1,2})\s*[-/]\s*(\d{1,2})(?![\d:])/g)) {
    dates.push(new Date(year, Number(m[1]) - 1, Number(m[2])).getTime());
  }
  const ok = dates.filter((d) => Number.isFinite(d) && d > 0);
  ok.sort((a, b) => a - b);
  if (ok.length >= 2) return make('custom', ok[0], ok[ok.length - 1]);
  if (ok.length === 1) return make('custom', ok[0], ok[0]);

  // 2) 关键词
  if (/今天|今日|本日|\btoday\b/i.test(s)) return make('today', today, today);
  if (/昨天|昨日|\byesterday\b/i.test(s)) return make('yesterday', today - DAY, today - DAY);
  if (/前天/.test(s)) return make('daybefore', today - 2 * DAY, today - 2 * DAY);
  if (/上个?周|上星期|\blastweek\b/i.test(s)) {
    const dow = (new Date(today).getDay() + 6) % 7;   // 周一 = 0
    const thisMonday = today - dow * DAY;
    return make('lastweek', thisMonday - 7 * DAY, thisMonday - DAY);
  }
  if (/本周|这周|这个?星期|\bthisweek\b/i.test(s)) {
    const dow = (new Date(today).getDay() + 6) % 7;
    return make('thisweek', today - dow * DAY, today);
  }
  if (/上个?月|上个月|\blastmonth\b/i.test(s)) {
    const firstThisMonth = new Date(new Date(today).getFullYear(), new Date(today).getMonth(), 1).getTime();
    return make('lastmonth', new Date(new Date(firstThisMonth).getFullYear(), new Date(firstThisMonth).getMonth() - 1, 1).getTime(), firstThisMonth - DAY);
  }
  if (/本月|这个?月|\bthismonth\b/i.test(s)) {
    const d = new Date(today);
    return make('thismonth', new Date(d.getFullYear(), d.getMonth(), 1).getTime(), today);
  }
  if (/全部|所有|历史|累计|all/i.test(s) && !/\d/.test(s)) return makeAll();

  const days = /(?:最近|近|这|过去)?\s*(\d{1,3})\s*(?:天|日)/.exec(s);
  if (days) {
    const n = clampInt(days[1], 0, 1, 3650);
    if (n > 0) return make(`${n}d`, today - (n - 1) * DAY, today);
  }

  // 3) 用户没写 → 用设置里的默认值
  const key = String(defaultKey || 'today').toLowerCase();
  if (key === 'yesterday') return make('yesterday', today - DAY, today - DAY);
  if (key === 'thisweek') return parseRange('本周', defaultKey, now);
  if (key === 'lastweek') return parseRange('上周', defaultKey, now);
  if (key === 'thismonth') return parseRange('本月', defaultKey, now);
  if (key === 'lastmonth') return parseRange('上月', defaultKey, now);
  if (key === 'all') return makeAll();
  const defDays = /^(\d{1,3})d$/.exec(key);
  if (defDays) {
    const n = clampInt(defDays[1], 1, 1, 3650);
    return make(`${n}d`, today - (n - 1) * DAY, today);
  }
  return make('today', today, today);
}

// ───────────────────────────── 计价（与用量页同口径）─────────────────────────────

/** 与 src/app.js 的 priceOf 保持一致：渠道自定义价优先，否则官方/远程价。 */
function priceOf(model, vendor, cfg) {
  const c = cfg || getConfig();
  const m = String(model || '');
  try {
    if (vendor) {
      const byVendor = resolveModelPrice(modelLabel(vendor, m), c);
      if (byVendor && byVendor.source === 'custom') return byVendor;
    }
    return resolveModelPrice(m, c) || { in: 0, out: 0, cached: 0 };
  } catch {
    return { in: 0, out: 0, cached: 0 };
  }
}

/** 单次运行的花费（元）。峰谷按本次运行发生时刻判定。 */
function costOfSession(session, cfg) {
  const u = session?.usage || {};
  const prompt = Number(u.promptTokens) || 0;
  const completion = Number(u.completionTokens) || 0;
  const cached = Math.min(Number(u.cachedTokens) || 0, prompt);
  const fresh = Math.max(0, prompt - cached);
  const price = priceOf(session?.model, session?.vendor, cfg);
  const tier = price?.peak ? priceAt(price, Number(session?.startedAt) || Date.now()) : price;
  const inRate = Number(tier?.in) || 0;
  const outRate = Number(tier?.out) || 0;
  const cachedRate = Number.isFinite(Number(tier?.cached)) ? Number(tier.cached) : inRate;
  return (fresh / 1e6) * inRate + (cached / 1e6) * cachedRate + (completion / 1e6) * outRate;
}

// ───────────────────────────── 会话数据采集 ─────────────────────────────

/** 会话 id 形如 <Date.now().toString(36)>-<hex>，时间戳可以直接解出来。 */
function decodeIdTime(id) {
  const seg = String(id || '').split('-')[0];
  const ts = parseInt(seg, 36);
  return Number.isFinite(ts) && ts > 1.6e12 && ts < 4e12 ? ts : 0;
}

/** 只读文件开头，拿到 chatKey（在 JSON 的前几个键里，不必解析整个文件）。 */
async function headChatKey(file) {
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    const m = /"chatKey"\s*:\s*"([^"]*)"/.exec(head);
    return m ? m[1] : '';
  } catch {
    return '';
  } finally {
    try { await handle?.close(); } catch { /* ignore */ }
  }
}

/** 读索引缓存（只用来快速筛掉别的群；内容坏了就当没有）。 */
async function readIndexCache() {
  try {
    const raw = JSON.parse(await fsp.readFile(INDEX_CACHE_FILE, 'utf8'));
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 找出该群在区间内的全部运行记录。
 * @returns {{sessions: Array, truncated: boolean, scanned: number}}
 */
async function collectSessions({ chatKey, range, maxSessions }) {
  const picked = new Map();   // id -> { id, startedAt, fallback }
  const cache = await readIndexCache();
  const cachedIds = new Set();

  for (const e of cache) {
    const id = String(e?.id || '');
    if (!id) continue;
    cachedIds.add(id);
    if (String(e.chatKey || '') !== chatKey) continue;
    const at = Number(e.startedAt) || decodeIdTime(id);
    if (!at || at < range.from || at > range.to) continue;
    picked.set(id, { id, startedAt: at, fallback: e });
  }

  // 缓存里没有的（区间内新产生的 / 正在运行的 / 缓存损坏缺失的）→ 从磁盘补
  let files = [];
  try { files = await fsp.readdir(SESSIONS_DIR); } catch { files = []; }
  const missing = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (cachedIds.has(id) || picked.has(id)) continue;
    const at = decodeIdTime(id);
    if (!at || at < range.from || at > range.to) continue;
    missing.push({ id, at });
  }
  if (missing.length) {
    const heads = await mapLimit(missing, 16, async (item) => {
      const key = await headChatKey(path.join(SESSIONS_DIR, `${item.id}.json`));
      return key === chatKey ? item : null;
    });
    for (const item of heads) if (item) picked.set(item.id, { id: item.id, startedAt: item.at, fallback: null });
  }

  let list = [...picked.values()].sort((a, b) => b.startedAt - a.startedAt);
  const truncated = list.length > maxSessions;
  if (truncated) list = list.slice(0, maxSessions);

  const sessions = await mapLimit(list, READ_CONCURRENCY, async (item) => {
    try {
      const data = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, `${item.id}.json`), 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch { /* 单个文件坏了不影响整次统计 */ }
    // 回落到索引摘要（缺 vendor，价格按通用表算）
    return item.fallback
      ? { id: item.id, chatKey, startedAt: item.startedAt, usage: item.fallback.usage, model: item.fallback.model, vendor: '', trigger: null }
      : null;
  });

  return { sessions: sessions.filter(Boolean), truncated, scanned: list.length };
}

// ───────────────────────────── 归属与汇总 ─────────────────────────────

/** 一次运行算谁的：优先被 @ 的那条消息，其次触发批里最早的一条。 */
function attributor(session) {
  const list = Array.isArray(session?.trigger) ? session.trigger.filter((e) => e && !e.self) : [];
  const hit = list.find((e) => e.atMe === true) || list[0] || null;
  if (!hit) return { key: '', id: '', name: '（主动发言 / 未识别）' };
  const id = String(hit.senderId || '');
  const name = String(hit.senderName || '').trim() || (id ? `QQ${id}` : '未知群友');
  return { key: id || `name:${name}`, id, name };
}

function fmtTokens(n) {
  return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v < 0.0001 && v > 0 ? '<0.0001' : v.toFixed(4);
}

function displayName(m) {
  return m.id ? `${m.name}(QQ:${m.id})` : m.name;
}

/**
 * 统计 + 渲染。纯函数式：不碰模块状态，便于离线验证。
 * @returns {{text: string, sessionCount: number, memberCount: number, truncated: boolean}}
 */
async function buildReport({ chatKey, range, cfg }) {
  const settings = normalizeSettings(cfg?.settings || cfg || {});
  const totals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0 };
  const members = new Map();
  let sessionCount = 0;

  if (String(chatKey || '').startsWith('group:')) {
    const { sessions, truncated } = await collectSessions({
      chatKey, range, maxSessions: settings.maxSessions
    });
    for (const s of sessions) {
      const u = s.usage || {};
      const prompt = Number(u.promptTokens) || 0;
      const completion = Number(u.completionTokens) || 0;
      const total = Number(u.totalTokens) || prompt + completion;
      // 零消耗会话（从没真正调用过模型的等待/中止会话）不计 —— 与核心记账口径一致
      if (!total && !(Number(u.calls) || 0)) continue;

      const cost = costOfSession(s, cfg?.raw || undefined);
      const who = attributor(s);
      const at = Number(s.startedAt) || 0;
      if (!members.has(who.key)) {
        members.set(who.key, {
          key: who.key, id: who.id, name: who.name,
          runs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, lastAt: 0
        });
      }
      const m = members.get(who.key);
      if (who.name && !/^（/.test(who.name)) m.name = who.name;   // 用最近一次看到的名字
      m.runs += 1;
      m.promptTokens += prompt;
      m.completionTokens += completion;
      m.cachedTokens += Math.min(Number(u.cachedTokens) || 0, prompt);
      m.totalTokens += total;
      m.cost += cost;
      m.lastAt = Math.max(m.lastAt, at);

      totals.promptTokens += prompt;
      totals.completionTokens += completion;
      totals.cachedTokens += Math.min(Number(u.cachedTokens) || 0, prompt);
      totals.totalTokens += total;
      totals.cost += cost;
      sessionCount += 1;
    }

    const lines = [`💰 本群花费统计（${range.label}）`];
    const ordered = [...members.values()].sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    if (!sessionCount) {
      lines.push('这个区间里还没有任何 token 消耗记录（或者机器人还没在这个群跑过）。');
      if (settings.footer) lines.push('（口径：每次运行的花费归给触发它的人）');
      return { text: lines.join('\n'), sessionCount, memberCount: 0, truncated, totals };
    }

    for (const [i, m] of ordered.slice(0, settings.topN).entries()) {
      lines.push(`${i + 1}. ${displayName(m)}：${fmtTokens(m.totalTokens)} token ｜ ¥${fmtMoney(m.cost)} ｜ ${m.runs} 次`);
    }
    if (ordered.length > settings.topN) {
      const rest = ordered.slice(settings.topN);
      const sum = rest.reduce((a, m) => ({
        totalTokens: a.totalTokens + m.totalTokens, cost: a.cost + m.cost, runs: a.runs + m.runs
      }), { totalTokens: 0, cost: 0, runs: 0 });
      lines.push(`其余 ${rest.length} 人：${fmtTokens(sum.totalTokens)} token ｜ ¥${fmtMoney(sum.cost)} ｜ ${sum.runs} 次`);
    }
    lines.push(`合计：${fmtTokens(totals.totalTokens)} token ｜ ¥${fmtMoney(totals.cost)} ｜ ${sessionCount} 次运行`);
    lines.push(`进/出 token：${fmtTokens(totals.promptTokens)} / ${fmtTokens(totals.completionTokens)}（其中缓存命中 ${fmtTokens(totals.cachedTokens)}）`);
    if (truncated) lines.push(`（区间内运行较多，只统计了最近 ${settings.maxSessions} 次）`);
    if (settings.footer) lines.push('（口径：每次运行的花费归给触发它的人；金额与「用量」页同源）');
    return { text: lines.join('\n'), sessionCount, memberCount: ordered.length, truncated, totals };
  }

  return { text: '这个统计只在群聊里有意义，私聊里没有群友数据。', sessionCount: 0, memberCount: 0, truncated: false, totals };
}

// ───────────────────────────── 触发识别 ─────────────────────────────

function pruneTasks(now = Date.now()) {
  for (const [key, value] of tasks) {
    if (!value || now - (Number(value.at) || 0) > TASK_TTL_MS) tasks.delete(key);
  }
}

/**
 * 取本轮的统计任务。
 * ⚠️ 钩子拿到的上下文里有 sessionId，但**工具的 ctx 没有**（它只有 ctx.session）——
 *    只按 ctx.sessionId 查会让工具永远拿不到任务，区间就退回模型自己填的参数。
 */
function taskOf(ctx) {
  return tasks.get(ctx?.sessionId || ctx?.session?.id) || null;
}

/** 这条消息是不是在 @机器人（新存档有 atMe 标记；老存档回落到名字匹配）。 */
function looksAtMe(entry) {
  if (!entry) return false;
  if (entry.atMe === true) return true;
  const text = String(entry.text || '');
  if (!text) return false;
  const persona = getConfig()?.persona || {};
  const names = [persona.selfNickname, persona.botName].map((x) => String(x || '').trim()).filter(Boolean);
  return names.some((n) => text.includes(`@${n}`));
}

/** 从本轮触发消息里认出统计请求；认不出返回 null。 */
function detect(ctx) {
  if (!ctx || ctx.kind !== 'group' || ctx.proactive || !ctx.sessionId) return null;
  const settings = currentSettings();
  const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];

  for (const entry of entries) {
    if (!entry || entry.self) continue;
    const text = String(entry.text || '');
    if (!text) continue;
    const keyword = settings.triggerWords.find((k) => text.includes(k));
    if (!keyword) continue;
    if (!settings.allowWithoutAt && !looksAtMe(entry)) continue;

    // 工具被关掉（总开关 / 分类开关 / 单项开关）时**不要接管** —— 否则模型既没有
    // 工具可用、又会被我们拦住 finish，整轮只能空转。
    const availability = getToolAvailability(toolId, {
      toolsCfg: getConfig()?.tools || {},
      runtimeContext: ctx
    });
    if (!availability.enabled) {
      log('统计工具当前不可用（%s），本次不接管，按普通聊天处理。', availability.reason);
      return null;
    }

    return {
      sessionId: ctx.sessionId,
      chatKey: String(ctx.chatKey || ''),
      chatId: String(ctx.chatId || ''),
      requester: { id: String(entry.senderId || ''), name: String(entry.senderName || '') },
      mid: entry.mid ?? null,
      range: parseRange(text, settings.defaultRange),
      keyword,
      at: Date.now(),
      attempts: 0,
      sent: false,
      blocks: 0
    };
  }
  return null;
}

// ───────────────────────────── 工具注册 ─────────────────────────────

export async function setup(a) {
  api = a;
  config = typeof a?.config === 'function' ? a.config : () => ({});
  log = typeof a?.log === 'function' ? a.log : () => {};
  warn = typeof a?.warn === 'function' ? a.warn : log;

  toolId = api.registerTool({
    id: 'group_cost_report',
    name: '发送本群花费统计',
    description: '统计当前群在指定日期区间内，各位群友触发的运行所消耗的 token 与折算人民币花费，并把报告直接发送到当前群聊。只在群聊里、被明确要求统计花费时调用一次；不需要参数，统计区间已经在触发时解析好。',
    category: 'query',
    icon: '💰',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: '可选，仅在自动解析失败时兜底。取值：today/yesterday/thisweek/lastweek/thismonth/lastmonth/7d/30d/all，或 "YYYY-MM-DD~YYYY-MM-DD"。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        if (String(ctx?.kind || '') !== 'group' || !String(ctx?.chatKey || '').startsWith('group:')) {
          return { content: '这个工具只在群聊里可用。', isError: true };
        }
        if (!ctx?.sender || typeof ctx.sender.sendTextBatch !== 'function') {
          return { content: '发送通道不可用，本次没有发送统计。', isError: true };
        }
        const task = taskOf(ctx);
        // 已经发出去过就绝不再发（重复播报比少发更糟）；只有"发失败"时才允许重试一次。
        if (task && (task.sent || task.attempts >= 2)) {
          return { content: '本轮已经统计并发送过了，请调用 finish 结束本轮。' };
        }
        if (task) task.attempts += 1;

        const settings = currentSettings();
        const range = task?.range || parseRange(String(args?.range || ''), settings.defaultRange);
        const report = await buildReport({
          chatKey: String(ctx.chatKey),
          range,
          cfg: { settings: settings, raw: getConfig() }
        });

        const result = await ctx.sender.sendTextBatch(ctx.chatKey, [report.text], {
          replyToMessageId: task?.mid ?? null
        });
        const sent = Array.isArray(result?.sent) ? result.sent : [];
        try {
          ctx.session?.sent?.push(...sent.map((x) => ({ type: 'text', text: x.text, at: x.at })));
          ctx.emit?.('session-update', ctx.session?.id);
        } catch { /* 只是留档，失败不影响已发出的消息 */ }

        if (!sent.length) {
          return { content: '统计报告没能发出去（可能被限频或去重），请调用 finish 结束本轮。', isError: true };
        }
        if (task) task.sent = true;
        log('已发送花费统计：群 %s，区间 %s，%s 次运行，合计 %s token / ¥%s。',
          task?.chatId || '', range.label, report.sessionCount,
          fmtTokens(report.totals.totalTokens), fmtMoney(report.totals.cost));
        return { content: '统计报告已经直接发送到本群了。请调用 finish 结束本轮，不要再补充任何文字。' };
      } catch (error) {
        warn('花费统计发送失败：%s', error?.message ?? error);
        return { content: `统计失败：${error?.message ?? error}。请调用 finish 结束本轮。`, isError: true };
      }
    }
  });

  // 这里不能打印"当前触发词"：setup 阶段本插件还没进注册表，api.config() 拿不到用户在
  // 设置里改过的值，只会拿到默认值 —— 打了反而误导（要看实际触发词，看控制台里
  // 「识别到花费统计请求」那行日志，那里是运行时读的真实设置）。
  log('群友花费统计已加载：群里 @我 + 触发词（默认「金额统计」）即可统计花费，区间可写在触发词后面。');
}

// ───────────────────────────── 钩子 ─────────────────────────────

export const hooks = {
  /** ① 确定性识别请求。这里只记任务，绝不发消息、不发网络请求。 */
  'before-context'(ctx) {
    try {
      pruneTasks();
      const hit = detect(ctx);
      if (!hit) return;
      tasks.set(ctx.sessionId, hit);
      log('识别到花费统计请求：群 %s，请求人 %s，区间 %s。',
        hit.chatId, hit.requester.name || hit.requester.id || '未知', hit.range.label);
    } catch (error) {
      warn('识别统计请求失败：%s', error?.message ?? error);
    }
  },

  /** ② 把本轮对话压成一句指令：保留 system（人设与安全规则），其余历史全部丢掉。 */
  'before-llm-messages'(ctx) {
    try {
      const task = taskOf(ctx);
      if (!task || !Array.isArray(ctx.messages)) return;
      const kept = ctx.messages.filter((m) => m?.role === 'system' || m?.role === 'developer');
      ctx.messages.splice(0, ctx.messages.length, ...kept);
      ctx.messages.push({
        role: 'user',
        content: [
          '【本群花费统计任务】群里有人要求统计花费，统计区间已经解析好，不需要你判断、也不需要你计算。',
          `第一步：调用 ${toolId}，不要传参数。它会自己统计，并把报告**直接发送到本群**。`,
          '第二步：收到工具结果后调用 finish 结束本轮。',
          '严禁：自己算数字、自己写报告、用 send_message 发送任何统计内容（会造成重复发送）。',
          `本次区间：${task.range.label}；请求人：${task.requester.name || '群友'}${task.requester.id ? `(QQ:${task.requester.id})` : ''}。`
        ].join('\n')
      });
    } catch (error) {
      warn('改写本轮对话失败：%s', error?.message ?? error);
    }
  },

  /** ④ 拦住其它工具：没发报告之前不许 finish，发完之后只许 finish。 */
  'before-tool'(ctx) {
    try {
      const task = taskOf(ctx);
      if (!task) return;
      const expected = (task.attempts || 0) > 0 ? 'finish' : toolId;
      if (ctx.toolName === expected) return;
      task.blocks = (task.blocks || 0) + 1;
      if (task.blocks > 4) return;   // 兜底：模型太犟时放行，避免把一整轮卡死
      return { block: true, reason: `本轮只做花费统计：现在应当调用 ${expected}。` };
    } catch (error) {
      warn('工具拦截失败：%s', error?.message ?? error);
    }
  },

  /** 工具真发出去了才标记 sent（后续据此清正文、拦住重复发送）。 */
  'after-tool'(ctx) {
    try {
      const task = taskOf(ctx);
      if (!task) return;
      if (ctx.toolName === toolId && !ctx.result?.isError) task.sent = true;
    } catch { /* ignore */ }
  },

  /** ⑥ 报告已由工具直接发出：清掉模型正文，避免任何"补一句"的重复。 */
  'after-response'(ctx) {
    try {
      const task = taskOf(ctx);
      if (task?.sent && ctx?.response?.message) ctx.response.message.content = '';
    } catch { /* ignore */ }
  }
};

// ───────────────────────────── 能力 ─────────────────────────────

export const providers = {
  /**
   * ③ 把本轮工具列表压到只剩本任务的工具（发完只剩 finish）。
   * 与 forward-summary 同做法：不绕过任何开关与限频，只是"本轮用不到的工具不发给模型"。
   */
  'llm.request-params'({ body, context } = {}) {
    try {
      const task = tasks.get(context?.sessionId || context?.session?.id);
      if (!task || !body || !Array.isArray(body.tools)) return body ? { body } : undefined;
      const expected = (task.attempts || 0) > 0 ? 'finish' : toolId;
      if (!body.tools.some((t) => t?.function?.name === expected)) {
        if (task.missingTool !== expected) {
          task.missingTool = expected;
          warn('无法推进统计任务：工具 %s 不在本轮可用工具列表里（检查「工具与技能」里的开关）。', expected);
        }
        return { body };
      }
      const next = { ...body, tools: body.tools.filter((t) => t?.function?.name === expected), tool_choice: 'auto' };
      delete next.parallel_tool_calls;   // 思考模式端点可能不接受这个字段
      return { body: next };
    } catch (error) {
      warn('请求改写失败：%s', error?.message ?? error);
      return undefined;   // 返回非对象 = 不改，宁可不动也不能弄坏请求
    }
  }
};

export function available() { return { ok: true }; }

export function deactivate() { tasks.clear(); }
export function dispose() { tasks.clear(); }

// 离线自检用（不参与运行时逻辑）
export const internals = {
  parseRange, normalizeSettings, buildReport, collectSessions, costOfSession, priceOf,
  attributor, detect, looksAtMe, fmtTokens, fmtMoney, decodeIdTime, SESSIONS_DIR
};
