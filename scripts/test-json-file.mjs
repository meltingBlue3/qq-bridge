// json-file 模块的单元回归：临时目录夹具，不触碰仓库 state/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteJson,
  atomicWriteText,
  readConfigObject,
  readJsonSafe
} from '../src/json-file.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-json-file-'));

test('readJsonSafe：缺失返回 fallback，required 时抛错', () => {
  const dir = tmpRoot();
  assert.deepEqual(readJsonSafe(path.join(dir, 'missing.json'), { ok: false }), { ok: false });
  assert.throws(() => readJsonSafe(path.join(dir, 'missing.json'), null, true), /配置文件读取\/解析失败/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonSafe：接受 UTF-8 BOM', () => {
  const dir = tmpRoot();
  const file = path.join(dir, 'bom.json');
  fs.writeFileSync(file, '\uFEFF{"a":1}', 'utf8');
  assert.deepEqual(readJsonSafe(file, null), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readConfigObject：拒绝 null/数组/标量，避免覆盖整份配置', () => {
  const dir = tmpRoot();
  for (const [name, content, pattern] of [
    ['null.json', 'null', /null/],
    ['array.json', '[]', /数组/],
    ['string.json', '"x"', /string/]
  ]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'utf8');
    assert.throws(() => readConfigObject(file), pattern);
  }
  const okFile = path.join(dir, 'ok.json');
  fs.writeFileSync(okFile, '{"a":1}', 'utf8');
  assert.deepEqual(readConfigObject(okFile), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteJson：创建父目录、末尾换行、无临时文件残留', () => {
  const dir = tmpRoot();
  const file = path.join(dir, 'nested', 'state.json');
  atomicWriteJson(file, { a: 1, b: [2] });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
  assert.deepEqual(readJsonSafe(file, null), { a: 1, b: [2] });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteText：原样写入文本并创建目录', () => {
  const dir = tmpRoot();
  const file = path.join(dir, 'deep', 'note.txt');
  atomicWriteText(file, '你好\nworld');
  assert.equal(fs.readFileSync(file, 'utf8'), '你好\nworld');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteJson 覆盖已有文件不会留下半个 JSON', () => {
  const dir = tmpRoot();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"old":true}', 'utf8');
  atomicWriteJson(file, { new: true });
  assert.deepEqual(readJsonSafe(file, null), { new: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
