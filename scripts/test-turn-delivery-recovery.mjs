import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOutboundDelivery } from '../src/core/outbound-delivery.js';
import { createTurnDeliveryRecovery } from '../src/core/turn-delivery-recovery.js';

const key = 'private:42', sessionId = 'owner-session', policy = 'owner-policy';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-turn-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'outbound.json'), calls = [];
  const state = { known: false, online: true, mapped: true, mode: 'closed-agent', policy };
  const open = () => {
    const delivery = createOutboundDelivery({ file,
      getContext: () => ({ ...state, sessionId, allowed: state.mapped }),
      sendPart: async (part) => { calls.push(part.text); return { messageId: -calls.length }; },
    });
    const recovery = createTurnDeliveryRecovery({ delivery, isMapped: () => state.mapped,
      prepareReply: (text) => text.includes('BLOCK-ME') ? { parts: [], reason: 'content-audit-blocked' } : { parts: text.split('|') },
    });
    return { delivery, recovery };
  };
  return { file, state, calls, open, ...open() };
}
function records(requestId, { seq = 10, turn = 1, text = 'reply', tool, kind = 'completed' } = {}) {
  return [
    { seq, type: 'turn/start', data: { turn } },
    { seq: seq + 1, type: 'user/message', data: { id: 'distinct-message-id', source: { kind: 'user', rpcId: requestId } } },
    ...(tool ? [{ seq: ++seq + 1, type: 'tool/call', data: { turn, name: tool } }] : []),
    { seq: seq + 2, type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
    { seq: seq + 3, type: 'turn/end', data: { turn, reason: { kind } } },
  ].map((event) => ({ type: 'event', event }));
}
const input = (h, overrides = {}) => h.delivery.beginInput({ key, sessionId, policy, mode: 'closed-agent', ...overrides });

test('reconnect recovers a completed reply from log evidence, persists it, and deduplicates after restart', async (t) => {
  const h = fixture(t);
  const requestId = input(h);
  h.delivery.finishInput(requestId, 'accepted');
  // No live turn events were delivered while the bridge was disconnected.
  const recovered = h.open();
  const snapshot = { hasMore: false, records: records(requestId, { text: 'first|second' }) };
  assert.equal(recovered.recovery.ingestSnapshot(sessionId, snapshot).turns[0].status, 'recorded');
  await recovered.delivery.flush(); assert.deepEqual(h.calls, []); // actual mode unknown
  const restarted = h.open();
  assert.equal(restarted.recovery.ingestSnapshot(sessionId, snapshot).turns[0].status, 'duplicate');
  h.state.known = true;
  await restarted.delivery.flush(); await restarted.delivery.flush();
  assert.deepEqual(h.calls, ['first', 'second']);
});

test('old untracked history is ignored even when its text looks like a normal reply', async (t) => {
  const h = fixture(t); h.state.known = true;
  const result = h.recovery.ingestSnapshot(sessionId, { records: records('pre-upgrade') });
  assert.equal(result.turns[0].status, 'untracked');
  await h.delivery.flush(); assert.deepEqual(h.calls, []);
  assert.deepEqual(h.delivery.snapshot().entries, {});
});

test('clipped history waits for older pages before later turns can be recorded', (t) => {
  const h = fixture(t);
  const id = input(h);
  const clipped = h.recovery.ingestSnapshot(sessionId, { hasMore: true, cursor: 17, records: records(id) });
  assert.deepEqual(clipped, { status: 'needs-history', cursor: 17, turns: [] });
  assert.deepEqual(h.delivery.snapshot().entries, {});
  assert.equal(h.recovery.ingestSnapshot(sessionId, { hasMore: false, records: records(id) }).turns[0].status, 'recorded');
});

test('recovered open turn completes on its live tail and replay does not double send', async (t) => {
  const h = fixture(t); h.state.known = true;
  const id = input(h); const history = records(id);
  h.recovery.ingestSnapshot(sessionId, { records: history.slice(0, -1) });
  assert.equal(h.recovery.ingestEvent(sessionId, history.at(-1).event).status, 'recorded');
  assert.equal(h.recovery.ingestEvent(sessionId, history.at(-1).event), null);
  assert.equal(h.recovery.ingestSnapshot(sessionId, { records: history }).turns[0].status, 'duplicate');
  await h.delivery.flush(); assert.deepEqual(h.calls, ['reply']);
});

test('simulation, silent, tool-attempted and audited content never becomes a replay payload', async (t) => {
  const h = fixture(t); h.state.known = true;
  const cases = [
    [{ mode: 'reserved2' }, { text: 'private internal text' }],
    [{ silent: true }, { text: 'silent summary' }],
    [{}, { text: 'tool fallback', tool: 'mcp__snowluma__qq_reply' }],
    [{}, { text: 'BLOCK-ME' }],
  ];
  for (const [i, [intent, output]] of cases.entries()) {
    const id = input(h, intent);
    assert.equal(h.recovery.ingestSnapshot(sessionId, { records: records(id, { ...output, turn: i + 1, seq: 10 + i * 10 }) }).turns[0].status, 'suppressed');
  }
  await h.delivery.flush(); assert.deepEqual(h.calls, []);
  const raw = fs.readFileSync(h.file, 'utf8');
  for (const value of ['private internal text', 'silent summary', 'tool fallback', 'BLOCK-ME']) assert.ok(!raw.includes(value));
});

test('a revoked mapping or changed policy cannot deliver recovered text', async (t) => {
  const h = fixture(t); h.state.known = true;
  const id = input(h);
  h.state.mapped = false;
  assert.equal(h.recovery.ingestSnapshot(sessionId, { records: records(id) }).status, 'unmapped');
  h.state.mapped = true;
  h.recovery.ingestSnapshot(sessionId, { records: records(id) });
  h.state.policy = 'new-policy';
  await h.delivery.flush(); assert.deepEqual(h.calls, []);
  assert.equal(Object.values(h.delivery.snapshot().entries)[0].cancelled, true);
});
