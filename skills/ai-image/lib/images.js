import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildBody, describeError } from './config.js';

async function sleep(ms, operation) {
  operation?.check();
  try { await delay(ms, undefined, { signal: operation?.signal }); }
  catch (error) { operation?.check(); throw error; }
  operation?.check();
}

export function detectMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function checkImage(buffer, maxBytes, reference = false) {
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > maxBytes) throw new Error(`图片超过 ${maxBytes / 1048576}MB 体积上限`);
  const mime = detectMime(buffer);
  if (!mime) throw new Error('返回内容不是支持的图片，可能是过期链接或错误页面');
  if (reference && !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    throw new Error('参考图只支持 PNG、JPEG、WebP 静态图，请重新发送');
  }
  return { buffer, mime };
}

export function decodeBase64(value, maxBytes) {
  const raw = String(value || '').trim();
  // 在去空白和解码前也设上限，避免不受限的内存分配。
  if (raw.length > Math.ceil(maxBytes * 4 / 3) + 4096) throw new Error('图片 base64 超过体积上限');
  const b64 = raw.replace(/^data:image\/[^;,]+;base64,/i, '').replace(/^base64:\/\//i, '').replace(/\s/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) throw new Error('图片 base64 格式不合法');
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > maxBytes) throw new Error('图片超过体积上限');
  return buffer;
}

export async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('响应内容超过体积上限');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('响应内容超过体积上限（传输中已截断）');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function isTimeout(error) {
  return ['AbortError', 'TimeoutError'].includes(error?.name) || /timeout|timed out/i.test(error?.message || '');
}

// 计时器覆盖 fetch 和完整响应体；任何成功、失败路径都在 finally 释放计时器。
async function fetchBytes(fetcher, url, options, timeoutMs, maxBytes, label, operation) {
  operation?.check();
  const controller = new AbortController();
  const cancel = () => controller.abort(operation.signal.reason);
  operation?.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    operation?.check();
    const response = await fetcher(url, { ...options, signal: controller.signal });
    const buffer = await readLimited(response, response.ok ? maxBytes : 65536);
    operation?.check();
    return { response, buffer };
  } catch (error) {
    operation?.check();
    if (controller.signal.aborted || isTimeout(error)) {
      throw new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒，含响应体读取）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    operation?.signal.removeEventListener('abort', cancel);
  }
}

export function extractImages(payload) {
  const candidates = Array.isArray(payload) ? [...payload] : [];
  for (const key of ['data', 'images', 'output', 'results', 'artifacts']) {
    const value = payload?.[key];
    if (Array.isArray(value)) candidates.push(...value);
    else if (value && typeof value === 'object') candidates.push(value);
  }
  return candidates.map((item) => {
    if (typeof item === 'string') return { kind: /^https?:\/\//i.test(item) ? 'url' : 'base64', value: item };
    if (!item || typeof item !== 'object') return null;
    const b64 = [item.b64_json, item.base64, item.image_base64, item.b64].find((v) => typeof v === 'string' && v.trim());
    if (b64) return { kind: 'base64', value: b64 };
    const value = [item.url, item.image_url?.url, item.image_url, item.image, item.file, item.url_path]
      .find((v) => typeof v === 'string' && v.trim());
    return value ? { kind: /^https?:\/\//i.test(value) ? 'url' : 'base64', value } : null;
  }).filter(Boolean);
}

export function createImageClient(fetcher) {
  async function request(settings, args, reference, operation) {
    for (let attempt = 0; ; attempt++) {
      operation?.check();
      let result;
      try {
        result = await fetchBytes(fetcher, settings.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Accept: 'application/json', Authorization: `Bearer ${settings.apiKey}`,
            ...(!reference ? { 'Content-Type': 'application/json' } : {})
          },
          body: buildBody(settings, args, reference)
        }, settings.timeoutMs, Math.ceil(settings.maxImageBytes * 4 / 3) * args.count + 1048576, '生成接口', operation);
      } catch (error) {
        operation?.check();
        throw new Error(`${describeError(error, settings.apiKey)}。请求结果未知，可能已计费，不自动重新生成`);
      }
      const { response, buffer } = result;
      // 5xx/408/网络错误不能证明请求未处理。仅在管理员明确开启时重试 HTTP 429。
      if (response.status === 429 && attempt < settings.maxRetries) {
        const seconds = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30000) : 2500, operation);
        continue;
      }
      let payload;
      try { payload = JSON.parse(buffer.toString('utf8')); } catch { /* 下方返回不含原始响应的错误 */ }
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message;
        throw new Error(`接口返回 HTTP ${response.status}${typeof message === 'string' ? `：${describeError(message, settings.apiKey)}` : ''}。未自动重新生成`);
      }
      if (!payload || typeof payload !== 'object') throw new Error('接口未返回有效 JSON；请求可能已计费，不要自动重新生成');
      const refs = extractImages(payload).slice(0, args.count);
      if (!refs.length) throw new Error('接口未返回图片；请检查模型是否支持 images 接口，不要自动重复生成');
      return refs;
    }
  }

  async function download(url, timeoutMs, maxBytes, operation) {
    operation?.check();
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('图片链接无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('图片链接必须是 http/https 地址');
    for (let attempt = 0; ; attempt++) {
      operation?.check();
      try {
        // API Key 只发给生成接口；QQ 图床与结果图下载均不携带它。
        const { response, buffer } = await fetchBytes(fetcher, url, {
          headers: { Accept: 'image/*' }, redirect: 'follow'
        }, timeoutMs, maxBytes, '图片下载', operation);
        if (!response.ok) throw new Error(`图片下载 HTTP ${response.status}`);
        return buffer;
      } catch (error) {
        operation?.check();
        if (attempt >= 1 || /体积上限|HTTP 4\d\d/.test(error.message)) throw error;
        await sleep(1200, operation);
      }
    }
  }

  async function materialize(ref, settings, operation) {
    operation?.check();
    const buffer = ref.kind === 'url'
      ? await download(ref.value, settings.downloadTimeoutMs, settings.maxImageBytes, operation)
      : decodeBase64(ref.value, settings.maxImageBytes);
    const { mime } = checkImage(buffer, settings.maxImageBytes);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    let filePath = '';
    try { filePath = await saveLocal(buffer, mime); } catch { /* 本地留档失败仍可通过 dataUrl 发送 */ }
    operation?.check();
    return { dataUrl, filePath, mime, bytes: buffer.length };
  }
  return { request, download, materialize };
}

async function saveLocal(buffer, mime) {
  const directory = path.join(os.tmpdir(), 'qq-agent-ai-image');
  await fs.mkdir(directory, { recursive: true });
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const filePath = path.join(directory, `${Date.now()}-${randomUUID()}.${ext}`);
  await fs.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
  // 最近 20 张保留，额外文件仅在一小时后清理，避免删除并发请求正在发送的图片。
  try {
    const files = (await fs.readdir(directory)).filter((name) => /^\d{13}-[\da-f-]+\.(png|jpg|webp|gif)$/.test(name)).sort();
    for (const name of files.slice(0, Math.max(0, files.length - 20))) {
      if (Number(name.slice(0, 13)) < Date.now() - 3600000) await fs.unlink(path.join(directory, name));
    }
  } catch { /* 缓存清理不影响图片交付 */ }
  return filePath;
}
