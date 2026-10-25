// Agent Reach（qqagent 侧）：把「看全网」这件事实用化。
//
// 为什么不是照搬上游 SKILL.md：那份 SKILL.md 是写给会自己跑 shell 的 agent 的
// （curl r.jina.ai / mcporter / gh / twitter-cli …），而 qqagent 的 qwen3.5 只有工具
// 没有 shell。所以这里只挑**本机真的能跑通、不需要登录态**的能力做成工具：
//   · web_read   —— 直接抓取 + 正文抽取（本机 r.jina.ai 连不上，实测超时，别指望 Jina）
//   · bili_search—— B 站官方搜索接口（实测 code=0，20 条结果，零配置）
//   · rss_read   —— RSS/Atom 解析（上游零配置渠道之一）
//   · reach_doctor—— 把上游 CLI 的 doctor 结果讲给模型听（它自己跑不了 shell）
// 需要登录态/境外网络的（小红书、Twitter、Reddit、YouTube、Exa…）**故意不做成工具**：
// 本机实测连 example.com 都超时，做成工具只会让模型反复失败、浪费轮次。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AGENT_REACH_EXE = 'D:\\qqagent\\ai-skills\\venv\\Scripts\\agent-reach.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * B 站风控用的 buvid3。2026-10-04 实测（同一台机、同一秒内对比）：
 *   · 裸请求 → 稳定 HTTP 412 code=-412（重试也一样，26ms 就被拒）
 *   · 带一个随机 buvid3 cookie → HTTP 200 code=0，20 条结果
 * 所以每次搜索都塞一个新的 buvid3，别去掉。
 */
function buvid3() {
  const h = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(Math.random() * 16).toString(16));
  return `${h}infoc`;
}

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

/** 明显指向内网的地址直接拒掉：模型可能被「读一下 http://127.0.0.1:3210/...」这种话诱导。 */
function isPrivateHost(u) {
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\.|^0\.|^10\.|^169\.254\.|^192\.168\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** HTML → 纯文本：先剁掉脚本/样式/注释，再按块级标签换行，最后压空白。 */
function htmlToText(html) {
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).filter((l) => l.length > 1).join('\n')
    .trim();
}

async function fetchText(url, { timeoutMs = 25000 } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = String(res.headers.get('content-type') || '');
  let text = buf.toString('utf8');
  if (/charset=(gbk|gb2312|gb18030)/i.test(ct)) {
    try { text = new TextDecoder('gbk').decode(buf); } catch { /* 保底用 utf8 */ }
  }
  return { status: res.status, ok: res.ok, contentType: ct, text };
}

function pickTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ''));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** XML 里的 <item>/<entry> 用正则取前 n 条 —— 不引第三方依赖，够用。 */
function parseFeed(xml, n) {
  const blocks = String(xml).match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  const pick = (b, tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(b);
    return m ? stripTags(m[1]) : '';
  };
  return blocks.slice(0, n).map((b) => {
    const link = pick(b, 'link') || (/<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? '');
    return { title: pick(b, 'title') || '（无标题）', link, date: pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || '', summary: pick(b, 'description') || pick(b, 'summary') || '' };
  });
}

function run(cmd, args, { timeoutMs = 90000, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export function register(api) {
  const log = api.log;

  api.registerTool({
    id: 'web_read',
    name: '读网页',
    description: '抓取网页正文并转成纯文本（去脚本/样式/标签）。适合「这个链接讲了什么」。境外站点本机常超时。',
    category: 'web',
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '网页地址（http/https）' },
        maxChars: { type: 'number', description: '正文最多返回多少字，默认 4000，上限 12000' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      const u = isHttpUrl(args?.url);
      if (!u) return { content: '错误：url 必须是 http/https 开头的完整地址', isError: true };
      if (isPrivateHost(u)) return { content: `错误：${u.hostname} 指向本机/内网，不允许抓取`, isError: true };
      const maxChars = Math.max(400, Math.min(12000, Number(args?.maxChars) || 4000));
      try {
        const r = await fetchText(u.href);
        if (!r.ok) return { content: `抓取失败：HTTP ${r.status}（${u.href}）${r.status === 403 || r.status === 412 ? '，多半是站点风控，需要登录/换地址' : ''}`, isError: true };
        const text = /html/i.test(r.contentType) || /<html/i.test(r.text.slice(0, 500)) ? htmlToText(r.text) : r.text.trim();
        if (!text) return { content: `抓到了 HTTP ${r.status}，但正文是空的（多半是全 JS 渲染的页面，本机没有浏览器渲染通道）`, isError: true };
        const title = /html/i.test(r.contentType) ? pickTitle(r.text) : '';
        const cut = text.length > maxChars;
        return {
          content: `${title ? `《${title}》\n` : ''}${text.slice(0, maxChars)}${cut ? `\n…（正文共 ${text.length} 字，已截断，需要更多就再调一次把 maxChars 调大）` : ''}`
        };
      } catch (error) {
        const msg = String(error?.name === 'TimeoutError' ? '连接超时（本机对境外站点常超时）' : (error?.message ?? error));
        return { content: `抓取失败：${msg}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'bili_search',
    name: '搜B站视频',
    description: 'B 站官方搜索接口搜视频，返回标题/UP主/播放量/时长/链接。无需登录。',
    category: 'web',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回条数，默认 5，上限 20' }
      },
      required: ['keyword']
    },
    async execute(ctx, args) {
      const kw = String(args?.keyword ?? '').trim();
      if (!kw) return { content: '错误：请给出搜索关键词', isError: true };
      const n = Math.max(1, Math.min(20, Number(args?.count) || 5));
      const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=${encodeURIComponent(kw)}`;
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', accept: 'application/json', cookie: `buvid3=${buvid3()}` },
          signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) {
          const hint = res.status === 412 || res.status === 403 ? '（B 站风控：携带随机 buvid3 cookie 后又出现这种码，等一会儿再试）' : '';
          return { content: `B 站搜索失败：HTTP ${res.status}${hint}`, isError: true };
        }
        const data = await res.json();
        if (data?.code !== 0) {
          const hint = data?.code === -412 || data?.code === -403 ? '（B 站风控，稍后重试）' : '';
          return { content: `B 站搜索失败：code=${data?.code} ${data?.message || ''}${hint}`, isError: true };
        }
        const arr = Array.isArray(data?.data?.result) ? data.data.result : [];
        if (!arr.length) return { content: `B 站没搜到「${kw}」的视频` };
        const lines = arr.slice(0, n).map((v, i) => {
          const title = stripTags(v.title);
          const link = v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : (v.arcurl || '');
          return `${i + 1}. ${title}\n   UP主 ${v.author || '—'} · 播放 ${v.play ?? '—'} · 时长 ${v.duration || '—'} · ${link}`;
        });
        return { content: `B 站「${kw}」的前 ${Math.min(n, arr.length)} 个结果：\n${lines.join('\n')}\n（共 ${data.data.numResults ?? arr.length} 个结果）` };
      } catch (error) {
        return { content: `B 站搜索失败：${String(error?.message ?? error)}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'rss_read',
    name: '读RSS',
    description: '读取 RSS/Atom 订阅源，返回最近几条的标题、时间、链接。',
    category: 'web',
    icon: '📰',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'RSS/Atom 源地址' },
        count: { type: 'number', description: '返回条数，默认 8，上限 30' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      const u = isHttpUrl(args?.url);
      if (!u) return { content: '错误：url 必须是 http/https 开头的完整地址', isError: true };
      if (isPrivateHost(u)) return { content: `错误：${u.hostname} 指向本机/内网，不允许抓取`, isError: true };
      const n = Math.max(1, Math.min(30, Number(args?.count) || 8));
      try {
        const r = await fetchText(u.href, { timeoutMs: 25000 });
        if (!r.ok) return { content: `读取失败：HTTP ${r.status}`, isError: true };
        const items = parseFeed(r.text, n);
        if (!items.length) return { content: '这个地址里没解析出任何条目（不是 RSS/Atom，或者内容在 JS 里）', isError: true };
        const lines = items.map((it, i) => `${i + 1}. ${it.title}${it.date ? `（${it.date}）` : ''}${it.link ? `\n   ${it.link}` : ''}`);
        return { content: `订阅源共取到 ${items.length} 条：\n${lines.join('\n')}` };
      } catch (error) {
        return { content: `读取失败：${String(error?.message ?? error)}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'reach_doctor',
    name: '渠道体检',
    description: '运行 Agent Reach 的 doctor，报告哪些平台渠道现在可用、哪些缺登录态。',
    category: 'system',
    icon: '🩺',
    parameters: { type: 'object', properties: {} },
    async execute() {
      if (!fs.existsSync(AGENT_REACH_EXE)) {
        return { content: `Agent Reach CLI 不在位（缺 ${AGENT_REACH_EXE}）。它装在 D:\\qqagent\\ai-skills\\venv 里，用 pip 装 agent-reach 即可。`, isError: true };
      }
      const { stdout, stderr } = await run(AGENT_REACH_EXE, ['doctor', '--json'], { timeoutMs: 120000 });
      let data = null;
      const m = /\{[\s\S]*\}/.exec(stdout || '');
      if (m) { try { data = JSON.parse(m[0]); } catch { data = null; } }
      if (!data) {
        const tail = (stderr || stdout || '').trim().split('\n').slice(-6).join('\n');
        return { content: `doctor 没给出 JSON，原始输出尾部：\n${tail.slice(0, 800)}`, isError: true };
      }
      const rows = [];
      const platforms = data.platforms || data.channels || data;
      if (Array.isArray(platforms)) {
        for (const p of platforms) {
          const name = p.platform || p.name || p.channel || '?';
          const ok = p.available ?? p.ready ?? p.status === 'ok';
          const backend = p.active_backend || p.backend || '';
          rows.push(`${ok ? '✅' : '❌'} ${name}${backend ? `（${backend}）` : ''}`);
        }
      } else if (platforms && typeof platforms === 'object') {
        for (const [name, v] of Object.entries(platforms)) {
          const ok = v?.available ?? v?.ready ?? v?.status === 'ok';
          rows.push(`${ok ? '✅' : '❌'} ${name}${v?.active_backend ? `（${v.active_backend}）` : ''}`);
        }
      }
      const ready = rows.filter((r) => r.startsWith('✅')).length;
      const note = '注意：本机对境外站点基本连不上（实测 example.com、r.jina.ai 都超时），'
        + '所以哪怕 doctor 标 ✅ 的境外渠道，真用起来也可能失败；B 站/RSS 这类国内可达的最稳。';
      return { content: `Agent Reach 渠道体检：${ready}/${rows.length} 可用\n${rows.join('\n')}\n\n${note}` };
    }
  });

  log('Agent Reach 技能已注册（web_read / bili_search / rss_read / reach_doctor）');
}
