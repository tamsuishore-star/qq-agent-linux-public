// B 站视频转发插件（确定性型 · 提供 media.download 能力）。
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
// 群里有人粘 B 站链接（含 b23.tv 短链）→ 本插件下载视频并作为**视频**发到群里，
// 同时补一条文案（标题 / UP 主 / 时长 / 原链接）。整条链路不经过 LLM：条件满足必然执行。
//
// ── 为什么必须由本进程下载，而不是把直链交给协议端 ─────────────────────────
// B 站 CDN **不带 Referer 一律 403**（带则 206 正常）。协议端不会替我们带
// Referer，所以"把 playurl 直链丢给 OneBot 视频段"这条路是死的 —— 必须本进程下完，
// 再用本地文件路径发。
//
// ── 安全边界（刻意保留的取舍，别当成疏漏）──────────────────────────────────
// 核心的 safe-fetch 有 SSRF 校验，但它按"只允许预期域名"设计，而 B 站 CDN 主机
// 并不在 bilibili.com 域名下（实际拿到 某个非 bilibili.com 的 CDN 域名），
// 直接套用会把自己拦死。这里的边界改为：
//   · **只下载本插件通过 playurl 拿到的地址**，绝不下载消息里出现的任意 URL
//     （用户可控的输入只有"哪个 BV 号"，下载目标由 B 站接口决定）；
//   · 体积上限硬限制，超了立刻取消并删除半截文件；
//   · 非 200/206、Content-Type 是 HTML/JSON 的一律拒绝（防止把错误页当视频发出去）。
// 也就是说：SSRF 面被收窄成"只能连 api.bilibili.com 与它返回的 CDN"，而不是"能连任意地址"。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isBiliLink, pickBiliLink, pickBareVideoToken, resolveLink, fetchVideoInfo,
  getPlayUrl, downloadVideo, safeFileName, shareCaption, qualityLabel
} from './bili-api.js';

// ── 配置与依赖注入 ────────────────────────────────────────────────────────

let cfg = () => ({});
let log = () => {};
let warn = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = api.warn;
}

/**
 * sender 的兜底获取。
 *
 * dispatchMediaLinks 传进来的 ctx 里**应该有** sender，但这一条我无法在不启动整个
 * 应用的前提下验证（app.js 的调用点是闭包内的私有变量）。所以这里做一次兜底：
 * 真没传进来时，直接从应用源码 import 那个单例。找不到就降级成"只发文案"，绝不让
 * 整条链路因为发不出媒体而炸掉 —— 那会让群友连链接都看不到。
 */
let senderModulePromise = null;
async function fallbackSender() {
  if (!senderModulePromise) {
    const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const candidates = [
      path.join(appRoot, 'src', 'sender.js'),
      path.join(appRoot, 'src', 'app.js')
    ];
    senderModulePromise = (async () => {
      for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        try {
          // 带时间戳 import：与加载器的热重载口径一致，避免拿到旧模块实例
          const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
          if (file.endsWith('sender.js') && mod?.sender) return mod.sender;
          if (mod?.sender) return mod.sender;
        } catch (error) {
          warn(`从 ${path.basename(file)} 取 sender 失败：${error?.message ?? error}`);
        }
      }
      return null;
    })();
  }
  return senderModulePromise;
}

function resolveMediaDir() {
  const configured = String(cfg().mediaDir || '').trim();
  if (configured) return configured;
  // 默认落在应用 data/ 旁边（与配置、会话、记忆同处），而不是安装目录：
  // 安装目录在 Program Files 下时通常不可写。
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return path.join(appRoot, 'data', 'bili-media');
}

/** 清理过期媒体文件：下载下来的视频发完就没用了，留着只会撑爆磁盘。 */
function pruneOldFiles(dir, maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* 单个文件清理失败不影响其它 */ }
    }
  } catch { /* 目录不存在/无权限：静默 */ }
}

// ── 发送 ──────────────────────────────────────────────────────────────────

/** 本地路径 → file:// URI（NapCat 对裸路径会报“识别URL失败”）。 */
function fileUri(p) {
  return 'file://' + String(p).replace(/\\/g, '/');
}

/**
 * 发视频段：
 *   ① 先试宿主机 file://（本机协议端可直接读）；
 *   ② 失败则复制到 NapCat 挂载目录，发容器内路径（Docker 场景）；
 *   ③ 再失败则用 base64:// 兜底。
 * 这样无论协议端在本机还是容器里，都不再“下载成功但发不出去”。
 */
async function sendVideoSegment(sender, chatKey, filePath, options) {
  try {
    return await sender.sendMedia(chatKey, [{ type: 'video', data: { file: fileUri(filePath) } }], options);
  } catch (first) {
    const host = String(cfg().napcatMountHost || '').trim();
    const cont = String(cfg().napcatMountContainer || '').trim();
    if (host && cont) {
      try {
        const dir = path.join(host, 'bili-media');
        fs.mkdirSync(dir, { recursive: true });
        const name = path.basename(filePath);
        const dest = path.join(dir, name);
        fs.copyFileSync(filePath, dest);
        const contPath = cont.replace(/\/+$/, '') + '/bili-media/' + name;
        return await sender.sendMedia(chatKey, [{ type: 'video', data: { file: fileUri(contPath) } }], options);
      } catch (second) {
        warn(`容器路径发送失败，改 base64：${second?.message ?? second}`);
      }
    }
    const b64 = fs.readFileSync(filePath).toString('base64');
    return await sender.sendMedia(chatKey, [{ type: 'video', data: { file: 'base64://' + b64 } }], options);
  }
}

/**
 * 发视频段 + 可选的文案。
 *
 * ⚠️ **视频必须独占一条消息**（这一条很重要）：
 *   拼成 [{video},{text}] 一次发出，协议端直接拒：
 *   `retcode=1400 message element "video" must be the only segment in a message`
 *   而且它是**发送阶段**才拒 —— 视频已经下载完、文件也落在磁盘上了，才在最后一步
 *   失败。表现就是"下载成功但群里什么都没有"。
 *   所以顺序是：先单独发视频，**再**单独发文案。两条消息，不是一条。
 *
 * 优先 sendMedia（自带串行/限频/去重/留档四道保护），sender 拿不到时降级纯文字。
 * 文案里带原链接：就算视频因为体积被跳过，群友也点得进去 —— 这是刻意的降级路径。
 */
async function sendVideoWithCaption({ sender, chatKey, filePath, caption, replyToMessageId = null }) {
  if (!filePath) {
    if (sender?.sendTextBatch) await sender.sendTextBatch(chatKey, [caption]);
    return { sent: false, mediaSent: false };
  }
  if (!sender?.sendMedia) {
    const fb = await fallbackSender();
    if (fb?.sendMedia) sender = fb;
  }
  if (!sender?.sendMedia) {
    warn('拿不到 sender.sendMedia，降级为只发文案');
    if (sender?.sendTextBatch) await sender.sendTextBatch(chatKey, [caption]);
    return { sent: false, mediaSent: false, reason: 'no-sender' };
  }

  // 视频段：**只有它自己**
  await sendVideoSegment(sender, chatKey, filePath, {
    label: `[B站视频]${caption ? `:${caption.split('\n')[0].slice(0, 40)}` : ''}`,
    dedupeKey: filePath,
    replyToMessageId: replyToMessageId || null
  });

  // 文案另发一条。失败不该把已成功的视频算成失败 —— 视频才是重点。
  let captionSent = false;
  if (caption && sender.sendTextBatch) {
    try {
      await sender.sendTextBatch(chatKey, [caption]);
      captionSent = true;
    } catch (error) {
      warn(`视频已发出，但文案发送失败：${error?.message ?? error}`);
    }
  }
  return { sent: true, mediaSent: true, captionSent };
}

/** 从消息文本里抠出被引用消息的 id（消息流里的引用标记形态）。 */
function replyIdFromText(text) {
  const m = String(text || '').match(/\[引用[^\]]*?id[=:]\s*(-?\d+)/i);
  return m ? m[1] : null;
}

// ── 核心：处理一个链接 ────────────────────────────────────────────────────

/**
 * 下载并分享一个 B 站视频。
 * 抽成独立函数是为了让 provider 与 internals 自测共用同一条路径 —— 测试跑的是真代码。
 */
export async function shareBiliVideo({ url, chatKey, sender = null, onebot = null, replyToMessageId = null, onebotFallback = null }) {
  // 链接形态优先；没有链接时吃裸 BV/av 号（群里只粘一个 BV 号很常见）
  const link = pickBiliLink(url) || pickBareVideoToken(url) || String(url || '').trim();
  if (!link) return { ok: false, skip: true };

  const resolved = await resolveLink(link);
  if (resolved.error) return { ok: false, error: resolved.error, friendly: '这个 B 站链接打不开，可能被删了或者我解析不了' };
  if (resolved.kind === 'unknown') return { ok: false, skip: true };

  const info = await fetchVideoInfo(resolved);
  if (!info.ok) return { ok: false, error: info.error, friendly: '视频信息拉不到，可能已删除或需要登录' };

  const pageUrl = info.bvid ? `https://www.bilibili.com/video/${info.bvid}${info.page > 1 ? `?p=${info.page}` : ''}` : link;
  const caption = shareCaption(info, { link: pageUrl });
  const dir = resolveMediaDir();
  pruneOldFiles(dir);

  const play = await getPlayUrl(info.bvid, info.cid, { qn: Number(cfg().qn) || 16 });
  if (!play.ok) {
    // 取流失败（会员专享/需要登录）：降级发文案，别让群友什么都看不到
    const reason = String(play.error || '');
    await sendVideoWithCaption({ sender: sender || onebotFallback, chatKey, filePath: null, caption: `${caption}\n（这个视频我拉不到视频流，可能仅限登录/大会员观看）` });
    return { ok: true, degraded: true, platform: 'bilibili', title: info.title, url: pageUrl, error: reason };
  }

  const maxMB = Math.max(1, Math.min(600, Number(cfg().maxMB) || 100));
  const maxBytes = maxMB * 1024 * 1024;
  if (play.sizeBytes && play.sizeBytes > maxBytes) {
    await sendVideoWithCaption({
      sender: sender || onebotFallback, chatKey, filePath: null,
      caption: `${caption}\n（原视频 ${(play.sizeBytes / 1048576).toFixed(1)}MB，超过我设的 ${maxMB}MB 上限，直接给你链接）`
    });
    return { ok: true, degraded: true, reason: 'too-large', platform: 'bilibili', title: info.title, url: pageUrl, sizeBytes: play.sizeBytes };
  }

  fs.mkdirSync(dir, { recursive: true });
  const fileName = safeFileName(info);
  const dest = path.join(dir, fileName);
  const dl = await downloadVideo(play.urls, dest, {
    maxBytes,
    referer: pageUrl,
    timeoutMs: Math.max(15000, Number(cfg().timeoutMs) || 60000),
    log: (m) => log(`${fileName} ${m}`)
  });
  if (!dl.ok) {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
    // 失败也把文案发出去：链接本身是有价值的，静默失败才是真的糟
    await sendVideoWithCaption({
      sender: sender || onebotFallback, chatKey, filePath: null,
      caption: `${caption}\n（下载失败：${dl.error}）`
    });
    return { ok: false, error: dl.error, friendly: dl.tooLarge ? `这个视频超过 ${maxMB}MB，我发不动，链接给你了` : '' };
  }

  const effSender = sender || onebotFallback;
  const r = await sendVideoWithCaption({ sender: effSender, chatKey, filePath: dest, caption, replyToMessageId });
  log(`已转发《${info.title}》（${info.author}，${qualityLabel(play.qn)}，${(dl.bytes / 1048576).toFixed(1)}MB）`);
  return {
    ok: true, platform: 'bilibili', title: info.title, url: pageUrl,
    bvid: info.bvid, quality: qualityLabel(play.qn), bytes: dl.bytes,
    mediaSent: r.mediaSent, filePath: dest
  };
}

// ── 能力提供者 ────────────────────────────────────────────────────────────

export const providers = {
  /**
   * 认领消息里的 B 站链接。
   *
   * 返回约定（见 src/media-links.js 的 dispatchMediaLinks）：
   *   {skip:true}            → 不认领，交给下一个提供者
   *   {ok:false, friendly}   → 认领了但失败，且这条失败值得告诉群友（会发一句）
   *   {ok:true, platform…}   → 成功
   */
  'media.download': async ({ url, sender, onebot, kind, chatId, text } = {}) => {
    if (!isBiliLink(url)) return { skip: true };   // 不是 B 站 → 让抖音之类的插件去认领
    const chatKey = `${kind}:${chatId}`;
    try {
      return await shareBiliVideo({
        url,
        chatKey,
        sender: sender || null,
        onebot: onebot || null,
        replyToMessageId: replyIdFromText(text)
      });
    } catch (error) {
      warn(`处理 B 站链接失败：${error?.stack ?? error}`);
      return { ok: false, error: String(error?.message ?? error), friendly: '这个 B 站视频我没转发成功' };
    }
  }
};

/**
 * 可用性自检。
 *
 * 与抽帧插件同样的坑：SkillManager 的可用性判定是**同步链**，返回 Promise 会被当成
 * truthy（永远"可用"）。本插件没有外部可执行文件依赖，所以这里可以诚实地同步返回
 * —— 只在配置明显非法时报告原因，让界面上的状态和实际行为一致。
 */
export function available() {
  const maxMB = Number(cfg().maxMB);
  if (cfg().maxMB !== undefined && (!Number.isFinite(maxMB) || maxMB <= 0)) {
    return { ok: false, reason: '体积上限（maxMB）配置不是正数，插件不会生效' };
  }
  return { ok: true };
}

/** 提示词片段：让模型知道视频是怎么来的，避免把"转发"说成"我看过了"。 */
export function promptSections() {
  return [{
    id: 'bili-video-note',
    title: 'B站视频',
    priority: 45,
    content: '群里出现 B 站链接时，插件会自动把视频本体转发进群（无需你动手）。'
      + '你只在"有人要你找/推荐 B 站视频"时才调 bili_video 工具。'
      + '视频是插件下载后发出去的，你并没有"看过"内容，不要评论视频里的画面。'
  }];
}

/** 排障与测试入口：跑的就是上面那条真实路径。 */
export const internals = {
  shareBiliVideo,
  resolveMediaDir,
  pruneOldFiles,
  replyIdFromText
};
