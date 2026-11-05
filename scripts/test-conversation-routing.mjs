import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ownerPolicy = { mode: 'closed-agent', preset: 'qsh-closed' };
const presets = ['qq-chat', 'qq-chat-v2', 'qsh-sim', 'qsh-sim-v2', 'qsh-closed'];
async function setup(t, options = {}) {
  const h = await bridgeHarness({ config: { allow: { groups: ['456', '789'], private: ['123'] }, sendDelayMs: 0 }, ...options });
  t.after(() => h.close());
  h.setPresets(presets);
  h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: presets.map((id) => ({ id })) } } }) };
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function call(method, endpoint, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: endpoint, method,
        headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...headers } }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
      });
      req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('fixture timeout')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function migrate(mode = 'reserved2') {
    h.setMode(mode);
    const result = await call('POST', '/api/conversations/migrate');
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  async function setPolicy(key, policy) {
    const result = await call('POST', '/api/conversations/policy', { key, policy });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  return { h, call, migrate, setPolicy };
}

test('real HTTP migration allows group simulation and owner execution simultaneously with explicit safe presets', async (t) => {
  const { h, migrate, setPolicy } = await setup(t);
  await migrate(); await setPolicy('private:123', ownerPolicy);
  const [group, owner] = await Promise.all([h.ensureSession('group:456'), h.ensureSession('private:123')]);
  assert.notEqual(group, owner);
  assert.equal(h.runtimeMode('group:456'), 'reserved2');
  assert.equal(h.runtimeMode('private:123'), 'closed-agent');
  assert.deepEqual(h.calls.created.map((v) => v.agentPreset).sort(), ['qsh-closed', 'qsh-sim']);
  assert.equal(h.isSessionAllowedInCurrentMode('private:999'), false);
});

test('a one-conversation edit retires only that mapping/token; metadata-only edit rebuilds none', async (t) => {
  const { h, migrate, setPolicy } = await setup(t);
  await migrate();
  const group = await h.ensureSession('group:456');
  await h.ensureSession('private:123');
  const token = h.getSocialV2State('group:456').agentToken;
  const timer = setTimeout(() => {}, 60000); timer.unref(); t.after(() => clearTimeout(timer));
  h.getSocialV2State('group:456').replyCheckTimer = timer;
  await setPolicy('private:123', ownerPolicy);
  assert.equal(h.state.sessions['group:456'], group);
  assert.equal(h.getSocialV2State('group:456').agentToken, token);
  assert.equal(h.getSocialV2State('group:456').replyCheckTimer, timer);
  assert.equal(h.state.sessions['private:123'], undefined);
  const owner = await h.ensureSession('private:123');
  await setPolicy('private:123', ownerPolicy);
  assert.equal(h.state.sessions['private:123'], owner);
  assert.equal(h.calls.created.length, 3);
});

test('model and effort override reach DSH only for their conversation', async (t) => {
  const { h, migrate, setPolicy } = await setup(t);
  await migrate();
  const selected = [];
  h.api.callUnary = async () => ({ result: { ok: true, value: { groups: [{ id: 'deepseek-official', models: [{ id: 'owner-model', reasoning: { efforts: [{ id: 'high' }] } }] }] } } });
  h.api.sessions.selectModel = async (params) => { selected.push(params); return { result: { ok: true, value: { selected: params } } }; };
  await setPolicy('private:123', { ...ownerPolicy, model: 'owner-model', reasoningEffort: 'high' });
  const owner = await h.ensureSession('private:123');
  const group = await h.ensureSession('group:456');
  assert.equal(selected.find((v) => v.sessionId === owner).model, 'owner-model');
  assert.equal(selected.find((v) => v.sessionId === owner).reasoningEffort, 'high');
  assert.equal(selected.find((v) => v.sessionId === group).model, h.cfg.dsh.model);
});

test('group agent authorization resolves its own policy while legacy/global mode is closed-agent', async (t) => {
  const { h, call, migrate } = await setup(t);
  await migrate('closed-agent');
  await h.ensureSession('group:456');
  const token = h.getSocialV2State('group:456').agentToken;
  const headers = { 'x-agent-token': token, 'x-agent-call': '1' };
  assert.equal((await call('GET', '/api/socialV2/state?key=group:456', undefined, headers)).status, 200);
  assert.equal((await call('GET', '/api/socialV2/state?key=group:789', undefined, headers)).status, 403);
  assert.equal((await call('POST', '/api/conversations/rollback', {}, headers)).status, 403);
  assert.equal((await call('POST', '/api/conversations/rollback', {}, { 'x-agent-call': '1' })).status, 403);
  const status = await call('GET', '/api/status', undefined, headers);
  assert.equal(status.data.mode, 'reserved2');
  assert.equal(status.data.ownerQQ, undefined);
});

test('corrupt policy state blocks privileged fallback and is not replaced by migration', async (t) => {
  const { h, call } = await setup(t, { files: { 'state/conversations.json': '{broken' } });
  h.setMode('closed-agent');
  await assert.rejects(h.ensureSession('private:123'), /不允许/);
  assert.equal(h.calls.created.length, 0);
  assert.equal((await call('POST', '/api/conversations/migrate')).status, 503);
});

test('routed owner creation never falls back when its named preset disappears', async (t) => {
  const { h, migrate, setPolicy } = await setup(t);
  await migrate(); await setPolicy('private:123', ownerPolicy);
  h.setPresets(['qsh-sim']);
  await assert.rejects(h.ensureSession('private:123'), /qsh-closed/);
  assert.equal(h.calls.created.length, 0);
});

test('owner change revokes old private execution while preserving group mapping and token', async (t) => {
  const { h, migrate } = await setup(t);
  await migrate('closed-agent');
  const group = await h.ensureSession('group:456');
  await h.ensureSession('private:123');
  const token = h.getSocialV2State('group:456').agentToken;
  h.cfg.ownerQQ = 999;
  h.reconcileSessionPolicies();
  assert.equal(h.state.sessions['private:123'], undefined);
  assert.equal(h.state.sessions['group:456'], group);
  assert.equal(h.getSocialV2State('group:456').agentToken, token);
  assert.equal(h.runtimeMode('private:999'), 'reserved2');
});

test('legacy setting changes cannot replace routed policy; explicit rollback restores legacy behavior', async (t) => {
  const { h, call, migrate, setPolicy } = await setup(t);
  await migrate(); await setPolicy('private:123', ownerPolicy);
  const group = await h.ensureSession('group:456');
  h.setMode('chat'); h.reconcileSessionPolicies();
  assert.equal(h.state.sessions['group:456'], group);
  assert.equal(h.runtimeMode('private:123'), 'closed-agent');
  assert.equal((await call('POST', '/api/mode', { mode: 'chat' })).status, 409);
  assert.equal((await call('POST', '/api/conversations/rollback')).status, 200);
  assert.equal(h.runtimeMode('private:123'), 'chat');
  assert.equal(h.state.sessions['group:456'], undefined);
});

test('real event stream forwards owner replies while simulation internal text stays private', async (t) => {
  const { h, migrate } = await setup(t);
  await migrate('closed-agent');
  const group = await h.ensureSession('group:456'), owner = await h.ensureSession('private:123');
  h.setReady(true);
  h.setQqOnline(true);
  await h.deliverPrompt('group:456', 'group input');
  await h.deliverPrompt('private:123', 'owner input');
  await h.deliverPrompt('private:123', 'second owner input');
  const fragment = h.getSocialV2State('group:456').agentToken.slice(0, 16);
  const controller = new AbortController();
  h.api.events.mux = async function* () {
    for (const [sessionId, text, offset] of [[group, 'simulation internal secret', 0],
      [owner, 'owner reply', 0], [owner, `token fragment ${fragment}`, 4]]) {
      const turn = offset;
      const requestId = h.calls.prompts.filter((prompt) => prompt.sessionId === sessionId)[offset ? 1 : 0].requestId;
      for (const [seq, event] of [
        { type: 'turn/start', data: { turn } },
        { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } },
        { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      ].entries()) yield { payload: { type: 'session/event', sessionId, event: { ...event, seq: seq + offset } } };
    }
    controller.abort();
  };
  await h.pumpMux({ signal: controller.signal });
  await h.outbound.flush();
  const sent = h.calls.http.filter(({ url }) => /\/send_(private|group)_msg$/.test(url));
  assert.deepEqual(sent.map(({ body }) => [body.user_id, body.message[0].data.text]), [[123, 'owner reply']]);
  assert.deepEqual(h.calls.sent, []);
  assert.equal(h.outbound.snapshot().entries[JSON.stringify([owner, '4'])].reason, 'audit-blocked');
});

test('a lost DSH acknowledgement is reconciled from paged history and the reply waits for QQ', async (t) => {
  const { h, migrate, call } = await setup(t);
  await migrate('closed-agent');
  h.setReady(true);
  h.setQqOnline(false);
  const key = 'private:123';
  const sessionId = await h.ensureSession(key);
  const original = h.api.sessions.prompt;
  h.api.sessions.prompt = async (params) => {
    await original(params);
    throw new Error('connection lost after submission');
  };
  const first = await h.deliverPrompt(key, 'first');
  assert.equal(first.uncertain, true);
  const review = await call('GET', '/api/delivery');
  assert.equal(review.status, 200);
  assert.deepEqual(review.data.submissions.map(({ requestId }) => requestId), [first.requestId]);
  assert.equal((await call('GET', '/api/delivery', undefined, { 'x-agent-call': '1' })).status, 403);
  h.api.sessions.prompt = original;
  assert.equal((await h.deliverPrompt(key, 'second')).queued, true);
  assert.equal(h.calls.prompts.length, 1);
  const records = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user', rpcId: first.requestId } } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'recovered reply' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ type: 'event', event: { ...event, seq } }));
  h.api.readSessionHistoryPage = async (id, request) => {
    assert.equal(id, sessionId);
    assert.equal(request.throughSeq, 3);
    assert.equal(request.beforeSeq, 2);
    return { records: records.slice(0, 2), hasMore: false };
  };
  const replay = async () => {
    const controller = new AbortController();
    h.api.events.mux = async function* () {
      yield { payload: { type: 'session/snapshot', sessionId,
        snapshot: { cursor: 3, hasMore: true, records: records.slice(2) } } };
      controller.abort();
    };
    await h.pumpMux({ signal: controller.signal });
    await h.recoveryQueue.enqueue(sessionId, () => {});
    await h.flushQueue();
    await h.outbound.flush();
  };
  const sent = () => h.calls.http.filter(({ url }) => url.endsWith('/send_private_msg'));
  await replay();
  assert.equal(h.calls.prompts.length, 2);
  assert.equal((await call('GET', '/api/delivery')).data.submissions.length, 0);
  assert.equal(sent().length, 0);
  h.setQqOnline(true);
  await replay();
  await replay();
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].body.message[0].data.text, 'recovered reply');
  assert.equal(h.outbound.snapshot().entries[JSON.stringify([sessionId, '1'])].parts[0].messageId, '9001');
});

test('resetting one mapped conversation cannot invalidate another in-flight creation', async (t) => {
  const { h, call, migrate } = await setup(t);
  await migrate('closed-agent');
  await h.ensureSession('private:123');
  let release, entered;
  const began = new Promise((resolve) => { entered = resolve; });
  const original = h.api.sessions.create;
  h.api.sessions.create = async (...args) => { entered(); await new Promise((resolve) => { release = resolve; }); return original(...args); };
  const creating = h.ensureSession('group:456');
  await began;
  assert.equal((await call('POST', '/api/session/reset', { key: 'private:123' })).status, 200);
  release(); assert.ok(await creating);
});

test('simulation reset does not delete or interrupt the closed owner conversation', async (t) => {
  const { h, call, migrate } = await setup(t);
  await migrate('closed-agent');
  await h.ensureSession('group:456');
  const owner = await h.ensureSession('private:123');
  h.getSocialV2State('group:456');
  // The owner may retain an old simulation state after changing mode.
  h.getSocialV2State('private:123');
  assert.equal((await call('POST', '/api/socialV2/reset', {})).status, 200);
  assert.equal(h.state.sessions['private:123'], owner);
  assert.equal(h.state.sessions['group:456'], undefined);
  assert.equal(h.calls.cancelled.includes(owner), false);
});

test('unknown model/unsupported effort is rejected before policy or audit changes', async (t) => {
  const { h, call, migrate } = await setup(t);
  await migrate();
  const revision = h.conversationPolicies.snapshot().revision;
  const response = await call('POST', '/api/conversations/policy', { key: 'private:123', policy: { ...ownerPolicy, model: 'unknown' } });
  assert.equal(response.status, 400);
  assert.equal(h.conversationPolicies.snapshot().revision, revision);
});

test('owner input still dispatches when simulation is disabled; the group cannot dispatch through that channel', async (t) => {
  const { h, migrate } = await setup(t);
  await migrate('closed-agent');
  h.cfg.socialV2.enabled = false;
  await Promise.all([
    h.handleIncoming('private', '123', { user_id: 123, message: 'owner request', message_id: 1001 }, h.cfg),
    h.handleIncoming('group', '456', { user_id: 222, message: 'group request', message_id: 1002 }, h.cfg),
  ]);
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.calls.prompts[0].sessionId, h.state.sessions['private:123']);
});

test('wake dispatch uses the target policy even when the legacy global mode is closed-agent', async (t) => {
  const { h, migrate } = await setup(t);
  await migrate('closed-agent');
  h.getSocialV2State('group:456');
  await h.sendWakePromptV2('group:456', 'admin');
  assert.equal(h.calls.prompts.length, 1);
  await h.sendWakePromptV2('private:123', 'admin');
  assert.equal(h.calls.prompts.length, 1);
});

test('preset catalogue outage cannot be bypassed with stale migration data', async (t) => {
  const { h, call } = await setup(t);
  h.api.agentPresets.list = async () => { throw new Error('catalogue offline'); };
  const result = await call('POST', '/api/conversations/migrate');
  assert.equal(result.status, 409);
  assert.equal(h.conversationPolicies.enabled, false);
});

test('persisted routing and session fingerprints reload without reverting to process-global chat', async (t) => {
  const first = await setup(t);
  await first.migrate('closed-agent');
  const group = await first.h.ensureSession('group:456');
  const owner = await first.h.ensureSession('private:123');
  const second = await setup(t, { savedState: first.h.state,
    files: { 'state/conversations.json': first.h.conversationPolicies.snapshot() } });
  assert.equal(second.h.runtimeMode('private:123'), 'closed-agent');
  assert.equal(second.h.runtimeMode('group:456'), 'reserved2');
  assert.equal(await second.h.ensureSession('group:456'), group);
  assert.equal(await second.h.ensureSession('private:123'), owner);
  assert.equal(second.h.calls.created.length, 0);
});

test('a saved explicit model policy cannot silently dispatch using a fallback after catalogue removal', async (t) => {
  const { h, migrate, setPolicy } = await setup(t);
  await migrate();
  h.api.callUnary = async () => ({ result: { ok: true, value: { groups: [{ id: 'deepseek-official', models: [{ id: 'owner-model' }] }] } } });
  await setPolicy('private:123', { ...ownerPolicy, model: 'owner-model' });
  h.api.callUnary = async () => ({ result: { ok: true, value: { groups: [] } } });
  await assert.rejects(h.deliverPrompt('private:123', 'must not dispatch'), /模型策略/);
  assert.equal(h.calls.prompts.length, 0);
});
