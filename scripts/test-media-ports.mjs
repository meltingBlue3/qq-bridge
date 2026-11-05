// 媒体抓取端口白名单：validateFetchUrl 的 allowPorts 门槛（离线——端口检查先于 DNS）。
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import dns from 'node:dns';

// safe-fetch captures lookup at import time. Replace it before loading the module;
// no query leaves this process, even when the host resolver stalls on .invalid.
const lookup = mock.method(dns.promises, 'lookup', async (hostname) => {
  assert.equal(hostname, 'offline.invalid');
  throw Object.assign(new Error('fixture ENOTFOUND'), { code: 'ENOTFOUND' });
});
const { validateFetchUrl, MEDIA_FETCH_PORTS } = await import('../src/safe-fetch.js');
after(() => mock.restoreAll());

// 断言错误类型区分「端口被拒」与「走到模拟 DNS」。
const NEVER = 'http://offline.invalid';

test('MEDIA_FETCH_PORTS：80/443/8080/8443（QQ 多媒体 CDN 的实际端口集）', () => {
  assert.deepEqual([...MEDIA_FETCH_PORTS].sort((a, b) => a - b), [80, 443, 8080, 8443]);
  assert.ok(Object.isFrozen(MEDIA_FETCH_PORTS));
});

test('白名单外端口在 DNS 之前被拒（不浪费解析、不给探测者探路信息）', async () => {
  const before = lookup.mock.callCount();
  await assert.rejects(validateFetchUrl(`${NEVER}:8081/x`, { allowPorts: MEDIA_FETCH_PORTS }), /端口 8081 不在允许的抓取端口白名单内/);
  await assert.rejects(validateFetchUrl(`${NEVER}:9443/x`, { allowPorts: MEDIA_FETCH_PORTS }), /端口 9443/);
  assert.equal(lookup.mock.callCount(), before);
});

test('白名单内端口与默认端口通过端口检查（继续走到 DNS，报解析失败而不是端口）', async () => {
  const before = lookup.mock.callCount();
  for (const u of [`${NEVER}:8443/x`, `${NEVER}/x`, `https://${'offline.invalid'}:443/x`]) {
    await assert.rejects(validateFetchUrl(u, { allowPorts: MEDIA_FETCH_PORTS }), /域名解析失败|主机名为空/,
      `${u} 不应被端口检查拒绝`);
  }
  assert.equal(lookup.mock.callCount(), before + 3);
});

test('不传 allowPorts 的调用（操作者路径）不受端口限制', async () => {
  await assert.rejects(validateFetchUrl(`${NEVER}:8081/x`), /域名解析失败/,
    '无白名单时端口不设限（内部抓取不受影响）');
});

test('重定向每一跳都复检端口：opts 透传（源码级）', () => {
  const src = fs.readFileSync(new URL('../src/safe-fetch.js', import.meta.url), 'utf8');
  assert.equal(src.split('validateFetchUrl(next, opts)').length - 1, 2, 'safeFetch 与 safeFetchBuffer 的重定向都要复检');
});

test('bridge.js：AI 通道媒体抓取（CDN/get_image/face）统一带端口白名单', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.equal(src.split('{ allowPorts: MEDIA_FETCH_PORTS }').length - 1, 3, '三处媒体抓取点');
  assert.match(src, /import \{ safeFetchBuffer, looksLikeImageBuffer, MEDIA_FETCH_PORTS \} from '\.\/safe-fetch\.js';/);
});
