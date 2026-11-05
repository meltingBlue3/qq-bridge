import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore, isJsonObject, updateJsonDocument } from '../src/json-store.js';
import { createSessionStateStore } from '../src/session-state.js';
import { createSlangStore } from '../src/slang-learner.js';
import { createStickerStore } from '../src/sticker-lib.js';
import { createInitialPromptStore } from '../src/initial-prompts.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function fixture(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-json-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  if (text !== undefined) fs.writeFileSync(file, text);
  const store = createJsonStore({ file, fallback: () => ({}), validate: isJsonObject });
  return { file, dir, store };
}

test('不存在的文件可创建；BOM 可加载；无变化保存不重写', (t) => {
  const h = fixture(t);
  assert.deepEqual(h.store.load(), {});
  assert.equal(h.store.save({ value: 1 }), true);
  const rename = t.mock.method(fs, 'renameSync');
  assert.equal(h.store.save({ value: 1 }), true);
  assert.equal(rename.mock.callCount(), 0);
  fs.writeFileSync(h.file, '\ufeff{"value":2}');
  assert.deepEqual(h.store.load(), { value: 2 });
});

test('写失败保留旧文档、清理临时文件，并可重试', (t) => {
  const h = fixture(t, '{"old":1}');
  h.store.load();
  const rename = fs.renameSync;
  let failing = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === h.file && failing) throw Object.assign(new Error('fixture disk error'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.equal(h.store.save({ next: 2 }), false);
  assert.equal(h.store.writable, true);
  assert.equal(fs.readFileSync(h.file, 'utf8'), '{"old":1}');
  assert.ok(!fs.readdirSync(h.dir).some((file) => file.endsWith('.tmp')));
  failing = false;
  assert.equal(h.store.save({ next: 2 }), true);
  assert.equal(h.store.lastError, null);
});

test('同长度且 mtime 相同的外部更新也会被发现；显式重载后可继续', (t) => {
  const h = fixture(t, '{"a":1}');
  h.store.load();
  const stat = fs.statSync(h.file);
  fs.writeFileSync(h.file, '{"b":2}');
  fs.utimesSync(h.file, stat.atime, stat.mtime);
  assert.equal(h.store.save({ a: 3 }), false);
  assert.equal(h.store.writable, false);
  assert.equal(fs.readFileSync(h.file, 'utf8'), '{"b":2}');
  assert.deepEqual(h.store.load(), { b: 2 });
  assert.equal(h.store.save({ b: 3 }), true);
});

test('读权限失败与文件不存在有别；读失败不允许保存', (t) => {
  const h = fixture(t, '{"keep":true}');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === h.file) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  assert.deepEqual(h.store.load(), {});
  assert.equal(h.store.writable, false);
  assert.equal(h.store.save({}), false);
  assert.equal(read(h.file, 'utf8'), '{"keep":true}');
});

test('局部更新保留未知字段，并拒绝更新期间出现的外部修改', (t) => {
  const h = fixture(t, '{"keep":{"nested":true},"a":1}');
  updateJsonDocument(h.file, (value) => ({ ...value, a: 2 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), { keep: { nested: true }, a: 2 });
  const external = '{"external":true}';
  assert.throws(() => updateJsonDocument(h.file, (value) => {
    fs.writeFileSync(h.file, external);
    return { ...value, a: 3 };
  }), /其它进程改写/);
  assert.equal(fs.readFileSync(h.file, 'utf8'), external);
});

for (const raw of ['{', '', 'null', '[]']) {
  test(`非法 JSON / 结构保留原文件且只读：${JSON.stringify(raw)}`, (t) => {
    const h = fixture(t, raw);
    h.store.load();
    assert.equal(h.store.writable, false);
    assert.equal(h.store.save({}), false);
    assert.equal(fs.readFileSync(h.file, 'utf8'), raw);
  });
}

for (const [name, create, value, bad] of [
  ['sessions', (file) => createSessionStateStore({ file }), { sessions: {}, sessionPolicies: {} }, '{"sessions":[]}'],
  ['slang', (file) => createSlangStore(file), [{ content: 'term' }], '{}'],
  ['stickers', (file) => createStickerStore(file), [{ id: 'sticker' }], '{}'],
]) {
  test(`${name} 使用同一只读保护并检测加载后的外部修改`, (t) => {
    const h = fixture(t, bad);
    const store = create(h.file);
    store.load();
    assert.equal(store.writable, false);
    assert.ok(!store.save(value));
    assert.equal(fs.readFileSync(h.file, 'utf8'), bad);
    fs.writeFileSync(h.file, JSON.stringify(value));
    store.load();
    fs.writeFileSync(h.file, bad);
    assert.ok(!store.save(value));
    assert.equal(fs.readFileSync(h.file, 'utf8'), bad);
  });
}

test('初始提示词写失败回滚内存，恢复后可再次保存', (t) => {
  const h = fixture(t);
  const store = createInitialPromptStore({ file: h.file, canonicalKey: (key) => key === 'group:1' ? key : null });
  store.load();
  assert.equal(store.set('group:1', 'original').ok, true);
  const rename = fs.renameSync;
  let failing = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === h.file && failing) throw Object.assign(new Error('disk error'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.equal(store.set('group:1', 'new').ok, false);
  assert.equal(store.get('group:1').text, 'original');
  failing = false;
  assert.equal(store.set('group:1', 'new').ok, true);
});

test('桥接初始化遇到结构错误的 sessions.json，后续建会话不得覆盖它', async () => {
  const raw = '{"sessions":[]}';
  const h = await bridgeHarness({ files: { 'state/sessions.json': raw } });
  try {
    await h.ensureSession('group:456');
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/sessions.json'), 'utf8'), raw);
  } finally { await h.close(); }
});
