// 热点抓取：给"发空间"提供选题素材。
//
// ── 为什么不用热搜榜，改用综合热门 ──
// 实测（2026-09-30）B站各接口的稳定性差别很大，连续调用 3 次的结果：
//   · x/web-interface/ranking/v2?rid=4    → -352 -352 -352   （风控，不可用）
//   · x/web-interface/ranking/v2?rid=119  →    0 -352 -352   （时好时坏）
//   · x/web-interface/popular             →    0    0    0   （稳定）
//   · x/v2/search/trending/ranking        →    0    0    0   （稳定）
// 排行榜接口对无 Cookie 的请求风控很凶，而本技能是**定时**跑的 —— 跑到一半拿不到
// 数据就发不出内容。所以只用稳定的两个源，不碰排行榜。
//
// ── 为什么要做题材白名单 ──
// B站热搜里时政/国际新闻占比很高（实测那一次前 15 条里有"英国为何又考虑加入欧盟"
// "房贷贴息政策能否拉高房价"这类）。用户的硬要求是**内容不能跟任何时政相关**，
// 所以这里做两道：先过 safe-topic 的禁用词，再过题材白名单 —— 只有明确属于
// 游戏 / 二次元 / 沙雕搞笑 / 科技玩梗的内容才留下。

import { isSafeTopic } from './safe-topic.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 题材关键词白名单。命中任意一个才算"能发"的题材。
 * 故意只放娱乐向词汇 —— 宁可今天的素材少几条，也不要跑偏到时政/社会新闻。
 */
const TOPIC_KEYWORDS = [
  // 游戏
  '游戏', '玩家', '通关', '副本', '抽卡', '开箱', '联机', '电竞', '赛事', '对局',
  '攻略', '速通', 'MOD', 'mod', '我的世界', '原神', '星穹铁道', '绝区零', '王者荣耀',
  '英雄联盟', 'LOL', 'CSGO', 'CS2', 'DOTA', '吃鸡', '永劫无间', '第五人格', '崩坏',
  '塞尔达', '艾尔登', '黑神话', '悟空', '双人成行', '模拟器', '独立游戏', '像素',
  // 二次元 / 动画
  '动漫', '动画', '番剧', '新番', '漫画', '声优', '手办', 'cos', 'COS', 'cosplay',
  '二次元', '鬼灭', '咒术', '进击的巨人', '火影', '海贼', '柯南', 'EVA', '高达',
  '初音', 'V家', '虚拟主播', 'Vtuber', 'VTuber', 'hololive', '碧蓝', '明日方舟',
  'MAD', 'MMD', 'AMV', '作画', 'OP', 'ED', '角色', '同人',
  // 沙雕 / 搞笑 / 梗
  '沙雕', '搞笑', '笑死', '整活', '鬼畜', '鬼才', '离谱', '抽象', '名场面', '笑点',
  '梗', '哈基米', '甲亢', '抽象话', '复读', '离谱操作', '翻车', '社死', '名侦探',
  '猫咪', '猫猫', '狗子', '动物', '萌宠', '仓鼠', '熊猫',
  // 科技玩梗（不含产业政策）
  'AI', 'ai', '机器人', '编程', '代码', '硬件', '显卡', '装机', '数码', '手机测评',
  '开源', '算法', '模型', 'deepseek', 'DeepSeek', 'chatgpt', 'ChatGPT'
];

/** 命中白名单就返回命中的词，用于给模型提示题材。 */
function topicOf(text) {
  const t = String(text || '');
  const hits = TOPIC_KEYWORDS.filter((k) => t.includes(k));
  return hits.length ? hits.slice(0, 3) : null;
}

async function getJson(fetchImpl, url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, referer: 'https://www.bilibili.com/' },
      signal: ctl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓一批候选素材。
 * @returns {Promise<{items: Array<{title:string,desc:string,source:string,topics:string[]}>, errors:string[]}>}
 */
export async function fetchHotTopics(fetchImpl, { limit = 12 } = {}) {
  const items = [];
  const errors = [];
  const seen = new Set();

  const push = (title, desc, source) => {
    const t = String(title || '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    // 硬门槛一：时政/敏感词直接丢
    if (!isSafeTopic(`${t} ${desc}`)) return;
    // 硬门槛二：必须命中题材白名单
    const topics = topicOf(`${t} ${desc}`);
    if (!topics) return;
    items.push({ title: t, desc: String(desc || '').trim().slice(0, 120), source, topics });
  };

  // 源一：综合热门（稳定）
  try {
    const j = await getJson(fetchImpl, 'https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1');
    if (j?.code === 0 && Array.isArray(j.data?.list)) {
      for (const v of j.data.list) {
        push(v.title, `${v.desc || ''} ${(v.tname || '')} ${(v.owner?.name || '')}`, 'B站热门');
      }
    } else {
      errors.push(`B站热门 code=${j?.code}`);
    }
  } catch (e) { errors.push(`B站热门：${e?.message || e}`); }

  // 源二：站内热搜（稳定，但时政占比高，靠上面两道门槛滤）
  try {
    const j = await getJson(fetchImpl, 'https://app.bilibili.com/x/v2/search/trending/ranking');
    if (j?.code === 0 && Array.isArray(j.data?.list)) {
      for (const v of j.data.list) push(v.keyword, v.show_name || '', 'B站热搜');
    } else {
      errors.push(`B站热搜 code=${j?.code}`);
    }
  } catch (e) { errors.push(`B站热搜：${e?.message || e}`); }

  return { items: items.slice(0, Math.max(1, limit)), errors };
}