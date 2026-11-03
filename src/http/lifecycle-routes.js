// 控制台「会话生命周期」路由组：清除上下文 / 清空工作区 / 重启桥接。
//
// 从 startConsoleServer() 整块搬出。这一组的特点是"清得干净"：
// 会话映射、权限元数据、collector、发送队列、社交状态、唤醒定时器、令牌表、
// 二代会话状态全部要同步清掉，任何一张表漏了都会表现为"重置后又复活"。
// Map/Set 全部按引用传入（原地变更），只有 sessionEpoch 需要 bump 回调。

import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../dsh-client.js';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleLifecycleRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    // 通用
    state,
    api,
    withTimeout,
    controlTimeoutMs,
    log,
    // session/reset
    bumpSessionEpoch,
    modelAppliedSessions,
    reverse,
    collectors,
    sendToolSucceededSessions,
    pendingSendToolCalls,
    v2TurnStartAt,
    turnLeaseNoted,
    toolCallNames,
    pending,
    cancelPendingEntry,
    queued,
    queuedHintAt,
    sessionPromises,
    drainPromptQueue,
    social,
    messageMediaStore,
    slangWindows,
    slangExtractionCooldowns,
    slangSubmitTimes,
    cancelSocialTimers,
    clearSocialV2Timers,
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    forgetAgentToken,
    socialV2,
    seenForwardIds,
    saveSocialV2State,
    saveState,
    // workspace/reset
    drainAllPromptQueues,
    cancelAllSocialTimers,
    clearAllSocialV2Timers,
    conversationTokens,
    knownAgentTokens,
    stateDir,
    activityLog,
    // restart
    releaseLock,
    exitProcess
  } = deps;

  if (req.method === 'POST' && url.pathname === '/api/session/reset') {
    const body = await readBody();
    const key = String(body.key ?? '');
    if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return true; }
    bumpSessionEpoch();
    const oldSessionId = state.sessions[key];
    delete state.sessions[key];
    modelAppliedSessions.delete(oldSessionId);
    // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
    delete state.sessionPolicies[key];
    reverse.delete(oldSessionId);
    collectors.delete(oldSessionId);
    sendToolSucceededSessions.delete(oldSessionId);
    pendingSendToolCalls.delete(oldSessionId);
    v2TurnStartAt.delete(oldSessionId);
    turnLeaseNoted.delete(oldSessionId);
    toolCallNames.delete(oldSessionId);
    const pe = pending.get(key);
    if (pe) {
      clearTimeout(pe.timer);
      cancelPendingEntry(pe).catch(() => {});
    }
    pending.delete(key);
    queued.delete(key);
    queuedHintAt.delete(key);
    sessionPromises.delete(key);
    drainPromptQueue(key, '会话已重置');
    social.recentMessages.delete(key);
    messageMediaStore.delete(key);
    social.pendingSummaries.delete(key);
    social.states.delete(key);
    social.silentContext.delete(key);
    social.silentTurns.delete(oldSessionId);
    social.exitingSessions.delete(oldSessionId);
    slangWindows.delete(key);
    slangExtractionCooldowns.delete(key);
    slangSubmitTimes.delete(key);
    cancelSocialTimers(key);
    clearSocialV2Timers(key);
    pendingWakeKeys.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
    wakeConfigMissCount.delete(key);
    forgetAgentToken(key);
    socialV2.conversations.delete(key);
    seenForwardIds.delete(key);
    saveSocialV2State();
    saveState();
    // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
    try { await withTimeout(api.stopSessionWork(oldSessionId), controlTimeoutMs, 'stopSessionWork'); }
    catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
    try { await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), controlTimeoutMs, 'archiveSession'); } catch {}
    log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
    sendJson({ ok: true, key, archived: oldSessionId });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
    bumpSessionEpoch();
    let archivedCount = 0;
    let stoppedCount = 0;
    try {
      // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
      // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
      const list = unwrap(await withTimeout(api.sessions.list({}), controlTimeoutMs, 'sessions.list'), 'session.list');
      const resolvedStateDir = path.resolve(stateDir);
      const statePrefix = path.normalize(resolvedStateDir + path.sep);
      const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
      const isUnderState = (cwd) => process.platform === 'win32'
        ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
        : cwd.startsWith(statePrefix);
      for (const item of list.items ?? []) {
        if (item.origin === 'subagent' || item.parentSessionId) continue;
        const cwd = normPath(item.cwd);
        if (isUnderState(cwd)) {
          // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
          try { await withTimeout(api.stopSessionWork(item.sessionId), controlTimeoutMs, 'stopSessionWork'); stoppedCount += 1; }
          catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), controlTimeoutMs, 'archiveSession'); archivedCount += 1; } catch {}
        }
      }
    } catch {}
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      cancelPendingEntry(entry).catch(() => {});
    }
    pending.clear();
    queued.clear();
    queuedHintAt.clear();
    sessionPromises.clear();
    drainAllPromptQueues('工作区已清空');
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    seenForwardIds.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    slangWindows.clear();
    slangExtractionCooldowns.clear();
    slangSubmitTimes.clear();
    cancelAllSocialTimers();
    clearAllSocialV2Timers();
    // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
    socialV2.conversations.clear();
    conversationTokens.clear();
    knownAgentTokens.clear();
    saveSocialV2State();
    state.sessions = {};
    state.sessionPolicies = {};
    reverse.clear();
    collectors.clear();
    sendToolSucceededSessions.clear();
    pendingSendToolCalls.clear();
    v2TurnStartAt.clear();
    toolCallNames.clear();
    saveState();
    try { fs.writeFileSync(activityLog, ''); } catch {}
    log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
    sendJson({ ok: true, archivedCount, stoppedCount });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/restart') {
    sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
    setTimeout(() => {
      log('控制台：重启桥接');
      // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
      // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
      try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
      try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
      releaseLock();
      exitProcess(0);
    }, 500);
    return true;
  }

  return false;
}
