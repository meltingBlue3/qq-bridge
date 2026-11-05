import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentsToText, extractMediaFromSegments, createInboundParser } from '../src/core/inbound-parser.js';

test('原生文本、可选空段和未知段可独立解析', async () => {
  assert.equal(await segmentsToText(' hello '), 'hello');
  assert.equal(await segmentsToText(null), '');
  assert.equal(await segmentsToText({ malformed: true }), '');
  assert.equal(await segmentsToText([{ type: 'unknown' }]), '[unknown]');
  assert.deepEqual(extractMediaFromSegments('native string'), []);
});

test('引用仅进入完整正文；命令文本不混入引用；消息 ID 不做数字转换', async () => {
  const calls = [];
  const parser = createInboundParser({
    resolveMember: async (group, qq) => { calls.push([group, qq]); return 'member'; },
    resolveReply: async (kind, id, messageId, selfId) => {
      assert.deepEqual([kind, id, messageId, selfId], ['group', '456', '12', 999]);
      return { sender: 'quoted', text: 'quoted /reset' };
    },
    isQuoteTargetSelf: async () => true,
  });
  const event = { group_id: 456, self_id: 999, message_id: '900719925474099312345', message_seq: 4,
    message: [{ type: 'reply', data: { id: '12' } }, { type: 'at', data: { qq: '123' } },
      { type: 'text', data: { text: 'hello' } }] };
  const result = await parser.parse('group', '456', event);
  assert.equal(result.textContent, '[引用 quoted：quoted /reset]@memberhello');
  assert.equal(result.plainContent, '@memberhello');
  assert.equal(result.quoteTargetIsSelf, true);
  assert.deepEqual(result.refsToStore, ['900719925474099312345', '4']);
  assert.ok(calls.every(([group]) => group === 456));
});

test('私聊不查群成员；引用查询失败降级；只引用自己的消息仍保留指向性', async () => {
  const parser = createInboundParser({
    resolveMember: () => assert.fail('private chat resolved a group member'),
    resolveReply: async () => { throw new Error('fixture failure'); },
    isQuoteTargetSelf: async () => true,
  });
  const result = await parser.parse('private', '123', { message: [{ type: 'reply', data: { id: '4' } }] });
  assert.equal(result.textContent, '[引用消息]');
  assert.equal(result.plainContent, '');
  assert.equal(result.quoteTargetIsSelf, true);
});

test('表情元数据保留 snake/camel 字段，摘要单行且限长', () => {
  const media = extractMediaFromSegments([
    { type: 'image', data: { file: 'x', emoji_id: 'em', emoji_package_id: 2, sub_type: 0,
      summary: `first\n${'x'.repeat(100)}`, key: 'fixture-key' } },
    { type: 'mface', data: { emojiId: 'other', summary: 'smile' } },
  ]);
  assert.equal(media[0].emojiId, 'em');
  assert.equal(media[0].emojiPackageId, '2');
  assert.equal(media[0].subType, '0');
  assert.equal(media[0].emojiKey, 'fixture-key');
  assert.ok(!media[0].summary.includes('\n'));
  assert.ok(media[0].summary.length <= 60);
  assert.equal(media[1].kind, 'sticker');
  assert.equal(media[1].emojiId, 'other');
});
