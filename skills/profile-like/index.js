// 名片点赞（技能 / LLM 型）
//
// 触发：群友或好友对机器人说「赞我」「给我点个赞」时，模型调用 like_profile 工具，
// 本文件通过 OneBot 的 send_like 动作给对方的 QQ 名片点赞。
//
// 关于 send_like：SnowLuma 已实现该动作（其 actions 表里定义为
//   defineAction({ name: "send_like", summary: "点赞", params: { user_id, times } })
// 参数就是「对方的 QQ 号」和「点几下」。本项目自带的工具里没有点赞，
// 所以这里直接走 ctx.onebot.call()，和内置工具读转发消息用的是同一套调用通道。
//
// 关于「为什么做成技能而不是插件」：本系统给插件的确定性通道只有 media.download、
// llm.request-params 这类**能力**，并没有「每条消息都能看到」的钩子（见
// plugins/red-packet-radar 文件头的说明）。「赞我」这种要先认人、再认意图的触发
// 只能交给模型判断，也就是给模型多一个可调用的工具 —— 这正是技能的定义。

/** 同一 QQ 号最近一次被点赞的时间戳（防连点；进程内有效，重启即清空）。 */
const lastLikedAt = new Map();

/** 把任意输入夹到 [min, max] 的整数；不是数字就返回 fallback。 */
function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function register(api) {
  api.registerTool({
    id: 'like_profile',
    name: '名片点赞',
    description: '给某个群友/好友的 QQ 名片点赞（就是名片赞，对方名片上的点赞数会 +1）。'
      + '适用：对方说「赞我」「给我点个赞」「帮我赞一下」时。'
      + 'userId 填对方的数字 QQ 号；如果对方说的就是「赞我」、而且他就是当前跟你说话的人，'
      + '可以不传 userId，工具会自动赞最近说话的那个人。'
      + '绝对不能传昵称、「我」、「你」这类词，也不许给机器人自己的 QQ 号点赞；'
      + '不认识的 QQ 号先别猜，去聊天记录里找「名字(QQ:数字)」。'
      + '同一个人短时间内不要重复调用（工具有冷却，重复调用只会白跑一趟）。',
    category: 'messaging',
    icon: '👍',
    parameters: {
      type: 'object',
      properties: {
        userId: {
          type: ['integer', 'string'],
          description: '要赞的对方的数字 QQ 号。对方说「赞我」且他就是当前说话人时可以省略。'
        },
        times: {
          type: 'integer',
          description: '点赞数量，1~20。一般不用传，会按技能设置里的默认数量。'
        }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        const cfg = api.config() || {};
        const maxTimes = clampInt(cfg.maxTimes, 1, 20, 20);
        const defaultTimes = clampInt(cfg.defaultTimes, 1, maxTimes, 10);
        const cooldownSec = clampInt(cfg.cooldownSeconds, 0, 86400, 30);

        // ── 认人：优先用模型给的 QQ 号；没给就认为「要让机器人点赞的是刚说话的那个人」──
        // 兜底用存档里最后一条「别人发的」消息，正好对应「@机器人 赞我」这个场景。
        let targetId = String(args?.userId ?? '').trim();
        let targetName = '';
        if (!targetId) {
          const recent = ctx.store?.recent?.(ctx.chatKey, { limit: 20, includeSelf: false }) || [];
          const last = [...recent].reverse().find((m) => m && String(m.senderId || '').trim());
          if (last) {
            targetId = String(last.senderId).trim();
            targetName = String(last.senderName || '');
          }
        }
        if (!targetId) {
          return { content: '错误：不知道要给谁点赞。请把对方的数字 QQ 号填进 userId。', isError: true };
        }
        if (!/^\d{2,12}$/.test(targetId)) {
          return {
            content: `错误：userId 必须是纯数字的 QQ 号（收到：${targetId}）。`
              + '不知道对方 QQ 号时，去聊天记录里找「名字(QQ:数字)」里的数字，别传昵称。',
            isError: true
          };
        }
        if (String(ctx.selfId || '') === targetId) {
          return { content: '错误：这是机器人自己的 QQ 号，机器人不能给自己点赞。要赞别人请传对方的 QQ 号。', isError: true };
        }
        if (!ctx.onebot || typeof ctx.onebot.call !== 'function') {
          return { content: '错误：当前没有连上 QQ 协议端，点赞发不出去。', isError: true };
        }

        // ── 冷却：同一个人短时间内只赞一次 ──
        const now = Date.now();
        const waitMs = cooldownSec * 1000 - (now - (lastLikedAt.get(targetId) || 0));
        if (waitMs > 0) {
          return {
            content: `刚刚才给 ${targetName || ''}(${targetId}) 点过赞，还要等 ${Math.ceil(waitMs / 1000)} 秒才能再点。`
              + '请跟对方说一句「等会儿再赞」，不要谎称已经赞了。'
          };
        }

        const times = clampInt(args?.times, 1, maxTimes, defaultTimes);
        await ctx.onebot.call('send_like', { user_id: Number(targetId), times });
        lastLikedAt.set(targetId, Date.now());

        const who = targetName ? `${targetName}(QQ:${targetId})` : `QQ:${targetId}`;
        return {
          content: JSON.stringify({
            ok: true,
            userId: targetId,
            times,
            note: `已给 ${who} 的 QQ 名片点了 ${times} 个赞。回一句很轻的话就行（比如「点了」），别邀功别啰嗦。`
          }, null, 1)
        };
      } catch (error) {
        return {
          content: `点赞失败：${error?.message ?? error}。`
            + '常见原因：对方不是好友（名片赞大多只能给好友点）、或协议端不支持该动作。'
            + '如实告诉对方「赞不上」，不要假装成功。',
          isError: true
        };
      }
    }
  });
}
