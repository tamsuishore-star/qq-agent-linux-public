// B 站 API 客户端（插件与技能共用，两处各复制一份保持「目录自包含」）。
//
// 只做四件事（下面每一条都经过实际验证，不是想当然）：
//   1. 解析链接    —— 支持 BV/av/ss/ep、b23.tv 短链、带 ?p= 分 P 与 ?t= 时间戳
//   2. 取元信息    —— 标题/UP 主/时长/封面/分 P
//   3. 搜索视频    —— 需先领 buvid3/buvid4 指纹 Cookie，否则 412 风控
//   4. 下载视频    —— 360P 单文件，**必须带 Referer**，否则 CDN 403
//
// ── 记录的坑（改代码前先读）──────────────────────────────────────────
// · `durl[].url` 的形态随 fnval 而变化：fnval=1 时返回**字符串数组**，
//   但也有版本直接给字符串。按固定形态取会拿到单个字符（实际出现过 "h"），
//   所以下面 urlOf() 两种都吃。
// · CDN 主机**不在 bilibili.com 域名下**（实际会拿到类似 xxx.edge.某CDN.com 的地址），
//   且不带 Referer 一律 403。这意味着：
//     ① 不能复用核心的 safe-fetch —— 它的 SSRF 校验是按"只允许预期域名"设计的，
//        会把这个 CDN 域名拒掉；
//     ② 也不能把 playurl 的直链丢给协议端去下（协议端不会带 Referer，必然 403）。
//   所以必须本进程下完再按本地路径发。
// · 搜索接口无 Cookie 直接 412；先 GET /x/frontend/finger/spi 拿 b_3/b_4 当
//   buvid3/buvid4 即可，**无需登录**。指纹 30 分钟内复用，遇到 412 重新领一次。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const API = 'https://api.bilibili.com';
// B 站对云服务器 IP 的风控：不带 buvid3 时 /x/web-interface/view 直接 412。
// 生成一个稳定的 buvid3（进程生命周期内）作为匿名 Cookie，实测可恢复 200。
const BUVID3 = randomUUID().replace(/-/g, '').toUpperCase();
const ANON_COOKIE = `buvid3=${BUVID3}`;

/** 把 urls 数组成写成字符串的形如 "a\nb" 再拆开（兼容两种返回形态）。 */
function urlListOf(field) {
  if (Array.isArray(field)) return field.map(String).filter(Boolean);
  if (typeof field === 'string') {
    // durl 可能是多段（罕见），B 站用换行分隔
    return field.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function apiHeaders(extra = {}) {
  return { 'User-Agent': UA, Referer: REFERER, Cookie: ANON_COOKIE, ...extra };
}

/** 统一的 JSON 请求：网络错误、非 JSON、B 站业务 code≠0 都归一成 {ok:false,...}。 */
async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: apiHeaders(headers), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, error: `请求失败：${error?.message ?? error}` };
  }
  const text = await res.text();
  if (res.status !== 200) {
    return { ok: false, error: `HTTP ${res.status}`, status: res.status, raw: text.slice(0, 200) };
  }
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, error: '返回不是 JSON', raw: text.slice(0, 200) }; }
  if (body?.code !== 0) {
    return { ok: false, error: body?.message || `业务码 ${body?.code}`, code: body?.code };
  }
  // ⚠️ 负载字段名不统一：普通接口是 `data`，而 pgc（番剧）接口是 **`result`**。
  // 只认 data 会让番剧接口"code=0 却解析出空数据"，表现为"剧集信息为空"这种
  // 指向完全错误的报错（注意：season 接口明明返回了 13 集）。
  const payload = body?.data !== undefined ? body.data : body?.result;
  return { ok: true, data: payload };
}

// ── 链接解析 ──────────────────────────────────────────────────────────────

/** BV 号形态（BV + 10 位 base58）。单独抽出来，避免两处正则不一致。 */
const BV_RE = /BV[0-9A-Za-z]{10}/;
const AV_RE = /av(\d{3,})/i;

/**
 * 从任意文本里抠出第一个 B 站链接（含裸 b23.tv，分享文案常把协议头吃掉）。
 *
 * ⚠️ 这里**故意不认裸 BV 号**。本函数是"自动转发"的触发器，对每条群消息都会跑，
 * 认得太宽会让普通聊天里偶然出现的 BV 字样触发一次真实下载。裸 BV 号由
 * pickBareVideoToken 处理，只给"模型明确要求分享"的路径用。
 */
export function pickBiliLink(text) {
  const s = String(text || '');
  const withProto = s.match(/https?:\/\/(?:www\.|m\.|t\.)?(?:bilibili\.com|b23\.tv)\/[^\s"'<>，。！？）)】]+/i);
  if (withProto) return withProto[0].replace(/[.,;:]+$/, '').replace(/\/+$/, '');
  const bare = s.match(/(?:b23\.tv|(?:www\.|m\.)?bilibili\.com)\/[A-Za-z0-9_\-/?=&.%]+/i);
  return bare ? `https://${bare[0]}`.replace(/[.,;:]+$/, '') : '';
}

/**
 * 抠"裸视频标识"：用户直接甩一个 BV1xxxx 或 av170001。
 * 返回可用的链接，抠不到返回 ''。
 */
export function pickBareVideoToken(text) {
  const s = String(text || '');
  const bv = s.match(BV_RE);
  if (bv) return `https://www.bilibili.com/video/${bv[0]}`;
  const av = s.match(AV_RE);
  if (av) return `https://www.bilibili.com/video/av${av[1]}`;
  return '';
}

/**
 * 消息里是否有值得处理的 B 站内容。
 * 链接形态与裸视频号都算 —— 群里只粘一个 BV 号是很常见的用法，不能漏。
 */
export function isBiliLink(text) {
  return Boolean(pickBiliLink(text) || pickBareVideoToken(text));
}

/**
 * 解析一个链接到稳定标识。
 * @returns {{kind:'video'|'bangumi'|'unknown', bvid?, aid?, epId?, seasonId?, page?, t?, raw, error?}}
 */
export function parseBiliUrl(rawUrl) {
  const out = { kind: 'unknown', page: 1, t: 0, raw: String(rawUrl || '') };
  const s = String(rawUrl || '');
  try {
    const u = new URL(s);
    out.page = Math.max(1, Number(u.searchParams.get('p')) || 1);
    // ?t=123 / ?t=1m30s / ?start=123
    const tRaw = u.searchParams.get('t') || u.searchParams.get('start') || '';
    const m = String(tRaw).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
    if (m && (m[1] || m[2] || m[3])) {
      out.t = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
    } else out.t = Math.max(0, Number(tRaw) || 0);

    const path = u.pathname;
    const bv = path.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    if (bv) { out.kind = 'video'; out.bvid = bv[1]; return out; }
    const av = path.match(/\/video\/av(\d+)/i);
    if (av) { out.kind = 'video'; out.aid = Number(av[1]); return out; }
    const ep = path.match(/\/bangumi\/play\/ep(\d+)/i);
    if (ep) { out.kind = 'bangumi'; out.epId = Number(ep[1]); return out; }
    const ss = path.match(/\/bangumi\/play\/ss(\d+)/i);
    if (ss) { out.kind = 'bangumi'; out.seasonId = Number(ss[1]); return out; }
  } catch { /* 非法 URL 走下面 */ }

  // 纯 BV 号（用户直接贴 BV1xx...）
  const bareBv = s.match(/^(BV[0-9A-Za-z]{8,})$/i);
  if (bareBv) { out.kind = 'video'; out.bvid = bareBv[1]; return out; }
  return out;
}

/**
 * 短链 → 真实链接。b23.tv 是 302 跳转，可直接从 Location 读出。
 * 用 redirect:'manual' 而不是 follow：省一次整页请求，也避免被跳去 App 引导页。
 */
export async function expandShortLink(url, { timeoutMs = 10000 } = {}) {
  const s = String(url || '');
  if (!/b23\.tv/i.test(s)) return { ok: true, url: s, expanded: false };
  try {
    const res = await fetch(s, { headers: apiHeaders(), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const loc = res.headers.get('location');
    // 302/301/307 且 Location 里有 BV/av 才算成功
    if (loc && /bilibili\.com\/(video|bangumi)/i.test(loc)) return { ok: true, url: loc, expanded: true };
    if (loc) return { ok: true, url: loc, expanded: true };
    return { ok: false, error: `短链未返回跳转（HTTP ${res.status}）` };
  } catch (error) {
    return { ok: false, error: `短链解析失败：${error?.message ?? error}` };
  }
}

/** 一步到位：任意链接 → 归一标识（短链自动展开）。 */
export async function resolveLink(rawUrl) {
  const first = parseBiliUrl(rawUrl);
  if (first.kind === 'video' && (first.bvid || first.aid)) return first;
  const ex = await expandShortLink(rawUrl);
  if (!ex.ok) return { ...first, error: ex.error };
  const second = parseBiliUrl(ex.url);
  return { ...second, page: second.page || first.page, t: first.t || second.t, expanded: ex.expanded };
}

// ── 元信息 ────────────────────────────────────────────────────────────────

/** 秒 → "3:58" / "1:02:33"。 */
export function formatDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** "3:58" → 238（搜索结果里 duration 是字符串）。 */
export function parseDurationText(text) {
  const parts = String(text || '').split(':').map((x) => Number(x) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * 取视频元信息 + 目标分 P 的 cid。
 * @returns {{ok:boolean, title?, author?, duration?, cover?, bvid?, aid?, cid?, page?, pages?, desc?, error?}}
 */
export async function fetchVideoInfo(link, { timeoutMs = 15000 } = {}) {
  const l = typeof link === 'string' ? parseBiliUrl(link) : link;
  if (l?.kind === 'bangumi') {
    // 番剧：走 pgc 接口拿 ep 对应的 avid/cid，再复用 video 接口的元信息形态
    const epId = l.epId;
    if (!epId) return { ok: false, error: '番剧链接暂只支持 /ep 形式（ss 形式请点进具体一集）' };
    const r = await getJson(`${API}/pgc/view/web/season?ep_id=${epId}`, { timeoutMs });
    if (!r.ok) return { ok: false, error: `番剧信息获取失败：${r.error}` };
    const ep = (r.data?.episodes || []).find((e) => Number(e.ep_id) === Number(epId)) || r.data?.episodes?.[0];
    if (!ep) return { ok: false, error: '番剧剧集信息为空' };
    // 番剧标题形态：season_title 是番剧名（「我真的没用咩？」），
    // ep.title 是集号（"1"），ep.show_title 更完整（"第1话 xxx"）。
    const seasonTitle = String(ep.season_title || r.data?.season_title || r.data?.title || '').trim();
    const epLabel = String(ep.show_title || ep.long_title || ep.title || '').trim();
    const title = seasonTitle && epLabel ? `${seasonTitle} · ${epLabel}` : (seasonTitle || epLabel || '番剧');
    return {
      ok: true, kind: 'bangumi',
      title,
      author: String(r.data?.up_info?.uname || r.data?.up_name || '').trim(),
      // duration 是**毫秒**（598000 = 598 秒），其它接口都是秒
      duration: Number(ep.duration) ? Number(ep.duration) / 1000 : 0,
      cover: String(ep.cover || r.data?.cover || ''),
      bvid: ep.bvid || '', aid: Number(ep.aid) || 0, cid: Number(ep.cid) || 0,
      page: 1, pageTotal: 1, pageTitle: epLabel
    };
  }

  const q = l?.bvid ? `bvid=${encodeURIComponent(l.bvid)}` : (l?.aid ? `aid=${l.aid}` : '');
  if (!q) return { ok: false, error: '无法识别的视频标识（既没有 BV 号也没有 av 号）' };
  const r = await getJson(`${API}/x/web-interface/view?${q}`, { timeoutMs });
  if (!r.ok) {
    const hint = /啥都木有|-404/.test(String(r.error)) ? '（视频可能已删除或仅会员可见）' : '';
    return { ok: false, error: `视频信息获取失败：${r.error}${hint}` };
  }
  const d = r.data || {};
  // ⚠️ av 号进来时响应里**一定有 bvid**，但只有这里才知道。
  // 上面解析 av 链接时拿不到 bvid，若不在回填，后续 playurl 与"原链接"都会缺 bvid。
  const pages = Array.isArray(d.pages) ? d.pages : [];
  const wantPage = Math.min(Math.max(1, Number(l?.page) || 1), Math.max(1, pages.length));
  const pg = pages[wantPage - 1] || null;
  const bvid = String(d.bvid || l?.bvid || '');
  return {
    ok: true, kind: 'video',
    title: String(d.title || '').trim(),
    author: String(d.owner?.name || '').trim(),
    duration: Number(pg?.duration ?? d.duration) || 0,
    cover: String(d.pic || ''),
    desc: String(d.desc || '').slice(0, 200),
    bvid, aid: Number(d.aid || l?.aid) || 0,
    cid: Number(pg?.cid ?? d.cid) || 0,
    page: wantPage, pageTotal: pages.length || 1,
    pageTitle: String(pg?.part || '').trim()
  };
}

// ── 取流 ──────────────────────────────────────────────────────────────────

const QN_LABEL = { 120: '4K', 116: '1080P60', 112: '1080P+', 80: '1080P', 74: '720P60', 64: '720P', 32: '480P', 16: '360P', 6: '240P' };
export function qualityLabel(qn) { return QN_LABEL[Number(qn)] || `${qn}P`; }

/**
 * 拿播放地址（无 Cookie，最高 360P/480P）。
 *
 * 为什么不用 DASH（fnval=16/4048）：DASH 返回的是音视频分离流，发到 QQ 还得先合流，
 * 那就把 ffmpeg 拖进来了 —— 而这个项目的抽帧插件已经证明"外部可执行文件"会带来
 * 一堆环境问题。qn=16 的 MP4 单文件正好够"让群友看个内容"。
 *
 * @returns {{ok:boolean, urls?:string[], sizeBytes?:number, qn?:number, accept?:number[], error?}}
 */
export async function getPlayUrl(bvid, cid, { qn = 16, timeoutMs = 15000 } = {}) {
  if (!bvid || !cid) return { ok: false, error: '缺少 bvid 或 cid' };
  const q = `bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=1&fnver=0&fourk=0`;
  const r = await getJson(`${API}/x/player/playurl?${q}`, { timeoutMs });
  if (!r.ok) return { ok: false, error: `取流失败：${r.error}` };
  const d = r.data || {};
  const urls = urlListOf(d?.durl?.[0]?.url);
  if (!urls.length) return { ok: false, error: '取流失败：接口没返回地址（可能需要登录或该视频受限）' };
  return {
    ok: true, urls,
    sizeBytes: Number(d?.durl?.[0]?.size) || 0,
    qn: Number(d?.quality) || qn,
    accept: Array.isArray(d?.accept_quality) ? d.accept_quality : []
  };
}

/**
 * 下载视频到本地文件，带体积上限。
 *
 * Referer 是硬要求（不带 = 403）；Referer 必须是最初的视频页地址，
 * 用 bilibili.com 首页也能过，但按真实页面来更稳。
 */
export async function downloadVideo(urls, destPath, { maxBytes = 100 * 1024 * 1024, referer = REFERER, timeoutMs = 60000, log = () => {} } = {}) {
  const list = urlListOf(urls);
  if (!list.length) return { ok: false, error: '下载地址为空' };
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const fh = fs.openSync(destPath, 'w');
  let written = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      let res;
      try {
        res = await fetch(list[i], {
          headers: apiHeaders({ Referer: referer || REFERER }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        return { ok: false, error: `下载请求失败：${error?.message ?? error}` };
      }
      if (res.status !== 200 && res.status !== 206) {
        return { ok: false, error: `下载被拒（HTTP ${res.status}）—— Referer 可能没生效`, status: res.status };
      }
      const ctype = String(res.headers.get('content-type') || '');
      if (/text\/html|application\/json/i.test(ctype)) {
        return { ok: false, error: `下载到的不是视频（Content-Type: ${ctype}）` };
      }
      const reader = res.body?.getReader?.();
      if (!reader) {
        const buf = Buffer.from(await res.arrayBuffer());
        written += buf.length;
        if (written > maxBytes) return { ok: false, error: `视频超过体积上限（>${Math.round(maxBytes / 1048576)}MB），已放弃` };
        fs.writeSync(fh, buf);
      } else {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          written += value.length;
          if (written > maxBytes) {
            try { await reader.cancel(); } catch { /* ignore */ }
            return { ok: false, error: `视频超过体积上限（>${Math.round(maxBytes / 1048576)}MB），已放弃`, tooLarge: true, sizeBytes: written };
          }
          fs.writeSync(fh, Buffer.from(value));
        }
      }
      log(`分片 ${i + 1}/${list.length} 完成，累计 ${(written / 1048576).toFixed(1)}MB`);
    }
  } finally {
    try { fs.closeSync(fh); } catch { /* ignore */ }
  }
  if (!written) {
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    return { ok: false, error: '下载内容为空' };
  }
  return { ok: true, bytes: written };
}

// ── 搜索（需要指纹 Cookie，否则 412）───────────────────────────────────────

let fingerprint = { cookie: '', at: 0 };
const FP_TTL_MS = 30 * 60 * 1000;

/** 领 buvid3/buvid4 指纹。无需登录，纯匿名接口。 */
export async function ensureFingerprint({ timeoutMs = 10000, force = false } = {}) {
  if (!force && fingerprint.cookie && Date.now() - fingerprint.at < FP_TTL_MS) return fingerprint.cookie;
  const r = await getJson(`${API}/x/frontend/finger/spi`, { timeoutMs });
  if (!r.ok) return '';
  const b3 = String(r.data?.b_3 || '').trim();
  const b4 = String(r.data?.b_4 || '').trim();
  fingerprint = { cookie: [b3 && `buvid3=${b3}`, b4 && `buvid4=${b4}`].filter(Boolean).join('; '), at: Date.now() };
  return fingerprint.cookie;
}

/** 把播放量格式化成"2450万" / "11.6万" / "2345"（搜索结果里 play 是数字，卡片上要好读）。 */
export function formatPlay(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
}

/**
 * 关键词搜视频。返回精简后的候选，供模型挑一条或插件直发。
 *
 * ── 为什么要自己排序（结论，别删）────────────────────────────────────────
 * B 站搜索接口**不按播放量返回**，而是按相关度。例如查「（热门歌曲）关键词」，
 * 第 1 名可能是几千万播放，而一条同样相关、播放量更高的版本在第 13 名。
 * 直接取第一条的结果就是"发了个没人看的版本"，明明有更好的选择。
 * 所以这里按 `play` 降序重排 —— 排序在扩展内用接口已经返回的字段完成，
 * **不经过模型，零 token 消耗**。
 *
 * 默认排序后来改成 `up-first`（UP 本人的优先）：查询里带上第二个词之后，前几条会
 * 变成别人的二创，而用户要的是"看这个 UP 的视频"。见下面 up-first 分支的注释。
 *
 * @param {object} o
 *   page        翻到第几页（1~3）。接口每页只给 20 条，只取第 1 页的话候选池很小，
 *               同一个词反复搜就永远是那几条 —— 这是"来回就那几个视频"的直接原因。
 *   fetchLimit  先向接口要几条候选来排（排序池，默认 20；接口一页就给 20 条）
 *   limit       排序后返回几条
 *   sortBy      'play'（播放量降序）| 'up-first'（UP 本人的优先，默认）|
 *               'up-only'（只要 UP 本人的）| 'default'（保持接口原序）
 *   maxDurationSec  时长上限，超过的不进候选（默认 1800 秒，见下方注释）
 *   minDurationSec  时长下限（默认 0）
 */
export async function searchVideos(keyword, {
  page = 1,
  limit = 5,
  fetchLimit = 20,
  sortBy = 'up-first',
  maxDurationSec = 1800,
  minDurationSec = 0,
  fuzzy = true,
  excludeBvids = null,
  timeoutMs = 15000,
  log = () => {}
} = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return { ok: false, error: '搜索关键词为空' };
  const pageNo = Math.min(3, Math.max(1, Math.round(Number(page) || 1)));

  /** 打一次搜索接口，返回原始 result 数组。pageNo 可覆盖（逐级回退时用同一个页码）。 */
  const callSearch = async (word, pageOverride = null) => {
    const p = Math.min(3, Math.max(1, Math.round(Number(pageOverride) || pageNo)));
    const url = `${API}/x/web-interface/search/type?search_type=video&page=${p}&keyword=${encodeURIComponent(word)}`;
    let cookie = await ensureFingerprint({ timeoutMs });
    let res = await getJson(url, { headers: cookie ? { Cookie: cookie } : {}, timeoutMs });
    // 412 = 风控：指纹过期或首次没有，重领一次再试
    if (!res.ok && (res.status === 412 || res.code === -412)) {
      log('搜索被风控（412），重新领指纹后重试');
      cookie = await ensureFingerprint({ timeoutMs, force: true });
      res = await getJson(url, { headers: cookie ? { Cookie: cookie } : {}, timeoutMs });
    }
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, raw: Array.isArray(res.data?.result) ? res.data.result : [] };
  };

  // first / usedKeyword / suggestion 由下面的"逐级回退"循环写入
  let first = { ok: true, raw: [] };
  let usedKeyword = kw;
  let suggestion = '';

  const normalize = (list) => list.map((it) => ({
    bvid: String(it.bvid || ''),
    title: String(it.title || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim(),
    author: String(it.author || '').trim(),
    durationSec: parseDurationText(it.duration),
    duration: formatDuration(parseDurationText(it.duration)),
    play: Number(it.play) || 0,
    playText: formatPlay(it.play),
    url: it.bvid ? `https://www.bilibili.com/video/${it.bvid}` : ''
  })).filter((x) => x.bvid);

  /**
   * 模糊搜索补救：第一次结果里**一条本人都没有**，而搜索建议能给出更完整的词时，
   * 用建议词再搜一次。
   *
   * 为什么需要（用户报"搜不到本人"时的常见根因）：
   *   · 搜一个不完整的中文名（如只搜前两个字）→ 20 条里 0 条是本尊（词太短，搜歪了）
   *   · 把名字补全再搜        → 20 条里有 8 条是本尊
   *   · 建议接口给出的第一条往往就是完整名字
   * B 站的 search_target 参数**没有任何区别**（partial_match_for_tags /
   * title_keyword / exact_match_for_tags / bili_user 返回完全一样），指望它做模糊
   * 匹配是死路；反倒是搜索建议接口能补上"词不完整"这个最常见的失败原因。
   *
   * 只在**一个本人都没有**时才补救：已经能搜到本人就不折腾，避免把用户的词换掉。
   */
  const countMine = (items, word) => {
    const n = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
    const w = n(word);
    return items.filter((x) => {
      const au = n(x.author);
      return au.length >= 2 && (w.includes(au) || au.includes(w));
    }).length;
  };

  /**
   * 关键词命中校验：标题里必须至少出现一个"像样的词"。
   *
   * ⚠️ 这一道是**必须的**，不是锦上添花。典型场景（用户反馈"根本不是想要的视频"）：
   *   模型传「（音游名）新手 玩法教学」→ B 站按整串字面匹配，命中了"新手/玩法/教学"
   *   这些通用词，返回的前几条是别的游戏的攻略、另一款游戏的开荒、又一款游戏的新手
   *   攻略…… **一条目标音游的都没有**。
   *   而旧代码的时长过滤写了"过滤后为空就退回未过滤"，等于**主动允许发完全无关的视频**。
   *   → 现在：命中数 < 阈值就视为"这个词没搜到"，宁可返回空由上层换词，也不发垃圾。
   *
   * 为什么用"分词后任一命中"而不是整串包含：群友的真实用词常是多词串
   * （「（音游名） 新手」），而视频标题往往只含其中一部分（「[角色名] 曲名…『音游名』」）。
   * 但同时又**不能太松**——只按两个字命中就会放进无关内容，
   * 所以中文按 2 字词、ASCII 按整词来切，短词（1 个字）直接丢掉不算有效命中。
   */
  const norm = (s) => String(s || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  const keywordsOf = (word) => {
    const w = String(word || '');
    const out = new Set();
    // ① 完整 token 优先，且**不要拆开**：中英混合的名字（如"某UP主Abc"）如果
    //    拆成中文段 + 英文段，就再也匹配不上标题里的完整写法了
    //    （注意：拆碎后整串命中 0/20，被迫只用英文段，会混进别人的二创视频）。
    for (const t of w.split(/\s+/).map((x) => x.trim()).filter(Boolean)) {
      out.add(t.toLowerCase());
      // ② 中文长串再切 2 字词作为补充（「某音游新手」→ 某音游/游新手）
      for (const cn of t.match(/[\u4e00-\u9fa5]{4,}/g) || []) {
        for (let i = 0; i + 2 <= cn.length; i += 2) out.add(cn.slice(i, i + 2));
      }
    }
    // 丢掉 1 个字符的（"新""玩"这种命中等于没命中）
    return [...out].filter((t) => t.length >= 2);
  };
  const hitCount = (item, kws) => {
    if (!kws.length) return 1;   // 没有可校验的词（纯单字/符号）就不拦
    // ⚠️ 必须把**作者名**也算进来。注意：搜 UP 名字时，他的视频标题里往往不含自己的
    //    名字，只看标题会把本人视频
    //    全部滤掉（命中 0/20）—— 那比不校验还糟。
    const hay = norm(`${item.title} ${item.author}`);
    return kws.filter((k) => hay.includes(k)).length;
  };
  const filterByKeyword = (list, word) => {
    const kws = keywordsOf(word);
    if (!kws.length) return { items: list, dropped: 0 };
    // 命中阈值：词多时不能"只中一个词"就放行。
    // 注意：搜「这个关键词肯定搜不到任何东西xyzabc」时，只要标题含"关键词"三个字
    // 就通过，于是《千万不要作死搜这些关键词》被当成命中发出去 —— 它与查询本意无关。
    // 词数 ≥3 时要求至少中 2 个，能把这种"只沾一个通用词"的噪声滤掉；
    // 单/双词查询仍按"中 1 个"（否则「（音游名）」这种单主体词会被误杀）。
    const need = kws.length >= 3 ? 2 : 1;
    const kept = list.filter((x) => hitCount(x, kws) >= need);
    return { items: kept, dropped: list.length - kept.length, need };
  };

  // ── 排除已经发过的（必须在模糊补救之前定义）──────────────────────────────
  // 场景（用户反馈）：同一个关键词每次都被发同一条视频。根因是"防重复"的记账
  // 挂在每一轮的 ctx 上，而 ctx 每轮新建 —— 下一轮账本就空了，于是又从排序第一名
  // （通常是播放量最高那条）开始，永远发同一条。
  // 所以把"这个关键词已经发过哪些 BV"交给调用方跨轮维护（落盘），这里只负责排除。
  const exclude = new Set((Array.isArray(excludeBvids) ? excludeBvids : []).map(String));

  /**
   * 逐级回退：按顺序试每个"有意义"的词 → 搜索建议里与它同前缀的候选。
   *
   * 为什么不直接用整串词：B 站按字面匹配多词串，命中的是"新手/玩法/教学"这类通用词，
   * 会把别的游戏攻略全捞回来（查「（音游名）新手 玩法教学」时，前面几条全是无关游戏，
   * 一条目标音游都没有）。
   *
   * 为什么不只取第一个词：第一版只取第一个词，结果像「音游 （音游名） 新手 教学」这样
   * 的查询会用"音游"去搜（它只是个品类名），主题词反而被丢了。所以改成**按顺序把每个词都试一遍**，
   * 谁搜出来的结果通过了内容校验就用谁 —— 顺序保证"越靠前的词优先"，
   * 但"音游"搜出的东西不含"音游"时会被校验挡掉，自然轮到后面的主题词。
   *
   * 修饰词（攻略/教学/新手…）跳过不试：它们单独搜必然搜出一堆不相干的教程，
   * 而且它们本来就是"要什么内容"的修饰，不是主题。
   */
  const pool = Math.max(1, Math.min(20, Number(fetchLimit) || 20));
  const STOPWORDS = new Set(['攻略', '教学', '教程', '新手', '入门', '推荐', '合集', '玩法', '介绍', '指南', '怎么', '如何', '视频', '播放', '全集', '完整版', '最新']);
  // 英文虚词同样要排除：它们单独搜会命中一堆毫不相干的视频
  // （曾经查一首英文歌时选中了其中的 "again"，结果搜出完全无关的动画主题曲）
  const EN_STOPWORDS = new Set(['again', 'you', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'see', 'song', 'video', 'music', 'full', 'new', 'best', 'live']);
  const sep = String(kw).split(/\s+/).map((x) => x.trim()).filter(Boolean);
  const candidates = [];
  for (const w of (sep.length ? sep : [kw])) {
    const nw = norm(w);
    // 单词候选的门槛：CJK ≥2 字、ASCII ≥4 字母。
    // 为什么 ASCII 要 ≥4：否则一首三词英文歌名会被拆成三个单词，而 "you" 这种
    // 短英文词在标题里到处都是（命中数虚高到 20/20），选中它等于搜了个寂寞。
    const isAscii = /^[a-z0-9._-]+$/i.test(nw);
    const minLen = isAscii ? 4 : 2;
    if (nw.length >= minLen && !STOPWORDS.has(nw) && !EN_STOPWORDS.has(nw) && !candidates.includes(w)) candidates.push(w);
  }
  // 整串（多词查询的完整写法）作为最后一个候选：它作为短语搜反而更准。
  // 顺序上放在所有单词候选之后，这样"整串"只在单词候选都搜不出内容时才启用；
  // 但全是虚词的组合，单词候选会被上面过滤掉，整串就成了唯一候选。
  if (sep.length > 1 && !candidates.some((c) => norm(c) === norm(kw))) candidates.push(kw);
  if (!candidates.length) candidates.push(kw);
  const coreWord = candidates[0];
  const coreNorm = norm(coreWord);
  if (fuzzy !== false) {
    // 所有候选词都搜不到内容时，才动用搜索建议（且只认与核心词同前缀的建议）
    const sug = await suggestKeywords(coreWord, { timeoutMs });
    for (const s of sug) {
      const ns = norm(s);
      if (ns.startsWith(coreNorm) && ns !== coreNorm && !candidates.some((c) => norm(c) === ns)) candidates.push(s);
      if (candidates.length >= 5) break;
    }
  }

  let matched = [];
  let matchedWord = kw;
  const droppedLog = [];
  // 按顺序试候选词，**取第一个通过内容校验的**。
  // ⚠️ 试过改成"把每个候选都搜一遍、取命中条数最多的"，结果更糟：
  //   「明日方舟 抽卡 攻略」选中了"明日方舟卫戍协议更新公告"（更长更偏的词条命中更多）、
  //   一首全是虚词的英文歌会选中其中的 "you"（英文单词命中数天然虚高）、
  //   「孤独摇滚 歌曲 合集」选中了"孤独摇滚第二季"。
  //   "命中最多"≠"最相关"，所以回到"按原顺序取第一个能用的"这个朴素规则。
  for (const cand of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const r0 = await callSearch(cand, pageNo);
    if (!r0.ok) continue;
    const norm0 = normalize(r0.raw).slice(0, pool).filter((x) => !exclude.has(x.bvid));
    const { items: kept, dropped } = filterByKeyword(norm0, cand);
    droppedLog.push(`${cand}: 命中 ${kept.length}/${norm0.length}${dropped ? `（滤掉 ${dropped}）` : ''}`);
    if (kept.length) {
      matched = kept;
      matchedWord = cand;
      first = { ok: true, raw: r0.raw };
      usedKeyword = cand;
      if (norm(cand) !== norm(kw)) suggestion = cand;
      break;
    }
  }
  if (droppedLog.length > 1) log(`关键词逐级回退：${droppedLog.join(' → ')}`);
  if (!matched.length) {
    return {
      ok: true, items: [], page: pageNo, poolTotal: 0, poolFromUpCount: 0,
      total: 0, fromUpCount: 0, returnedTotal: 0,
      usedKeyword: kw,
      suggestion: null,
      keywordMiss: true,
      error: `「${kw}」没搜到内容匹配的视频（试过：${candidates.join(' / ')}）`
    };
  }
  {
    // 命中集合并入后续流程：把 matched 当作"本页候选"，后面的时长过滤/排序都作用在它上面
    var itemsFromKeyword = matched;
  }

  // 用逐级回退得到的"关键词命中集合"作为候选。
  // ⚠️ 它已经做过排除与关键词校验，这里不要再退回未校验的 normalize(raw)，
  //    那会把刚才滤掉的无关视频又放回来（这正是"被无关词带偏"这类事件的发生方式）。
  let items = itemsFromKeyword;

  // ── 时长过滤：为什么默认卡 30 分钟 ──────────────────────────────────────
  // 高播放里混着大量"循环歌单/助眠合集"（有些长达 60:18、32:00，播放量都不低）。
  // 它们会稳定赢下"播放量最高"，但根本不适合
  // 当"给别人听一首歌"用：体积大、要么被体积上限挡掉只发链接，要么发出去半分钟
  // 还在前奏。所以先按时长筛掉，再排播放量。
  // 过滤后一条都不剩时**退回未过滤**，而不是报"没搜到"——宁可发个长的也别什么都没。
  const maxSec = Number(maxDurationSec) > 0 ? Number(maxDurationSec) : 0;
  const minSec = Number(minDurationSec) > 0 ? Number(minDurationSec) : 0;
  let filtered = true;
  if (maxSec || minSec) {
    const kept = items.filter((x) => (!maxSec || x.durationSec <= maxSec) && (!minSec || x.durationSec >= minSec));
    if (kept.length) items = kept;
    else filtered = false;
  }

  // ── UP 判定：**任何排序模式下都要先算出来** ────────────────────────────────
  // 为什么用名字比对而不是 mid（UP 的 uid）：B 站的公开搜索接口**没有**"只搜某人
  // 投稿"的参数（传 mid 无效，返回结果与不传一模一样）。站内的「用户投稿」
  // 搜索走签名接口，需要 WBI 签名 + Cookie，成本高一个档。所以先做能做的：
  // 用作者名与关键词的互相包含关系判断"这条像不像本人发的"。
  //
  // ⚠️ 曾经把这段计算写在 up-first 分支里，结果 sortBy=play/default 时
  // fromUpCount 恒为 0 —— 明明前三名作者都是本人却报 0，排障时被它误导过。
  // 统计必须与排序解耦。
  // （归一化函数复用上面关键词校验里的 norm，不要在这里重复声明）
  const kwNorm = norm(usedKeyword || keyword);
  const isUp = (x) => {
    const au = norm(x.author);
    if (!au || au.length < 2) return false;
    return kwNorm.includes(au) || au.includes(kwNorm);
  };
  items = items.map((x) => ({ ...x, fromUp: isUp(x) }));
  const mine = items.filter((x) => x.fromUp).sort((a, b) => b.play - a.play);
  const others = items.filter((x) => !x.fromUp).sort((a, b) => b.play - a.play);

  const mode = String(sortBy || 'up-first');
  if (mode === 'play' || mode === 'default') {
    // 播放量降序 / 保持接口原序；两条支路都不改变 fromUp 统计
    items = mode === 'play' ? [...items].sort((a, b) => b.play - a.play) : items;
  } else if (mode === 'up-only') {
    // 只发作者名对得上的（代价是可能空手而归）
    items = mine;
  } else {
    // up-first：本人的全部提到前面（各自内部再按播放量降序）
    items = [...mine, ...others];
  }
  const returned = items.slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));  return {
    ok: true,
    items: returned,
    durationFiltered: filtered,
    page: pageNo,
    // ⚠️ 统计口径要写清楚，否则会被误读（注意：把候选池的统计当成"返回条数"）：
    //   poolTotal / poolFromUp*  —— 整个候选池（本页过滤后）的统计
    //   returnedTotal / returnedFromUp* —— 实际返回给调用方的这几条的统计
    poolTotal: items.length,
    poolFromUpCount: items.filter((x) => x.fromUp).length,
    total: items.length,
    fromUpCount: returned.filter((x) => x.fromUp).length,
    returnedTotal: returned.length,
    // 实际用的词与"是否被建议纠正过"：调用方据此告诉模型/用户换了什么词
    usedKeyword,
    suggestion: suggestion || null
  };
}

/**
 * 搜索建议：把不完整的词补成 B 站认得的词。
 *
 * 作用：搜一个不完整的中文名时 20 条里 0 条是本尊，
 * 而建议接口给出的第一条往往就是完整名字 —— 补上"词不完整"这个最常见的搜歪原因。
 * 接口：s.search.bilibili.com（免 Cookie、免指纹）。
 */
export async function suggestKeywords(term, { timeoutMs = 8000 } = {}) {
  const t = String(term || '').trim();
  if (!t) return [];
  try {
    const res = await fetch(`https://s.search.bilibili.com/main/suggest?term=${encodeURIComponent(t)}&main_ver=v1`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return [];
    const j = await res.json();
    const tags = Array.isArray(j?.result?.tag) ? j.result.tag : [];
    return tags.map((x) => String(x?.value || '').trim()).filter(Boolean).slice(0, 10);
  } catch {
    return [];   // 建议接口挂了不能影响搜索本身
  }
}

// ── WBI 签名（B 站 2023 年起给很多接口加的反爬参数）──────────────────────────
//
// 为什么要它：想直接播「某个 UP 主页里播放量最高的视频」，必须用空间投稿接口
//   /x/space/wbi/arc/search?mid=<uid>&order=click
// 这个接口**必须**带 w_rid 签名，否则返回 HTML 错误页。对照：
//   · 老接口 /x/space/arc/search 免签能通，但 order=click 被风控 412、第 2 页 -799
//   · 新接口不带签名 → 直接 HTML
//   · 新接口带签名 + 只带 Cookie → -352 风控校验失败
//   · 新接口带签名 + **完整浏览器头**（Origin/Sec-Fetch-*）→ code:0 ✓
// 也就是说：签名只是必要条件，**请求头同样是必要条件**，少一个都不行。
//
// 算法：nav 接口取 wbi_img 的 img_url/sub_url → 各取文件名（去掉扩展名）→ 拼成
// 64 字符 → 按下面的固定表重排出 32 字符 mixin → 参数按字典序拼 query + wts 时间戳
// → md5(query + mixin) 即 w_rid。
const WBI_MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
];

let wbiKeyCache = null;
let wbiKeyAt = 0;
const WBI_KEY_TTL_MS = 30 * 60 * 1000;

/** 取（并缓存）wbi mixin。key 会轮换，所以带 TTL。 */
async function ensureWbiMixin({ timeoutMs = 10000, force = false } = {}) {
  if (!force && wbiKeyCache && Date.now() - wbiKeyAt < WBI_KEY_TTL_MS) return wbiKeyCache;
  // ⚠️ 这里**不能**用 getJson：nav 未登录时 code=-101，而 getJson 对 code≠0 一律判失败，
  // 会把 wbi_img 一起丢掉。wbi_img 恰恰是登录与否都会返回的（key 与登录态无关）。
  let body;
  try {
    const res = await fetch(`${API}/x/web-interface/nav`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    body = await res.json();
  } catch {
    return null;
  }
  const imgUrl = body?.data?.wbi_img?.img_url || '';
  const subUrl = body?.data?.wbi_img?.sub_url || '';
  const key = (u) => String(u).split('/').pop().split('.')[0];
  const raw = key(imgUrl) + key(subUrl);
  if (raw.length < 64) return null;
  wbiKeyCache = WBI_MIXIN_TABLE.map((i) => raw[i]).join('').slice(0, 32);
  wbiKeyAt = Date.now();
  return wbiKeyCache;
}

/** 给参数签名，返回可直接拼到 URL 后的 query 串。 */
export async function wbiSign(params, opts = {}) {
  const mixin = await ensureWbiMixin(opts);
  if (!mixin) return null;
  const withTs = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(withTs).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

// ── UP 主：名字 → uid，uid → 主页投稿 ──────────────────────────────────────

/**
 * 按名字搜索 UP 主，返回 { mid, uname, fans, videos }。
 * 用 search_type=bili_user，免签名（只需指纹 Cookie）。
 */
export async function searchUpUser(name, { timeoutMs = 15000 } = {}) {
  const kw = String(name || '').trim();
  if (!kw) return { ok: false, error: 'UP 名字为空' };
  const url = `${API}/x/web-interface/search/type?search_type=bili_user&page=1&keyword=${encodeURIComponent(kw)}`;
  let cookie = await ensureFingerprint({ timeoutMs });
  let r = await getJson(url, { headers: cookie ? { Cookie: cookie } : {}, timeoutMs });
  if (!r.ok && (r.status === 412 || r.code === -412)) {
    cookie = await ensureFingerprint({ timeoutMs, force: true });
    r = await getJson(url, { headers: cookie ? { Cookie: cookie } : {}, timeoutMs });
  }
  if (!r.ok) return { ok: false, error: `搜 UP 失败：${r.error}` };
  const list = Array.isArray(r.data?.result) ? r.data.result : [];
  const users = list.map((u) => ({
    mid: Number(u.mid) || 0,
    uname: String(u.uname || '').replace(/<[^>]+>/g, '').trim(),
    fans: Number(u.fans) || 0,
    videos: Number(u.videos) || 0,
    sign: String(u.usign || '').slice(0, 60)
  })).filter((u) => u.mid);
  if (!users.length) return { ok: false, error: `没找到叫「${kw}」的 UP 主` };
  return { ok: true, users, best: users[0] };
}

/**
 * 直接拉某个 UP 的主页投稿（走签名接口）。
 *
 * ── 为什么必须带节流 ──────────────────────────────────────────────────────
 * 连续打这个接口（哪怕间隔 3 秒）会被**长时间限流**，报
 * 「request was banned」/「风控校验失败」，而且过了 6 分钟仍未恢复。
 * 所以：① 调用方必须缓存（见上层 skill 的 upCache）；② 这里再加一道最小间隔。
 *
 * @param mid      UP 的 uid
 * @param order    'click'（按播放量，默认）| 'pubdate'（最新）| 'stow'（收藏）
 * @param page     第几页（每页 ps 条）
 */
let lastSpaceCallAt = 0;
const SPACE_MIN_INTERVAL_MS = 1500;
const SPACE_BANNED_COOLDOWN_MS = 10 * 60 * 1000;
let spaceBannedUntil = 0;

/**
 * 限流冷却时间**必须落盘**，不能只放内存。
 *
 * 原因（原因）：bili-api.js 可能被多个进程各加载一份（插件进程、技能进程、
 * 我自己跑测试的脚本、热重载后的新实例），内存变量各进程互不可见 —— 一个进程里
 * 刚被 B 站封了，另一个进程照样立刻再打，等于没有保护。
 * 落盘后，任何进程碰到限流都会让**所有**进程一起退避。
 */
function banStateFile() {
  return path.join(os.tmpdir(), 'qq-agent-bili-space-ban.json');
}

function readBanUntil() {
  try {
    const j = JSON.parse(fs.readFileSync(banStateFile(), 'utf8'));
    const t = Number(j?.until) || 0;
    return t > Date.now() ? t : 0;
  } catch {
    return 0;
  }
}

function writeBanUntil(until) {
  try {
    fs.writeFileSync(banStateFile(), JSON.stringify({ until, at: Date.now() }), 'utf8');
  } catch { /* 写不进去只影响跨进程保护，不影响功能 */ }
}

/** 当前是否处于限流冷却中（跨进程可见）。 */
function bannedUntil() {
  const fromDisk = readBanUntil();
  if (fromDisk > spaceBannedUntil) spaceBannedUntil = fromDisk;
  return spaceBannedUntil;
}

export async function fetchUpVideos(mid, { page = 1, ps = 20, order = 'click', timeoutMs = 15000 } = {}) {
  const id = Number(mid);
  if (!id) return { ok: false, error: '缺少 UP 的 uid' };
  const bu = bannedUntil();
  if (Date.now() < bu) {
    const mins = Math.ceil((bu - Date.now()) / 60000);
    return { ok: false, banned: true, error: `B 站正在限流这个接口（约 ${mins} 分钟后可再试）—— 刚才请求太频繁了，稍后再来或改用关键词搜索` };
  }
  const wait = lastSpaceCallAt + SPACE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSpaceCallAt = Date.now();

  const pn = Math.min(50, Math.max(1, Math.round(Number(page) || 1)));
  const size = Math.min(50, Math.max(1, Math.round(Number(ps) || 20)));
  const query = await wbiSign({ mid: id, ps: size, pn, order, platform: 'web', web_location: 1550101 }, { timeoutMs });
  if (!query) return { ok: false, error: 'WBI 签名参数获取失败（nav 接口没给出 key）' };
  const cookie = await ensureFingerprint({ timeoutMs });
  // ⚠️ 请求头是必需的：只带 Cookie 会 -352 风控校验失败；
  //    Origin/Sec-Fetch-* 齐全才算"像浏览器发的请求"。
  const headers = {
    'User-Agent': UA,
    Referer: `https://space.bilibili.com/${id}/video`,
    Origin: 'https://space.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    ...(cookie ? { Cookie: cookie } : {})
  };
  let res;
  try {
    res = await fetch(`${API}/x/space/wbi/arc/search?${query}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, error: `空间接口请求失败：${error?.message ?? error}` };
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: `空间接口返回了非 JSON（多半被风控拦了，HTTP ${res.status}）` };
  }
  if (body?.code !== 0) {
    const msg = String(body?.message || `业务码 ${body?.code}`);
    if (/banned|风控|过于频繁|-352|-799/i.test(msg) || body?.code === -352 || body?.code === -799) {
      spaceBannedUntil = Date.now() + SPACE_BANNED_COOLDOWN_MS;
      writeBanUntil(spaceBannedUntil);   // 落盘：让其它进程也一起退避
      return { ok: false, banned: true, error: `B 站限流（${msg}）：这个接口调太勤会被封一段时间，已自动冷却 10 分钟。稍后再试，或改用关键词搜索。` };
    }
    return { ok: false, error: msg };
  }
  spaceBannedUntil = 0;
  writeBanUntil(0);
  const vlist = Array.isArray(body?.data?.list?.vlist) ? body.data.list.vlist : [];
  return {
    ok: true,
    total: Number(body?.data?.page?.count) || vlist.length,
    items: vlist.map((x) => ({
      bvid: String(x.bvid || ''),
      title: String(x.title || '').replace(/<[^>]+>/g, '').trim(),
      author: String(x.author || '').trim(),
      durationSec: Number(x.length) || 0,
      duration: formatDuration(Number(x.length) || 0),
      play: Number(x.play) || 0,
      playText: formatPlay(x.play),
      url: x.bvid ? `https://www.bilibili.com/video/${x.bvid}` : ''
    })).filter((x) => x.bvid)
  };
}

// ── 给"发消息"用的小工具 ─────────────────────────────────────────────────

/** 生成安全文件名：BV号 + 洗过的标题，避免 Windows 非法字符与超长路径。 */
export function safeFileName(info) {
  const bad = /[\\/:*?"<>|\u0000-\u001f]/g;
  const title = String(info?.title || 'video').replace(bad, '_').slice(0, 60);
  const id = String(info?.bvid || info?.aid || 'bili').replace(bad, '_');
  return `${id}_${title}.mp4`.replace(/\s+/g, ' ').trim();
}

/** 拼一条人类可读的分享文案。 */
export function shareCaption(info, { link = '' } = {}) {
  const bits = [];
  if (info?.title) bits.push(info.title);
  const meta = [];
  if (info?.author) meta.push(info.author);
  if (info?.duration) meta.push(formatDuration(info.duration));
  if (info?.pageTotal > 1 && info?.page) meta.push(`P${info.page}/${info.pageTotal}`);
  if (meta.length) bits.push(meta.join(' · '));
  const url = link || (info?.bvid ? `https://www.bilibili.com/video/${info.bvid}` : '');
  if (url) bits.push(url);
  return bits.join('\n');
}
