import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationPolicyStore, policyOperator } from '../src/core/conversation-policy-store.js';

const consoleAuth = { kind: 'console', authenticated: true };
const ownerAuth = { kind: 'qq', authenticated: true, conversationKey: 'private:42', senderId: 42 };
const simulation = { mode: 'simulation', preset: 'qsh-sim' };
function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'conversations.json');
  if (initial !== undefined) fs.writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  const open = (options = {}) => createConversationPolicyStore({ file, now: () => 1234, ...options });
  return { file, open, store: open() };
}

test('missing state does not silently enable owner execution or create a file', (t) => {
  const h = fixture(t);
  assert.equal(h.store.enabled, false);
  assert.equal(h.store.writable, true);
  assert.equal(h.store.snapshot(), null);
  assert.equal(fs.existsSync(h.file), false);
  assert.throws(() => h.store.policyFor('private:42'), /尚未启用/);
});

test('migration persists policy and provenance together and survives reload', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'closed-agent', ownerQQ: 42 }, consoleAuth);
  const loaded = h.open();
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.policyFor('private:42').mode, 'closed-agent');
  assert.equal(loaded.policyFor('group:8').mode, 'simulation');
  const saved = JSON.parse(fs.readFileSync(h.file));
  assert.equal(saved.audit[0].updatedBy, 'console');
  assert.equal(saved.audit[0].type, 'routing-migrated');
  assert.deepEqual(saved.legacy, { mode: 'closed-agent', ownerQQ: 42 });
  assert.equal(saved.revision, 1);
  assert.throws(() => h.store.migrate({ mode: 'chat', ownerQQ: 42 }, consoleAuth), /重复迁移/);
});

for (const mode of ['chat', 'reserved', 'reserved2']) {
  test(`${mode} migration keeps owner unprivileged until an explicit policy change`, (t) => {
    const h = fixture(t);
    h.store.migrate({ mode, ownerQQ: 42 }, consoleAuth);
    assert.equal(h.store.policyFor('private:42').mode, 'simulation');
    assert.equal(h.store.snapshot().audit[0].events[0].from, mode);
  });
}

test('editing one policy reports only that conversation; payload cannot forge audit identity', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'reserved2', ownerQQ: 42 }, consoleAuth);
  const groupBefore = h.store.policyFingerprint('group:8');
  const result = h.store.update('private:42', { mode: 'closed-agent', preset: 'qsh-closed', updatedBy: 'attacker' }, ownerAuth);
  assert.deepEqual(result.changedKeys, ['private:42']);
  assert.equal(h.store.policyFingerprint('group:8'), groupBefore);
  assert.equal(h.store.snapshot().audit[1].updatedBy, 'command:private:42');
  assert.deepEqual(result.auditEvent, h.store.snapshot().audit[1]);
  assert.equal(h.open().policyFor('private:42').preset, 'qsh-closed');
});

test('metadata-only edit is audited without rebuilding a session', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'reserved2', ownerQQ: 42 }, consoleAuth);
  h.store.update('group:8', simulation, consoleAuth);
  assert.deepEqual(h.store.update('group:8', simulation, ownerAuth).changedKeys, []);
  assert.equal(h.store.snapshot().revision, 3);
});

test('owner change revokes old private execution, preserves group policy, and never grants the new owner implicitly', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'closed-agent', ownerQQ: 42 }, consoleAuth);
  h.store.update('group:8', { ...simulation, model: 'group-model' }, ownerAuth);
  const before = h.store.policyFingerprint('group:8');
  assert.deepEqual(h.store.reconcileOwner(99, consoleAuth).changedKeys, ['private:42']);
  assert.equal(h.store.policyFor('private:42').mode, 'simulation');
  assert.equal(h.store.policyFor('private:99').mode, 'simulation');
  assert.equal(h.open().policyFingerprint('group:8'), before);
  assert.throws(() => h.store.update('group:8', simulation, ownerAuth), /本人私聊/);
  assert.equal(h.store.snapshot().audit.at(-1).before.conversations['group:8'].updatedBy, 'command:private:42');
  assert.deepEqual(h.store.reconcileOwner(99, consoleAuth), { changedKeys: [] });
});

test('policy removal returns to safe defaults and is audited', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'closed-agent', ownerQQ: 42 }, consoleAuth);
  assert.deepEqual(h.store.remove('private:42', ownerAuth).changedKeys, ['private:42']);
  assert.equal(h.store.policyFor('private:42').mode, 'simulation');
  assert.equal(h.store.snapshot().audit.at(-1).type, 'conversation-deleted');
});

test('rollback disables routing and returns the untouched legacy snapshot; later migration retains history', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'reserved', ownerQQ: 42 }, consoleAuth);
  assert.deepEqual(h.store.rollback(consoleAuth), { mode: 'reserved', ownerQQ: 42 });
  assert.equal(h.open().enabled, false);
  assert.throws(() => h.store.policyFor('group:8'), /尚未启用/);
  h.store.migrate({ mode: 'reserved2', ownerQQ: 42 }, ownerAuth);
  assert.deepEqual(h.store.snapshot().audit.map((v) => v.type), ['routing-migrated', 'routing-rolled-back', 'routing-migrated']);
});

test('only authenticated console or actual owner private transport can change policy', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'reserved2', ownerQQ: 42 }, consoleAuth);
  const before = fs.readFileSync(h.file, 'utf8');
  for (const auth of [undefined, { kind: 'console' }, { kind: 'agent', authenticated: true },
    { kind: 'qq', authenticated: true, conversationKey: 'group:8', senderId: 42 },
    { kind: 'qq', authenticated: true, conversationKey: 'private:42', senderId: 99 },
    { kind: 'qq', authenticated: true, conversationKey: 'private:99', senderId: 42 }]) {
    assert.throws(() => h.store.update('private:42', { mode: 'closed-agent', preset: 'qsh-closed' }, auth), /操作者|本人私聊/);
    assert.throws(() => h.store.remove('private:42', auth));
    assert.throws(() => h.store.rollback(auth));
  }
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  assert.equal(policyOperator(ownerAuth, '42'), 'command:private:42');
});

test('a valid operator still cannot give a group or another private chat local tools', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'reserved2', ownerQQ: 42 }, consoleAuth);
  for (const key of ['group:8', 'private:99']) {
    assert.throws(() => h.store.update(key, { mode: 'closed-agent', preset: 'qsh-closed' }, consoleAuth), /restricted to the owner/);
  }
  assert.equal(h.store.snapshot().revision, 1);
});

for (const broken of ['', '{broken', 'null', '[]', '{"version":2}']) {
  test(`corrupt state ${JSON.stringify(broken)} cannot be replaced by migration`, (t) => {
    const h = fixture(t, broken);
    assert.equal(h.store.enabled, false);
    assert.equal(h.store.writable, false);
    assert.throws(() => h.store.migrate({ mode: 'closed-agent', ownerQQ: 42 }, consoleAuth));
    assert.equal(fs.readFileSync(h.file, 'utf8'), broken);
  });
}

test('external edit blocks both policy and audit publication', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'reserved2', ownerQQ: 42 }, consoleAuth);
  const before = h.store.snapshot();
  fs.appendFileSync(h.file, ' ');
  assert.throws(() => h.store.update('private:42', { mode: 'closed-agent', preset: 'qsh-closed' }, consoleAuth), /其它进程/);
  assert.deepEqual(h.store.snapshot(), before);
  assert.equal(h.store.policyFor('private:42').mode, 'simulation');
});

test('missing or malformed audit prevents loading even an otherwise valid privileged policy', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'closed-agent', ownerQQ: 42 }, consoleAuth);
  const valid = h.store.snapshot();
  for (const damage of [
    (value) => { delete value.audit; },
    (value) => { value.revision++; },
    (value) => { value.audit[0].seq = 0; },
    (value) => { value.audit[0].at = null; },
    (value) => { value.ownerQQ = 99; },
  ]) {
    const value = structuredClone(valid); damage(value);
    const text = JSON.stringify(value);
    fs.writeFileSync(h.file, text);
    const loaded = h.open();
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.writable, false);
    assert.equal(fs.readFileSync(h.file, 'utf8'), text);
  }
});

test('failed atomic replacement does not publish memory or audit and can be retried', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'reserved2', ownerQQ: 42 }, consoleAuth);
  const before = h.store.snapshot();
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === h.file) throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
    return originalRename(source, target);
  };
  try {
    assert.throws(() => h.store.update('private:42', { mode: 'closed-agent', preset: 'qsh-closed' }, consoleAuth), /disk failure/);
    assert.deepEqual(h.store.snapshot(), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.file)), before);
  } finally { fs.renameSync = originalRename; }
  assert.equal(h.store.writable, true);
  h.store.update('private:42', { mode: 'closed-agent', preset: 'qsh-closed' }, consoleAuth);
  assert.equal(h.store.snapshot().revision, 2);
});

test('invalid clock rejects a change without publishing a new policy or audit', (t) => {
  const h = fixture(t);
  h.store.migrate({ mode: 'reserved2', ownerQQ: 42 }, consoleAuth);
  const loaded = h.open({ now: () => NaN });
  assert.throws(() => loaded.update('private:42', { mode: 'closed-agent', preset: 'qsh-closed' }, consoleAuth), /审计时间/);
  assert.equal(loaded.snapshot().revision, 1);
});
