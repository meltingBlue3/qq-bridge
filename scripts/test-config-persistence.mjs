// Real console routes, temporary config and fake upstreams only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const edits = [
  ['/api/whitelist', { allow: { groups: [456], private: [123] }, ownerQQ: 123 }],
  ['/api/security', { interceptNotify: false }],
  ['/api/dsh/effort', { reasoningEffort: 'high' }],
  ['/api/roles/limit', { maxInjectChars: 9000 }],
  ['/api/social', { triggerProbability: 0.2 }],
  ['/api/socialV2/config', { wake: { batchWindowMs: 1234 }, sticker: { collect: { maxPerHour: 7 } } }],
];

async function withConsole(run, files = {}) {
  const h = await bridgeHarness({ files, config: {
    futureSection: { keep: ['unknown', 0, false] },
    dsh: { authToken: 'fixture-only', futureDsh: 'keep' },
    role: { futureRole: 'keep' }, security: { futureSecurity: 'keep' },
    social: { futureSocial: 'keep' },
    socialV2: { wake: { futureWake: 'keep' }, sticker: { collect: { futureCollect: 'keep' } } },
  } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const configFile = path.join(h.temp, 'config.json');
  const post = async (endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
      method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ h, configFile, post }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

for (const [endpoint, body] of edits) {
  test(`${endpoint} 局部更新保留根级与嵌套未知配置`, async () => withConsole(async ({ configFile, post }) => {
    const result = await post(endpoint, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    const file = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.deepEqual(file.futureSection, { keep: ['unknown', 0, false] });
    assert.equal(file.dsh.futureDsh, 'keep');
    assert.equal(file.role.futureRole, 'keep');
    assert.equal(file.security.futureSecurity, 'keep');
    assert.equal(file.social.futureSocial, 'keep');
    assert.equal(file.socialV2.wake.futureWake, 'keep');
    assert.equal(file.socialV2.sticker.collect.futureCollect, 'keep');
  }));

  test(`${endpoint} 遇到损坏配置时不覆盖原文件`, async () => withConsole(async ({ configFile, post }) => {
    const raw = '{"broken":';
    fs.writeFileSync(configFile, raw);
    const result = await post(endpoint, body);
    assert.equal(result.status, 500);
    assert.equal(fs.readFileSync(configFile, 'utf8'), raw);
  }));
}

test('配置写失败时内存不提前生效；修复写入后可重试', async (t) => withConsole(async ({ h, configFile, post }) => {
  const original = fs.readFileSync(configFile, 'utf8');
  const old = h.cfg.role.maxInjectChars;
  const rename = fs.renameSync;
  let failing = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === configFile && failing) throw Object.assign(new Error('fixture IO failure'), { code: 'EIO' });
    return rename(from, to);
  });
  const failed = await post('/api/roles/limit', { maxInjectChars: 10000 });
  assert.equal(failed.status, 500);
  assert.equal(h.cfg.role.maxInjectChars, old);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  failing = false;
  assert.equal((await post('/api/roles/limit', { maxInjectChars: 10000 })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).role.maxInjectChars, 10000);
}));

for (const [file, endpoint, body] of [
  ['mode.json', '/api/mode', { mode: 'reserved2' }],
  ['current-role.json', '/api/role-mode', { mode: 'active' }],
  ['feedback.json', '/api/socialV2/feedback-clear', {}],
]) {
  test(`${file} 内容损坏时控制台不得覆盖原文件`, async () => withConsole(async ({ h, post }) => {
    const target = path.join(h.temp, 'state', file);
    fs.writeFileSync(target, '{broken');
    const result = await post(endpoint, body);
    assert.equal(result.status, 500);
    assert.equal(fs.readFileSync(target, 'utf8'), '{broken');
  }));
}

test('二代重置通过同一存储实例保存，重置后新消息仍能持久化', async () => withConsole(async ({ h, post }) => {
  h.setMode('reserved2');
  const first = h.getSocialV2State('group:456');
  first.lastWakeReason = 'before-reset';
  h.appendSocialV2Message('group:456', 'fixture', 'first', 'first', false, false, 'id-1');
  assert.equal((await post('/api/socialV2/reset', {})).status, 200);
  h.appendSocialV2Message('group:456', 'fixture', 'second', 'second', false, false, 'id-2');
  const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
  assert.equal(saved.conversations['group:456'].recentMessages.length, 1);
  assert.equal(saved.conversations['group:456'].recentMessages[0].text, 'second');
}));

test('模式设置保留未知字段；损坏的角色状态保持静默', async () => withConsole(async ({ h, post }) => {
  const target = path.join(h.temp, 'state/mode.json');
  fs.writeFileSync(target, JSON.stringify({ mode: 'chat', future: { keep: true } }));
  assert.equal((await post('/api/mode', { mode: 'reserved2' })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).future, { keep: true });
  fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), '{broken');
  await assert.rejects(h.sendMessagesV2('group:456', ['must stay silent'], []), /静默/);
}));

test('黑话新增写失败不报成功，回滚后同词可以重试', async (t) => withConsole(async ({ h, post }) => {
  const target = path.join(h.temp, 'state/slang.json');
  const rename = fs.renameSync;
  let failing = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target && failing) throw Object.assign(new Error('fixture disk error'), { code: 'EIO' });
    return rename(from, to);
  });
  const payload = { content: 'fixture-slang', meaning: 'fixture' };
  assert.equal((await post('/api/slang', payload)).status, 500);
  assert.equal(fs.existsSync(target), false);
  failing = false;
  assert.equal((await post('/api/slang', payload)).status, 200, 'failed entry must not remain as a duplicate');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8'))[0].content, payload.content);
}));

test('表情本地备注写失败回滚内存，后续更新保留旧备注', async (t) => withConsole(async ({ h, post }) => {
  const target = path.join(h.temp, 'state/stickers.json');
  const original = fs.readFileSync(target, 'utf8');
  const rename = fs.renameSync;
  let failing = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target && failing) throw Object.assign(new Error('fixture disk error'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.equal((await post('/api/stickers/note', { stickerId: 'fixture-sticker', note: 'failed' })).status, 500);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  failing = false;
  const next = await post('/api/stickers/note', { stickerId: 'fixture-sticker', usage: 'updated usage' });
  assert.equal(next.status, 200);
  assert.equal(next.body.sticker.localNote, 'original');
}, { 'state/stickers.json': [{ id: 'fixture-sticker', localNote: 'original' }] }));

test('暂停持久化失败仍立即暂停当前进程，并可重试保存', async (t) => withConsole(async ({ h, post }) => {
  const target = path.join(h.temp, 'state/social-v2.json');
  const rename = fs.renameSync;
  let failing = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target && failing) throw Object.assign(new Error('fixture disk error'), { code: 'EIO' });
    return rename(from, to);
  });
  const result = await post('/api/socialV2/activity', { paused: true });
  assert.equal(result.status, 500);
  assert.equal(h.socialV2.paused, true);
  failing = false;
  assert.equal((await post('/api/socialV2/activity', { paused: true })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).paused, true);
}));
