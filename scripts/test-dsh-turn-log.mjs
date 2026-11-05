import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshTurnLog, loadDshDeliveryHistory, scanDshTurnSnapshot } from '../src/core/dsh-turn-log.js';

const start = (seq, turn = 1) => ({ seq, type: 'turn/start', data: { turn } });
const user = (seq, rpcId = 'request-1') => ({ seq, type: 'user/message', data: {
  id: 'a-separate-message-id', role: 'user', source: { kind: 'user', rpcId }, content: [],
} });
const assistant = (seq, text = 'reply', turn = 1) => ({ seq, type: 'assistant/message', data: {
  turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] },
} });
const end = (seq, turn = 1, kind = 'completed') => ({ seq, type: 'turn/end', data: { turn, reason: { kind } } });
const wrap = (event) => ({ type: 'event', event });

test('real snapshot shape recovers complete turns using source.rpcId, not message ID', () => {
  const records = [start(4), user(5), assistant(6), end(7)].map(wrap);
  const result = scanDshTurnSnapshot(records);
  assert.deepEqual(result.completed, [{ turn: '1', seq: 7, startSeq: 4, reason: 'completed',
    complete: true, requestIds: ['request-1'], unboundUser: false, sendToolAttempted: false, text: 'reply' }]);
  assert.equal(result.log.firstSeq, 4);
  assert.equal(result.log.lastSeq, 7);
});

test('snapshot open turn can continue on the live tail without another start event', () => {
  const result = scanDshTurnSnapshot([start(4), user(5), assistant(6, 'first ')]);
  assert.equal(result.log.openTurn, '1');
  assert.deepEqual(result.completed, []);
  assert.equal(result.log.ingest(assistant(6, 'first ')), null);
  result.log.ingest(assistant(7, 'last'));
  assert.equal(result.log.ingest(end(8)).text, 'first last');
  assert.equal(result.log.openTurn, null);
});

test('merged history pages sort and deduplicate identical events', () => {
  const events = [end(7), assistant(6), wrap(assistant(6)), wrap(start(4)), user(5)];
  const result = scanDshTurnSnapshot(events);
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].text, 'reply');
  assert.deepEqual(result.conflicts, []);
});

test('a clipped turn or an internal sequence gap never yields partial text for recovery', () => {
  const clipped = scanDshTurnSnapshot([user(5), assistant(6), end(7)]).completed[0];
  assert.equal(clipped.complete, false);
  assert.equal(clipped.text, '');
  const gap = scanDshTurnSnapshot([start(4), user(5), assistant(7), end(8)]);
  assert.deepEqual(gap.log.gaps, [{ after: 5, before: 7 }]);
  assert.equal(gap.completed[0].complete, false);
  assert.equal(gap.completed[0].text, '');
});

test('a gap before a later complete turn does not lose that later turn', () => {
  const result = scanDshTurnSnapshot([end(2), start(10, 2), user(11), assistant(12, 'valid', 2), end(13, 2)]);
  assert.equal(result.completed[0].complete, false);
  assert.equal(result.completed[1].complete, true);
  assert.equal(result.completed[1].text, 'valid');
});

test('conflicting copies at the same sequence cannot be guessed or forwarded', () => {
  const result = scanDshTurnSnapshot([start(4), user(5), assistant(6, 'one'), assistant(6, 'two'), end(7)]);
  assert.deepEqual(result.conflicts, [6]);
  assert.equal(result.completed[0].complete, false);
  assert.equal(result.completed[0].text, '');
});

test('runtime-context messages do not become user intents; unbound user data is flagged', () => {
  const event = (seq, source) => ({ seq, type: 'user/message', data: { source, content: [] } });
  const result = scanDshTurnSnapshot([start(4), user(5), event(6, { kind: 'runtime-context' }),
    event(7, { kind: 'user' }), assistant(8), end(9)]).completed[0];
  assert.deepEqual(result.requestIds, ['request-1']);
  assert.equal(result.unboundUser, true);
});

test('QQ tool attempt marks fallback text unsafe even if its result is missing or errored', () => {
  for (const name of ['mcp__snowluma__qq_reply', 'mcp__snowluma__qq_send_voice', 'mcp__snowluma__qq_send_sticker']) {
    const result = scanDshTurnSnapshot([start(4), user(5), { seq: 6, type: 'tool/call', data: { turn: 1, name } },
      assistant(7), end(8)]).completed[0];
    assert.equal(result.sendToolAttempted, true);
  }
});

test('chunks do not duplicate assembled assistant text and failed turns stay distinguishable', () => {
  const log = createDshTurnLog();
  for (const event of [start(4), user(5), { seq: 6, type: 'assistant/chunk', data: { turn: 1, text: 'reply' } }, assistant(7)]) log.ingest(event);
  const completed = log.ingest(end(8, 1, 'error'));
  assert.equal(completed.text, 'reply');
  assert.equal(completed.reason, 'error');
});

test('oversized or malformed assistant content cannot be replayed as a partial reply', () => {
  const small = createDshTurnLog({ maxTextChars: 3 });
  for (const event of [start(4), user(5), assistant(6, 'too long')]) small.ingest(event);
  assert.equal(small.ingest(end(7)).complete, false);
  const malformed = scanDshTurnSnapshot([start(4), user(5), { seq: 6, type: 'assistant/message', data: { turn: 1, message: { content: 'bad' } } }, end(7)]);
  assert.equal(malformed.completed[0].complete, false);
});

test('older pages use one fixed log cut and fill a turn clipped by the opening snapshot', async () => {
  const calls = [];
  const result = await loadDshDeliveryHistory({ hasMore: true, cursor: 7, records: [wrap(end(7))] }, async (request) => {
    calls.push(request);
    if (request.beforeSeq === 7) return { hasMore: true, records: [wrap(assistant(6))] };
    return { hasMore: false, records: [wrap(start(4)), wrap(user(5))] };
  });
  assert.deepEqual(calls, [{ throughSeq: 7, beforeSeq: 7, maxMessages: 50 }, { throughSeq: 7, beforeSeq: 6, maxMessages: 50 }]);
  assert.equal(result.hasMore, false);
  assert.equal(result.pagesRead, 2);
  assert.equal(scanDshTurnSnapshot(result.records).completed[0].text, 'reply');
});

test('non-progressing, discontinuous or malformed pages cannot publish a clipped result', async () => {
  const initial = { hasMore: true, cursor: 7, records: [wrap(end(7))] };
  for (const page of [
    { hasMore: true, records: [wrap(end(7))] },
    { hasMore: false, records: [wrap(user(5))] },
    { hasMore: false, records: [] },
    { records: [wrap(assistant(6))] },
  ]) await assert.rejects(loadDshDeliveryHistory(initial, async () => page), /boundary|completion status/);
});

test('history limits fail explicitly instead of forwarding the newest clipped page', async () => {
  await assert.rejects(loadDshDeliveryHistory({ hasMore: true, cursor: 7, records: [wrap(end(7))] },
    async () => ({ hasMore: true, records: [wrap(assistant(6))] }), { maxPages: 1 }), /page limit/);
  await assert.rejects(loadDshDeliveryHistory({ hasMore: false, records: [wrap(start(4)), wrap(user(5))] },
    () => assert.fail('should not fetch'), { maxRecords: 1 }), /recovery budget/);
});

test('normalized recovery pages retain provenance and text without historical media/tool payloads', async () => {
  const rawUser = user(5); rawUser.data.content = [{ type: 'image', data: 'private-image-bytes' }];
  const tool = { type: 'tool/result', seq: 6, data: { message: { content: [{ type: 'text', text: 'private-tool-payload' }] } } };
  const snapshot = await loadDshDeliveryHistory({ hasMore: false,
    records: [start(4), rawUser, tool, assistant(7), end(8)] }, () => assert.fail('should not fetch'));
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('private-image-bytes'));
  assert.ok(!serialized.includes('private-tool-payload'));
  const completed = scanDshTurnSnapshot(snapshot.records).completed[0];
  assert.equal(completed.complete, true);
  assert.deepEqual(completed.requestIds, ['request-1']);
  assert.equal(completed.text, 'reply');
});
