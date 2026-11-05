import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLongSegment, planSocialTimeline } from '../src/core/reply-formatting.js';

test('long segments preserve both complete URLs and emoji at every boundary', () => {
  const url = 'https://example.com/path?q=1&x=2';
  for (let offset = 1; offset <= 520; offset++) {
    const input = '啊'.repeat(offset) + '😀' + url + '中间' + url;
    const parts = splitLongSegment(input, 500);
    assert.equal(parts.join(''), input);
    assert.ok(parts.every((v) => v.isWellFormed() && !v.includes('\0')));
  }
});

test('social timeline splits intentional CJK spaces but keeps English sentences', () => {
  assert.deepEqual(planSocialTimeline('你好 hello world 再见', {}).main, ['你好', 'hello world', '再见']);
  assert.deepEqual(planSocialTimeline('hello world', {}).main, ['hello world']);
  assert.deepEqual(planSocialTimeline('', {}), { main: [], followUp: null });
});

test('disabled bursts keep spaces and still split overlong text without loss', () => {
  const input = '你好 hello world 再见';
  assert.deepEqual(planSocialTimeline(input, { burstEnabled: false }).main, [input]);
  const parts = planSocialTimeline('啊'.repeat(1500), { burstEnabled: false, maxReplyChars: 500 }).main;
  assert.equal(parts.length, 3);
  assert.equal(parts.join(''), '啊'.repeat(1500));
});
