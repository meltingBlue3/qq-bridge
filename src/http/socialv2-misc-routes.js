// reserved2 杂项路由组（AI 通过 MCP 工具调用的面 + 控制台读取面）：
//   check-send / tool-log GET+clear / feedback GET+clear+POST / my-recent / record-sent。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// 文件系统副作用（清空 tool-log / feedback 文件）以 clearToolLog / clearFeedback
// 闭包注入，模块自身不 import node:fs，便于纯内存单测。

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSocialV2MiscRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    log,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    readToolLog,
    clearToolLog,
    readFeedbackEntries,
    appendFeedbackEntry,
    clearFeedback,
    feedbackTimes,
    truncateText,
    appendActivity,
    getSocialV2State,
    readThroughSeqV2
  } = deps;

  if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const tool = String(body.tool ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!key || !tool || !token) {
      sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
      return true;
    }
    if (!agentTokenOk(key, token)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }
    if (!v2SessionAllowed(key)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
    const flag = flagMap[tool];
    if (!flag) {
      sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
      return true;
    }
    if (!v2ToolEnabled(flag)) {
      sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
      return true;
    }
    sendJson({ ok: true, key, tool });
    return true;
  }

  // ── 工具调用日志 ─────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    sendJson({ ok: true, entries: readToolLog(limit) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
    clearToolLog();
    log('控制台：工具调用日志已清空');
    sendJson({ ok: true });
    return true;
  }
  // ── 反馈 / 自己消息 ──────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
    sendJson({ ok: true, entries: readFeedbackEntries() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
    clearFeedback();
    log('控制台：清空 AI 反馈');
    sendJson({ ok: true });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
    const rawMessage = String(body.message ?? '').trim();
    if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return true; }
    // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
    const fNow = Date.now();
    const fTimes = feedbackTimes.get(key) || [];
    const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
    const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
    if (fRecentMinute >= 5 || fRecentHour >= 20) {
      sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
      return true;
    }
    fTimes.push(fNow);
    feedbackTimes.set(key, fTimes.slice(-100));
    const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
    const message = truncateText(rawMessage, maxLength);
    appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
    log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
    appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
    if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
      log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
    }
    sendJson({ ok: true, key, level, message });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return true; }
    const st = getSocialV2State(key);
    const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
    sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
    // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
    sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
    return true;
  }

  return false;
}
