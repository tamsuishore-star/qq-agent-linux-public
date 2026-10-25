// API 余额告急乞讨技能（LLM 型）—— 余额不足时让模型在群里自然地求充值。
//
// ── 设计要点 ──────────────────────────────────────────────────────────────
//   · 为什么是 Skill 不是插件（这条决定了整个形状）：
//       扩展拿不到 sender / onebot —— createSkillApi 只给
//       registerTool / config / fetch / log…（plugin-loader.js:71-133），
//       **唯一能发言的路径是模型的 send_message**；
//       而 hooks 按约定禁网禁发（见 affinity 对 §3.2 的引用），
//       所以"查余额"只能做成工具，在会话里跑。
//   · 读不到全局 baseUrl / apiKey：api.config() 只返回本技能自己的设置，
//       所以接口地址和查询 Key 由用户在控制台填一次（见 README）。
//   · 走 api.fetch —— 只有 manifest 声明了 permissions:["web_fetch"] 才拿得到。
//   · 状态机（模型按返回的第一行 status 行动）：
//       ok              余额够 → 绝口不提钱；顺便清冷却，下次再跌立刻能喊
//       low             低于阈值 → 发一条求充值（**先记冷却再返回**，防连喊）
//       cooling         冷却中 → 当无事发生
//       not-configured  没填接口 → 只回给模型，不进群
//       error           查询失败 → isError，最多让模型再试一次
//   · 冷却落盘在 DATA_DIR（skills/ 之外）：写在技能目录里会触发 fs.watch
//     热重载（plugin-loader.js:565 对 skills/ 递归监听）→ 自己写文件 →
//     自己被重载 → 内存状态清零，是个自激回路。
//   · 余额缓存只放内存：宁可热重载后多查一次，也不要为了缓存去写文件。
//   · 配置一律执行时用 cfg() 现读（setup 时快照会导致改了设置不生效）
//
// ── v1.1.0：改成关键词触发（省 token 的核心改动）──────────────────────────
//   · 旧版在 skill.json 的 prompt.sections 里写"每次开始回复前调用一次"，
//     后果是**每轮一次工具往返** + 每轮 150~200 token 固定片段 —— 这才是费钱的根源，
//     而不是工具本身。v1.1.0 删掉静态片段，改成钩子里**命中关键词才注入**一行指令。
//   · 为什么必须用钩子：skillContext 不含消息文本（orchestrator.js:762-770），
//     所以 promptSections(context) / available(context) 都判断不了"这轮有没有人问余额"；
//     唯一拿得到 messages 的是 before-llm-messages（orchestrator.js:873-879，
//     明确允许原地修改数组，返回值忽略）。
//   · 只匹配【未读信息】那一段（到下一个已知核心段标题为止）：全文匹配会让
//     "10 条之前有人聊过余额"变成误触发，照样每轮烧钱。
//   · 注入追加在消息**末尾** → 系统提示与用户提示前缀一个字节都没动，不破坏前缀缓存。
//   · 钩子禁网禁发（plugin-development.md §3.2），所以命中后仍要走一次工具往返 —— 这是下限，
//     做不到"钩子里查完把余额塞进提示词"。频率靠工具内部的缓存 + 冷却兜底。
//   · 钩子被 5s 超时 / 异常吞掉时的兜底：工具 description 保留一句话语义，模型可自主调用。

const BUILD_TAG = 'v1.1.0';

/** 关键词默认值（与 skill.json 的 settings.triggerKeywords 保持一致）。 */
const DEFAULT_KEYWORDS = '查余额,余额,还剩多少,够不够,钱够吗,没钱了,要充值,快没钱,余额不足';

/** 核心 user prompt 里的分段标记（prompt.js:855 渲染「【未读信息】以下是…」）。 */
const UNREAD_MARKER = '【未读信息】';

/** 已知核心段标题：注入只看【未读信息】到下一个此类标题之间，聊天内容里的【】不参与切割。 */
const CORE_SECTION_RE = /\n【(?:记忆|已读信息|新已读信息|未读信息|新加入成员|当前时间|角色设定|表情包|引导说明)/;

/** 注入用的标记，同时充当幂等判据。 */
const INJECT_TAG = '【触发】';

/** 余额接口的自动探测顺序（balanceUrl 留空时按序试，命中即停）。 */
const CANDIDATE_PATHS = [
  '/user/balance',           // DeepSeek 官方：balance_infos[0].total_balance（不存在时 404 很快）
  '/v1/dashboard/balance',   // new-api 及多数中转站：data.balance
  '/api/user/self',          // 老 one-api：data.quota（额度单位，配 unitScale）
  '/v1/account/balance'      // 部分自建网关
];

/** 返回 JSON 里余额数字的候选路径（balancePath 留空时取第一个能读到数的）。 */
const AUTO_VALUE_PATHS = [
  'data.balance', 'balance', 'data.quota', 'quota',
  'data.credit', 'credit', 'data.remaining_balance', 'remaining_balance',
  // DeepSeek：余额挂在数组里，且是字符串金额（"110.00"，getPath 用下标能穿过数组）
  'balance_infos.0.total_balance'
];

/** 单次请求超时：会话内工具不能挂太久，超了就换下一个候选。 */
const FETCH_TIMEOUT_MS = 5000;

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let fetchFn = () => Promise.reject(new Error('本技能没有 fetch 权限（manifest 缺 permissions）'));

/** 内存态：余额缓存。热重载会清空，可接受（下次重查即可）。 */
let balanceCache = { at: 0, value: null, url: '' };

/** 落盘态：冷却时间 + 上次命中的接口。写 DATA_DIR，避开 skills/ 监听。 */
let stateLoaded = false;
let statePath = '';
let state = { lastBegAt: 0, goodUrl: '' };

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  fetchFn = typeof api.fetch === 'function'
    ? api.fetch
    : () => Promise.reject(new Error('本技能没有 fetch 权限（manifest 缺 permissions）'));

  api.registerTool({
    id: 'check_balance',
    name: '查 API 余额',
    description:
      '查询 API 账户余额，判断要不要在群里求充值。返回第一行是 status：'
      + 'ok = 钱够（绝口不提钱）；low = 低于阈值（按提示发一条求充值）；'
      + 'cooling = 刚说过（当无事发生）；not-configured / error = 出问题（不要在群里提）。'
      + '只在被问到余额、或收到【触发】指令时调用，平时不要调。',
    category: 'system',
    icon: '🪙',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '调用理由，可省略' }
      },
      required: []
    },

    async execute(ctx, args) {
      const reason = String(args?.reason ?? '').slice(0, 200);
      try {
        return await runCheck(reason);
      } catch (error) {
        // 兜底：余额这条支线出任何问题都不能炸掉整个会话
        warn(`余额检查异常：${describe(error)}`);
        return fail(`余额查询失败：${humanize(error)}。不要在群里提这件事。`);
      }
    }
  });

  log(`API 余额乞讨技能已加载（${BUILD_TAG}）`);
}

/** 可用性自检：必须同步返回，绝不联网（manager.js:187-199 只认 false / {ok:false}）。 */
export function available() {
  return { ok: true };
}

// ── 触发钩子 ──────────────────────────────────────────────────────────────
//
// skills/ 导出 hooks 是合法的：plugin-loader.js:436 照收（lint 只警告"没工具"的 skill），
// manager.js:414-429 按名字执行，带 5s 超时 + 错误隔离（抛错只记日志，不影响会话）。
export const hooks = {
  /**
   * 模型拿到 messages 之前的最后一站。命中关键词才追加一行指令；不命中什么都不做（零成本）。
   * 返回值会被忽略 —— 必须原地改数组。
   */
  'before-llm-messages': async (payload) => {
    try {
      injectTrigger(payload);
    } catch (error) {
      // 判定失败 = 本轮不注入，模型仍能靠工具 description 自主调用，不影响会话
      warn(`余额触发判定失败（本次不注入）：${describe(error)}`);
    }
  }
};

/**
 * 关键词 / 主动机会 → 往最后一条 user 消息末尾追加【触发】指令。
 * 纯函数、无共享状态（并发会话安全）、无 IO（远快于 5s 超时）。
 */
function injectTrigger(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages) || !messages.length) return;

  // 只碰最后一条（user prompt）。messages[0] 是核心系统提示，绝对不动。
  const msg = messages[messages.length - 1];
  if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') return;
  if (msg.content.includes(INJECT_TAG)) return;   // 幂等：同一条消息不重复注入

  const s = readSettings();
  const tail = unreadTail(msg.content);

  let text = '';
  if (payload.proactive === true && s.triggerMode === 'keyword+proactive') {
    // 主动机会：平时零成本，这一轮才巡查；ok 就安静结束，别为"钱够"说话
    text = `${INJECT_TAG}（主动机会）巡查一次余额：调用 api-beggar__check_balance。`
      + 'status=ok 就当无事发生、正常结束；status=low 才在当前会话发一条求充值'
      + '（用你的语气、带上真实余额数字，**一条就够**）；'
      + 'status=cooling / not-configured / error 一律安静结束，不要在群里提。';
  } else {
    const hit = pickKeyword(tail, s.triggerKeywords);
    if (!hit) return;
    text = `${INJECT_TAG}有人说「${hit}」，在问余额：调用 api-beggar__check_balance 查一次，`
      + '按返回的 status 简短回答：status=ok 报一下真实余额，**绝口别提工具和阈值**；'
      + 'status=low 就在当前会话发一条求充值的消息（用你的语气、带上真实余额数字，**一条就够**）；'
      + 'status=cooling 说刚查过、别再喊；'
      + 'status=not-configured / error 不要在群里提，也不要重试超过一次。';
  }

  msg.content = `${msg.content}\n\n${text}`;
}

/**
 * 取【未读信息】段的正文：到最后一个标记起、到下一个核心段标题止。
 * 为什么不能拿全文匹配：user prompt 里还带【已读信息】历史，
 * "10 条之前有人聊过余额"会变成误触发，每轮都白烧一次工具往返。
 * 返回 '' 表示切不出来（标记被核心改名了）—— 宁可不触发，也不全文乱匹配。
 */
function unreadTail(content) {
  const i = content.lastIndexOf(UNREAD_MARKER);
  if (i < 0) return '';
  const rest = content.slice(i + UNREAD_MARKER.length);
  const cut = rest.search(CORE_SECTION_RE);
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

/** 在尾段里找第一个命中的关键词（拉丁字母忽略大小写）。 */
function pickKeyword(tail, rawKeywords) {
  if (!tail) return '';
  const hay = tail.toLowerCase();
  for (const kw of splitKeywords(rawKeywords)) {
    if (hay.includes(kw.toLowerCase())) return kw;
  }
  return '';
}

/** 逗号 / 中文逗号 / 顿号 / 分号 / 空格 / 竖线都算分隔符；去空、去重。 */
function splitKeywords(raw) {
  const out = [];
  const seen = new Set();
  for (const piece of String(raw ?? '').split(/[,，、;；|\s]+/)) {
    const kw = piece.trim();
    if (!kw || seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function runCheck(reason) {
  const s = readSettings();
  await loadState();

  if (!s.balanceUrl && !s.baseOrigin) {
    return tell('not-configured',
      '还没配置余额接口：请管理员在技能设置里填「API Base URL」（或直接填「余额接口」）。这件事不要在群里说。');
  }

  const now = Date.now();
  if (balanceCache.value !== null && s.cacheSec > 0 && now - balanceCache.at < s.cacheSec * 1000) {
    return judge(balanceCache.value, s, '缓存命中');
  }

  let got;
  try {
    got = await queryBalance(s);
  } catch (error) {
    log(`余额查询失败：${describe(error)}${reason ? `（调用理由：${reason}）` : ''}`);
    // userFacing 的错误文案在抛出时已经人话化过，别再 humanize 一遍
    // （二次处理会把「HTTP 404 / 连不上」压成笼统的"查不到余额"，丢掉排查线索）
    const text = error?.userFacing ? describe(error) : humanize(error);
    return fail(`余额查询失败：${text}。最多再试一次，不要在群里提这件事。`);
  }

  balanceCache = { at: Date.now(), value: got.value, url: got.url };
  log(`余额查询成功：${got.url} → ${got.value}`);
  return judge(got.value, s, `实时查询 ${got.url}`);
}

/** 拿到余额数字后的判断。返回给模型的文本第一行永远是 status: xxx。 */
function judge(value, s, source) {
  if (!Number.isFinite(value)) {
    return fail(`余额接口返回了数据，但取到的不是数字（${source}）。请管理员填「余额字段」点路径，必要时配「单位换算除数」。`);
  }

  if (value >= s.threshold) {
    // 有人充上了 → 解除冷却，下次再跌可以立刻喊
    if (state.lastBegAt) {
      state.lastBegAt = 0;
      saveState();
    }
    return tell('ok',
      `余额 ${fmt(value)}，高于阈值 ${fmt(s.threshold)}（${source}）。钱够花，什么都别提。`);
  }

  const left = cooldownLeftMs(s.cooldownMin);
  if (left > 0) {
    return tell('cooling',
      `余额 ${fmt(value)} 已低于阈值 ${fmt(s.threshold)}，但 ${Math.max(1, Math.ceil(left / 60000))} 分钟内已经求过一次了，本次当无事发生（${source}）。`);
  }

  if (s.dryRun) {
    return tell('low',
      `【演练模式】余额 ${fmt(value)} < 阈值 ${fmt(s.threshold)}，阈值已被触发，`
      + `但演练模式下你不要为此发言。管理员关掉演练模式后才会真的求充值（${source}）。`);
  }

  // 先记冷却再交给模型：放之后的话，同一次会话里模型可能连喊三次
  markCooldown();
  return tell('low',
    `余额 ${fmt(value)} < 阈值 ${fmt(s.threshold)}。立刻在当前会话发一条求充值的消息：`
    + '用自己的人设说，带上真实余额数字，撒娇/卖惨/玩梗都行，**一条就够**，'
    + `发完调 end_session 收尾（${source}）。`);
}

// ── 余额查询 ──────────────────────────────────────────────────────────────

/**
 * 查余额。显式配置只试一个地址；留空则按候选顺序探测，命中即停。
 * 上次命中过的地址排到最前，避免每次都三连问。
 */
async function queryBalance(s) {
  const urls = buildUrls(s);
  if (!urls.length) throw new Error('没有可用的余额地址（请填 API Base URL 或余额接口）');

  if (state.goodUrl && urls.includes(state.goodUrl)) {
    urls.splice(urls.indexOf(state.goodUrl), 1);
    urls.unshift(state.goodUrl);
  }

  const problems = [];
  for (const url of urls) {
    const path = shortUrl(url, s);
    let res;
    try {
      res = await fetchJson(url, s);
    } catch (error) {
      problems.push(`${path}：${humanize(error)}`);
      continue;
    }
    if (!res.ok) {
      problems.push(`${path}：${describeHttp(res.status)}`);
      continue;
    }
    if (res.json === null || res.json === undefined) {
      problems.push(`${path}：返回的不是 JSON`);
      continue;
    }
    const raw = pickValue(res.json, s);
    if (raw === null) {
      problems.push(`${path}：取不到余额字段`);
      continue;
    }
    const value = raw / s.unitScale;
    if (!Number.isFinite(value)) {
      problems.push(`${path}：余额字段不是数字`);
      continue;
    }
    state.goodUrl = url;
    saveState();
    return { value, url };
  }
  const error = new Error(problems.join('；') || '所有候选接口都不可用');
  error.userFacing = true;   // 文案已经是人话，runCheck 不要再 humanize 一遍
  throw error;
}

/** 错误文案里的地址只留路径：完整 URL 带域名，没必要进会话记录。 */
function shortUrl(url, s) {
  const origin = stripSlash(s.baseOrigin);
  if (origin && url.startsWith(origin)) return url.slice(origin.length) || '/';
  try { return new URL(url).pathname; } catch { return url; }
}

/** HTTP 状态 → 一句能直接照着排查的话。 */
function describeHttp(status) {
  if (status === 401 || status === 403) return `HTTP ${status} 鉴权失败（Key 不对或没权限）`;
  if (status === 404) return `HTTP 404 路径不存在（换一个余额接口候选）`;
  if (status === 429) return `HTTP 429 被限流（调大缓存秒数）`;
  if (status >= 500) return `HTTP ${status} 服务端错误`;
  return `HTTP ${status}`;
}

/** 拼出要试的地址列表。显式 balanceUrl 只给一个；否则按 Base URL + 候选路径。 */
function buildUrls(s) {
  const explicit = s.balanceUrl;
  if (explicit) {
    if (/^https?:\/\//i.test(explicit)) return [explicit];
    const origin = stripSlash(s.baseOrigin);
    // 只填了相对路径却没给 Base URL → 无解，交给上层报"没配置"
    return origin ? [`${origin}${explicit.startsWith('/') ? '' : '/'}${explicit}`] : [];
  }
  const origin = stripSlash(s.baseOrigin);
  if (!origin) return [];
  return CANDIDATE_PATHS.map((p) => `${origin}${p}`);
}

/** 从返回 JSON 里取余额数字。显式 balancePath 只信它，否则按常见写法试。 */
function pickValue(json, s) {
  if (s.balancePath) return toNumber(getPath(json, s.balancePath));
  if (typeof json === 'number') return json;
  if (typeof json === 'string' && json.trim() !== '' && Number.isFinite(Number(json))) return Number(json);
  for (const p of AUTO_VALUE_PATHS) {
    const n = toNumber(getPath(json, p));
    if (n !== null) return n;
  }
  return null;
}

async function fetchJson(url, s) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = { accept: 'application/json' };
    if (s.apiKey) headers.authorization = `Bearer ${s.apiKey}`;
    const res = await fetchFn(url, { headers, signal: controller.signal });
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// ── 冷却 / 状态落盘 ───────────────────────────────────────────────────────

function cooldownLeftMs(cooldownMin) {
  if (!(cooldownMin > 0) || !state.lastBegAt) return 0;
  const end = state.lastBegAt + cooldownMin * 60000;
  return end > Date.now() ? end - Date.now() : 0;
}

function markCooldown() {
  state.lastBegAt = Date.now();
  saveState();
}

/**
 * 状态文件：优先放 DATA_DIR（从核心读，读不到就退回系统临时目录）。
 * 两者都在 skills/ 之外，不会触发热重载。任何失败都退化成纯内存，不抛错。
 *
 * ⚠️ fs/path 必须在这里就备好：saveState 是同步的，靠动态 import 现拿会
 * 拿到 null（Promise 还没解析）→ 第一次 markCooldown 静默写丢，冷却形同虚设。
 */
async function loadState() {
  if (stateLoaded) return;
  stateLoaded = true;

  try { const m = await import('node:fs'); _fs = m.default || m; } catch { _fs = null; }
  try { const m = await import('node:path'); _path = m.default || m; } catch { _path = null; }

  let dir = '';
  try {
    const { DATA_DIR } = await import('../../src/config.js');
    dir = DATA_DIR;
  } catch (error) {
    // 核心目录结构变了/路径不对：退回系统临时目录，功能照常，只是换个落盘位置
    try { const os = await import('node:os'); dir = (os.default || os).tmpdir(); } catch { dir = ''; }
  }
  if (!dir || !_fs || !_path) {
    warn('拿不到可用的落盘目录，冷却只记在内存里（重启/热重载会重置）');
    return;
  }
  statePath = _path.join(dir, 'skill-api-beggar-state.json');

  try {
    const raw = JSON.parse(_fs.readFileSync(statePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      state.lastBegAt = Number(raw.lastBegAt) || 0;
      state.goodUrl = String(raw.goodUrl || '');
    }
  } catch { /* 新文件 / 半截文件：按默认值继续 */ }
}

function saveState() {
  if (!statePath || !_fs || !_path) return;
  try {
    _fs.mkdirSync(_path.dirname(statePath), { recursive: true });
    _fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  } catch (error) {
    warn(`冷却状态落盘失败（下次重启会重置冷却）：${describe(error)}`);
  }
}

/** 由 loadState() 填充；未加载时 saveState 直接跳过。 */
let _fs = null;
let _path = null;

// ── 配置与小工具 ──────────────────────────────────────────────────────────

/** 每次执行现读（用户改完设置立刻生效）。脏值一律回退默认，绝不抛错。 */
function readSettings() {
  const c = cfg() || {};
  const num = (v, d, min) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) return d;
    return n;
  };
  return {
    baseOrigin: String(c.baseOrigin ?? '').trim(),
    balanceUrl: String(c.balanceUrl ?? '').trim(),
    balancePath: String(c.balancePath ?? '').trim(),
    unitScale: num(c.unitScale, 1, 0.000001),
    apiKey: String(c.apiKey ?? '').trim(),
    threshold: num(c.threshold, 5, 0),
    cooldownMin: num(c.cooldownMin, 120, 0),
    cacheSec: num(c.cacheSec, 300, 0),
    // manifest 默认 true；显式 false 才关（'' / undefined 都按默认处理）
    dryRun: c.dryRun !== false,
    // 触发关键词：留空 = 回到默认词表（清空多半是误操作，而不是"彻底不触发"）
    triggerKeywords: String(c.triggerKeywords ?? '').trim() || DEFAULT_KEYWORDS,
    // 触发范围：只认 enum 里的两个值，脏值/缺失按 manifest 默认（keyword+proactive）
    triggerMode: c.triggerMode === 'keyword' ? 'keyword' : 'keyword+proactive'
  };
}

function tell(status, text) {
  return { content: `status: ${status}\n${text}` };
}

/** 失败一律走 isError（不抛错）—— 抛错会被上层兜成通用错误，模型拿不到有用信息。 */
function fail(message) {
  return { content: message, isError: true };
}

function fmt(n) {
  if (!Number.isFinite(Number(n)) ) return String(n);
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function stripSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 点路径取值：'data.balance' → json.data.balance。取不到返回 undefined。 */
function getPath(obj, dotPath) {
  let cur = obj;
  for (const key of String(dotPath).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function describe(error) {
  if (!error) return '未知错误';
  return String(error?.message || error);
}

/** 给模型/群里看的错误文案：去掉可能含内部细节的部分。 */
function humanize(error) {
  const text = describe(error);
  if (/permission|权限|未声明/i.test(text)) return '本技能没有联网权限';
  if (/aborted|abort|超时|timeout|timed out/i.test(text)) return '接口超时了';
  if (/HTTP \d{3}/i.test(text)) return '余额接口返回了错误';
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(text)) return '连不上余额接口';
  if (/取不到余额字段|不是 JSON|不是数字/i.test(text)) return '返回格式对不上（检查余额字段设置）';
  return '查不到余额';
}
