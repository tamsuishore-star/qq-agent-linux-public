// QQ点赞技能：给 AI「给指定 QQ 用户送个人页赞」的能力。
//
// 与指令前置的 /赞 同一套协议口径（2026-10-03/04 实测定案）：
//   · snowluma 的点赞动作叫 send_like；NapCat 才叫 send_profile_like——先发
//     send_like，协议端回 unknown action 时换名重试一次；
//   · 协议单次最多 10 个赞，times 更大按 10 个一轮循环补（轮间 500ms）；
//   · QQ 对同一个人有每日额度，被拒时失败即停、按实送数回报。
//
// skill.json 的 tools[] 里声明了同一个工具（manifest 侧），这里 register 的是执行体。

const PER_CALL = 10;   // 协议端单次点赞上限
const MAX_TIMES = 50;  // 工具层上限：每日额度摆在那，再往上只是刷协议端

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function register(api) {
  api.registerTool({
    id: 'qq_like',
    name: '点赞',
    description: '给指定 QQ 用户的个人页点赞。user_id = 对方 QQ 号（必填，从对话上下文里认）；times = 次数（默认 10，范围 1~50，协议单次上限 10 自动分轮）。当日额度送满时只送得出去一部分，返回实送数。',
    category: 'message',
    icon: '👍',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '对方的 QQ 号（纯数字）' },
        times: { type: 'integer', description: '点赞次数，默认 10，范围 1~50' }
      },
      required: ['user_id']
    },
    async execute(ctx, args) {
      const userId = String(args?.user_id ?? '').replace(/\D/g, '');
      if (!userId || userId.length < 4 || userId.length > 12) {
        return { content: '错误：需要提供对方的 QQ 号（user_id，4~12 位纯数字）。认不出是谁就先问对方。', isError: true };
      }
      let times = Math.round(Number(args?.times));
      if (!Number.isFinite(times) || times <= 0) times = PER_CALL;
      times = Math.min(MAX_TIMES, times);

      // ⚠️ 必须以方法形式调用（onebot.call(...)，保留 receiver）——不能先解构再裸调，
      // 否则 call 内部 this.httpUrl 的 this 是 undefined，报
      // "Cannot read properties of undefined (reading 'httpUrl')"（2026-10-04 实测翻车）。
      const onebot = ctx?.onebot;
      if (!onebot || typeof onebot.call !== 'function') {
        return { content: '点赞失败：当前没有可用的协议连接，稍后再试。', isError: true };
      }

      // 动作名双兼容：snowluma = send_like，NapCat = send_profile_like
      const sendLike = async (n) => {
        try {
          return await onebot.call('send_like', { user_id: Number(userId), times: n });
        } catch (error) {
          if (/unknown action/i.test(String(error?.message ?? error))) {
            return onebot.call('send_profile_like', { user_id: Number(userId), times: n });
          }
          throw error;
        }
      };

      let done = 0;
      let lastError = '';
      const rounds = Math.ceil(times / PER_CALL);
      for (let i = 0; i < rounds; i += 1) {
        const n = Math.min(PER_CALL, times - done);
        try {
          await sendLike(n);
          done += n;
        } catch (error) {
          lastError = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 120);
          break;
        }
        if (i + 1 < rounds) await sleep(500);
      }

      if (!done) return { content: `点赞失败：${lastError || '协议端拒绝了这次操作'}`, isError: true };
      if (done < times) {
        return { content: `已为 ${userId} 点了 ${done} 个赞（要 ${times} 个，剩下的被拒了，多半是今天给这个人的赞已经送满）。` };
      }
      return { content: `已为 ${userId} 点了 ${done} 个赞。` };
    }
  });
}
