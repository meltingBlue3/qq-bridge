// reserved2「发送」路由组（AI 通过 MCP 工具调用的面）：
//   send-burst（分条，禁引用）、send-message（统一发送，支持引用/@）、send-poke（拍一拍）。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// 三条路由共享同一套闸门顺序：token → 模式/白名单 → 静默 → 敏感词 → 限频预占（失败回滚）。

import { SENSITIVE_RE } from '../sensitive.js';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSocialV2SendRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    socialV2,
    log,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    getCurrentMode,
    modeAllowed,
    shouldBlockSilentReply,
    computeGapsV2,
    sendMessagesV2,
    recordSentMessagesV2,
    getSocialV2State,
    saveSocialV2State,
    appendActivity,
    scheduleReplyCheckV2,
    findCjkSpaceWarning,
    findSplitBoundaryWarning,
    resolveReplyTargetV2,
    assertGroupMember,
    captureSendGuard,
    bot
  } = deps;

  const currentMode = (key) => getCurrentMode(key);

  // 模型可能把数组/字符串序列化成 JSON 字符串传入，这里统一还原。
  const normalizeRawMessages = (rawMessages) => {
    if (typeof rawMessages === 'string') {
      const trimmed = rawMessages.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed.map(String);
        } catch {}
      } else if (trimmed.startsWith('"')) {
        // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === 'string') return parsed;
          if (Array.isArray(parsed)) return parsed.map(String);
        } catch {}
      }
    }
    return rawMessages;
  };

  const toMessageList = (rawMessages) => Array.isArray(rawMessages)
    ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
    : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);

  const rollbackSendTimes = (st, now, count) => {
    for (let i = 0; i < count; i++) {
      const idx = st.sendTimes.indexOf(now);
      if (idx >= 0) st.sendTimes.splice(idx, 1);
    }
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
  };

  const rateLimitOk = (st, sendCfg, count, now) => {
    const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
    const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
    const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
    return !((maxPerMinute > 0 && recentMinute + count > maxPerMinute) || (maxPerHour > 0 && recentHour + count > maxPerHour));
  };

  const validateMessages = (messages, sendCfg) => {
    const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (messages.length > maxMsgs) return `最多发送 ${maxMsgs} 条`;
    for (const msg of messages) {
      if (msg.length > maxChars) return `单条消息不能超过 ${maxChars} 字`;
      if (SENSITIVE_RE.test(msg)) return '__SENSITIVE__';
    }
    return null;
  };

  const parseKey = (key) => {
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return null;
    return { kind: keyMatch[1], id: Number(keyMatch[2]) };
  };

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const messages = toMessageList(normalizeRawMessages(body.messages));
    const replyToMessageId = body.replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
      return true;
    }
    if (!key || !messages.length) {
      sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
      return true;
    }
    const sendCfgBurst = cfg.socialV2?.send ?? {};
    if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
      sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
      return true;
    }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return true; }
    if (currentMode(key) !== 'reserved2') {
      sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
      return true;
    }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    const parsed = parseKey(key);
    if (!parsed) {
      sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
      return true;
    }
    const { kind, id } = parsed;
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode(key))) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (shouldBlockSilentReply(key)) {
      sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
      return true;
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const validationError = validateMessages(messages, sendCfg);
    if (validationError) {
      if (validationError === '__SENSITIVE__') sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
      else sendJson({ ok: false, error: validationError }, 400);
      return true;
    }
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
      if (!rateLimitOk(st, sendCfg, messages.length, now)) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      // 先预占发送额度，避免并发绕过限频
      for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
      const sentMessages = await sendMessagesV2(key, messages, delays);
      recordSentMessagesV2(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
      appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
      const spaceWarn = findCjkSpaceWarning(messages);
      const splitWarn = findSplitBoundaryWarning(messages);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2(key, error.sent);
        log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      rollbackSendTimes(st, now, Math.max(0, messages.length - sentCount));
      saveSocialV2State();
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const rawMessages = normalizeRawMessages(body.messages);
    const isRawString = typeof rawMessages === 'string';
    const messages = toMessageList(rawMessages);
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
    // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
    // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
    // "字符串多段时有特殊间隔策略"。
    const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
    const gapMs = Number(body.gapMs);
    const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
    if (!key || !messages.length) {
      sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
      return true;
    }
    const sendCfgBurst = cfg.socialV2?.send ?? {};
    if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
      sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
      return true;
    }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return true; }
    if (currentMode(key) !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    const parsed = parseKey(key);
    if (!parsed) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const { kind, id } = parsed;
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode(key))) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (kind === 'private' && atUserId) {
      sendJson({ ok: false, error: '私聊不需要 @' }, 400);
      return true;
    }
    if (shouldBlockSilentReply(key)) {
      sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
      return true;
    }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
      return true;
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const validationError = validateMessages(messages, sendCfg);
    if (validationError) {
      if (validationError === '__SENSITIVE__') sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
      else sendJson({ ok: false, error: validationError }, 400);
      return true;
    }
    const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
    // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
    const st = getSocialV2State(key);
    const now = Date.now();
    if (!rateLimitOk(st, sendCfg, messages.length, now)) {
      sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
      return true;
    }
    // 先预占发送额度，避免并发绕过限频
    for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        // 引用解析失败：回滚已预占的发送额度
        rollbackSendTimes(st, now, messages.length);
        saveSocialV2State();
        sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
        return true;
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    try {
      const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
      recordSentMessagesV2(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
      appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
      const spaceWarn = findCjkSpaceWarning(messages);
      const splitWarn = findSplitBoundaryWarning(messages);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2(key, error.sent);
        log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      rollbackSendTimes(st, now, Math.max(0, messages.length - sentCount));
      saveSocialV2State();
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (currentMode(key) !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return true; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return true; }
    if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return true; }
    const parsed = parseKey(key);
    if (!parsed) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const { kind, id } = parsed;
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode(key))) {
      sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
      return true;
    }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return true; }
    if (kind === 'group' && !targetUserId) {
      sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
      return true;
    }
    if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
      sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
      return true;
    }
    // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
    if (kind === 'group') {
      const memberError = await assertGroupMember(id, targetUserId);
      if (memberError) { sendJson({ ok: false, error: memberError }, 403); return true; }
    }
    const st = getSocialV2State(key);
    const sendCfg = cfg.socialV2?.send ?? {};
    const now = Date.now();
    if (!rateLimitOk(st, sendCfg, 1, now)) {
      sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
      return true;
    }
    st.sendTimes.push(now);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默/暂停。
    // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
    // { ai: true }：拍一拍是 AI 通道动作，出站瞬间还要重查静默/暂停/关闭。
    const sendGuard = captureSendGuard(key, { ai: true });
    try {
      sendGuard();
      if (shouldBlockSilentReply(key)) {
        const blocked = new Error('静默模式已开启，当前不允许拍一拍');
        blocked.statusCode = 403;
        throw blocked;
      }
      if (kind === 'group') {
        await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
      } else {
        // 私聊拍一拍：send_poke 自动路由到当前私聊对象
        await bot.raw('send_poke', { user_id: id });
      }
      st.lastActionAt = now;
      st.lastAiReplyAt = now;
      st.wakeConfig.noActionCount = 0;
      const pokeText = kind === 'group'
        ? `[拍一拍] 我拍了拍 ${targetUserId}`
        : '[拍一拍] 我拍了拍你';
      st.recentMessages.push({
        messageId: null,
        sender: '我',
        text: pokeText,
        plain: pokeText,
        tail: pokeText,
        kind: 'poke',
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [],
        hasMedia: false,
        forwardIds: [],
        hasForward: false,
        poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
        time: Date.now()
      });
      const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
      if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
      st.preSleepWaitSatisfiedAt = 0;
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
      saveSocialV2State();
      log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
      appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
      sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
    } catch (error) {
      rollbackSendTimes(st, now, 1);
      log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
      sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
    }
    return true;
  }

  return false;
}
