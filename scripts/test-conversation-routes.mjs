import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationPolicyStore } from '../src/core/conversation-policy-store.js';
import { handleConversationRoutes } from '../src/http/conversation-routes.js';
import { authorizeAgentRequest } from '../src/route-policy.js';

const auth = { kind: 'console', authenticated: true };
const policy = { mode: 'closed-agent', preset: 'qsh-closed' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-policy-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createConversationPolicyStore({ file: path.join(dir, 'conversations.json') });
  const changes = [];
  const deps = { store, getLegacy: () => ({ mode: 'reserved2', ownerQQ: 42 }),
    getAvailablePresets: () => ['qsh-sim', 'qsh-sim-v2', 'qsh-closed'], onChanged: (result) => changes.push(result) };
  async function call(method, endpoint, body, extra = {}) {
    let response;
    const handled = await handleConversationRoutes({ req: { method, headers: {}, ...extra.req },
      url: new URL(endpoint, 'http://fixture'), readBody: async () => body,
      sendJson: (data, status = 200) => { response = { status, data }; }, auth, deps, ...extra });
    return { handled, ...response };
  }
  return { call, store, deps, changes };
}

test('migration derives legacy mode/owner from runtime, ignores forged identity and mode in body', async (t) => {
  const h = fixture(t);
  const response = await h.call('POST', '/api/conversations/migrate', { ownerQQ: 99, mode: 'closed-agent', updatedBy: 'attacker' });
  assert.equal(response.status, 200);
  assert.deepEqual(h.store.snapshot().legacy, { mode: 'reserved2', ownerQQ: 42 });
  assert.equal(h.store.policyFor('private:42').mode, 'simulation');
  assert.equal(h.store.snapshot().audit[0].updatedBy, 'console');
  assert.equal(h.changes.length, 1);
});

test('set/delete policy and rollback return durable changes before runtime callback', async (t) => {
  const h = fixture(t);
  await h.call('POST', '/api/conversations/migrate');
  h.deps.onChanged = () => { assert.equal(h.store.snapshot().revision >= 2, true); };
  const set = await h.call('POST', '/api/conversations/policy', { key: 'private:42', policy });
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.result.changedKeys, ['private:42']);
  assert.equal((await h.call('DELETE', '/api/conversations/policy?key=private:42')).status, 200);
  assert.equal(h.store.policyFor('private:42').mode, 'simulation');
  assert.equal((await h.call('POST', '/api/conversations/rollback')).status, 200);
  assert.equal(h.store.enabled, false);
});

test('missing/unloaded preset prevents migration and edits without an audit commit', async (t) => {
  const h = fixture(t);
  h.deps.getAvailablePresets = () => [];
  assert.equal((await h.call('POST', '/api/conversations/migrate')).status, 409);
  assert.equal(h.store.snapshot(), null);
  h.deps.getAvailablePresets = () => ['qsh-sim'];
  assert.equal((await h.call('POST', '/api/conversations/migrate')).status, 200);
  assert.equal((await h.call('POST', '/api/conversations/policy', { key: 'private:42', policy })).status, 409);
  assert.equal(h.store.snapshot().revision, 1);
});

test('agent markers, missing authentication and non-console contexts cannot access any route', async (t) => {
  const h = fixture(t);
  for (const endpoint of ['/api/conversations', '/api/conversations/migrate', '/api/conversations/policy', '/api/conversations/rollback']) {
    for (const extra of [{ auth: undefined }, { auth: { kind: 'console' } },
      { auth: { kind: 'qq', authenticated: true, senderId: 42, conversationKey: 'private:42' } },
      { req: { method: 'POST', headers: { 'x-agent-call': '1' } } },
      { req: { method: 'POST', headers: { 'x-agent-token': 'fixture' } } }]) {
      assert.equal((await h.call('POST', endpoint, { auth, updatedBy: 'console' }, extra)).status, 403);
    }
    assert.equal(authorizeAgentRequest({ method: 'POST', pathname: endpoint,
      headers: { 'x-agent-token': 'fixture' }, isLiveAgentToken: () => true }).ok, false);
    assert.equal(authorizeAgentRequest({ method: 'POST', pathname: endpoint,
      headers: { 'x-agent-call': '1' }, mode: 'closed-agent' }).ok, false);
  }
  assert.equal(h.store.snapshot(), null);
});

test('state retrieval is explicit about disabled routing; unknown/mismatched methods cannot mutate', async (t) => {
  const h = fixture(t);
  const response = await h.call('GET', '/api/conversations');
  assert.equal(response.data.enabled, false);
  assert.equal(response.data.document, null);
  assert.equal((await h.call('GET', '/api/conversations/migrate')).status, 405);
  assert.equal((await h.call('POST', '/not-conversation')).handled, false);
});

test('runtime apply failure reports that the durable policy was committed and needs restart', async (t) => {
  const h = fixture(t);
  h.deps.onChanged = () => { throw new Error('runtime rejected'); };
  const response = await h.call('POST', '/api/conversations/migrate');
  assert.equal(response.status, 500);
  assert.equal(response.data.committed, true);
  assert.equal(response.data.requiresRestart, true);
  assert.equal(h.store.enabled, true);
  assert.equal(h.store.snapshot().revision, 1);
});

test('disk failure is a server error and cannot activate a policy or invoke the runtime callback', async (t) => {
  const h = fixture(t);
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('injected policy write failure'), { code: 'EIO' }); };
  try {
    const response = await h.call('POST', '/api/conversations/migrate');
    assert.equal(response.status, 500);
    assert.equal(response.data.committed, false);
    assert.equal(h.store.enabled, false);
    assert.equal(h.changes.length, 0);
  } finally { fs.renameSync = originalRename; }
  assert.equal((await h.call('POST', '/api/conversations/migrate')).status, 200);
});
