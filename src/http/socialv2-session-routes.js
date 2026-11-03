// reserved2「会话读取与收尾」路由组（AI 通过 MCP 工具调用的面）：
//   state（qq_social_state）、prompt（qq_get_prompt）、unread/recent（读消息）、
//   mark-read（收尾确认）、wake-config（设置下一次唤醒）。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSocialV2SessionRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    log,
    // 鉴权与闸门
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    getCurrentMode,
    // 状态
    getSocialV2State,
    saveSocialV2State,
    // 唤醒策略（bridge 绑定 cfg 的包装 + 纯函数）
    computeWakeSafetyV2,
    isSleepingConfigV2,
    preSleepWaitBlockedV2,
    ensureWakeableV2,
    pickWakeTriggersV2,
    normalizeSpeakerIdsV2,
    // 水位协议
    readThroughSeqV2,
    requestedReadThroughSeqV2,
    acknowledgeMessagesV2,
    noteModelMessagesV2,
    markReadCalledKeys,
    wakeConfigUpdatedKeys,
    wakeConfigMissCount,
    cancelReplyCheckV2,
    setupSleepTimerV2,
    // prompt 聚合
    syncStickerLibrary,
    readRoleState,
    stickerEnabled,
    getSelfIdentity,
    currentRoleHint,
    currentRoleHintV2,
    replyTimingV2,
    formatMemoryV2,
    formatParticipationV2,
    confirmedSlangListV2,
    slangEntries,
    buildSlangContext,
    stickerEntries,
    buildStickerContext,
    buildStickerStrategyHint,
    voiceLibrary,
    voiceCfg
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return true; }
    const st = getSocialV2State(key);
    sendJson({
      ok: true,
      key,
      wakeConfig: st.wakeConfig,
      wakeSafety: computeWakeSafetyV2(st.wakeConfig),
      unreadCount: st.unread.length,
      recentCount: st.recentMessages.length,
      lastWakeReason: st.lastWakeReason,
      lastAiReplyAt: st.lastAiReplyAt
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return true; }
    const st = getSocialV2State(key);
    // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
    if (cfg.socialV2?.sticker?.enabled !== false) {
      try { await syncStickerLibrary(false); } catch {}
    }
    const roleState = readRoleState();
    const toolMap = {
      getPrompt: 'qq_get_prompt',
      getUnread: 'qq_get_unread_messages',
      getRecent: 'qq_get_recent_messages',
      socialState: 'qq_social_state',
      sendGroup: 'qq_send_group_message',
      sendPrivate: 'qq_send_private_message',
      reply: 'qq_reply',
      sendBurst: 'qq_send_burst',
      sendMessage: 'qq_send_message',
      waitMessages: 'qq_wait_for_messages',
      feedback: 'qq_report_feedback',
      getMyRecent: 'qq_get_my_recent_messages',
      getMessageDetail: 'qq_get_message_detail',
      getActiveMembers: 'qq_get_active_members',
      setWakeConfig: 'qq_set_wake_config',
      markRead: 'qq_mark_read',
      memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
      slangQuery: 'qq_slang_query',
      slangSubmit: 'qq_slang_submit',
      getImages: 'qq_get_message_images',
      getForwardMsg: 'qq_get_forward_msg',
      sendPoke: 'qq_send_poke',
      listStickers: 'qq_list_stickers',
      getStickerImage: 'qq_get_sticker_image',
      sendSticker: 'qq_send_sticker',
      setStickerRemark: 'qq_set_sticker_remark',
      stickerNote: 'qq_sticker_note',
      collectSticker: 'qq_collect_sticker',
      getSelfImage: 'qq_get_self_image',
      sendVoice: 'qq_send_voice / qq_list_voices'
    };
    const tools = cfg.socialV2?.tools ?? {};
    const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
    const enabledTools = [];
    for (const [flag, name] of Object.entries(toolMap)) {
      if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
    }
    const currentMode = getCurrentMode();
    const self = getSelfIdentity();
    sendJson({
      ok: true,
      key,
      time: new Date().toISOString(),
      // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
      self: {
        nickname: self.nickname || null,
        userId: self.userId || null,
        line: self.line || null
      },
      role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
      recommended: cfg.socialV2?.provideRecommendations === false ? null : {
        wake: cfg.socialV2?.wake ?? {},
        send: cfg.socialV2?.send ?? {},
        wait: cfg.socialV2?.wait ?? {},
        proactive: cfg.socialV2?.proactive ?? {}
      },
      enabledTools,
      replyTiming: replyTimingV2(st),
      unreadCount: st.unread.length,
      recentCount: st.recentMessages.length,
      currentWakeConfig: st.wakeConfig,
      wakeSafety: computeWakeSafetyV2(st.wakeConfig),
      memory: formatMemoryV2(st),
      participation: formatParticipationV2(st),
      slang: {
        enabled: cfg.slang?.enabled !== false,
        entries: confirmedSlangListV2(),
        block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
      },
      stickers: {
        enabled: cfg.socialV2?.sticker?.enabled !== false,
        total: stickerEntries.length,
        context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
        strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
      },
      // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
      voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
        enabled: true,
        total: voiceLibrary().length,
        names: voiceLibrary().slice(0, 12).map((v) => v.name),
        maxSeconds: voiceCfg().maxSeconds,
        hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
      }
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return true; }
    const afterRaw = url.searchParams.get('afterSeq');
    const afterSeq = afterRaw === null ? null : Number(afterRaw);
    if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
      sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
      return true;
    }
    const st = getSocialV2State(key);
    // Preserve the old tail read by default; cursor paging lets a backlog
    // larger than one response be read completely, even outside recent.
    const messages = afterSeq === null ? st.unread.slice(-limit)
      : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
    const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
    sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return true; }
    const st = getSocialV2State(key);
    const start = Math.max(0, st.recentMessages.length - offset - limit);
    const end = Math.max(0, st.recentMessages.length - offset);
    const messages = st.recentMessages.slice(start, end);
    const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
    sendJson({ ok: true, key, messages, readThroughSeq });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return true; }
    const st = getSocialV2State(key);
    // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
    // （旧 preset 与「没有水位」的收尾调用；见 acknowledgeMessagesV2 的注释与
    // test-token-economy 的 legacy 用例）。当前 preset 会明确要求带上 readThroughSeq 水位。
    const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
    // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
    // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
    if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
      const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
      const remainMin = Math.ceil(remaining / 60000);
      sendJson({
        ok: false,
        error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
        preSleepWaitMs: preSleepMs,
        preSleepWaitRemainingMs: remaining
      }, 400);
      return true;
    }
    const markedCount = acknowledgeMessagesV2(st, throughSeq);
    st.lastActionAt = Date.now();
    st.wakeConfig.noActionCount = 0;
    // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
    if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
      st.wakeConfig.infinite = true;
    }
    ensureWakeableV2(st, { key });
    st.wakeConfig.confirmedAt = Date.now();
    st.wakeConfig.confirmedBy = 'mark_read';
    markReadCalledKeys.add(key);
    saveSocialV2State();
    log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
    sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return true; }
    const st = getSocialV2State(key);
    const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
    // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
    const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
    const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
    const current = st.wakeConfig;
    const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
    const normalizeTriggerBool = (name, fallback) => {
      if (name in inputTriggers) return inputTriggers[name] === true;
      return fallback;
    };
    const rawKeywords = inputTriggers.keywords;
    const nextKeywords = rawKeywords !== undefined
      ? (Array.isArray(rawKeywords)
          ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
          : [])
      : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
    const next = {
      ...current,
      mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
      infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
      sleepUntil: current.sleepUntil,
      triggers: {
        // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
        ...pickWakeTriggersV2(inputTriggers, current.triggers),
        atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
        nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
        question: normalizeTriggerBool('question', current.triggers.question === true),
        anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
        poke: normalizeTriggerBool('poke', current.triggers.poke === true),
        keywords: nextKeywords
      },
      batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
        ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
        : current.batchWindowMs
    };
    // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
    if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
      next.triggers.anyMessage = false;
    }
    if (next.mode === 'active') {
      next.infinite = true;
      next.sleepUntil = null;
      next.triggers.anyMessage = true;
    }
    if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
    if (next.infinite) {
      next.sleepUntil = null;
    } else if (input.sleepUntil) {
      const d = new Date(String(input.sleepUntil));
      if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
    } else if (Number.isFinite(Number(input.sleepMs))) {
      let ms = Math.max(0, Math.round(Number(input.sleepMs)));
      const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
      const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
      if (ms < minMs) ms = minMs;
      if (maxMs > 0 && ms > maxMs) ms = maxMs;
      next.sleepUntil = new Date(Date.now() + ms).toISOString();
    } else if (!next.sleepUntil && !next.infinite) {
      // 既没有无限也没有时间：使用推荐默认有限时长
      const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
      const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
      const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
      next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
    }
    // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
    if (!next.infinite && next.sleepUntil) {
      const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
      const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
      let until = Date.parse(next.sleepUntil);
      if (Number.isFinite(until)) {
        if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
        if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
        next.sleepUntil = new Date(until).toISOString();
      }
    }
    // 归一化概率
    if (next.triggers.probability !== undefined) {
      next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
    }
    // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
    if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
      next.triggers.poke = input.triggers.poke === true;
    }
    // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
    // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
    next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
    // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
    if (key.startsWith('private:')) {
      next.triggers.speakerIds = [];
    }
    // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
    if (next.infinite) {
      const tr = next.triggers ?? {};
      const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
      if (!hasTrigger) {
        sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
        return true;
      }
    }
    // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
    if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
      const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
      const remainMin = Math.ceil(remaining / 60000);
      sendJson({
        ok: false,
        error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
        preSleepWaitMs: preSleepMs,
        preSleepWaitRemainingMs: remaining
      }, 400);
      return true;
    }
    const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
    st.wakeConfig = next;
    st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
    st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
    st.wakeConfig.noActionCount = 0;
    st.wakeConfig.confirmedAt = Date.now();
    st.wakeConfig.confirmedBy = 'set_wake_config';
    st.lastActionAt = Date.now();
    // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
    wakeConfigUpdatedKeys.add(key);
    wakeConfigMissCount.delete(key);
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
    setupSleepTimerV2(key);
    log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
    sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
    return true;
  }

  return false;
}
