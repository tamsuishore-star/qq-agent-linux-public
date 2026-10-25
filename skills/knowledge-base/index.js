// 专业知识库 —— 编程 / 网络工程知识检索。
//
// ── 定位 ─────────────────────────────────────────────────────────────────
// 这是一个 **LLM 型 Skill**（放 skills/），因为它唯一的对外形态就是"给模型一个
// 查询工具"。按加载器的约定：只有 registerTool 注册的工具才会进模型的 function
// 列表；只写 providers 的模块对模型完全隐形。
//
// ── 数据从哪来 ───────────────────────────────────────────────────────────
// 内置 kb-data.jsonl，每行一条 {id,title,term,body,tags,source}。语料从以下
// 开源项目清洗而来（许可证见 skill.json 的 description）：
//   原有（2026-09）：
//     tldr-pages                      CC-BY-4.0   命令速查
//     Node.js glossary                MIT         Node.js 术语
//     chinese-computer-science-terms  MIT         中英术语对照
//     Networking 101 GCP sheet        CC0-1.0     网络工程术语
//     JavaGuide                       Apache-2.0  计算机基础概念
//     javascript-questions            MIT         JavaScript 概念
//   C++ / Python 新增（2026-10）：
//     python-docs-zh-cn@3.13  PSF+CC0    Python 官方文档中文版（.po 抽取）
//     modern-cpp-tutorial     MIT        现代 C++ 教程（中英双语）
//     modern-cpp-cheatsheet   MIT        现代 C++ 速查
//     CPP_Glossary            MIT        C++ 术语
//     python_learners_glossary CC0-1.0   Python 术语
//     ultimate-python         MIT        Python 入门指南
//     learn-python            MIT        Python 代码示例
//   Kotlin 新增（2026-10）：
//     kotlin-web-site         Apache-2.0 Kotlin 官方文档（docs/topics/*.md，英文）
//     kotlin-by-example       MIT        Kotlin 官方示例教程
//   manual —— 人工撰写的高频概念兜底条目（含 C++/Python/Kotlin 核心概念）
//
// ⚠ 新增来源时**必须同步三处**，否则会静默降级（不是报错）：
//     1. lib/index-engine.mjs 的 SOURCE_WEIGHT —— 不写就按 1.0 算
//     2. 本文件下文的 SOURCE_LABEL     —— 不写模型看到的是原始 source key
//     3. skill.json 的 description / configSchema.sources —— 不写用户读不到
//
// ⚠ .po 语料的坑（python-docs-zh-cn）：中文正文只在**版本分支**（3.13），
//   main 分支只有翻译流水线；文件头有 Project-Id-Version 等元数据必须滤掉；
//   译者用 `!` 前缀禁用角色链接（`:mod:`!socket`` → `!socket`）要去掉；
//   分块靠位置注释 `#: ../../library/x.rst:45` 的行号回退来切。
//
// ⚠ Kotlin 是**英文原文**（官方不发中文译文到公开仓库，译文托管在 Crowdin）。
//   所以清洗时把中文主题词写进 title/term/tags（覆盖率 95%），
//   否则中文提问（「协程」「空安全」）一个字都命中不了。
//   另外 kotlin-web-site 整个 tarball 有 1.27 GB，但文档正文只有 1.2 MB ——
//   不要下整包，走 fetch-kotlin-docs.py 逐个拉 raw 文件（见该脚本注释）。
//
// ── 为什么要落盘一个 jsonl 而不是把语料写进代码 ──────────────────────────
// 语料会随上游更新而变，且体量上千条。写进 index.js 会让代码文件不可读、
// 也让"换一批语料"变成"改代码"。jsonl 一行一条，天然可 diff、可增量替换。
//
// ── 索引策略 ─────────────────────────────────────────────────────────────
// 启动时在内存建倒排索引（实测 1.2 万条 / ~600ms）。刻意**不落盘索引**：
// 落盘会引入"索引版本与代码不同步"这类难查问题（改了权重忘了重建，表现是
// 结果说不通）。启动重建，永远一致。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeIndex } from './lib/index-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(HERE, 'kb-data.jsonl');

/** 来源名称（给模型看的人类可读名） */
const SOURCE_LABEL = {
  'manual': '核心概念（人工整理）',
  'tldr': 'tldr 命令速查',
  'cs-terms': '计算机术语对照',
  'node-glossary': 'Node.js 官方术语表',
  'net101': '网络工程术语',
  'javaguide': 'JavaGuide 计算机基础',
  'jsq': 'JavaScript 概念问答',
  // C++ / Python（2026-10 新增）
  'cpp-tutorial': '现代 C++ 教程',
  'cpp-glossary': 'C++ 术语',
  'cpp-cheatsheet': '现代 C++ 速查',
  'py-docs': 'Python 官方文档',
  'py-glossary': 'Python 术语',
  'py-tutorial': 'Python 入门指南',
  'py-cheatsheet': 'Python 代码示例',
  'k-docs': 'Kotlin 官方文档',
  'k-example': 'Kotlin 官方示例',
};

let api = null;
let cfg = () => ({});
let log = () => {};
let index = new KnowledgeIndex();
let loadError = '';

// ── 数据加载 ─────────────────────────────────────────────────────────────

function loadItems() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`找不到语料文件：${DATA_FILE}`);
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const items = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      items.push(JSON.parse(s));
    } catch {
      // 单行坏了不该拖垮整库：跳过并继续（否则一行格式错误 = 知识库整体不可用）
    }
  }
  return items;
}

/** 建索引。可用则返回 true。 */
function rebuild() {
  try {
    const items = loadItems();
    const stats = index.build(items);
    loadError = '';
    log(`[knowledge-base] 索引就绪：${stats.docs} 条 / ${stats.tokens} 词 / ${stats.postings} 倒排项`);
    return true;
  } catch (error) {
    loadError = String(error?.message ?? error);
    log(`[knowledge-base] 索引构建失败：${loadError}`);
    return false;
  }
}

// ── 检索封装 ─────────────────────────────────────────────────────────────

/**
 * 解析来源白名单。空串 = 不过滤。
 * 接受逗号/中文逗号分隔；只保留已知来源，未知的忽略（避免写错了静默变成"搜不到"）。
 */
function sourceWhitelist() {
  const raw = String(cfg().sources ?? '').trim();
  if (!raw) return null;
  const known = new Set(Object.keys(SOURCE_LABEL));
  const list = raw.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  const valid = list.filter((s) => known.has(s));
  return valid.length ? new Set(valid) : null;
}

/**
 * 判断查询是否值得检索。
 *
 * 为什么需要：模型偶尔会把闲聊也丢进来（实测「你好呀今天天气不错」会命中
 * osascript 命令速查），返回的内容会诱导它在闲聊里突然念技术名词，非常突兀。
 *
 * 判定分两段：
 *   A. 结构判定（不查索引，快）：纯叠字（「哈哈哈哈」「emmm」）直接拒；
 *   B. 分数判定（查完再定）：首条分数低于 SOFT_SCORE_FLOOR 的视为闲聊。
 *      实测闲聊普遍落在 9~21 分，技术问题在 100 分以上，四十是安全的分离线。
 */
const SOFT_SCORE_FLOOR = 40;

function isChitchatShape(q) {
  const s = q.replace(/[\s，。！？~,.!?]/g, '');
  if (s.length < 2) return true;
  // 全叠字：只有一个不同字符（哈哈哈哈 / 嘿嘿嘿 / emmm 归一后也是）
  if (new Set(s).size === 1) return true;
  return false;
}

/** 执行一次检索，返回 {results, relaxed, whitelist} */
function doSearch(query, limitOverride) {
  const c = cfg();
  const q = String(query ?? '').trim();
  if (q.length < Number(c.minQueryLen ?? 2)) {
    return { results: [], reason: `查询太短（少于 ${c.minQueryLen ?? 2} 字），不做检索` };
  }
  if (isChitchatShape(q)) {
    return { results: [], reason: '这看起来是随口闲聊' };
  }

  const wl = sourceWhitelist();
  const limit = Math.max(1, Math.min(20, Number(limitOverride) || Number(c.maxResults) || 5));

  let results = index.search(q, {
    limit: limit * 3,           // 先多取，过滤来源后再截断
    minScore: Number(c.minScore) || 0,
    relRatio: Number(c.relRatio) || 0,
  });

  if (wl) results = results.filter((r) => wl.has(r.doc.source));

  // 分数闸：首条都不到门槛，说明整批都是被 bigram 碎片凑出来的噪声（闲聊特征）
  if (results.length && results[0].score < SOFT_SCORE_FLOOR) {
    return { results: [], reason: '没有找到足够相关的技术内容' };
  }

  const relaxed = results.length > 0 && results[0].relaxed === true;
  return { results: results.slice(0, limit), relaxed, whitelist: wl ? [...wl] : null };
}

/** 把结果渲染成给模型看的文本 */
function renderResults(results, { announce = true } = {}) {
  if (!results.length) return '';
  const blocks = [];
  for (let i = 0; i < results.length; i++) {
    const { doc, score } = results[i];
    const label = SOURCE_LABEL[doc.source] || doc.source;
    const head = announce
      ? `[${i + 1}] ${doc.title}　（来源：${label}，相关度 ${score.toFixed(1)}）`
      : `[${i + 1}] ${doc.title}`;
    blocks.push(`${head}\n${doc.body}`);
  }
  return blocks.join('\n\n');
}

/**
 * 把模型传回的「联网材料」规整成干净的字符串数组。
 *
 * 为什么写得这么宽容：这个参数的内容来自模型（它从 web_search / web_fetch 拿到
 * 的东西），形态完全不可控 —— 可能是一整段多行文本、可能是分号连缀的一行、
 * 也可能是它原样粘过来的 [{title,url,snippet}] 对象数组。参数形态**不该成为
 * 失败点**：吃不下就丢材料，等于让用户白等一次联网。
 */
function normalizeNotes(raw, maxItems = 12, maxChars = 600) {
  const acc = [];
  const push = (s) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (t) acc.push(t.slice(0, maxChars));
  };

  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      // 模型爱把多条要点用换行或分号并成一段，按这两种边界拆
      for (const part of v.split(/\n+|；|;|(?:^|\s)[-·•]\s*/)) push(part);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'object') {
      const title = String(v.title ?? v.name ?? '').trim();
      const body = String(v.snippet ?? v.summary ?? v.text ?? v.content ?? '').trim();
      const url = String(v.url ?? v.link ?? '').trim();
      const line = [title, body, url ? `（${url}）` : ''].filter(Boolean).join('：');
      push(line || JSON.stringify(v));
      return;
    }
    push(v);
  };

  walk(raw);

  // 去重：同一条被模型重复粘贴是常事，重复列出来只会浪费上下文
  const seen = new Set();
  const uniq = [];
  for (const s of acc) {
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  return uniq.slice(0, maxItems);
}

/**
 * 把「本地检索结果」与「联网要点」拼成一份多源材料包 + 写作指令。
 *
 * ⚠ 边界要说清楚：技能拿不到 LLM（api 上没有模型调用入口），所以**真正的
 *   「总结」只能由模型自己完成**。这个函数负责的是总结之前那一步 ——
 *   把两个来源的材料归并、去重、标明冲突与缺口，让模型总结时有据可依。
 *   声称"工具帮你总结好了"是做不到的，别写成那样。
 */
function buildSynthesis(question, results, notes, opts = {}) {
  const BODY_LIMIT = 800;
  const lines = [];
  lines.push(`【多源材料】关于「${question}」`);
  lines.push('');

  // 本地语料
  if (results.length) {
    lines.push(`▍本地知识库（${results.length} 条）`);
    for (let i = 0; i < results.length; i++) {
      const { doc, score } = results[i];
      const label = SOURCE_LABEL[doc.source] || doc.source;
      const body = String(doc.body || '').trim();
      const clipped = body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}…` : body;
      lines.push(`〔${i + 1}〕${doc.title}　（${label}，相关度 ${score.toFixed(1)}）`);
      lines.push(clipped);
    }
  } else {
    lines.push('▍本地知识库：没有覆盖这个问题的条目。');
  }
  lines.push('');

  // 联网材料
  if (notes.length) {
    lines.push(`▍联网材料（${notes.length} 条，来自你刚才的搜索 / 抓取）`);
    for (const n of notes) lines.push(`· ${n}`);
  } else {
    lines.push('▍联网材料：无。');
  }
  lines.push('');

  // 写作指令 —— 按"两个来源的有无"给出不同的提醒，这是本工具相对
  // knowledge_search 的主要增量：它知道材料是从哪来的、缺哪一块。
  lines.push('▍请据此写一段完整讲解');
  lines.push('· 先直接给结论，再讲原理，最后给例子和常见坑；不要逐条罗列材料原文。');
  if (opts.indexDown) {
    lines.push('· 本地知识库这次不可用，内容全部依据联网材料 —— 不确定的细节要说明。');
  } else if (results.length && notes.length) {
    lines.push('· 两边的信息若冲突，以联网的较新内容为准，并说明存在差异。');
  } else if (results.length && !notes.length) {
    lines.push('· 目前只有本地资料。若问题涉及时效性内容（版本、最新变化、近期事件），可以再联网核实。');
  } else if (!results.length && notes.length) {
    lines.push('· 本地库没有覆盖，内容主要依据联网材料 —— 不确定的地方要如实说明。');
  } else {
    lines.push('· 两个来源都没有材料：如实说不确定，不要编造具体命令、参数、版本号或数字。');
  }
  lines.push('· 用你自己的话讲，不要照抄，也不要提「知识库」「检索」「材料」这类内部说法。');

  return lines.join('\n');
}

// ── 工具 ─────────────────────────────────────────────────────────────────

export function setup(injected) {
  api = injected;
  cfg = injected.config;
  log = injected.log;

  rebuild();

  // ── 工具：知识检索 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'knowledge_search',
    name: '查询专业知识库',
    category: 'knowledge',
    icon: '📖',
    description:
      '在内置的编程/网络工程知识库里检索专业概念与术语。'
      + '覆盖：C++（智能指针、移动语义、模板、STL、RAII、并发等）、'
      + 'Python（GIL、装饰器、生成器、asyncio、标准库、语言语义等，含官方文档）、'
      + 'Kotlin（空安全、扩展函数、data/sealed class、协程与 Flow、'
      + '集合操作、委托、作用域函数、泛型、类型系统等，含官方文档）、'
      + '计算机网络（TCP/IP、DNS、VLAN、BGP、子网掩码等）、编程概念'
      + '（正则表达式、内存泄漏、死锁、哈希、幂等、并发等）、计算机基础、'
      + 'JavaScript 概念、以及大量命令行工具的用法速查。'
      + '当群友问到具体技术概念、术语定义、命令用法时调用。'
      + '参数 query 传要查的核心术语（例如「幂等」「智能指针」「GIL」「Kotlin 协程」'
      + '「git rebase」），'
      + '不要传整句话，也不要传闲聊内容。'
      + '查到后请用你自己的话讲清楚，不要照抄原文，也不要提「检索」「知识库」这类内部说法。'
      // ★ 有了联网兜底后，"查不到"的正确反应不再是直接认输
      + '查不到、或结果明显不对口时，**不要就此说不知道** —— '
      + '改用 web_search 联网搜索，对最相关的 1~2 个结果用 web_fetch 读正文后再回答；'
      + '需要完整、深入地讲清一个问题时，把联网要点交给 knowledge_synthesize 归并后再写。'
      + '两个来源都确实没有内容时，才诚实说不确定，不要硬编。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要检索的技术术语或概念，简短为佳，例如「幂等」「智能指针」「GIL」「Kotlin 协程」「子网掩码」。',
        },
        limit: {
          type: ['integer', 'string'],
          description: '最多返回几条，默认按设置（通常 5）。一般不用传。',
        },
      },
      required: ['query'],
    },
    async execute(_ctx, args) {
      const c = cfg();
      if (!c.enabled) {
        return { content: '知识库功能已被管理员关闭。', isError: true };
      }
      if (!index.built) {
        return {
          content: `知识库索引不可用（${loadError || '未构建'}）。请让管理员检查语料文件是否完整。`,
          isError: true,
        };
      }

      const q = String(args?.query ?? '').trim();
      const { results, reason, relaxed } = doSearch(q, args?.limit);

      if (c.verboseLog) {
        log(`[knowledge-base] 查询「${q}」→ ${results.length} 条：`
          + results.map((r) => r.doc.title).join(' | '));
      }

      if (!results.length) {
        return {
          content: `${reason ? reason + '。' : ''}知识库里没有找到与「${q}」相关的内容。`
            + '请按你自己的理解回答，并如实说明这不在可查资料范围内、可能不够准确。'
            + '不要编造具体的命令参数或协议细节。',
        };
      }

      const text = renderResults(results, { announce: c.announceSource !== false });
      const note = relaxed
        ? '\n（注：本次匹配较宽松，结果可能不完全对口，请自行判断相关性。）'
        : '';
      return {
        content: `关于「${q}」在知识库中查到以下内容：\n\n${text}${note}\n\n`
          + '请基于以上资料回答，用你自己的话说清楚，不要照抄，也不要提及检索过程。',
      };
    },
  });

  // ── 工具：多源综合（本地语料 + 联网材料） ─────────────────────────────
  api.registerTool({
    id: 'knowledge_synthesize',
    name: '综合讲解（本地 + 联网）',
    category: 'knowledge',
    icon: '🧩',
    description:
      '把「本地知识库的资料」与「你联网搜到的材料」合并成一份组织好的材料包，'
      + '并给出写讲解的指令 —— 适合需要完整、深入回答的技术问题。'
      + '典型流程：① 先用 knowledge_search 查本地库；'
      + '② 本地库没覆盖、或信息不够新不够全时，用 web_search 联网搜，'
      + '再用 web_fetch 打开最相关的 1~2 篇读正文；'
      + '③ 把联网得到的要点（标题+摘要，或正文要点，逐条一行）填进 web_notes，调用本工具；'
      + '④ 按返回的指令，把两边材料合成一段完整讲解再回答。'
      + '本工具**自己不联网** —— 联网由你用 web_search / web_fetch 完成，'
      + '它只负责归并材料、标出两个来源是否冲突、提醒你哪一块没覆盖。'
      + '若你只想查一下本地库有什么、或问题很简单，直接用 knowledge_search 即可，不必调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '用户问的原始问题（尽量用原话），用于把材料对齐到问题上。',
        },
        web_notes: {
          type: 'string',
          description:
            '你通过 web_search / web_fetch 得到的要点，逐条写、每条一行。'
            + '直接把搜到的「标题+摘要」或读到的正文要点粘进来即可，不用先整理成文。'
            + '没有联网就留空 —— 留空也能用，工具会只用本地资料。',
        },
        query: {
          type: 'string',
          description: '本地检索用的关键词（简短术语为佳），留空则直接用 question 检索。',
        },
        limit: {
          type: ['integer', 'string'],
          description: '本地最多取几条，默认按设置（通常 5）。一般不用传。',
        },
      },
      required: ['question'],
    },
    async execute(_ctx, args) {
      const c = cfg();
      if (!c.enabled) {
        return { content: '知识库功能已被管理员关闭。', isError: true };
      }
      const question = String(args?.question ?? '').trim();
      if (!question) {
        return { content: 'question 不能为空 —— 请把用户的问题原话传进来。', isError: true };
      }
      const notes = normalizeNotes(args?.web_notes);

      // 本地索引坏了不该连带毁掉联网那一半：只要能拿到联网材料，照样能综合
      if (!index.built) {
        if (!notes.length) {
          return {
            content: `知识库索引不可用（${loadError || '未构建'}），也没有联网材料可以综合。`,
            isError: true,
          };
        }
        return { content: buildSynthesis(question, [], notes, { indexDown: true }) };
      }

      const q = String(args?.query ?? '').trim() || question;
      const { results } = doSearch(q, args?.limit);
      if (c.verboseLog) {
        log(`[knowledge-base] synthesize「${question}」→ 本地 ${results.length} 条 / 联网 ${notes.length} 条`);
      }
      return { content: buildSynthesis(question, results, notes, {}) };
    },
  });

  // ── 工具：知识库概况 ──────────────────────────────────────────────────
  api.registerTool({
    id: 'knowledge_stats',
    name: '知识库概况',
    category: 'knowledge',
    icon: '📊',
    description:
      '查询内置知识库的规模与各来源条目数。'
      + '仅当有人明确问「知识库里有什么」「有多少条」时使用；回答技术问题不要调用它。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const info = index.info();
      if (!info.built) {
        return { content: `知识库未就绪（${loadError || '索引未构建'}）。`, isError: true };
      }
      // 按来源统计（从 docs 现场算，避免再维护一份计数）
      const bySource = new Map();
      for (const d of index.docs) {
        bySource.set(d.source, (bySource.get(d.source) || 0) + 1);
      }
      const lines = [...bySource.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([src, n]) => `  · ${SOURCE_LABEL[src] || src}：${n} 条`);
      return {
        content: `知识库共 ${info.docs} 条，按来源：\n${lines.join('\n')}\n\n`
          + `（索引含 ${info.tokens} 个词项、${info.postings} 条倒排记录）`,
      };
    },
  });
}

/**
 * 提示词片段。仅在启用时注入 —— 关掉知识库却仍告诉模型「你有知识库」，
 * 会让它去调一个不存在的工具。
 *
 * ⚠⚠ 这里返回的片段与 skill.json 的 prompt.sections **同 id**，而
 *    manager.js 的去重是「同 id 后写覆盖」，且动态片段（本函数）总是在
 *    manifest 片段之后 push —— 所以**本文件这份才是真正生效的**，
 *    skill.json 里那份只是副本。改提示词必须两处一起改，否则会看到
 *    「改了没生效」的假象。
 */
export function promptSections() {
  if (!cfg().enabled) return [];
  if (!index.built) return [];
  const allowWeb = cfg().allowWebFallback !== false;

  // 联网兜底那一段单独拼：管理员可以关掉 —— 有些群不希望机器人频繁联网
  // （慢、耗 token、也可能搜出不合适的站）。关掉后语义就回到"查不到就说不知道"。
  const webRule = allowWeb
    ? '知识库没覆盖、或者内容不够新不够全时，**不要就此说「不知道」**：'
      + '改用 web_search 联网搜索，对最相关的 1~2 个结果用 web_fetch 打开读正文，再综合回答。'
      + '需要完整、深入地讲清一个技术问题时，把联网要点填进 knowledge_synthesize 的 web_notes，'
      + '让它把本地资料与联网材料归并后，再按它给的指令写那段讲解。'
      + '已经联网拿到材料了就不要重复搜同一件事。'
      + '两个来源都确实没有内容时，才诚实说不确定，不要编造命令参数或协议细节。'
    : '知识库没覆盖时，如实说不确定，不要编造命令参数或协议细节。';

  return [{
    id: 'knowledge-base-usage',
    title: '',
    priority: 62,
    content:
      '你内置了一个专业知识库（覆盖编程与网络工程），可以用 knowledge_search 查询。'
      + '当群友问到具体技术概念、术语、命令用法时先查一下再回答。'
      + '查到后用自己的话讲清楚，不要照抄原文，也不要提到「检索」「知识库条目」这类内部说法——就像你本来就知道。'
      + webRule
      + '闲聊、问候、情感话题**不要**查库，那会显得突兀。'
      + '同一个问题一轮里查一次就够，不要反复调用。',
  }];
}

/** 就绪检查：UI 会显示这里返回的原因，而不是假装生效 */
export function available() {
  if (!cfg().enabled) return { ok: false, reason: '知识库被关闭了' };
  if (!index.built) return { ok: false, reason: `索引不可用：${loadError || '未构建'}` };
  return { ok: true };
}

/** 对外能力：其它模块（如 proactive / 自定义钩子）可按名取用检索 */
export const providers = {
  'knowledge.search': ({ query, limit } = {}) => {
    if (!index.built) return { ok: false, error: loadError || '索引未构建', results: [] };
    const { results } = doSearch(query, limit);
    return {
      ok: true,
      results: results.map((r) => ({
        title: r.doc.title,
        body: r.doc.body,
        source: r.doc.source,
        score: Number(r.score.toFixed(2)),
      })),
      text: renderResults(results, { announce: cfg().announceSource !== false }),
    };
  },
};

export function dispose() {
  // 工具由加载器按 skillId 批量注销；这里只需放掉索引占用的内存
  index = new KnowledgeIndex();
}

export const internals = {
  loadItems, rebuild, doSearch, renderResults, SOURCE_LABEL,
  // 多源综合的两个纯函数也导出：它们的入参形态来自模型、完全不可控，
  // 是最值得单独测的对象（见工作区 knowledge-base-test/test-e2e.mjs）。
  buildSynthesis, normalizeNotes,
};
