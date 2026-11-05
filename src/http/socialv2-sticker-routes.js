// reserved2「表情包体系」路由组（AI 通过 MCP 工具调用的面）：
//   sticker-image / self-image / sticker-note / sticker-remark /
//   send-sticker / collect-sticker / sticker-list GET+POST。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。

import fs from 'node:fs';
import path from 'node:path';
import { truncateText } from '../md-to-plain.js';
import { formatStickerList } from '../sticker-lib.js';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSocialV2StickerRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    root,
    log,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    getCurrentMode,
    modeAllowed,
    shouldBlockSilentReply,
    stickerEnabled,
    stickerEntries,
    stickerSyncedAt,
    syncStickerLibrary,
    safeFetchBuffer,
    getStickerImageData,
    applyStickerNoteV2,
    setStickerRemarkV2,
    sendStickerV2,
    collectStickerV2,
    resolveReplyTargetV2,
    getSocialV2State,
    saveSocialV2State,
    appendActivity,
    scheduleReplyCheckV2,
    mimeFromBuffer,
    mimeFromUrl,
    getImageDimensions,
    toModelMedia,
    maxMediaBytes,
    maxMediaPixels,
    lastForcedAgentStickerSyncGet,
    lastForcedAgentStickerSyncSet
  } = deps;

  const parseKey = (key) => {
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return null;
    return { kind: keyMatch[1], id: Number(keyMatch[2]) };
  };

  if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const key = String(url.searchParams.get('key') ?? '').trim();
    const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return true; }
    try {
      const entry = await getStickerImageData(stickerId);
      const fetched = await safeFetchBuffer(entry.url, maxMediaBytes);
      const dims = getImageDimensions(fetched.buffer);
      if (dims && dims.width * dims.height > maxMediaPixels) {
        sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
        return true;
      }
      const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
      const prep = await toModelMedia(fetched.buffer, mimeType, `收藏表情 ${entry.id}`);
      if (!prep.ok) {
        sendJson({ ok: false, error: `表情图片无法提供给模型：${prep.error}` }, 413);
        return true;
      }
      sendJson({
        ok: true,
        key,
        sticker: {
          id: entry.id,
          desc: entry.desc || '',
          localNote: entry.localNote || '',
          tags: entry.tags || [],
          url: entry.url,
          md5: entry.md5
        },
        image: { mimeType: prep.mimeType, data: prep.buffer.toString('base64') },
        ...(prep.note ? { note: prep.note } : {})
      });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return true; }
    const selfPath = path.join(root, 'assets', 'deepseek娘.png');
    try {
      if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return true; }
      const buf = fs.readFileSync(selfPath);
      const mimeType = mimeFromBuffer(buf) || 'image/png';
      sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
    } catch (error) {
      sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return true; }
    const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
    const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
    const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
    const entry = applyStickerNoteV2(stickerId, note, tags, usage);
    if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
    log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
    sendJson({ ok: true, key, sticker: entry });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return true; }
    try {
      const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
      log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
      sendJson({ ok: true, key, sticker: entry });
    } catch (error) {
      sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    const caption = String(body.message ?? body.caption ?? '').trim();
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
    // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
    if (caption) {
      sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
      return true;
    }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return true; }
    const currentMode = getCurrentMode(key);
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    const parsed = parseKey(key);
    if (!parsed) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const { kind, id } = parsed;
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
      return true;
    }
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const stForReply = getSocialV2State(key);
      const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
        return true;
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const now = Date.now();
    try {
      const st = getSocialV2State(key);
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      const sent = await sendStickerV2(key, stickerId, {
        replyToMessageId: actualReplyToMessageId,
        atUserId
      });
      // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
      const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
      const text = `[表情包:${label}]`;
      st.recentMessages.push({
        messageId: sent.messageId ? String(sent.messageId) : null,
        sender: '我',
        text: truncateText(text, 200),
        plain: truncateText(text, 200),
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [],
        hasMedia: false,
        forwardIds: [],
        hasForward: false,
        sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
        time: Date.now()
      });
      const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
      if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      st.preSleepWaitSatisfiedAt = 0;
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
      saveSocialV2State();
      scheduleReplyCheckV2(key);
      log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
      appendActivity(`${key} [sticker] 工具发送表情：${label}`);
      sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
    } catch (error) {
      const st = getSocialV2State(key);
      const idx = st.sendTimes.indexOf(now);
      if (idx >= 0) st.sendTimes.splice(idx, 1);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      saveSocialV2State();
      log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const messageRef = String(body.messageId ?? body.seq ?? '').trim();
    const remark = String(body.remark ?? '').trim();
    if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const st = getSocialV2State(key);
    const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
    if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return true; }
    const now = Date.now();
    const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
    const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
    const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
      sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
      return true;
    }
    // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
    st.stickerCollectTimes = st.stickerCollectTimes || [];
    st.stickerCollectTimes.push(now);
    if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
    try {
      const result = await collectStickerV2(key, messageRef, remark);
      saveSocialV2State();
      log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
      appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
      sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
    } catch (error) {
      const idx = st.stickerCollectTimes.indexOf(now);
      if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
      if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
      saveSocialV2State();
      log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const key = String(url.searchParams.get('key') ?? '').trim();
    const query = String(url.searchParams.get('query') ?? '').trim();
    const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
    const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
    // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
    // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
    // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
    const force = false;
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; }
    try {
      const synced = await syncStickerLibrary(force);
      // agent 视角只看 global + 本会话条目；控制台（无令牌）全量。
      const list = formatStickerList(synced?.entries ?? stickerEntries, query, count,
        req.headers['x-agent-token'] ? key : '');
      sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const query = String(body.query ?? '').trim();
    const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
    const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
    let force = body.refresh === true;
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; }
    // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
    if (req.headers['x-agent-token'] && force) {
      const now = Date.now();
      if (now - lastForcedAgentStickerSyncGet() < 10000) force = false;
      else lastForcedAgentStickerSyncSet(now);
    }
    try {
      const synced = await syncStickerLibrary(force);
      const list = formatStickerList(synced?.entries ?? stickerEntries, query, count,
        req.headers['x-agent-token'] ? key : '');
      sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  return false;
}
