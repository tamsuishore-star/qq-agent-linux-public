import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkImage, decodeBase64 } from './images.js';
import { positiveInteger } from './config.js';

function imageMedias(entry) {
  if (entry?.recalled || !Array.isArray(entry?.media)) return [];
  return entry.media.filter((media) => media?.kind === 'image' && (media.url || media.file));
}

function recentWithinRun(entries, trigger, session) {
  const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const lastId = Math.max(0, ...trigger.map((entry) => positive(entry?.id)));
  const lastTs = Math.max(0, ...trigger.map((entry) => positive(entry?.ts))) || positive(session?.startedAt);
  return entries.filter((entry) => {
    const id = positive(entry?.id);
    if (lastId && id) return id <= lastId;
    const ts = positive(entry?.ts);
    return !lastTs || !ts || ts <= lastTs;
  });
}

async function readLocalReference(source, settings, operation) {
  const localPath = /^file:/i.test(source) ? fileURLToPath(source) : source;
  operation?.check();
  const handle = await fs.open(localPath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > settings.maxRefBytes) throw new Error('参考图不是普通文件或超过体积上限');
    // 读取 stat 时的长度，避免文件增长导致无界分配。
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      operation?.check();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    operation?.check();
    return checkImage(buffer.subarray(0, offset), settings.maxRefBytes, true).buffer;
  } finally { await handle.close(); }
}

export async function loadReference(ctx, args, settings, client, operation) {
  operation?.check();
  const imageIndex = positiveInteger(args.imageIndex, 1, 'imageIndex', 100);
  const explicit = args.messageId != null && String(args.messageId).trim() !== '';
  let candidates;
  if (explicit) {
    const mid = String(args.messageId).trim().replace(/^#/, '');
    if (!/^-?\d+$/.test(mid)) throw new Error('messageId 必须是聊天记录里的 QQ 消息 id（#数字）');
    const entry = await ctx.store?.findByMid?.(ctx.chatKey, mid);
    if (!entry) throw new Error(`当前会话找不到消息 #${mid}，请使用真实的带图消息 id`);
    candidates = [entry];
  } else {
    // 兼容 trigger 为消息数组的版本，也兼容文档中 trigger 为字符串的版本。
    const trigger = Array.isArray(ctx.session?.trigger) ? ctx.session.trigger : [];
    candidates = trigger.some((entry) => imageMedias(entry).length)
      ? trigger : recentWithinRun(await ctx.store?.recent?.(ctx.chatKey, { limit: 30 }) || [], trigger, ctx.session);
  }
  operation?.check();
  const entry = [...candidates].reverse().find((item) => imageMedias(item).length);
  if (!entry) throw new Error(explicit ? '指定消息里没有可用图片，请确认消息 id' : '最近 30 条消息里没有图片，请先发送参考图');
  const images = imageMedias(entry);
  if (imageIndex > images.length) throw new Error(`这条消息只有 ${images.length} 张图片，不能选择第 ${imageIndex} 张`);
  const media = images[imageIndex - 1];
  let buffer;
  let lastError;
  const triedUrls = new Set();
  async function fromUrl(value) {
    const url = String(value || '').trim();
    if (!url || triedUrls.has(url)) return null;
    triedUrls.add(url);
    try {
      const downloaded = await client.download(url, settings.refDownloadTimeoutMs, settings.maxRefBytes, operation);
      return checkImage(downloaded, settings.maxRefBytes, true).buffer;
    } catch (error) { operation?.check(); lastError = error; return null; }
  }
  if (media.url) buffer = await fromUrl(media.url);
  // 仅从当前会话的媒体 file id 向协议端查询路径，不接收模型提供的任意本地路径。
  if (!buffer && media.file && typeof ctx.onebot?.call === 'function') {
    try {
      operation?.check();
      const info = await ctx.onebot.call('get_image', { file: String(media.file) });
      operation?.check();
      const result = info?.data || info;
      if (result?.url) buffer = await fromUrl(result.url);
      if (!buffer) {
        const source = String(result?.file || result?.path || '');
        if (/^https?:\/\//i.test(source)) buffer = await fromUrl(source);
        else if (source) buffer = await readLocalReference(source, settings, operation);
      }
    } catch (error) { operation?.check(); lastError = error; }
  }
  operation?.check();
  if (!buffer) throw new Error(`参考图读取失败：${lastError?.message || '链接不可用且协议端没有提供文件'}。请重新发送参考图`);
  return {
    ...checkImage(buffer, settings.maxRefBytes, true),
    origin: `消息 #${entry.mid ?? '未知'} 的第 ${imageIndex} 张图`
  };
}

export async function providerReference(image, settings, client, operation) {
  operation?.check();
  let buffer;
  if (Buffer.isBuffer(image?.buffer)) buffer = image.buffer;
  else if (typeof image === 'string' || image?.dataUrl) {
    buffer = decodeBase64(typeof image === 'string' ? image : image.dataUrl, settings.maxRefBytes);
  } else if (image?.url) buffer = await client.download(image.url, settings.refDownloadTimeoutMs, settings.maxRefBytes, operation);
  else throw new Error('请提供参考图 image：{ buffer }、{ dataUrl } 或 { url }');
  operation?.check();
  return checkImage(buffer, settings.maxRefBytes, true);
}
