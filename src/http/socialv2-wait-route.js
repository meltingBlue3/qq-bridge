// reserved2「等待」路由：/api/socialV2/wait（qq_wait_for_messages 的后端）。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// 长轮询核心语义（不要改动前先读 test-socialv2-wait.mjs 与 test-reply-wait.mjs）：
//   · purpose=reply：短静默窗口，批延迟/读提示词耗时计入 quiet，新消息重置静默；
//   · purpose=messages：等 minNew 条新消息后，再等到 quietMs 静默才返回（不抢话）；
//   · 单次 timeoutMs ≥ 沉睡前观察窗口的等待才算观察；短等待不累计；
//   · 返回按「已读水位」补齐漏消息窗口，而不是按请求时刻的 baseline。
// 同一会话只允许一个长轮询（租约按归一化 key 记账，过期可接管）。

import { looksLikeUnfinished } from '../v2-wait.js';
import { countUnseenUnread, unreadCountNote } from '../social-v2/receipts.js';
import { preSleepWaitWindowMsV2 } from '../social-v2/wake-policy.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleWaitRoute({ req, res, url, sendJson, readBody, deps }) {
  const {
    cfg,
    socialV2,
    log,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    getCurrentMode,
    getSocialV2State,
    saveSocialV2State,
    readThroughSeqV2,
    noteModelMessagesV2,
    canonicalV2Key,
    activeWaits,
    activeWaitLeaseMs,
    suggestQuietMsV2,
    cancelReplyCheckV2,
    preSleepWaitBlockedV2
  } = deps;

  if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
      sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
      return true;
    }
    const replyWait = body.purpose === 'reply';
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return true; }
    if (socialV2.paused) {
      const st = getSocialV2State(key);
      sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
      return true;
    }
    const waitCfg = cfg.socialV2?.wait ?? {};
    const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
    const defaultMs = Number(waitCfg.defaultMs) || 30000;
    const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
    const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
    const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
    const st = getSocialV2State(key);
    // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
    // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
    // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
    // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
    const leaseKey = canonicalV2Key(key) ?? key;
    if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < activeWaitLeaseMs) {
      // 429 必须可执行：告诉模型「多久后租约才可能释放」（租约到期倒计时），
      // 并明确「立刻重试没有意义」——否则模型会把它当瞬时抖动马上重发，
      // 在整个租约期内打转。沉睡前观察场景单独给一句出口：静候即可，不要补发等待。
      const retryAfterMs = Math.max(0, activeWaits.get(leaseKey) + activeWaitLeaseMs - Date.now());
      sendJson({
        ok: false,
        error: '该会话已有一个等待中的 qq_wait_for_messages，不要立刻重试（重试只会拿到同样的拒绝）',
        retryAfterMs,
        hint: '若你只是在完成沉睡前观察：静候即可，观察窗口会随时间自然届满，不需要再发等待。'
      }, 429);
      return true;
    }
    const leaseStamp = Date.now();
    activeWaits.set(leaseKey, leaseStamp);
    // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
    const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
    req.on('close', finishWait);
    // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
    // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
    res.on('close', finishWait);
    const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
    const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
    const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
    // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
    // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
    // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
    const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
    // A reply wait must also include messages received while the model
    // was reading/thinking after its snapshot, before this HTTP request.
    const requestSeq = st.lastUnreadSeq || 0;
    const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
    const start = Date.now();
    let arrived = false;
    let lastNewAt = 0;
    let aborted = false;
    req.on('close', () => { aborted = true; });
    if (replyWait) {
      const incomingAt = () => {
        const value = Number(st.lastIncomingAt);
        return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
      };
      lastNewAt = incomingAt();
      let observedSeq = st.lastUnreadSeq || 0;
      // Batch delay and model reading time already count towards quiet.
      // New arrivals restart quiet, but timeoutMs remains a hard budget.
      while (!aborted && Date.now() - start < timeoutMs) {
        if ((st.lastUnreadSeq || 0) !== observedSeq) {
          observedSeq = st.lastUnreadSeq || 0;
          lastNewAt = incomingAt();
        }
        const remaining = quietMs - (Date.now() - lastNewAt);
        if (remaining <= 0) break;
        await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
      }
      // A message may arrive during the final sleep, exactly at timeout.
      // Its timestamp must still invalidate the previous quiet window.
      lastNewAt = incomingAt();
      arrived = (st.lastUnreadSeq || 0) > baseline;
    } else while (Date.now() - start < timeoutMs && !aborted) {
      let nowSeq = st.lastUnreadSeq || 0;
      if (nowSeq - baseline >= minNew) {
        arrived = true;
        lastNewAt = Date.now();
        // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
        // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
        while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
          if ((st.lastUnreadSeq || 0) > nowSeq) {
            nowSeq = st.lastUnreadSeq || 0;
            lastNewAt = Date.now();
          }
          await sleep(200);
        }
        break;
      }
      await sleep(300);
    }
    const waitedMs = Date.now() - start;
    if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
        (req.headers['x-agent-token'] && (getCurrentMode() !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
          || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
      finishWait();
      sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
      return true;
    }
    // 会话方反馈⑤：观察窗口按会话活跃度自适应（wake-policy.preSleepWaitWindowMsV2），
    // 显式配置的 preSleepWaitMs 是上限。这里取**等待结束时**的窗口：等待期间来过新消息
    // 会把活跃度推向更长的档位，闸门判定与给模型的建议参数保持同一口径。
    const preSleepWaitMs = preSleepWaitWindowMsV2(st, cfg.socialV2?.wake ?? {});
    // 闸门状态只算一次：既用于 preSleepWaitRemainingMs，也用于下面直接告诉模型"现在能不能收尾"。
    const preSleepBlocked = preSleepWaitBlockedV2(st);
    const preSleepRemainingMs = preSleepBlocked
      ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
      : 0;
    // 这次等待「算不算沉睡前观察」：闸门只认单次 timeoutMs ≥ 观察窗口的调用。
    // 实测踩过：模型用 timeoutMs=90000 等了 90 秒，以为完成了观察，结果闸门不认，
    // 只能再补一次 180 秒 —— 白花一轮。所以要在返回里把这件事说破，而不是让它自己悟。
    const preSleepCountsAsObservation = !replyWait && timeoutMs >= preSleepWaitMs;
    const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
    // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
    // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
    const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
    // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
    // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
    const preSleepSatisfiedNow = !replyWait && (!arrived
      ? waitedMs >= preSleepWaitMs
      : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
    if (preSleepSatisfiedNow) {
      st.preSleepWaitSatisfiedAt = Date.now();
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
    } else if (!replyWait && !arrived) {
      // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
      st.preSleepWaitAccumMs = 0;
    } else if (!replyWait) {
      // 等待期间有新消息：
      // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
      // - 否则只清空累计，不算完成沉睡前观察。
      if (preSleepAttempt) {
        st.preSleepWaitObservedAt = Date.now();
      }
      st.preSleepWaitAccumMs = 0;
    }
    if (!replyWait) saveSocialV2State();
    // Each buffer is governed by its own tool switch: the unread buffer by
    // getUnread, the recent buffer by getRecent. A disabled switch must not leak
    // through either newMessages or the watermark, so the buffer is dropped
    // before arrival is judged -- not filtered afterwards.
    const history = replyWait
      ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
        ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
      : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
    // ── 漏消息窗口（2026-10-18 修）──────────────────────────────────
    //
    // 旧实现按 `seq > baseline` 取"本次等待期间新到的"，而 baseline 对普通等待是
    // **请求开始时的 lastUnreadSeq**。于是「模型思考/发消息那几秒里到达的消息」
    // 永远落在窗口外：本次不返回、下次请求的 baseline 已经越过它们 ⇒ 既没展示给模型，
    // 也没进 readThroughSeq（连续游标）⇒ 水位从此卡死。
    // 实测：会话末段 readThroughSeq 钉在 185，可模型已经看过 205，
    // 之后每次等待都要多读一次 unread 才能收尾；期间有人 @ 也完全没进本回合。
    //
    // 现在按**已读过水位**取：凡是没有进入 readThroughSeq 的消息，一律补给它。
    // `arrived` 仍按 requestSeq 判（"有没有新动静"语义不变），所以等待不会变成忙轮询；
    // 只要这次确实返回了，返回的就是「从水位起连续的一段」，模型据此能正常推进水位。
    const watermarkAtRequest = readThroughSeqV2(st);
    const pendingFloor = Math.min(baseline, watermarkAtRequest);
    const fullPending = [...new Map(history
      .filter((m) => m && !m.isSelf && (m.seq || 0) > pendingFloor)
      .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
    // 有上限：一次倒 30 条旧账会把上下文挤爆。**必须从最老的开始取**（连续，
    // 水位才推得动）；被截断时 partial=true，提示模型用 unread 工具续读。
    const waitCap = Math.min(50, Math.max(12, Number(cfg.socialV2?.context?.unreadLimit) || 30));
    const pending = fullPending.length > waitCap ? fullPending.slice(0, waitCap) : fullPending;
    const pendingTruncated = fullPending.length > pending.length;
    // `arrived` is recomputed against what this request may actually hand over,
    // so a suppressed buffer cannot report an arrival it is not allowed to show.
    const newMessages = replyWait ? pending : (arrived ? pending : []);
    // newUnreadCount 在登记回执之前取：模型要的是「这次等待前我有几条没见过」。
    const newUnreadCount = countUnseenUnread(st);
    const unreadNote = unreadCountNote(st);
    const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
    const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
      : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
    const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
    finishWait();
    sendJson({
      ok: true,
      key,
      purpose: replyWait ? 'reply' : 'messages',
      arrived,
      quiet,
      quietMs,
      suggestedQuietMs,
      speakerLikelyDone: quiet,
      lastMessageUnfinished,
      timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
      waitedMs,
      preSleepWaitSatisfied: preSleepSatisfiedNow,
      preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
      // 补发被上限截断时告诉模型「还有更老的没给」，它才知道要用 unread(afterSeq=readThroughSeq) 续读。
      ...(pendingTruncated ? { partial: true } : {}),
      // A reply check has no sleep countdown; showing one here suggests
      // the model should complete sleep observation before its first reply.
      ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
      // ── 直接说「现在能不能收尾、该怎么收」 ────────────────────────────
      //
      // 为什么不能只给 preSleepWaitRemainingMs 让模型自己解读：实测它会用一次
      // timeoutMs=90000 的等待去凑 180 秒的观察窗口（闸门根本不认），然后再补一次 180 秒，
      // 白花一轮。这里把闸门的判断结果和**该发的参数**直接写给它，
      // 并且**只在闸门真的放行时**才说「可以收尾」——绝不诱导它提前设置潜水
      // （那会被桥接 400 拒绝，反而更慢）。
      ...(!replyWait ? {
        canSleepNow: !preSleepBlocked,
        countsAsObservation: preSleepCountsAsObservation,
        hint: preSleepBlocked
          ? `还不能收尾：还需约 ${Math.ceil(preSleepRemainingMs / 1000)} 秒没有新消息。要完成沉睡前观察，请用 qq_wait_for_messages(timeoutMs=${preSleepWaitMs}) 一次等满——更短的 timeoutMs 不算观察，满足不了闸门（本次 ${Math.round(timeoutMs)}ms ${preSleepCountsAsObservation ? '达标' : '不达标'}）。`
          : '现在可以直接收尾：qq_mark_read(throughSeq=已读水位) 或 qq_set_wake_config(throughSeq=已读水位, config=…)。不用再等一轮。'
      } : {}),
      newMessages,
      readThroughSeq,
      // 会话方反馈③：unreadCount 是缓冲总量（含已展示待确认），newUnreadCount 才是没见过的。
      unreadCount: st.unread.length,
      newUnreadCount,
      ...(unreadNote ? { unreadNote } : {})
    });
    return true;
  }

  return false;
}
