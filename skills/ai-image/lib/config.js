const MB = 1024 * 1024;
const RESERVED = new Set(['model', 'prompt', 'n', 'size', 'image', 'image[]', 'images', 'mask', 'response_format', 'stream']);

export function resolveEndpoint(raw, mode) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new Error('Base URL 必须是完整的 http/https 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 只支持 http/https，不能包含用户名、密码、查询参数或 #片段');
  }
  let prefix = url.pathname.replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/i, '');
  if (!prefix) prefix = '/v1';
  url.pathname = `${prefix}/images/${mode === 'edit' ? 'edits' : 'generations'}`;
  return url.href;
}

function numberSetting(value, fallback, min, max) {
  const n = value === '' || value == null ? fallback : Number(value);
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : fallback)));
}

export function readSettings(raw = {}, mode = 'generate') {
  const baseUrl = String(raw.baseUrl || '').trim();
  const apiKey = String(raw.apiKey || '').trim();
  if (!baseUrl || !apiKey) throw new Error('请在「AI生图」设置中填写 Base URL 和 API Key');
  if (/\r|\n/.test(apiKey)) throw new Error('API Key 不能包含换行');
  const model = String((mode === 'edit' && raw.editModel) || raw.model || 'gpt-image-1').trim();
  if (!model) throw new Error('请填写模型 id');
  let extraBody = {};
  if (String(raw.extraBody || '').trim()) {
    try { extraBody = JSON.parse(raw.extraBody); } catch { throw new Error('额外请求字段必须是合法的 JSON 对象'); }
    if (!extraBody || typeof extraBody !== 'object' || Array.isArray(extraBody)) {
      throw new Error('额外请求字段必须是 JSON 对象，不能是数组或其他类型');
    }
  }
  extraBody = Object.fromEntries(Object.entries(extraBody).filter(([key]) => !RESERVED.has(key)));
  const responseFormat = raw.responseFormat || 'auto';
  if (!['auto', 'url', 'b64_json'].includes(responseFormat)) throw new Error('返回格式只能是 auto、url 或 b64_json');
  return {
    endpoint: resolveEndpoint(baseUrl, mode), apiKey, model, extraBody, responseFormat,
    defaultSize: String(raw.defaultSize || '').trim(),
    timeoutMs: numberSetting(raw.timeoutMs, 180000, 5000, 600000),
    downloadTimeoutMs: numberSetting(raw.downloadTimeoutMs, 60000, 5000, 300000),
    refDownloadTimeoutMs: numberSetting(raw.refDownloadTimeoutMs, 30000, 5000, 120000),
    maxRetries: numberSetting(raw.maxRetries, 0, 0, 3),
    maxImageBytes: numberSetting(raw.maxImageMB, 8, 1, 32) * MB,
    maxRefBytes: numberSetting(raw.maxRefMB, 20, 1, 50) * MB
  };
}

export function positiveInteger(value, fallback, name, max) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} 必须是 1~${max} 的整数`);
  return n;
}

export function validateArgs(args = {}, settings) {
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('请提供非空的 prompt 图片描述或修改要求');
  const prompt = args.prompt.trim();
  if (prompt.length > 2000) throw new Error('prompt 最多 2000 字');
  const count = positiveInteger(args.count, 1, 'count', 4);
  const size = String(args.size ?? '').trim() || settings.defaultSize;
  if (size && !/^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(size)) {
    throw new Error('size 请使用 auto 或 宽x高（例如 1024x1024）；实际支持的尺寸取决于模型');
  }
  return { prompt, count, size };
}

export function buildBody(settings, args, reference) {
  const fields = { ...settings.extraBody, model: settings.model, prompt: args.prompt, n: args.count };
  if (args.size) fields.size = args.size;
  if (settings.responseFormat !== 'auto') fields.response_format = settings.responseFormat;
  if (!reference) return JSON.stringify(fields);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const ext = reference.mime === 'image/jpeg' ? 'jpg' : reference.mime.split('/')[1];
  form.set('image', new Blob([reference.buffer], { type: reference.mime }), `reference.${ext}`);
  return form;
}

// 只输出可读错误；不把上游回显的密钥、内联图片或签名查询串带进日志/模型上下文。
export function describeError(error, apiKey = '') {
  let text = String(error?.message || error || '未知错误');
  if (apiKey) text = text.split(apiKey).join('[已隐藏密钥]');
  text = text.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]')
    .replace(/(?:data:image\/[^;,]+;base64,|base64:\/\/)[A-Za-z0-9+/=\s]+/gi, '[图片数据]')
    .replace(/[A-Za-z0-9+/=]{100,}/g, '[长数据已隐藏]')
    .replace(/https?:\/\/[^\s"<>]+/g, (value) => value.split(/[?#]/)[0]);
  return text.slice(0, 500);
}
