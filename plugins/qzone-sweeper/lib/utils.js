// 空间互动插件的两个纯函数层：**HTML 转文本** 与 **内容/隐私闸门**。
//
// 为什么单独拆出来：这两层是纯函数（输入字符串 → 输出字符串/判定结果），
// 不碰网络、不碰磁盘，可以单独 import 出来跑测试。索引和状态那些有副作用的东西
// 混在一起的话，"评论为什么被拒"这种事就只能靠线上复现，代价太大。
//
// ── 为什么 cgi 的正文要过一层 HTML 转换 ────────────────────────────────────
// Qzone 的 emotion_cgi_msglist_v6 / feeds3_html_more 返回的 `content` 与 `html`
// 是**带标签的富文本**：`<div>今天好累</div><img src=".../e100.gif">`。
// 表情在空间里不是 unicode emoji，而是 `e100.gif` 这种**情感图** —— 直接丢掉的话，
// 满屏表情的说说会变成空白，模型就会以为"这人没写内容"而去瞎评论。
// 所以：文本节点保留、`e{数字}` 的图换成 `[表情]` 占位、其余标签丢掉。
// 反过来也不能原样把 HTML 喂给模型：标签会白烧 token，还容易被模型当成格式指令。

/** HTML 实体表。只列空间正文里真会出现的那些，不做完整 HTML5 表。 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–'
};

/**
 * HTML 片段 → 纯文本。
 *
 * 处理顺序有讲究：
 *   ① 先把 `<br>`/`</div>`/`</p>` 这类**块级边界**换成换行 —— 晚了就被下面的
 *      标签清理一起吞掉，整段话会挤成一行。
 *   ② 再换表情图（e{数字}.gif 等）为 [表情]。
 *   ③ 再剥剩下的标签。
 *   ④ 最后解实体 + 压空白。
 */
export function htmlToText(input) {
  let s = String(input ?? '');
  if (!s) return '';
  // ① 块级边界 → 换行
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n');
  // ② 空间的情感图（表情包）→ [表情]。e100.gif / emo_1.png / face_2.gif 都算。
  s = s.replace(/<img\b[^>]*?src\s*=\s*["']?([^"'>\s]+)[^>]*>/gi, (m, src) => {
    const u = String(src || '').toLowerCase();
    if (/(^|\/)(e\d+|em\d*|emo[_\-]?\d*|face[_\-]?\d*|[a-z]*emoji[a-z0-9_]*)\.[a-z]+$/.test(u)) return '[表情]';
    if (/\/(e|em|face|emoji)[^/]*\.(gif|png|jpg|jpeg|webp)$/.test(u)) return '[表情]';
    return '';                                  // 普通配图不放正文里，图片信息另有字段
  });
  // ③ 剥标签
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  // ④ 实体
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name) => {
    const key = String(name).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : m;
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : m;
    }
    return m;
  });
  // ⑤ 压空白：换行最多留一个，行内多个空格并成一个，去首尾空白行
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}

function safeFromCodePoint(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/**
 * 折叠成一行并限长 —— 给日志和回执用，避免把一整条说说塞进返回值。
 * 注意：这里**不**删换行之外的东西，正文本身要保持原样给模型看。
 */
export function oneLine(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 抹掉正文里的 @ 与裸 QQ 号 —— 见文件头"别人的空间不提群友"那条。 */
export function stripMentions(text) {
  return String(text ?? '')
    .replace(/@\{?uin:(\d+)\}?/gi, '')
    .replace(/@[^\s@，。！？!?,、]{1,20}/g, '')
    .replace(/[（(【\[]\s*\d{5,12}\s*[)）】\]]/g, '')
    .replace(/\b\d{6,12}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 平台级红线：时政 / 违法 / 辱骂。命中即拒，**不区分来源**（用户让你评也照查）。
 *
 * 这份词表是粗筛，一定会有漏网，所以它只是最后一道，不是唯一一道 ——
 * 提示词里同样明确禁止了这类内容。宁可偶尔误杀一句正常评论，
 * 也不要让机器人跑到别人空间底下发表政治言论或骂人。
 */
const PLATFORM_BANNED = [
  // 时政 / 社会敏感
  '政治', '政府', '共产党', '国民党', '领导人', '主席', '总统', '体制', '独裁', '民主',
  '游行', '示威', '抗议', '维权', '审查', '封杀', '翻墙', '墙国', '战狼',
  '台独', '港独', '疆独', '藏独', '分裂国家', '反华',
  '疫情', '封城', '核酸', '疫苗', '灾难', '地震', '洪水', '空难', '事故死亡',
  '宗教', '穆斯林', '基督教', '法轮',
  // 违法 / 黑灰产
  '赌博', '博彩', '洗钱', '枪支', '毒品', '冰毒', '大麻', '代开发票', '刷单返利',
  '色情', '裸聊', '约炮', '援交', '卖淫',
  // 辱骂 / 攻击
  '傻逼', '煞笔', '沙比', '智障', '脑残', '废物', '滚你', '操你', '草你', '尼玛',
  '去死', '死全家', '贱人', '婊子', '杂种'
];

/**
 * 评论内容闸门。
 * @param {string} text 已抹过 @ 的评论正文
 * @param {string[]} extra 用户在设置里加的额外禁词
 * @returns {{ok:boolean, hit?:string, reason?:string}}
 */
export function checkComment(text, extra = []) {
  const s = String(text ?? '').trim();
  if (!s) return { ok: false, reason: '评论是空的。' };
  if (s.length > 200) return { ok: false, reason: `评论太长了（${s.length} 字），空间评论最多一两句，压到 200 字以内。` };

  for (const w of PLATFORM_BANNED) {
    if (s.includes(w)) {
      return { ok: false, hit: w, reason: `命中平台红线词「${w}」。别人空间底下不能出现时政、违法或辱骂内容，换一句正常的话。` };
    }
  }
  for (const raw of extra || []) {
    const w = String(raw || '').trim();
    if (w && s.includes(w)) {
      return { ok: false, hit: w, reason: `命中你设置的禁词「${w}」，换个说法。` };
    }
  }
  return { ok: true };
}

/**
 * 空话检测：不是硬拦，只用来在回执里提醒模型"这句太空了"。
 * 真人不会在别人的说说底下写"真不错""支持一下"，那一眼就是机器人。
 */
const EMPTY_PHRASES = ['真不错', '支持一下', '支持支持', '不错不错', '说得好', '点赞', '加油哦', '厉害了', '挺好的', '真好', '牛', '666'];
export function looksEmpty(text) {
  const s = String(text ?? '').trim();
  if (!s) return true;
  if (s.length <= 4) return true;
  return EMPTY_PHRASES.includes(s);
}

/** 把像 QQ 号的列表转成干净的数字字符串数组。 */
export function parseIdList(raw) {
  return String(raw ?? '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d{4,12}$/.test(x));
}

/** 当前是否落在免打扰时段内。支持跨零点（22:00-08:00）。留空/解析失败 = 不限制。 */
export function inQuietHours(spec, now = new Date()) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec ?? ''));
  if (!m) return false;
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/** 时间戳（秒或毫秒都收）→ 本地可读字符串，给模型看。 */
export function fmtTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 相对时间（"3 小时前"），比绝对时间更适合模型判断新不新。 */
export function fmtAgo(ts, now = Date.now()) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const ms = n > 1e12 ? n : n * 1000;
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
