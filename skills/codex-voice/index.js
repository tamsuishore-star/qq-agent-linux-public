// codex的语音插件（Codex 定制版）：一个技能包，两个语音引擎。
// 引擎1 KK：GET https://api-v2.yuafeng.cn/API/kktts.php?action=voice&content=<文字>&voice_id=<音色ID>
//   免密钥。返回 JSON {code:0, data:{url:"<mp3 地址>"}}，实测 content-type audio/mpeg。
// 引擎2 TIAX：GET https://www.tiax.pw/API/yuyin.php?msg=<文字>&apikey=<密钥>&ys=<音色编号>
//   直接返回 MP3 二进制。音色编号 1-266（名字映射提取自 TIAX 文转音插件源码）。
//   内置密钥已实测可用（audio/mpeg）。如失效可在技能设置里更新。

const KK_API = 'https://api-v2.yuafeng.cn/API/kktts.php';
const TIAX_API = 'https://www.tiax.pw/API/yuyin.php';
const MAX_TEXT_LEN = 300;
const DEFAULT_TIAX_KEY = 'a11319ff2c79e573a06979ad2674fc6cab7fadec9cfb026375858eb85fb8be33';

// KK 引擎音色：别名 → 音色ID
const KK_VOICES = {
  '温柔女友': '94515b46345cc63b379bc046f5f88dd6',
  '苹果香': '94b8f3ec59b18723224b7ac5e3fa3a07',
  '网恋音': '6240a7ed1f462fdf1b143b3b406ec379',
  '夹子音': 'ded710805a714c2a4523b84a8ed96388',
  '青瘦音': '5ba65879589987546208ed81ade54ca1',
  '甜御音': '504f0c1ad23cb7200c1ebf6b39465f78'
};

// TIAX 引擎音色：名字 → 编号（共 266 个）
const TIAX_VOICES = {"2学长":1,"AD学姐":2,"alex克隆":3,"【红色警戒2】苏联情报员语音":4,"【宣传片】（大气悠扬浑厚）":5,"阿蕾奇诺":6,"爱莉希雅":7,"爱丽丝（中配）":8,"安倍晋三":9,"八戒":10,"白领御姐音":11,"白鹿的声音":12,"白岩松":13,"北方口音LY":14,"北京地铁黄华报站":15,"贝利亚":16,"毕业季温情女学生":17,"菠萝宝宝yuna":18,"伯纳德":19,"采访女生":20,"曹操":21,"茶文化班章老茶头":22,"陈赫":23,"陳章 台灣男聲 活力親切":24,"陈奕恒":25,"重音TETO SV":26,"重音teto":27,"吹牛逼呢":28,"磁性电台女生":29,"达叔":30,"大气宣传片配音":31,"大健康男医生":32,"丹恒，饮月":33,"三角洲蜂医":34,"道士别人的":35,"德俊7":36,"邓紫琪":37,"丁真":38,"丁真（锐刻五代版）":39,"东北雨姐":40,"東急の声 日本語":41,"東武 車内放送":42,"董卿":43,"董璇":44,"董宇辉":45,"动物科普":46,"抖兜":47,"豆包":48,"短视频":49,"方言":50,"仿真人（常用男配音、语速快）":51,"仿真人（男声、情绪平稳）":52,"仿真人（男声、偏用于广告）":53,"粉丝直播间喊麦":54,"冯宝宝":55,"フリーザ様":56,"母女对话（妈妈）":57,"甘雨":58,"感性女生配音":59,"钢镚":60,"高启强1":61,"高启强正常音色":62,"工作刘":63,"工商旅游001女":64,"关晓彤":65,"广告波音":66,"广告端庄女声":67,"郭德纲":68,"国恒":69,"台湾女":70,"夯大力":71,"郝邵文3":72,"合肥女主持人":73,"河源木桃香普通话":74,"黑卡蒂":75,"黑手":76,"嘿嘿温柔文艺女声":77,"弘历":78,"户晨风":79,"户山香澄":80,"花火导演1":81,"熊的研究所":82,"激进仔仔":83,"贾小军":84,"贾小军终极版":85,"贾维斯2":86,"间桐樱":87,"囁き声がちなメイドロボ":88,"让子弹飞-姜文":89,"蒋介石":90,"角栄":91,"今田りくさん音声":92,"金正恩":93,"近鉄 有田さん 車内放送":94,"九安":95,"军事纪录片配音":96,"卡卡西":97,"凯尔希中文":98,"科比（牢大）":99,"科普-小奇":100,"空":101,"扣比不":102,"懒羊羊":103,"老八":104,"老黑":105,"老蒋":106,"老马说车":107,"老人":108,"老三国关羽":109,"老女人快速版":110,"乐哥":111,"雷军":112,"磊哥":113,"李丽红舌尖":114,"李玫瑾":115,"李云龙":116,"丽丽":117,"历史纪录片-2006":118,"刘备-正常":119,"刘（王俊凯）":120,"刘晓燕":121,"卢本伟":122,"卢本伟（新模型）":123,"绿衣女主持人爆款声":124,"落ち着いた男性":125,"落ち着いた女性":126,"麦当劳":127,"马保国":128,"麦克阿瑟":129,"满穗！！！":130,"满穗（23穗）":131,"满穗-欢快":132,"毛老师激情版":133,"美股南哥":134,"美輪明宏_肉声":135,"美輪明宏Ver.02":136,"魔魔":137,"蜜雪女主播":138,"奶龙(效果最好的一个)":139,"纳西妲 (原神)女声":140,"男の子":141,"男性ナレーター":142,"男主":143,"男声白老师":144,"小俊":145,"南柏先生声音（激情版）":146,"女大学生":147,"自分４":148,"千年":149,"強弱なしこまいぼいす":150,"青浦中安报站":151,"青子":152,"清雅女声":153,"祁同伟":154,"少年2":155,"小说抒情男":156,"シャア・アズナブル":157,"人生のたび":158,"日本人渋い声の男性":159,"日化发货2":160,"日漫少女":161,"日常营销号":162,"赛博朋克":163,"诗歌剧":164,"三月七":165,"桑海":166,"山鸡":167,"山田凉":168,"少女声音":169,"少羽（杨志平）":170,"舌尖上的中国":171,"沈腾":172,"声音":173,"说书03":174,"盛国恒":175,"小樱":176,"GTI指挥官":177,"士道":178,"电影解说":179,"影视解说":180,"跳跳":181,"游戏解说-快":182,"台湾女女":183,"帅帅的大男孩 +可疑":184,"沢城みゆき":185,"Ran Mouri (毛利蘭)":186,"四郎生气":187,"田中角栄の声":188,"户外女主播":189,"孙笑川258":190,"孙盈盈（声音1）":191,"孫悟空":192,"台湾男":193,"太乙真人自用版":194,"太平盛世":195,"唐三":196,"唐僧":197,"糖猫米雪儿":198,"陶矜":199,"陶衿":200,"特遣队员（男）.mp3":201,"天童爱丽丝（中配）":202,"天宇一休":203,"甜美女主播":204,"甜美女声":205,"潮汐摆摆":206,"万子颖":207,"王琨":208,"王琨声音模型10.17t1":209,"王俊凯":210,"王炸音频":211,"王者李白":212,"王一博":213,"1204-女主持人":214,"温柔动听女声":215,"吴彦祖15":216,"五条悟":217,"小小班班班":218,"闲鱼配音大壮":219,"ギャル子":220,"小凡-激动":221,"小孩3":222,"小明剑魔":223,"小莹":224,"新幹線・車内放送の声[男性]":225,"新游戏解说":226,"信ボイスver1.0":227,"行善":228,"熊二":229,"旭旭宝宝":230,"宣传片":231,"雪莉酒（女）":232,"二狗":233,"月半猫":234,"央视配音":235,"杨幂":236,"我叫夯大力（包像版）":237,"仙逆1":238,"中医提问":239,"范志波（专家）":240,"12.9 王鑫":241,"俄罗斯":242,"磁性男声":243,"爱莉":244,"不知火舞":245,"赵阳":246,"黑碎屏":247,"赛马娘":248,"痞老板2":249,"fufu大王3.0（初音未来）":250,"有兽焉 天禄":251,"鱼木123":252,"御女茉莉":253,"买量解说":254,"八重":255,"中年老女性":256,"眼前这位老哥":257,"张颂文":258,"蔚蓝档案爱丽丝中文":259,"游戏男解说":260,"24.12.27违医生":261,"蔡徐坤":262,"英国海军(British Navy)G&B":263,"琨哥":264,"王安宇":265,"章鱼哥":266};

let cfg = () => ({});

export function setup(api) {
  cfg = api.config;
  api.log('codex的语音插件已加载（KK + TIAX 双引擎）');

  api.registerTool({
    id: 'tts_send_voice',
    name: '文字转语音',
    description: '把一段文字转成语音并发到当前会话。内置双引擎：KK 引擎（温柔女友/苹果香/网恋音/夹子音/青瘦音/甜御音或任意32位音色ID）和 TIAX 引擎（266 种音色，如丁真、郭德纲、懒羊羊等，可报名字或编号 1-266）。当用户发送「#语音 文本」「#kk 文本」「#tts 文本」、或要求「发语音」「用语音说」「文字转语音」时使用。voice 参数可选，传音色名字或编号；engine 参数可选（kk/tiax），不填会自动判断。',
    category: 'media',
    icon: '🎙️',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要转成语音的文字，最长 300 字' },
        voice: { type: 'string', description: '音色名字或编号，可选。KK：温柔女友等别名或32位音色ID；TIAX：音色名（如 丁真）或编号 1-266。不填用默认音色' },
        engine: { type: 'string', enum: ['kk', 'tiax'], description: '指定引擎，可选。不填会根据音色自动判断' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args?.text ?? '').trim();
      if (!text) return { content: '缺少 text 参数：请提供要转成语音的文字', isError: true };
      if (text.length > MAX_TEXT_LEN) {
        return { content: '文字太长（' + text.length + ' 字），最多 ' + MAX_TEXT_LEN + ' 字。请拆成几段分别转换', isError: true };
      }

      const picked = resolveVoice(args?.voice, args?.engine);
      if (picked.error) return { content: picked.error, isError: true };

      let audio = null;
      let fallbackUrl = '';
      try {
        const r = picked.engine === 'kk'
          ? await synthKK(api, text, picked.voiceId)
          : await synthTiax(api, text, picked.voiceId);
        audio = r.buf;
        fallbackUrl = r.url;
      } catch (error) {
        return { content: '语音生成失败：' + (error?.message ?? error), isError: true };
      }
      if (!audio || audio.length < 100) {
        return { content: '语音生成失败：接口返回的不是有效音频', isError: true };
      }

      const fileRef = 'base64://' + audio.toString('base64');
      const label = '[语音] ' + text.slice(0, 30);
      try {
        await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: fileRef } }], { label: label });
        return { content: '已把语音发到当前会话（音色：' + picked.label + '）。不要再用文字复述这句话。' };
      } catch (error1) {
        if (fallbackUrl && fileRef !== fallbackUrl) {
          try {
            await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: fallbackUrl } }], { label: label });
            return { content: '已把语音发到当前会话（音色：' + picked.label + '）。不要再用文字复述这句话。' };
          } catch (error2) {
            return { content: '语音发送失败：' + (error2?.message ?? error2) + '（第一次：' + (error1?.message ?? error1) + '）', isError: true };
          }
        }
        return { content: '语音发送失败：' + (error1?.message ?? error1), isError: true };
      }
    }
  });

  api.registerTool({
    id: 'tts_list_voices',
    name: '查询可用音色',
    description: '返回语音插件的可用音色说明：KK 引擎 6 个别名 + TIAX 引擎 266 个音色（报名字或编号均可）。当用户问「有哪些音色」「语音音色」「怎么换声音」时使用。',
    category: 'query',
    icon: '🎵',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const kkLines = Object.keys(KK_VOICES).map(function (k) { return '- ' + k; }).join('\n');
      const examples = ['丁真', '郭德纲', '懒羊羊', '爱莉希雅']
        .map(function (n) { return TIAX_VOICES[n] != null ? n + '(' + TIAX_VOICES[n] + '号)' : null; })
        .filter(Boolean).join('、');
      return {
        content: '【KK 引擎】\n' + kkLines + '\n- 或任意 32 位音色ID\n\n【TIAX 引擎】共 ' + Object.keys(TIAX_VOICES).length + ' 个音色（编号 1-266）\n例如：' + examples + '\n说音色名字或编号都行'
      };
    }
  });
}

/** 解析音色请求 → {engine, voiceId, label} 或 {error} */
function resolveVoice(requested, engine) {
  const wanted = String(requested ?? '').trim();
  const wantEngine = String(engine ?? '').trim().toLowerCase();
  const cfgKK = String(cfg().defaultVoice || '温柔女友').trim();
  const cfgTiax = String(cfg().tiaxDefaultVoice || '7').trim();

  if (wanted) {
    if (KK_VOICES[wanted]) return { engine: 'kk', voiceId: KK_VOICES[wanted], label: wanted };
    if (TIAX_VOICES[wanted] != null) return { engine: 'tiax', voiceId: String(TIAX_VOICES[wanted]), label: wanted + '（' + TIAX_VOICES[wanted] + '号）' };
    if (/^[0-9a-fA-F]{16,64}$/.test(wanted)) return { engine: 'kk', voiceId: wanted, label: '自定义音色ID' };
    if (/^\d{1,3}$/.test(wanted)) {
      const n = parseInt(wanted, 10);
      if (n >= 1 && n <= 321) return { engine: 'tiax', voiceId: String(n), label: n + '号音色' };
      return { error: '音色编号要在 1-321 之间' };
    }
    if (wantEngine === 'kk') return { error: 'KK 引擎不认识音色「' + wanted + '」。可用：' + Object.keys(KK_VOICES).join('、') + '，或 32 位音色ID' };
    if (wantEngine === 'tiax') return { error: 'TIAX 引擎不认识音色「' + wanted + '」，请用音色名或编号 1-266，可先用 tts_list_voices 查询' };
    return { error: '不认识音色「' + wanted + '」。KK 引擎音色：' + Object.keys(KK_VOICES).join('、') + '；TIAX 引擎另有 266 个音色（说名字或编号 1-266），可先用 tts_list_voices 查询' };
  }

  if (wantEngine === 'tiax') return { engine: 'tiax', voiceId: cfgTiax, label: cfgTiax + '号音色（TIAX 默认）' };
  const kkId = KK_VOICES[cfgKK] || (/^[0-9a-fA-F]{16,64}$/.test(cfgKK) ? cfgKK : KK_VOICES['温柔女友']);
  const kkName = Object.keys(KK_VOICES).find(function (k) { return KK_VOICES[k] === kkId; }) || '自定义音色';
  return { engine: 'kk', voiceId: kkId, label: kkName };
}

/** KK 引擎合成：JSON → 拿 MP3 地址 → 下载 */
async function synthKK(api, text, voiceId) {
  const url = KK_API + '?action=voice&content=' + encodeURIComponent(text) + '&voice_id=' + encodeURIComponent(voiceId);
  const res = await api.fetch(url);
  if (!res.ok) throw new Error('KK 接口返回 HTTP ' + res.status);
  const json = api.utils.safeJsonParse(await res.text(), null);
  if (!json || json.code !== 0) throw new Error('KK 语音生成失败：' + (json?.msg || '接口返回异常'));
  const audioUrl = String(json?.data?.url || '').trim();
  if (!audioUrl) throw new Error('KK 语音生成失败：接口没有返回音频地址');
  return { buf: await downloadAudio(api, audioUrl), url: audioUrl };
}

/** TIAX 引擎合成：响应本身就是 MP3 二进制 */
async function synthTiax(api, text, voiceId) {
  const key = String(cfg().tiaxApikey || DEFAULT_TIAX_KEY).trim();
  const url = TIAX_API + '?msg=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(key) + '&ys=' + encodeURIComponent(voiceId);
  const res = await api.fetch(url);
  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try {
      const j = api.utils.safeJsonParse(await res.text(), null);
      if (j && j.error && j.error.message) detail = j.error.message;
    } catch (e) {}
    throw new Error('TIAX 语音生成失败：' + detail);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const isAudio = buf.slice(0, 3).toString('latin1') === 'ID3' || buf[0] === 0xFF;
  if (!isAudio) {
    let msg = '接口没有返回音频';
    try {
      const j = api.utils.safeJsonParse(buf.toString('utf8'), null);
      if (j && j.error && j.error.message) msg = j.error.message;
      else if (j && j.msg) msg = j.msg;
    } catch (e) {}
    throw new Error('TIAX 语音生成失败：' + msg + '（若提示密钥无效，请到技能设置里更新 TIAX API 密钥）');
  }
  return { buf: buf, url: url };
}

/** 下载音频 */
async function downloadAudio(api, url) {
  const res = await api.fetch(url);
  if (!res.ok) throw new Error('音频下载失败：HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}