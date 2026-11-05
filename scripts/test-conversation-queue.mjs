import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationQueue } from '../src/core/conversation-queue.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('同会话严格 FIFO，跨会话并行，全部完成后释放条目', async () => {
  const queue = createConversationQueue();
  const barrier = deferred();
  const events = [];
  const a = queue.enqueue('group:1', async () => { events.push('a-start'); await barrier.promise; events.push('a-end'); });
  const b = queue.enqueue('group:1', () => events.push('b'));
  await queue.enqueue('group:2', () => events.push('other'));
  assert.deepEqual(events, ['a-start', 'other']);
  barrier.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(events, ['a-start', 'other', 'a-end', 'b']);
  assert.equal(queue.entries.size, 0);
});

test('同步异常和异步拒绝只影响当前任务，后续仍可执行', async () => {
  const queue = createConversationQueue();
  const a = queue.enqueue('key', () => { throw new Error('sync'); });
  const b = queue.enqueue('key', () => Promise.reject(new Error('async')));
  const c = queue.enqueue('key', () => 42);
  await assert.rejects(a, /sync/);
  await assert.rejects(b, /async/);
  assert.equal(await c, 42);
  assert.equal(queue.entries.size, 0);
});

test('取消只拒绝待处理任务，旧完成不能清掉或驱动新一代队列', async () => {
  const queue = createConversationQueue();
  const old = deferred();
  const fresh = deferred();
  const a = queue.enqueue('key', () => old.promise);
  const waiting = queue.enqueue('key', () => assert.fail('cancelled task ran'));
  const rejected = assert.rejects(waiting, /reset/);
  queue.cancel('key', 'reset');
  const b = queue.enqueue('key', () => fresh.promise);
  old.resolve('old');
  assert.equal(await a, 'old');
  assert.equal(queue.isBusy('key'), true);
  fresh.resolve('new');
  assert.equal(await b, 'new');
  await rejected;
  assert.equal(queue.entries.size, 0);
});

test('取消全部会话后可以重新接收任务', async () => {
  const queue = createConversationQueue();
  const barrier = deferred();
  const running = queue.enqueue('one', () => barrier.promise);
  const waiting = queue.enqueue('one', () => 1);
  const rejected = assert.rejects(waiting, /shutdown/);
  queue.cancelAll('shutdown');
  assert.equal(queue.entries.size, 0);
  assert.equal(await queue.enqueue('two', () => 2), 2);
  barrier.resolve();
  await Promise.all([running, rejected]);
});
