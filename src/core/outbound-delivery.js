import crypto from 'node:crypto';
import { createJsonStore, isJsonObject } from '../json-store.js';
import { canonicalConversationKey } from './session-router.mjs';

const MODES = new Set(['chat', 'reserved', 'reserved2', 'simulation', 'closed-agent']);
const STATES = new Set(['held', 'pending', 'sending', 'delivered', 'uncertain', 'discarded']);
const simulation = (mode) => mode === 'reserved2' || mode === 'simulation';
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.length > 0;
const keyOk = (value) => typeof value === 'string' && canonicalConversationKey(value) === value;
const sessionOk = (value) => text(value) && value.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(value);
const messageId = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = String(value ?? '');
  return /^-?[1-9]\d{0,99}$/.test(id) ? id : null;
};
const idFor = (sessionId, turn) => JSON.stringify([sessionId, String(turn)]);
const terminal = (part) => part.status === 'delivered' || part.status === 'discarded';
const INPUT_STATES = new Set(['submitting', 'accepted', 'uncertain', 'rejected', 'command', 'completed']);
const empty = () => ({ version: 1, revision: 0, nextOrdinal: 1, entries: {}, sessions: {}, inputs: {}, resolutions: [] });

function valid(value) {
  if (!isJsonObject(value) || value.version !== 1 || !integer(value.revision)
    || !Number.isSafeInteger(value.nextOrdinal) || value.nextOrdinal < 1
    || !isJsonObject(value.entries) || !isJsonObject(value.sessions) || !isJsonObject(value.inputs) || !Array.isArray(value.resolutions)) return false;
  for (const [id, input] of Object.entries(value.inputs)) {
    if (!sessionOk(id) || !isJsonObject(input) || !sessionOk(input.sessionId) || !keyOk(input.key)
      || !text(input.policy) || !MODES.has(input.mode) || typeof input.silent !== 'boolean'
      || !INPUT_STATES.has(input.status) || !integer(input.updatedAt)) return false;
    if (input.status === 'completed' && (!text(input.completedBy)
      || value.entries[input.completedBy]?.sessionId !== input.sessionId)) return false;
  }
  for (const [id, entry] of Object.entries(value.entries)) {
    if (!isJsonObject(entry) || !sessionOk(entry.sessionId) || !text(entry.turn)
      || id !== idFor(entry.sessionId, entry.turn) || !keyOk(entry.key)
      || !text(entry.policy) || !integer(entry.seq) || !integer(entry.ordinal) || entry.ordinal < 1
      || entry.ordinal >= value.nextOrdinal || !integer(entry.createdAt)
      || !(entry.mode === null || MODES.has(entry.mode)) || typeof entry.cancelled !== 'boolean'
      || typeof entry.allowAuto !== 'boolean' || typeof entry.suppressed !== 'boolean'
      || !Array.isArray(entry.parts) || !integer(entry.cursor) || entry.cursor > entry.parts.length) return false;
    if (entry.suppressed && entry.parts.length) return false;
    if (!entry.allowAuto && !entry.suppressed) return false;
    if (simulation(entry.mode) && !entry.suppressed) return false;
    if (!value.sessions[entry.sessionId] || value.sessions[entry.sessionId].key !== entry.key) return false;
    for (const part of entry.parts) {
      if (!isJsonObject(part) || typeof part.text !== 'string' || !STATES.has(part.status)
        || !integer(part.attempts) || !integer(part.updatedAt)) return false;
      if (['held', 'pending', 'sending', 'uncertain'].includes(part.status) && !text(part.text)) return false;
      if (part.status === 'delivered' && !messageId(part.messageId)) return false;
      if (part.status === 'sending' && !text(part.attemptId)) return false;
    }
    const cursor = entry.parts.findIndex((part) => !terminal(part));
    if (entry.cursor !== (cursor < 0 ? entry.parts.length : cursor)) return false;
  }
  for (const [sid, session] of Object.entries(value.sessions)) {
    if (!sessionOk(sid) || !isJsonObject(session) || !keyOk(session.key)
      || !integer(session.lastObservedSeq) || !integer(session.lastSettledCompletionSeq)) return false;
  }
  return value.resolutions.every((entry) => isJsonObject(entry) && text(entry.actor) && text(entry.reason)
    && integer(entry.at) && text(entry.id) && integer(entry.partIndex)
    && ['acknowledge', 'discard', 'retry'].includes(entry.action));
}

// Only adapters with proof that transport was never invoked may use this type.
// HTTP errors, disconnects and timeouts are not such proof.
export class DeliveryNotSentError extends Error {}

// Durable completed output, separate from the pending-input backlog. Each turn
// has a per-part cursor; scalar sequence maxima are diagnostics, not proof that
// every preceding log record was delivered. Stable turn IDs own deduplication.
export function createOutboundDelivery({
  file, getContext, sendPart, now = Date.now, log = () => {}, maxEntries = 10000,
}) {
  if (typeof getContext !== 'function' || typeof sendPart !== 'function') throw new TypeError('Delivery requires policy and transport adapters');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be positive');
  const storage = createJsonStore({ file, fallback: empty, validate: valid, log });
  let document = storage.load();
  let recoveryError = null;
  const running = new Map();
  const snapshot = () => structuredClone(document);
  function stamp() {
    const at = now();
    if (!integer(at)) throw new Error('Invalid delivery clock');
    return at;
  }
  function commit(change) {
    if (recoveryError) throw recoveryError;
    const next = snapshot();
    change(next);
    next.revision++;
    for (const entry of Object.values(next.entries)) {
      const cursor = entry.parts.findIndex((part) => !terminal(part));
      entry.cursor = cursor < 0 ? entry.parts.length : cursor;
      if (entry.suppressed || entry.parts.every(terminal)) {
        const session = next.sessions[entry.sessionId];
        session.lastSettledCompletionSeq = Math.max(session.lastSettledCompletionSeq, entry.seq);
      }
    }
    if (!storage.save(next)) throw storage.lastError ?? new Error('Delivery journal save failed');
    document = next;
  }

  // A process may have died after QQ accepted the message. Recover the durable
  // intent as uncertain, never as pending. If this write fails, send nothing.
  if (Object.values(document.inputs).some((input) => input.status === 'submitting')
    || Object.values(document.entries).some((entry) => entry.parts.some((part) => part.status === 'sending'))) {
    try {
      commit((next) => {
        for (const input of Object.values(next.inputs)) if (input.status === 'submitting') {
          input.status = 'uncertain'; input.updatedAt = stamp();
        }
        for (const entry of Object.values(next.entries)) for (const part of entry.parts) {
          if (part.status === 'sending') {
            part.status = 'uncertain'; part.reason = 'process-restarted-during-send'; part.updatedAt = stamp();
          }
        }
      });
    } catch (error) { recoveryError = error; }
  }

  // Commit before calling session/prompt. Store provenance, not prompt content.
  // On a lost response only a matching DSH user/message can prove acceptance.
  function beginInput({ key, sessionId, policy, mode, silent = false, requestId = crypto.randomUUID() }) {
    if (!keyOk(key) || !sessionOk(sessionId) || !sessionOk(requestId) || !text(policy)
      || !MODES.has(mode) || typeof silent !== 'boolean') throw new Error('Invalid input submission record');
    if (Object.hasOwn(document.inputs, requestId)) throw new Error('Duplicate input request ID');
    if (Object.keys(document.inputs).length >= maxEntries * 4) throw new Error('Input provenance capacity reached');
    commit((next) => { next.inputs[requestId] = { key, sessionId, policy, mode, silent, status: 'submitting', updatedAt: stamp() }; });
    return requestId;
  }

  function finishInput(requestId, status) {
    if (!['accepted', 'rejected', 'command', 'uncertain'].includes(status)) throw new Error('Invalid input outcome');
    const current = Object.hasOwn(document.inputs, requestId) ? document.inputs[requestId] : null;
    if (!current) throw new Error('Input submission not recorded');
    if (current.status === 'completed' || current.status === status
      || current.status === 'accepted' && status === 'uncertain') return current.status;
    commit((next) => { next.inputs[requestId].status = status; next.inputs[requestId].updatedAt = stamp(); });
    return status;
  }

  function observeInput(sessionId, requestId) {
    const input = Object.hasOwn(document.inputs, requestId) ? document.inputs[requestId] : null;
    if (input?.sessionId !== sessionId || !['submitting', 'uncertain'].includes(input?.status)) return false;
    finishInput(requestId, 'accepted');
    return true;
  }

  function blocksInput(key, sessionId, policy) {
    return Object.values(document.inputs).some((input) => input.key === key
      && input.sessionId === sessionId && input.policy === policy
      && ['submitting', 'uncertain'].includes(input.status));
  }

  function matchInputs(sessionId, requestIds, turn) {
    if (!Array.isArray(requestIds) || !requestIds.length || requestIds.some((id) => !sessionOk(id))) return null;
    const ids = [...new Set(requestIds)];
    const inputs = ids.map((id) => Object.hasOwn(document.inputs, id) ? document.inputs[id] : null);
    const first = inputs[0];
    if (!first || inputs.some((input) => !input || input.sessionId !== sessionId
      || input.key !== first.key || input.policy !== first.policy || input.mode !== first.mode
      || input.status === 'rejected' || input.status === 'command'
      || input.status === 'completed' && input.completedBy !== idFor(sessionId, turn))) return null;
    return { key: first.key, policy: first.policy, mode: first.mode, inputIds: ids,
      allowAuto: !simulation(first.mode) && !inputs.some((input) => input.silent) };
  }

  function record({ key, sessionId, turn, seq, policy, mode = null, parts = [], allowAuto = false, reason = '', inputIds = [] }) {
    if (!keyOk(key) || !sessionOk(sessionId) || !(integer(turn) || text(turn) && turn.length <= 200)
      || !integer(seq) || !text(policy) || !(mode === null || MODES.has(mode))
      || !Array.isArray(parts) || parts.some((part) => typeof part !== 'string' || part.length > 8000)
      || typeof allowAuto !== 'boolean' || !Array.isArray(inputIds)) throw new Error('Invalid completed-output record');
    const id = idFor(sessionId, turn);
    if (Object.hasOwn(document.entries, id)) return { id, duplicate: true };
    if (Object.keys(document.entries).length >= maxEntries) throw new Error('Delivery journal capacity reached; no existing receipt was discarded');
    if (document.sessions[sessionId] && document.sessions[sessionId].key !== key) throw new Error('Session is already bound to another conversation');
    const suppressed = simulation(mode) || !allowAuto || !parts.some((part) => part.length);
    if (inputIds.length) {
      const matched = matchInputs(sessionId, inputIds, turn);
      if (!matched || matched.key !== key || matched.policy !== policy || matched.mode !== mode
        || allowAuto && !matched.allowAuto) throw new Error('Completed output does not match input provenance');
    }
    const at = stamp();
    commit((next) => {
      next.sessions[sessionId] ??= { key, lastObservedSeq: 0, lastSettledCompletionSeq: 0 };
      next.sessions[sessionId].lastObservedSeq = Math.max(next.sessions[sessionId].lastObservedSeq, seq);
      next.entries[id] = { key, sessionId, turn: String(turn), seq, policy, mode,
        ordinal: next.nextOrdinal++, createdAt: at, cancelled: false, allowAuto, suppressed,
        reason: suppressed ? (simulation(mode) ? 'simulation-internal' : reason || 'not-automatic-output') : reason,
        cursor: 0, parts: suppressed ? [] : parts.filter(Boolean).map((value) => ({
          text: value, status: mode === null ? 'held' : 'pending', attempts: 0, updatedAt: at,
        })),
      };
      for (const inputId of inputIds) {
        next.inputs[inputId].status = 'completed'; next.inputs[inputId].updatedAt = at; next.inputs[inputId].completedBy = id;
      }
    });
    return { id, duplicate: false };
  }

  function cancelEntries(ids, reason) {
    if (!ids.length) return;
    commit((next) => {
      for (const id of ids) {
        const entry = next.entries[id]; entry.cancelled = true;
        for (const part of entry.parts) {
          if (terminal(part)) continue;
          const uncertain = part.status === 'sending' || part.status === 'uncertain';
          part.status = uncertain ? 'uncertain' : 'discarded';
          if (!uncertain) part.text = '';
          part.reason = reason; part.updatedAt = stamp();
        }
      }
    });
  }
  function cancelKey(key, reason = 'conversation-revoked-or-reset') {
    cancelEntries(Object.keys(document.entries).filter((id) => {
      const entry = document.entries[id];
      return entry.key === key && !entry.cancelled && entry.parts.some((part) => !terminal(part));
    }), reason);
  }

  const contextMatches = (entry, context) => context?.allowed === true
    && context.sessionId === entry.sessionId && context.policy === entry.policy && context.discard !== true;

  async function flushKey(key) {
    if (running.has(key)) return running.get(key);
    if (!storage.writable || recoveryError) return { blocked: true };
    const task = Promise.resolve().then(async () => {
      let delivered = 0;
      try {
        for (;;) {
          const entry = Object.values(document.entries).filter((item) => item.key === key
            && !item.cancelled && !item.suppressed && item.parts.some((part) => !terminal(part)))
            .sort((a, b) => a.ordinal - b.ordinal)[0];
          if (!entry) break;
          const id = idFor(entry.sessionId, entry.turn);
          const index = entry.cursor;
          const part = entry.parts[index];
          const context = getContext(structuredClone(entry));
          if (context?.known !== true || !MODES.has(context.mode)) break;
          if (!contextMatches(entry, context)) {
            cancelEntries([id], 'policy-or-admission-changed'); continue;
          }
          // Recheck actual mode even if the producer misclassified the record.
          if (simulation(context.mode)) {
            if (entry.parts.some((item) => item.attempts > 0)) cancelEntries([id], 'simulation-internal');
            else commit((next) => { next.entries[id].mode = context.mode; next.entries[id].suppressed = true;
              next.entries[id].reason = 'simulation-internal'; next.entries[id].parts = []; });
            continue;
          }
          if (entry.mode !== null && entry.mode !== context.mode) {
            cancelEntries([id], 'mode-changed'); continue;
          }
          if (part.status === 'uncertain' || part.status === 'sending') break;
          if (context.online !== true || context.paused === true) break;
          const attemptId = crypto.randomUUID();
          commit((next) => {
            const current = next.entries[id]; current.mode = context.mode;
            const active = current.parts[index]; active.status = 'sending'; active.attemptId = attemptId;
            active.attempts++; active.updatedAt = stamp();
          });
          let result;
          try {
            // If the adapter queues or prepares anything asynchronously it must
            // call this again immediately before invoking its transport.
            const assertCurrent = () => {
              const active = document.entries[id];
              const current = getContext(structuredClone(active));
              if (active.cancelled || active.parts[index].attemptId !== attemptId
                || current?.known !== true || current.mode !== context.mode
                || !contextMatches(active, current) || current.online !== true || current.paused === true) {
                throw new DeliveryNotSentError('Delivery no longer eligible before transport');
              }
            };
            assertCurrent();
            result = await sendPart({ id, key, sessionId: entry.sessionId, turn: entry.turn,
              seq: entry.seq, partIndex: index, text: part.text, attemptId, assertCurrent });
          } catch (error) {
            const status = error instanceof DeliveryNotSentError ? 'pending' : 'uncertain';
            commit((next) => {
              const current = next.entries[id]; const active = current.parts[index];
              if (active.attemptId !== attemptId) return;
              active.status = current.cancelled && status === 'pending' ? 'discarded' : status;
              if (active.status === 'discarded') active.text = '';
              active.reason = status === 'pending' ? 'transport-not-invoked' : 'transport-result-unknown';
              active.updatedAt = stamp();
            });
            break;
          }
          const receipt = messageId(result?.messageId);
          commit((next) => {
            const active = next.entries[id].parts[index];
            if (active.attemptId !== attemptId) return;
            active.status = receipt ? 'delivered' : 'uncertain'; active.updatedAt = stamp();
            if (receipt) { active.messageId = receipt; active.text = ''; }
            else active.reason = 'missing-acknowledgement';
          });
          if (!receipt) break;
          delivered++;
        }
        return { delivered };
      } catch (error) {
        log(`Delivery stopped for ${key}: ${error.message}`);
        return { delivered, blocked: true, error: error.message };
      }
    });
    running.set(key, task);
    try { return await task; }
    finally { if (running.get(key) === task) running.delete(key); }
  }

  function resolveUncertain({ id, partIndex, action, actor, reason, expectedRevision, verifiedMessageId }) {
    if (!text(actor) || !text(reason) || !integer(partIndex) || expectedRevision !== document.revision) throw new Error('Resolution requires authenticated actor, reason and current revision');
    const entry = document.entries[id]; const part = entry?.parts?.[partIndex];
    if (!part || part.status !== 'uncertain' || running.has(entry.key)) throw new Error('Only an idle uncertain delivery may be resolved');
    if (!['acknowledge', 'discard', 'retry'].includes(action)) throw new Error('Unknown delivery resolution');
    const receipt = messageId(verifiedMessageId);
    if (action === 'acknowledge' && !receipt) throw new Error('A verified QQ message ID is required');
    if (action === 'retry') {
      const context = getContext(structuredClone(entry));
      if (entry.cancelled || context?.known !== true || !contextMatches(entry, context)
        || !MODES.has(context.mode) || simulation(context.mode) || entry.mode !== context.mode) {
        throw new Error('Cannot retry a revoked or internal delivery');
      }
    }
    commit((next) => {
      const active = next.entries[id].parts[partIndex];
      active.status = action === 'acknowledge' ? 'delivered' : action === 'discard' ? 'discarded' : 'pending';
      if (action !== 'retry') active.text = '';
      if (receipt && action === 'acknowledge') active.messageId = receipt;
      active.updatedAt = stamp();
      next.resolutions.push({ id, partIndex, action, actor, reason, at: stamp() });
    });
  }

  return {
    beginInput, finishInput, observeInput, blocksInput, matchInputs, record, cancelKey, resolveUncertain, snapshot,
    flush: () => Promise.all([...new Set(Object.values(document.entries).map((entry) => entry.key))].map(flushKey)),
    get writable() { return storage.writable && !recoveryError; },
    get error() { return recoveryError ?? storage.lastError; },
  };
}
