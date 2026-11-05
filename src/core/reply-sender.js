// Shared per-conversation output ordering for text, bursts, stickers and voice.
// Transport adapters own protocol details; partial successes remain explicit.
export function createReplySender({
  captureSendGuard, redactKnownTokensOnly, splitForQQ, sendTextPart,
  sendMessagePart, sleep, getSendDelay, randInt, log = () => {},
}) {
  const sendChains = new Map();
  const lastSendFailed = new Map();
  function sendChainFor(key) { return sendChains.get(key) ?? Promise.resolve(); }
  function rememberSendChain(key, promise) {
    const tail = promise.catch(() => {});
    sendChains.set(key, tail);
    void tail.then(() => {
      if (sendChains.get(key) === tail) sendChains.delete(key);
    });
  }
  // Keep the caller's rejection, but recover the shared tail for later sends.
  function enqueue(key, task) {
    const result = sendChainFor(key).then(task);
    rememberSendChain(key, result.catch(() => {}));
    return result;
  }
  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    let chain = sendChainFor(key);
    for (const part of parts) {
      chain = chain
        .then(async () => {
          assertSendAllowed();
          await sendTextPart(key, part);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(getSendDelay()));
    }
    rememberSendChain(key, chain);
    return chain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }


  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key, { ai: true });
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    let chain = sendChainFor(key);
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      chain = chain
        .then(async () => {
          assertSendAllowed();
          await sendTextPart(key, msg);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        chain = chain.then(() => sleep(delay));
      }
    }
    rememberSendChain(key, chain);
    return chain.then(() => sent);
  }



  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key, { ai: true });
    const sent = [];
    const failed = [];
    let chain = sendChainFor(key);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      chain = chain
        .then(async () => {
          assertSendAllowed();
          await sendMessagePart(key, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ/burst 一致的失败记账：v1 社交循环靠它判断「是否真的说过话」。
          lastSendFailed.set(key, true);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        chain = chain.then(() => sleep(d));
      }
    }
    rememberSendChain(key, chain);
    return chain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }


  return { sendToQQ, sendBurstToQQ, sendMessagesV2, lastSendSucceeded, enqueue,
    entries: sendChains, failures: lastSendFailed };
}
