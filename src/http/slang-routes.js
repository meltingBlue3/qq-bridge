// reserved2 黑话学习路由组（AI 通过 MCP 工具调用的面）：
//   GET /api/socialV2/slang/query / POST /api/socialV2/slang/submit。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// 注意 slangEntries 是外层 let 且会被整体重赋值（loadSlang / 控制台清空），
// 因此必须以 getSlangEntries() getter 注入，不能按引用快照。
// 落盘与研究任务以函数注入。

import { SLANG_STATUS } from '../slang-learner.js';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSlangRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    log,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    confirmedSlangListV2,
    getSlangEntries,
    buildSlangContext,
    redactKnownTokensOnly,
    allowSlangSubmit,
    saveSlangStore,
    queueSlangTask,
    runSlangResearch,
    createSlangEntry,
    publicSlangEntry,
    mergeEvidence,
    appendActivity
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return true; }
    const list = confirmedSlangListV2().filter((e) => {
      if (!q) return true;
      return e.content.toLowerCase().includes(q)
        || e.meaning.toLowerCase().includes(q)
        || e.usage.toLowerCase().includes(q)
        || e.example.toLowerCase().includes(q);
    });
    sendJson({
      ok: true,
      key,
      total: list.length,
      entries: list,
      block: buildSlangContext(getSlangEntries(), cfg.slang?.injectMax ?? 8)
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
    const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return true; }
    if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return true; }
    if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; }
    if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return true; }
    if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return true; }
    const existing = getSlangEntries().find((e) => e.content === content);
    if (existing) {
      if (existing.status === SLANG_STATUS.CONFIRMED) {
        sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
        return true;
      }
      if (existing.status === SLANG_STATUS.REJECTED) {
        sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
        return true;
      }
      // candidate：累计出现次数并追加语境证据
      existing.count = (Number(existing.count) || 0) + 1;
      if (context) {
        existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
      }
      existing.updatedAt = new Date().toISOString();
      saveSlangStore();
      if (cfg.slang?.autoResearch !== false) {
        const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
        if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
          queueSlangTask(() => runSlangResearch([existing]));
        }
      }
      log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
      sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
      return true;
    }
    const entry = createSlangEntry({
      content,
      source: 'ai',
      status: SLANG_STATUS.CANDIDATE,
      evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
    });
    getSlangEntries().push(entry);
    saveSlangStore();
    if (cfg.slang?.autoResearch !== false) {
      queueSlangTask(() => runSlangResearch([entry]));
    }
    log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
    appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
    sendJson({ ok: true, entry: publicSlangEntry(entry) });
    return true;
  }

  return false;
}
