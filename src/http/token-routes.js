// 控制台「令牌与花费」路由组。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
// QQ 侧 AI 是放行的（见 route-policy.js），而跨群花费属于管理信息，
// 不应让某个群里的 AI 读到别的群烧了多少钱。这里保留显式 403 做双保险。

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleTokenRoutes({ req, url, sendJson, deps }) {
  const { tokenLedger, getPriceSymbol, log } = deps;

  if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
    if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
      const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
      sendJson(tokenLedger.series({ hours, maxBuckets }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const detail = tokenLedger.conversation(key, { turnLimit: limit });
      if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return true; }
      sendJson(detail);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      sendJson({ ok: true, symbol: getPriceSymbol(), entries: tokenLedger.recent(limit) });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
      tokenLedger.reset();
      log('控制台：token 用量账本已重置');
      sendJson({ ok: true });
      return true;
    }
    sendJson({ ok: false, error: 'not found' }, 404);
    return true;
  }

  return false;
}
