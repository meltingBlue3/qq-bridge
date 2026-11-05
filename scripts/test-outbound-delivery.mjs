import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOutboundDelivery, DeliveryNotSentError } from '../src/core/outbound-delivery.js';

const key = 'group:8';
const sid = 'session-1';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-outbound-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'outbound.json');
  const calls = [];
  const hooks = {
    context: (entry) => ({ known: true, allowed: true, online: true, policy: entry.policy, mode: 'chat', sessionId: entry.sessionId }),
    send: async () => ({ messageId: -calls.length }),
  };
  const open = () => createOutboundDelivery({ file, now: () => 1000, ...options,
    getContext: (entry) => hooks.context(entry),
    sendPart: async (part) => { calls.push(part); return hooks.send(part); },
  });
  const delivery = open();
  const record = (overrides = {}, store = delivery) => store.record({
    key, sessionId: sid, turn: 1, seq: 10, policy: 'policy-a', mode: 'chat', allowAuto: true,
    parts: ['reply'], ...overrides,
  }).id;
  return { file, calls, hooks, open, delivery, record };
}
const entry = (store, id) => store.snapshot().entries[id];
const statuses = (store, id) => entry(store, id).parts.map((part) => part.status);

test('offline completed output survives restart and commits send intent before each transport call', async (t) => {
  const h = fixture(t);
  const context = h.hooks.context;
  h.hooks.context = (job) => ({ ...context(job), online: false });
  const id = h.record({ parts: ['one', 'two'] });
  await h.delivery.flush();
  assert.equal(h.calls.length, 0);
  const restarted = h.open();
  assert.deepEqual(statuses(restarted, id), ['pending', 'pending']);
  h.hooks.context = context;
  h.hooks.send = async (part) => {
    const saved = JSON.parse(fs.readFileSync(h.file, 'utf8')).entries[id];
    assert.equal(saved.parts[part.partIndex].status, 'sending');
    assert.equal(saved.parts[part.partIndex].attemptId, part.attemptId);
    assert.equal(saved.cursor, part.partIndex);
    return { messageId: -part.partIndex - 1 };
  };
  await restarted.flush();
  assert.deepEqual(h.calls.map((part) => part.text), ['one', 'two']);
  assert.deepEqual(statuses(h.open(), id), ['delivered', 'delivered']);
  assert.equal(entry(restarted, id).cursor, 2);
  assert.deepEqual(entry(restarted, id).parts.map((part) => part.messageId), ['-1', '-2']);
  assert.equal(restarted.snapshot().sessions[sid].lastSettledCompletionSeq, 10);
});

test('duplicate live/snapshot completions never requeue a delivered turn', async (t) => {
  const h = fixture(t);
  const id = h.record(); await h.delivery.flush();
  const restarted = h.open();
  const duplicate = restarted.record({ key, sessionId: sid, turn: '1', seq: 10, policy: 'policy-a', mode: 'chat', allowAuto: true, parts: ['replay'] });
  assert.deepEqual(duplicate, { id, duplicate: true });
  await restarted.flush();
  assert.equal(h.calls.length, 1);
});

test('a scalar sequence maximum cannot discard an unseen older completion', async (t) => {
  const h = fixture(t);
  h.record({ turn: 2, seq: 20, parts: ['newer'] }); await h.delivery.flush();
  h.record({ turn: 1, seq: 10, parts: ['older recovered'] }); await h.delivery.flush();
  assert.deepEqual(h.calls.map((part) => part.text), ['newer', 'older recovered']);
  assert.equal(h.delivery.snapshot().sessions[sid].lastObservedSeq, 20);
});

test('unknown mode holds all output, then releases only a confirmed eligible conversation', async (t) => {
  const h = fixture(t);
  const context = h.hooks.context;
  h.hooks.context = (job) => ({ ...context(job), known: false });
  const id = h.record({ mode: null });
  await h.delivery.flush();
  assert.deepEqual(statuses(h.delivery, id), ['held']);
  assert.equal(h.calls.length, 0);
  h.hooks.context = context;
  await h.open().flush();
  assert.equal(h.calls.length, 1);
});

test('simulation text never becomes a sendable part, even across mode confirmation and restart', async (t) => {
  const h = fixture(t);
  const direct = h.record({ mode: 'reserved2', parts: ['direct internal text'] });
  const held = h.record({ turn: 2, seq: 12, mode: null, parts: ['held internal text'] });
  const base = h.hooks.context;
  h.hooks.context = (job) => ({ ...base(job), mode: 'reserved2' });
  await h.delivery.flush();
  assert.equal(entry(h.delivery, direct).suppressed, true);
  assert.equal(entry(h.delivery, held).suppressed, true);
  assert.ok(!fs.readFileSync(h.file, 'utf8').includes('internal text'));
  h.hooks.context = base;
  await h.open().flush();
  assert.equal(h.calls.length, 0);
});

test('silent, tool-delivered and unknown-intent results are suppressed without persisting their text', async (t) => {
  const h = fixture(t);
  for (const [i, reason] of ['silent-input', 'tool-delivered', 'missing-intent'].entries()) {
    const id = h.record({ turn: i, seq: i, allowAuto: false, reason, parts: [`internal-${i}`] });
    assert.equal(entry(h.delivery, id).reason, reason);
    assert.deepEqual(entry(h.delivery, id).parts, []);
  }
  await h.delivery.flush();
  assert.equal(h.calls.length, 0);
  assert.ok(!fs.readFileSync(h.file, 'utf8').includes('internal-0'));
});

test('timeout preserves acknowledged prefix, blocks later sends and never retries automatically', async (t) => {
  const h = fixture(t);
  h.hooks.send = async (part) => { if (part.text === 'uncertain') throw new Error('timeout after submission'); return { messageId: -h.calls.length }; };
  const id = h.record({ parts: ['acknowledged', 'uncertain', 'later part'] });
  h.record({ turn: 2, seq: 12, parts: ['later turn'] });
  await h.delivery.flush(); await h.delivery.flush();
  const restarted = h.open(); await restarted.flush();
  assert.deepEqual(h.calls.map((part) => part.text), ['acknowledged', 'uncertain']);
  assert.deepEqual(statuses(restarted, id), ['delivered', 'uncertain', 'pending']);
  assert.equal(entry(restarted, id).cursor, 1);
  restarted.resolveUncertain({ id, partIndex: 1, action: 'acknowledge', actor: 'console', reason: 'confirmed in QQ history',
    verifiedMessageId: '-99', expectedRevision: restarted.snapshot().revision });
  await restarted.flush();
  assert.deepEqual(h.calls.map((part) => part.text), ['acknowledged', 'uncertain', 'later part', 'later turn']);
  assert.equal(entry(h.open(), id).parts[1].messageId, '-99');
  assert.equal(restarted.snapshot().resolutions.at(-1).actor, 'console');
});

test('process loss with a durable send in flight becomes uncertain on reopen', async (t) => {
  const h = fixture(t);
  const entered = deferred(), release = deferred();
  h.hooks.send = async () => { entered.resolve(); await release.promise; return { messageId: '-22' }; };
  const id = h.record(); const active = h.delivery.flush();
  await entered.promise;
  try {
    const restarted = h.open();
    assert.deepEqual(statuses(restarted, id), ['uncertain']);
    assert.equal(entry(restarted, id).parts[0].reason, 'process-restarted-during-send');
    await restarted.flush();
    assert.equal(h.calls.length, 1);
  } finally { release.resolve(); await active; }
  assert.deepEqual(statuses(h.open(), id), ['uncertain'], 'a stale writer must not overwrite the new journal');
});

test('proven preflight failure remains pending and is safe to retry', async (t) => {
  const h = fixture(t);
  h.hooks.send = async () => { throw new DeliveryNotSentError('no request invoked'); };
  const id = h.record(); await h.delivery.flush();
  assert.deepEqual(statuses(h.delivery, id), ['pending']);
  h.hooks.send = async () => ({ messageId: '-3' });
  await h.delivery.flush();
  assert.deepEqual(statuses(h.delivery, id), ['delivered']);
  assert.equal(entry(h.delivery, id).parts[0].attempts, 2);
});

test('invalid or missing acknowledgement is uncertain, not delivered', async (t) => {
  const h = fixture(t);
  h.hooks.send = async () => ({ ok: true, messageId: 0 });
  const id = h.record(); await h.delivery.flush(); await h.delivery.flush();
  assert.deepEqual(statuses(h.delivery, id), ['uncertain']);
  assert.equal(h.calls.length, 1);
});

test('an uncertain retry requires explicit resolution, current revision and current policy', async (t) => {
  const h = fixture(t);
  const base = h.hooks.context;
  h.hooks.send = async () => { throw new Error('uncertain'); };
  const id = h.record(); await h.delivery.flush();
  const resolution = { id, partIndex: 0, action: 'retry', actor: 'console', reason: 'checked target history', expectedRevision: h.delivery.snapshot().revision };
  assert.throws(() => h.delivery.resolveUncertain({ ...resolution, expectedRevision: 0 }), /current revision/);
  h.hooks.context = (job) => ({ ...base(job), policy: 'other' });
  assert.throws(() => h.delivery.resolveUncertain(resolution), /revoked/);
  h.hooks.context = base;
  h.delivery.resolveUncertain(resolution);
  h.hooks.send = async () => ({ messageId: '-42' });
  await h.delivery.flush();
  assert.deepEqual(statuses(h.delivery, id), ['delivered']);
  assert.equal(h.calls.length, 2);
});

test('revocation while a transport adapter is queued blocks the actual network send', async (t) => {
  const h = fixture(t);
  const entered = deferred(), release = deferred(); let network = 0;
  h.hooks.send = async (part) => { entered.resolve(); await release.promise; part.assertCurrent(); network++; return { messageId: '-7' }; };
  const id = h.record(); const task = h.delivery.flush();
  await entered.promise;
  h.delivery.cancelKey(key);
  release.resolve(); await task;
  assert.equal(network, 0);
  assert.deepEqual(statuses(h.delivery, id), ['discarded']);
});

test('stale binding is cancelled without discarding the new session under the same key and policy', async (t) => {
  const h = fixture(t);
  const old = h.record({ parts: ['old session'] });
  const replacement = h.record({ sessionId: 'session-2', parts: ['replacement'] });
  const base = h.hooks.context;
  h.hooks.context = (job) => ({ ...base(job), sessionId: 'session-2' });
  await h.delivery.flush();
  assert.deepEqual(h.calls.map((part) => part.text), ['replacement']);
  assert.deepEqual(statuses(h.delivery, old), ['discarded']);
  assert.deepEqual(statuses(h.delivery, replacement), ['delivered']);
});

test('same-conversation FIFO and single-flight while a different conversation delivers independently', async (t) => {
  const h = fixture(t);
  const entered = deferred(), release = deferred(), other = deferred();
  h.hooks.send = async (part) => {
    if (part.text === 'first') { entered.resolve(); await release.promise; }
    if (part.text === 'other') other.resolve();
    return { messageId: '-1' };
  };
  h.record({ parts: ['first', 'second'] });
  h.record({ turn: 2, seq: 12, parts: ['third'] });
  h.record({ key: 'private:9', sessionId: 'other', parts: ['other'] });
  const initial = h.delivery.flush(); await entered.promise;
  const repeated = h.delivery.flush(); await other.promise;
  assert.deepEqual(h.calls.map((part) => part.text), ['first', 'other']);
  release.resolve(); await Promise.all([initial, repeated]);
  assert.deepEqual(h.calls.map((part) => part.text), ['first', 'other', 'second', 'third']);
});

test('failed journal write before send invokes no transport and can be retried', async (t) => {
  const h = fixture(t); const id = h.record();
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === h.file) throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
    return rename(source, target);
  };
  try { await h.delivery.flush(); assert.equal(h.calls.length, 0); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(statuses(h.delivery, id), ['pending']);
  await h.delivery.flush(); assert.equal(h.calls.length, 1);
});

test('receipt persistence failure leaves durable intent and cannot cause a resend', async (t) => {
  const h = fixture(t); const id = h.record();
  const rename = fs.renameSync;
  h.hooks.send = async () => {
    fs.renameSync = (source, target) => {
      if (target === h.file) throw Object.assign(new Error('injected receipt failure'), { code: 'EIO' });
      return rename(source, target);
    };
    return { messageId: '-55' };
  };
  try { await h.delivery.flush(); } finally { fs.renameSync = rename; }
  assert.deepEqual(statuses(h.delivery, id), ['sending']);
  const restarted = h.open(); await restarted.flush();
  assert.deepEqual(statuses(restarted, id), ['uncertain']);
  assert.equal(h.calls.length, 1);
});

test('corruption and external writes cannot be replaced or cause transport calls', async (t) => {
  const h = fixture(t); const id = h.record();
  const original = fs.readFileSync(h.file, 'utf8');
  fs.writeFileSync(h.file, original + ' ');
  await h.delivery.flush();
  assert.equal(h.delivery.writable, false);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(statuses(h.delivery, id), ['pending']);
  fs.writeFileSync(h.file, '{broken');
  const broken = h.open();
  assert.equal(broken.writable, false);
  assert.throws(() => h.record({}, broken));
  await broken.flush(); assert.equal(fs.readFileSync(h.file, 'utf8'), '{broken');
  assert.equal(h.calls.length, 0);
});

test('capacity protects existing receipts and malformed identifiers never become journal keys', (t) => {
  const h = fixture(t, { maxEntries: 1 });
  assert.throws(() => h.record({ key: null }), /Invalid/);
  assert.throws(() => h.record({ sessionId: '__proto__' }), /Invalid/);
  assert.throws(() => h.record({ turn: {} }), /Invalid/);
  const id = h.record();
  assert.throws(() => h.record({ turn: 2, seq: 20 }), /capacity/);
  assert.deepEqual(Object.keys(h.open().snapshot().entries), [id]);
});

test('a lost input acknowledgement remains distinct from unsent output and can be linked by log evidence', async (t) => {
  const h = fixture(t);
  const requestId = h.delivery.beginInput({ key, sessionId: sid, policy: 'policy-a', mode: 'chat', requestId: 'request-1' });
  assert.equal(h.delivery.snapshot().inputs[requestId].status, 'submitting');
  const restarted = h.open();
  assert.equal(restarted.snapshot().inputs[requestId].status, 'uncertain');
  assert.deepEqual(restarted.snapshot().entries, {});
  await restarted.flush(); assert.equal(h.calls.length, 0);
  const intent = restarted.matchInputs(sid, [requestId], 1);
  assert.equal(intent.allowAuto, true);
  const id = h.record({ inputIds: intent.inputIds }, restarted);
  assert.equal(restarted.snapshot().inputs[requestId].status, 'completed');
  assert.equal(restarted.snapshot().inputs[requestId].completedBy, id);
  restarted.finishInput(requestId, 'uncertain');
  assert.equal(restarted.snapshot().inputs[requestId].status, 'completed');
  assert.equal(restarted.matchInputs(sid, [requestId], 2), null);
  await restarted.flush(); assert.equal(h.calls.length, 1);
});

test('recovery requires all input IDs and matching session, mode and policy', (t) => {
  const h = fixture(t);
  const begin = (requestId, overrides = {}) => h.delivery.beginInput({ key, sessionId: sid,
    policy: 'policy-a', mode: 'chat', requestId, ...overrides });
  begin('normal'); begin('other-policy', { policy: 'policy-b' }); begin('other-session', { sessionId: 'session-2' });
  for (const requestIds of [[], ['unknown'], ['normal', 'unknown'], ['normal', 'other-policy'], ['normal', 'other-session']]) {
    assert.equal(h.delivery.matchInputs(sid, requestIds, 1), null);
  }
  assert.throws(() => h.record({ inputIds: ['normal'], mode: 'closed-agent' }), /does not match/);
  assert.throws(() => h.record({ inputIds: ['normal'], policy: 'policy-b' }), /does not match/);
});

test('silent and simulation input provenance refuses automatic output', async (t) => {
  const h = fixture(t);
  const begin = (requestId, overrides = {}) => h.delivery.beginInput({ key, sessionId: sid,
    policy: 'policy-a', mode: 'chat', requestId, ...overrides });
  begin('normal'); begin('silent', { silent: true });
  assert.equal(h.delivery.matchInputs(sid, ['normal', 'silent'], 1).allowAuto, false);
  assert.throws(() => h.record({ inputIds: ['normal', 'silent'] }), /does not match/);
  h.record({ allowAuto: false, inputIds: ['normal', 'silent'], parts: ['do not persist silent text'] });
  begin('simulation', { mode: 'reserved2' });
  assert.equal(h.delivery.matchInputs(sid, ['simulation'], 2).allowAuto, false);
  h.record({ turn: 2, seq: 12, mode: 'reserved2', allowAuto: false, inputIds: ['simulation'], parts: ['do not persist simulation text'] });
  await h.delivery.flush(); assert.equal(h.calls.length, 0);
  assert.ok(!fs.readFileSync(h.file, 'utf8').includes('do not persist'));
});

test('rejected and command inputs cannot authorize snapshot replies', (t) => {
  const h = fixture(t);
  for (const status of ['rejected', 'command']) {
    const id = h.delivery.beginInput({ key, sessionId: sid, policy: 'policy-a', mode: 'chat' });
    h.delivery.finishInput(id, status);
    assert.equal(h.open().matchInputs(sid, [id], 1), null);
  }
});
