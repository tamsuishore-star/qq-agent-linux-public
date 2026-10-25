// 离线自检：node "D:\qqagent\QQ Agent\resources\app\skills\agent-reach\tools\test-skill.mjs"
// 不走 qqagent 主进程：直接把 index.js 当 ESM 载入，塞一个假的 api，逐个调工具。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(here);
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); } };

const manifest = JSON.parse(fs.readFileSync(path.join(skillDir, 'skill.json'), 'utf8'));
const tools = new Map();
const mod = await import(pathToFileURL(path.join(skillDir, 'index.js')).href);
mod.register({ registerTool: (t) => tools.set(t.id, t), log: () => {}, warn: () => {}, error: () => {} });
const call = (id, args) => tools.get(id).execute({ chatKey: 'test', session: { sent: [] }, sender: {} }, args);

console.log('A skill.json');
ok('id = agent-reach', manifest.id === 'agent-reach', manifest.id);
ok('entry = index.js', manifest.entry === 'index.js', manifest.entry);
ok('声明了 4 个工具', manifest.tools.length === 4, String(manifest.tools.length));
ok('permissions 只有 web_fetch', JSON.stringify(manifest.permissions) === JSON.stringify(['web_fetch']), JSON.stringify(manifest.permissions));

console.log('B 注册的工具');
ok('web_read', tools.has('web_read'));
ok('bili_search', tools.has('bili_search'));
ok('rss_read', tools.has('rss_read'));
ok('reach_doctor', tools.has('reach_doctor'));
ok('工具名不会超过 64 字符', [...tools.keys()].every((k) => `agent-reach__${k}`.length <= 64));

console.log('C web_read 守卫');
const r1 = await call('web_read', { url: 'http://127.0.0.1:3210/api/status' });
ok('内网地址被拒', r1.isError === true && /本机\/内网/.test(r1.content), r1.content?.slice(0, 80));
const r2 = await call('web_read', { url: 'file:///C:/Windows/win.ini' });
ok('非 http 协议被拒', r2.isError === true && /http/.test(r2.content), r2.content?.slice(0, 80));
const r3 = await call('web_read', { url: 'http://192.168.1.1/' });
ok('192.168 被拒', r3.isError === true, r3.content?.slice(0, 80));
const r4 = await call('rss_read', { url: 'http://localhost:8080/feed.xml' });
ok('rss_read 也拦内网', r4.isError === true, r4.content?.slice(0, 80));

console.log('D 联网能力（B 站可用，境外站点本机本来就超时）');
const r5 = await call('bili_search', { keyword: '鲸鱼女仆', count: 3 });
if (r5.isError) {
  console.log(`  ! B 站搜索这次没通（网络波动，不计失败）：${r5.content?.slice(0, 100)}`);
} else {
  ok('返回了 BV 链接', /bilibili\.com\/video\/BV/.test(r5.content), r5.content?.slice(0, 120));
  ok('条数受 count 限制', (r5.content.match(/bilibili\.com\/video\//g) || []).length <= 3);
}
const r6 = await call('rss_read', { url: 'https://r.jina.ai/https://example.com' });
ok('连不上的源给出可读错误而不是抛异常', r6.isError === true && typeof r6.content === 'string', String(r6.content).slice(0, 90));

console.log('E reach_doctor（真的跑上游 CLI）');
const r7 = await call('reach_doctor', {});
if (r7.isError) {
  console.log(`  ! doctor 没给出 JSON（不计失败）：${r7.content?.slice(0, 120)}`);
} else {
  ok('报出渠道可用数', /渠道体检：\d+\/\d+ 可用/.test(r7.content), r7.content.slice(0, 80));
  ok('带上可用/不可用标记', /[✅❌]/.test(r7.content));
}

console.log(`\nagent-reach：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
