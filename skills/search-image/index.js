let cfg = () => ({});
let httpFetch = null;

export function setup(api) {
  cfg = api.config;
  httpFetch = typeof api.fetch === 'function' ? (...args) => api.fetch(...args) : null;

  api.registerTool({
    id: 'search_image',
    name: '搜图发图',
    description: '根据关键词搜索图片并发送到当前会话。当用户说“搜图 猫”“找一张风景图”“发张二次元图”等需要图片时使用。参数 keyword 是搜索关键词，越具体越准。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，例如“猫”“风景”“二次元”' },
        count: { type: 'number', description: '要发送几张，1~5，默认用设置里的值' }
      },
      required: ['keyword']
    },
    async execute(ctx, args) {
      const c = cfg();
      const keyword = String(args?.keyword ?? '').trim();
      if (!keyword) {
        return { content: '缺少 keyword：请告诉我要搜什么图。', isError: true };
      }

      if (!httpFetch) {
        return { content: '未启用网络权限（web_fetch），无法搜图。', isError: true };
      }

      const apiId = String(c.apiId ?? '').trim();
      const apiKey = String(c.apiKey ?? '').trim();
      if (!apiId || !apiKey) {
        return {
          content: '还没配置搜图 API。请在 QQ Agent 的「技能」页找到“搜图发图”，填入 apihz 的 ID 和 KEY。',
          isError: true
        };
      }

      const maxCount = clamp(Number(c.maxCount) || 3, 1, 5);
      const defaultCount = clamp(Number(c.defaultCount) || 1, 1, maxCount);
      const count = clamp(Number(args?.count) || defaultCount, 1, maxCount);

      try {
        const url = new URL(String(c.apiUrl || 'https://cn.apihz.cn/api/img/apihzimgbaidu.php'));
        url.searchParams.set('id', apiId);
        url.searchParams.set('key', apiKey);
        url.searchParams.set('words', keyword);
        url.searchParams.set('page', '1');
        url.searchParams.set('type', '1');
        url.searchParams.set('limit', String(count));

        const resp = await httpFetch(url.toString(), {
          method: 'GET',
          headers: { 'User-Agent': 'QQAgent/1.0' }
        });

        if (!resp.ok) {
          return { content: `搜图接口请求失败：HTTP ${resp.status}`, isError: true };
        }

        const data = await resp.json().catch(() => null);
        if (!data || data.code !== 200 || !data.data) {
          const msg = data?.msg || data?.message || '接口没有返回可用图片';
          return { content: `没搜到「${keyword}」的图片：${msg}`, isError: true };
        }

        let items = data.data;
        if (items && !Array.isArray(items)) items = [items];
        if (!Array.isArray(items) || items.length === 0) {
          return { content: `没搜到「${keyword}」的图片，换个词试试？`, isError: true };
        }

        const urls = items
          .map((it) => it?.imgurl || it?.url || it?.image_url)
          .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
          .slice(0, count);

        if (urls.length === 0) {
          return { content: '搜到了结果，但没有可用的图片链接。', isError: true };
        }

        let sent = 0;
        for (const imgUrl of urls) {
          try {
            await ctx.sender.sendImage(ctx.chatKey, { url: imgUrl }, { note: `搜图：${keyword}` });
            sent += 1;
          } catch {
            // 单张失败就跳过，继续尝试下一张
          }
        }

        if (sent === 0) {
          return { content: '找到了图片，但发送失败了。请稍后再试。', isError: true };
        }

        return { content: `已发送 ${sent} 张「${keyword}」的图片。不要再复述图片内容。` };
      } catch (error) {
        return { content: `搜图失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
}

export function available() {
  return true;
}