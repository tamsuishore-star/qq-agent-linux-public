// 空间互动的**节奏控制与历史记录**，落在磁盘上。
//
// ── 为什么节奏必须由代码管，不能交给提示词 ────────────────────────────────
// 「一天别点太多赞」「别连着评论」这种话，模型没有稳定的时间感：它每次被唤醒
// 只看得到本轮上下文，不记得自己 20 分钟前刚点过 7 个赞。所以配额只能落盘，
// 由代码硬拦，模型只负责"这一条我要不要理、评论写什么"。
//
// ── 三条规则，对应三个真实的社交风险 ─────────────────────────────────────
//   每小时上限    一轮扫下来从动态头点到尾 —— 好友那边会看到一串连着的赞，非常像机器
//   每日上限      半夜给人点一整个相册的赞，第二天被问"你是不是被盗号了"
//   最小间隔      真人是刷到一条点一条，不是 8 秒点 8 条
//
// ── 去重也要落盘 ────────────────────────────────────────────────────────
// 同一条说说重复点赞/重复评论是最容易被看穿的破绽（"你怎么评了两遍"）。
// 而且热重载会重新执行 setup —— 只存在内存里的话，每次改配置就全忘了。
//
// 存储位置与 qzone 技能同约定：<install>/data/Qzone/ 下，可用
// QQ_AGENT_DATA_DIR 覆盖（第二实例/便携版靠它区分）。写盘用临时文件 + rename，
// 避免写一半被读到。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib/ → 插件目录 → plugins/ → app 根（即 <install>/resources/app）
const APP_ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * 找**数据目录**。这里不能照抄 qzone 技能里那行 `path.join(APP_ROOT, 'data')`：
 *   · 安装版的应用根是 <install>/resources/app，而数据目录在 <install>/data
 *     （见 src/config.js 的 DATA_DIR）—— 直接拼 APP_ROOT 会在安装目录里
 *     凭空多出一个没人看的 resources/app/data。
 *   · 生产运行时进程里确实有 QQ_AGENT_DATA_DIR，但插件也可能被单独 import
 *     （自检脚本/测试），那时环境变量不存在，需要一个能自证的兜底。
 * 所以顺序是：环境变量（唯一权威）→ 往上找到真的放着 config.json 的那个 data/
 * → 都没有才退回 APP_ROOT/data 旁边的默认位置。
 * 判据用 config.json 而不是"目录存在"：data 下还有一堆别的目录，
 * 只看存在性会挑错兄弟目录。
 */
function resolveDataDir() {
  const explicit = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (explicit) return explicit;
  const installRoot = path.resolve(APP_ROOT, '..', '..');
  const looksLikeDataDir = (d) => {
    try { return fs.existsSync(path.join(d, 'config.json')); } catch { return false; }
  };
  for (const cand of [path.join(installRoot, 'data'), path.join(installRoot, 'data-2')]) {
    if (looksLikeDataDir(cand)) return cand;
  }
  return path.join(APP_ROOT, 'data');
}

const DATA_DIR = resolveDataDir();

const HOUR = 3600 * 1000;

export class SweepState {
  constructor({ dir } = {}) {
    this.dir = path.resolve(dir || path.join(DATA_DIR, 'Qzone'));
    this.file = path.join(this.dir, 'sweeper-state.json');
    this.data = this.#read();
  }

  #read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        // postId → 点赞时间戳（毫秒）
        liked: (raw?.liked && typeof raw.liked === 'object') ? raw.liked : {},
        // postId → 评论时间戳（毫秒）
        commented: (raw?.commented && typeof raw.commented === 'object') ? raw.commented : {},
        // 全部动作（点赞+评论）的时间戳数组，按天/小时配额就数它
        actions: Array.isArray(raw?.actions) ? raw.actions.map(Number).filter(Number.isFinite) : [],
        // 互动历史（给人看的：谁、哪条、说了什么）
        history: Array.isArray(raw?.history) ? raw.history : [],
        lastActionAt: Number(raw?.lastActionAt) || 0,
        lastScanAt: Number(raw?.lastScanAt) || 0,
        lastNudgeAt: Number(raw?.lastNudgeAt) || 0,
        failCount: Number(raw?.failCount) || 0
      };
    } catch {
      return { liked: {}, commented: {}, actions: [], history: [], lastActionAt: 0, lastScanAt: 0, lastNudgeAt: 0, failCount: 0 };
    }
  }

  #write() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);          // 原子写
      return true;
    } catch (e) {
      console.warn('[qzone-sweeper] 状态写入失败:', e?.message ?? e);
      return false;
    }
  }

  // ── 去重 ──────────────────────────────────────────────────────────────

  hasLiked(postId) { return Boolean(this.data.liked[String(postId)]); }
  hasCommented(postId) { return Boolean(this.data.commented[String(postId)]); }

  // ── 配额 ──────────────────────────────────────────────────────────────

  /** 清掉超过 7 天的动作记录，避免文件无限增长。 */
  #prune(now = Date.now()) {
    const keep = now - 7 * 24 * HOUR;
    const before = this.data.actions.length;
    this.data.actions = this.data.actions.filter((t) => t >= keep);
    // 评论/点赞去重表只保留 7 天内的，太老的说说本来也不会再被扫到
    for (const map of [this.data.liked, this.data.commented]) {
      for (const [k, v] of Object.entries(map)) if (Number(v) < keep) delete map[k];
    }
    if (this.data.history.length > 300) this.data.history = this.data.history.slice(-300);
    return before !== this.data.actions.length;
  }

  /** 今天的动作数（按本地自然日切，不是"最近 24 小时" —— 用户理解的是"今天"）。 */
  todayCount(now = Date.now()) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const since = d.getTime();
    return this.data.actions.filter((t) => t >= since).length;
  }

  /** 最近一小时内（滑动窗口）的动作数。 */
  hourCount(now = Date.now()) {
    const since = now - HOUR;
    return this.data.actions.filter((t) => t >= since).length;
  }

  todayLikeCount(now = Date.now()) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return this.data.history.filter((h) => h.kind === 'like' && Number(h.ts) >= d.getTime()).length;
  }

  todayCommentCount(now = Date.now()) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return this.data.history.filter((h) => h.kind === 'comment' && Number(h.ts) >= d.getTime()).length;
  }

  /**
   * 现在能不能动一下手？不能就给出**具体原因**和还要等多久。
   * 返回的 reason 会原样进工具回执 —— 模型看到"还要等 23 分钟"就不会胡乱重试。
   */
  canAct({ kind = 'like', dailyLikeLimit = 8, dailyCommentLimit = 3, hourlyLimit = 6, cooldownMinutes = 60 } = {}, now = Date.now()) {
    this.#prune(now);
    const fmt = (ms) => {
      const min = Math.ceil(ms / 60000);
      return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分钟` : `${min} 分钟`;
    };

    const cool = Math.max(0, Number(cooldownMinutes) || 0) * 60000;
    if (cool && this.data.lastActionAt && now - this.data.lastActionAt < cool) {
      return { ok: false, code: 'cooldown', waitMs: cool - (now - this.data.lastActionAt), reason: `距上一个动作只过了 ${Math.floor((now - this.data.lastActionAt) / 60000)} 分钟，还要等约 ${fmt(cool - (now - this.data.lastActionAt))}。` };
    }
    const hourly = Math.max(0, Number(hourlyLimit) || 0);
    if (hourly && this.hourCount(now) >= hourly) {
      return { ok: false, code: 'hourly', reason: `这一小时已经互动了 ${hourly} 次（上限 ${hourly}），下一小时再说。` };
    }
    if (kind === 'comment') {
      const lim = Math.max(0, Number(dailyCommentLimit) || 0);
      const used = this.todayCommentCount(now);
      if (lim && used >= lim) return { ok: false, code: 'daily-comment', reason: `今天已经评论了 ${used} 条（上限 ${lim}），明天再来。` };
    } else {
      const lim = Math.max(0, Number(dailyLikeLimit) || 0);
      const used = this.todayLikeCount(now);
      if (lim && used >= lim) return { ok: false, code: 'daily-like', reason: `今天已经点了 ${used} 个赞（上限 ${lim}），明天再来。` };
    }
    return { ok: true, code: null, reason: '' };
  }

  /** 记一次成功的动作。kind = 'like' | 'comment'。 */
  record({ kind, postId, targetUin = '', author = '', content = '' }) {
    const now = Date.now();
    if (kind === 'like') this.data.liked[String(postId)] = now;
    else if (kind === 'comment') this.data.commented[String(postId)] = now;
    this.data.actions.push(now);
    this.data.lastActionAt = now;
    this.data.history.push({
      ts: now,
      kind,
      postId: String(postId),
      targetUin: String(targetUin || ''),
      author: String(author || '').slice(0, 40),
      content: String(content || '').slice(0, 200)
    });
    this.#prune(now);
    return this.#write();
  }

  markScan() { this.data.lastScanAt = Date.now(); return this.#write(); }
  markNudge() { this.data.lastNudgeAt = Date.now(); return this.#write(); }
  markFail() { this.data.failCount = (this.data.failCount || 0) + 1; return this.#write(); }

  /** 最近 n 条互动记录（时间倒序）。 */
  recent(n = 5) {
    return [...this.data.history].sort((a, b) => b.ts - a.ts).slice(0, Math.max(0, n));
  }

  /** 给状态工具用的一份汇总。 */
  snapshot(cfg, now = Date.now()) {
    const like = this.canAct({ ...cfg, kind: 'like' }, now);
    const comment = this.canAct({ ...cfg, kind: 'comment' }, now);
    return {
      todayActions: this.todayCount(now),
      todayLikes: this.todayLikeCount(now),
      todayComments: this.todayCommentCount(now),
      hourActions: this.hourCount(now),
      lastActionAt: this.data.lastActionAt || null,
      lastScanAt: this.data.lastScanAt || null,
      canLike: like.ok,
      likeReason: like.reason || '',
      canComment: comment.ok,
      commentReason: comment.reason || ''
    };
  }
}
