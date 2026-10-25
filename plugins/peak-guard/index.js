// peak-guard —— DeepSeek 高峰期智能节流（确定性插件）
//
// 定位：在"是否要为一个群聊排定一次模型会话"这个决策点上做预算控制，
// 而不是等模型被调用后再省。核心在 Orchestrator.onIncoming 里查询 `reply.gate`，
// 返回 { allow:false } 时只把消息标已读、不建会话、不调模型。
//
// 判定依据（全部是本地可观测/可配置的，不假装知道 DeepSeek 服务器负载）：
//   · 用户配置的高峰时段（本地时区）
//   · 当前模式：off / smart / save / strict
//   · 每群每分钟、全局每分钟的调用预算（滑动分钟桶）
//   · @ 机器人、命令消息、私聊可配置豁免
//
// 另外提供 `llm.request-params`：在 save/strict 模式下把 max_tokens 压到上限，
// 减少长回复的 output token；不改变模型、不改变供应商。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const PLUGIN_ID = 'peak-guard';
const STATE_FILE = path.join(DATA_DIR, 'peak-guard.json');
const MODES = new Set(['off', 'smart', 'save', 'strict']);

let api = null;
const stats = {
  allowed: 0, denied: 0, exemptAt: 0, exemptCommand: 0, exemptPrivate: 0,
  lastDeniedAt: 0, lastReason: '', lastChat: '', since: Date.now(), autoTriggers: 0
};
const buckets = new Map(); // key -> { minute, count }
const feedback = [];       // 最近请求结果（有界），用于 429/延迟自动升压
const auto = { until: 0, reason: '' };

const cfg = () => {
  try { return (typeof api?.config === 'function' ? api.config() : null) || {}; }
  catch { return {}; }
};
const log = (m) => { try { api?.log?.(`[${PLUGIN_ID}] ${m}`); } catch { /* ignore */ } };
const num = (v, d, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(Math.max(n, min), max);
};

/** 解析 "9-12,14-18"（本地小时，支持跨夜如 22-2）。 */
export function parseHours(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[,，;；\s]+/)) {
    const m = part.match(/^(\d{1,2})\s*[-~]\s*(\d{1,2})$/);
    if (!m) continue;
    const a = Number(m[1]); const b = Number(m[2]);
    if (a < 0 || a > 23 || b < 0 || b > 23) continue;
    out.push([a, b]);
  }
  return out;
}

export function inPeakHours(raw, hour = new Date().getHours()) {
  for (const [a, b] of parseHours(raw)) {
    if (a === b) continue;
    if (a < b) { if (hour >= a && hour < b) return true; }
    else if (hour >= a || hour < b) return true; // 跨夜
  }
  return false;
}

function currentMode() {
  const m = String(cfg().mode || 'smart');
  return MODES.has(m) ? m : 'smart';
}

/** 当前是否处于"压力"：自动观测到 429/慢请求/高错误率，或用户配置的高峰时段。 */
function pressureNow() {
  const s = cfg();
  const mode = currentMode();
  if (mode === 'off') return false;
  if (s.autoPressure !== false && Date.now() < auto.until) return true;
  if (mode === 'strict') return true;
  return inPeakHours(s.peakHours ?? '9-12,14-18');
}

/**
 * 观测一次模型请求结果。429/503、窗口内错误率或平均延迟超阈值时，
 * 把状态提升为"压力"并保持 holdSec 秒（滞回，避免抖动）。
 */
export function observe(payload = {}) {
  const s = cfg();
  if (s.enabled === false || s.autoPressure === false) return;
  const now = Date.now();
  const winMs = num(s.windowSec, 300, 30, 3600) * 1000;
  const holdMs = num(s.holdSec, 300, 30, 3600) * 1000;
  feedback.push({
    ts: now,
    ok: payload.ok !== false,
    status: Number(payload.status) || 0,
    latencyMs: Number(payload.latencyMs) || 0
  });
  while (feedback.length > 100) feedback.shift();
  while (feedback.length && now - feedback[0].ts > winMs) feedback.shift();

  let reason = '';
  if (payload.status === 429 || payload.status === 503) reason = `HTTP ${payload.status}`;
  else if (feedback.length >= 3) {
    const errs = feedback.filter((f) => !f.ok || f.status >= 500).length;
    const rate = (errs / feedback.length) * 100;
    const avg = feedback.reduce((n, f) => n + f.latencyMs, 0) / feedback.length;
    const rateLimit = num(s.errorRatePct, 30, 1, 100);
    const slowLimit = num(s.slowMs, 15000, 1000, 300000);
    if (rate >= rateLimit) reason = `错误率 ${rate.toFixed(0)}%`;
    else if (avg >= slowLimit) reason = `平均延迟 ${Math.round(avg)}ms`;
  }
  if (!reason) return;
  auto.until = now + holdMs;
  auto.reason = reason;
  stats.autoTriggers += 1;
  if (s.debugLog === true) log(`自动升压：${reason}，保持 ${Math.round(holdMs / 1000)}s`);
}

function take(key, limit) {
  const minute = Math.floor(Date.now() / 60000);
  let b = buckets.get(key);
  if (!b || b.minute !== minute) { b = { minute, count: 0 }; buckets.set(key, b); }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

const limits = (mode) => (mode === 'strict'
  ? { group: 2, global: 6 }
  : mode === 'save' ? { group: 4, global: 12 } : { group: 6, global: 20 });

/**
 * 核心在排会话前调用。必须同步返回（Orchestrator.onIncoming 是同步流程）。
 * @param {{chatKey:string,isPrivate:boolean,atMe:boolean,isCommand:boolean}} ctx
 */
export function gate(ctx = {}) {
  const s = cfg();
  if (s.enabled === false) return { allow: true, reason: 'disabled' };
  const mode = currentMode();
  if (mode === 'off') return { allow: true, reason: 'mode-off' };
  if (s.onlyGroups !== false && ctx.isPrivate) {
    stats.exemptPrivate += 1;
    return { allow: true, reason: 'private-exempt' };
  }
  if (s.exemptAt !== false && ctx.atMe) {
    stats.exemptAt += 1;
    return { allow: true, reason: 'at-exempt' };
  }
  if (s.exemptCommands !== false && ctx.isCommand) {
    stats.exemptCommand += 1;
    return { allow: true, reason: 'command-exempt' };
  }
  if (!pressureNow()) { stats.allowed += 1; return { allow: true, reason: 'normal' }; }

  const lim = limits(mode);
  const groupLimit = num(s.groupPerMin, lim.group, 1, 60);
  const globalLimit = num(s.globalPerMin, lim.global, 1, 200);
  const chatKey = String(ctx.chatKey || 'unknown');
  if (!take(`g:${chatKey}`, groupLimit)) {
    return deny(chatKey, `群聊每分钟预算 ${groupLimit} 已用完（${mode}）`);
  }
  if (!take('global', globalLimit)) {
    return deny(chatKey, `全局每分钟预算 ${globalLimit} 已用完（${mode}）`);
  }
  stats.allowed += 1;
  return { allow: true, reason: 'budget-ok' };
}

function deny(chatKey, reason) {
  stats.denied += 1;
  stats.lastDeniedAt = Date.now();
  stats.lastReason = reason;
  stats.lastChat = chatKey;
  if (cfg().debugLog === true) log(`拦截 ${chatKey}：${reason}`);
  return { allow: false, reason, silent: true, mode: currentMode() };
}

export const providers = {
  'reply.gate': (ctx) => gate(ctx),
  'llm.request-feedback': (payload) => observe(payload),
  // save/strict 下限制输出长度；normal 不改请求，避免影响正常回复质量。
  'llm.request-params': ({ body } = {}) => {
    const s = cfg();
    const mode = currentMode();
    if ((mode === 'save' || mode === 'strict') && pressureNow()) {
      const cap = num(s.maxOutputTokens, 500, 100, 4000);
      if (!body.max_tokens || body.max_tokens > cap) body.max_tokens = cap;
    }
    return { body };
  },
  'peak-guard.status': () => ({
    mode: currentMode(),
    pressure: pressureNow(),
    autoUntil: auto.until ? new Date(auto.until).toLocaleString('zh-CN', { hour12: false }) : '',
    autoReason: auto.reason,
    recentRequests: feedback.length,
    recent429: feedback.filter((f) => f.status === 429 || f.status === 503).length,
    peakHours: String(cfg().peakHours ?? '9-12,14-18'),
    limits: limits(currentMode()),
    ...stats,
    lastDenied: stats.lastDeniedAt ? new Date(stats.lastDeniedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  })
};

export function setup(skillApi) {
  api = skillApi;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (j && typeof j === 'object') Object.assign(stats, j.stats || {});
    }
  } catch { /* 状态文件坏了不影响节流 */ }
}

export function available() { return { ok: true }; }

export function activate() {
  log(`已启用（mode=${currentMode()}，peakHours=${cfg().peakHours ?? '9-12,14-18'}）`);
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), stats }, null, 1));
  } catch { /* ignore */ }
}

export function deactivate() { /* 无监听器可摘 */ }

export const internals = {
  stats, buckets, feedback, auto, parseHours, inPeakHours, gate, observe, limits,
  reset() { buckets.clear(); feedback.length = 0; auto.until = 0; auto.reason = ''; }
};
