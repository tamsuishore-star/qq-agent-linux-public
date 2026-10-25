// owner-whitelist 自测（离线，不联网、**绝不碰真实配置**）。
//
// 用法：
//   & "<QQ Agent 安装目录>\resources\app\snowluma\node.exe" selftest.mjs
//   （在技能目录里跑；用安装目录自带的 node.exe，不必另装 Node）
//
// 覆盖：清单合法性（含"不再依赖外部能力"）、工具注册、主人名单解析与闸门
//       （未填号码 / 非主人 / 取不到号码）、增删查三种动作、当前会话缺省、幂等、
//       号码校验、上限、黑名单冲突与「留空放行」副作用提醒、写失败的用户可见性、
//       核心配置接线（含 deepMerge 数组语义）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill.json'), 'utf8'));
const mod = await import('./index.js');

// ── 测试脚手架 ─────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('异步用例请用 acheck');
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}: ${error?.message ?? error}`);
  }
};
const acheck = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}: ${error?.message ?? error}`);
  }
};

/** 配置桩：与核心 deepMerge 同款语义（对象递归、数组整体替换），并记录每次写入。 */
function makeConfigStore(init = {}) {
  const state = {
    allow: { groups: [], private: [], ...(init.allow || {}) },
    deny: { groups: [], private: [], ...(init.deny || {}) },
    allowAllWhenEmpty: init.allowAllWhenEmpty === true,
  };
  const writes = [];
  const merge = (base, patch) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = merge(base[k], v);
      } else {
        out[k] = structuredClone(v);
      }
    }
    return out;
  };
  return {
    state,
    writes,
    ops: {
      getConfig: () => structuredClone(state),
      updateConfig: (patch) => {
        writes.push(structuredClone(patch));
        Object.assign(state, merge(state, patch));
        return structuredClone(state);
      },
    },
  };
}

/**
 * 假 api。capability / hasCapability 故意做成"一调就炸"：
 * 本技能宣称**不再依赖**任何外部能力，这个陷阱就是那条断言的执行者 ——
 * 将来谁把软依赖加回来，自测立刻红。
 */
function makeApi({ ownerIds = '1062935770' } = {}) {
  const tools = [];
  const logs = [];
  const api = {
    config: () => ({ enabled: true, ownerIds }),
    registerTool: (def) => { tools.push(def); return `owner-whitelist__${def.id}`; },
    capability: () => { throw new Error('本技能不该再调用 api.capability（已去掉前置依赖）'); },
    hasCapability: () => { throw new Error('本技能不该再调用 api.hasCapability（已去掉前置依赖）'); },
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push(`WARN ${a.join(' ')}`),
  };
  return { api, tools, logs };
}

const tool0 = (tools) => tools.find((t) => t.id === 'whitelist');
const ctxGroup = (senderId, id = '546789624') => ({
  chatKey: `group:${id}`, kind: 'group', chatId: id, selfId: '10001',
  session: { trigger: [{ senderId }] }, store: { recent: () => [] },
});
const ctxPrivate = (senderId, id = '1062935770') => ({
  chatKey: `private:${id}`, kind: 'private', chatId: id, selfId: '10001',
  session: { trigger: [{ senderId }] }, store: { recent: () => [] },
});

// ── [1] 清单 ───────────────────────────────────────────────────────────────
console.log('\n[1] 清单与注册');
{
  check('id 合法且与目录名一致', () => {
    assert.match(manifest.id, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    assert.equal(manifest.id, path.basename(SKILL_DIR));
  });
  check('category 在允许值内', () => assert.ok(['model', 'message', 'knowledge', 'media', 'utility'].includes(manifest.category), manifest.category));
  check('已去掉前置依赖（不再声明 requires）', () => {
    assert.ok(!manifest.requires || manifest.requires.length === 0, JSON.stringify(manifest.requires));
  });
  check('设置里有主人 QQ 号这一项', () => {
    assert.ok('ownerIds' in manifest.settings, 'settings.ownerIds 不存在');
    assert.equal(manifest.settings.ownerIds, '');
    assert.ok(manifest.configSchema.ownerIds?.label, 'configSchema.ownerIds 缺 label');
    assert.ok(String(manifest.configSchema.ownerIds.description).includes('留空'), '要说清留空会怎样');
  });
  check('提示词片段合法（id/priority/content）', () => {
    const s = manifest.prompt?.sections?.[0];
    assert.ok(s, '缺少 prompt.sections[0]');
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.ok(s.priority > 0 && s.priority <= 99, String(s.priority));
    assert.ok(String(s.content).includes('owner-whitelist__whitelist'), '片段里要写清工具名');
    assert.ok(String(s.content).includes('自行校验'), '要说明主人身份由工具自己校验');
  });
  check('configSchema 与 settings 键一致', () => assert.deepEqual(Object.keys(manifest.configSchema).sort(), Object.keys(manifest.settings).sort()));
}

// ── [2] 工具注册 ───────────────────────────────────────────────────────────
console.log('\n[2] 工具注册');
const { api, tools } = makeApi({});
mod.setup(api);
{
  check('注册了 1 个工具且短名是 whitelist', () => {
    assert.equal(tools.length, 1);
    assert.equal(tools[0].id, 'whitelist');
  });
  check('id 字符集安全、总长 ≤64', () => {
    const full = `owner-whitelist__${tools[0].id}`;
    assert.match(full, /^[a-zA-Z0-9_-]+$/);
    assert.ok(full.length <= 64, String(full.length));
  });
  check('description 写清了「做什么 + 什么时候用 + 谁能用」', () => {
    const d = tools[0].description;
    assert.ok(d.includes('聊天白名单'), '要说清做什么');
    assert.ok(d.includes('调用本工具'), '要说清什么时候调用');
    assert.ok(d.includes('主人'), '要说清谁能用');
  });
  check('parameters 三个属性都有 description，required 含 action', () => {
    const p = tools[0].parameters;
    for (const k of ['action', 'target', 'kind']) assert.ok(p.properties[k]?.description, `${k} 缺 description`);
    assert.deepEqual(p.required, ['action']);
    assert.deepEqual(p.properties.action.enum, ['list', 'add', 'remove']);
  });
  check('工具上没有 requires（不再依赖外部能力）', () => {
    assert.ok(!tools[0].requires || tools[0].requires.length === 0, JSON.stringify(tools[0].requires));
  });
  check('available() 在填了号码时返回 ok（且没碰 capability）', () => assert.equal(mod.available().ok, true));
}

// ── [3] 主人名单解析与闸门 ─────────────────────────────────────────────────
console.log('\n[3] 主人名单与闸门');
{
  const run = (ctx, args) => tool0(tools).execute(ctx, args);

  check('名单解析：中英文逗号/分号/顿号/空白都认，去重保序，非法项丢掉', () => {
    const got = mod.internals.normalizeOwnerIds(' 1062935770，2229576564、1062935770;abc 12345 1111111111111111 ');
    assert.deepEqual(got, ['1062935770', '2229576564', '12345'], JSON.stringify(got));
  });
  check('名单解析：数组入参也认，非数字整项丢弃', () => {
    assert.deepEqual(mod.internals.normalizeOwnerIds(['1062935770', 'abc', ' 2229576564 ']), ['1062935770', '2229576564']);
  });

  await acheck('未填主人 QQ 号 → 拒绝，并指路去设置里填', async () => {
    const fresh = makeApi({ ownerIds: '' });
    mod.setup(fresh.api);
    const r = await tool0(fresh.tools).execute(ctxPrivate('1062935770'), { action: 'list' });
    assert.equal(r.isError, true);
    assert.match(r.content, /还没填主人 QQ 号/);
    assert.equal(mod.available().ok, false);
    assert.match(mod.available().reason, /还没填主人 QQ 号/);
    mod.setup(api); // 还原
  });

  await acheck('非主人 → 拒绝，且不读不写配置、不回名单内容', async () => {
    const { ops, writes } = makeConfigStore({ allow: { groups: ['546789624'] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxGroup('999999999'), { action: 'list' });
    assert.equal(r.isError, true);
    assert.match(r.content, /只有主人能改/);
    assert.equal(writes.length, 0, '不该写配置');
    assert.ok(!r.content.includes('546789624'), '不该把名单内容回给非主人');
  });

  await acheck('正文里自称主人无效（号码才是唯一判据）', async () => {
    const { ops } = makeConfigStore();
    mod.internals.setConfigOps(ops);
    const r = await run(ctxGroup('999999999'), { action: 'add', target: '333333', kind: 'group' });
    assert.equal(r.isError, true);
    assert.match(r.content, /999999999/, '拒绝信息里要点出实际号码');
  });

  await acheck('拿不到发送者号码 → 拒绝', async () => {
    const r = await run({ chatKey: 'group:1', kind: 'group', chatId: '1', session: { trigger: [] }, store: { recent: () => [] } }, { action: 'list' });
    assert.equal(r.isError, true);
    assert.match(r.content, /拿不到/);
  });

  await acheck('多主人：名单里第二个号码也放行', async () => {
    const multi = makeApi({ ownerIds: '1062935770, 2229576564' });
    mod.setup(multi.api);
    const { ops } = makeConfigStore();
    mod.internals.setConfigOps(ops);
    const r = await tool0(multi.tools).execute(ctxPrivate('2229576564'), { action: 'list' });
    assert.notEqual(r.isError, true, r.content);
    mod.setup(api);
  });

  await acheck('主人（私聊）→ 放行并给出名单', async () => {
    const { ops } = makeConfigStore({ allow: { groups: ['546789624'], private: [] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'list' });
    assert.notEqual(r.isError, true);
    assert.match(r.content, /聊天白名单/);
    assert.match(r.content, /546789624/);
  });
}

// ── [4] 添加 ───────────────────────────────────────────────────────────────
console.log('\n[4] 添加');
{
  const run = (ctx, args) => tool0(tools).execute(ctx, args);

  await acheck('显式给群号 → 写进 allow.groups，且不动 deny / allowAllWhenEmpty', async () => {
    const { state, ops, writes } = makeConfigStore({ allow: { groups: ['111111'] }, deny: { groups: ['222222'] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'add', target: '333333', kind: 'group' });
    assert.notEqual(r.isError, true, r.content);
    assert.deepEqual(state.allow.groups, ['111111', '333333']);
    assert.deepEqual(state.deny.groups, ['222222'], '黑名单不能被碰');
    assert.equal(state.allowAllWhenEmpty, false);
    assert.deepEqual(Object.keys(writes[0]), ['allow'], '写 patch 只该带 allow');
    assert.deepEqual(Object.keys(writes[0].allow), ['groups'], '只该写被改的那个键');
  });

  await acheck('省略 target → 用当前群（本群群号 + kind=group）', async () => {
    const { state, ops } = makeConfigStore();
    mod.internals.setConfigOps(ops);
    const r = await run(ctxGroup('1062935770', '546789624'), { action: 'add' });
    assert.notEqual(r.isError, true, r.content);
    assert.deepEqual(state.allow.groups, ['546789624']);
  });

  await acheck('省略 target → 私聊写入 private 键（不是 privates）', async () => {
    const { state, ops } = makeConfigStore();
    mod.internals.setConfigOps(ops);
    await run(ctxPrivate('1062935770', '88888888'), { action: 'add' });
    assert.deepEqual(state.allow.private, ['88888888']);
    assert.deepEqual(state.allow.groups, []);
  });

  await acheck('重复添加 → 幂等，不写盘', async () => {
    const { ops, writes } = makeConfigStore({ allow: { groups: ['333333'] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'add', target: '333333', kind: 'group' });
    assert.match(r.content, /已经在/);
    assert.equal(writes.length, 0);
  });

  await acheck('号码不合法 → 拒绝，不写盘', async () => {
    const { ops, writes } = makeConfigStore();
    mod.internals.setConfigOps(ops);
    const r1 = await run(ctxPrivate('1062935770'), { action: 'add', target: 'abc', kind: 'group' });
    const r2 = await run(ctxPrivate('1062935770'), { action: 'add', target: '123', kind: 'group' });
    assert.equal(r1.isError, true);
    assert.equal(r2.isError, true);
    assert.equal(writes.length, 0);
  });

  await acheck('容忍 "群123456" / "QQ:123456" 这类写法', async () => {
    const { state, ops } = makeConfigStore();
    mod.internals.setConfigOps(ops);
    await run(ctxPrivate('1062935770'), { action: 'add', target: '群999000', kind: 'group' });
    assert.deepEqual(state.allow.groups, ['999000']);
  });

  await acheck('目标在黑名单里 → 有 ⚠️ 提醒（黑名单优先）', async () => {
    const { ops } = makeConfigStore({ deny: { groups: ['222222'] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'add', target: '222222', kind: 'group' });
    assert.match(r.content, /⚠️/);
    assert.match(r.content, /黑名单/);
  });

  await acheck('空名单 + 开着「留空放行」→ 提醒加完就变成只在白名单里回话', async () => {
    const { ops } = makeConfigStore({ allowAllWhenEmpty: true });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'add', target: '333333', kind: 'group' });
    assert.match(r.content, /留空时允许所有会话/);
  });

  await acheck('达到上限 200 条 → 拒绝', async () => {
    const many = Array.from({ length: 200 }, (_, i) => String(100000 + i));
    const { ops, writes } = makeConfigStore({ allow: { groups: many } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'add', target: '999999', kind: 'group' });
    assert.equal(r.isError, true);
    assert.match(r.content, /上限/);
    assert.equal(writes.length, 0);
  });

  await acheck('write 抛错 → 明确报错（不能假装成功）', async () => {
    mod.internals.setConfigOps({
      getConfig: () => ({ allow: { groups: [] }, deny: {}, allowAllWhenEmpty: false }),
      updateConfig: () => { throw new Error('磁盘只读'); },
    });
    const r = await run(ctxPrivate('1062935770'), { action: 'add', target: '333333', kind: 'group' });
    assert.equal(r.isError, true);
    assert.match(r.content, /写入配置失败/);
  });

  await acheck('kind 非法 → 拒绝', async () => {
    const { ops, writes } = makeConfigStore();
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'add', target: '333333', kind: 'friend' });
    assert.equal(r.isError, true);
    assert.equal(writes.length, 0);
  });
}

// ── [5] 移除 ───────────────────────────────────────────────────────────────
console.log('\n[5] 移除');
{
  const run = (ctx, args) => tool0(tools).execute(ctx, args);

  await acheck('移除已有条目 → 只删它', async () => {
    const { state, ops } = makeConfigStore({ allow: { groups: ['111111', '222222'] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'remove', target: '111111', kind: 'group' });
    assert.notEqual(r.isError, true, r.content);
    assert.deepEqual(state.allow.groups, ['222222']);
    assert.match(r.content, /移出聊天白名单/);
  });

  await acheck('移除不存在 → 幂等，不写盘', async () => {
    const { ops, writes } = makeConfigStore({ allow: { groups: ['111111'] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'remove', target: '999999', kind: 'group' });
    assert.match(r.content, /本来就不在/);
    assert.equal(writes.length, 0);
  });

  await acheck('移除当前会话 → 明确提醒「我在这里不再回话」', async () => {
    const { ops } = makeConfigStore({ allow: { groups: ['546789624', '777777'] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxGroup('1062935770', '546789624'), { action: 'remove', target: '546789624', kind: 'group' });
    assert.match(r.content, /不会再回话/);
  });

  await acheck('移除最后一条且未开留空放行 → 提醒会全静默', async () => {
    const { ops } = makeConfigStore({ allow: { groups: ['777777'] } });
    mod.internals.setConfigOps(ops);
    const r = await run(ctxPrivate('1062935770'), { action: 'remove', target: '777777', kind: 'group' });
    assert.match(r.content, /最后一条/);
    assert.match(r.content, /不在任何群/);
  });
}

// ── [6] 查看 ───────────────────────────────────────────────────────────────
console.log('\n[6] 查看');
{
  await acheck('list 报出两个名单 + 相关设置，并标出当前会话在不在名单里', async () => {
    const { ops } = makeConfigStore({ allow: { groups: ['546789624'], private: ['1062935770'] }, deny: { groups: ['222222'] }, allowAllWhenEmpty: false });
    mod.internals.setConfigOps(ops);
    const r = await tool0(tools).execute(ctxGroup('1062935770', '546789624'), { action: 'list' });
    assert.match(r.content, /群聊（1）/);
    assert.match(r.content, /私聊（1）/);
    assert.match(r.content, /黑名单：群 1/);
    assert.match(r.content, /留空时允许所有会话：关/);
    assert.match(r.content, /当前会话 group:546789624：在白名单里/);
  });

  await acheck('省略 action → 默认 list', async () => {
    const { ops } = makeConfigStore();
    mod.internals.setConfigOps(ops);
    const r = await tool0(tools).execute(ctxPrivate('1062935770'), {});
    assert.match(r.content, /聊天白名单/);
  });
}

// ── [7] 与核心的接线 ───────────────────────────────────────────────────────
console.log('\n[7] 核心配置接线');
{
  mod.internals.resetConfigOps();
  try {
    const ops = await mod.internals.loadCoreOps();
    check('能定位核心 src/config.js（真装在技能目录里时应通过）', () => {
      assert.ok(ops.from);
      assert.equal(typeof ops.getConfig, 'function');
      assert.equal(typeof ops.updateConfig, 'function');
      const snap = mod.internals.snapshot(ops.getConfig());
      assert.ok(Array.isArray(snap.allow.groups));
    });
    console.log(`       路径：${ops.from}`);

    // 本工具唯一的写路径是 updateConfig({ allow: { <key>: 新数组 } })，
    // 它能不能"只改这一条、别的不动"，取决于 deepMerge 对数组的语义 —— 在这里拿真代码验一次。
    check('deepMerge 对白名单数组是整体替换、且不碰没写到的字段', () => {
      if (!ops.deepMerge) throw new Error('核心没有导出 deepMerge，无法验证');
      const base = {
        allow: { groups: ['111111'], private: ['222222'] },
        deny: { groups: ['333333'], private: [] },
        allowAllWhenEmpty: true,
      };
      const out = ops.deepMerge(base, { allow: { groups: ['111111', '999999'] } });
      assert.deepEqual(out.allow.groups, ['111111', '999999'], '应当是整体替换（不是并集）');
      assert.deepEqual(out.allow.private, ['222222'], '没写到的键要保留');
      assert.deepEqual(out.deny, { groups: ['333333'], private: [] }, 'deny 不能被碰');
      assert.equal(out.allowAllWhenEmpty, true, '留空放行不能被碰');
    });
  } catch (error) {
    console.log(`  skip 未能定位核心 config.js（在工作区里跑就会这样）：${error?.message ?? error}`);
  }
}

console.log(`\n===== 通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
