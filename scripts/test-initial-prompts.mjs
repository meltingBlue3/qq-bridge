// initial-prompts 存储模块的单元回归：临时目录夹具，不碰真实 state/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInitialPromptStore, normalizeInitialPromptText } from '../src/initial-prompts.js';

const canonicalKey = (key) => {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  return m ? `${m[1]}:${Number(m[2])}` : null;
};

function fixture(fileContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-initial-prompts-'));
  const file = path.join(dir, 'initial-prompts.json');
  if (fileContent !== undefined) fs.writeFileSync(file, fileContent, 'utf8');
  return { dir, file };
}

function store(file, { maxChars = () => 2000 } = {}) {
  return createInitialPromptStore({ file, maxChars, canonicalKey, log: () => {} });
}

test('缺失文件：空表、可写、保存后能重新加载', () => {
  const { dir, file } = fixture();
  const s = store(file);
  s.load();
  assert.equal(s.entries.size, 0);
  assert.equal(s.writable, true);
  const result = s.set('group:456', '群背景：讨论技术，不聊八卦');
  assert.equal(result.ok, true);
  assert.equal(result.key, 'group:456');
  assert.equal(fs.existsSync(file), true);

  const s2 = store(file);
  s2.load();
  assert.equal(s2.entries.get('group:456').text, '群背景：讨论技术，不聊八卦');
  assert.ok(s2.entries.get('group:456').createdAt > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('空内容删除；非法 key / 超长内容被拒绝', () => {
  const { dir, file } = fixture();
  const s = store(file, { maxChars: () => 10 });
  s.load();
  assert.equal(s.set('bad-key', 'x').statusCode, 400);
  assert.equal(s.set('group:456', '12345678901').statusCode, 400);
  assert.equal(s.set('group:456', '12345').ok, true);
  const del = s.set('group:456', '   ');
  assert.equal(del.deleted, true);
  assert.equal(s.entries.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('损坏文件降级只读，保存不会覆盖原文件', () => {
  const { dir, file } = fixture('{broken json');
  const s = store(file);
  s.load();
  assert.equal(s.writable, false);
  assert.equal(s.set('group:456', '新内容').statusCode, 500);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken json');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('加载不截断，注入时才按上限截断', () => {
  const { dir, file } = fixture(JSON.stringify({ 'group:456': { text: '一二三四五六七八九十', createdAt: 1, updatedAt: 2 } }));
  const s = store(file, { maxChars: () => 5 });
  s.load();
  assert.equal(s.entries.get('group:456').text.length, 10);
  const text = s.format('group:456');
  assert.match(text, /^【群聊环境/);
  assert.match(text, /已按上限截断/);
  assert.ok(!text.includes('一二三四五六七八九十'), '超长正文必须被截断');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeInitialPromptText 去 BOM / 控制字符 / 统一行尾', () => {
  assert.equal(normalizeInitialPromptText('\uFEFFa\r\nb\u0000'), 'a\nb');
});
