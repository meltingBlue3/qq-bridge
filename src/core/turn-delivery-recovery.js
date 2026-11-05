import { createDshTurnLog, scanDshTurnSnapshot } from './dsh-turn-log.js';

// Joins complete DSH turns to their durable bridge input provenance. Never
// interpret an untracked historic assistant message as a new QQ reply.
export function createTurnDeliveryRecovery({ delivery, prepareReply, isMapped = () => true, log = () => {} }) {
  const streams = new Map();

  function observeEvent(sessionId, record) {
    const event = record?.type === 'event' ? record.event : record;
    const source = event?.data?.source ?? event?.data?.message?.source;
    return event?.type === 'user/message' && Number.isSafeInteger(event.seq) && event.seq >= 0
      && source?.kind === 'user' && typeof source.rpcId === 'string'
      && delivery.observeInput(sessionId, source.rpcId);
  }

  function recordTurn(sessionId, turn) {
    if (!turn.complete) {
      log(`Incomplete DSH turn cannot be recovered (${sessionId}, turn ${turn.turn}, seq ${turn.seq})`);
      return { status: 'incomplete' };
    }
    if (turn.unboundUser) return { status: 'untracked' };
    const intent = delivery.matchInputs(sessionId, turn.requestIds, turn.turn);
    if (!intent) return { status: 'untracked' };
    let reason;
    if (turn.reason !== 'completed') reason = `turn-${turn.reason ?? 'unknown'}`;
    else if (!intent.allowAuto) reason = 'input-disallows-automatic-output';
    else if (turn.sendToolAttempted) reason = 'explicit-qq-tool-attempted';
    else if (!turn.text.trim()) reason = 'empty-output';
    const prepared = reason ? { parts: [] } : prepareReply(turn.text, intent);
    if (!reason && prepared.reason) reason = prepared.reason;
    if (!reason && !prepared.parts?.some((part) => typeof part === 'string' && part.length)) reason = 'empty-output';
    const recorded = delivery.record({ ...intent, sessionId, turn: turn.turn, seq: turn.seq,
      allowAuto: !reason && intent.allowAuto, reason, parts: prepared.parts ?? [] });
    return { ...recorded, status: recorded.duplicate ? 'duplicate' : reason ? 'suppressed' : 'recorded' };
  }

  function ingestSnapshot(sessionId, snapshot) {
    if (!isMapped(sessionId)) return { status: 'unmapped', turns: [] };
    // Fetch and join older pages before committing any turn from a clipped
    // history. Otherwise a later reply could pass an unseen earlier one.
    if (snapshot?.hasMore === true) return { status: 'needs-history', cursor: snapshot.cursor, turns: [] };
    const scanned = scanDshTurnSnapshot(snapshot?.records);
    if (scanned.log.gaps.length || scanned.conflicts.length) return { status: 'gap', turns: [] };
    const turns = scanned.completed.map((turn) => recordTurn(sessionId, turn));
    const previous = streams.get(sessionId);
    if (!previous || previous.lastSeq === null
      || scanned.log.lastSeq !== null && scanned.log.lastSeq >= previous.lastSeq) streams.set(sessionId, scanned.log);
    let observed = false;
    const conflicts = new Set(scanned.conflicts);
    for (const record of snapshot?.records ?? []) {
      const event = record?.type === 'event' ? record.event : record;
      if (!conflicts.has(event?.seq) && observeEvent(sessionId, record)) observed = true;
    }
    return { status: 'scanned', turns, observed, gaps: scanned.log.gaps, conflicts: scanned.conflicts };
  }

  function ingestEvent(sessionId, event) {
    if (!isMapped(sessionId)) return null;
    let stream = streams.get(sessionId);
    if (!stream) { stream = createDshTurnLog(); streams.set(sessionId, stream); }
    if (stream.lastSeq !== null && event?.seq > stream.lastSeq + 1) return { status: 'gap' };
    const turn = stream.ingest(event);
    return turn ? recordTurn(sessionId, turn) : observeEvent(sessionId, event) ? { status: 'observed' } : null;
  }

  return { ingestSnapshot, ingestEvent, forget: (sessionId) => streams.delete(sessionId), clear: () => streams.clear() };
}
