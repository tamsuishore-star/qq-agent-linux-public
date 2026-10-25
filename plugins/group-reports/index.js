// 日报·周报·告警（确定性型 / plugins/）
//
// 上游是 0.2 的 src/daily-report.js + src/weekly-report.js + src/alerting.js。
// 0.4 把这三样都砍了（代码与文档里 0 命中），但它们本质是"定时 + 推送 + 模板拼字符串"，
// 正是 plugins/（确定性型）该干的事 —— 所以这里原样把能力搬回来，**不改核心一行**：
//
//   activate / deactivate   起停每分钟的检查定时器（到点才发，当天/当周各只发一次）
//   after-response 钩子     记下本轮是否报错（只入内存，不在钩子里发网络请求：
//                           钩子有 5 秒超时，推送留给定时器 —— 这点和记忆插件的取舍一致）
//   providers               reports.daily / weekly / alert / status，给 UI 或技能手动触发
//
// 数据全部来自本地文件（data/sessions/*.json + session-index-cache.json），
// 花钱统计复用核心的 model-prices（价格表、峰谷时段口径与用量页完全一致）。
// 报告是模板拼的，**不调模型**：0 token。
//
// 与 0.2 的差异（有意为之）：
//   · 窗口判定改为"扫会话文件 + 索引缓存做粗筛"（0.4 没有 sessions-index.json，
//     只有 session-index-cache.json，且它可能被裁剪，所以只用来跳过、不当真源）
//   · 配置来自插件设置（设置页可改），不再塞在 config.dailyReport 里
//   · 群聊纪要 /digest 与 /外号 不在这里（那是另一件事）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { resolveModelPrice, sumCostByTime } from '../../src/model-prices.js';

/** 出厂默认值（与 plugin.json 的 settings 保持一致，改一处要改两处）。
 *  ownerQq 出厂留空 —— 安装者自己在插件设置里填自己的号；
 *  发布前不要把任何真实 QQ 写进默认值（否则装上的人会把报告发到别人号上）。 */
const DEFAULTS = {
  enabled: true,
  ownerQq: '',
  dailyEnabled: true,
  dailyHour: 8,
  dailyMinute: 30,
  weeklyEnabled: true,
  weeklyWeekday: 1,
  weeklyHour: 9,
  weeklyMinute: 0,
  alertEnabled: true,
  alertErrorThreshold: 3,
  alertErrorWindowMin: 10,
  alertDisconnect: true,
  alertAuthError: true,
  alertCooldownMin: 30,
  checkIntervalSec: 60
};

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'session-index-cache.json');
const STATE_FILE = path.join(DATA_DIR, 'reports-state.json');

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let api = null;
let timer = null;
let bootTimer = null;
let ticking = false;
/** 本轮报错暂存（钩子只写这里，推送交给定时器）。 */
let pendingErrors = [];
/** 掉线探测连续失败次数。 */
let downStreak = 0;

// ── 设置与状态 ────────────────────────────────────────────────────────────

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadState() {
  const s = readJson(STATE_FILE, null);
  return {
    dailySentDay: '',
    weeklySentKey: '',
    alertedSessions: [],
    lastAlertAt: {},
    down: false,
    ...(s && typeof s === 'object' ? s : {})
  };
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    api?.warn?.('状态写入失败（不影响报告本身）：', error?.message ?? error);
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

const fmtNum = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
};
const f2 = (x) => (Math.round(Number(x) * 100) / 100).toFixed(2);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const pad2 = (n) => String(n).padStart(2, '0');
const dayKeyOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const mdOf = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const startOfDay = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const chatLabel = (chatKey) => {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return String(chatKey || '未知会话');
};

// ── 会话统计 ──────────────────────────────────────────────────────────────

/**
 * 取窗口 [start, end) 内的会话对象。
 * 索引缓存只用来**跳过**明确不在窗口内的文件（它可能被 keepFiles 裁剪，
 * 所以缓存里没有的 id 一律老实读文件，绝不能当成"不存在"）。
 */
function loadSessions(start, end) {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const cache = readJson(INDEX_CACHE_FILE, null);
  const byId = new Map();
  if (Array.isArray(cache?.entries)) {
    for (const e of cache.entries) if (e?.id) byId.set(String(e.id), e);
  }
  const out = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    const meta = byId.get(id);
    if (meta) {
      const t = Number(meta.startedAt) || 0;
      if (t && (t < start || t >= end)) continue;
    }
    const s = readJson(path.join(SESSIONS_DIR, f), null);
    if (!s) continue;
    const started = Number(s.startedAt) || 0;
    if (!started || started < start || started >= end) continue;
    out.push(s);
  }
  return out;
}

/** 把一次会话里的每轮模型调用摊平成计费行（与用量页同口径：raw.usage）。 */
function callRows(session) {
  const rows = [];
  const started = Number(session?.startedAt) || Date.now();
  for (const m of (session?.messages || [])) {
    const ru = m?.raw?.usage;
    if (!ru) continue;
    const promptTokens = Number(ru.prompt_tokens) || 0;
    const completionTokens = Number(ru.completion_tokens) || 0;
    if (!promptTokens && !completionTokens) continue;
    const cached = Number(
      ru.prompt_tokens_details?.cached_tokens
      ?? ru.prompt_cache_hit_tokens
      ?? ru.cached_tokens
      ?? 0
    ) || 0;
    rows.push({
      at: Number(m?.raw?.createdAt) || started,
      model: String(m?.raw?.model || session?.model || ''),
      promptTokens,
      completionTokens,
      cachedTokens: cached
    });
  }
  return rows;
}

/** 聚合一批会话：轮次、状态分布、token、按模型的峰谷花费、会话量最大的几个群。 */
function summarize(sessions) {
  const counts = { sent: 0, noreply: 0, error: 0, other: 0 };
  const byChat = new Map();
  const rowsByModel = new Map();
  let searchCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let rounds = 0;
  let sent = 0;

  for (const s of sessions) {
    searchCount += Number(s.webSearchCount) || 0;
    rounds += Number(s.rounds) || 0;
    sent += Number(s.outcome?.sent) || 0;
    const st = String(s.status || '');
    if (st === 'done') counts.sent += 1;
    else if (st === 'noreply') counts.noreply += 1;
    else if (st === 'error') counts.error += 1;
    else counts.other += 1;

    const key = String(s.chatKey || '');
    const cur = byChat.get(key) || { chatKey: key, sessions: 0, sent: 0 };
    cur.sessions += 1;
    cur.sent += Number(s.outcome?.sent) || 0;
    byChat.set(key, cur);

    const u = s.usage || {};
    promptTokens += Number(u.promptTokens) || 0;
    completionTokens += Number(u.completionTokens) || 0;
    cachedTokens += Number(u.cachedTokens) || 0;

    for (const r of callRows(s)) {
      const list = rowsByModel.get(r.model) || [];
      list.push(r);
      rowsByModel.set(r.model, list);
    }
  }

  let cfg = null;
  try { cfg = getConfig(); } catch { /* 配置没就绪就不估算花费 */ }
  let cost = 0;
  let peakCost = 0;
  let peakTokens = 0;
  let totalTokensForPeak = 0;
  let unpriced = 0;
  const models = [];
  for (const [model, rows] of rowsByModel) {
    models.push({ model, calls: rows.length });
    if (!cfg) continue;
    try {
      const price = resolveModelPrice(model, cfg);
      // 没配价的模型（source='unmatched' 或单价为 0）不能当成"免费"混进总额，
      // 否则报告里的花费会平白少一块 —— 单独计数，在报告里说明。
      if (!price || price.source === 'unmatched' || (!Number(price.in) && !Number(price.out))) {
        unpriced += rows.length;
        continue;
      }
      const r = sumCostByTime(rows, price);
      cost += r.cost;
      peakCost += r.peakCost;
      peakTokens += r.peakTokens;
      totalTokensForPeak += r.peakTokens + r.offPeakTokens;
    } catch { /* 单个模型算不出来不影响别的 */ }
  }
  models.sort((a, b) => b.calls - a.calls);

  return {
    sessions: sessions.length,
    counts,
    searchCount,
    rounds,
    sentMessages: sent,
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    cost,
    peakCost,
    peakTokens,
    totalTokensForPeak,
    unpricedCalls: unpriced,
    models,
    chats: [...byChat.values()].sort((a, b) => b.sessions - a.sessions)
  };
}

// ── 报告模板（纯拼字符串，禁调模型）──────────────────────────────────────

function renderDaily(summary, dayTs) {
  const d = new Date(dayTs);
  const L = [];
  L.push(`📊 昨日小报（${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_CN[d.getDay()]}）`);
  L.push('');
  L.push(`处理 ${summary.sessions} 轮：已回 ${summary.counts.sent} · 没接 ${summary.counts.noreply} · 出错 ${summary.counts.error}`
    + (summary.counts.other ? ` · 其他 ${summary.counts.other}` : ''));
  L.push(`token：输入 ${fmtNum(summary.promptTokens)} / 输出 ${fmtNum(summary.completionTokens)} / 缓存命中 ${fmtNum(summary.cachedTokens)}（${pct(summary.cachedTokens, summary.promptTokens)}%）`);
  L.push(`花费估算：¥${f2(summary.cost)}${summary.peakCost ? `（高峰 ¥${f2(summary.peakCost)}，占 ${pct(summary.peakCost, summary.cost)}%）` : ''}`
    + (summary.unpricedCalls ? `（另有 ${summary.unpricedCalls} 次调用没配价，未计入）` : ''));
  if (summary.peakTokens || summary.totalTokensForPeak) {
    L.push(`高峰时段 token 占 ${pct(summary.peakTokens, summary.totalTokensForPeak)}%`);
  }
  if (summary.searchCount) L.push(`联网搜索 ${summary.searchCount} 次（不计费）`);
  if (summary.sentMessages) L.push(`发出消息 ${summary.sentMessages} 条`);
  if (summary.chats.length) {
    const top = summary.chats.slice(0, 3)
      .map((c) => `${chatLabel(c.chatKey)} ${c.sessions} 轮`)
      .join(' · ');
    L.push(`最活跃：${top}`);
  }
  if (summary.models.length) {
    L.push(`模型：${summary.models.slice(0, 3).map((m) => `${m.model || '未知'}×${m.calls}`).join(' · ')}`);
  }
  L.push('');
  const sum = [];
  if (summary.counts.error > 0) sum.push(`出了 ${summary.counts.error} 次错${summary.counts.error >= 3 ? '，有点多，可能中转在抽风' : '，可翻会话看原因'}`);
  if (summary.counts.sent === 0 && summary.counts.noreply > 0) sum.push('昨天一句话没发，光潜水了');
  else if (summary.counts.sent > 0) sum.push(`聊了 ${summary.counts.sent} 轮，${summary.counts.noreply <= summary.counts.sent ? '还算活跃' : '多数时候在看'}`);
  if (summary.cost && pct(summary.peakCost, summary.cost) >= 30) sum.push('不少钱烧在高峰时段，肉疼');
  if (summary.cacheHitRate > 0.3) sum.push('缓存命中不错，省了一些');
  if (!sum.length) sum.push('平平淡淡的一天');
  L.push(sum.join('；') + '。');
  return L.join('\n');
}

function renderWeekly(summary, start, end) {
  const L = [];
  L.push(`📈 本周小报（${mdOf(start)} ~ ${mdOf(end - 1)}）`);
  L.push('');
  L.push(`处理 ${summary.sessions} 轮：已回 ${summary.counts.sent} · 没接 ${summary.counts.noreply} · 出错 ${summary.counts.error}`
    + (summary.counts.other ? ` · 其他 ${summary.counts.other}` : ''));
  L.push(`token：输入 ${fmtNum(summary.promptTokens)} / 输出 ${fmtNum(summary.completionTokens)} / 缓存命中 ${pct(summary.cachedTokens, summary.promptTokens)}%`);
  L.push(`花费估算：¥${f2(summary.cost)}${summary.peakCost ? `（高峰 ¥${f2(summary.peakCost)}，占 ${pct(summary.peakCost, summary.cost)}%）` : ''}`
    + (summary.unpricedCalls ? `（另有 ${summary.unpricedCalls} 次调用没配价，未计入）` : ''));
  if (summary.sentMessages) L.push(`发出消息 ${summary.sentMessages} 条 · 平均每轮 ${(summary.sentMessages / Math.max(1, summary.counts.sent)).toFixed(1)} 条`);
  if (summary.searchCount) L.push(`联网搜索 ${summary.searchCount} 次`);
  if (summary.chats.length) {
    L.push('');
    L.push('分会话：');
    for (const c of summary.chats.slice(0, 6)) {
      L.push(`· ${chatLabel(c.chatKey)}：${c.sessions} 轮 · 发 ${c.sent} 条`);
    }
  }
  if (summary.models.length) {
    L.push('');
    L.push(`模型：${summary.models.slice(0, 3).map((m) => `${m.model || '未知'}×${m.calls}`).join(' · ')}`);
  }
  const days = Math.max(1, Math.round((end - start) / 86400000));
  L.push('');
  L.push(`日均 ${(summary.sessions / days).toFixed(1)} 轮 · ¥${f2(summary.cost / days)}`);
  return L.join('\n');
}

// ── OneBot 推送（私聊主人）───────────────────────────────────────────────

function onebotEndpoint() {
  let cfg = null;
  try { cfg = getConfig(); } catch { /* 读不到就用默认本地口 */ }
  const httpUrl = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.snowluma?.httpAccessToken || cfg?.snowluma?.accessToken || '');
  return { httpUrl, token };
}

async function onebotCall(action, params = {}, timeoutMs = 10000) {
  const { httpUrl, token } = onebotEndpoint();
  const doFetch = (api && typeof api.fetch === 'function' && api.fetch !== globalThis.fetch)
    ? api.fetch : globalThis.fetch;
  const res = await doFetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`OneBot ${action} HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'ok' && body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败：retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
  }
  return body.data;
}

/** 私聊主人一条纯文本。ownerQq 留空 → 只写日志（本地调试不打扰）。 */
async function push(text, { reason = 'report' } = {}) {
  const s = settings();
  const owner = String(s.ownerQq || '').trim();
  if (!owner) {
    api?.log?.(`（未配置主人 QQ，${reason} 只记录在日志）\n${text}`);
    return { ok: false, skipped: 'no-owner', text };
  }
  try {
    await onebotCall('send_private_msg', {
      user_id: Number(owner),
      message: [{ type: 'text', data: { text } }]
    });
    api?.log?.(`已私聊主人（${reason}）：${text.split('\n')[0]}`);
    return { ok: true, text };
  } catch (error) {
    api?.warn?.(`私聊主人失败（${reason}）：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error), text };
  }
}

// ── 到点判定 ──────────────────────────────────────────────────────────────

const timePassed = (now, hour, minute) => {
  const h = now.getHours();
  const m = now.getMinutes();
  return h > hour || (h === hour && m >= minute);
};

const inCooldown = (state, kind, now, cooldownMin) => {
  const last = Number(state.lastAlertAt?.[kind]) || 0;
  return last > 0 && now - last < cooldownMin * 60000;
};

const markAlert = (state, kind, now) => {
  state.lastAlertAt = { ...(state.lastAlertAt || {}), [kind]: now };
  saveState(state);
};

// ── 告警 ──────────────────────────────────────────────────────────────────

const AUTH_RE = /401|403|unauthorized|invalid api key|authentication|api key|鉴权|令牌|token 无效/i;

async function alertOnce(kind, text, state, now) {
  const s = settings();
  if (s.alertEnabled === false) return false;
  const cooldown = Math.max(1, Number(s.alertCooldownMin) || 30);
  if (inCooldown(state, kind, now, cooldown)) return false;
  markAlert(state, kind, now);
  await push(text, { reason: `告警:${kind}` });
  return true;
}

export async function alertError(errorText, { chatKey = '', sessionId = '' } = {}) {
  const s = settings();
  if (s.alertEnabled === false || s.alertAuthError === false) return false;
  const text = String(errorText || '');
  if (!AUTH_RE.test(text)) return false;
  const state = loadState();
  const body = [
    '⚠️ 小鲸鱼报警：模型鉴权/额度出问题了',
    '',
    `会话：${chatKey ? chatLabel(chatKey) : '未知'}${sessionId ? ` · ${sessionId}` : ''}`,
    `报错：${text.slice(0, 300)}`,
    '',
    '多半是 API key 过期/欠费/中转挂了，去设置页换个 key 或换个中转。'
  ].join('\n');
  return alertOnce('auth', body, state, Date.now());
}

/** 扫最近窗口内的出错会话，达阈值就告警（一次一条，冷却期内不重复）。 */
async function checkSessionErrors(state, now) {
  const s = settings();
  if (s.alertEnabled === false) return;
  const windowMs = Math.max(1, Number(s.alertErrorWindowMin) || 10) * 60000;
  const threshold = Math.max(1, Number(s.alertErrorThreshold) || 3);
  const alerted = new Set(state.alertedSessions || []);
  const recent = loadSessions(now - windowMs, now + 60000);
  const fresh = recent.filter((x) => String(x.status) === 'error' && !alerted.has(String(x.id)));
  if (!fresh.length) return;

  // 鉴权类先单独、立刻告警（key 过期不该等到凑够 3 次）
  for (const x of fresh) {
    const msg = String(x.error || x.errorMessage || '');
    if (msg && AUTH_RE.test(msg)) {
      await alertError(msg, { chatKey: x.chatKey, sessionId: x.id });
      break;
    }
  }

  if (fresh.length >= threshold) {
    const lines = fresh.slice(0, 5).map((x) => {
      const when = new Date(Number(x.endedAt) || Number(x.startedAt) || now);
      return `· ${pad2(when.getHours())}:${pad2(when.getMinutes())} ${chatLabel(x.chatKey)}：${String(x.error || '（无错误详情）').slice(0, 120)}`;
    });
    const body = [
      `⚠️ 小鲸鱼报警：${Math.max(1, Math.round(windowMs / 60000))} 分钟内出了 ${fresh.length} 次错`,
      '',
      ...lines,
      fresh.length > 5 ? `· …还有 ${fresh.length - 5} 次` : '',
      '',
      '去会话页看完整报错（多半是模型端点/网络）。'
    ].filter(Boolean).join('\n');
    await alertOnce('errors', body, state, now);
  }

  // 记下已告警过的会话，防重复（只留最近 200 条）
  state.alertedSessions = [...new Set([...(state.alertedSessions || []), ...fresh.map((x) => String(x.id))])].slice(-200);
  saveState(state);
}

/** 探活 OneBot（SnowLuma）：连续 3 次失败 = 掉线，恢复后再发一条。 */
async function checkOnebotHealth(state, now) {
  const s = settings();
  if (s.alertEnabled === false || s.alertDisconnect === false) return;
  let alive = false;
  let who = '';
  try {
    const info = await onebotCall('get_login_info', {}, 5000);
    who = info?.nickname ? `${info.nickname}（${info.user_id}）` : '';
    alive = true;
  } catch { alive = false; }

  if (alive) {
    downStreak = 0;
    if (state.down) {
      state.down = false;
      saveState(state);
      await push(`✅ 小鲸鱼回来了：OneBot 已连上${who ? `（${who}）` : ''}。`, { reason: '恢复' });
    }
    return;
  }

  downStreak += 1;
  if (downStreak < 3 || state.down) return;
  state.down = true;
  saveState(state);
  await alertOnce('disconnect', [
    '⚠️ 小鲸鱼报警：OneBot 掉线了',
    '',
    `连续 ${downStreak} 次探活失败（${onebotEndpoint().httpUrl}）。`,
    '机器人现在收不到消息、也发不出去。多半是 SnowLuma 没启动或端口被占。'
  ].join('\n'), state, now);
}

// ── 定时检查（每分钟）────────────────────────────────────────────────────

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = settings();
    if (s.enabled === false) return;
    const now = Date.now();
    const d = new Date(now);
    const state = loadState();
    const todayKey = dayKeyOf(now);

    // ① 日报（统计昨天）
    if (s.dailyEnabled !== false && state.dailySentDay !== todayKey
      && timePassed(d, Math.min(23, Math.max(0, Number(s.dailyHour) || 0)), Math.min(59, Math.max(0, Number(s.dailyMinute) || 0)))) {
      const start = startOfDay(now - 86400000);
      const end = startOfDay(now);
      const summary = summarize(loadSessions(start, end));
      state.dailySentDay = todayKey;
      saveState(state);
      if (summary.sessions) {
        await push(renderDaily(summary, start), { reason: '日报' });
      } else {
        api?.log?.('日报：昨天没有任何会话，跳过（不打扰）');
      }
    }

    // ② 周报（最近 7 个自然日）
    if (s.weeklyEnabled !== false) {
      const dueWeekday = Math.min(6, Math.max(0, Number(s.weeklyWeekday) || 0));
      const weekKey = `${todayKey}#${dueWeekday}`;
      if (d.getDay() === dueWeekday && state.weeklySentKey !== weekKey
        && timePassed(d, Math.min(23, Math.max(0, Number(s.weeklyHour) || 0)), Math.min(59, Math.max(0, Number(s.weeklyMinute) || 0)))) {
        const end = startOfDay(now);
        const start = end - 7 * 86400000;
        const summary = summarize(loadSessions(start, end));
        state.weeklySentKey = weekKey;
        saveState(state);
        if (summary.sessions) await push(renderWeekly(summary, start, end), { reason: '周报' });
        else api?.log?.('周报：这一周没有任何会话，跳过');
      }
    }

    // ③ 告警
    if (s.alertEnabled !== false) {
      if (pendingErrors.length) {
        const list = pendingErrors;
        pendingErrors = [];
        for (const e of list) await alertError(e.error, e);
      }
      await checkSessionErrors(state, now);
      await checkOnebotHealth(loadState(), now);
    }
  } catch (error) {
    api?.warn?.('检查出错（不影响主流程）：', error?.message ?? error);
  } finally {
    ticking = false;
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
}

/** 生效：起每分钟检查。首跑延迟 10 秒，别和启动抢 IO。 */
export function activate() {
  const s = settings();
  if (s.enabled === false) {
    api?.log?.('日报·周报·告警：设置里是关闭状态，不启动定时器');
    return;
  }
  const everySec = Math.max(15, Number(s.checkIntervalSec) || 60);
  timer = setInterval(() => { tick().catch(() => {}); }, everySec * 1000);
  timer.unref?.();
  bootTimer = setTimeout(() => { tick().catch(() => {}); }, 10000);
  bootTimer.unref?.();
  const hhmm = (h, m) => `${pad2(h)}:${pad2(m)}`;
  api?.log?.(`已启用：日报 ${hhmm(s.dailyHour, s.dailyMinute)} · 周报 ${WEEKDAY_CN[s.weeklyWeekday] || '?'} ${hhmm(s.weeklyHour, s.weeklyMinute)}`
    + ` · 主人 ${s.ownerQq || '（未设置）'} · 检查间隔 ${everySec} 秒`);
}

export function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

/** 生效状态：只反映插件开关（能力/钩子是否被调用由核心的启用状态决定）。 */
export function available() {
  return settings().enabled !== false;
}

// ── 钩子：只记账，不发网络请求（钩子有 5 秒超时）──────────────────────────

export const hooks = {
  async 'after-response'(ctx = {}) {
    const s = settings();
    if (s.enabled === false || s.alertEnabled === false) return;
    try {
      const session = ctx.session || {};
      const status = String(session.status || '');
      const error = String(session.error || session.errorMessage || '');
      if (status === 'error' && error) {
        pendingErrors.push({ error, chatKey: String(ctx.chatKey || session.chatKey || ''), sessionId: String(session.id || '') });
        if (pendingErrors.length > 20) pendingErrors = pendingErrors.slice(-20);
      }
    } catch { /* 记账失败无所谓 */ }
  }
};

// ── 能力：手动触发（UI / 技能 / 排查）────────────────────────────────────

export const providers = {
  /** 立刻生成一份日报；send=true 时同时私聊主人。 */
  'reports.daily': async (args = {}) => {
    try {
      const now = Date.now();
      const start = startOfDay(now - 86400000);
      const end = startOfDay(now);
      const summary = summarize(loadSessions(start, end));
      const text = summary.sessions ? renderDaily(summary, start)
        : `📊 昨日小报（${mdOf(start)}）：昨天一次会话都没有。`;
      const res = args?.send ? await push(text, { reason: '日报(手动)' }) : { ok: true, text };
      return { ok: true, text, sent: Boolean(res.ok), stats: { sessions: summary.sessions, cost: summary.cost } };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  /** 立刻生成一份周报；send=true 时同时私聊主人。 */
  'reports.weekly': async (args = {}) => {
    try {
      const end = startOfDay(Date.now());
      const start = end - 7 * 86400000;
      const summary = summarize(loadSessions(start, end));
      const text = summary.sessions ? renderWeekly(summary, start, end)
        : `📈 本周小报（${mdOf(start)} ~ ${mdOf(end - 1)}）：这一周一次会话都没有。`;
      const res = args?.send ? await push(text, { reason: '周报(手动)' }) : { ok: true, text };
      return { ok: true, text, sent: Boolean(res.ok), stats: { sessions: summary.sessions, cost: summary.cost } };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  /** 手动发一条告警（排查推送通路用）。 */
  'reports.alert': async (args = {}) => {
    const text = String(args?.text || '⚠️ 这是一条测试告警（来自插件报告中心）。');
    const res = await push(text, { reason: '告警(手动)' });
    return { ok: Boolean(res.ok), ...res };
  },

  /** 状态：设置、状态文件、OneBot 探活。 */
  'reports.status': async () => {
    const state = loadState();
    let alive = false;
    let who = '';
    try {
      const info = await onebotCall('get_login_info', {}, 4000);
      alive = true;
      who = info?.nickname ? `${info.nickname}（${info.user_id}）` : '';
    } catch { alive = false; }
    return {
      ok: true,
      settings: settings(),
      state,
      onebot: { alive, who, endpoint: onebotEndpoint().httpUrl, downStreak },
      now: new Date().toISOString()
    };
  }
};
