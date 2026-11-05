// session/follow snapshots contain records of shape {type:'event', event},
// while live frames carry the event directly. A user/message in a turn carries
// the bridge's session/prompt requestId in data.source.rpcId (not data.id).
const seqOk = (seq) => Number.isSafeInteger(seq) && seq >= 0;
const turnOk = (turn) => seqOk(turn) || typeof turn === 'string' && turn.length > 0 && turn.length <= 200;
const SEND_TOOL = /^mcp__snowluma__qq_(reply|send_(?:group_message|private_message|burst|message|voice|sticker))$/;
export const isQqOutputTool = (name) => typeof name === 'string' && SEND_TOOL.test(name);

/** Stateful scanner for one ordered session stream. Only complete turns are replayable. */
export function createDshTurnLog({ maxTextChars = 256000 } = {}) {
  let active = null;
  let lastSeq = null;
  let firstSeq = null;
  const gaps = [];
  function ingest(record) {
    const event = record?.type === 'event' ? record.event : record;
    if (!event || !seqOk(event.seq) || typeof event.type !== 'string') return null;
    const { seq, type, data } = event;
    if (lastSeq !== null && seq <= lastSeq) return null;
    if (firstSeq === null) firstSeq = seq;
    if (lastSeq !== null && seq > lastSeq + 1) {
      gaps.push({ after: lastSeq, before: seq });
      if (gaps.length > 64) gaps.shift();
      if (active) active.complete = false;
    }
    lastSeq = seq;
    if (type === 'turn/start') {
      active = turnOk(data?.turn) ? { turn: String(data.turn), startSeq: seq, complete: true,
        requestIds: new Set(), unboundUser: false, sendToolAttempted: false, chunks: [], chars: 0 } : null;
      return null;
    }
    if (type === 'turn/end') {
      if (!turnOk(data?.turn)) { active = null; return null; }
      const turn = String(data.turn);
      const finished = active?.turn === turn ? active : null;
      active = null;
      return { turn, seq, reason: typeof data?.reason?.kind === 'string' ? data.reason.kind : null,
        startSeq: finished?.startSeq ?? null,
        complete: finished?.complete === true,
        requestIds: finished ? [...finished.requestIds] : [],
        unboundUser: finished?.unboundUser ?? true,
        sendToolAttempted: finished?.sendToolAttempted ?? false,
        text: finished?.complete ? finished.chunks.join('') : '' };
    }
    if (!active) return null;
    if (type === 'user/message') {
      const source = data?.source ?? data?.message?.source;
      if (source?.kind === 'runtime-context') return null;
      if (source?.kind === 'user' && typeof source.rpcId === 'string' && source.rpcId && source.rpcId.length <= 200) {
        active.requestIds.add(source.rpcId);
      } else active.unboundUser = true;
    } else if (type === 'tool/call' && String(data?.turn) === active.turn) {
      if (isQqOutputTool(data?.name)) active.sendToolAttempted = true;
    } else if (type === 'assistant/message' && String(data?.turn) === active.turn) {
      const blocks = data?.message?.content;
      if (!Array.isArray(blocks)) { active.complete = false; return null; }
      for (const block of blocks) {
        if ((block?.type === 'tool-call' || block?.type === 'tool_use') && isQqOutputTool(block.name)) active.sendToolAttempted = true;
        if (block?.type !== 'text') continue;
        if (typeof block.text !== 'string') { active.complete = false; continue; }
        if (!active.complete) continue;
        active.chars += block.text.length;
        if (active.chars > maxTextChars) { active.complete = false; active.chunks = []; continue; }
        active.chunks.push(block.text);
      }
    }
    return null;
  }
  return { ingest, get firstSeq() { return firstSeq; }, get lastSeq() { return lastSeq; },
    get openTurn() { return active?.turn ?? null; }, get gaps() { return gaps.map((gap) => ({ ...gap })); } };
}

/** Sort a snapshot (or joined history pages) and return a scanner for its live tail. */
export function scanDshTurnSnapshot(records) {
  const log = createDshTurnLog();
  const completed = [];
  const events = (Array.isArray(records) ? records : [])
    .map((record) => record?.type === 'event' ? record.event : record)
    .filter((event) => event && seqOk(event.seq) && typeof event.type === 'string')
    .sort((a, b) => a.seq - b.seq);
  const conflicts = new Set();
  for (let i = 1; i < events.length; i++) {
    if (events[i - 1].seq === events[i].seq && JSON.stringify(events[i - 1]) !== JSON.stringify(events[i])) conflicts.add(events[i].seq);
  }
  for (const event of events) {
    if (conflicts.has(event.seq)) continue; // Treat divergent copies as a missing record, never pick one.
    const turn = log.ingest(event);
    if (turn) completed.push(turn);
  }
  return { completed, log, conflicts: [...conflicts] };
}

// Retain only the fields needed to classify a reply. In particular, do not
// accumulate historical user images, tool arguments or tool results across pages.
function compactRecords(records) {
  if (!Array.isArray(records)) throw new Error('Missing DSH history records');
  return records.map((record) => {
    const event = record?.type === 'event' ? record.event : record;
    if (!event || !seqOk(event.seq) || typeof event.type !== 'string') throw new Error('Invalid DSH history sequence');
    const { seq, type, data } = event;
    let value = null;
    if (type === 'turn/start') value = { turn: data?.turn };
    else if (type === 'turn/end') value = { turn: data?.turn, reason: { kind: data?.reason?.kind } };
    else if (type === 'user/message') {
      const source = data?.source ?? data?.message?.source;
      value = { source: { kind: source?.kind, rpcId: source?.rpcId } };
    } else if (type === 'tool/call') value = { turn: data?.turn, name: data?.name };
    else if (type === 'assistant/message') {
      const blocks = data?.message?.content;
      value = { turn: data?.turn, message: { content: Array.isArray(blocks) ? blocks
        .filter((block) => ['text', 'tool-call', 'tool_use'].includes(block?.type))
        .map(({ type, text, name }) => ({ type, text, name })) : null } };
    }
    return { seq, type, data: value };
  });
}

/** Page older history at the follow snapshot's fixed log cut before replay. */
export async function loadDshDeliveryHistory(snapshot, readPage, {
  maxPages = 64, maxRecords = 30000, maxTextChars = 8000000, pageMessages = 50,
} = {}) {
  const pages = [compactRecords(snapshot?.records)];
  let recordCount = 0, chars = 0;
  function budget(records) {
    recordCount += records.length;
    for (const event of records) {
      if (event.type !== 'assistant/message') continue;
      for (const block of event.data.message.content ?? []) if (typeof block.text === 'string') chars += block.text.length;
    }
    if (recordCount > maxRecords || chars > maxTextChars) throw new Error('DSH replay history exceeds the recovery budget');
  }
  budget(pages[0]);
  let hasMore = snapshot?.hasMore === true;
  if (hasMore) {
    const throughSeq = snapshot.cursor;
    if (!seqOk(throughSeq) || !pages[0].length || pages[0].some((event) => event.seq > throughSeq)) {
      throw new Error('Clipped DSH snapshot has no valid log cut');
    }
    let beforeSeq = pages[0].reduce((seq, event) => Math.min(seq, event.seq), Infinity);
    while (hasMore) {
      if (pages.length > maxPages) throw new Error('DSH replay history exceeds the page limit');
      if (beforeSeq <= 0) throw new Error('DSH history claims more records before the beginning');
      const page = await readPage({ throughSeq, beforeSeq, maxMessages: pageMessages });
      if (typeof page?.hasMore !== 'boolean') throw new Error('DSH history page lacks completion status');
      const records = compactRecords(page.records);
      const latest = records.reduce((seq, event) => Math.max(seq, event.seq), -1);
      if (latest !== beforeSeq - 1) throw new Error('DSH history page did not join the snapshot at its boundary');
      budget(records);
      pages.push(records);
      beforeSeq = records.reduce((seq, event) => Math.min(seq, event.seq), Infinity);
      hasMore = page.hasMore;
    }
  }
  return { records: pages.reverse().flat(), cursor: snapshot?.cursor, hasMore: false, pagesRead: pages.length - 1 };
}
