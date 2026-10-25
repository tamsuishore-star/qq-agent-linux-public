// 发空间的节奏控制与历史记录。
//
// 用户的要求是"一周发个两三次"。这句话要落到代码里得拆成三条可执行的规则：
//   1. 周配额：最近 7 天内最多 3 条（可配）
//   2. 最小间隔：两条之间至少隔 N 天（默认 2 天）—— 防止"周一连发三条凑数"
//   3. 冷却：发完至少等 H 小时才允许下一次（默认 18 小时）
//
// 为什么必须做成硬约束而不是"提示词里劝"：
// 模型对"频率别太高"这种模糊表述没有稳定的时间感，而且它每次被唤醒都只看得到
// 当轮上下文，不记得自己昨天刚发过。所以节奏必须落在**磁盘上**，由代码判断，
// 模型只负责"今天该发的话，写什么内容"。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..', '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');

const DAY = 24 * 3600 * 1000;

/** 状态文件路径（与 music 技能的归档同思路，放 data 下，不进提示词背景）。 */
export class QzoneState {
  constructor({ dir } = {}) {
    this.dir = path.resolve(dir || path.join(DATA_DIR, 'Qzone'));
    this.file = path.join(this.dir, 'state.json');
    this.data = this.#read();
  }

  #read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        posts: Array.isArray(raw?.posts) ? raw.posts : [],
        lastAttempt: Number(raw?.lastAttempt) || 0
      };
    } catch {
      return { posts: [], lastAttempt: 0 };   // 没发过 / 首次运行
    }
  }

  #write() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);   // 原子写，避免写一半被读到
      return true;
    } catch (e) {
      console.warn('[qzone] 状态写入失败:', e?.message ?? e);
      return false;
    }
  }

  /**
   * 最近 n 天的发布记录（时间倒序）。
   * @param {boolean} countedOnly 只要"计入配额"的那些（强制发的测试帖不算）
   */
  recent(days = 7, countedOnly = false) {
    const since = Date.now() - days * DAY;
    return this.data.posts
      .filter((p) => Number(p.ts) >= since)
      .filter((p) => !countedOnly || p.counted !== false)
      .sort((a, b) => b.ts - a.ts);
  }

  /** 全部历史（时间倒序），给"查发过的"用。 */
  history(limit = 20) {
    return [...this.data.posts].sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, limit));
  }

  /**
   * 最近发过的标题，用于让模型避开重复选题。
   * 这里连强制发的也算 —— 测试帖虽然不占配额，但内容还是发出去过了，不该重复。
   */
  recentTopics(n = 8) {
    return this.history(n).map((p) => p.title).filter(Boolean);
  }

  /**
   * 现在能不能发？不能的话给出原因和下次可发时间。
   *
   * ⚠️ 只有"自动发"（counted !== false）才受这里的三条限制约束。
   * 用户**明确要求**发的那条走 forced 通道，不查这里 —— 否则你想手动测一次
   * 都得等两天，功能没法调试。安全闸门（时政/隐私）不区分来源，一律照查。
   *
   * @returns {{allowed:boolean, reason:string, nextAllowedAt:number|null,
   *            weekCount:number, maxPerWeek:number, hoursSinceLast:number|null}}
   */
  canPost({ maxPerWeek = 3, minGapDays = 2, cooldownHours = 18 } = {}) {
    const now = Date.now();
    const week = this.recent(7, true);            // 只数计入配额的
    const lastAuto = this.recent(7 * 52, true)[0] || null;   // 最近一条"计入配额"的
    const countedTotal = this.data.posts.filter((p) => p.counted !== false).length;
    const hoursSinceLast = lastAuto ? (now - Number(lastAuto.ts)) / 3600000 : null;

    const base = { weekCount: week.length, maxPerWeek, hoursSinceLast, countedTotal };
    const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

    // 1) 周配额
    if (week.length >= maxPerWeek) {
      // 配额恢复时间 = 本周最早那条 + 7 天
      const oldest = week[week.length - 1];
      const next = Number(oldest.ts) + 7 * DAY;
      return { ...base, allowed: false, nextAllowedAt: next, reason: `本周已发 ${week.length} 条（上限 ${maxPerWeek}），${fmt(next)} 之后才能再发。` };
    }

    if (lastAuto) {
      // 2) 最小间隔
      const gapMs = minGapDays * DAY;
      if (now - Number(lastAuto.ts) < gapMs) {
        const next = Number(lastAuto.ts) + gapMs;
        return { ...base, allowed: false, nextAllowedAt: next, reason: `距上一条只过了 ${hoursSinceLast.toFixed(1)} 小时，要求至少间隔 ${minGapDays} 天，${fmt(next)} 之后才能再发。` };
      }
      // 3) 冷却
      if (hoursSinceLast < cooldownHours) {
        const next = Number(lastAuto.ts) + cooldownHours * 3600000;
        return { ...base, allowed: false, nextAllowedAt: next, reason: `距上一条只过了 ${hoursSinceLast.toFixed(1)} 小时，冷却 ${cooldownHours} 小时，${fmt(next)} 之后才能再发。` };
      }
    }

    return { ...base, allowed: true, nextAllowedAt: null, reason: '' };
  }

  /**
   * 记一次成功发布。
   * @param {boolean} counted false = 用户强制要求发的测试帖，不占周配额也不触发冷却
   */
  recordPost({ content, title = '', tid = null, source = '', mood = '', counted = true, image = '', visibility = '' }) {
    this.data.posts.push({
      ts: Date.now(),
      content: String(content || '').slice(0, 500),
      title: String(title || '').slice(0, 120),
      tid: tid != null ? String(tid) : null,
      source: String(source || ''),
      mood: String(mood || ''),
      image: String(image || ''),
      visibility: String(visibility || ''),
      counted: counted !== false
    });
    // 只留最近 200 条，避免文件无限增长
    if (this.data.posts.length > 200) this.data.posts = this.data.posts.slice(-200);
    return this.#write();
  }

  /** 记一次尝试（成功或失败），用于诊断。 */
  markAttempt() {
    this.data.lastAttempt = Date.now();
    return this.#write();
  }
}