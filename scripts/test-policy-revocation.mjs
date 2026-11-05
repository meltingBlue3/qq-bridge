// Exercise real bridge policy transitions against temporary files and a fake QQ/DSH gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function withBridge(run) {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456', '789'] } } });
  try { await run(h); } finally { await h.close(); }
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function call(port, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token,
        'x-agent-call': '1', 'content-type': 'application/json' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('fixture HTTP timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('catalogue outage alone preserves permitted sessions and tokens', async () => withBridge(async (h) => {
  h.setMode('reserved2');
  const id = await h.ensureSession('group:456');
  const st = h.getSocialV2State('group:456');
  const token = st.agentToken;
  const cancellations = h.calls.cancelled.length;
  h.setPresets([]);
  h.reconcileSessionPolicies();
  assert.equal(h.state.sessions['group:456'], id);
  assert.equal(st.agentToken, token);
  assert.equal(h.calls.cancelled.length, cancellations);
}));

for (const [name, mode, key, revoke] of [
  ['mode change', 'closed-agent', 'private:123', (h) => h.setMode('chat')],
  ['owner change', 'closed-agent', 'private:123', (h) => { h.cfg.ownerQQ = 999; }],
  ['allowlist removal', 'reserved2', 'group:456', (h) => { h.cfg.allow.groups = ['789']; }],
  ['denylist addition', 'reserved2', 'group:456', (h) => { h.cfg.deny.groups = ['456']; }],
]) {
  test(`${name} revokes mappings, tokens and timers even without a preset catalogue`, async () => withBridge(async (h) => {
    h.setMode(mode);
    const id = await h.ensureSession(key);
    const st = h.getSocialV2State(key);
    const token = st.agentToken;
    const timer = setTimeout(() => assert.fail('revoked wake timer fired'), 30000);
    timer.unref();
    st.sleepTimer = timer;
    try {
      h.setPresets([]);
      revoke(h);
      h.reconcileSessionPolicies();
      assert.equal(h.state.sessions[key], undefined);
      assert.equal(h.state.sessionPolicies[key], undefined);
      assert.notEqual(st.agentToken, token);
      assert.ok(h.KNOWN_AGENT_TOKENS.has(token), 'the revoked token must remain available for redaction');
      assert.equal(st.sleepTimer, null);
      assert.ok(h.calls.cancelled.includes(id));
    } finally { clearTimeout(timer); }
  }));
}

test('a session token cannot read or send to another allowed conversation', async () => withBridge(async (h) => {
  h.setMode('reserved2');
  const token = h.getSocialV2State('group:456').agentToken;
  h.getSocialV2State('group:789');
  await withServer(h, async (port) => {
    assert.equal(await call(port, '/api/socialV2/state?key=group:456', token), 200);
    assert.equal(await call(port, '/api/socialV2/state?key=group:789', token), 403);
    assert.equal(await call(port, '/api/socialV2/send-message', token,
      { key: 'group:789', messages: ['must not leave the fixture'] }), 403);
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.calls.http.filter((c) => /\/send_/.test(c.url)).length, 0);
  });
}));

test('removed and re-added conversations reject the old token', async () => withBridge(async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  const st = h.getSocialV2State('group:456');
  const token = st.agentToken;
  h.setPresets([]);
  h.cfg.allow.groups = ['789'];
  h.reconcileSessionPolicies();
  h.cfg.allow.groups = ['456', '789'];
  await withServer(h, async (port) => {
    assert.equal(await call(port, '/api/socialV2/state?key=group:456', token), 403);
    assert.equal(await call(port, '/api/socialV2/state?key=group:456', st.agentToken), 200);
  });
}));

test('unmapped conversation state is revoked once and its old token cannot revive', async () => withBridge(async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  const token = st.agentToken;
  h.cfg.allow.groups = ['789'];
  h.reconcileSessionPolicies();
  assert.notEqual(st.agentToken, token);
  const rotated = st.agentToken;
  h.reconcileSessionPolicies();
  assert.equal(st.agentToken, rotated, 'polling must not keep issuing new tokens');
  h.cfg.allow.groups = ['456', '789'];
  h.reconcileSessionPolicies();
  await withServer(h, async (port) => {
    assert.equal(await call(port, '/api/socialV2/state?key=group:456', token), 403);
  });
  h.cfg.allow.groups = ['789'];
  h.reconcileSessionPolicies();
  assert.notEqual(st.agentToken, rotated, 'a second removal must revoke the replacement token too');
}));

test('queued AI sends are cancelled when mode changes before transport', async () => withBridge(async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  const sending = h.sendMessagesV2('group:456', ['queued fixture'], []);
  h.setMode('closed-agent');
  h.reconcileSessionPolicies();
  await assert.rejects(sending, /模式|会话|白名单/);
  assert.equal(h.calls.http.filter((c) => /\/send_/.test(c.url)).length, 0);
}));

test('permission changes discard queued prompts before a removed conversation can return', async () => withBridge(async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  h.api.sessions.prompt = async () => {
    began();
    await new Promise((resolve) => { release = resolve; });
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'in flight');
  await started;
  const second = h.deliverPrompt('group:456', 'stale queued data').then(() => null, (error) => error);
  try {
    h.cfg.allow.groups = ['789'];
    h.reconcileSessionPolicies();
    assert.equal(h.promptQueues.has('group:456'), false);
    h.cfg.allow.groups = ['456', '789'];
  } finally { release(); await first; }
  assert.match((await second)?.message ?? '', /权限已变化/);
}));

test('permission changes discard the offline retry backlog', async () => withBridge(async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  h.setReady(false);
  await h.deliverPrompt('group:456', 'offline fixture');
  assert.equal(h.queued.get('group:456').length, 1);
  h.cfg.allow.groups = ['789'];
  h.reconcileSessionPolicies();
  assert.equal(h.queued.has('group:456'), false);
}));

test('ordinary offline input without any session mapping is discarded on revocation', async () => withBridge(async (h) => {
  h.setMode('chat');
  h.setReady(false);
  h.cfg.sendDelayMs = 0;
  await h.handleIncoming('group', '456', { user_id: 111, group_id: 456, message: 'offline before creation' }, h.cfg);
  assert.equal(h.state.sessions['group:456'], undefined);
  assert.equal(h.queued.get('group:456').length, 1);
  h.cfg.allow.groups = ['789'];
  h.reconcileSessionPolicies();
  h.cfg.allow.groups = ['456', '789'];
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.queued.has('group:456'), false);
  assert.equal(h.calls.prompts.length, 0);
}));

test('revocation invalidates an unmapped in-flight creation even if access is restored before completion', async () => withBridge(async (h) => {
  h.setMode('reserved2');
  let began, release;
  const started = new Promise((resolve) => { began = resolve; });
  const originalCreate = h.api.sessions.create;
  h.api.sessions.create = async (...args) => {
    began();
    await new Promise((resolve) => { release = resolve; });
    return originalCreate(...args);
  };
  const creating = h.ensureSession('group:456');
  const rejected = assert.rejects(creating, /已重置或权限已变化/);
  await started;
  h.cfg.allow.groups = ['789'];
  h.reconcileSessionPolicies();
  h.cfg.allow.groups = ['456', '789'];
  release(); await rejected;
  assert.equal(h.state.sessions['group:456'], undefined);
  assert.equal(h.calls.follows.length, 0);
}));
