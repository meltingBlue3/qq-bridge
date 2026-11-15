// preset-routes 的直接路由回归：临时 preset 目录，不启动 HTTP server。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { handlePresetRoutes } from '../src/http/preset-routes.js';
import { extractPresetPrefix } from '../src/preset-prompt.js';
import { getPresetPatchStatus } from '../src/preset-patches.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2', simulation: 'qsh-sim', simulationV2: 'qsh-sim-v2' };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-preset-routes-'));
  const dsh = path.join(root, 'dsh', 'agent-presets');
  const backupDir = path.join(root, 'state', 'preset-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of Object.values(PRESET_NAMES)) {
    const dir = path.join(dsh, name);
    fs.mkdirSync(dir, { recursive: true });
    // 用仓库里的真实 preset 做夹具：保存接口会做 ≥500 字符 + 安全不变量校验，
    // 手写迷你 YAML 无法通过，也不应该为了测试放宽生产校验。
    fs.copyFileSync(path.resolve(process.cwd(), 'dsh', 'agent-presets', name, 'agent.cordis.yml'), path.join(dir, 'agent.cordis.yml'));
    fs.copyFileSync(path.resolve(process.cwd(), 'dsh', 'agent-presets', name, 'preset.yml'), path.join(dir, 'preset.yml'));
  }
  return { root, dsh, backupDir };
}

function realPrefix(name) {
  const file = path.resolve(process.cwd(), 'dsh', 'agent-presets', name, 'agent.cordis.yml');
  return extractPresetPrefix(fs.readFileSync(file, 'utf8'));
}

test('canonical simulation prompt is editable and synchronized independently of the legacy preset', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const h = harness(f.root, f.backupDir);
  const legacySource = path.join(f.dsh, 'qq-chat-v2', 'agent.cordis.yml');
  const before = fs.readFileSync(legacySource, 'utf8');
  for (const preset of ['qsh-sim', 'qsh-sim-v2']) {
    const content = realPrefix(preset) + '\n\n本会话使用独立仿真预设。';
    const result = await h.call('POST', '/api/preset/sim-prompt', { preset, content });
    assert.equal(result.last.status, 200);
    assert.equal(patchPrefix(f.root, preset), content);
  }
  assert.equal(fs.readFileSync(legacySource, 'utf8'), before);
});

function harness(root, backupDir) {
  const sent = [];
  let body = {};
  let backupSeq = 0;
  const deps = {
    PRESET_NAMES,
    PRESET_BACKUP_DIR: backupDir,
    knownPresetName: (raw) => {
      const name = String(raw ?? '').trim();
      if (!name) return PRESET_NAMES.v2;
      return Object.values(PRESET_NAMES).includes(name) ? name : null;
    },
    readPresetPromptText: (name) => {
      const file = path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
      const text = fs.readFileSync(file, 'utf8');
      return { text, prefix: extractPresetPrefix(text) };
    },
    presetStatus: (name) => ({ name, ...getPresetPatchStatus(name, {
      sourceFile: path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml'), patchFile: patchFile(root, name),
    }) }),
    presetSourceYaml: (name) => path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml'),
    presetPatchYaml: (name) => patchFile(root, name),
    backupPresetFile: (name) => {
      const src = path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
      if (!fs.existsSync(src)) return null;
      const dest = path.join(backupDir, `${name}.agent.cordis.yml.${String(++backupSeq).padStart(4, '0')}`);
      fs.copyFileSync(src, dest);
      return dest;
    },
    listPresetBackups: (name) => fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((f) => f.startsWith(`${name}.agent.cordis.yml.`)).sort().reverse().map((file) => ({ file }))
      : [],
    log: () => {}
  };
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const handled = await handlePresetRoutes({
      req: { method }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call };
}

test('GET /api/preset/sim-prompt 返回 prefix 与状态', async () => {
  const { root, backupDir } = fixture();
  const h = harness(root, backupDir);
  const result = await h.call('GET', '/api/preset/sim-prompt?preset=qq-chat-v2');
  assert.equal(result.handled, true);
  assert.ok(result.last.obj.content.length > 500);
  assert.equal(result.last.obj.presets.length, 4);
  fs.rmSync(root, { recursive: true, force: true });
});

function patchFile(root, name = 'qq-chat-v2') {
  return path.join(root, 'plugins', 'qq-agent-presets', 'presets', `${name}.patch.yml`);
}

function patchPrefix(root, name = 'qq-chat-v2') {
  const row = yaml.load(fs.readFileSync(patchFile(root, name), 'utf8'))[0].insert[0];
  const source = yaml.load(fs.readFileSync(path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml'), 'utf8'));
  assert.deepEqual(row.config.plugins, source.map((plugin) => plugin.id === 'qq-tool-restrict'
    ? { ...plugin, name: 'qq-agent-presets/qq-tool-restrict.mjs' } : plugin));
  return row.config.plugins.find((plugin) => plugin.id === 'persona').config.prefix;
}

for (const name of Object.values(PRESET_NAMES)) {
  test(`${name}: 保存更新真实 bundle，守卫引用保持正确`, async (t) => {
    const { root, backupDir } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const content = `${realPrefix(name)}\n\n同步回归测试。`;
    const result = await harness(root, backupDir).call('POST', '/api/preset/sim-prompt', { preset: name, content });
    assert.equal(result.last.obj.ok, true);
    assert.equal(result.last.obj.synced, true);
    assert.equal(result.last.obj.status.synced, true);
    assert.equal(result.last.obj.requiresRestart, true);
    assert.equal(patchPrefix(root, name), content);
  });
}

test('正文未改也修复过期 bundle；重复保存不再要求重启、不重写源文件', async (t) => {
  const { root, backupDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
  const original = fs.readFileSync(file, 'utf8');
  const patch = patchFile(root);
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, 'outdated patch');
  const h = harness(root, backupDir);
  const content = extractPresetPrefix(original);
  const repaired = await h.call('POST', '/api/preset/sim-prompt', { content });
  assert.equal(repaired.last.obj.unchanged, true);
  assert.equal(repaired.last.obj.synced, true);
  assert.equal(repaired.last.obj.requiresRestart, true);
  assert.equal(patchPrefix(root), content);
  const rename = t.mock.method(fs, 'renameSync');
  const repeated = await h.call('POST', '/api/preset/sim-prompt', { content });
  assert.equal(repeated.last.obj.requiresRestart, false);
  assert.equal(rename.mock.callCount(), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readdirSync(backupDir).length, 0);
});

test('从备份还原同时更新 bundle', async (t) => {
  const { root, backupDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness(root, backupDir);
  await h.call('POST', '/api/preset/sim-prompt', { content: `${realPrefix('qq-chat-v2')}\n\n还原前的新版本。` });
  const backups = await h.call('GET', '/api/preset/sim-prompt/backups');
  const restored = await h.call('POST', '/api/preset/sim-prompt/restore', { file: backups.last.obj.backups[0].file });
  assert.equal(restored.last.obj.ok, true);
  assert.equal(restored.last.obj.synced, true);
  assert.equal(restored.last.obj.requiresRestart, true);
  assert.equal(patchPrefix(root), realPrefix('qq-chat-v2'));
});

test('bundle 替换失败返回 500，源文件回滚且旧 bundle 保留', async (t) => {
  const { root, backupDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
  const original = fs.readFileSync(source, 'utf8');
  const patch = patchFile(root);
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, 'old bundle');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === patch) throw Object.assign(new Error('fixture patch write failed'), { code: 'EIO' });
    return rename(from, to);
  });
  const result = await harness(root, backupDir).call('POST', '/api/preset/sim-prompt', {
    content: `${realPrefix('qq-chat-v2')}\n\n不应写入成功。`
  });
  assert.equal(result.last.status, 500);
  assert.equal(result.last.obj.ok, false);
  assert.equal(result.last.obj.synced, false);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  assert.equal(fs.readFileSync(patch, 'utf8'), 'old bundle');
  assert.ok(!fs.readdirSync(path.dirname(patch)).some((name) => name.endsWith('.tmp')));
});

test('已有 bundle 也会检查内容；无法读取元数据时不改写源或 bundle', async (t) => {
  const { root, backupDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
  const original = fs.readFileSync(source, 'utf8');
  const patch = patchFile(root);
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, 'stale bundle');
  const h = harness(root, backupDir);
  const before = await h.call('GET', '/api/preset/sim-prompt');
  assert.equal(before.last.obj.status.bundled, true);
  assert.equal(before.last.obj.status.synced, false);
  fs.writeFileSync(path.join(path.dirname(source), 'preset.yml'), 'name: [');
  const result = await h.call('POST', '/api/preset/sim-prompt', { content: `${realPrefix('qq-chat-v2')}\n新正文。` });
  assert.equal(result.last.status, 500);
  assert.equal(result.last.obj.synced, false);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  assert.equal(fs.readFileSync(patch, 'utf8'), 'stale bundle');
});

test('还原时 bundle 写失败，同样回滚源文件并返回失败', async (t) => {
  const { root, backupDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness(root, backupDir);
  await h.call('POST', '/api/preset/sim-prompt', { content: `${realPrefix('qq-chat-v2')}\n当前新版本。` });
  const backups = await h.call('GET', '/api/preset/sim-prompt/backups');
  const target = backups.last.obj.backups[0].file;
  const source = path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
  const original = fs.readFileSync(source, 'utf8');
  const patch = patchFile(root);
  const previousPatch = fs.readFileSync(patch, 'utf8');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === patch) throw Object.assign(new Error('fixture restore failure'), { code: 'EIO' });
    return rename(from, to);
  });
  const result = await h.call('POST', '/api/preset/sim-prompt/restore', { file: target });
  assert.equal(result.last.status, 500);
  assert.equal(result.last.obj.synced, false);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  assert.equal(fs.readFileSync(patch, 'utf8'), previousPatch);
});

test('正文未变的同步失败不会报成功，也不会生成新备份', async (t) => {
  const { root, backupDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const patch = patchFile(root);
  fs.mkdirSync(patch, { recursive: true });
  const result = await harness(root, backupDir).call('POST', '/api/preset/sim-prompt', { content: realPrefix('qq-chat-v2') });
  assert.equal(result.last.status, 500);
  assert.equal(result.last.obj.synced, false);
  assert.equal(fs.readdirSync(backupDir).length, 0);
});

test('源文件回滚也失败时，错误明确要求检查源文件与备份', async (t) => {
  const { root, backupDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const patch = patchFile(root);
  const source = path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
  const rename = fs.renameSync;
  let sourceWrites = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === patch || (to === source && ++sourceWrites > 1)) {
      throw Object.assign(new Error('fixture IO failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  const result = await harness(root, backupDir).call('POST', '/api/preset/sim-prompt', {
    content: `${realPrefix('qq-chat-v2')}\n无法回滚的测试。`
  });
  assert.equal(result.last.status, 500);
  assert.equal(result.last.obj.synced, false);
  assert.match(result.last.obj.error, /回滚失败.*检查源文件与备份/);
  assert.equal(fs.readdirSync(backupDir).length, 1);
});

test('真实控制台 HTTP 入口接入 bundle 同步与状态检查', async () => {
  const files = {};
  for (const name of Object.values(PRESET_NAMES)) {
    for (const file of ['agent.cordis.yml', 'preset.yml']) {
      const rel = `dsh/agent-presets/${name}/${file}`;
      files[rel] = fs.readFileSync(path.resolve(rel), 'utf8');
    }
  }
  const h = await bridgeHarness({ files });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/preset/sim-prompt`;
    const headers = { 'content-type': 'application/json' };
    const content = `${realPrefix('qq-chat-v2')}\nHTTP 同步测试。`;
    const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ content }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).synced, true);
    assert.equal(patchPrefix(h.temp), content);
    const loaded = await fetch(url, { headers });
    const result = await loaded.json();
    assert.equal(result.status.synced, true);
    assert.equal(result.status.bundled, true);
    assert.ok(!JSON.stringify(result.status).includes(h.temp), 'status must not expose installation paths');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('未知 preset 返回 400，非路由返回 false', async () => {
  const { root, backupDir } = fixture();
  const h = harness(root, backupDir);
  const bad = await h.call('GET', '/api/preset/sim-prompt?preset=../evil');
  assert.equal(bad.last.status, 400);
  const notRoute = await h.call('GET', '/api/status');
  assert.equal(notRoute.handled, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST 保存会写源文件并返回 requiresRestart', async () => {
  const { root, backupDir } = fixture();
  const h = harness(root, backupDir);
  const result = await h.call('POST', '/api/preset/sim-prompt', {
    preset: 'qq-chat-v2',
    content: `${realPrefix('qq-chat-v2')}\n\n新增测试内容。`
  });
  assert.equal(result.last.obj.ok, true);
  assert.equal(result.last.obj.requiresRestart, true);
  assert.match(fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8'), /新增测试内容/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('备份列表与还原路径都按 preset 隔离', async () => {
  const { root, backupDir } = fixture();
  const h = harness(root, backupDir);
  const save = await h.call('POST', '/api/preset/sim-prompt', { preset: 'qq-chat-v2', content: `${realPrefix('qq-chat-v2')}\n\n备份前新增内容。` });
  assert.equal(save.last.obj.ok, true);
  const backups = await h.call('GET', '/api/preset/sim-prompt/backups?preset=qq-chat-v2');
  assert.equal(backups.last.obj.ok, true);
  assert.ok(backups.last.obj.backups.length >= 1);
  fs.rmSync(root, { recursive: true, force: true });
});
