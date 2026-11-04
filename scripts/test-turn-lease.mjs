// 回合判忙租约纯函数层：恢复宽限的语义锁。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RESTORED_TURN_GRACE_MS, TURN_BUSY_LEASE_MS, restoredTurnStartAt } from '../src/turn-lease.js';

test('restoredTurnStartAt：默认回拨到「租约只剩 45s」的位置', () => {
  const now = 1_700_000_000_000;
  const start = restoredTurnStartAt(now);
  assert.equal(start, now - (TURN_BUSY_LEASE_MS - RESTORED_TURN_GRACE_MS));
  assert.equal(now - start, 14 * 60 * 1000 + 15 * 1000, '15min − 45s = 14min15s');
});

test('恢复回合的忙窗口 = 宽限期：45s 内判忙，之后自动解除', () => {
  const now = 1_700_000_000_000;
  const start = restoredTurnStartAt(now);
  const isBusy = (t) => t - start < TURN_BUSY_LEASE_MS;
  assert.equal(isBusy(now), true, '刚恢复：判忙（给活回合的 end 留窗口）');
  assert.equal(isBusy(now + 44_000), true);
  assert.equal(isBusy(now + RESTORED_TURN_GRACE_MS), false, '宽限期一过立即解除，不拖满租约');
  // 对比旧语义（按 now 起算）会忙满 15 分钟 —— 锁定这次修正的差异
  const oldStart = now;
  assert.equal(now + RESTORED_TURN_GRACE_MS - oldStart < TURN_BUSY_LEASE_MS, true, '旧实现此时仍判忙（这正是要修的问题）');
});

test('restoredTurnStartAt：自定义租约/宽限与边界收敛', () => {
  const now = 5_000_000;
  assert.equal(restoredTurnStartAt(now, { leaseMs: 60_000, graceMs: 10_000 }), now - 50_000);
  assert.equal(restoredTurnStartAt(now, { leaseMs: 30_000, graceMs: 60_000 }), now, '宽限 > 租约时夹到 0（起点=now）');
  assert.equal(restoredTurnStartAt(now, { leaseMs: 0, graceMs: 0 }), now);
  assert.equal(restoredTurnStartAt(Number.NaN), NaN - 0, '非法 now 原样透传（调用方保证）');
});

test('bridge.js 已接线：恢复走 restoredTurnStartAt，不再按 now 直接起算', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /v2TurnStartAt\.set\(sessionId, restoredTurnStartAt\(Date\.now\(\)\)\)/);
  assert.doesNotMatch(src, /v2TurnStartAt\.set\(sessionId, Date\.now\(\)\)/, '旧写法必须消失');
  assert.match(src, /from '\.\/turn-lease\.js'/);
  const harness = fs.readFileSync(new URL('./audit-bridge-harness.mjs', import.meta.url), 'utf8');
  assert.match(harness, /turn-lease\.js/, 'VM 夹具必须注入 turn-lease 绑定');
});
