// token-routes 的直接路由回归：内存账本 stub，不读真实账本文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTokenRoutes } from '../src/http/token-routes.js';

function harness() {
  const sent = [];
  let resetCount = 0;
  const tokenLedger = {
    summary: ({ limit }) => ({ totals: { input: 1 }, turns: Array.from({ length: limit }, () => ({})) }),
    stats: () => ({ files: 2, records: 3 }),
    series: ({ hours, maxBuckets }) => ({ hours, buckets: maxBuckets }),
    conversation: (key) => (key === 'group:456' ? { key, turns: [] } : null),
    recent: (limit) => Array.from({ length: limit }, (_, i) => i),
    reset: () => { resetCount += 1; }
  };
  const deps = { tokenLedger, getPriceSymbol: () => 'CNY', log: () => {} };
  const call = async (method, pathname, headers = {}) => {
    const handled = await handleTokenRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, wasReset: () => resetCount > 0 };
}

test('agent token 一律 403（跨群花费是管理信息）', async () => {
  const h = harness();
  const result = await h.call('GET', '/api/tokens/summary', { 'x-agent-token': 't' });
  assert.equal(result.last.status, 403);
});

test('summary / series / turns / recent 的参数钳制与形状', async () => {
  const h = harness();
  const summary = await h.call('GET', '/api/tokens/summary?limit=99999');
  assert.equal(summary.last.obj.turns.length, 500, 'limit 钳到 500 上限');
  assert.deepEqual(summary.last.obj.ledger, { files: 2, records: 3 });

  const series = await h.call('GET', '/api/tokens/series?hours=99999&buckets=1');
  assert.deepEqual(series.last.obj, { hours: 2160, buckets: 6 }, 'hours 钳到 90 天、buckets 下限 6');

  const turns = await h.call('GET', '/api/tokens/turns?key=group:456');
  assert.equal(turns.last.obj.key, 'group:456');
  const missing = await h.call('GET', '/api/tokens/turns?key=group:999');
  assert.equal(missing.last.status, 404);

  const recent = await h.call('GET', '/api/tokens/recent?limit=3');
  assert.equal(recent.last.obj.symbol, 'CNY');
  assert.equal(recent.last.obj.entries.length, 3);
});

test('reset 需要 POST 且真的重置；未知子路径 404', async () => {
  const h = harness();
  assert.equal((await h.call('POST', '/api/tokens/reset')).last.obj.ok, true);
  assert.equal(h.wasReset(), true);
  assert.equal((await h.call('GET', '/api/tokens/unknown')).last.status, 404);
});

test('非 tokens 路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/status')).handled, false);
});
