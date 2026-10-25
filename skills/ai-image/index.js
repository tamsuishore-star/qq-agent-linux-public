// AI生图 | nuoxi4n
import { readSettings, validateArgs, describeError } from './lib/config.js';
import { createImageClient } from './lib/images.js';
import { loadReference, providerReference } from './lib/reference.js';

let config = () => ({});
let client;
let warn = () => {};
let enabled = false;
const operations = new Set();

function cancellation(message) {
  const error = new Error(`${message}，已停止后续处理；已受理的生成请求仍可能计费，不要自动重新生成`);
  error.code = 'ai-image-cancelled';
  return error;
}

function beginOperation(ctx) {
  if (!enabled) throw cancellation('技能未启用');
  const controller = new AbortController();
  const operation = {
    signal: controller.signal,
    check() {
      if (['aborted', 'error', 'done', 'noreply'].includes(ctx?.session?.status)) {
        controller.abort(cancellation('当前会话已结束'));
      }
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    finish: () => operations.delete(controller)
  };
  operation.check();
  operations.add(controller);
  return operation;
}

export function activate() { enabled = true; }
export function deactivate() {
  enabled = false;
  for (const controller of operations) controller.abort(cancellation('技能已停用或重新加载'));
  operations.clear();
}
export function dispose() { deactivate(); }

export function setup(api) {
  deactivate();
  config = api.config;
  client = createImageClient(api.fetch);
  warn = api.warn || (() => {});
  enabled = true;
  const common = {
    prompt: { type: 'string', minLength: 1, maxLength: 2000, description: '画面描述或改图要求。改图时写清保留什么、修改什么' },
    size: { type: 'string', description: '可选尺寸，如 1024x1024、1536x1024 或 auto；省略时使用设置值' },
    count: { type: 'integer', minimum: 1, maximum: 4, description: '生成数量，默认 1，最多 4；模型可能有更低的限制' }
  };
  api.registerTool({
    id: 'gen', name: '文生图', category: 'media', icon: '🎨',
    description: '当用户要求从文字描述画图、生成插画或设计画面时使用。纯文字生成，不使用参考图；参考已有图片修改时用 edit。生成结果直接发送到当前会话，不需要再调发图工具。',
    parameters: { type: 'object', properties: common, required: ['prompt'] },
    execute: (ctx, args) => execute('generate', ctx, args)
  });
  api.registerTool({
    id: 'edit', name: '图生图', category: 'media', icon: '🖌️',
    description: '当用户要求修改已发图片、变换风格或参考图片创作时使用。messageId 指定当前会话的带图消息；省略时使用触发消息或最近图片，imageIndex 选择第几张。生成结果直接发送，不需要再调发图工具。',
    parameters: {
      type: 'object',
      properties: {
        ...common,
        messageId: { type: ['string', 'integer'], description: '可选，当前会话带图消息的 QQ 消息 id（聊天记录中的 #数字），不要编造' },
        imageIndex: { type: 'integer', minimum: 1, maximum: 100, description: '参考消息中的第几张图片，从 1 开始，默认 1；越界会报错' }
      },
      required: ['prompt']
    },
    execute: (ctx, args) => execute('edit', ctx, args)
  });
}

// QQ-agent 的可用性调用链是同步的，配置每次重读以支持设置热更新。
export function available() {
  try {
    readSettings(config(), 'generate');
    readSettings(config(), 'edit');
    return { ok: true };
  } catch (error) { return { ok: false, reason: describeError(error) }; }
}

export function promptSections() {
  if (!enabled || !available().ok) return [];
  return [{
    id: 'ai-image-routing', title: 'AI生图', priority: 35,
    content: '用户要求纯文字创作时用 ai-image__gen；要求基于已发图片修改时用 ai-image__edit。'
      + '用户指定某张图时传真实 messageId 和从 1 开始的 imageIndex；图片指代不清时先确认，不要猜测。'
      + '两个工具都会直接发图，不要重复调用发送工具；未查看生成图片时不要描述其细节。'
      + '生成超时或发送失败时不要自动重新生成，先告知错误；如有本地缓存可重发已有图片。'
  }];
}

async function prepare(mode, rawArgs, ctx, operation) {
  operation.check();
  const settings = readSettings(config(), mode);
  operation.apiKey = settings.apiKey;
  const args = validateArgs(rawArgs, settings);
  if (!client) throw new Error('技能尚未 setup');
  const imageClient = client;
  let reference;
  if (mode === 'edit') {
    reference = ctx
      ? await loadReference(ctx, rawArgs, settings, imageClient, operation)
      : await providerReference(rawArgs.image, settings, imageClient, operation);
  }
  operation.check();
  const refs = await imageClient.request(settings, args, reference, operation);
  const images = [];
  const problems = [];
  for (const [index, ref] of refs.entries()) {
    operation.check();
    try { images.push(await imageClient.materialize(ref, settings, operation)); }
    catch (error) {
      operation.check();
      problems.push(`第 ${index + 1} 张：${describeError(error, settings.apiKey)}`);
    }
  }
  if (!images.length) throw new Error(`接口已返回图片但无法下载或解码：${problems.join('；')}。可能已计费，不要重新生成`);
  if (refs.length < args.count) problems.push(`请求 ${args.count} 张，接口只返回 ${refs.length} 张`);
  return { images, problems, origin: reference?.origin, settings };
}

function errorMessage(error, key) {
  if (key === undefined) {
    try { key = String(config()?.apiKey || '').trim(); } catch { /* 配置读取本身失败 */ }
  }
  return describeError(error, key);
}

async function execute(mode, ctx, args) {
  let operation;
  try {
    if (typeof ctx?.sender?.sendImage !== 'function') throw new Error('当前会话没有可用的图片发送器');
    operation = beginOperation(ctx);
    const result = await prepare(mode, args, ctx, operation);
    const problems = [...result.problems];
    let sent = 0;
    for (const image of result.images) {
      try {
        operation.check();
        const sentBefore = ctx.session?.sent?.length;
        // QQ-agent 的 OneBot 客户端透传 file 字段，协议需要 base64://，不是 data: URL。
        const receipt = await ctx.sender.sendImage(ctx.chatKey,
          { ...(image.filePath ? { file: image.filePath } : {}),
            dataUrl: image.dataUrl.replace(/^data:[^;,]+;base64,/, 'base64://') },
          { note: mode === 'edit' ? 'AI改图' : 'AI绘图' });
        sent++;
        // sender 负责聊天留档；仅在它未同步更新 session 时补充本轮展示记录。
        if (Array.isArray(ctx.session?.sent) && ctx.session.sent.length === sentBefore) {
          ctx.session.sent.push({ type: 'image', text: '[图片:AI绘图]', messageId: receipt?.message_id ?? null,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        }
      } catch (error) {
        problems.push(`未完成发送：${errorMessage(error, operation.apiKey)}${image.filePath ? `（本地缓存：${image.filePath}）` : '（未能保存本地缓存）'}`);
        if (operation.signal.aborted) break;
      }
    }
    if (!sent) throw new Error(`图片已生成但发送失败：${problems.join('；')}。不要重新生成，请重发已有图片`);
    try { ctx.emit?.('session-update', ctx.session?.id); } catch { /* 通知失败不影响发送结果 */ }
    return { content: `已${result.origin ? `参考${result.origin}` : ''}生成并发送 ${sent} 张图片到当前会话。`
      + (problems.length ? `部分结果未完成：${problems.join('；')}。不要自动重新生成。` : '')
      + '无需再次发送；尚未查看图片，不要编造画面细节。' };
  } catch (error) {
    const message = errorMessage(error, operation?.apiKey);
    try { warn(message); } catch { /* 日志故障不能让工具异常冒泡 */ }
    return { content: `AI生图失败：${message}`, isError: true };
  } finally { operation?.finish(); }
}

async function provide(mode, args) {
  let operation;
  try {
    operation = beginOperation();
    const { images, problems } = await prepare(mode, args, undefined, operation);
    operation.check();
    return { ok: true, images, ...(problems.length ? { warnings: problems } : {}) };
  } catch (error) { return { ok: false, error: errorMessage(error, operation?.apiKey) }; }
  finally { operation?.finish(); }
}

// 能力调用返回图片数据和缓存路径，不向聊天自动发消息。
export const providers = {
  'image.generate': (args) => provide('generate', args),
  'image.edit': (args) => provide('edit', args)
};
