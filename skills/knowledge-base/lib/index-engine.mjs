// 倒排索引检索引擎 —— 零依赖纯 JS。
//
// ── 为什么自己写，不用现成的库 ─────────────────────────────────────────────
// 项目本身零第三方依赖（只有 js-yaml / undici / ws）。为了一个可选插件引入
// lunr / flexsearch / jieba 之类，会同时带来体积、供应链风险和"版本漂移"——
// 而这套语料的规模（几千条短条目）用最朴素的倒排索引就够，且行为完全可控。
//
// ── 分词策略（没有分词库怎么办）─────────────────────────────────────────────
// 中文检索的老问题是"词不等于字"。没有词典时，**二元切分（bigram）** 是
// 标准解法：「网络工程」→ 网络 / 络工 / 工程。它把"分词"问题降级成"子串匹配"，
// 召回稳定、不需要任何词表，代价是索引略大——几千条语料完全可接受。
// 英文/术语走另一条路：按非字母数字切，小写归一，保留 tcp / http2 这类。
//
// ── 权重 ─────────────────────────────────────────────────────────────────
// 标题与术语命中远比正文命中更重要（用户问"什么是 VLAN"，命中的应该是
// 标题为 VLAN 的那条，而不是正文里顺带提了一句 VLAN 的条目）。
// 故 title/term 的词权重 ×5，正文 ×1，再乘 idf。
//
// ── 为什么在内存里建索引而不是落盘 ────────────────────────────────────────
// 条目总量几千，建索引实测在几十毫秒级。落盘索引会引入"文件版本与代码不同步"
// 这一类难查的问题（改了权重算法忘了重建索引，表现是"结果说不通"）。
// 启动时重建，简单且永远一致。

/** 英文/数字 token：字母、数字，允许内部的 . - _ + （http2、utf-8、node.js） */
const EN_TOKEN = /[a-z0-9][a-z0-9._+-]*/g;

/**
 * 符号型关键字 → 中文别名（**仅查询侧展开**）。
 *
 * 为什么需要：`?.` `?:` `!!` `::` `..` 这类**纯符号**永远不可能成为 token
 * （`EN_TOKEN` 要求以字母数字开头），所以「Kotlin 的 ?. 和 ?: 怎么用」分词后
 * 只剩 `kotlin` 一个词，检索退化成"谁标题里 Kotlin 多谁赢"，把 Kotlin/JS、
 * Kotlin Koans 拉了上来。清洗侧标题里写的是「（?. 安全调用）」——其中的 `?.`
 * 同样不是 token，等于没写。
 *
 * 对策：在**查询分词时**把这些符号替换成对应的中文词，让它们能命中清洗侧
 * 已经写进标题的中文别名（`安全调用` / `Elvis` / `非空断言` …）。
 * 只在查询侧做，索引侧不动 ⇒ 不改变任何已有条目的权重分布，风险最低。
 */
const SYMBOL_ALIASES = [
  // 顺序有意义：长的先替换，避免 `?:` 被 `?` 抢先处理。
  // 每个符号可展开成**多个**别名（中英各一），覆盖面更广。
  ['?:', ' elvis 空安全 '],
  ['?.', ' 安全调用 空安全 '],
  ['!!', ' 非空断言 空安全 '],
  ['::', ' 函数引用 '],
  ['..', ' 区间 '],
  ['->', ' lambda '],
];

/** 中文（含扩展区）字符 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 停用词表。
 *
 * 为什么必须有：中文 bigram 会把「什么是VLAN」切成 什么/么是/是v… ，
 * 其中「什么」「么是」这类疑问词在几乎每条正文里都不出现，但一旦某条恰好含它，
 * 就会以极高分值挤进结果——实测「什么是VLAN」曾把 a2ping 命令拉到第二名。
 * 这类词没有区分度，却因为 df 小反而 idf 高，是典型的检索噪声源。
 *
 * 覆盖：疑问/指代/助词/常见连接词，以及"用法/怎么/如何"这类提问外壳词。
 */
const STOP_TOKENS = new Set([
  // 疑问与指代
  '什么', '么是', '是什', '哪些', '哪个', '怎么', '么样', '怎样', '如何', '为何',
  '为什么', '什么', '何谓', '是否', '能否', '可以', '不能',
  // 助词与结构
  '的', '了', '是', '在', '和', '与', '及', '或', '也', '都', '就', '而', '但',
  '这', '那', '它', '他', '我', '你', '您', '有', '没', '不', '要', '会', '能',
  '一个', '一种', '一样', '一下', '有些', '这个', '那个', '这些', '那些',
  // 提问外壳
  '用法', '使用', '介绍', '什么', '解释', '说明', '区别', '差异', '对比', '含义',
  '意思', '意思', '作用', '功能', '原理', '机制', '是什么',
  // 英文停用词
  // ★ 2026-10 修正：`is / as / in / out / by / with / for / when` 这类词在**通用英文**
  //   里确实是停用词，但在**编程语境**里是关键字（Kotlin 的 `is`/`as`/`in`/`out`/`by`/
  //   `when`、C++ 的 `for`/`with`…）。原先一律滤掉，导致查询「Kotlin 类型检查 is 和 as」
  //   分词后只剩 `kotlin`，退化成"谁标题里 Kotlin 多谁赢"，命中的是 Kotlin/JS、Kotlin Koans
  //   这类无关条目。故从停用词表**移除**这 8 个；
  //   它们 df 低（is 仅命中 15 条标题）⇒ idf 高 ⇒ 恰好成为强判别信号，收益大于噪声。
  //   保留的仍是真正的功能词（the/a/of/to/and/not/it/this/that/what/how/why/which/do/...）。
  'the', 'a', 'an', 'are', 'was', 'were', 'be', 'of', 'to', 'on',
  'and', 'or', 'not', 'it', 'this', 'that', 'what', 'how', 'why', 'which',
  'do', 'does', 'can', 'could', 'should', 'would', 'from', 'at',
]);

/**
 * 来源可信度权重。
 *
 * 为什么需要：「DNS解析」查询里，`acme.sh --dns 命令用法（tldr）` 会超过
 * `Cloud DNS（网络工程）`。原因是 tldr 条目标题就是命令名，命令名里含 dns 就
 * 精确命中；而概念条目标题是概念名，未必含查询词。但用户问"XX解析"想要的是
 * **概念解释**，不是某个命令的用法。
 *
 * 故按"条目性质"分配权重：
 *   术语/概念类（cs-terms / net101 / node-glossary）—— 天然是"回答是什么"，
 *     权重高于纯命令速查。
 *   tldr —— 是"命令怎么敲"，只在明确是问命令时才是最优解；给略低的基础权重，
 *     但它仍能靠精确命中拿到高分（实测 git rebase 仍稳居第一）。
 *
 * node-glossary 为何从 1.25 降到 1.1（2026-10）：
 *   它收录的是 **Node.js 生态**的术语，正文多为单句英文定义（例如
 *   `RAII（Node.js）` = "Resource Acquisition Is Initialization ... in C++."）。
 *   中文查询「RAII」时，这条 88 字符的英文单句会以 130 分压过 manual 的
 *   300 字中文详解（122 分）——因为它"标题=术语"而标题命中是满权重的。
 *   它仍是合法语料（不该删），但在**跨语言的通用概念**查询上确实不该拿加权。
 *   降到 1.1 后它仍高于 javaguide/tldr，Node 专属查询依旧能召回。
 */
const SOURCE_WEIGHT = {
  'manual': 1.5,
  'cs-terms': 1.3,
  'net101': 1.4,
  'node-glossary': 1.1,
  'javaguide': 1.2,
  'jsq': 0.95,
  'tldr': 0.75,
  // ── C++（2026-10 新增）──────────────────────────────────────────────
  // cpp-glossary 是"术语即标题"的字典，天然回答"XX 是什么"，给高权重。
  'cpp-glossary': 1.35,
  'cpp-tutorial': 1.2,      // 教程正文，质量高但偏长
  'cpp-cheatsheet': 1.05,   // 速查条目，知识点密但碎片化
  // ── Python（2026-10 新增）────────────────────────────────────────────
  // py-docs 是**官方文档**，权威性最高，且条目来自按小节聚合的长段，
  // 是概念类问题的首选来源。
  'py-docs': 1.4,
  'py-glossary': 1.3,       // 术语表（CC0），回答"什么是 XX"
  'py-tutorial': 1.15,      // 入门指南，偏流程/工具链
  'py-cheatsheet': 1.05,    // 代码示例与注释
  // ── Kotlin（2026-10 新增）────────────────────────────────────────────
  // k-docs 是 **JetBrains 官方文档**（kotlin-web-site，Apache-2.0），
  // 122 篇 Markdown 按 ## / ### 切节，是 Kotlin 概念问题的首选来源。
  // ⚠ 它是**英文原文**（Kotlin 官方不发中文译文到公开仓库），中文检索靠
  //   清洗时写进 title/term/tags 的中文主题词（覆盖率 95%）。
  //   所以权重跟 py-docs 齐平，但不如 manual 兜底条目 —— 后者是中文写法。
  'k-docs': 1.4,
  'k-example': 1.1,         // 官方示例教程（kotlin-by-example），偏代码示范
};

/** 取来源权重（未登记的来源按 1.0） */
function sourceWeight(src) {
  return SOURCE_WEIGHT[String(src ?? '')] ?? 1.0;
}

/** 是否含 CJK 字符 */
export function hasCJK(s) {
  return CJK.test(String(s ?? ''));
}

/**
 * 分词：返回 token 数组。
 * 英文全小写；中文切 bigram；单字中文（长度 1 的词）也保留，否则「图」「栈」这类
 * 单字查询会全军覆没。
 *
 * @param {string} text
 * @param {boolean} applyStop 是否滤停用词。**建索引与查询必须同口径**——
 *   建索引时滤掉、查询时不过滤（或反之）会造成"索引里查不到"的诡异现象。
 * @param {boolean} expandSymbols 是否把 `?.` `?:` `!!` 等符号展开成中文别名。
 *   **只在查询侧开**（建索引侧不开，保持已有条目权重不变）。见 SYMBOL_ALIASES。
 */
export function tokenize(text, applyStop = true, expandSymbols = false) {
  let s = String(text ?? '');
  if (!s) return [];
  const out = [];

  if (expandSymbols) {
    for (const [sym, alias] of SYMBOL_ALIASES) {
      if (s.includes(sym)) s = s.split(sym).join(alias);
    }
  }

  const lower = s.toLowerCase();

  // 英文/数字 token
  let m;
  EN_TOKEN.lastIndex = 0;
  while ((m = EN_TOKEN.exec(lower)) !== null) {
    const t = m[0];
    if (t.length >= 1 && t.length <= 40) {
      if (applyStop && STOP_TOKENS.has(t)) continue;
      out.push(t);
    }
  }

  // 中文 bigram：只对连续的中文串切，跨过标点/空格就断开
  const cjkRuns = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || [];
  for (const run of cjkRuns) {
    const push = (tk) => {
      if (applyStop && STOP_TOKENS.has(tk)) return;
      out.push(tk);
    };
    if (run.length === 1) {
      push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      push(run.slice(i, i + 2));
    }
    // 长词的首尾单字也补上，帮助「栈」「图」这类单字问法
    if (run.length <= 4) {
      push(run[0]);
      push(run[run.length - 1]);
    }
  }
  return out;
}

/** 简单的 32 位字符串哈希（用于 idf 表？不需要，这里仅给外部复用） */
export function hashStr(s) {
  let h = 2166136261;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class KnowledgeIndex {
  constructor() {
    /** token -> Map<docIdx, weight> */
    this.postings = new Map();
    /** 文档数组 */
    this.docs = [];
    /** token -> 文档频率 */
    this.df = new Map();
    this.built = false;
    this.builtAt = 0;
    this.stats = { docs: 0, tokens: 0, postings: 0 };
  }

  /**
   * 建索引。items: [{id,title,term,body,tags,source}]
   * @param {Array} items
   */
  build(items) {
    this.postings = new Map();
    this.df = new Map();
    this.docs = [];
    const list = Array.isArray(items) ? items : [];

    for (const it of list) {
      const idx = this.docs.length;
      const doc = {
        idx,
        id: String(it.id ?? ''),
        title: String(it.title ?? ''),
        term: String(it.term ?? ''),
        body: String(it.body ?? ''),
        tags: Array.isArray(it.tags) ? it.tags : [],
        source: String(it.source ?? ''),
      };
      this.docs.push(doc);

      // 字段加权：title/term 是"这条讲什么"的最强信号
      const fieldTokens = [
        [doc.title, 5],
        [doc.term, 5],
        [doc.tags.join(' '), 3],
        [doc.body, 1],
      ];

      const local = new Map(); // token -> 本轮累计权重
      for (const [text, w] of fieldTokens) {
        if (!text) continue;
        for (const tk of tokenize(text)) {
          local.set(tk, (local.get(tk) || 0) + w);
        }
      }

      for (const [tk, w] of local) {
        let bag = this.postings.get(tk);
        if (!bag) {
          bag = new Map();
          this.postings.set(tk, bag);
        }
        bag.set(idx, w);
        this.df.set(tk, (this.df.get(tk) || 0) + 1);
      }
    }

    let postings = 0;
    for (const bag of this.postings.values()) postings += bag.size;
    this.stats = { docs: this.docs.length, tokens: this.postings.size, postings };
    this.built = true;
    this.builtAt = Date.now();
    return this.stats;
  }

  /**
   * 检索。
   * @param {string} query
   * @param {object} opts
   *   limit=5       最多返回条数
   *   sourceFilter  只搜某个来源
   *   minScore=0    绝对分下限（低于此分视为噪声）
   *   relRatio=0    相对分下限：低于 首条分 * relRatio 的丢弃
   * @returns {Array<{doc, score, matched}>}
   */
  search(query, opts = {}) {
    const limit = Math.max(1, Math.min(50, Number(opts.limit) || 5));
    const minScore = Number(opts.minScore) || 0;
    const relRatio = Number(opts.relRatio) || 0;

    // 查询侧开启符号别名展开（`?.`→安全调用、`?:`→elvis 等），
    // 建索引侧不开 —— 只影响查询理解，不改变已有条目的权重分布。
    let qTokens = tokenize(query, true, true);
    let relaxed = false;
    // 停用词过滤后一个 token 不剩（例如整句都是「这是为什么」）→ 退回不过滤，
    // 宁可给点结果也别空手；标记 relaxed 供上层提示"这次匹配较宽"。
    if (!qTokens.length) {
      qTokens = tokenize(query, false, true);
      relaxed = true;
    }
    if (!qTokens.length) return [];

    const N = this.docs.length || 1;
    const scores = new Map();   // docIdx -> score
    const matched = new Map();  // docIdx -> Set<token>

    for (const tk of qTokens) {
      const bag = this.postings.get(tk);
      if (!bag) continue;
      const df = this.df.get(tk) || 1;
      // idf：出现得越少越有区分度；+1 防止除零与负值
      const idf = Math.log(1 + N / df);
      for (const [docIdx, w] of bag) {
        scores.set(docIdx, (scores.get(docIdx) || 0) + w * idf);
        let s = matched.get(docIdx);
        if (!s) { s = new Set(); matched.set(docIdx, s); }
        s.add(tk);
      }
    }

    if (!scores.size) return [];

    // ── 查询短语（多词固定搭配）──────────────────────────────────────────
    // 起因：查询「data class」里 `data` 会命中 cs-terms 的「数据（Data）」，
    // 而 `class` 单独不足以拉开差距 ⇒ 一条**跨语料无关条目**排到了
    // Kotlin「data class（数据类）」前面。
    // 对策：把查询里**连续的 ASCII 单词**视作可能的固定搭配，若某文档
    // 同时命中短语的全部词，视为"短语级命中"，给额外加成。
    // 通用性：对 C++ 的 `unique pointer`、Python 的 `list comprehension` 同样生效。
    const phraseTokens = [];
    {
      const raw = String(query ?? '').toLowerCase();
      const runs = raw.match(/[a-z0-9][a-z0-9._+-]*(?:\s+[a-z0-9][a-z0-9._+-]*)+/g) || [];
      for (const run of runs) {
        const parts = run.split(/\s+/).filter((p) => p && !STOP_TOKENS.has(p));
        if (parts.length >= 2) phraseTokens.push(parts);
      }
    }

    // 覆盖率加成：命中查询词种类越多的条目越可能是"整条对得上"
    const qUnique = new Set(qTokens).size || 1;
    const results = [];
    for (const [docIdx, base] of scores) {
      const doc = this.docs[docIdx];
      if (!doc) continue;
      if (opts.sourceFilter && doc.source !== opts.sourceFilter) continue;
      const matchedSet = matched.get(docIdx) || new Set();
      const cov = (matchedSet.size || 0) / qUnique;
      // 完全覆盖时给 1.6 倍，避免"长正文堆词"压过"精确标题命中"
      const covBoost = 1 + cov * 0.6;

      // 短语级命中加成：整段固定搭配都命中，1.35 倍
      let phraseBoost = 1;
      for (const parts of phraseTokens) {
        if (parts.every((p) => matchedSet.has(p))) { phraseBoost = 1.35; break; }
      }

      // ── 标题长度惩罚 ──────────────────────────────────────────────────
      // 起因：「DNS解析」查询里 `acme.sh --dns 命令用法（tldr）` 拿 116 分，
      // 而真正对口的 `Cloud DNS` 只有 66 —— 前者标题又长又全是词，
      // token 命中数天然多。但"标题越长越可能是泛泛而谈"，短标题才更可能
      // 是专讲这一个概念的条目。故按标题 token 数做温和衰减：
      // 1 个词系数 1.0，之后每个词乘 0.94（不会翻盘，但足以纠正量级错位）。
      const titleTk = tokenize(doc.title, true).length + tokenize(doc.term, true).length;
      const lenPenalty = Math.pow(0.94, Math.max(0, titleTk - 1));

      // ── 正文极短衰减 ──────────────────────────────────────────────────
      // 起因：「RAII」查询里 node-glossary 的
      //   `Resource Acquisition Is Initialization - ... in C++.`（78 字符）
      // 以 130 分压过 manual 的 300 字完整讲解（122 分）——因为术语类条目
      // "标题=术语"，标题命中满分，而评分只惩罚"标题长"，不惩罚"正文空"。
      // 但一条只有一句话的条目，对模型的信息量远不如成段讲解。
      // 所以对正文短于 90 字符的条目做温和衰减（最低 0.72），
      // 阈值取得低，是为了不误伤正常的术语词典条目（正文普遍 100+ 字符）。
      const bodyLen = (doc.body || '').length;
      const bodyPenalty = bodyLen >= 90 ? 1 : (0.72 + 0.28 * (bodyLen / 90));

      const score = base * covBoost * phraseBoost * lenPenalty * bodyPenalty * sourceWeight(doc.source);
      results.push({ doc, score, matched: [...(matched.get(docIdx) || [])] });
    }
    results.sort((a, b) => b.score - a.score);

    // ── 噪声闸门 ────────────────────────────────────────────────────────
    // 只看绝对阈值不够：「DNS解析」里 acme.sh 拿 116 分，而真正该排第一的
    // Cloud DNS 只有 66 —— 纯按分排序时错的那个天然在前面。
    // 但这属于"长标题堆词"问题，这里先用相对阈值把尾部离群的截掉，
    // 保证结果集内部不至于混进与首条差一个量级的条目。
    const top = results[0]?.score || 0;
    const floor = Math.max(minScore, top * relRatio);
    const filtered = results.filter((r) => r.score >= floor);

    // ── 同文档限流（结果多样性）─────────────────────────────────────────
    // 起因：「事件循环」查询 Top-5 全是 py-docs 里同一份 asyncio 文档的碎片
    // （`事件循环（38）`/`（37）`/`（19）`…），把 Node.js 事件循环这类
    // 真正该出现的条目全挤出去了。长文档被分块后，同族的碎片天然同分，
    // 会霸占整个结果列表——对模型来说这 5 条几乎是同一份材料，等于只召回了 1 条。
    //
    // 判据：用"去掉结尾 `（…）` 后的标题"当文档族键（分块命名约定就是
    // `<文档标题>（<提示>）` / `<文档标题>（<序号>）`）。
    // 每族最多占 2 席；被限流的不丢弃，而是排到末尾继续参与截断，
    // 这样 limit 大时（工具默认给模型看更多）仍能拿到同族的补充信息。
    const famCount = new Map();
    const primary = [];
    const overflow = [];
    for (const r of filtered) {
      const fam = String(r.doc.title || '').replace(/（[^（）]*）\s*$/, '');
      const n = famCount.get(fam) || 0;
      if (n < 2) {
        famCount.set(fam, n + 1);
        primary.push(r);
      } else {
        overflow.push(r);
      }
    }
    return [...primary, ...overflow]
      .slice(0, limit)
      .map((r) => ({ ...r, relaxed }));
  }

  /** 索引概况，供工具/自检展示 */
  info() {
    return {
      built: this.built,
      builtAt: this.builtAt,
      ...this.stats,
    };
  }
}
