/**
 * qq-agent-browser —— 给 QQ Agent 一个「真的能开网页」的能力。
 *
 * 它解决什么：
 *   核心自带的 web_fetch 只抓静态 HTML，而现在的站点大多是 JS 渲染的 —— 抓回来常常只剩
 *   一个空壳（实测 B 站视频页纯 HTTP 只拿到一行 title）。这个插件走本机 Edge 的调试端口
 *   （CDP），把页面**真的打开**，等渲染完再取文本 / HTML，或者直接截图（图可以发到当前会话）。
 *
 * 安全模型（三条都是刻意的，别顺手放宽）：
 *   1. **独立 profile**：默认用 data/<本插件 id>/profile 起 Edge，和你自己那个浏览器完全隔离
 *      —— 群友就算使唤机器人开网页、截图，也读不到你的任何登录态。
 *   2. **会话白名单**：默认只有核心白名单里的群/好友能触发（与"机器人能不能回话"同一份名单）。
 *   3. **动作白名单**：eval / click / fill 这类"能操作页面"的动作可以在设置里关掉。
 *   ⚠️ 本插件目录里**不含任何个人数据**（端口 / profile 路径 / 白名单全走 api.config()，
 *      落在 data/config.json 那棵树里），所以点「上传到市场」是安全的。
 *
 * 两个踩过的坑（照抄结论，别改回去）：
 *   · 子模块用**带时间戳**的动态 import：宿主只给入口加 `?t=`，静态 import 的子模块会被 ESM
 *     缓存固定住，改了 lib/cdp.js 热重载不生效、也不报错。
 *   · 核心模块 `src/config.js` **不能**带时间戳：带 query 是另一个模块实例，而它的
 *     getConfig() 是模块级单例缓存 —— 会冻结在插件加载那一刻（白名单改了不生效）。
 *
 * @module qq-agent-browser
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 本扩展的 id —— 必须与 plugin.json 的 `id` 逐字一致（api.config() 按 id 查配置）。 */
export const SKILL_ID = 'qq-agent-browser';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const stamp = `?t=${Date.now()}`;
const { createCdp, ACTIONS: CDP_ACTIONS } = await import(`./lib/cdp.js${stamp}`);
const { getConfig, DATA_DIR } = await import('../../src/config.js');

/** 全部支持的 action（来自 CDP 客户端，不在这里另抄一份）。 */
const ALL_ACTIONS = Array.isArray(CDP_ACTIONS) ? CDP_ACTIONS : [];

/** 会改变页面状态的动作 —— 设置里最常见的就是把这几个关掉。 */
const MUTATING_ACTIONS = ['eval', 'click', 'fill'];

const DEFAULTS = {
  enabled: true,
  // ⚠️ 刻意不用 9222：那是很多工具/别的插件的默认调试端口（实测本机 9222 上就挂着另一个
  //    带登录态的实例）。插件一旦探测到端口在听就**直接连上去用** —— 如果连上的是别人的
  //    实例，那个实例里的登录态就等于交给机器人了。用一个只有本插件在用的端口，这条
  //    "独立 profile"的安全边界才真的成立。
  port: 9333,
  profileDir: '',
  edgePath: '',
  actions: ALL_ACTIONS.join(','),
  autoLaunch: true,
  sendShotToChat: true,
  onlyWhitelist: true,
  domainAllow: ''
};

/** Edge / Chromium 的常见安装位置（找不到时由设置里的 edgePath 指定）。 */
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

let api = null;
let client = null;
let clientKey = '';
let launching = null;
/** 上一次「启动了浏览器但没就绪」的时刻，用于退避（见 ensureReady）。 */
let launchFailedAt = 0;
/** 启动失败后的退避时长：浏览器起不来时，别每次调用都再 spawn 一个进程。 */
const LAUNCH_FAIL_BACKOFF_MS = 60000;
/**
 * 本插件自己打开/新建的标签 id（8 位），**按会话分开存**（chatKey → tabId）。
 *
 * ⚠️ 为什么必须按会话隔离（2026-10-10 审查）：原来是一个模块级字符串，所有群/好友共用。
 *    白名单里有多个群时，群 A 先 open 了某个页面，群 B 直接 shot 就会截到**群 A 的页面**
 *    并发进群 B；两个会话并行时（宿主按 chatKey 独立调度、允许同时跑），双方的 open
 *    还会互相覆盖，后执行的动作落到先执行那个会话的页面上。
 */
const activeTabs = new Map();

// ── 配置 ──────────────────────────────────────────────────────────────────

/** 布尔判定与核心同口径：配置接口是原样写入的，字符串 "false" / 0 也要按「关」处理。 */
function off(v) {
  return v === false || v === 'false' || v === 0 || v === '0';
}

/** 读插件设置（缺项回落默认值）。 */
function cfg() {
  let raw = {};
  try { raw = (api && typeof api.config === 'function' ? api.config() : null) || {}; } catch { raw = {}; }
  const merged = { ...DEFAULTS, ...raw };
  const port = Number(merged.port);
  return {
    enabled: !off(merged.enabled),
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.floor(port) : DEFAULTS.port,
    profileDir: String(merged.profileDir || '').trim(),
    edgePath: String(merged.edgePath || '').trim(),
    actions: parseActions(merged.actions),
    autoLaunch: !off(merged.autoLaunch),
    sendShotToChat: !off(merged.sendShotToChat),
    onlyWhitelist: !off(merged.onlyWhitelist),
    domainAllow: String(merged.domainAllow || '').trim()
  };
}

/** 逗号/空格/分号分隔的动作名 → 合法动作数组（不认识的直接丢掉）。 */
function parseActions(v) {
  const list = String(v || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return [...ALL_ACTIONS];
  const valid = list.filter((a) => ALL_ACTIONS.includes(a));
  // ⚠️ 填了但一个都不认识（拼错、用了旧名）时**回落为全部**，而不是"一个都不允许"：
  //    后者表现为"工具在、但永远拒绝执行"，用户只会看到"动作没在设置里允许"，
  //    很难想到是自己把动作名写错了。
  if (!valid.length) {
    try { api?.warn?.(`设置里的动作列表（${v}）没有一个能识别，已回落为全部动作`); } catch { /* 日志失败不影响主流程 */ }
    return [...ALL_ACTIONS];
  }
  return valid;
}

/** 只允许访问的域名（逗号分隔；空 = 不限）。 */
function domainList(c) {
  return String(c.domainAllow || '').split(/[,，;；\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(url, c) {
  const list = domainList(c);
  if (!list.length) return { ok: true };
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return { ok: false, reason: `看不懂这个地址：${url}` }; }
  const hit = list.some((d) => host === d || host.endsWith(`.${d}`));
  return hit ? { ok: true } : { ok: false, reason: `域名 ${host} 不在允许列表里（设置 → 插件 → 浏览器 → 只允许访问这些域名）` };
}

// ── 会话白名单（复用核心那份 allow 名单）────────────────────────────────────

/**
 * 当前会话能不能用浏览器能力。
 *
 * 规则与核心一致：群消息看 `allow.groups`、私聊看 `allow.private`；两份名单都空时看
 * `allowAllWhenEmpty`。拿不到核心配置时**按不允许**处理（fail-closed）。
 */
function sessionAllowed(ctx, c) {
  if (c.onlyWhitelist === false) return true;
  try {
    const g = getConfig() || {};
    const allow = g.allow || {};
    const deny = g.deny || {};
    const groups = (Array.isArray(allow.groups) ? allow.groups : []).map(String);
    const privates = (Array.isArray(allow.private) ? allow.private : []).map(String);
    const denyGroups = (Array.isArray(deny.groups) ? deny.groups : []).map(String);
    const denyPrivates = (Array.isArray(deny.private) ? deny.private : []).map(String);
    const key = String(ctx?.chatKey || '');
    const id = key.replace(/^(group|private):/, '');
    const isPrivate = key.startsWith('private:');
    const isGroup = key.startsWith('group:');
    // ⚠️ 黑名单优先：核心 src/app.js 的 allowed() 就是 deny 先判（进了 deny 一律拒），
    //    这里以前只查 allow —— 于是「被拉黑的群」在核心那边不回话，插件这边却照样
    //    允许开网页、截图并发图。名单口径必须与核心逐字一致，别依赖上游顺手拦住。
    const denied = isPrivate ? denyPrivates.includes(id)
      : isGroup ? denyGroups.includes(id)
        : (denyGroups.includes(id) || denyPrivates.includes(id));
    if (denied) return false;
    if (!groups.length && !privates.length) return g.allowAllWhenEmpty === true;
    if (isPrivate) return privates.includes(id);
    if (isGroup) return groups.includes(id);
    return groups.includes(id) || privates.includes(id);
  } catch {
    return false;
  }
}

// ── 浏览器进程 ────────────────────────────────────────────────────────────

function browserDataDir() {
  const root = String(DATA_DIR || '').trim() || path.join(HERE, '..', '..', 'data');
  return path.join(root, SKILL_ID);
}

/** 用哪个 profile：设置里填了就用它，否则用插件自己的独立目录。 */
function profileDirOf(c) {
  return c.profileDir || path.join(browserDataDir(), 'profile');
}

/** 端口是否已经在监听（用 /json/version 探测，不依赖 Get-NetTCPConnection 那类会被沙箱拒的调用）。 */
async function probe(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function findBrowser(explicit) {
  const cands = explicit ? [explicit, ...BROWSER_CANDIDATES] : BROWSER_CANDIDATES;
  for (const p of cands) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return '';
}

/** 连不上时给一条能直接复制的启动命令（跨平台各给一条）。 */
function launchCommand(c) {
  const profile = profileDirOf(c);
  const exe = findBrowser(c.edgePath) || '<你的浏览器可执行文件>';
  if (process.platform === 'win32') {
    return `Start-Process '${exe}' -ArgumentList @('--remote-debugging-port=${c.port}', '--user-data-dir=${profile}', '--no-first-run', '--no-default-browser-check', 'about:blank')`;
  }
  return `'${exe}' --remote-debugging-port=${c.port} --user-data-dir='${profile}' --no-first-run about:blank &`;
}

/**
 * 确保调试端口可用：已经在听就直接用；否则（且允许自动启动时）拉起一个 Edge。
 *
 * ⚠️ 拉起来的 Edge 是**独立 profile**，与用户平时那个浏览器无关 —— 这是刻意的安全边界，
 * 别改成去连用户的日常 profile（那等于把全部登录态交给机器人）。
 */
async function ensureReady(c) {
  if (await probe(c.port)) return { launched: false };
  if (c.autoLaunch === false) {
    const err = new Error(`调试端口 ${c.port} 没在监听，而"自动启动"是关着的。可以先手动启动：\n${launchCommand(c)}`);
    err.code = 'NO_AUTOLAUNCH';
    throw err;
  }
  if (launching) { await launching; return { launched: true, concurrent: true }; }
  // 刚失败过就先不重试：浏览器起不来时（被安全软件拦、端口被占、策略禁用调试端口），
  // 模型每调用一次工具就多堆一个 msedge 进程，而且每次都要白等 15 秒。
  if (launchFailedAt && Date.now() - launchFailedAt < LAUNCH_FAIL_BACKOFF_MS) {
    const waited = Math.round((Date.now() - launchFailedAt) / 1000);
    const left = Math.ceil((LAUNCH_FAIL_BACKOFF_MS - (Date.now() - launchFailedAt)) / 1000);
    const err = new Error(`${waited} 秒前试过启动浏览器但没成功，先不重复启动（再过 ${left} 秒会自动重试一次）。`);
    err.code = 'LAUNCH_BACKOFF';
    throw err;
  }
  launching = (async () => {
    const exe = findBrowser(c.edgePath);
    if (!exe) {
      const err = new Error('找不到 Edge/Chrome 的可执行文件，请在设置里填「Edge 可执行文件路径」');
      err.code = 'NO_BROWSER';
      throw err;
    }
    const profile = profileDirOf(c);
    try { fs.mkdirSync(profile, { recursive: true }); } catch { /* 建不出来就让浏览器自己报错 */ }
    const args = [
      `--remote-debugging-port=${c.port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // ⚠️ 必须禁同步：新 profile 第一次启动时 Edge 会弹"要同步浏览数据吗"的确认页
      //    （页面上带着本机登录的 Microsoft 账号），而且它**会占据默认标签** —— 后面所有
      //    text / eval / shot 都被引到那个对话框上（2026-10-07 实测：读回来的 title 变成
      //    "我们现在正在你的所有设备上同步你的浏览数据"，截图只有 500×450）。
      //    禁掉同步既躲开这个坑，也避免把账号数据同步进机器人的 profile。
      '--disable-sync',
      '--disable-features=msSyncConfirmation,SigninInterception',
      'about:blank'
    ];
    // detached + unref：机器人所在的应用关掉时，别把浏览器一起带走（它是独立 profile，
    // 留着不影响谁）；stdio 全部 ignore，避免管道句柄拖住进程。
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    // 等端口就绪：Edge 冷启动到能应答 /json/version 通常 1~4 秒，给足 15 秒。
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await probe(c.port, 1000)) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    // ⚠️ 超时必须回收自己刚拉起的那个进程：不 kill 的话，在浏览器始终起不来的环境里，
    //    每次调用都会再堆一个 msedge（detached + unref 意味着没人会帮你收）。
    try { child.kill(); } catch { /* 已经自己退了就算了 */ }
    const err = new Error(`启动了浏览器但 ${c.port} 一直没就绪（15 秒），已把它关掉。可以手动检查：\n${launchCommand(c)}`);
    err.code = 'LAUNCH_TIMEOUT';
    throw err;
  })();
  try { await launching; launchFailedAt = 0; } catch (error) { launchFailedAt = Date.now(); throw error; } finally { launching = null; }
  return { launched: true };
}

/** 取（必要时重建）CDP 客户端：端口或 profile 变了就换新实例。 */
function getClient(c) {
  const key = `${c.port}|${profileDirOf(c)}`;
  if (client && clientKey === key) return client;
  if (client) { try { client.close(); } catch { /* 旧实例关掉失败无所谓 */ } }
  client = createCdp({
    port: c.port,
    edgeExecutable: c.edgePath || undefined,
    edgeProfileDir: profileDirOf(c),
    log: (m) => { try { api?.log?.(String(m)); } catch { /* 日志失败不影响主流程 */ } }
  });
  clientKey = key;
  return client;
}

// ── 工具 ──────────────────────────────────────────────────────────────────

/** 把与浏览器有关的错误翻成能直接给模型看的一句话。 */
function browserErrorText(error, c) {
  const code = error?.code || '';
  const msg = String(error?.message || error || '未知错误');
  if (code === 'CDP_UNREACHABLE' || code === 'NO_AUTOLAUNCH' || code === 'LAUNCH_TIMEOUT'
    || code === 'NO_BROWSER' || code === 'LAUNCH_BACKOFF') {
    return `浏览器没就绪：${msg}`;
  }
  if (code === 'CDP_TIMEOUT') return `浏览器操作超时：${msg}`;
  return `浏览器操作失败：${msg}`;
}

function registerBrowserTool() {
  api.registerTool({
    id: 'browser',
    name: '浏览器',
    description: '开一个真实网页（本机 Edge，独立 profile）：抓 JS 渲染后的正文/HTML、截图、必要时滚动点击填表。'
      + '适用：web_fetch 抓回来是空壳或乱码的站点、需要等渲染的页面、想让群友看到页面长什么样（截图发到当前会话）。'
      + '不适用：公开静态页面（web_fetch 更快）、站内搜索（用 web_search）。'
      + 'action=' + ALL_ACTIONS.join('/') + '；截图发群时传 send=true。',
    // ⚠️ 必须是宿主 CATEGORY_META 里的八类之一（messaging/sticker/query/memory/web/
    //    knowledge/media/system）：设置页 ui/app/06-settings-render.js 的分类数组是硬编码的，
    //    写 'utility'（市场分类里有、宿主工具分类里没有）会让这个工具在设置页**没有卡片**，
    //    用户看不到它的单独开关，只能手改 config.json。
    category: 'web',
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '要做什么：tabs=看有哪些标签页；url=当前地址与标题；open=导航当前页到 url；'
            + 'newtab=新开标签；text=页面可见文本；html=页面 HTML；eval=执行一段 JS 并取回结果；'
            + 'a11y=无障碍树；click=点一个元素；fill=填输入框；shot=截图；wait=等条件成立'
        },
        url: { type: 'string', description: 'open/newtab 用：要打开的网址' },
        tab: { type: 'string', description: '标签页 id（tabs 列出来的 8 位）或其前缀；不填用默认页' },
        selector: { type: 'string', description: 'click/fill/wait/shot（按元素截图）用的 CSS 选择器' },
        text: { type: 'string', description: 'fill 用：要填进去的文字' },
        expression: { type: 'string', description: 'eval/wait 用：一段 JS 表达式（支持 await）' },
        timeoutMs: { type: 'integer', description: 'wait 最长等多久（毫秒，默认 15000）' },
        fullPage: { type: 'boolean', description: 'shot 用：true=整页截图（默认只截当前视口）' },
        maxChars: { type: 'integer', description: 'text/html 用：最多返回多少字符（默认 8000，上限 50000）。'
          + '页面很长时先看开头，需要更多再显式调大 —— 不填也一定会有上限，不会把整页塞进来。' },
        maxNodes: { type: 'integer', description: 'a11y 用：最多列多少个节点（默认 120）' },
        frame: { type: 'string', description: 'text/html/eval 用：进哪个 iframe 里取（填 frame 的 url 片段或 id 前缀）。'
          + '跨域 iframe 里的内容在主框架里读不到，只能这样进到那一层' },
        send: { type: 'boolean', description: 'shot 用：true=把这张图直接发到当前会话（群友能看到）' }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      const c = cfg();
      if (c.enabled === false) {
        return { content: '浏览器插件在设置里是关着的（设置 → 插件 → 浏览器）。' };
      }
      if (!sessionAllowed(ctx, c)) {
        return { content: '当前会话不在机器人的白名单里，不能用浏览器能力。' };
      }
      const action = String(args?.action || '').trim();
      if (!ALL_ACTIONS.includes(action)) {
        return { content: `不认识的 action「${action}」。可用：${ALL_ACTIONS.join('、')}` };
      }
      if (!c.actions.includes(action)) {
        return { content: `动作「${action}」没在设置里允许（当前允许：${c.actions.join('、') || '（空）'}）。` };
      }
      if ((action === 'open' || action === 'newtab') && args?.url) {
        const chk = hostAllowed(args.url, c);
        if (!chk.ok) return { content: chk.reason };
      }
      // ⚠️ send 是插件的参数，不往 CDP 传；outPath 是留给 CLI 调试的落盘开关，
      //    模型不该有写文件的能力，一律剔掉（cdp.js 仍支持，宿主内部调用可用）。
      const params = { ...(args || {}) };
      delete params.action;
      delete params.send;
      delete params.outPath;
      // ⚠️ 默认标签必须是**本会话自己打开的那一个**，不能是"第 0 个标签页"：新 profile 首次
      //    启动会自带一个引导页（同步确认 / 欢迎页），它排在 index 0，于是 text / eval / shot
      //    全被引到那个页面上（2026-10-07 实测）。open / newtab 之后记住返回的 tab id，
      //    后续调用默认带上它；调用方显式给了 tab 就听调用方的。
      // ⚠️ 判「有没有给 tab」**不能**用 falsy：`tab: 0` 是合法索引（第 0 个标签页），
      //    而 `!0 === true` 会把它当成「没给」并被默认标签顶掉 —— 模型明确要看第 0 页，
      //    却静默读到别的页面（同 lib/cdp.js:304 的那条告诫）。
      const tabGiven = params.tab !== undefined && params.tab !== null && String(params.tab).trim() !== '';
      const tabKey = String(ctx?.chatKey || '');
      const rememberedTab = activeTabs.get(tabKey) || '';
      if (!tabGiven && rememberedTab && action !== 'tabs' && action !== 'newtab') {
        params.tab = rememberedTab;
      }

      try {
        await ensureReady(c);
      } catch (error) {
        return { content: browserErrorText(error, c) };
      }
      const cdpClient = getClient(c);
      let r;
      try {
        r = await cdpClient.run(action, params);
      } catch (error) {
        return { content: browserErrorText(error, c) };
      }
      let tail = '';
      // 记住"本会话正在用哪个标签"，后续动作默认作用在它上面（见上面的说明）
      if ((action === 'open' || action === 'newtab') && r?.tab) {
        activeTabs.set(tabKey, String(r.tab));
      }
      // domainAllow 只拦得住 open / newtab：eval / click 本身就能让页面跳走
      // （点一个站外链接、location.href = ...）。这里在动作后核对一次当前地址，
      // 越界就在返回里明说 —— 页面已经跳过去了，拦不住，但不能瞒着。
      if (domainList(c).length && (action === 'eval' || action === 'click' || action === 'fill')) {
        try {
          const now = await cdpClient.run('url', params.tab === undefined ? {} : { tab: params.tab });
          const href = String(now?.href || now?.targetUrl || '');
          if (/^https?:/i.test(href) && !hostAllowed(href, c).ok) {
            tail += `\n⚠️ 注意：页面现在在 ${href}，它不在「只允许访问这些域名」的名单里`
              + '（eval/click 这类动作能绕过 open 的域名限制，想彻底锁死就别在动作白名单里放它们）。';
          }
        } catch { /* 核对失败不影响主流程 */ }
      }
      if (action === 'shot' && (args?.send === true || args?.send === 'true')) {
        tail += await sendShot(ctx, c, r);
      }
      const body = String(r?.text ?? '').trim() ? r.text : '（这一步没有返回内容）';
      return { content: `${body}${tail}` };
    }
  });
}

/**
 * 把截图发到当前会话。
 *
 * 发图走核心的 sender.sendImage（`base64://` 是它认的形式，见 src/sender.js）。
 * 单独抽成函数是为了让失败信息只影响这一句，而不是把整个工具调用判成失败。
 */
async function sendShot(ctx, c, r) {
  if (c.sendShotToChat === false) return '\n（设置里关了「允许把截图发到当前会话」，图没发出去）';
  const b64 = String(r?.pngBase64 || '');
  if (!b64) return '\n（这次没拿到图片数据，没发出去）';
  if (!ctx?.sender || typeof ctx.sender.sendImage !== 'function') return '\n（当前会话拿不到发送能力，图没发出去）';
  // ⚠️ 优先落盘再用本地路径发（而不是直接甩 base64），两个原因：
  //   ① 宿主对图片的去重键，dataUrl 取的是「长度 + 前 64 字符」—— 同尺寸的两张截图，
  //      PNG 头（签名 + IHDR）完全一样、压缩后长度也常常撞上，于是 8 秒内连发两张
  //      同尺寸截图时，第二张会被判成「刚发过」直接跳过；file 路径每次都不同。
  //   ② base64 内联进 HTTP body 会放大 1/3 体积，大图很容易撞上协议端 15 秒超时。
  //   宿主 sender.sendImage 在 file 失败时会自动回退 dataUrl，所以两个都给它。
  const file = saveShotFile(b64);
  try {
    await ctx.sender.sendImage(ctx.chatKey, file
      ? { file, dataUrl: `base64://${b64}` }
      : { dataUrl: `base64://${b64}` }, {});
    return '\n（已把这张图发到当前会话）';
  } catch (error) {
    return `\n（发图失败：${error?.message ?? error}）`;
  }
}

/** 把截图存进插件自己的数据目录，返回绝对路径（失败返回空串，调用方会退回 base64）。 */
function saveShotFile(b64) {
  try {
    const dir = path.join(browserDataDir(), 'shots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    // 只留最近 20 张：截图发完就没用了，别让它把磁盘堆满（按文件名排序即时间序）
    const olds = fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort();
    for (const name of olds.slice(0, Math.max(0, olds.length - 20))) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* 删不掉就留着 */ }
    }
    return file;
  } catch {
    return '';
  }
}

// ── 提示词 ────────────────────────────────────────────────────────────────

/**
 * 告诉模型"什么时候该想起浏览器"。
 *
 * 与工具描述的分工：这里是"判断标准"，工具描述是"参数怎么填"。白名单外的会话不加这段
 * （它拿不到工具，就没必要占提示词）。
 */
export function promptSections(context = {}) {
  const c = cfg();
  if (c.enabled === false) return [];
  if (!c.actions.length) return [];
  if (!sessionAllowed(context, c)) return [];
  const lines = [
    '【一个可用的能力】你可以开一个**真实浏览器**（本机 Edge，独立 profile）去看网页。',
    '· 什么时候值得用：web_fetch 抓回来是空壳 / 乱码 / 只有标题；页面内容要靠 JS 渲染；',
    '  需要点一下、翻一页、滚动加载；或者群友想看看某个页面长什么样。',
    '· 群友想看页面时：用 browser 的 action="shot" 并带上 send=true —— 截图会直接发到当前会话。',
    '· 想看视频画面：先 open 视频页，再用 eval 设 `document.querySelector("video").currentTime = 30`，',
    '  等一会儿再 shot（想连声音一起看是做不到的，你只能拿到画面）。',
    '· 别拿它当搜索用：公开静态页面走 web_fetch / web_search，快得多也不占浏览器。',
    '· 它是**独立 profile**：里面没有用户任何账号的登录态，所以需要登录的页面会看到登录墙 ——',
    '  这是刻意的，别去想办法绕过（也不要向群友打听账号密码）。'
  ];
  if (c.actions.some((a) => MUTATING_ACTIONS.includes(a))) {
    lines.push('· 页面操作（eval / click / fill）请只在你确实需要时用，别乱点别人页面上的按钮。');
  }
  return [{ id: 'qq-agent-browser-guide', title: '浏览器能力', priority: 24, content: lines.join('\n') }];
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export async function setup(injected) {
  api = injected;
  registerBrowserTool();
}

export function activate() { /* 懒加载：第一次真正要用时才去探测 / 启动浏览器 */ }

export function deactivate() {
  try { client?.close(); } catch { /* 关不掉就算了 */ }
  client = null;
  clientKey = '';
  // 标签记忆跟着连接一起作废：留着会指向旧实例里已经关掉的标签
  activeTabs.clear();
}

export function dispose() {
  deactivate();
  api = null;
}

/** 没配模型时不必暴露工具（与 bili-daily 同口径）。 */
export function available() {
  // ⚠️ 这里必须一起看插件自己的 enabled：plugin.json 承诺「关掉后工具不再出现在模型手里」，
  //    而宿主正是用 available() 决定工具可不可见的 —— 只在 execute 里拦的话，
  //    模型照样看得见、照样会调用，然后每次都收到一句「插件在设置里是关着的」。
  if (cfg().enabled === false) return { ok: false, reason: '插件在设置里被关掉了' };
  const g = getConfig();
  if (!String(g?.api?.model || '').trim()) return { ok: false, reason: '还没在设置里选择模型' };
  return { ok: true };
}

/**
 * 能力：`browser.session`（只读状态查询）。
 *
 * 声明在 plugin.json 里，这里给出实现 —— 两边一致，加载器就不会报"声明了能力却没有提供
 * 实现"，别的地方也能问一句"浏览器现在是什么状态"。
 */
export const providers = {
  'browser.session': () => {
    const c = cfg();
    return {
      enabled: c.enabled,
      port: c.port,
      profileDir: profileDirOf(c),
      actions: c.actions,
      autoLaunch: c.autoLaunch,
      onlyWhitelist: c.onlyWhitelist,
      connected: Boolean(client),
      // 记住了几个会话的标签（多群场景下排障用：能看出会不会互相串）
      rememberedTabs: activeTabs.size
    };
  }
};

// 供独立自测用
export const internals = { cfg, parseActions, sessionAllowed, hostAllowed, profileDirOf, launchCommand, ALL_ACTIONS, activeTabs, saveShotFile };
