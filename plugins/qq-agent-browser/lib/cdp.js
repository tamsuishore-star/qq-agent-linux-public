/**
 * qq-agent-browser / lib/cdp.js —— 从 `dsh-edge-browser` 移植的 CDP 客户端。
 *
 * 这是什么：
 *   一个零依赖的 Chrome DevTools Protocol 客户端，用来驱动本机 Edge（或任何带
 *   `--remote-debugging-port` 起的 Chromium）：`/json/list` 列标签页，WebSocket 连到某个
 *   目标发 CDP 命令（`Runtime.evaluate` / `Page.navigate` / `Page.captureScreenshot` /
 *   `Input.dispatchMouseEvent` / `Accessibility.getFullAXTree` …）。
 *
 * 依赖什么：
 *   只用 Node 内置能力 —— `globalThis.WebSocket`（Node ≥ 22 自带）、`fetch`、
 *   `node:os` / `node:path` / `node:fs`（仅 `shot` 可选落盘时用）。
 *   不 import 任何 npm 包，也不 import 宿主 `src/*`，所以这个文件能脱离宿主独立测试：
 *     node -e "import('./lib/cdp.js').then((m) => console.log(m.ACTIONS))"
 *
 * 移植时去掉了什么（相对源文件 `dsh-edge-browser/lib/index.js`）：
 *   1. 宿主的工具注册表适配层：`ctx.tools.register`、手写的 PARAMETERS JSON Schema、
 *      `defineEdgeTool` / `presentCall` / `apply(ctx, config)`。
 *   2. 宿主的提示词段：`ctx.systemPrompt.section`、`buildSectionText`、段名与段顺序。
 *   3. 一切与环境变量绑定的路径推导（`defaultEdgeProfile` 读 `DSH_HOME`）——改成显式传参。
 *
 * 移植时改了什么（逐条，都是为了让它在宿主之外能用）：
 *   - 入口从"模块级 options + apply()"改成工厂 `createCdp()`，返回 `{ run, close }`。
 *   - 每个 action 的返回值从"一段给人看的文本"改成 `{ ok: true, text, ...结构化字段 }`，
 *     文本仍在 `text` 里；失败照旧抛错（见下面的失败约定）。
 *   - `shot` 不再要求 `outPath`：默认把 PNG 以 base64 返回（`pngBase64` / `bytes` /
 *     `width` / `height`），`outPath` 降级为可选（给了才落盘）——发到 QQ 要的是 base64。
 *   - 启动命令里的路径改成通用形式（可传 `launcherPath` / `edgeExecutable` / `edgeProfileDir`），
 *     不再写死 `DSH_HOME`。
 *   - 加了 `log` 调用点（原来没有日志口），并给关键错误加 `error.code`。
 *
 * 失败约定：
 *   连不上调试端口的错误带 `error.code = 'CDP_UNREACHABLE'`（宿主可据此提示"要先起 Edge"）；
 *   超时带 `error.code = 'CDP_TIMEOUT'`；其余错误只有 message。
 *
 * @module qq-agent-browser/cdp
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// 为什么零依赖：不 import 任何 npm 包 —— 宿主不必为它装依赖，也不会撞上宿主的插件版本闸门。
// 代价是参数校验得自己做（见 REQUIRED_ARGS / validateCall）。
//
// 为什么是"客户端 + 对象参数"而不是"命令行 + stdout"：
//   受限沙箱下子进程 + 管道捕获会 EPERM（Windows 沙箱的已知边界），而命令行形态的
//   `cdp.mjs` 正好依赖 stdout 回传。这里直接讲 CDP（Node 自带 WebSocket / fetch，仍为零依赖），
//   既不 spawn 子进程，也把参数当结构化值传递——顺带绕开"`cdp.mjs eval` 会吃掉 JS 引号"那个坑。

/** 可用的 action 集合，同时用于参数校验与运行时分发。 */
export const ACTIONS = ['tabs', 'url', 'open', 'newtab', 'text', 'html', 'eval', 'a11y', 'click', 'fill', 'shot', 'wait']

/** 每个 action 必填的参数名，仅用于生成可读错误。 */
export const REQUIRED_ARGS = {
  open: ['url'],
  newtab: ['url'],
  eval: ['expression'],
  click: ['selector'],
  fill: ['selector', 'text'],
}

/**
 * "二选一"必填：`wait` 既没 selector 也没 expression 时无法构造探测条件。
 * 单列出来是因为 REQUIRED_ARGS 的语义是"每个都必填"，装不下这种或关系。
 */
export const REQUIRED_ONE_OF = {
  wait: ['selector', 'expression'],
}

/** Edge 可执行文件路径（标准安装位置），可用 `edgeExecutable` 覆盖。 */
const DEFAULT_EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

/** 标签页短 id 的长度（列出与匹配都用这个长度，便于复制）。 */
const TAB_ID_LENGTH = 8

/** a11y 默认最多列多少个节点。 */
const DEFAULT_MAX_NODES = 120

/** 各 action 等待条件的默认毫秒数。 */
const DEFAULT_WAIT_MS = 15000

/**
 * text / html 没传 maxChars 时的默认上限（字符）。
 *
 * ⚠️ 这个默认值必须有（2026-10-10 审查）：宿主把工具返回的 content 原样塞进模型上下文
 *    （src/orchestrator.js 不做任何截断），而旧代码 `truncate(text, undefined)` 是「不截断」——
 *    对一个大页面调一次 text，就是几十万字符直接进上下文：烧钱、挤掉对话历史，
 *    甚至整个请求 400。8000 字符够模型读懂一页正文，要更多可以显式传 maxChars。
 */
const DEFAULT_TEXT_CHARS = 8000
/** maxChars 的硬上限：再大就不是「读一页」而是「搬整站」了。 */
const MAX_TEXT_CHARS = 50000

//#region CDP 底层（零依赖：只用 Node 内置 fetch / WebSocket）

/**
 * 取一个可用的 WebSocket 实现：**全局优先，`ws` 包兜底**。
 *
 * ⚠️ 不能想当然认为 `globalThis.WebSocket` 一定存在：Node 22+ 才把它做成全局对象，
 *    而宿主可能是 **Electron（内置 Node 20）** —— 实测 QQ Agent 就是这样，报
 *    「WebSocket is not defined」：浏览器明明已经起来了（端口在听、窗口都在），
 *    但每次操作都卡在建连接这一步，用户看到的是"浏览器起不来、页面打不开"。
 *    宿主自己的 package.json 带 `ws` 依赖，所以按"全局优先、`ws` 兜底"取；
 *    两个都拿不到时给一句能看懂的错误，别让它退化成一个莫名的 undefined。
 */
let wsImplPromise = null
async function loadWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  if (wsImplPromise === null) {
    wsImplPromise = (async () => {
      try {
        const mod = await import('ws')
        const impl = mod?.WebSocket ?? mod?.default ?? mod
        if (typeof impl !== 'function') throw new Error('ws 模块没有导出构造函数')
        return impl
      } catch (error) {
        throw new Error(`运行时没有全局 WebSocket，也加载不到 ws 包：${error?.message ?? error}`)
      }
    })()
  }
  return wsImplPromise
}

/**
 * 连不上调试端口时抛的错误。带上可复制的启动命令，避免调用方只会说"失败了"。
 * 刻意写明"调用方自己也能执行"：实测在拿到提权批准后，由 agent 直接跑启动器可以成功绑上端口
 * （受限沙箱下绑不上，是权限不是命令错），省掉一轮"叫用户动手"。
 * @param rt - 运行时配置（端口、可执行文件、profile 目录、启动器路径）。
 * @param cause - 底层错误信息。
 * @returns 带 code 的错误对象。
 */
function unreachableError(rt, cause) {
  // ⚠️ launcherPath 默认是空的：本插件目录里**没有** start-edge.ps1（那是 dsh-edge-browser
  //    的启动器），给出一个不存在的路径只会让人白跑一趟。没有启动器就直接给原始命令。
  const launcherHint = rt.launcherPath
    ? `先直接跑下面这条（幂等：端口在听就秒退并打印「直接复用」，零权限需求）：\n`
      + `  powershell -ExecutionPolicy Bypass -File "${rt.launcherPath}"\n`
      + '（把引号里换成本机启动器脚本的实际路径；如果它不存在，就用下面等价的原始命令：）\n'
    : '可以直接用下面这条命令手动起一个：\n'
  const error = new Error(
    `连不上 Edge 调试端口 127.0.0.1:${rt.port}（${cause}）。` +
      launcherHint +
      `  Start-Process "${rt.edgeExecutable}" -ArgumentList @(\n` +
      `    '--remote-debugging-port=${rt.port}',\n` +
      `    '--user-data-dir=${rt.edgeProfileDir}',\n` +
      `    '--no-first-run', '--no-default-browser-check', 'about:blank')`,
  )
  error.code = 'CDP_UNREACHABLE'
  return error
}

/**
 * 一条到某个调试目标的 CDP 连接。
 */
class CdpSession {
  /**
   * @param wsUrl - 目标的 webSocketDebuggerUrl。
   * @param timeoutMs - 单条命令的默认超时。
   */
  constructor(wsUrl, timeoutMs) {
    this.wsUrl = wsUrl
    this.timeoutMs = timeoutMs
    this.seq = 0
    this.pending = new Map()
    /** CDP 事件监听：method -> Set<handler>。进跨域 iframe 要等 executionContextCreated 才知道 contextId。 */
    this.listeners = new Map()
    this.ws = undefined
  }

  /**
   * 订阅一条 CDP 事件。
   * @param method - 事件方法名，如 Runtime.executionContextCreated。
   * @param handler - 收到事件时调用，参数是事件的 params。
   * @returns 取消订阅的函数。
   */
  on(method, handler) {
    let set = this.listeners.get(method)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  /**
   * 建立 WebSocket 连接。
   * @returns 本对象，便于链式调用。
   */
  async connect() {
    // ⚠️ 必须走 loadWebSocket()，不能裸写 `new WebSocket(...)`：Electron 宿主里没有这个
    //    全局对象（见 loadWebSocket 的注释 —— 实测就是这么挂的）。
    const WS = await loadWebSocket()
    const ws = new WS(this.wsUrl)
    this.ws = ws
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(undefined), { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      // 没有 id 的是事件（CDP 事件不带 id），分发给订阅者。
      if (message.id === undefined) {
        const set = this.listeners.get(message.method)
        if (set === undefined) return
        for (const handler of [...set]) {
          try {
            handler(message.params)
          } catch {
            /* 单个订阅者出错不影响其他 */
          }
        }
        return
      }
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
    return this
  }

  /**
   * 发一条 CDP 命令并等结果。
   * @param method - CDP 方法名。
   * @param params - 方法参数。
   * @param timeoutMs - 超时，默认用构造时给的值。
   * @returns 该命令的 result。
   */
  send(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          const error = new Error(`${method} 超时（${timeoutMs}ms）`)
          error.code = 'CDP_TIMEOUT'
          reject(error)
        }
      }, timeoutMs)
      timer.unref?.()
    })
  }

  /**
   * 在页面里执行 JS 并取回值。
   * @param expression - JS 表达式。
   * @param contextId - 可选：指定执行上下文（进 iframe 时用，来自 executionContextCreated 事件）。
   * @returns 求值结果。
   */
  async evaluate(expression, contextId) {
    const params = {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }
    if (contextId !== undefined) params.contextId = contextId
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', params)
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'JS 执行失败')
    }
    return result.value
  }

  /** 关闭连接。 */
  close() {
    try {
      this.ws?.close()
    } catch {
      /* 关闭失败无所谓 */
    }
  }
}

/**
 * 列出所有 page 类型调试目标。
 * @param rt - 运行时配置。
 * @returns 目标数组。
 */
async function listPages(rt) {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${rt.port}/json/list`)
  } catch (error) {
    throw unreachableError(rt, error.message)
  }
  if (!response.ok) throw new Error(`/json/list 返回 HTTP ${response.status}`)
  return (await response.json()).filter((target) => target.type === 'page')
}

/**
 * 标签页的短 id：CDP target id 的前 8 位。
 * 存在的理由：位置索引跨实例/跨重排并不可靠（同一个 profile 重建实例后 [0]/[1] 可能互换），
 * 而 target id 是稳定的，拿它定位不会指错页面。
 * @param page - CDP 目标。
 * @returns 短 id。
 */
function shortId(page) {
  return String(page.id ?? '').slice(0, TAB_ID_LENGTH)
}

/**
 * 把 `tab` 参数解析成 pages 数组下标。索引与 id 都接受：
 *   - 数字（或纯数字字符串）按索引（只为兼容旧调用，推荐用 id）；
 *   - 其他字符串按短 id 前缀匹配（不区分大小写，用 startsWith，所以复制 8 位或其前缀都行）。
 * @param pages - 当前 page 目标列表。
 * @param tab - 参数 tab，可能是数字、字符串或未提供。
 * @param defaultTab - 未提供时的默认索引。
 * @returns pages 的下标。
 * @throws 找不到时报错，并在消息里列出可选标签页。
 */
function resolveTabIndex(pages, tab, defaultTab) {
  // 注意：0 是合法索引，所以只能判 undefined/null（以及空串），不能用 falsy 判断。
  if (tab === undefined || tab === null) return defaultTab
  if (typeof tab === 'string' && tab.trim() === '') return defaultTab
  if (typeof tab === 'number') {
    if (Number.isInteger(tab) && tab >= 0 && tab < pages.length) return tab
    throw new Error(`没有第 ${tab} 个标签页，当前共 ${pages.length} 个`)
  }
  const text = String(tab).trim()
  // ⚠️ 顺序与长度判定都很要紧：**先按 id 前缀找，短的才当索引**。
  //    CDP 的 target id 是 hex，前 8 位**完全可能全是数字**（实测遇到过 14183171）——
  //    旧实现"纯数字一律当索引"，于是把这种 id 当成"第 14183171 个标签页"直接报错。
  //    但也不能无条件先按 id：索引 "0" 会撞上"id 以 0 开头"的标签页（约 1/16 概率）。
  //    shortId 是 8 位，所以 >=4 位按 id 前缀、1~3 位按索引，两边都不会误伤。
  if (text.length >= 4) {
    const wanted = text.toLowerCase()
    const byId = pages.findIndex((page) => shortId(page).toLowerCase().startsWith(wanted))
    if (byId >= 0) return byId
  }
  if (/^\d+$/.test(text)) {
    const index = Number(text)
    if (index >= 0 && index < pages.length) return index
    throw new Error(`没有第 ${index} 个标签页（也没有 id 以 ${text} 开头的），当前共 ${pages.length} 个`)
  }
  const available = pages.map((page, i) => `[${i}] ${shortId(page)} ${page.title}`).join('; ')
  throw new Error(`找不到 id 以 ${text} 开头的标签页。当前可用：${available}`)
}

/**
 * 摘掉一条会话：从活动集合里移除并关闭。
 * @param rt - 运行时配置。
 * @param session - 要释放的会话。
 */
function release(rt, session) {
  rt.sessions.delete(session)
  session.close()
}

/**
 * 连到指定标签页（按索引或 id）。
 * @param rt - 运行时配置。
 * @param tab - 标签索引或 id 前缀。
 * @returns 会话与目标。
 */
async function attach(rt, tab) {
  const pages = await listPages(rt)
  if (pages.length === 0) throw new Error('没有可用标签页（Edge 里至少留一个窗口）')
  const page = pages[resolveTabIndex(pages, tab, rt.defaultTab)]
  const session = await new CdpSession(page.webSocketDebuggerUrl, rt.timeoutMs).connect()
  // 记进活动集合：close() 时兜底关掉还开着的连接（正常路径由 release 摘除）。
  rt.sessions.add(session)
  return { session, page }
}

/**
 * 睡一会儿。
 * @param ms - 毫秒。
 * @returns 完成后的 promise。
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 等 document.readyState 变成 complete，或超时。
 * @param session - 已连接的会话。
 * @param timeoutMs - 最长等待。
 * @returns 是否在超时前就绪。
 */
async function waitReady(session, timeoutMs = DEFAULT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await session.evaluate('document.readyState')) === 'complete') return true
    } catch {
      /* 导航中会短暂报错，继续等 */
    }
    await sleep(250)
  }
  return false
}

/**
 * 在 frame 树里按 spec 匹配一个 frame。
 * spec 可以是 frame id 的前缀（十六进制）或 url 的子串（不区分大小写）。
 * @param frameTree - Page.getFrameTree 的 frameTree。
 * @param spec - frame 定位。
 * @returns 匹配到的 frame 描述（含 id / url）。
 * @throws 匹配不到时列出可选 frame。
 */
function pickFrame(frameTree, spec) {
  const frames = []
  const walk = (node) => {
    if (node === undefined || node === null || node.frame === undefined) return
    frames.push(node.frame)
    for (const child of node.childFrames ?? []) walk(child)
  }
  walk(frameTree)
  const wanted = String(spec ?? '').trim().toLowerCase()
  if (wanted === '') throw new Error('frame 不能为空')
  const byId = frames.find((frame) => String(frame.id ?? '').toLowerCase().startsWith(wanted))
  if (byId !== undefined) return byId
  const byUrl = frames.find((frame) => String(frame.url ?? '').toLowerCase().includes(wanted))
  if (byUrl !== undefined) return byUrl
  const available = frames
    .map((frame) => `${String(frame.id ?? '').slice(0, TAB_ID_LENGTH)} ${frame.url}`)
    .join('; ')
  throw new Error(`找不到匹配的 iframe: ${spec}。当前 frame：${available}`)
}

/**
 * 取某个 frame 的执行上下文 id。
 *
 * 跨域 iframe 在主框架里用 JS 摸不到（同源策略），只能让 CDP 到那个 frame 的 executionContext
 * 里执行。`Runtime.enable` 会为已存在的上下文补发 `executionContextCreated` 事件，
 * 因此按 `auxData.frameId` 认领即可（不必自己维护 context 生命周期）。
 * @param session - 已连接的会话。
 * @param frameId - 目标 frame id。
 * @returns contextId。
 */
async function contextIdForFrame(session, frameId) {
  const found = { id: undefined }
  const off = session.on('Runtime.executionContextCreated', (params) => {
    const context = params?.context
    if (context === undefined || context === null) return
    if (String(context.auxData?.frameId ?? '') === String(frameId)) found.id = context.id
  })
  try {
    await session.send('Runtime.enable')
    const deadline = Date.now() + 2000
    while (found.id === undefined && Date.now() < deadline) await sleep(50)
  } finally {
    off()
  }
  if (found.id === undefined) throw new Error(`拿不到该 iframe 的执行上下文（可能已销毁）：${frameId}`)
  return found.id
}

/**
 * 连接标签页；给了 frame 就再解析出该 iframe 的执行上下文。
 * @param rt - 运行时配置。
 * @param args - 调用参数（用到 tab / frame）。
 * @returns 会话、目标页与可选的 contextId。
 */
async function attachWithContext(rt, args) {
  const { session, page } = await attach(rt, args.tab)
  if (typeof args.frame !== 'string' || args.frame.trim() === '') return { session, page, contextId: undefined }
  try {
    const { frameTree } = await session.send('Page.getFrameTree')
    const frame = pickFrame(frameTree, args.frame)
    const contextId = await contextIdForFrame(session, frame.id)
    return { session, page, contextId }
  } catch (error) {
    release(rt, session)
    throw error
  }
}

/**
 * 从 PNG 字节里读真实像素尺寸。
 *
 * 为什么自己读 IHDR：`Page.captureScreenshot` 只回 base64，不回尺寸；而 clip 用的是 CSS 像素，
 * 在有缩放（devicePixelRatio ≠ 1）时和实际图片像素不一致。IHDR 里的是真尺寸。
 * PNG 结构固定：8 字节签名 + 4 字节长度 + 'IHDR' + 宽(4) + 高(4)。
 * @param buffer - PNG 字节。
 * @returns 尺寸；不是 PNG 时返回 undefined。
 */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * shot 的 fullPage 是否要整页：模型经常把布尔写成字符串 "true" 或 1，
 * 严格比 === true 会让它「说了整页却只截到视口」，这里统一按真值处理。
 * @param v - 调用方给的值。
 * @returns 是否整页截图。
 */
function fullPageWanted(v) {
  return v === true || v === 1 || v === 'true' || v === '1'
}

/**
 * 按最大字符数截断并标注原始长度。
 * @param text - 原文。
 * @param max - 上限；0 或 undefined 表示不截断（调用方**必须**先过 limitOf() 兜底，
 *   见 DEFAULT_TEXT_CHARS：把 undefined 直接透进来等于没有上限）。
 * @returns 展示文本。
 */
function truncate(text, max) {
  if (!max || text.length <= max) return text
  return `${text.slice(0, max)}\n…[截断，共 ${text.length} 字符]`
}

/**
 * 把调用方给的 maxChars 夹到合法区间；没给就用默认上限。
 * @param maxChars - 模型/调用方传的上限，可能是 undefined / 字符串 / 越界值。
 * @returns 实际使用的字符上限（永远是一个正数）。
 */
function limitOf(maxChars) {
  const n = Number(maxChars)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TEXT_CHARS
  return Math.max(200, Math.min(MAX_TEXT_CHARS, Math.floor(n)))
}

//#endregion

//#region 各 action 的实现

/**
 * 执行一次调用。
 * @param rt - 运行时配置。
 * @param action - 动作名。
 * @param args - 已校验的参数。
 * @returns 该 action 的结果字段（`ok` / `action` 由 run() 补上）。
 */
async function runAction(rt, action, args) {
  const tab = args.tab

  switch (action) {
    case 'tabs': {
      const pages = await listPages(rt)
      if (pages.length === 0) return { text: '（没有标签页）', tabs: [] }
      // 默认标签要夹在有效范围内：页数可能比 defaultTab 少（关到只剩一页时很常见）。
      const fallback = Math.min(Math.max(rt.defaultTab, 0), pages.length - 1)
      const lines = pages.map(
        (page, index) =>
          `${index === fallback ? '*' : ' '} [${index}] id=${shortId(page)} ${page.title}\n      ${page.url}`,
      )
      const tabs = pages.map((page, index) => ({
        index,
        id: shortId(page),
        title: page.title,
        url: page.url,
        default: index === fallback,
      }))
      return { text: `${lines.join('\n')}\n（* = 省略 tab 时的默认标签，现在是第 ${fallback} 个）`, tabs }
    }

    case 'url': {
      const { session, page } = await attach(rt, tab)
      try {
        const href = await session.evaluate('location.href')
        const title = await session.evaluate('document.title')
        return {
          text: `[${shortId(page)}] ${title}\n${href}\n(目标地址 ${page.url})`,
          tab: shortId(page),
          title,
          href,
          targetUrl: page.url,
        }
      } finally {
        release(rt, session)
      }
    }

    case 'open': {
      const { session, page } = await attach(rt, tab)
      try {
        await session.send('Page.enable')
        await session.send('Page.navigate', { url: args.url })
        const ready = await waitReady(session, rt.timeoutMs)
        const title = await session.evaluate('document.title')
        return {
          text: `已导航到 ${args.url}\n标签 id=${shortId(page)}\n标题: ${title}\n就绪: ${ready ? 'complete' : '超时（可能仍在加载）'}`,
          tab: shortId(page),
          url: args.url,
          title,
          ready,
        }
      } finally {
        release(rt, session)
      }
    }

    case 'newtab': {
      const response = await fetch(
        `http://127.0.0.1:${rt.port}/json/new?${encodeURIComponent(args.url)}`,
        { method: 'PUT' },
      ).catch((error) => {
        throw unreachableError(rt, error.message)
      })
      if (!response.ok) throw new Error(`新建标签页失败: HTTP ${response.status}`)
      const target = await response.json()
      const id = String(target.id ?? '').slice(0, TAB_ID_LENGTH)
      return { text: `已新开标签页 id=${id}: ${target.url ?? args.url}`, tab: id, url: target.url ?? args.url }
    }

    case 'text': {
      const { session, contextId } = await attachWithContext(rt, args)
      try {
        const body = await session.evaluate('document.body ? document.body.innerText : ""', contextId)
        const bodyText = String(body ?? '')
        const limit = limitOf(args.maxChars)
        return { text: truncate(bodyText, limit), length: bodyText.length, limit, truncated: bodyText.length > limit }
      } finally {
        release(rt, session)
      }
    }

    case 'html': {
      const { session, contextId } = await attachWithContext(rt, args)
      try {
        const markup = String(await session.evaluate('document.documentElement.outerHTML', contextId) ?? '')
        const limit = limitOf(args.maxChars)
        return { text: truncate(markup, limit), length: markup.length, limit, truncated: markup.length > limit }
      } finally {
        release(rt, session)
      }
    }

    case 'eval': {
      const { session, contextId } = await attachWithContext(rt, args)
      try {
        const value = await session.evaluate(args.expression, contextId)
        // undefined 不是合法 JSON：JSON.stringify(undefined) 返回 undefined（不是字符串），
        // 交给调用方会变成 "undefined" 或空。这里显式回落，保持"总能拿到一段文本"。
        const rendered =
          typeof value === 'string' ? value : (JSON.stringify(value, undefined, 2) ?? String(value))
        return { text: rendered, value }
      } finally {
        release(rt, session)
      }
    }

    case 'a11y': {
      // 节点数上限：此前借用 maxChars（描述说是字符数，实际当节点数用），语义不符，后正名为 maxNodes。
      const maxNodes = typeof args.maxNodes === 'number' && args.maxNodes > 0 ? args.maxNodes : DEFAULT_MAX_NODES
      const { session } = await attach(rt, tab)
      try {
        await session.send('Accessibility.enable')
        const { nodes } = await session.send('Accessibility.getFullAXTree')
        const rows = []
        for (const node of nodes) {
          const role = node.role?.value
          const label = node.name?.value?.trim()
          if (!label) continue
          if (['generic', 'none', 'InlineTextBox', 'StaticText'].includes(role)) continue
          const properties = Object.fromEntries(
            (node.properties ?? [])
              .filter((entry) => ['checked', 'disabled', 'expanded', 'focused', 'required'].includes(entry.name))
              .map((entry) => [entry.name, entry.value?.value]),
          )
          const keys = Object.keys(properties)
          const extra = keys.length > 0
            ? ` {${keys.map((key) => `${key}=${properties[key]}`).join(' ')}}`
            : ''
          rows.push(`${role}: ${label}${extra}`)
          if (rows.length >= maxNodes) break
        }
        return {
          text: rows.length > 0 ? rows.join('\n') : '（无障碍树里没有带名称的节点）',
          nodes: rows.length,
        }
      } finally {
        release(rt, session)
      }
    }

    case 'click': {
      const { session } = await attach(rt, tab)
      try {
        const raw = await session.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(args.selector)})
          if (!el) return null
          el.scrollIntoView({ block: 'center', inline: 'center' })
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return 'ZERO'
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
        })()`)
        if (raw === null) throw new Error(`找不到元素: ${args.selector}`)
        if (raw === 'ZERO') throw new Error(`元素不可见（尺寸为 0）: ${args.selector}`)
        const { x, y } = JSON.parse(raw)
        // 走真实输入事件（而不是 el.click()）：才等价于用户点击，能过掉只认 pointer 事件的组件。
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        return { text: `已点击 ${args.selector} @ (${Math.round(x)}, ${Math.round(y)})`, x, y }
      } finally {
        release(rt, session)
      }
    }

    case 'fill': {
      const { session } = await attach(rt, tab)
      try {
        // 走原型上的 value setter（而不是 el.value = ...）：React/Vue 那类受控组件自己劫持了
        // 实例上的 value，直接赋值不会触发它们的 onChange；改原型 setter 后再补发 input/change 才行。
        const ok = await session.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(args.selector)})
          if (!el) return false
          const value = ${JSON.stringify(args.text)}
          el.focus()
          // 1) <select>：按 value 或可见文本选中（不处理的话它会走下面 input 的分支，静默失败）
          if (el instanceof HTMLSelectElement) {
            const opt = [...el.options].find((o) => o.value === value || String(o.textContent || '').trim() === value)
            if (!opt) return 'NO_OPTION'
            el.value = opt.value
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          }
          // 2) 可编辑容器（contenteditable）：富文本编辑器基本都是这类，它们没有 value 属性
          if (el.isContentEditable) {
            el.textContent = value
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          }
          // 3) input / textarea：走原型上的 value setter（React/Vue 那类受控组件劫持了实例上的
          //    value，直接赋值不会触发它们的 onChange —— 改原型 setter 后再补发事件才行）
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (setter) setter.call(el, value)
          else if ('value' in el) el.value = value
          else return 'NOT_FILLABLE'
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        })()`)
        if (ok === false) throw new Error(`找不到元素: ${args.selector}`)
        if (ok === 'NO_OPTION') throw new Error(`这个下拉框里没有匹配「${args.text}」的选项: ${args.selector}`)
        if (ok === 'NOT_FILLABLE') throw new Error(`这个元素不能填文字（既不是输入框也不是可编辑区域）: ${args.selector}`)
        return { text: `已填入 ${args.selector}` }
      } finally {
        release(rt, session)
      }
    }

    case 'shot': {
      const { session } = await attach(rt, tab)
      try {
        const shotParams = { format: 'png' }
        const wantElement = typeof args.selector === 'string' && args.selector.trim() !== ''
        if (wantElement) {
          // 元素截图：先量出元素在**页面坐标系**（含滚动量）里的位置，再让 CDP 按 clip 截。
          const raw = await session.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(args.selector)})
            if (!el) return null
            el.scrollIntoView({ block: 'center', inline: 'center' })
            const r = el.getBoundingClientRect()
            return JSON.stringify({
              x: r.left + window.scrollX,
              y: r.top + window.scrollY,
              width: r.width,
              height: r.height,
            })
          })()`)
          if (raw === null) throw new Error(`找不到元素: ${args.selector}`)
          const rect = JSON.parse(raw)
          if (rect.width < 1 || rect.height < 1) throw new Error(`元素不可见（尺寸为 0）: ${args.selector}`)
          shotParams.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
          shotParams.captureBeyondViewport = true
        } else if (fullPageWanted(args.fullPage)) {
          // 整页截图：不给 clip 时视口外会是空白，所以按内容尺寸显式给。
          const metrics = await session.send('Page.getLayoutMetrics')
          const size = metrics.cssContentSize ?? metrics.contentSize
          shotParams.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
          shotParams.captureBeyondViewport = true
        } else {
          shotParams.captureBeyondViewport = false
        }
        const { data } = await session.send('Page.captureScreenshot', shotParams)
        const buffer = Buffer.from(data, 'base64')
        const size = pngSize(buffer)
        const what = wantElement ? `元素 ${args.selector}` : fullPageWanted(args.fullPage) ? '整页' : '视口'
        const result = {
          text: `截图完成（${what}）：${size ? `${size.width}×${size.height}` : '?'} 像素，${buffer.length} 字节`,
          pngBase64: data,
          mimeType: 'image/png',
          bytes: buffer.length,
          width: size?.width,
          height: size?.height,
          what,
        }
        // outPath 是可选的：宿主（QQ 那边）要 base64，CLI 调试时才落盘。
        if (typeof args.outPath === 'string' && args.outPath.trim() !== '') {
          mkdirSync(dirname(args.outPath), { recursive: true })
          writeFileSync(args.outPath, buffer)
          result.outPath = args.outPath
          result.text += `，已保存: ${args.outPath}`
        }
        return result
      } finally {
        release(rt, session)
      }
    }

    case 'wait': {
      // 等条件成立：SPA 的关键数据常在 readyState === complete 之后才注入（实测某视频站
      // 的 __playinfo__ 就是）。参数校验放在连接之前：输入不合法时不该先撞"连不上端口"。
      const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : rt.timeoutMs
      const probe =
        typeof args.selector === 'string' && args.selector.trim() !== ''
          ? `!!document.querySelector(${JSON.stringify(args.selector)})`
          : typeof args.expression === 'string' && args.expression.trim() !== ''
            ? `!!(${args.expression})`
            : null
      if (probe === null) throw new Error('wait 需要 selector 或 expression 之一')
      const { session } = await attach(rt, tab)
      try {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
          let hit = false
          try {
            hit = (await session.evaluate(probe)) === true
          } catch {
            /* 导航/重载中求值会报错，等下一轮 */
          }
          const waitedMs = Date.now() - started
          const what = args.selector ?? args.expression
          if (hit) return { text: `条件已满足（等了 ${waitedMs}ms）：${what}`, waitedMs }
          await sleep(250)
        }
        const error = new Error(`等待超时（${timeoutMs}ms）：${args.selector ?? args.expression}`)
        error.code = 'CDP_TIMEOUT'
        throw error
      } finally {
        release(rt, session)
      }
    }

    default:
      throw new Error(`未知 action: ${action}`)
  }
}

//#endregion

//#region 参数校验与入口

/**
 * 把调用方给的参数规整成一个对象。
 * @param params - 任意值。
 * @returns 参数对象。
 */
function normalizeArgs(params) {
  return params !== null && typeof params === 'object' ? params : {}
}

/**
 * 校验一次调用。语义与源文件的调用前校验一致（含 tab 的形状检查）。
 * @param action - 动作名。
 * @param args - 调用参数。
 */
function validateCall(action, args) {
  for (const key of REQUIRED_ARGS[action] ?? []) {
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`action "${action}" 需要非空参数 ${key}`)
    }
  }
  const oneOf = REQUIRED_ONE_OF[action] ?? []
  if (oneOf.length > 0 && !oneOf.some((key) => typeof args[key] === 'string' && args[key].trim() !== '')) {
    throw new Error(`action "${action}" 需要 ${oneOf.join(' 或 ')} 之一`)
  }
  if (args.tab !== undefined && args.tab !== null) {
    const text = typeof args.tab === 'string' ? args.tab.trim() : undefined
    // 索引：整数，或纯数字字符串
    const isIndex = typeof args.tab === 'number' ? Number.isInteger(args.tab) : text !== undefined && /^\d+$/.test(text)
    // id：至少 4 位的十六进制前缀。
    // ⚠️ 刻意**不要求含数字**（2026-10-10 审查）：target id 是 hex，前 8 位完全可能全是
    //    字母（如 "abcdefab"，概率约 1/2557），而 tabs 会把它照样列出来 —— 要求含数字
    //    等于「tabs 列出的 id 被自己拒绝」；更糟的是一旦这个 id 被记成默认标签，
    //    此后每个动作都会卡在参数校验这一步。长度 >= 4 已经足够把 "abc"/"dead" 这类
    //    普通词挡在外面（它们不是 4 位以上全 hex）。
    const isId = text !== undefined && /^[0-9a-fA-F]{4,}$/.test(text);
    if (!isIndex && !isId) {
      throw new Error('tab 必须是整数索引，或 tabs 列出的 8 位 id（至少 4 位十六进制且含数字）')
    }
  }
}

/**
 * 建一个 CDP 客户端。
 *
 * @param options - 配置。
 * @param options.port - 调试端口，默认 9222。
 * @param options.log - 日志函数，默认丢弃；调用点很少（每次 run 一条，失败前一条）。
 * @param options.timeoutMs - 单条 CDP 命令与等待类 action 的默认超时，默认 15000。
 * @param options.defaultTab - 省略 `tab` 时用第几个标签页，默认 0。列表页数不够时会夹到最后一页。
 * @param options.edgeExecutable - 报"连不上"时给出的 Edge 路径，默认标准安装位置。
 * @param options.edgeProfileDir - 报"连不上"时给出的数据目录，默认 `<home>/.edge-agent-profile`。
 *   注意：它只是**打印在错误信息里**，本模块不会去启动 Edge。
 * @param options.launcherPath - 报"连不上"时给出的启动器脚本路径；默认空字符串（本插件不带
 *   启动器脚本，为空时错误信息里就直接给原始启动命令）。
 * @returns `{ run(action, params), close() }`。
 */
export function createCdp({
  port = 9222,
  log = () => {},
  timeoutMs = DEFAULT_WAIT_MS,
  defaultTab = 0,
  edgeExecutable = DEFAULT_EDGE_EXE,
  edgeProfileDir = join(homedir(), '.edge-agent-profile'),
  launcherPath = '',
} = {}) {
  const rt = {
    port,
    timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_MS,
    defaultTab: typeof defaultTab === 'number' && Number.isInteger(defaultTab) && defaultTab >= 0 ? defaultTab : 0,
    edgeExecutable,
    edgeProfileDir,
    launcherPath,
    sessions: new Set(),
    closed: false,
  }

  /** 日志永远不能反过来弄挂调用：log 抛错只当没写。 */
  const writeLog = (message) => {
    if (typeof log !== 'function') return
    try {
      log(message)
    } catch {
      /* 宿主日志出错与本模块无关 */
    }
  }

  return {
    /**
     * 跑一个 action。
     * @param action - ACTIONS 之一。
     * @param params - 该 action 的参数。
     * @returns `{ ok: true, action, text, ...结构化字段 }`。
     * @throws 参数不合法、连不上、CDP 报错或超时时抛错，不返回 `ok: false`。
     */
    async run(action, params = {}) {
      if (rt.closed) throw new Error('这个 CDP 客户端已经 close() 了，请重新 createCdp()')
      if (typeof action !== 'string' || !ACTIONS.includes(action)) {
        throw new Error(`action 必须是 ${ACTIONS.join(' / ')} 之一，收到 ${JSON.stringify(action)}`)
      }
      const args = normalizeArgs(params)
      validateCall(action, args)
      writeLog(`cdp ${action}${args.tab === undefined ? '' : ` tab=${args.tab}`}`)
      try {
        const result = await runAction(rt, action, args)
        return { ok: true, action, ...result }
      } catch (error) {
        writeLog(`cdp ${action} 失败：${error?.message ?? error}`)
        throw error
      }
    },

    /**
     * 关掉所有还开着的连接。正常路径里每个 action 用完就关，这里是兜底（比如中途被中断）。
     * @returns 完成后的 promise。
     */
    async close() {
      rt.closed = true
      for (const session of [...rt.sessions]) session.close()
      rt.sessions.clear()
    },
  }
}

//#endregion

/**
 * 仅供测试的内部出口（不参与对外契约，加进来是为了让纯函数能被直接断言）。
 */
export const __internals = {
  pngSize,
  pickFrame,
  resolveTabIndex,
  shortId,
  truncate,
  unreachableError,
}
