// Admin policy API. auth is supplied by the authenticated HTTP middleware, never
// parsed from JSON. Agents (including tokenless owner agents) cannot use it.
const paths = new Set(['/api/conversations', '/api/conversations/migrate',
  '/api/conversations/policy', '/api/conversations/rollback']);

export async function handleConversationRoutes({ req, url, readBody, sendJson, auth, deps }) {
  if (!paths.has(url.pathname)) return false;
  if (auth?.kind !== 'console' || auth.authenticated !== true
    || req.headers?.['x-agent-call'] !== undefined || req.headers?.['x-agent-token'] !== undefined) {
    sendJson({ ok: false, error: '会话策略接口仅允许已认证的控制台' }, 403);
    return true;
  }
  const { store, getLegacy, onChanged = () => {}, getAvailablePresets = () => [] } = deps;
  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    sendJson({ ok: true, enabled: store.enabled, writable: store.writable,
      error: store.error?.message ?? null, document: store.snapshot() });
    return true;
  }
  const isMutation = req.method === 'POST' && ['/api/conversations/migrate', '/api/conversations/policy', '/api/conversations/rollback'].includes(url.pathname)
    || req.method === 'DELETE' && url.pathname === '/api/conversations/policy';
  if (!isMutation) { sendJson({ ok: false, error: '不支持的请求方法' }, 405); return true; }
  if (!store.writable) { sendJson({ ok: false, error: '会话策略存储只读，请修复文件并重新加载' }, 503); return true; }
  let committed = false;
  const previousStoreError = store.error;
  try {
    let result;
    if (url.pathname.endsWith('/migrate')) {
      // The live legacy state, not an untrusted body, defines the migration.
      const legacy = getLegacy();
      const needed = legacy.mode === 'closed-agent' && legacy.ownerQQ ? ['qsh-sim', 'qsh-closed'] : ['qsh-sim'];
      const available = await getAvailablePresets();
      if (needed.some((preset) => !available.includes(preset))) {
        sendJson({ ok: false, error: 'DSH 尚未加载迁移所需 preset，请先安装并重启 DSH' }, 409); return true;
      }
      result = store.migrate(legacy, auth);
    } else if (url.pathname.endsWith('/rollback')) result = store.rollback(auth);
    else if (req.method === 'DELETE') result = store.remove(url.searchParams.get('key'), auth);
    else {
      const body = await readBody();
      if (!(await getAvailablePresets()).includes(body.policy?.preset)) {
        sendJson({ ok: false, error: 'DSH 尚未加载该 preset，请先安装并重启 DSH' }, 409); return true;
      }
      await deps.validatePolicy?.(body.policy);
      result = store.update(body.key, body.policy, auth);
    }
    committed = true;
    await onChanged(result);
    sendJson({ ok: true, result });
  } catch (error) {
    const persistenceFailed = store.error && store.error !== previousStoreError;
    sendJson({ ok: false, error: error?.message ?? '会话策略操作失败', committed,
      ...(committed ? { requiresRestart: true } : {}) }, committed || persistenceFailed ? 500 : 400);
  }
  return true;
}
