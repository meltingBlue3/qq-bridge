// roles 文件层单测：临时 roles/ 目录，不碰真实人格卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRoleStore,
  ROLE_CONTENT_MAX_BYTES,
  ROLE_NAME_MAX,
  sanitizeRoleName,
  validateRoleContent
} from '../src/roles.js';

function fixture(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-roles-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function store(rolesDir, limit = () => 2000) {
  return createRoleStore({ rolesDir, getInjectLimit: limit });
}

test('listRoles 排除 README，按中文名排序', () => {
  const dir = fixture({ 'b.md': '# b', 'a.md': '# a', 'README.md': 'readme', 'x.txt': 'x' });
  const s = store(dir);
  assert.deepEqual(s.listRoles(), ['a', 'b']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateRoleName 拒绝空名/超长/保留名/Windows 设备名', () => {
  const s = store(fixture());
  assert.equal(s.validateRoleName(' 傲娇助手 '), '傲娇助手');
  assert.equal(s.validateRoleName('a-b_1'), 'a-b_1');
  assert.throws(() => s.validateRoleName(''), /不能为空/);
  assert.throws(() => s.validateRoleName('a'.repeat(ROLE_NAME_MAX + 1)), /过长/);
  assert.throws(() => s.validateRoleName('README'), /保留名称/);
  assert.throws(() => s.validateRoleName('CON'), /系统保留名称/);
  assert.equal(sanitizeRoleName('../x'), 'x');
});

test('validateRoleContent 去 CRLF / 拒绝空内容 / 限制体积', () => {
  assert.equal(validateRoleContent('a\r\nb'), 'a\nb');
  assert.throws(() => validateRoleContent('  '), /不能为空/);
  assert.throws(() => validateRoleContent('x'.repeat(ROLE_CONTENT_MAX_BYTES + 1)), /过长/);
});

test('writeRoleContent 自动补末尾换行，readRoleContent 原样读回', () => {
  const dir = fixture();
  const s = store(dir);
  s.writeRoleContent('测试', '# 测试\n正文');
  assert.equal(s.readRoleContent('测试'), '# 测试\n正文\n');
  assert.equal(fs.readFileSync(path.join(dir, '测试.md'), 'utf8'), '# 测试\n正文\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('roleSummaries 报告注入长度/截断/警告', () => {
  const dir = fixture({
    '短.md': '# 短\n普通人格',
    '长.md': '# 长\n' + '字'.repeat(20),
    '一代.md': '# 一代\n[SILENT] 这条是一代指令'
  });
  const s = store(dir, () => 10);
  const rows = s.roleSummaries();
  const short = rows.find((r) => r.name === '短');
  const long = rows.find((r) => r.name === '长');
  const gen1 = rows.find((r) => r.name === '一代');
  assert.equal(short.truncated, false);
  assert.equal(long.truncated, true);
  assert.equal(long.injectedV2, 10);
  assert.ok(gen1.warnings > 0, '未标记的一代指令应产生警告');
  fs.rmSync(dir, { recursive: true, force: true });
});
