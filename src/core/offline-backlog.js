// In-memory pending input. This is not an outbound delivery receipt or a durable journal.
export function createOfflineBacklog({
  deliver, isReady, isAllowed, isBlocked = () => false, log = () => {}, maxPerKey = 50,
  timers = { setTimeout, clearTimeout },
}) {
  if (!Number.isSafeInteger(maxPerKey) || maxPerKey < 1) throw new TypeError('maxPerKey must be positive');
  const pending = new Map();
  const running = new Map();
  const retries = new Map();
  const scheduled = new Map();

  function cap(key, items) {
    const dropped = Math.max(0, items.length - maxPerKey);
    if (dropped) {
      items.splice(0, dropped);
      log(`离线队列满（${maxPerKey}），丢弃 ${dropped} 条最旧消息 (${key})`);
    }
    return items;
  }

  function schedule(key, delay) {
    if (scheduled.has(key)) timers.clearTimeout(scheduled.get(key));
    const timer = timers.setTimeout(() => {
      scheduled.delete(key);
      void flushKey(key).catch((error) => log(`补投异常 ${key}: ${error.message}`));
    }, delay);
    timer.unref?.();
    scheduled.set(key, timer);
  }

  function enqueue(key, item, { dedupe = false, retryAfterMs } = {}) {
    const items = pending.get(key) ?? [];
    if (!dedupe || !items.some((queued) => queued.promptText === item.promptText)) items.push(item);
    pending.set(key, cap(key, items));
    retries.delete(key);
    if (retryAfterMs !== undefined) schedule(key, retryAfterMs);
  }

  function discard(key) {
    pending.delete(key);
    retries.delete(key);
    const active = running.get(key);
    if (active) active.cancelled = true;
    if (scheduled.has(key)) timers.clearTimeout(scheduled.get(key));
    scheduled.delete(key);
  }

  function discardAll() {
    for (const key of new Set([...pending.keys(), ...running.keys(), ...scheduled.keys()])) discard(key);
  }

  function prepend(key, item) {
    pending.set(key, cap(key, [item, ...(pending.get(key) ?? [])]));
  }

  function flushKey(key) {
    const previous = running.get(key);
    if (previous && !previous.cancelled) {
      previous.flushAgain = true;
      return previous.promise;
    }
    if (!isReady() || !pending.has(key)) return Promise.resolve();
    if (scheduled.has(key)) timers.clearTimeout(scheduled.get(key));
    scheduled.delete(key);
    const active = { cancelled: false, flushAgain: false, promise: null };
    running.set(key, active);
    // Register ownership before any user callback can re-enter flush().
    active.promise = Promise.resolve().then(async () => {
      let sent = 0;
      let failed = 0;
      try {
        while (!active.cancelled && pending.has(key)) {
          if (!isAllowed(key)) { discard(key); break; }
          if (!isReady() || isBlocked(key)) break;
          const items = pending.get(key);
          const item = items.shift();
          if (!items.length) pending.delete(key);
          try {
            const result = await deliver(key, item);
            if (active.cancelled) break;
            if (result?.uncertain) {
              retries.delete(key);
              log(`补投结果待确认 ${key}：不重复提交`);
              break;
            }
            if (result?.queued) { prepend(key, item); break; }
            if (!result?.ok) throw new Error(result?.error || '未知错误');
            retries.delete(key);
            if (!result.skipped) sent++;
          } catch (error) {
            if (active.cancelled) break;
            if (!isAllowed(key)) { discard(key); break; }
            prepend(key, item);
            failed++;
            const count = (retries.get(key) ?? 0) + 1;
            retries.set(key, count);
            const delay = count > 5 ? 60000 : Math.min(3000 * 2 ** (count - 1), 60000);
            log(`补投失败 ${key}: ${error.message}；${delay}ms 后重试`);
            schedule(key, delay);
            break;
          }
        }
        return { sent, failed };
      } finally {
        if (running.get(key) === active) {
          running.delete(key);
          if (!active.cancelled && active.flushAgain && pending.has(key) && !scheduled.has(key)) schedule(key, 200);
        }
        if (!active.cancelled) log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
      }
    });
    return active.promise;
  }

  const flush = () => Promise.all([...new Set([...pending.keys(), ...running.keys()])].map(flushKey));
  return { enqueue, flush, discard, discardAll, pending, dispose: discardAll };
}
