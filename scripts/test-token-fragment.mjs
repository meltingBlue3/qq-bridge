// 令牌片段级匹配器：直接单元测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTokenFragmentMatcher, TOKEN_FRAGMENT_LENGTH } from '../src/token-fragment.js';

const TOKEN = 'sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'; // 35 字符，片段级受控

test('整串命中：完整 token 出现在文本里必须被检测', () => {
  const m = createTokenFragmentMatcher();
  m.sync([TOKEN]);
  assert.equal(m.test(`令牌是 ${TOKEN} 请保密`), true);
});

test('拆条场景：文本只含 token 的连续 12 字符残段也必须被检测', () => {
  const m = createTokenFragmentMatcher();
  m.sync([TOKEN]);
  // 模型把 token 拆两条发：每条各带 ≥12 个连续字符
  assert.equal(m.test(TOKEN.slice(0, 15)), true, '前 15 字符残段');
  assert.equal(m.test(TOKEN.slice(-15)), true, '后 15 字符残段');
  assert.equal(m.test(TOKEN.slice(10, 25)), true, '中间 15 字符残段');
});

test('灵敏度边界（有意为之）：两侧残段都 < 12 字符时检测不到', () => {
  const m = createTokenFragmentMatcher();
  m.sync([TOKEN]);
  assert.equal(TOKEN.length >= TOKEN_FRAGMENT_LENGTH * 2, true);
  assert.equal(m.test(`${TOKEN.slice(0, 6)} 中间插了别的话 ${TOKEN.slice(-6)}`), false,
    '拆分点落在窗口内部是文档化边界：灵敏度与误伤的权衡');
});

test('短 token（<12 字符）只做整串匹配，不做片段推断', () => {
  const m = createTokenFragmentMatcher();
  m.sync(['abc123']);
  assert.equal(m.test('前缀 abc123 后缀'), true, '整串命中');
  assert.equal(m.test('abc123xx'), true, '整串 includes 语义保持');
});

test('不误伤：普通文本与随机串不命中', () => {
  const m = createTokenFragmentMatcher();
  m.sync([TOKEN]);
  assert.equal(m.test('今天天气不错，一起去吃饭吗？'), false);
  assert.equal(m.test('a1b2 c3d4 随便打打'), false);
  assert.equal(m.test(''), false);
  assert.equal(m.test(null), false);
});

test('sync 之后摘除的 token 不再命中', () => {
  const m = createTokenFragmentMatcher();
  m.sync([TOKEN, 'deadbeefdeadbeefdead']);
  assert.equal(m.test(TOKEN.slice(0, 12)), true);
  m.sync(['deadbeefdeadbeefdead']);
  assert.equal(m.test(TOKEN.slice(0, 12)), false, 'token 被摘除后片段同步失效');
  assert.equal(m.test('deadbeefdeadbeefdead'), true);
});

test('redact：整串替换为 ***，残段长块同样打码；短残段保持原样', () => {
  const m = createTokenFragmentMatcher();
  m.sync([TOKEN]);
  assert.equal(m.redact(`密钥 ${TOKEN} 泄露`), '密钥 *** 泄露');
  const masked = m.redact(`残段 ${TOKEN.slice(0, 18)} 结束`);
  assert.ok(masked.includes('***'), '18 字符残段必须被打码');
  assert.ok(!masked.includes(TOKEN.slice(0, 12)), '打码后不得残留 12 字符连续片段');
  assert.equal(m.redact('没有令牌的普通文本'), '没有令牌的普通文本');
});

test('bridge.js 已接线：四个出站审计点与两个脱敏函数全部走片段匹配', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ createTokenFragmentMatcher \} from '\.\/token-fragment\.js';/);
  assert.match(src, /const tokenFragments = createTokenFragmentMatcher\(\);/);
  assert.equal(src.split('tokenFragments.test(').length - 1, 4, '四个出站审计点');
  assert.equal(src.split('tokenFragments.redact(').length - 1, 2, 'redactSensitiveText + redactKnownTokensOnly');
  assert.match(src, /tokenFragments\.sync\(KNOWN_AGENT_TOKENS\);/, 'token 集合增删后必须同步滑窗');
  const harness = fs.readFileSync(new URL('./audit-bridge-harness.mjs', import.meta.url), 'utf8');
  assert.match(harness, /token-fragment\.js/, 'VM 夹具必须注入片段匹配模块');
});
