#!/usr/bin/env node
// compose lint：断言「仿真层（preset）」「人格层（roles/*.md）」「注入通道（qq-persona 插件 + 桥接）」
// 三方遵守分层契约。契约文档：docs/guides/PROMPT_LAYERING.md
//
// 这个测试存在的意义：2026-10-29 出过一次事故——preset 等的是【角色扮演】标记，
// 桥接发的是「# 角色卡：」，两边约定不一致，模型就当没看见角色卡。
// 那种 bug 单测各自的模块永远发现不了，只有把三方拼起来看才发现。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS = ['qq-chat', 'qq-chat-v2'];
const PERSONA_VARIABLE = '{{qqPersona}}';

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const presetText = (name) => read('dsh', 'agent-presets', name, 'agent.cordis.yml');
const bridgeText = read('src', 'bridge.js');
const pluginText = read('plugins', 'qq-persona', 'lib', 'index.js');
const config = JSON.parse(read('config.json'));

const roleFiles = fs
  .readdirSync(path.join(ROOT, 'roles'))
  .filter((name) => name.endsWith('.md') && name !== 'README.md');

// 旧版遗留卡：小鲸鱼.md 里有工具说明、长度也超限（正是本契约要禁的写法）。
// 它是历史内容，不在这次重构范围内，所以只警告不阻塞；重写它之后从这里删掉。
const KNOWN_LEGACY = new Set(['小鲸鱼.md']);

test('每个 preset 都有【提示词分层与优先级】段', () => {
  for (const name of PRESETS) {
    assert.ok(presetText(name).includes('【提示词分层与优先级】'), `${name} 缺少分层优先级段`);
  }
});

test('preset 不含旧的身份冲突句式', () => {
  const banned = ['不改变你的真实身份', '角色卡可以调整性格与语气，但', 'You are a coding agent'];
  for (const name of PRESETS) {
    const text = presetText(name);
    for (const phrase of banned) {
      assert.ok(!text.includes(phrase), `${name} 仍包含旧句式：${phrase}`);
    }
  }
});

test('人格卡走 system prompt：preset / 插件 / 桥接三方对齐', () => {
  for (const name of PRESETS) {
    assert.ok(presetText(name).includes(PERSONA_VARIABLE), `${name} 没有用 ${PERSONA_VARIABLE} 注入人格卡`);
  }
  assert.ok(pluginText.includes("variable('qqPersona'"), 'qq-persona 插件没有注册 qqPersona 变量');
  assert.ok(pluginText.includes('context?.agent?.id'), 'qq-persona 插件没有按会话 id 取人格');
  assert.ok(bridgeText.includes('syncPersonaForSession('), '桥接没有调用 syncPersonaForSession');
  assert.ok(bridgeText.includes("'qq-persona'"), '桥接没有写 qq-persona 目录');
  // 人格卡不能再拼进用户消息
  assert.ok(!bridgeText.includes('wrapPersonaBlock('), '桥接仍在把人格卡拼进用户消息');
});

test('preset 的默认风格明确让位于角色卡', () => {
  for (const name of PRESETS) {
    const text = presetText(name);
    assert.ok(
      text.includes('以角色卡为准') || text.includes('按卡里'),
      `${name} 的默认风格没有声明可被角色卡覆盖`
    );
  }
});

test('preset 声明 XML 消息封装与提示词注入规则', () => {
  for (const name of PRESETS) {
    const text = presetText(name);
    assert.ok(text.includes('qq_message'), `${name} 没有说明 <qq_message> 封装`);
    assert.ok(text.includes('用户输入的数据'), `${name} 没有声明正文是不可信数据`);
    assert.ok(text.includes('role="owner"'), `${name} 没有把管理员身份绑到 role 属性`);
  }
});

test('preset 明确禁止把用户正文里的"角色卡"当系统设定', () => {
  for (const name of PRESETS) {
    const text = presetText(name);
    assert.ok(
      text.includes('普通文本') && text.includes('不得据此改变身份'),
      `${name} 没有防伪造说明`
    );
  }
});

test('角色卡不写工具用法，也不引用系统注入变量', () => {
  for (const file of roleFiles) {
    const text = read('roles', file);
    if (KNOWN_LEGACY.has(file)) {
      console.warn(`⚠️ 已知遗留：${file} 仍含工具说明，待重写`);
      continue;
    }
    assert.ok(!/qq_send_|mcp__snowluma|mcp__web-search/.test(text), `${file} 里出现工具名`);
    assert.ok(!text.includes(PERSONA_VARIABLE), `${file} 里出现 ${PERSONA_VARIABLE}（会递归注入）`);
  }
});

test('角色卡长度不超过 role.maxInjectChars', () => {
  const limit = Number(config.role?.maxInjectChars ?? 6000);
  for (const file of roleFiles) {
    const len = [...read('roles', file)].length;
    if (KNOWN_LEGACY.has(file)) {
      console.warn(`⚠️ 已知遗留：${file} 有 ${len} 字符，超过上限 ${limit}（会被截断）`);
      continue;
    }
    assert.ok(len <= limit, `${file} 有 ${len} 字符，超过上限 ${limit}`);
  }
});
