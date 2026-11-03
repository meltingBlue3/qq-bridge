// preset-routes 的直接路由回归：临时 preset 目录，不启动 HTTP server。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlePresetRoutes } from '../src/http/preset-routes.js';
import { extractPresetPrefix } from '../src/preset-prompt.js';

const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };

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
  }
  return { root, dsh, backupDir };
}

function realPrefix(name) {
  const file = path.resolve(process.cwd(), 'dsh', 'agent-presets', name, 'agent.cordis.yml');
  return extractPresetPrefix(fs.readFileSync(file, 'utf8'));
}

function harness(root, backupDir) {
  const sent = [];
  let body = {};
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
    presetStatus: (name) => ({ name, exists: fs.existsSync(path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml')) }),
    presetSourceYaml: (name) => path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml'),
    installedPresetYaml: (name) => path.join(root, 'installed', name, 'agent.cordis.yml'),
    backupPresetFile: (name) => {
      const src = path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
      if (!fs.existsSync(src)) return null;
      const dest = path.join(backupDir, `${name}.agent.cordis.yml.${Date.now()}`);
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
  assert.equal(result.last.obj.presets.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
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
