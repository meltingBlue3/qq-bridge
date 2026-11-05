// 控制台「二代仿真管理」路由组（全部位于 route-policy 的 adminOnlyV2Paths）：
//   config（运行时配置归一化落盘）、activity（暂停/恢复）、reset（清空二代状态）、
//   states（全会话概览）、wake（手动唤醒，首次强制 bootstrap）、initial-prompt（操作者预写环境说明）。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。

import path from 'node:path';
import { atomicWriteJson, readConfigObject } from '../json-file.js';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSocialV2AdminRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    root,
    socialV2,
    state,
    api,
    log,
    // config
    refreshAllDefaultWakeConfigsV2,
    // activity
    clearAllSocialV2Timers,
    setupSleepTimerV2,
    scheduleProactiveCheckV2,
    saveSocialV2State,
    // reset
    bumpSessionEpoch,
    sessionPromises,
    drainAllPromptQueues,
    stopRetiredSessionWork,
    sessionModels,
    modelAppliedSessions,
    reverse,
    collectors,
    v2TurnStartAt,
    turnLeaseNoted,
    toolCallNames,
    pendingSendToolCalls,
    sendToolSucceededSessions,
    forgetAgentToken,
    seenForwardIds,
    saveState,
    pendingWakeKeys,
    clearAllPendingWakeLeases,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    // wake
    getCurrentMode,
    modeAllowed,
    getSocialV2State,
    sendWakePromptV2,
    // initial-prompt
    initialPrompts,
    initialPromptStore,
    initialPromptMaxChars,
    canonicalV2Key,
    setInitialPrompt
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
    sendJson({ ok: true, config: cfg.socialV2 ?? {} });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
    const body = await readBody();
    const configFile = path.join(root, 'config.json');
    const file = readConfigObject(configFile);
    // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
    //
    // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
    // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
    // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
    // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
    // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
    // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
    // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
    const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
      ? file.socialV2
      : null;
    const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
    const merged = { ...current, ...body };
    // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
    for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
      if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
        merged[sub] = current[sub] ?? {};
      }
    }
    if (merged.autoReplyCheckMs !== undefined) {
      const n = Number(merged.autoReplyCheckMs);
      merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
    }
    // tools：只接受布尔开关
    const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
    if (body.tools && typeof body.tools === 'object') {
      merged.tools = { ...(current.tools ?? {}), ...body.tools };
      for (const k of toolFlags) {
        if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
      }
    }
    // wake：数值与字符串数组归一化
    if (body.wake && typeof body.wake === 'object') {
      merged.wake = { ...(current.wake ?? {}), ...body.wake };
      for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
        if (merged.wake[k] !== undefined) {
          const n = Number(merged.wake[k]);
          merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
          // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
          if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
        }
      }
      if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
      if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
      if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
      if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
      if (merged.wake.recommendedKeywords !== undefined) {
        merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
      }
      if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
      if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
    }
    // send：数值归一化
    if (body.send && typeof body.send === 'object') {
      merged.send = { ...(current.send ?? {}), ...body.send };
      for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
        if (merged.send[k] !== undefined) {
          const n = Number(merged.send[k]);
          merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
          // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
          if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
        }
      }
      if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
      if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
      if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
    }
    // wait：数值归一化
    if (body.wait && typeof body.wait === 'object') {
      merged.wait = { ...(current.wait ?? {}), ...body.wait };
      for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
        if (merged.wait[k] !== undefined) {
          const n = Number(merged.wait[k]);
          merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
        }
      }
    }
    // proactive：主动机会参数
    if (body.proactive && typeof body.proactive === 'object') {
      merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
      for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
        if (merged.proactive[k] !== undefined) {
          const n = Number(merged.proactive[k]);
          merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
          // 毫秒类字段统一非负取整；概率字段单独 clamp。
          if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
        }
      }
      if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
      if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
    }
    // sticker：表情包体系参数归一化
    if (body.sticker && typeof body.sticker === 'object') {
      merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
      if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
      for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
        if (merged.sticker[k] !== undefined) {
          const n = Number(merged.sticker[k]);
          merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
        }
      }
      if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
      if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
      if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
      if (body.sticker.collect && typeof body.sticker.collect === 'object') {
        merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
        if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
        for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
          if (merged.sticker.collect[k] !== undefined) {
            const n = Number(merged.sticker.collect[k]);
            merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
          }
        }
      }
    }
    // feedback：数值/布尔归一化
    if (body.feedback && typeof body.feedback === 'object') {
      merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
      if (merged.feedback.maxLength !== undefined) {
        const n = Number(merged.feedback.maxLength);
        merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
      }
      if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
    }
    // context：数值归一化
    if (body.context && typeof body.context === 'object') {
      merged.context = { ...(current.context ?? {}), ...body.context };
      for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
        if (merged.context[k] !== undefined) {
          const n = Number(merged.context[k]);
          merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
        }
      }
      for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
        const n = Number(merged.context[name] ?? fallback);
        merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
      }
      if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
    }
    if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
    if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
    if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
    file.socialV2 = merged;
    atomicWriteJson(configFile, file);
    cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
    // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
    // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
    const WAKE_DEFAULT_KEYS = [
      'defaultMode', 'recommendedDefaultInfinite',
      'recommendedSleepMinMs', 'recommendedSleepMaxMs',
      'recommendedProbability', 'recommendedKeywords',
      'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
      'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
    ];
    const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
      WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
    if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
    log('控制台：二代仿真配置已更新');
    sendJson({ ok: true, config: cfg.socialV2 });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
    sendJson({ ok: true, paused: socialV2.paused });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
    const body = await readBody();
    const paused = body.paused === true;
    socialV2.paused = paused;
    if (paused) {
      clearAllSocialV2Timers();
      log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
    } else {
      log('控制台：二代 AI 已恢复');
      for (const key of socialV2.conversations.keys()) {
        setupSleepTimerV2(key);
        scheduleProactiveCheckV2(key);
      }
    }
    if (saveSocialV2State() === false) {
      sendJson({ ok: false, paused: socialV2.paused, error: '当前进程的暂停状态已更新，但保存失败；请检查存储告警后重试' }, 500);
      return true;
    }
    sendJson({ ok: true, paused: socialV2.paused });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
    const scoped = deps.isConversationRoutingEnabled?.() === true;
    const keys = scoped
      ? [...new Set([...socialV2.conversations.keys(), ...Object.keys(state.sessions), ...sessionPromises.keys()])].filter((key) => getCurrentMode(key) === 'reserved2')
      : [...socialV2.conversations.keys()];
    if (scoped) {
      for (const key of keys) {
        bumpSessionEpoch(key);
        sessionPromises.delete(key);
        deps.clearSocialV2Timers(key);
        deps.drainPromptQueue(key, '二代状态已重置');
      }
    } else {
      bumpSessionEpoch();
      sessionPromises.clear();
      clearAllSocialV2Timers();
      drainAllPromptQueues('二代状态已重置');
    }
    for (const key of keys) {
      const sid = state.sessions[key];
      if (sid) {
        delete state.sessions[key];
        // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
        // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
        // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
        stopRetiredSessionWork(sid, key);
        sessionModels.delete(sid);
        modelAppliedSessions.delete(sid);
        reverse.delete(sid);
        collectors.delete(sid);
        v2TurnStartAt.delete(sid);
        turnLeaseNoted.delete(sid);
        toolCallNames.delete(sid);
        pendingSendToolCalls.delete(sid);
        sendToolSucceededSessions.delete(sid);
        // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
        api.events.forget?.(sid);
      }
      delete state.sessionPolicies[key];
      forgetAgentToken(key);
      socialV2.conversations.delete(key);
      seenForwardIds.delete(key);
    }
    saveState();
    pendingWakeKeys.clear();
    clearAllPendingWakeLeases();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    socialV2.paused = false;
    if (saveSocialV2State() === false) {
      sendJson({ ok: false, error: '内存状态已清理，但二代状态文件保存失败；原文件未覆盖，请检查存储告警' }, 500);
      return true;
    }
    log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
    sendJson({ ok: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
    const list = [];
    for (const [key, st] of socialV2.conversations) {
      list.push({
        key,
        wakeConfig: st.wakeConfig,
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        lastWakeReason: st.lastWakeReason,
        lastAiReplyAt: st.lastAiReplyAt,
        noActionCount: st.wakeConfig.noActionCount || 0
      });
    }
    sendJson({ ok: true, conversations: list });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const reason = String(body.reason ?? 'admin').trim() || 'admin';
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const currentMode = getCurrentMode(key);
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「二代协议说明 + 操作者为这个会话
    // 预写的初始提示词（群环境/氛围）」。若用手动唤醒的 admin 文案顶掉它，这个会话就
    // 永远拿不到引导 —— 而 bootstrapSent 一旦置真，后续再也不会补发。
    const firstWake = !st.bootstrapSent;
    if (firstWake) st.bootstrapSent = true;
    const effectiveReason = firstWake ? 'bootstrap' : reason;
    saveSocialV2State();
    // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
    // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
    // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
    // 表面上"唤醒成功"，实际上谁也不知道它失败了。
    void sendWakePromptV2(key, effectiveReason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
    log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
    sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
    return true;
  }

  // 操作者预写的「会话初始提示词」：控制台专用（AI 既读不到也改不了 —— adminOnlyV2Paths）。
  // 内容只在该会话**首次唤醒**（bootstrap）时注入一次，见 buildWakePromptV2。
  if (url.pathname === '/api/socialV2/initial-prompt' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) {
        const entries = [...initialPrompts.entries()]
          .map(([entryKey, entry]) => ({
            key: entryKey,
            chars: entry.text.length,
            createdAt: entry.createdAt || 0,
            updatedAt: entry.updatedAt || 0,
            preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
          }))
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: initialPromptStore.writable });
        return true;
      }
      const canonical = canonicalV2Key(key);
      if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const entry = initialPrompts.get(canonical) ?? null;
      sendJson({
        ok: true,
        key: canonical,
        exists: !!entry,
        text: entry?.text ?? '',
        createdAt: entry?.createdAt || 0,
        updatedAt: entry?.updatedAt || 0,
        maxChars: initialPromptMaxChars(),
        writable: initialPromptStore.writable
      });
      return true;
    }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const explicitDelete = body.delete === true;
    // 只接受 { key, text: string } 或 { key, delete: true }：
    // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
    if (!explicitDelete && typeof body.text !== 'string') {
      sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
      return true;
    }
    const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
    if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return true; }
    log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
    sendJson({
      ok: true,
      key: result.key,
      deleted: result.deleted,
      chars: result.chars,
      exists: !!result.entry,
      updatedAt: result.entry?.updatedAt || 0,
      maxChars: initialPromptMaxChars()
    });
    return true;
  }

  return false;
}
