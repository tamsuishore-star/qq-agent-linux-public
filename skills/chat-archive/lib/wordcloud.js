// skills/chat-archive/lib/wordcloud.js
//
// 聊天记录词云：分词 + 排版（**纯逻辑，不碰文件系统，便于离线验证**）。
//
// ── 为什么要自己写分词 ────────────────────────────────────────────────────
// 中文没有空格，常规做法是上 jieba 这类分词库；但程序自带的 node_modules 里没有，
// 为这个功能装一套依赖（体积大、还可能和 Electron 的 ABI 打架）不划算。
// 这里用**无词典的新词发现**（nlp 里叫"未登录词识别"），两步：
//   ① 挖候选：把每段连续中文里 2~6 字的所有组合（n-gram）都数一遍，顺带记下
//      每个候选**左右两边都出现过哪些字**（邻字分布）。
//   ② 判词：两个经典判据 ——
//      · 凝固度：拆开之后不该还这么常见（"打游戏" 成词，是因为 打|游戏 远不如
//        打游戏 常见）。用点互信息式的最小值衡量。
//      · 边界自由度：真词的两边应该"什么字都能接"（左邻右舍五花八门）；
//        如果某个候选的右边**永远**是同一个字（比如 "今天深渊出货" 后面永远是
//        "了"），那它就只是更长那句话里的一段碎片，不是词。
//      这两条合起来，能把 "渊出货了" 这种碎片刷掉、留下 "深渊出货了"。
// 群聊词云不是学术分词，这套土办法出来的效果足够"一眼看出群里在聊什么"。
//
// ── 排版 ──────────────────────────────────────────────────────────────────
// 按行打包：每行高度 = 该行最大字号，行内按估算宽度推进 —— **构造上不会重叠**，
// 这是刻意的：词云最丑的样子就是字压字。渲染端（PowerShell + GDI+）会再用真实字体
// 量一遍宽度，超宽就把该词按比例缩小，保证一定塞得下。

// 停用词：群聊里出现频率极高但没信息量的词（口语、连接词、平台词、消息占位）
const STOPWORDS = new Set([
  '这个', '那个', '这样', '那样', '什么', '怎么', '为啥', '为什么', '可以', '不行', '不是', '没有', '没事',
  '已经', '还是', '但是', '因为', '所以', '如果', '虽然', '然后', '而且', '就是', '也是', '都是', '只是',
  '我们', '你们', '他们', '自己', '别人', '大家', '一起', '一个', '一下', '一直', '一样', '一点', '一般',
  '时候', '现在', '今天', '昨天', '明天', '刚才', '马上', '最近', '以前', '以后', '有点', '真的', '好像',
  '应该', '可能', '感觉', '觉得', '知道', '不知', '不知道', '有没有', '是不是', '能不能', '要不要',
  '哈哈哈', '哈哈', '呵呵', '嘿嘿', '嘻嘻', '嘎嘎', '笑死', '好吧', '好的', '好嘞', '可以可以',
  '图片', '语音', '视频', '表情', '表情包', '引用', '撤回', '拍一拍', '转发', '链接',
  'http', 'https', 'www', 'com', 'cn', 'b23', 'qq', 'vx', 'png', 'jpg', 'gif'
]);

// 词首/词尾不该出现的字：助词、代词、语气词、连接词。中文的词很少以"的了是都你我这那"打头，
// 也很少以"的了吗呢你我这那"收尾 —— 凡是长这样的候选，多半是切错了边界的碎片
// （"姐姐这""了一晚""都没""得比"），这条规则能把它们成批刷掉。
const HEAD_BAD = new Set('的了是都就也还得很太不没别被把给让和与或而并且但却又再在从向对为们个着过地你他她它咱这那哪谁什怎'.split(''));
const TAIL_BAD = new Set('的吗呢吧你他她它们这那个些很太都也还就在有和与而并但却又再把被给让对向从以之于其此谁'.split(''));
// 这几个字收尾时不能一刀切：3 个字以上的"了/是/着/过"结尾往往是完整的一句话
// （"深渊出货了""别熬夜了"），一刀切会把群里最有梗的词全砍掉；只在 2 字词尾才当碎片处理。
const TAIL_SOFT = new Set('了是着过'.split(''));

const CJK = /[\u4e00-\u9fa5]/;
const CJK_ONLY = /^[\u4e00-\u9fa5]+$/;

const NGRAM_MAX = 6;          // 候选最长 6 字（再长就不是词而是句子了）
const RUN_CAP = 60;           // 一段连续中文超过这个长度只取前 60 字（防复制粘贴刷爆统计）

/** 去掉消息里的噪声：引用前缀、@、链接、CQ 码、数字。 */
function cleanText(raw) {
  return String(raw ?? '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/\[引用[^\]]*\]/g, ' ')
    .replace(/【[^】]{0,40}】/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@\S{1,20}/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[\u3000\u2000-\u200f\ufe0f]/g, ' ');
}

/** 把每条消息切成"连续中文段"和"英文/数字词"，段与段之间天然是词边界。 */
function forEachUnit(texts, fn) {
  for (const raw of texts) {
    const t = cleanText(raw);
    const re = /[\u4e00-\u9fa5]+|[A-Za-z][A-Za-z0-9_+-]{0,20}/g;
    let m;
    while ((m = re.exec(t)) !== null) fn(m[0]);
  }
}

const bumpIn = (map, key, sub) => {
  let inner = map.get(key);
  if (!inner) { inner = new Map(); map.set(key, inner); }
  inner.set(sub, (inner.get(sub) || 0) + 1);
};

/** 第一遍：数 n-gram 与单字频次。 */
function countNgrams(texts, { maxGram = NGRAM_MAX } = {}) {
  const uni = new Map();
  const freq = new Map();
  let chars = 0;
  forEachUnit(texts, (unit) => {
    if (CJK.test(unit[0])) {
      const s = [...unit];
      const arr = s.length > RUN_CAP ? s.slice(0, RUN_CAP) : s;
      for (const ch of arr) uni.set(ch, (uni.get(ch) || 0) + 1);
      chars += arr.length;
      for (let n = 2; n <= maxGram && n <= arr.length; n += 1) {
        for (let i = 0; i + n <= arr.length; i += 1) {
          const w = arr.slice(i, i + n).join('');
          freq.set(w, (freq.get(w) || 0) + 1);
        }
      }
    } else {
      const w = unit.toLowerCase();
      if (w.length >= 2) freq.set(w, (freq.get(w) || 0) + 1);
    }
  });
  return { uni, freq, chars };
}

/** 第二遍：只给"够格"的候选（count >= 门槛）统计左右邻字分布 + 整段独立出现的次数。 */
function neighborStats(texts, wanted, { maxGram = NGRAM_MAX } = {}) {
  const left = new Map();
  const right = new Map();
  const alone = new Map();      // 整段就是它（两边都是段首/段尾）的次数：固定梗大多是这种
  forEachUnit(texts, (unit) => {
    if (!CJK.test(unit[0])) return;
    const s = [...unit];
    const arr = s.length > RUN_CAP ? s.slice(0, RUN_CAP) : s;
    for (let n = 2; n <= maxGram && n <= arr.length; n += 1) {
      for (let i = 0; i + n <= arr.length; i += 1) {
        const w = arr.slice(i, i + n).join('');
        if (!wanted.has(w)) continue;
        const head = i === 0;
        const tail = i + n === arr.length;
        bumpIn(left, w, head ? '^' : arr[i - 1]);                  // ^ = 段首
        bumpIn(right, w, tail ? '$' : arr[i + n]);                 // $ = 段尾
        if (head && tail) alone.set(w, (alone.get(w) || 0) + 1);
      }
    }
  });
  return { left, right, alone };
}

/** 分布的信息熵（bit）。越"五花八门"越大；只有一种邻居时是 0。 */
function entropyOf(inner) {
  if (!inner || !inner.size) return 0;
  let total = 0;
  for (const v of inner.values()) total += v;
  if (!total) return 0;
  let h = 0;
  for (const v of inner.values()) { const p = v / total; h -= p * Math.log2(p); }
  return h;
}

/** 凝固度：拆开后的"意外程度"，取所有拆法里最小的一种（最弱的那处若仍够牢就成词）。 */
function cohesionOf(w, n, { uni, freq, chars }) {
  let min = Infinity;
  for (let i = 1; i < w.length; i += 1) {
    const a = i === 1 ? (uni.get(w[0]) || 0) : (freq.get(w.slice(0, i)) || 0);
    const b = i === w.length - 1 ? (uni.get(w[w.length - 1]) || 0) : (freq.get(w.slice(i)) || 0);
    if (!a || !b) { min = 0; break; }
    min = Math.min(min, (n * chars) / (a * b));
  }
  return Number.isFinite(min) ? min : 0;
}

// 判词门槛（数字来自真实群聊样本的调参，见 stage 的 debug-cloud）
const COHESION_MIN = 8;      // 凝固度下限
const FREEDOM_MIN = 0.55;    // 左右邻字熵的下限（bit）
const FREQ_RESCUE = 12;      // 高频词豁免：出现这么多次的，允许它只在一侧有变化
                             // （"原神启动"这种固定梗两边都是段首/段尾，熵天然为 0）

/**
 * 统计词频并筛出"像词"的候选。
 * @param {string[]} texts 消息正文列表
 * @param {object} opts { minCount, maxWords, extraStop, dropWords }
 * @returns {{words:{text:string,count:number}[], totalTexts:number, scanned:number, stats:object}}
 */
function countWords(texts, { minCount = 3, maxWords = 60, extraStop = [], dropWords = [] } = {}) {
  const extra = extraStop.map((x) => String(x).toLowerCase()).filter(Boolean);
  const drop = dropWords.map((x) => String(x).toLowerCase()).filter(Boolean);
  const blocked = [...extra, ...drop];
  const list = texts.filter((t) => String(t ?? '').trim());
  const mined = countNgrams(list);
  const { uni, freq, chars } = mined;

  // 先把够频次的挑出来。
  // 内置停用词只做**精确**匹配（它们本身就短，"包含就杀"会误伤一大片）；
  // 用户自己填的屏蔽词和人名做**包含**匹配 —— 屏蔽"深渊"就该把"深渊出货了"一起带走。
  const wanted = new Set();
  for (const [w, n] of freq) {
    if (n < minCount) continue;
    if (STOPWORDS.has(w)) continue;
    if (blocked.some((d) => w === d || w.includes(d))) continue;
    wanted.add(w);
  }
  const nb = neighborStats(list, wanted);

  const scored = [];
  for (const w of wanted) {
    const n = freq.get(w);
    const isCJK = CJK_ONLY.test(w);
    let cohesion = Infinity;
    let freedom = Infinity;
    if (isCJK) {
      if (HEAD_BAD.has(w[0]) || TAIL_BAD.has(w[w.length - 1])) continue;   // 边界明显切错的碎片
      if (w.length <= 2 && TAIL_SOFT.has(w[w.length - 1])) continue;
      cohesion = cohesionOf(w, n, mined);
      const hl = entropyOf(nb.left.get(w));
      const hr = entropyOf(nb.right.get(w));
      freedom = Math.min(hl, hr);
      if (cohesion < COHESION_MIN) continue;
      // 三种情况放行：
      //   ① 两边都"接得上话"（真词）；
      //   ② 它自己就是一条完整消息（群里反复喊的固定梗，两边天然都是段首/段尾）；
      //   ③ 高频 + 至少一侧有变化。
      const isMeme = (nb.alone.get(w) || 0) >= Math.max(3, n * 0.4);
      const saved = n >= FREQ_RESCUE && Math.max(hl, hr) >= FREEDOM_MIN;
      if (freedom < FREEDOM_MIN && !isMeme && !saved) continue;
    } else {
      freedom = Math.max(entropyOf(nb.left.get(w)), entropyOf(nb.right.get(w)));
    }
    scored.push({ text: w, count: n, cohesion: Math.round(cohesion * 10) / 10, freedom: Math.round(freedom * 100) / 100 });
  }

  // 长词优先：短词如果被更长、且频次差不多的词完全盖住（"游戏" vs "打游戏" 且两者几乎一样多），
  // 只留长的那个。0.9 这个系数是刻意的——"游戏"单独也用得多时（比如 12 次里的 10 次在"打游戏"里）
  // 就该两个都留。
  scored.sort((a, b) => b.count - a.count || b.text.length - a.text.length || a.text.localeCompare(b.text, 'zh'));
  const kept = [];
  for (const it of scored) {
    const covered = kept.some((k) => k.text.length > it.text.length
      && k.text.includes(it.text) && k.count >= it.count * 0.9);
    if (covered) continue;
    kept.push(it);
  }
  kept.sort((a, b) => b.count - a.count || b.text.length - a.text.length || a.text.localeCompare(b.text, 'zh'));
  return {
    words: kept.slice(0, maxWords).map(({ text, count }) => ({ text, count })),
    totalTexts: texts.length,
    scanned: list.length,
    stats: {
      candidates: freq.size,
      passed: wanted.size,
      kept: kept.length,
      chars
    }
  };
}

// 配色：稳重的深色系，白底上可读性都不错
const PALETTE = [
  [31, 78, 121], [176, 58, 46], [29, 105, 20], [127, 63, 152], [176, 105, 20],
  [20, 108, 120], [150, 40, 90], [60, 70, 90], [10, 90, 60], [170, 70, 20]
];

/** 估算一段文字的像素宽度（渲染端会用真实字体再校一遍，这里求稳不求准）。 */
function estimateWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text)) w += CJK.test(ch) ? fontSize * 1.06 : fontSize * 0.62;
  return w;
}

/**
 * 按行打包排版。字大在前，行内居中，行高按该行最大字号 —— 构造上不重叠。
 * @returns {{width:number, height:number, fontSize:number, fontFamily:string, background:number[], words:object[]}}
 */
function layout(words, {
  width = 900, height = 620, fontFamily = 'Microsoft YaHei',
  minSize = 16, maxSize = 64, margin = 22, header = '', footer = ''
} = {}) {
  const usable = width - margin * 2;
  const headerH = header ? 34 : 0;
  const footerH = footer ? 24 : 0;
  const top = margin + headerH;
  const bottom = height - margin - footerH;
  const list = Array.isArray(words) ? words.filter((w) => w && String(w.text ?? '').trim()) : [];
  const maxCount = Math.max(1, ...list.map((w) => Number(w.count) || 1));
  const minCount = Math.min(...list.map((w) => Number(w.count) || 1), maxCount);

  // 字号：按频次的平方根缩放（线性缩放会让小词小到看不见）
  const items = list.map((w, i) => {
    const c = Number(w.count) || 1;
    const t = maxCount === minCount ? 1 : (Math.sqrt(c) - Math.sqrt(minCount)) / (Math.sqrt(maxCount) - Math.sqrt(minCount));
    let size = Math.round(minSize + t * (maxSize - minSize));
    const text = String(w.text);
    const wide = estimateWidth(text, size);
    if (wide > usable) size = Math.max(minSize, Math.floor((usable * size) / (wide || 1)));   // 太长的词先压到能放下
    return { text, count: c, size, color: PALETTE[i % PALETTE.length] };
  }).sort((a, b) => b.size - a.size || b.count - a.count);

  const gapOf = (size) => Math.max(8, Math.round(size * 0.45));
  const rows = [];
  let row = { items: [], height: 0, width: 0 };
  for (const it of items) {
    const wpx = estimateWidth(it.text, it.size);
    const need = wpx + (row.items.length ? gapOf(it.size) : 0);
    if (row.items.length && row.width + need > usable) {
      rows.push(row);
      row = { items: [], height: 0, width: 0 };
    }
    row.items.push({ ...it, wpx });
    row.width += wpx + (row.items.length > 1 ? gapOf(it.size) : 0);
    row.height = Math.max(row.height, it.size);
  }
  if (row.items.length) rows.push(row);

  // 垂直方向也居中，避免上方堆死、下方空一大块
  const totalH = rows.reduce((s, r) => s + Math.round(r.height * 1.35), 0);
  let y = top + Math.max(0, Math.floor(((bottom - top) - totalH) / 2));
  const placed = [];
  let rowIndex = 0;
  for (const r of rows) {
    let x = Math.round(margin + Math.max(0, (usable - r.width) / 2));
    for (const it of r.items) {
      placed.push({
        text: it.text, count: it.count, size: it.size, color: it.color, row: rowIndex,
        x, y: Math.round(y + (r.height - it.size) / 2), wpx: Math.round(it.wpx)
      });
      x += Math.round(it.wpx + gapOf(it.size));
    }
    y += Math.round(r.height * 1.35);
    rowIndex += 1;
  }
  return {
    width, height, fontFamily,
    background: [255, 255, 255],
    header: header || '',
    footer: footer || '',
    headerSize: header ? 22 : 0,
    footerSize: footer ? 13 : 0,
    margin,
    words: placed
  };
}

export {
  STOPWORDS, PALETTE, cleanText, countNgrams, neighborStats,
  entropyOf, cohesionOf, countWords, layout, estimateWidth,
  COHESION_MIN, FREEDOM_MIN, NGRAM_MAX
};
