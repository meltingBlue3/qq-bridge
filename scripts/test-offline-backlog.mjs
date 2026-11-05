import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineBacklog } from '../src/core/offline-backlog.js';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const item = (promptText) => ({ promptText });
function setup(overrides = {}) {
  const scheduled = [];
  const cancelled = new Set();
  const seen = [];
  const queue = createOfflineBacklog({
    isReady: () => true, isAllowed: () => true,
    deliver: async (key, message) => { seen.push([key, message.promptText]); return { ok: true }; },
    timers: { setTimeout: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
      clearTimeout: (timer) => cancelled.add(timer) },
    ...overrides,
  });
  return { queue, seen, scheduled, cancelled };
}

test('离线时不取出积压；恢复后同会话 FIFO', async () => {
  let ready = false;
  const h = setup({ isReady: () => ready });
  h.queue.enqueue('a', item('one'));
  h.queue.enqueue('a', item('two'));
  await h.queue.flush();
  assert.equal(h.queue.pending.get('a').length, 2);
  ready = true;
  await h.queue.flush();
  assert.deepEqual(h.seen, [['a', 'one'], ['a', 'two']]);
  assert.equal(h.queue.pending.size, 0);
});

test('逐会话并行；一个会话的慢补投不挡其他会话', async () => {
  const barrier = deferred();
  const other = deferred();
  const seen = [];
  const h = setup({ deliver: async (key, message) => {
    seen.push([key, message.promptText]);
    if (key === 'a') await barrier.promise;
    else other.resolve();
    return { ok: true };
  } });
  h.queue.enqueue('a', item('slow'));
  h.queue.enqueue('b', item('independent'));
  const flushing = h.queue.flush();
  await other.promise;
  assert.deepEqual(seen, [['a', 'slow'], ['b', 'independent']]);
  barrier.resolve();
  await flushing;
});

test('失败项回到队首，退避后先于后来消息重试', async () => {
  let failing = true;
  const h = setup({ deliver: async () => { if (failing) throw new Error('network'); return { ok: true }; } });
  h.queue.enqueue('a', item('old'));
  await h.queue.flush();
  assert.equal(h.scheduled[0].delay, 3000);
  h.queue.enqueue('a', item('new'));
  assert.deepEqual(h.queue.pending.get('a').map((message) => message.promptText), ['old', 'new']);
  failing = false;
  await h.queue.flush();
  assert.equal(h.queue.pending.size, 0);
});

test('撤权或重置期间在途失败不能把旧消息重新塞回队列', async () => {
  const barrier = deferred();
  const h = setup({ deliver: async () => { await barrier.promise; throw new Error('old failure'); } });
  h.queue.enqueue('a', item('old'));
  const flushing = h.queue.flush();
  await Promise.resolve();
  h.queue.discard('a');
  barrier.resolve();
  await flushing;
  assert.equal(h.queue.pending.size, 0);
  assert.equal(h.scheduled.length, 0);
});

test('反复调用 flush 单飞且不会把失败退避缩短成尾沿重试', async () => {
  const barrier = deferred();
  let calls = 0;
  const h = setup({ deliver: async () => { calls++; await barrier.promise; return { ok: false, error: 'failure' }; } });
  h.queue.enqueue('a', item('one'));
  const first = h.queue.flush();
  await Promise.resolve();
  const second = h.queue.flush();
  barrier.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(h.scheduled.map((timer) => timer.delay), [3000]);
});

test('普通重复文本保留，显式重试可去重；容量上限覆盖重试合并', async () => {
  const h = setup({ maxPerKey: 2 });
  h.queue.enqueue('a', item('same'));
  h.queue.enqueue('a', item('same'));
  h.queue.enqueue('a', item('same'), { dedupe: true });
  assert.equal(h.queue.pending.get('a').length, 2);
  h.queue.enqueue('a', item('new'));
  assert.deepEqual(h.queue.pending.get('a').map((message) => message.promptText), ['same', 'new']);
});

test('dispatch 返回 queued 时保留当前项，暂停/禁用唤醒可跳过', async () => {
  let ready = true;
  const h = setup({ isReady: () => ready, deliver: async () => { ready = false; return { ok: true, queued: true }; } });
  h.queue.enqueue('a', item('one'));
  await h.queue.flush();
  assert.equal(h.queue.pending.get('a')[0].promptText, 'one');
});

test('持续失败按退避阶梯重试；取消清掉重试定时器', async () => {
  const h = setup({ deliver: async () => ({ ok: false, error: 'offline' }) });
  h.queue.enqueue('a', item('one'));
  for (const delay of [3000, 6000, 12000, 24000, 48000, 60000]) {
    await h.queue.flush();
    assert.equal(h.scheduled.at(-1).delay, delay);
  }
  const timer = h.scheduled.at(-1);
  h.queue.discard('a');
  assert.ok(h.cancelled.has(timer));
  assert.equal(h.queue.pending.size, 0);
});

test('在途失败回队也受容量限制，不无限拼接积压', async () => {
  const barrier = deferred();
  const h = setup({ maxPerKey: 2, deliver: async () => { await barrier.promise; return { ok: false }; } });
  h.queue.enqueue('a', item('old'));
  const flushing = h.queue.flush();
  await Promise.resolve();
  h.queue.enqueue('a', item('new1'));
  h.queue.enqueue('a', item('new2'));
  barrier.resolve();
  await flushing;
  assert.deepEqual(h.queue.pending.get('a').map((message) => message.promptText), ['new1', 'new2']);
});

test('旧补投返回时不得清理重置后正在补投的新一代', async () => {
  const old = deferred();
  const fresh = deferred();
  const h = setup({ deliver: async (_key, message) => {
    await (message.promptText === 'old' ? old.promise : fresh.promise);
    return { ok: true };
  } });
  h.queue.enqueue('a', item('old'));
  const first = h.queue.flush();
  await Promise.resolve();
  h.queue.discard('a');
  h.queue.enqueue('a', item('new'));
  const second = h.queue.flush();
  await Promise.resolve();
  old.resolve();
  await first;
  fresh.resolve();
  await second;
  assert.equal(h.queue.pending.size, 0);
  assert.equal(h.scheduled.length, 0);
});
