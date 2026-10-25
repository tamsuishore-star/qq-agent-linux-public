// 表情包配图：从 aigengtu 图库挑一张图，给说说配图用。
//
// 图库来源与 reply-meme 技能同一个（gallery-index.json）。这里不重复实现语义匹配，
// 只做两件事：按关键词/分类粗筛 + 随机挑一张，然后把**图片直链**交给
// send_qzone_msg 的 images —— 协议端会自己把图抓下来上传到空间相册。
//
// 为什么只放 aigengtu 的图：见 safe-topic.js 的 isAllowedImageUrl。放开任意 URL
// 等于开了一条把任意外链搬进自己空间的通道。

const INDEX_URL = 'https://aigengtu.com/gallery-index.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 从图库条目里抽出一条可用的（original 必须是白名单域名下的 meme 图片）。 */
function toEntry(value) {
  if (!value || typeof value.original !== 'string') return null;
  if (!/https?:\/\/img\.aigengtu\.com\/meme\/\d+\.(webp|png|jpe?g|gif)$/i.test(value.original)) return null;
  return {
    original: value.original,
    title: String(value.name || value.alt || '').trim(),
    category: String(value.category || '').trim()
  };
}

/**
 * 取一批表情包候选。
 * @param {Function} fetchImpl 注入的 fetch（受 skill.json 的 web_fetch 权限门禁）
 * @param {{keyword?:string, category?:string, limit?:number}} opts
 */
export async function pickMemes(fetchImpl, { keyword = '', category = '', limit = 30 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let raw;
  try {
    const res = await fetchImpl(INDEX_URL, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } finally { clearTimeout(timer); }

  // 索引结构：{ gallery: { <分类>: [ {name, original, category}, ... ] } }
  const gallery = raw?.gallery;
  if (!gallery || typeof gallery !== 'object') return { items: [], error: '图库索引结构不认识' };

  // 索引结构（实测）：gallery 是「分类名 → { name, images: [...] }」的对象。
  // 早先按「分类名 → 数组」解析，结果一条都取不到 —— 所以这里对两种形态都兼容，
  // 免得图库方改一次结构就静默失效（返回 0 条而不报错，最难查）。
  let all = [];
  for (const [cat, node] of Object.entries(gallery)) {
    const list = Array.isArray(node) ? node
      : Array.isArray(node?.images) ? node.images
      : Array.isArray(node?.items) ? node.items
      : null;
    if (!list) continue;
    for (const v of list) {
      const e = toEntry(v);
      if (e) { e.category = e.category || cat; all.push(e); }
    }
  }
  if (!all.length) return { items: [], error: '图库里没有可用图片' };

  const kw = String(keyword || '').trim();
  const cat = String(category || '').trim();
  let pool = all;
  if (cat) {
    const byCat = pool.filter((e) => e.category === cat);
    if (byCat.length) pool = byCat;
  }
  if (kw) {
    const byKw = pool.filter((e) => `${e.title} ${e.category}`.includes(kw));
    if (byKw.length) pool = byKw;
  }

  // 分类均衡：图库里 "DeepSeek娘" 一个分类就占 1381/1407 条，
  // 直接全库随机的话，挑 10 次有 9 次都是它，配图会显得很重复。
  // 所以先按分类分组、轮转着取（每轮从各分类各取一张），取满为止。
  const byCat = new Map();
  for (const e of pool) {
    const k = e.category || '(未分类)';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(e);
  }
  for (const arr of byCat.values()) arr.sort(() => Math.random() - 0.5);
  const groups = [...byCat.values()].sort((a, b) => b.length - a.length);
  const picked = [];
  let round = 0;
  while (picked.length < Math.max(1, limit)) {
    let added = 0;
    for (const g of groups) {
      if (picked.length >= Math.max(1, limit)) break;
      if (round < g.length) { picked.push(g[round]); added++; }
    }
    if (!added) break;
    round++;
  }

  return { items: picked, total: all.length, matched: pool.length, categories: byCat.size };
}