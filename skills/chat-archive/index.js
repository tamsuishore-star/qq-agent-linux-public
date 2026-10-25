// skills/chat-archive/index.js
//
// 群聊档案检索（LLM 型技能）：让机器人能翻**自己的本地存档**回答"上次那个是什么"。
//
// ── 为什么是技能（skills/）────────────────────────────────────────────────
// "上次那个链接""谁提过 xx" 这种问题要靠模型理解人话才能翻译成检索条件
// （关键词是什么、要不要限定某个人、时间范围大概多久），参数得从自然语言里抠出来 ——
// 按 skill-development.md §0 的三问判断法属于 LLM 型。（对照：整点报时是钟表规则 → 插件。）
//
// ── 数据从哪来（都是本机现成的，零外部依赖）──────────────────────────────
// 核心把每条群消息都落盘在 data/messages/<kind>_<id>.json，结构实测为：
//   { chatKey, nextLocalId, messages: [ { id, mid, ts(毫秒), senderId, senderName,
//     text, self, read, reply, media, isPoke?, atMe?, atNames? } ] }
// 本技能**只读**这些文件：不联网、不写盘、不发消息（结果交给模型去说）。
// 这也正是它最靠谱的地方 —— 没有接口会失效、没有限流、没有费用。
//
// ── 边界（要靠提示词和行为一起守）────────────────────────────────────────
//   · 默认**只查当前会话**（ctx.chatKey）。别的群的内容不能在这个群里说出来，
//     所以跨会话检索只对「主人识别」名单里的人开放（且要显式给 chat 参数）。
//   · 只读、只回原文片段；不替用户编造"大概意思"。
//   · 输出条数与每条长度都有上限（设置可调），避免变成刷屏/占满上下文。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { countWords, layout, cleanText, estimateWidth } from './lib/wordcloud.js';

const ID = 'chat-archive';
const MSG_DIR = path.join(DATA_DIR, 'messages');
const SCAN_MAX = 50000;          // 单次最多扫这么多条（防止哪天存档涨到几十万条时卡住）
const CACHE_MAX = 3;             // 最多缓存几份解析结果

let cfgOf = () => ({});
let log = () => {};
let warn = () => {};
let apiRef = null;            // setup(api) 时记下来：定时器要用它问"这个技能还开着吗"

const pad = (n) => String(n).padStart(2, '0');

// ── 设置 ──────────────────────────────────────────────────────────────────
function settings() {
  const c = cfgOf() || {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    defaultDays: Math.max(1, Math.min(3650, Math.round(n(c.defaultDays, 7)))),
    maxDays: Math.max(1, Math.min(3650, Math.round(n(c.maxDays, 90)))),
    defaultLimit: Math.max(1, Math.min(200, Math.round(n(c.defaultLimit, 20)))),
    maxLimit: Math.max(1, Math.min(200, Math.round(n(c.maxLimit, 50)))),
    snippetChars: Math.max(20, Math.min(500, Math.round(n(c.snippetChars, 100)))),
    // 群活跃榜
    dailyBoard: c.dailyBoard !== false,
    weeklyBoard: c.weeklyBoard !== false,
    weeklyReplacesDaily: c.weeklyReplacesDaily !== false,
    boardTargets: String(c.boardTargets ?? ''),
    boardTop: Math.max(1, Math.min(15, Math.round(n(c.boardTop, 5)))),
    boardMinMessages: Math.max(0, Math.min(1000, Math.round(n(c.boardMinMessages, 5)))),
    boardGraceMinutes: Math.max(0, Math.min(59, Math.round(n(c.boardGraceMinutes, 5)))),
    // 词云
    wcTop: Math.max(10, Math.min(120, Math.round(n(c.wcTop, 60)))),
    wcMinCount: Math.max(2, Math.min(50, Math.round(n(c.wcMinCount, 3)))),
    wcFont: String(c.wcFont ?? '').trim() || 'Microsoft YaHei',
    wcStopExtra: String(c.wcStopExtra ?? ''),
    autoCloud: c.autoCloud !== false
  };
}

// ── 存档读取（带按 mtime 失效的缓存）──────────────────────────────────────
const cache = new Map();      // file → { mtimeMs, size, data }

/** chatKey（`group:123`）→ 存档文件名（`group_123.json`）。 */
function fileForChat(chatKey) {
  const m = String(chatKey ?? '').match(/^(group|private):(\d+)$/);
  if (!m) return null;
  return path.join(MSG_DIR, `${m[1]}_${m[2]}.json`);
}

/** 列出本机存档里所有会话（只给主人看清单用）。 */
function listArchives() {
  try {
    return fs.readdirSync(MSG_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /^(group|private)_\d+\.json$/.test(e.name))
      .map((e) => {
        const st = fs.statSync(path.join(MSG_DIR, e.name));
        return { file: path.join(MSG_DIR, e.name), name: e.name, sizeKB: Math.round(st.size / 1024), mtimeMs: st.mtimeMs };
      });
  } catch { return []; }
}

/**
 * 读某个存档文件的消息数组。缓存按 (mtime, size) 失效 ——
 * 存档是持续追加的，靠 mtime 判断"变了没有"最省事。
 */
function readArchive(file) {
  let st = null;
  try { st = fs.statSync(file); } catch { return { ok: false, error: `没有这个会话的存档：${path.basename(file)}` }; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { ok: true, messages: hit.data, cached: true };
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, error: `存档读不出来（${path.basename(file)}）：${e?.message ?? e}` }; }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data: messages });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { ok: true, messages, cached: false, chatKey: String(parsed?.chatKey ?? '') };
}

// ── 检索 ──────────────────────────────────────────────────────────────────
function fmtTime(ts) {
  const d = new Date(Number(ts) || 0);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function speakerOf(m) {
  if (m?.self) return String(m.senderName || '我');
  return String(m.senderName || m.senderId || '某人');
}

/** 文本化一条消息：没有正文的（图片/文件/拍一拍）给出可读占位。 */
function textOf(m, snippetChars) {
  let t = String(m?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) {
    if (m?.isPoke) t = '（拍一拍）';
    else if (m?.media) t = '（图片/文件）';
    else t = '（无文字内容）';
  }
  return t.length > snippetChars ? `${t.slice(0, snippetChars)}…` : t;
}

function splitTerms(keyword) {
  return String(keyword ?? '')
    .split(/[\s,，、;；]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 在某个会话的存档里检索。
 * @param {object} opts { chatKey, keyword, days, limit, sender, includeSelf, snippetChars }
 */
function searchArchive(opts = {}) {
  const s = settings();
  const file = fileForChat(opts.chatKey);
  if (!file) return { ok: false, error: `看不懂这个会话标识：${opts.chatKey}` };
  const read = readArchive(file);
  if (!read.ok) return read;

  const days = Math.max(1, Math.min(s.maxDays, Math.round(Number(opts.days) || s.defaultDays)));
  const limit = Math.max(1, Math.min(s.maxLimit, Math.round(Number(opts.limit) || s.defaultLimit)));
  const since = Date.now() - days * 86400000;
  const terms = splitTerms(opts.keyword);
  const sender = String(opts.sender ?? '').trim().toLowerCase();
  const includeSelf = opts.includeSelf !== false;

  const all = read.messages;
  const slice = all.length > SCAN_MAX ? all.slice(-SCAN_MAX) : all;
  const hits = [];
  let scanned = 0;
  let inRange = 0;
  for (let i = slice.length - 1; i >= 0; i -= 1) {          // 从新往旧扫，先拿到最近的
    const m = slice[i];
    const ts = Number(m?.ts) || 0;
    if (!ts || ts < since) continue;
    inRange += 1;
    scanned += 1;
    if (!includeSelf && m?.self) continue;
    if (sender) {
      const who = `${m?.senderName ?? ''} ${m?.senderId ?? ''}`.toLowerCase();
      if (!who.includes(sender)) continue;
    }
    if (terms.length) {
      const hay = String(m?.text ?? '').toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
    }
    hits.push(m);
    if (hits.length >= limit) break;
  }
  return {
    ok: true,
    file,
    days,
    since,
    terms,
    total: all.length,
    inRange,
    scanned,
    hits,
    truncated: hits.length >= limit,
    read
  };
}

function renderHits(r, snippetChars) {
  if (!r.hits.length) return [];
  return r.hits.map((m) => `· ${fmtTime(m.ts)} ${speakerOf(m)}：${textOf(m, snippetChars)}`);
}

/** 这段时间里谁最能说。 */
function statsOf(chatKey, days, topN) {
  const s = settings();
  const file = fileForChat(chatKey);
  if (!file) return { ok: false, error: `看不懂这个会话标识：${chatKey}` };
  const read = readArchive(file);
  if (!read.ok) return read;
  const d = Math.max(1, Math.min(s.maxDays, Math.round(Number(days) || s.defaultDays)));
  const since = Date.now() - d * 86400000;
  const byWho = new Map();
  let total = 0;
  let first = null;
  let last = null;
  for (const m of read.messages) {
    const ts = Number(m?.ts) || 0;
    if (!ts || ts < since) continue;
    total += 1;
    if (first === null || ts < first) first = ts;
    if (last === null || ts > last) last = ts;
    const who = m?.self ? '（机器人自己）' : speakerOf(m);
    byWho.set(who, (byWho.get(who) || 0) + 1);
  }
  const rows = [...byWho.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, Math.min(20, Number(topN) || 10)));
  return { ok: true, days: d, since, total, first, last, rows, archiveTotal: read.messages.length };
}

// ── 群活跃榜（每日 0 点日榜 / 周一 0 点周榜）──────────────────────────────
// 为什么放在这个技能里而不是单独做个插件：统计引擎（读存档、按人计数）就在这儿，
// 拆出去等于把同一套逻辑复制一份、还可能两边口径不一致。功能都是一个扩展，只有一个开关。
//
// 两条时间口径（都很关键，写错了榜就是错的）：
//   · 0 点发"日榜" → 统计的是**刚过去的那一天**（昨天 00:00 ~ 今天 00:00），
//     不是"最近 24 小时"，也不是刚开始的今天。
//   · 周一 0 点发"周榜" → 统计**刚过去的那一周**（上周一 00:00 ~ 本周一 00:00）。
// 判重键落盘（data/chat-archive/state.json），重启后同一时段不会重复发；
// 宽限期内没跑到（比如半夜电脑休眠）就跳过这一次，不会把半夜的榜拖到白天发。
const BOARD_TICK_MS = 30 * 1000;
let boardTimer = null;
let senderRef = null;            // 工具被调用时捕获（发送通道，见文件头注释）
let boardState = { firedKeys: [], lastBoard: null };
let boardStateLoaded = false;

function boardStatePath() { return path.join(DATA_DIR, 'chat-archive', 'state.json'); }

function loadBoardState() {
  if (boardStateLoaded) return;
  boardStateLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(boardStatePath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      boardState = {
        firedKeys: Array.isArray(raw.firedKeys) ? raw.firedKeys.map(String).slice(-60) : [],
        lastBoard: raw.lastBoard && typeof raw.lastBoard === 'object' ? raw.lastBoard : null
      };
    }
  } catch { /* 首次运行没有这个文件 */ }
}

function saveBoardState() {
  try {
    fs.mkdirSync(path.dirname(boardStatePath()), { recursive: true });
    const tmp = `${boardStatePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(boardState, null, 1), 'utf8');
    fs.renameSync(tmp, boardStatePath());
  } catch (e) { warn(`榜单状态落盘失败：${e?.message ?? e}`); }
}

/**
 * 统计一个**固定时间区间**内的发言情况（日榜/周榜都用它）。
 * 机器人自己的发言不参与排名（它一天能刷几百条，进了榜就没法看了），单独计数。
 */
function statsInRange(chatKey, fromTs, toTs, topN = 5) {
  const file = fileForChat(chatKey);
  if (!file) return { ok: false, error: `看不懂这个会话标识：${chatKey}` };
  const read = readArchive(file);
  if (!read.ok) return read;
  const byWho = new Map();
  const byHour = new Map();
  let total = 0;
  let selfCount = 0;
  let first = null;
  let last = null;
  for (const m of read.messages) {
    const ts = Number(m?.ts) || 0;
    if (!ts || ts < fromTs || ts >= toTs) continue;
    total += 1;
    if (first === null || ts < first) first = ts;
    if (last === null || ts > last) last = ts;
    const h = new Date(ts).getHours();
    byHour.set(h, (byHour.get(h) || 0) + 1);
    if (m?.self) { selfCount += 1; continue; }              // 不进榜
    const who = speakerOf(m);
    byWho.set(who, (byWho.get(who) || 0) + 1);
  }
  const rows = [...byWho.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, Math.min(15, topN)));
  const topHour = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  return { ok: true, total, selfCount, active: total - selfCount, rows, topHour, first, last };
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/** 把统计渲染成一条能直接发群里的榜单。 */
function renderBoard({ scope, chatKey, fromTs, toTs, stats, prevStats = null }) {
  const s = settings();
  const from = new Date(fromTs);
  const to = new Date(toTs - 1);
  const rangeLabel = scope === 'daily'
    ? `${from.getMonth() + 1}月${from.getDate()}日（周${WD[from.getDay()]}）`
    : `${from.getMonth() + 1}/${from.getDate()} ~ ${to.getMonth() + 1}/${to.getDate()}`;
  const lines = [`🏆 ${scope === 'daily' ? '日榜' : '周榜'}｜${rangeLabel}`];
  if (!stats.rows.length) {
    lines.push('（这段时间没人说话，榜是空的）');
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    stats.rows.forEach(([who, n], i) => {
      let delta = '';
      if (prevStats?.ok) {
        const prevIdx = prevStats.rows.findIndex(([w]) => w === who);
        if (prevIdx === -1) delta = '　🆕新上榜';
        else {
          const diff = prevIdx - i;
          if (diff > 0) delta = `　↑${diff}`;
          else if (diff < 0) delta = `　↓${-diff}`;
        }
      }
      const pct = Math.round((n / Math.max(1, stats.active)) * 100);
      lines.push(`${medals[i] || `${i + 1}.`} ${who} —— ${n} 条（${pct}%）${delta}`);
    });
  }
  lines.push(`合计 ${stats.total} 条，其中群友 ${stats.active} 条${stats.selfCount ? `、我自己 ${stats.selfCount} 条` : ''}`);
  if (stats.topHour) lines.push(`最热闹的时段：${String(stats.topHour[0]).padStart(2, '0')}:00 前后（${stats.topHour[1]} 条）`);
  if (prevStats?.ok && scope === 'weekly') lines.push(`（上一周共 ${prevStats.active} 条，箭头＝名次变化）`);
  return lines.join('\n');
}

/** 榜发到哪些群：设置里填了就发那些，留空用核心白名单群。 */
function boardTargets() {
  const explicit = String(settings().boardTargets).split(/[,，、;；\s]+/).map((x) => x.trim()).filter((x) => /^\d{5,}$/.test(x));
  if (explicit.length) return explicit.map((id) => `group:${id}`);
  try {
    const groups = ((getConfig()?.allow?.groups) || []).map(String).filter(Boolean);
    if (groups.length) return groups.map((id) => `group:${id}`);
  } catch { /* ignore */ }
  return [];
}

/** 算"刚过去的那一天/那一周"的区间。 */
function boardWindow(scope, now = new Date()) {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (scope === 'daily') return { from: dayStart - 86400000, to: dayStart };
  const wd = now.getDay() === 0 ? 7 : now.getDay();          // 1=周一
  const mondayThis = dayStart - (wd - 1) * 86400000;
  return { from: mondayThis - 7 * 86400000, to: mondayThis };
}

async function sendBoard(scope, { targets = null, chatKey = '', reason = '', now = new Date() } = {}) {
  const s = settings();
  const list = targets ?? boardTargets();
  if (!list.length) {
    warn(`${scope === 'daily' ? '日榜' : '周榜'}该发了，但没有目标群（设置里没填、白名单也没群）`);
    return { ok: false, error: '没有目标群' };
  }
  if (!senderRef || typeof senderRef.sendTextBatch !== 'function') {
    warn(`${scope === 'daily' ? '日榜' : '周榜'}该发了，但还没拿到发送通道：在群里说一句话（或问一次「谁最能说」）即可激活`);
    return { ok: false, error: '没有发送通道' };
  }
  const { from, to } = boardWindow(scope, now);
  const sent = [];
  const skipped = [];
  for (const key of list) {
    const stats = statsInRange(key, from, to, s.boardTop);
    if (!stats.ok) { skipped.push(`${key}（${stats.error}）`); continue; }
    if (stats.active < s.boardMinMessages) { skipped.push(`${key}（只有 ${stats.active} 条，低于门槛 ${s.boardMinMessages}，不打扰）`); continue; }
    let prevStats = null;
    if (scope === 'weekly') {
      const prev = boardWindow('weekly', new Date(from));    // 上一周
      prevStats = statsInRange(key, prev.from, prev.to, s.boardTop);
    }
    const text = renderBoard({ scope, chatKey: key, fromTs: from, toTs: to, stats, prevStats });
    try {
      await senderRef.sendTextBatch(key, [text]);
      sent.push(key);
      log(`已发${scope === 'daily' ? '日榜' : '周榜'}到 ${key}：群友 ${stats.active} 条，榜首 ${stats.rows[0]?.[0] ?? '无'}${reason ? `（${reason}）` : ''}`);
    } catch (e) { skipped.push(`${key}（发送失败：${e?.message ?? e}）`); }
  }
  if (sent.length) {
    boardState.lastBoard = { scope, at: Date.now(), sent: sent.length, skipped: skipped.length };
    saveBoardState();
  }
  for (const x of skipped) warn(`榜单跳过 ${x}`);
  return { ok: sent.length > 0, sent, skipped, from, to };
}

function dayKeyOf(now) { return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }

/**
 * 现在该不该发榜、发哪个（纯函数，便于离线验证 0 点逻辑）。
 * 只在 0 点那一小段（含宽限）才有戏；周一优先周榜；判重键已存在则不发。
 */
function whichBoardDue(now = new Date()) {
  const s = settings();
  if (now.getHours() !== 0 || now.getMinutes() > s.boardGraceMinutes) return { scope: '', key: '' };
  const key = dayKeyOf(now);
  const isMonday = now.getDay() === 1;
  const weeklyKey = `weekly:${key}`;
  const dailyKey = `daily:${key}`;
  if (s.weeklyBoard && isMonday && !boardState.firedKeys.includes(weeklyKey)) {
    return { scope: 'weekly', key: weeklyKey, suppressDaily: s.weeklyReplacesDaily, dailyKey };
  }
  if (s.dailyBoard && !boardState.firedKeys.includes(dailyKey)) return { scope: 'daily', key: dailyKey };
  return { scope: '', key: '' };
}

/** 每 30 秒看一眼：到 0 点了吗？到点了就发对应的榜。 */
async function boardTick(now = new Date()) {
  try {
    if (!apiRef) return;
    let active = true;
    try { active = apiRef.isSkillActive(ID) !== false; } catch { active = true; }
    if (!active) return;
    const due = whichBoardDue(now);
    if (!due.scope) return;
    boardState.firedKeys = [...boardState.firedKeys, due.key].slice(-60);
    if (due.scope === 'weekly' && due.suppressDaily) boardState.firedKeys = [...boardState.firedKeys, due.dailyKey].slice(-60);
    saveBoardState();
    const r = await sendBoard(due.scope, { reason: due.scope === 'weekly' ? '周一 0 点' : '每日 0 点', now });
    // 周一发完周榜，再补一张"上一周"的词云（用的是同一个时间窗口、同一批群）
    if (due.scope === 'weekly' && r.ok && settings().autoCloud) {
      await sendCloud({
        targets: r.sent, fromTs: r.from, toTs: r.to,
        scopeLabel: '跟周榜一起', reason: '周一 0 点跟周榜一起'
      });
    }
  } catch (e) { warn(`榜单定时检查出错：${e?.message ?? e}`); }
}

function ensureBoardTimer() {
  if (boardTimer) return;
  boardTimer = setInterval(() => { boardTick().catch(() => {}); }, BOARD_TICK_MS);
  boardTimer.unref?.();          // 不 unref 会把项目离线测试的进程钉住
}

function stopBoardTimer() { if (boardTimer) { clearInterval(boardTimer); boardTimer = null; } }

/** 抓发送通道（工具被调用时）。 */
function captureSender(ctx) {
  if (ctx?.sender && typeof ctx.sender.sendTextBatch === 'function') senderRef = ctx.sender;
}

// ── 词云图 ────────────────────────────────────────────────────────────────
// 分词与排版在 lib/wordcloud.js（纯逻辑、可离线验证）；这里只负责
// "取文本 → 出图 → 发出去"。
//
// 画中文为什么绕道 PowerShell：程序自带的 node_modules 里没有 canvas / sharp，
// 我上一轮给股票技能写过一个纯 JS 的 PNG 编码器，但它只有 5x7 的 ASCII 点阵字体，
// 画不了汉字。而 Windows 自带 .NET 的 GDI+（System.Drawing）能直接用系统字体
// （微软雅黑/黑体）把中文画进 PNG —— 实测这台机器上可用，且不用装任何东西。
// ffmpeg 那条路我也探过：PATH 和常见目录里都没有 ffmpeg 命令行，所以不用它。
const CLOUD_DIR = path.join(DATA_DIR, 'chat-archive');
const CLOUD_KEEP = 5;              // 只保留最近几张，避免越攒越多

// 画图用的 PowerShell：优先用系统绝对路径（不依赖 PATH —— 程序有时是在
// 换过环境变量的进程里启动的，靠 PATH 找 powershell.exe 会莫名失败）。
const PS_EXE = (() => {
  const abs = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { return fs.existsSync(abs) ? abs : 'powershell.exe'; } catch { return 'powershell.exe'; }
})();

let lastCloudAt = 0;
const CLOUD_COOLDOWN_MS = 20 * 1000;   // 防刷屏：两张词云至少隔 20 秒

/** PowerShell 单引号转义：' → ''。 */
const psQuote = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

/** 取这段时间的群友发言正文（不含机器人自己、跳过空消息）。
 *  两种口径：给 days（"最近 N 天"，人工问的走这条）；给 fromTs/toTs（定时那一路走这条，
 *  区间对齐"刚过去的那一周"，跟周榜是同一个窗口，免得图和榜说的不是同一段时间）。 */
function collectTexts(chatKey, days, { excludeSelf = true, fromTs = 0, toTs = 0 } = {}) {
  const file = fileForChat(chatKey);
  if (!file) return { ok: false, error: `看不懂这个会话标识：${chatKey}` };
  const read = readArchive(file);
  if (!read.ok) return read;
  const useWindow = Number(fromTs) > 0 && Number(toTs) > Number(fromTs);
  const since = useWindow ? Number(fromTs) : Date.now() - Math.max(1, days) * 86400000;
  const until = useWindow ? Number(toTs) : Infinity;
  const texts = [];
  for (const m of read.messages) {
    const ts = Number(m?.ts) || 0;
    if (!ts || ts < since || ts >= until) continue;
    if (excludeSelf && m?.self) continue;
    const t = cleanText(m?.text ?? '');
    if (!t.trim()) continue;
    texts.push(String(m.text));      // 交给分词器再清一遍（保留原文里的中文与英文词）
  }
  return { ok: true, texts, days, from: since, to: until === Infinity ? Date.now() : until };
}

/** 生成画图计划（纯函数，便于离线断言）。 */
function buildCloudPlan(chatKey, days, { scopeLabel = '', fromTs = 0, toTs = 0, title = '' } = {}) {
  const s = settings();
  const got = collectTexts(chatKey, days, { fromTs, toTs });
  if (!got.ok) return got;
  const nicknames = (() => {
    try {
      const m = getConfig()?.memberNotes || {};
      return Object.values(m).map(String).filter((x) => x.length >= 2);
    } catch { return []; }
  })();
  const counted = countWords(got.texts, {
    minCount: s.wcMinCount,
    maxWords: s.wcTop,
    extraStop: String(s.wcStopExtra).split(/[,，、;；\s]+/).filter(Boolean),
    dropWords: nicknames                                     // 人名词不进词云（榜单已经管人了）
  });
  const fmt = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const header = title || (fromTs > 0 && toTs > fromTs
    ? `群聊词云 · ${fmt(fromTs)} ~ ${fmt(toTs - 1)}${scopeLabel ? ` · ${scopeLabel}` : ''}`
    : `群聊词云 · 最近 ${days} 天${scopeLabel ? ` · ${scopeLabel}` : ''}`);
  const footer = `样本 ${counted.scanned} 条群友消息 · 词云由发言里的高频词组统计得出`;
  const plan = layout(counted.words, { fontFamily: s.wcFont, header, footer });
  return { ok: true, plan, counted, texts: got.texts.length, from: got.from, to: got.to };
}

/**
 * 用 PowerShell + GDI+ 把计划画成 PNG。
 * 计划走 JSON 文件（不放命令行里，免去长度与转义问题）。
 */
function renderCloudPng(plan, outPath) {
  return new Promise((resolve) => {
    const planPath = path.join(CLOUD_DIR, `plan-${Date.now()}.json`);
    try {
      fs.mkdirSync(CLOUD_DIR, { recursive: true });
      fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');
    } catch (e) { resolve({ ok: false, error: `词云计划写盘失败：${e?.message ?? e}` }); return; }

    const font = plan.fontFamily || 'Microsoft YaHei';
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Drawing',
      `$plan = [System.IO.File]::ReadAllText(${psQuote(planPath)}, [System.Text.Encoding]::UTF8) | ConvertFrom-Json`,
      '$w = [int]$plan.width; $h = [int]$plan.height',
      '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias',
      '$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
      '$bg = $plan.background',
      '$g.Clear([System.Drawing.Color]::FromArgb(255, [int]$bg[0], [int]$bg[1], [int]$bg[2]))',
      '$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 40, 44, 52))',
      '$gray = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 130, 136, 144))',
      'function Draw-Centered($text, $size, $brush, $y) {',
      '  $f = New-Object System.Drawing.Font(' + psQuote(font) + ', [single]$size, [System.Drawing.FontStyle]::Bold)',
      '  $sz = $g.MeasureString($text, $f)',
      '  $x = [Math]::Max($plan.margin, ($plan.width - $sz.Width) / 2)',
      '  $g.DrawString($text, $f, $brush, [single]$x, [single]$y)',
      '  $f.Dispose()',
      '}',
      'if ($plan.header) { Draw-Centered $plan.header $plan.headerSize $ink $plan.margin }',
      'if ($plan.footer) { Draw-Centered $plan.footer $plan.footerSize $gray ($plan.height - $plan.margin - 18) }',
      'foreach ($wd in $plan.words) {',
      '  $col = $wd.color',
      '  $f = New-Object System.Drawing.Font(' + psQuote(font) + ', [single]$wd.size, [System.Drawing.FontStyle]::Bold)',
      '  $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, [int]$col[0], [int]$col[1], [int]$col[2]))',
      // 用真实字体量一遍：万一比估算宽，按比例缩小该词，保证不越界、不叠字
      '  $sz = $g.MeasureString($wd.text, $f)',
      '  if ($sz.Width -gt ($wd.wpx + 4) -and $wd.wpx -gt 0) {',
      '    $scale = [Math]::Max(0.6, $wd.wpx / $sz.Width)',
      '    $f.Dispose()',
      '    $f = New-Object System.Drawing.Font(' + psQuote(font) + ', [single]([int]($wd.size * $scale)), [System.Drawing.FontStyle]::Bold)',
      '    $sz = $g.MeasureString($wd.text, $f)',
      '  }',
      // 真实行高比字号大（雅黑约 1.3 倍），把多出来的那点上下均分，
      // 免得字的墨迹往邻行探过去 —— 这是"看着不挤"的关键一步。
      '  $dy = [Math]::Max(0, ($sz.Height - $wd.size) / 2)',
      '  $g.DrawString($wd.text, $f, $b, [single]$wd.x, [single]($wd.y - $dy))',
      '  $f.Dispose(); $b.Dispose()',
      '}',
      '$ink.Dispose(); $gray.Dispose(); $g.Dispose()',
      `$bmp.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$bmp.Dispose()',
      "Write-Output 'OK'"
    ].join('\r\n');

    let child = null;
    try {
      child = spawn(PS_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve({ ok: false, error: `起 PowerShell 失败：${e?.message ?? e}` }); return; }
    let out = '';
    let err = '';
    const cap = (x, d) => (x.length > 2000 ? x : x + String(d));
    child.stdout?.on('data', (d) => { out = cap(out, d); });
    child.stderr?.on('data', (d) => { err = cap(err, d); });
    const killer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 30000);
    killer.unref?.();
    child.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: `画图进程出错：${e?.message ?? e}` }); });
    child.on('close', (code) => {
      clearTimeout(killer);
      try { fs.unlinkSync(planPath); } catch { /* 清不掉就算了 */ }
      if (code !== 0 || !fs.existsSync(outPath)) {
        resolve({ ok: false, error: `画图失败（退出码 ${code}）：${String(err || out).trim().slice(0, 200)}` });
        return;
      }
      // 只留最近几张
      try {
        const files = fs.readdirSync(CLOUD_DIR).filter((f) => /^cloud-\d+\.png$/.test(f)).sort();
        for (const f of files.slice(0, Math.max(0, files.length - CLOUD_KEEP))) fs.unlinkSync(path.join(CLOUD_DIR, f));
      } catch { /* ignore */ }
      resolve({ ok: true, file: outPath, bytes: fs.statSync(outPath).size });
    });
  });
}

/**
 * 定时发词云（周一 0 点跟着周榜发）。
 * 跟人工那条路的区别：区间用**周榜同一个窗口**（刚过去的那一周），
 * 目标群也只发给"榜真的发成功了的那些群" —— 榜因为太冷没发，图也不该单独冒出来。
 */
async function sendCloud({ targets = null, fromTs = 0, toTs = 0, days = 0, scopeLabel = '', reason = '' } = {}) {
  const s = settings();
  const list = targets ?? boardTargets();
  if (!list.length) {
    warn(`词云该发了，但没有目标群（设置里没填、白名单也没群）`);
    return { ok: false, error: '没有目标群' };
  }
  if (!senderRef || typeof senderRef.sendImage !== 'function') {
    warn('词云该发了，但还没拿到发送通道（发图要通道）：在群里说一句话、或问一次「谁最能说」即可激活');
    return { ok: false, error: '没有发送通道' };
  }
  const sent = [];
  const skipped = [];
  for (const key of list) {
    const built = buildCloudPlan(key, days || s.defaultDays, { fromTs, toTs, scopeLabel });
    if (!built.ok) { skipped.push(`${key}（${built.error}）`); continue; }
    if (built.texts < s.boardMinMessages) { skipped.push(`${key}（样本只有 ${built.texts} 条，低于门槛 ${s.boardMinMessages}，不打扰）`); continue; }
    if (!built.counted.words.length) { skipped.push(`${key}（这段时间没有能成词的发言）`); continue; }
    const outPath = path.join(CLOUD_DIR, `cloud-${Date.now()}.png`);
    const r = await renderCloudPng(built.plan, outPath);          // 串行画：画图是重活，别并发压机器
    if (!r.ok) { skipped.push(`${key}（出图失败：${r.error}）`); continue; }
    try {
      await senderRef.sendImage(key, {
        file: outPath,
        dataUrl: `base64://${fs.readFileSync(outPath).toString('base64')}`
      }, { note: '群聊词云' });
      sent.push(key);
      log(`已发词云到 ${key}：${built.plan.words.length} 个词，样本 ${built.texts} 条${reason ? `（${reason}）` : ''}`);
    } catch (e) { skipped.push(`${key}（发送失败：${e?.message ?? e}）`); }
  }
  for (const x of skipped) warn(`词云跳过 ${x}`);
  if (sent.length) {
    boardState.lastCloud = { at: Date.now(), sent: sent.length, skipped: skipped.length, from: fromTs, to: toTs };
    saveBoardState();
  }
  return { ok: sent.length > 0, sent, skipped, from: fromTs, to: toTs };
}

// ── 主人判定（只有主人能跨会话查）─────────────────────────────────────────
function parseIds(raw) {
  return String(raw ?? '').split(/[,，、;；\s]+/).map((x) => x.trim()).filter((x) => /^\d{5,}$/.test(x));
}

function ownerIds() {
  try { return parseIds(getConfig()?.skills?.['owner-identity']?.ids); } catch { return []; }
}

function senderIdOf(ctx) {
  const entries = ctx?.session?.trigger ?? ctx?.session?.triggerEntries ?? [];
  const list = Array.isArray(entries) ? entries : [];
  const last = [...list].reverse().find((e) => e && !e.self);
  return String(last?.senderId ?? '');
}

/** 解析"别的会话"参数：群号 / QQ 号 → chatKey（只在主人调用时才允许）。 */
function resolveOtherChat(ctx, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, chatKey: '' };
  const m = text.match(/^(group|private)?[:：]?(\d{5,})$/);
  if (!m) return { ok: false, error: `看不懂「${text}」，给群号或 QQ 号（纯数字）就行` };
  const ids = ownerIds();
  const uid = senderIdOf(ctx);
  if (!ids.length || !uid || !ids.includes(uid)) {
    return { ok: false, error: '查别的群/私聊的存档只有主人可以，这次调用已忽略该参数（只查了当前会话）。' };
  }
  const kind = m[1] || (String(text).includes('private') ? 'private' : 'group');
  return { ok: true, chatKey: `${kind}:${m[2]}`, owner: true };
}

// ── 工具 ──────────────────────────────────────────────────────────────────
export function setup(api) {
  apiRef = api;
  cfgOf = typeof api.config === 'function' ? api.config : () => ({});
  log = (...a) => api.log?.(...a);
  warn = (...a) => api.warn?.(...a);

  api.registerTool({
    id: 'search',
    name: '翻群聊存档',
    description: '在本群的本地消息存档里按关键词/时间段检索，用来回答「上次那个链接」「谁提过 xx」「前两天说的那个」。'
      + '适用：群友问过去发生过的具体内容（回忆型问题）。'
      + '参数：keyword 关键词（多个词用空格分隔＝都要出现，可留空表示"只按时间翻最近的"）；'
      + 'days 往前翻几天（默认看设置，不填就按默认）；sender 只看某个人（昵称或 QQ 号）；'
      + 'includeSelf=false 排除机器人自己的发言；limit 最多几条。'
      + '返回带时间和发言人的原文片段，照实引用即可；没找到就照实说没找到。'
      + 'chat 参数可以查别的会话，但**只有主人能生效**，其他人给了也只会查当前会话。',
    category: 'query',
    icon: '🗂️',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要找的内容关键词，多个词用空格分隔（例如「B站 链接」）' },
        days: { type: 'number', description: '往前翻几天，例如 3=最近三天、30=最近一个月' },
        sender: { type: 'string', description: '只看某个人说的（昵称或 QQ 号）' },
        includeSelf: { type: 'boolean', description: '是否包含机器人自己的发言，默认包含' },
        limit: { type: 'number', description: '最多返回几条，默认按设置' },
        chat: { type: 'string', description: '要查的群号或 QQ 号（只有主人有效；留空=当前会话）' }
      },
      required: []
    },
    async execute(ctx, args = {}) {
      captureSender(ctx);
      const s = settings();
      let chatKey = String(ctx?.chatKey ?? '');
      const other = resolveOtherChat(ctx, args?.chat);
      let note = '';
      if (!other.ok) note = `（${other.error}）`;
      else if (other.chatKey) chatKey = other.chatKey;
      if (!chatKey) return { content: '错误：拿不到当前会话标识，没法查存档', isError: true };

      const r = searchArchive({
        chatKey,
        keyword: args?.keyword,
        days: args?.days,
        limit: args?.limit,
        sender: args?.sender,
        includeSelf: args?.includeSelf,
        snippetChars: s.snippetChars
      });
      if (!r.ok) return { content: `错误：${r.error}${note}`, isError: true };

      const head = `会话 ${chatKey}｜最近 ${r.days} 天里共 ${r.inRange} 条消息` +
        (r.terms.length ? `，其中命中「${r.terms.join(' ')}」的 ${r.hits.length} 条` : `，取最近的 ${r.hits.length} 条`);
      if (!r.hits.length) {
        return {
          content: [
            `${head}。没找到匹配的消息。`,
            r.terms.length ? '可以换个关键词、或者把 days 放大一点（例如 30），也可以去掉 sender 限制再试。' : '这段时间里这个会话没有消息。',
            `（存档里累计 ${r.total} 条${r.read.cached ? '，来自缓存' : ''}）${note}`
          ].join('\n')
        };
      }
      return {
        content: [
          head + '（从新到旧）：',
          ...renderHits(r, s.snippetChars),
          r.truncated ? `…还有更多，需要的话把 limit 调大或缩小时间范围。` : '',
          note
        ].filter(Boolean).join('\n')
      };
    }
  });

  api.registerTool({
    id: 'stats',
    name: '群聊活跃统计',
    description: '统计最近一段时间本群里谁发言最多（含总条数、时间范围），用来回答「这周谁最能说」「谁最活跃」。'
      + '参数：days 统计最近几天（默认按设置）；top 列出前几名（默认 10）。'
      + 'chat 参数可以统计别的会话，但只有主人能生效。',
    category: 'query',
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '统计最近几天' },
        top: { type: 'number', description: '列出前几名，默认 10' },
        chat: { type: 'string', description: '要统计的群号或 QQ 号（只有主人有效；留空=当前会话）' }
      },
      required: []
    },
    async execute(ctx, args = {}) {
      captureSender(ctx);
      let chatKey = String(ctx?.chatKey ?? '');
      let note = '';
      const other = resolveOtherChat(ctx, args?.chat);
      if (!other.ok) note = `（${other.error}）`;
      else if (other.chatKey) chatKey = other.chatKey;
      if (!chatKey) return { content: '错误：拿不到当前会话标识，没法统计', isError: true };

      const r = statsOf(chatKey, args?.days, args?.top);
      if (!r.ok) return { content: `错误：${r.error}${note}`, isError: true };
      if (!r.total) return { content: `会话 ${chatKey}｜最近 ${r.days} 天里没有消息。${note}` };
      return {
        content: [
          `会话 ${chatKey}｜最近 ${r.days} 天：共 ${r.total} 条消息（${fmtTime(r.first)} ~ ${fmtTime(r.last)}）`,
          ...r.rows.map(([who, n], i) => `${i + 1}. ${who} —— ${n} 条（${Math.round((n / r.total) * 100)}%）`),
          `（存档累计 ${r.archiveTotal} 条）${note}`
        ].join('\n')
      };
    }
  });

  api.registerTool({
    id: 'board',
    name: '群活跃榜',
    description: '群活跃榜（按发言数排名）。定时会在**每天 0 点发日榜、周一 0 点发周榜**（周榜还带与上周的名次变化）。'
      + 'action=preview 只看不发（默认）：按 scope 生成榜单文字，你转述给群友即可；'
      + 'action=send 立刻把榜发到目标群（只有主人能用，用来补发或试看效果）。'
      + 'scope=daily（过去一整天，默认）或 weekly（过去一整周）。chat 可指定群号（只有主人有效）。',
    category: 'query',
    icon: '🏆',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['preview', 'send'], description: 'preview=只看不发（默认）；send=立刻发到目标群（仅主人）' },
        scope: { type: 'string', enum: ['daily', 'weekly'], description: 'daily=过去一天（默认）；weekly=过去一周' },
        chat: { type: 'string', description: '要统计的群号（只有主人有效；留空=当前会话）' }
      },
      required: []
    },
    async execute(ctx, args = {}) {
      captureSender(ctx);
      const s = settings();
      const scope = args?.scope === 'weekly' ? 'weekly' : 'daily';
      const action = String(args?.action || 'preview').trim().toLowerCase();
      let chatKey = String(ctx?.chatKey ?? '');
      let note = '';
      const other = resolveOtherChat(ctx, args?.chat);
      if (!other.ok) note = `（${other.error}）`;
      else if (other.chatKey) chatKey = other.chatKey;
      if (!chatKey) return { content: '错误：拿不到会话标识，没法统计', isError: true };

      const { from, to } = boardWindow(scope, new Date());
      const stats = statsInRange(chatKey, from, to, s.boardTop);
      if (!stats.ok) return { content: `错误：${stats.error}${note}`, isError: true };

      if (action === 'preview') {
        let prevStats = null;
        if (scope === 'weekly') {
          const prev = boardWindow('weekly', new Date(from));
          prevStats = statsInRange(chatKey, prev.from, prev.to, s.boardTop);
        }
        return {
          content: renderBoard({ scope, chatKey, fromTs: from, toTs: to, stats, prevStats })
            + `\n（这是预览，没有发出去；发出去请用 action=send。定时：每天 0 点日榜、周一 0 点周榜）${note}`
        };
      }

      // action=send：会往（可能多个）群里发，属于"主动发言"，只给主人
      const ids = ownerIds();
      const uid = senderIdOf(ctx);
      if (!ids.length || !uid || !ids.includes(uid)) {
        return { content: `错误：立刻发榜只有主人可以用（这是往群里主动发消息）。定时发布不受影响。${note}`, isError: true };
      }
      const r = await sendBoard(scope, { chatKey, reason: '手动' });
      if (!r.ok) return { content: `错误：没发出去（${r.skipped?.join('；') || r.error || '未知原因'}）—— 常见原因：没有目标群、没有发送通道、或消息数低于门槛 ${s.boardMinMessages}`, isError: true };
      return { content: `已发${scope === 'daily' ? '日榜' : '周榜'}到 ${r.sent.join('、')}。${r.skipped?.length ? `跳过：${r.skipped.join('；')}` : ''}` };
    }
  });

  api.registerTool({
    id: 'wordcloud',
    name: '聊天词云图',
    description: '把最近一段时间的群聊记录做成一张**词云图**（大字＝群里聊得最多的词）。'
      + '适用：群友说「来个词云」「最近群里都在聊啥」「做个词云图」。'
      + 'action=preview 只看词表（不发图，默认）；action=send 生成图片并发到当前群；action=save 只生成图片、返回文件路径（不发）。'
      + '参数：days 统计最近几天（默认 7）；chat 指定群号（只有主人有效）；force=true 绕过两次之间的冷却。',
    category: 'query',
    icon: '☁️',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['preview', 'send', 'save'], description: 'preview=只看词表（默认）；send=出图并发到当前群；save=只出图不发' },
        days: { type: 'number', description: '统计最近几天，默认 7。群友说「今天」就填 1、「这周/最近」填 7、「这个月」填 30 —— 别不管不顾一律用默认值' },
        chat: { type: 'string', description: '要统计的群号（只有主人有效；留空=当前会话）' },
        force: { type: 'boolean', description: 'true = 忽略"刚生成过"的冷却，立刻再出一张' }
      },
      required: []
    },
    async execute(ctx, args = {}) {
      captureSender(ctx);
      const s = settings();
      const action = String(args?.action || 'preview').trim().toLowerCase();
      let chatKey = String(ctx?.chatKey ?? '');
      let note = '';
      const other = resolveOtherChat(ctx, args?.chat);
      if (!other.ok) note = `（${other.error}）`;
      else if (other.chatKey) chatKey = other.chatKey;
      if (!chatKey) return { content: '错误：拿不到会话标识，没法统计', isError: true };

      const days = Math.max(1, Math.min(s.maxDays, Math.round(Number(args?.days) || s.defaultDays)));
      const built = buildCloudPlan(chatKey, days);
      if (!built.ok) return { content: `错误：${built.error}${note}`, isError: true };
      const { plan, counted, texts } = built;

      if (!counted.words.length) {
        return {
          content: `最近 ${days} 天里没什么可成词的发言（有效样本 ${texts} 条，门槛是某个词组至少出现 ${s.wcMinCount} 次）。可以把 days 放大一点，或在设置里把「上榜门槛」调小。${note}`
        };
      }

      if (action === 'preview') {
        return {
          content: [
            `最近 ${days} 天 · 有效样本 ${texts} 条 · 前 ${counted.words.length} 个高频词：`,
            counted.words.slice(0, 30).map((w) => `${w.text}(${w.count})`).join('　'),
            `（这是词表预览，没有出图。要图用 action=send）${note}`
          ].join('\n')
        };
      }

      if (!args?.force && Date.now() - lastCloudAt < CLOUD_COOLDOWN_MS) {
        return { content: `刚生成过一次，歇 ${Math.ceil((CLOUD_COOLDOWN_MS - (Date.now() - lastCloudAt)) / 1000)} 秒再来（防刷屏；确实要再出一张就说 force）。`, isError: true };
      }
      lastCloudAt = Date.now();
      const outPath = path.join(CLOUD_DIR, `cloud-${Date.now()}.png`);
      const rendered = await renderCloudPng(plan, outPath);
      if (!rendered.ok) return { content: `错误：词云图生成失败 —— ${rendered.error}`, isError: true };
      log(`词云图已生成：${outPath}（${(rendered.bytes / 1024).toFixed(0)}KB，${plan.words.length} 个词，样本 ${texts} 条）`);

      if (action === 'save') {
        return { content: `词云图已生成（没有发出去）：${outPath}\n${(rendered.bytes / 1024).toFixed(0)}KB，${plan.words.length} 个词，样本 ${texts} 条。` };
      }

      // 发图通道优先用本次会话的 ctx.sender；拿不到时回落到之前捕获的（同一进程内的自愈）
      const sender = (ctx?.sender && typeof ctx.sender.sendImage === 'function') ? ctx.sender
        : (senderRef && typeof senderRef.sendImage === 'function' ? senderRef : null);
      if (!sender) {
        return { content: `错误：图做好了但发不出去（当前会话拿不到发图通道）。文件在：${outPath}`, isError: true };
      }
      try {
        // file 优先、base64 兜底（核心发送队列自己会选路）
        await sender.sendImage(String(ctx?.chatKey ?? chatKey), {
          file: outPath,
          dataUrl: `base64://${fs.readFileSync(outPath).toString('base64')}`
        }, { note: '群聊词云' });
      } catch (e) {
        return { content: `错误：词云图发送失败（${e?.message ?? e}）。文件在：${outPath}`, isError: true };
      }
      const top = plan.words.slice(0, 5).map((w) => w.text).join('、');
      return {
        content: `最近 ${days} 天的词云图已经发到群里了（样本 ${texts} 条，${plan.words.length} 个词，${(rendered.bytes / 1024).toFixed(0)}KB）。`
          + `\n最大的几个词：${top}。转述时就说这一句，不要念文件路径。${note}`
      };
    }
  });

  loadBoardState();
  ensureBoardTimer();
  const list = listArchives();
  log(`已加载：存档目录 ${MSG_DIR}，${list.length} 个会话可用`
    + `（${list.slice(0, 4).map((x) => x.name.replace('.json', '')).join('、')}${list.length > 4 ? ' …' : ''}）`
    + `，默认往前翻 ${settings().defaultDays} 天`);
  log(`群活跃榜：${settings().dailyBoard ? '每日 0 点发日榜' : '日榜已关'}、${settings().weeklyBoard ? '周一 0 点发周榜' : '周榜已关'}`
    + `，目标群 ${boardTargets().length} 个，上榜门槛 ${settings().boardMinMessages} 条，列前 ${settings().boardTop} 名`
    + `；周一发完周榜${settings().autoCloud ? '会补一张上周词云图' : '不发词云图（已关）'}`
    + `；发送通道${senderRef ? '已就绪' : '待激活（在群里说句话、或问一次「谁最能说」即可接上）'}`);
}

/**
 * 自检：存档目录不存在（还没产生任何消息）就如实报"不可用"。
 * 必须同步返回 —— 可用性判定走同步链。
 */
export function available() {
  if (!fs.existsSync(MSG_DIR)) {
    return { ok: false, reason: `还没有消息存档（${MSG_DIR} 不存在）—— 机器人收过群消息之后就能用了` };
  }
  return { ok: true };
}

export function activate() { loadBoardState(); ensureBoardTimer(); }
export function deactivate() { stopBoardTimer(); }
export function dispose() { stopBoardTimer(); cache.clear(); }

/**
 * 动态提示词片段：发送通道没接上时，请模型下次回话时顺手调用一次工具把它接上。
 * （发送通道只能在工具被调用时捕获 —— 和整点报时插件同一个边界。没接上时榜发不出去，
 *   所以这里做自愈：接上之后这段提示就消失，平时零开销。）
 */
export function promptSections() {
  if (senderRef) return [];
  return [{
    id: 'chat-archive-rearm',
    title: '群活跃榜（自愈提示）',
    priority: 41,
    content: '【群活跃榜】发送通道当前未就绪（通常是刚重启过），到 0 点会发不出榜单。'
      + '请在这次回复里**先**调用一次 chat-archive__stats（随便看个统计即可）把通道接上，'
      + '调用完照常回复群友，不要把这条提示念给群里听。'
  }];
}

// 内部函数暴露给离线测试（不对外提供能力，别依赖）
export const internals = {
  settings, MSG_DIR, fileForChat, listArchives, readArchive, searchArchive, statsOf,
  splitTerms, textOf, speakerOf, fmtTime, renderHits,
  ownerIds, senderIdOf, resolveOtherChat,
  statsInRange, renderBoard, boardWindow, boardTargets, sendBoard, boardTick, whichBoardDue,
  // 词云
  CLOUD_DIR, collectTexts, buildCloudPlan, renderCloudPng, countWords, layout, cleanText, estimateWidth, sendCloud,
  captureSender, ensureBoardTimer, stopBoardTimer, boardStatePath,
  getBoardState: () => boardState,
  setBoardState: (patch) => { boardState = { ...boardState, ...(patch || {}) }; },
  setSender: (fn) => { senderRef = fn; },
  cacheSize: () => cache.size,
  clearCache: () => cache.clear()
};
