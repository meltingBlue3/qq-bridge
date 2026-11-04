// reserved2 读路由组（AI 通过 MCP 工具调用的面）：
//   message-detail / forward-message / forward-media / active-members / group-members。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// bot.raw / bot.request / onebotHttpAction / fetchMediaData / resolveReplyInfo 等
// I/O 均以函数注入，模式判断用 getCurrentMode() 回调。

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSocialV2ReadRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    log,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    getCurrentMode,
    modeAllowed,
    allowed,
    getSocialV2State,
    resolveReplyInfo,
    seenForwardIds,
    botRaw,
    botRequest,
    onebotHttpAction,
    fetchMediaData,
    formatForwardResponse,
    truncateText,
    rememberForwardMediaV2,
    filterForwardMediaV2
  } = deps;

  // ── agent 视角的成员视图 ────────────────────────────────────────────────────
  // 带 x-agent-token 的调用（模型自己看）默认隐藏**管理员身份**（isOwner /
  // role=owner|admin）：群名册里的管理员标记被模型复述出去，等于把权限结构
  // 泄露给会话里的任何群友。userId 默认保留——拍一拍/点名工具需要它；
  // cfg.socialV2.privacy.exposeUserId=false 时一并隐藏（行为对齐上游 #88）。
  const isAgentCall = Boolean(req.headers['x-agent-token']);
  const exposeUserId = cfg.socialV2?.privacy?.exposeUserId !== false;
  const agentMemberView = (m) => {
    if (!isAgentCall) return m;
    const out = { ...m };
    delete out.isOwner;
    if (out.role === 'owner' || out.role === 'admin') delete out.role;
    if (!exposeUserId) {
      delete out.userId;
      delete out.user_id;
    }
    return out;
  };

  if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const messageId = String(url.searchParams.get('messageId') ?? '').trim();
    if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    try {
      const st = getSocialV2State(key);
      const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
      const forwardFields = found ? {
        forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
        hasForward: !!found.hasForward
      } : {};
      let info = null;
      // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
      if (found && found.messageId && String(found.messageId) !== messageId) {
        info = {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: found.userId ? String(found.userId) : null,
          messageId: String(found.messageId),
          seq: found.seq
        };
      } else {
        info = await resolveReplyInfo(kind, id, messageId);
        if (!info && found) {
          info = {
            sender: String(found.sender || ''),
            text: String(found.text || found.plain || '').slice(0, 200),
            userId: found.userId ? String(found.userId) : null,
            messageId: found.messageId ? String(found.messageId) : null,
            seq: found.seq
          };
        }
      }
      // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
      if (info && found) Object.assign(info, forwardFields);
      // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
      if (info) info.textTruncated = String(info.text ?? '').length >= 200;
      sendJson({ ok: true, key, messageId, info });
    } catch (error) {
      sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const id = String(url.searchParams.get('id') ?? '').trim();
    const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return true; }
    const currentMode = getCurrentMode();
    if (currentMode !== 'reserved2') {
      sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
      return true;
    }
    if (!agentToken) {
      sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
      return true;
    }
    if (!agentTokenOk(key, agentToken)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }
    const kind = keyMatch[1];
    const num = Number(keyMatch[2]);
    if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true;
    }
    if (!v2ToolEnabled('getForwardMsg')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
      return true;
    }
    // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
    const st = getSocialV2State(key);
    const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
    const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
    const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
    if (!seenInRecent && !seenInUnread && !seenInMemory) {
      sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
      return true;
    }
    try {
      const data = await botRaw('get_forward_msg', { id });
      const formatted = formatForwardResponse(data);
      const remember = (fid) => {
        if (!fid) return;
        let set = seenForwardIds.get(key);
        if (!set) {
          set = new Set();
          seenForwardIds.set(key, set);
        }
        set.add(fid);
        if (set.size > 1000) {
          for (const old of set) {
            set.delete(old);
            if (set.size <= 1000) break;
          }
        }
      };
      // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
      for (const m of formatted.messages || []) {
        for (const fid of m.nestedForwardIds || []) remember(fid);
      }
      // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
      const nestedPreviews = [];
      const nestedIds = [];
      const seenNested = new Set();
      for (const m of formatted.messages || []) {
        for (const fid of m.nestedForwardIds || []) {
          if (!seenNested.has(fid) && nestedIds.length < 5) {
            seenNested.add(fid);
            nestedIds.push(fid);
          }
        }
      }
      for (const fid of nestedIds) {
        try {
          const ndata = await botRaw('get_forward_msg', { id: fid });
          const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
          for (const nm of nfmt.messages || []) {
            for (const nfid of nm.nestedForwardIds || []) remember(nfid);
          }
          nestedPreviews.push({ id: fid, ...nfmt });
        } catch (error) {
          log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
          nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
        }
      }
      // 登记本层与嵌套预览里出现的媒体：forward-media 只抓「本会话真的见过」的媒体
      // （防模型凭空编 URL 让桥接去抓；身份键与 MCP 侧一致：url > file > emojiId > faceId）。
      const rememberMedia = (msgs) => {
        for (const m of Array.isArray(msgs) ? msgs : []) {
          if (m && Array.isArray(m.media) && m.media.length) rememberForwardMediaV2?.(key, m.media);
        }
      };
      rememberMedia(formatted.messages);
      for (const np of nestedPreviews) rememberMedia(np?.messages);
      sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
    } catch (error) {
      log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const media = Array.isArray(body.media) ? body.media : [];
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return true; }
    if (getCurrentMode() !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return true; }
    if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return true; }
    // 安全边界：只抓「本会话真的见过」的媒体（转发读取时登记 / 本会话消息已入库）。
    // 旧实现照单全收 body.media，等于给 AI 一个「帮我抓任意 URL」的原语。
    const { allowed, denied } = filterForwardMediaV2
      ? filterForwardMediaV2(key, media)
      : { allowed: media, denied: [] };
    if (!allowed.length) {
      sendJson({ ok: false, error: '请求的媒体都不在本会话已见范围内（只能读取本会话收到的转发/消息媒体）' }, 403);
      return true;
    }
    try {
      const images = await fetchMediaData(allowed);
      sendJson({
        ok: true,
        key,
        media: allowed,
        images,
        ...(denied.length ? { deniedCount: denied.length, note: `${denied.length} 条媒体不在本会话已见范围内，已拒绝` } : {})
      });
    } catch (error) {
      log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
      sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return true; }
    const st = getSocialV2State(key);
    const map = new Map();
    for (const m of st.recentMessages) {
      if (!m || m.isSelf) continue;
      const uid = m.userId ? String(m.userId) : '';
      const key2 = uid || String(m.sender || '未知');
      const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
      if (!cur.userId && uid) cur.userId = uid;
      cur.count += 1;
      if (m.time > cur.lastTime) cur.lastTime = m.time;
      if (m.isOwner) cur.isOwner = true;
      map.set(key2, cur);
    }
    const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit).map(agentMemberView);
    sendJson({ ok: true, key, members });
    return true;
  }
  // ── 群成员列表（v2 读工具；替代只有 closed-agent 才能用的旧只读工具）────────
  //
  // 为什么需要这一条：qq-chat-v2 预设第 6 条明确要求「QQ 号从 qq_get_group_members 的
  // user_id 拿」，但旧版是无令牌工具、在 reserved2 下必然 403 —— 模型被自己的提示词
  // 引到一个永远失败的工具上（实测 turn10 白烧一步）。这里给它一个带会话令牌的 v2 形态。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/group-members') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const groupMatch = /^group:(\d+)$/.exec(key);
    if (!groupMatch) { sendJson({ ok: false, error: '群成员只能按 group:群号 查询' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    // ⚠️ 白名单/模式判定**不能**挂在「有令牌」条件里：closed-agent 的代理调用本来就不带令牌
    // （它走的是操作者路径），只按 header 判断会让它拿任意群号去枚举成员 ——
    // 那正是旧 qq_get_group_members 明确防住的事（先 legacyReadToolAllowed 再 isAllowed）。
    //
    // 也不能直接用 v2SessionAllowed：它的 closed-agent 分支只放行 `private:<ownerQQ>`，
    // 于是「管理员在私聊里让 AI 看看某群成员」会 403 —— 那是旧工具本来支持的能力，
    // 属于这次改动不该带走的回归。所以 closed-agent 下按**同样严格的白名单**放行群读取。
    const currentMode = getCurrentMode();
    const groupMembersAllowed = currentMode === 'closed-agent'
      ? allowed('group', Number(groupMatch[1]), cfg)
      : v2SessionAllowed(key);
    if (!groupMembersAllowed) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getGroupMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_group_members' }, 403); return true; }
    const groupId = Number(groupMatch[1]);
    try {
      let response;
      try {
        response = await botRequest('get_group_member_list', { group_id: groupId });
      } catch (wsError) {
        // 与表情库同步同一条原则：WS 挂了不代表网关挂了，读接口走 HTTP 兜底。
        response = await onebotHttpAction('get_group_member_list', { group_id: groupId });
      }
      const payload = response && typeof response === 'object' && response.data !== undefined ? response.data : response;
      const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null);
      if (!raw) { sendJson({ ok: false, error: '网关返回的成员列表格式异常，已拒绝' }, 502); return true; }
      const members = raw.slice(0, limit).map((m) => ({
        userId: m?.user_id != null ? String(m.user_id) : '',
        nickname: truncateText(String(m?.nickname ?? ''), 40),
        card: truncateText(String(m?.card ?? ''), 40),
        ...(m?.role ? { role: String(m.role) } : {})
      })).filter((m) => m.userId).map(agentMemberView);
      sendJson({ ok: true, key, count: raw.length, returned: members.length, truncated: raw.length > members.length, members });
    } catch (error) {
      log(`群成员查询失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `获取群成员失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  return false;
}
