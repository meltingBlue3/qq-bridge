// Per-conversation FIFO. Cancellation rejects waiting tasks; in-flight effects
// cannot be undone. An old completion never touches a replacement generation.
export function createConversationQueue({ entries = new Map() } = {}) {
  async function process(key, entry) {
    if (entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entries.get(key) === entry) entries.delete(key);
      return;
    }
    entry.running = true;
    try { item.resolve(await item.run({ isCurrent: () => entries.get(key) === entry })); }
    catch (error) { item.reject(error); }
    finally {
      entry.running = false;
      if (entries.get(key) === entry) {
        if (entry.queue.length) void process(key, entry);
        else entries.delete(key);
      }
    }
  }

  function enqueue(key, run) {
    return new Promise((resolve, reject) => {
      let entry = entries.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        entries.set(key, entry);
      }
      entry.queue.push({ run, resolve, reject });
      void process(key, entry);
    });
  }

  function cancel(key, reason = '会话任务已取消') {
    const entry = entries.get(key);
    if (!entry) return;
    const error = reason instanceof Error ? reason : new Error(reason);
    for (const item of entry.queue) item.reject(error);
    entry.queue = [];
    entries.delete(key);
  }

  function cancelAll(reason) { for (const key of entries.keys()) cancel(key, reason); }

  return { enqueue, cancel, cancelAll, entries, isBusy: (key) => entries.has(key) };
}
