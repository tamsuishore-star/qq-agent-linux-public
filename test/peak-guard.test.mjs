import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHours, inPeakHours, internals, setup, providers } from '../plugins/peak-guard/index.js';

const base = {
  enabled: true,
  mode: 'strict',
  peakHours: '0-23',
  onlyGroups: true,
  groupPerMin: 1,
  globalPerMin: 10,
  maxOutputTokens: 300,
  exemptAt: true,
  exemptCommands: true
};

function reset(config = {}) {
  setup({ config: () => ({ ...base, autoPressure: true, ...config }), log: () => {} });
  internals.reset();
}

test('parseHours 支持多段与跨夜', () => {
  assert.deepEqual(parseHours('9-12,14-18'), [[9, 12], [14, 18]]);
  assert.deepEqual(parseHours('22-2'), [[22, 2]]);
  assert.deepEqual(parseHours('bad,25-30'), []);
});

test('inPeakHours 处理跨夜', () => {
  assert.equal(inPeakHours('22-2', 23), true);
  assert.equal(inPeakHours('22-2', 1), true);
  assert.equal(inPeakHours('22-2', 12), false);
  assert.equal(inPeakHours('9-12', 9), true);
  assert.equal(inPeakHours('9-12', 12), false);
});

test('strict 模式下每群预算生效', () => {
  reset();
  const ctx = { chatKey: 'group:1', isPrivate: false, atMe: false, isCommand: false };
  assert.equal(internals.gate(ctx).allow, true);
  const second = internals.gate(ctx);
  assert.equal(second.allow, false);
  assert.match(second.reason, /预算/);
});

test('@、命令、私聊默认豁免', () => {
  reset();
  assert.equal(internals.gate({ chatKey: 'group:1', isPrivate: false, atMe: true }).allow, true);
  assert.equal(internals.gate({ chatKey: 'group:1', isPrivate: false, atMe: false, isCommand: true }).allow, true);
  assert.equal(internals.gate({ chatKey: 'private:1', isPrivate: true, atMe: false }).allow, true);
});

test('request-params 在 strict 下限制输出 token', () => {
  reset();
  const out = providers['llm.request-params']({ body: { max_tokens: 2000 } });
  assert.equal(out.body.max_tokens, 300);
  const out2 = providers['llm.request-params']({ body: {} });
  assert.equal(out2.body.max_tokens, 300);
});

test('off 模式不拦截', () => {
  reset({ mode: 'off' });
  const ctx = { chatKey: 'group:9', isPrivate: false, atMe: false, isCommand: false };
  for (let i = 0; i < 5; i++) assert.equal(internals.gate(ctx).allow, true);
});

test('429 会自动升压并拦截（即使不在配置时段）', () => {
  reset({ mode: 'smart', peakHours: '0-0' });
  const ctx = { chatKey: 'group:8', isPrivate: false, atMe: false, isCommand: false };
  assert.equal(internals.gate(ctx).allow, true);
  providers['llm.request-feedback']({ ok: false, status: 429, latencyMs: 1000 });
  assert.equal(internals.gate(ctx).allow, true);   // 压力下仍先按预算放行一次
  assert.equal(internals.gate(ctx).allow, false);  // 预算用尽
});

test('连续慢请求会自动升压', () => {
  reset({ mode: 'smart', peakHours: '0-0', slowMs: 15000, windowSec: 300 });
  const ctx = { chatKey: 'group:7', isPrivate: false, atMe: false, isCommand: false };
  for (let i = 0; i < 3; i++) providers['llm.request-feedback']({ ok: true, status: 200, latencyMs: 20000 });
  assert.equal(internals.gate(ctx).allow, true);   // 第一次仍在预算内
  assert.equal(internals.gate(ctx).allow, false);  // 第二次超预算
});

test('正常延迟不会误触发', () => {
  reset({ mode: 'smart', peakHours: '0-0', slowMs: 15000 });
  const ctx = { chatKey: 'group:6', isPrivate: false, atMe: false, isCommand: false };
  for (let i = 0; i < 3; i++) providers['llm.request-feedback']({ ok: true, status: 200, latencyMs: 500 });
  assert.equal(internals.auto.until, 0);          // 正常延迟不升压
  assert.equal(internals.gate(ctx).allow, true);
});
