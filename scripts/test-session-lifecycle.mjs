import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLifecycle } from '../src/core/session-lifecycle.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const state = { sessions: {}, sessionPolicies: {} };
  const reverse = new Map();
  const pending = new Map();
  const calls = { create: [], follow: [], archived: [], retired: [], saved: 0 };
  let epoch = 0;
  let allowed = true;
  let sequence = 0;
  const plan = { policy: 'p1', mode: 'chat', preset: 'qq-chat', strictPreset: true, directory: '/fixture', missingPresetError: '缺少安全 preset' };
  const api = {
    workspace: { create: async () => ({ created: false, workspace: { workspaceId: 'ws' } }) },
    sessions: { create: async (params) => { calls.create.push(params); return { sessionId: `s${++sequence}` }; } },
    events: { follow: (id) => calls.follow.push(id) },
  };
  const hooks = { model: async () => 'ok' };
  const lifecycle = createSessionLifecycle({
    state, reverse, pending, api, unwrap: (v) => v,
    getEpoch: () => epoch, getPlan: () => ({ ...plan }), isAllowed: () => allowed,
    selectModel: (id) => hooks.model(id),
    retire: (key) => { calls.retired.push(key); reverse.delete(state.sessions[key]); delete state.sessions[key]; delete state.sessionPolicies[key]; },
    persist: () => { calls.saved++; }, archive: async (id) => { calls.archived.push(id); }, ensureDirectory: () => {},
  });
  return { ...lifecycle, state, reverse, pending, calls, plan, api, hooks, reset: () => { epoch++; pending.clear(); }, revoke: () => { allowed = false; } };
}

test('same-key concurrent creation single-flights; saved session is reused', async () => {
  const h = fixture();
  assert.deepEqual(await Promise.all([h.ensure('a'), h.ensure('a')]), ['s1', 's1']);
  assert.equal(await h.ensure('a'), 's1');
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.reverse.get('s1'), 'a');
  assert.equal(h.pending.size, 0);
});

test('a blocked conversation does not block another conversation', async () => {
  const h = fixture();
  const entered = deferred(), release = deferred();
  let count = 0;
  h.api.sessions.create = async () => { if (++count === 1) { entered.resolve(); await release.promise; return { sessionId: 'slow' }; } return { sessionId: 'fast' }; };
  const slow = h.ensure('a');
  await entered.promise;
  assert.equal(await h.ensure('b'), 'fast');
  release.resolve();
  assert.equal(await slow, 'slow');
});

test('strict preset absence/failure never falls back to default tools', async () => {
  const h = fixture();
  h.plan.preset = undefined;
  await assert.rejects(h.ensure('a'), /缺少安全 preset/);
  assert.equal(h.calls.create.length, 0);
  h.plan.preset = 'qq-chat';
  h.api.sessions.create = async (params) => { h.calls.create.push(params); throw new Error('unavailable'); };
  await assert.rejects(h.ensure('a'), /unavailable/);
  assert.deepEqual(h.calls.create, [{ workspaceId: 'ws', agentPreset: 'qq-chat' }]);
});

test('owner-only non-strict plan retains explicit preset fallback', async () => {
  const h = fixture();
  h.plan.strictPreset = false;
  h.plan.mode = 'closed-agent';
  h.api.sessions.create = async (params) => { h.calls.create.push(params); if (params.agentPreset) throw new Error('unavailable'); return { sessionId: 'fallback' }; };
  assert.equal(await h.ensure('a'), 'fallback');
  assert.deepEqual(h.calls.create, [{ workspaceId: 'ws', agentPreset: 'qq-chat' }, { workspaceId: 'ws' }]);
});

for (const change of ['reset', 'policy', 'revoke', 'invalidate']) {
  test(`${change} during creation archives stale result without following or persisting`, async () => {
    const h = fixture();
    const entered = deferred(), release = deferred();
    h.api.sessions.create = async () => { entered.resolve(); await release.promise; return { sessionId: 'old' }; };
    const result = h.ensure('a');
    const rejected = assert.rejects(result, /已重置或权限已变化/);
    await entered.promise;
    if (change === 'reset') h.reset();
    if (change === 'policy') h.plan.policy = 'p2';
    if (change === 'revoke') h.revoke();
    if (change === 'invalidate') h.pending.delete('a');
    release.resolve();
    await rejected;
    assert.deepEqual(h.calls.archived, ['old']);
    assert.deepEqual(h.calls.follow, []);
    assert.deepEqual(h.state.sessions, {});
    assert.equal(h.calls.saved, 0);
  });
}

test('reset before workspace completes prevents even submitting session creation', async () => {
  const h = fixture();
  const entered = deferred(), release = deferred();
  h.api.workspace.create = async () => { entered.resolve(); await release.promise; return { created: false, workspace: { workspaceId: 'ws' } }; };
  const rejected = assert.rejects(h.ensure('a'), /已重置/);
  await entered.promise;
  h.reset(); release.resolve();
  await rejected;
  assert.equal(h.calls.create.length, 0);
});

test('not-found model selection retires and rebuilds the mapped session', async () => {
  const h = fixture();
  h.state.sessions.a = 'missing'; h.state.sessionPolicies.a = 'p1';
  h.hooks.model = async (id) => id === 'missing' ? 'not-found' : 'ok';
  assert.equal(await h.ensure('a'), 's1');
  assert.deepEqual(h.calls.retired, ['a']);
});

test('late not-found model result cannot retire a replacement mapping', async () => {
  const h = fixture();
  h.state.sessions.a = 'old'; h.state.sessionPolicies.a = 'p1';
  const entered = deferred(), release = deferred();
  h.hooks.model = async () => { entered.resolve(); await release.promise; return 'not-found'; };
  const rejected = assert.rejects(h.ensure('a'), /已重置/);
  await entered.promise;
  h.state.sessions.a = 'replacement';
  release.resolve(); await rejected;
  assert.equal(h.state.sessions.a, 'replacement');
  assert.deepEqual(h.calls.retired, []);
});

test('old completion does not delete a replacement in-flight creation', async () => {
  const h = fixture();
  const entered = deferred(), release = deferred(), newerEntered = deferred(), newerRelease = deferred();
  let count = 0;
  h.api.sessions.create = async () => {
    if (++count === 1) { entered.resolve(); await release.promise; return { sessionId: 'old' }; }
    newerEntered.resolve(); await newerRelease.promise; return { sessionId: 'new' };
  };
  const rejected = assert.rejects(h.ensure('a'), /已重置/);
  await entered.promise; h.reset();
  const newer = h.ensure('a'); await newerEntered.promise;
  const replacementPromise = h.pending.get('a');
  release.resolve(); await rejected;
  assert.equal(h.pending.get('a'), replacementPromise);
  newerRelease.resolve(); assert.equal(await newer, 'new');
  assert.equal(h.state.sessions.a, 'new');
});
