// http-utils 的纯单元回归：用假 req/res，不需要监听端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  allowedLoopbackHosts,
  isAllowedHost,
  isAllowedOrigin,
  readJsonBody,
  sendJsonResponse
} from '../src/http-utils.js';

function fakeRequest(headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.paused = false;
  req.pause = () => { req.paused = true; };
  return req;
}

test('Host / Origin 只接受本机回环与绑定端口', () => {
  assert.deepEqual(allowedLoopbackHosts(3100), ['127.0.0.1:3100', 'localhost:3100', '[::1]:3100']);
  for (const host of ['127.0.0.1:3100', 'LOCALHOST:3100', '[::1]:3100']) {
    assert.equal(isAllowedHost(host, 3100), true, host);
  }
  for (const host of ['evil.com:3100', '127.0.0.1:3101', '', 'localhost']) {
    assert.equal(isAllowedHost(host, 3100), false, host);
  }
  assert.equal(isAllowedOrigin('http://127.0.0.1:3100', 3100), true);
  assert.equal(isAllowedOrigin('http://localhost:3100/path', 3100), true);
  assert.equal(isAllowedOrigin('https://evil.com', 3100), false);
  assert.equal(isAllowedOrigin('not a url', 3100), false);
});

test('readJsonBody：空 body 返回 {}，合法对象正常解析', async () => {
  const empty = fakeRequest();
  const p1 = readJsonBody(empty);
  empty.emit('end');
  assert.deepEqual(await p1, {});

  const req = fakeRequest({ 'content-length': '11' });
  const p2 = readJsonBody(req);
  req.emit('data', Buffer.from('{"a":1}'));
  req.emit('end');
  assert.deepEqual(await p2, { a: 1 });
});

test('readJsonBody：非法 JSON / 非对象 / 超限 / 中断都带正确的 statusCode', async () => {
  const cases = [
    ['not-json', /请求体必须是合法 JSON/, 400],
    ['[]', /请求体必须是 JSON 对象/, 400],
    ['null', /请求体必须是 JSON 对象/, 400]
  ];
  for (const [body, pattern, status] of cases) {
    const req = fakeRequest();
    const p = readJsonBody(req);
    req.emit('data', Buffer.from(body));
    req.emit('end');
    await assert.rejects(p, (error) => error.statusCode === status && pattern.test(error.message));
  }

  const tooLarge = fakeRequest({ 'content-length': '100' });
  await assert.rejects(readJsonBody(tooLarge, { maxBytes: 10 }), (error) => error.statusCode === 413);

  const streamed = fakeRequest();
  const p = readJsonBody(streamed, { maxBytes: 5 });
  streamed.emit('data', Buffer.from('123456'));
  await assert.rejects(p, (error) => error.statusCode === 413);
  assert.equal(streamed.paused, true, '超限后必须暂停请求流');

  const aborted = fakeRequest();
  const pa = readJsonBody(aborted);
  aborted.emit('aborted');
  await assert.rejects(pa, (error) => error.statusCode === 400 && /中断/.test(error.message));
});

test('sendJsonResponse：统一 2 空格 JSON 与安全响应头', () => {
  const calls = [];
  const res = {
    writeHead(status, headers) { calls.push({ status, headers }); },
    end(body) { calls.push({ body }); }
  };
  sendJsonResponse(res, { ok: true, n: 1 }, 201);
  assert.equal(calls[0].status, 201);
  assert.match(calls[0].headers['content-type'], /application\/json/);
  assert.equal(calls[0].headers['X-Frame-Options'], 'DENY');
  assert.equal(calls[1].body, '{\n  "ok": true,\n  "n": 1\n}');
});
