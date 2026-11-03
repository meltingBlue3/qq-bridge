// 控制台 HTTP 的通用安全工具。
//
// 这组逻辑原本写在 startConsoleServer() 的每个请求闭包里：
//   · 安全响应头（DENY/CSP/nosniff/no-store/no-referrer）
//   · JSON 请求体读取（1MB 上限、30 秒超时、必须是 JSON 对象）
//   · Host / Origin 的本机回环校验
// 抽出来后，它们可以脱离真实 HTTP server 单测，也避免每个路由各自复制一份。

export const SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
});

/** 写一个 JSON 响应（统一 2 空格缩进 + 安全头）。 */
export function sendJsonResponse(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj, null, 2));
}

/** 本机回环允许的 Host 列表（端口必须用 server.address().port，而不是配置值）。 */
export function allowedLoopbackHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export function isAllowedHost(hostHeader, port) {
  return allowedLoopbackHosts(port).includes(String(hostHeader ?? '').toLowerCase());
}

export function isAllowedOrigin(originHeader, port) {
  let originHost = '';
  try { originHost = new URL(String(originHeader)).host; } catch { /* malformed origin is rejected */ }
  return allowedLoopbackHosts(port).includes(originHost);
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 错误统一带 `statusCode`，调用方（bridge 的路由 catch）直接回对应的 4xx。
 * 规则与原实现一致：
 *   · Content-Length 或实际累计超过 maxBytes → 413；
 *   · 空 body → {}；
 *   · 非对象（数组、字符串、null）→ 400；
 *   · 读取超时/连接中断 → 400。
 */
export function readJsonBody(req, { maxBytes = 1_000_000, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let bodyTimer = null;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      if (bodyTimer) clearTimeout(bodyTimer);
      const err = new Error(message);
      err.statusCode = status;
      reject(err);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (bodyTimer) clearTimeout(bodyTimer);
      resolve(value);
    };
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      fail(413, '请求体过大（超过 1MB）');
      return;
    }
    bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), timeoutMs);
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        req.pause?.();
        fail(413, '请求体过大（超过 1MB）');
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data.trim()) { done({}); return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(400, '请求体必须是 JSON 对象');
        return;
      }
      done(parsed);
    });
    req.on('error', () => fail(400, '请求体读取失败'));
    req.on('aborted', () => fail(400, '请求体读取中断'));
  });
}
