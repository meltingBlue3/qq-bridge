import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplySender } from '../src/core/reply-sender.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const calls = [], delays = [];
  const hooks = { allowed: true, text: async () => {}, message: async () => {} };
  const sender = createReplySender({
    captureSendGuard: () => () => { if (!hooks.allowed) throw new Error('revoked'); },
    redactKnownTokensOnly: (v) => String(v).replaceAll('secret', '[redacted]'),
    splitForQQ: (v) => v.split('|'),
    sendTextPart: async (key, text) => { await hooks.text(key, text); calls.push([key, text]); },
    sendMessagePart: async (...args) => { await hooks.message(...args); calls.push(args); },
    sleep: async (ms) => { delays.push(ms); }, getSendDelay: () => 5, randInt: (min) => min,
  });
  return { ...sender, calls, delays, hooks };
}

test('text redacts before splitting, preserves order and cleans its tail', async () => {
  const h = fixture();
  await h.sendToQQ('a', 'secret|second');
  assert.deepEqual(h.calls, [['a', '[redacted]'], ['a', 'second']]);
  assert.deepEqual(h.delays, [5, 5]);
  await Promise.resolve();
  assert.equal(h.entries.size, 0);
});

test('text, media jobs and bursts share FIFO while another conversation progresses', async () => {
  const h = fixture();
  const entered = deferred(), release = deferred();
  const media = h.enqueue('a', async () => { entered.resolve(); await release.promise; h.calls.push(['a', 'voice']); });
  await entered.promise;
  const text = h.sendToQQ('a', 'text');
  const burst = h.sendBurstToQQ('a', ['one', 'two'], 10, 20);
  await h.sendToQQ('b', 'independent');
  assert.deepEqual(h.calls, [['b', 'independent']]);
  release.resolve(); await Promise.all([media, text, burst]);
  assert.deepEqual(h.calls.slice(1), [['a', 'voice'], ['a', 'text'], ['a', 'one'], ['a', 'two']]);
  assert.deepEqual(h.delays, [5, 5, 10]);
});

test('a rejected media job does not poison the next batch', async () => {
  const h = fixture();
  const media = h.enqueue('a', async () => { throw new Error('transport'); });
  const text = h.sendToQQ('a', 'next');
  await assert.rejects(media, /transport/); await text;
  assert.deepEqual(h.calls, [['a', 'next']]);
});

test('partial v2 failure reports exactly successful parts and leaves queue usable', async () => {
  const h = fixture();
  h.hooks.message = async (key, msg) => { if (msg === 'bad') throw new Error('transport'); };
  await assert.rejects(h.sendMessagesV2('a', ['first', 'bad', 'last'], [10, 20], '-1', '123'), (error) => {
    assert.deepEqual(error.sent, ['first', 'last']);
    assert.match(error.message, /1\/3/); return true;
  });
  assert.deepEqual(h.calls, [['a', 'first', '-1', '123'], ['a', 'last', null, null]]);
  assert.deepEqual(h.delays, [10, 20]);
  assert.equal(h.lastSendSucceeded('a'), false);
  await h.sendToQQ('a', 'next');
  assert.equal(h.lastSendSucceeded('a'), true);
});

test('revocation while waiting prevents all parts from reaching the transport', async () => {
  const h = fixture();
  const release = deferred();
  const media = h.enqueue('a', () => release.promise);
  const result = h.sendMessagesV2('a', ['one', 'two'], [], null);
  const rejected = assert.rejects(result, (error) => { assert.deepEqual(error.sent, []); return true; });
  h.hooks.allowed = false; release.resolve();
  await media; await rejected;
  assert.deepEqual(h.calls, []);
});

test('burst failure only counts successful parts and records failure', async () => {
  const h = fixture();
  h.hooks.text = async (key, msg) => { if (msg === 'bad') throw new Error('transport'); };
  assert.deepEqual(await h.sendBurstToQQ('a', ['secret', 'bad', 'last'], 0, 0), ['[redacted]', 'last']);
  assert.equal(h.lastSendSucceeded('a'), false);
});
