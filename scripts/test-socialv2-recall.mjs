// 撤回事件入库替换：模块直测 + bridge 接线断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyRecallV2, RECALLED_PLACEHOLDER } from '../src/social-v2/recall.js';

function makeMsg(overrides = {}) {
  return {
    seq: 7, messageId: 'msg-100', sender: '群友A', userId: '999',
    text: '原文明文', plain: '原文明文', tail: '原文明文',
    quoteTargetIsSelf: false, isOwner: false, isSelf: false,
    media: [{ kind: 'image', file: 'x.jpg' }], hasMedia: true,
    forwardIds: ['fwd-1', 'fwd-2'], hasForward: true,
    time: 1700000000000, ...overrides
  };
}

test('applyRecallV2：替换内容与派生字段，保留 seq/时间/发送者', () => {
  // 真实运行时 recent 与 unread 存的是**同一个对象引用**（append 时 push 同一个 msg）
  const m = makeMsg();
  const st = { recentMessages: [m], unread: [m] };
  const r = applyRecallV2(st, 'msg-100');
  assert.equal(r.replaced, 1, 'recent 与 unread 是同一对象引用，只算一次');
  assert.deepEqual(r.forwardIds, ['fwd-1', 'fwd-2'], '转发 id 要交还给调用方清白名单');
  assert.equal(m.seq, 7, 'seq 是水位锚点，不能动');
  assert.equal(m.time, 1700000000000, '时间保留');
  assert.equal(m.sender, '群友A', '发送者保留');
  assert.equal(m.text, RECALLED_PLACEHOLDER);
  assert.equal(m.plain, RECALLED_PLACEHOLDER);
  assert.equal(m.tail, RECALLED_PLACEHOLDER);
  assert.equal(m.recalled, true);
  assert.deepEqual(m.media, []);
  assert.equal(m.hasMedia, false);
  assert.deepEqual(m.forwardIds, []);
  assert.equal(m.hasForward, false);
  assert.ok(!JSON.stringify(st).includes('原文明文'), '原文不得残留在状态里');
});

test('applyRecallV2：独立对象各算一次（历史数据可能已分裂）；不匹配零改动；幂等', () => {
  // 旧状态文件加载后 recent/unread 可能是两个独立对象：两条都该被替换
  const st0 = { recentMessages: [makeMsg()], unread: [makeMsg()] };
  assert.equal(applyRecallV2(st0, 'msg-100').replaced, 2);
  // JSON 往返后的普通情形：不匹配时零改动
  const st = { recentMessages: [makeMsg()], unread: [makeMsg({ messageId: 200, seq: 8 })] };
  assert.equal(applyRecallV2(st, 'msg-other').replaced, 0);
  assert.equal(st.recentMessages[0].text, '原文明文', '未命中的消息原样保留');
  const r = applyRecallV2(st, 200); // 数字 id 与字符串等价
  assert.equal(r.replaced, 1);
  assert.equal(st.unread[0].recalled, true);
  assert.equal(applyRecallV2(st, 200).replaced, 0, '重复撤回事件幂等');
});

test('applyRecallV2：空入参与畸形状态安全返回', () => {
  assert.deepEqual(applyRecallV2(null, 'x'), { replaced: 0, forwardIds: [] });
  assert.deepEqual(applyRecallV2({}, ''), { replaced: 0, forwardIds: [] });
  assert.deepEqual(applyRecallV2({ recentMessages: [null, '垃圾', makeMsg()] }, 'msg-100').replaced, 1, '畸形条目被跳过');
  assert.deepEqual(applyRecallV2({ recentMessages: 'not-array' }, 'msg-100').replaced, 0);
});

test('bridge.js 已接线：双 notice_type 订阅 + 缓存清理 + 落盘', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /bot\.onNotice\('group_recall'/);
  assert.match(src, /bot\.onNotice\('friend_recall'/);
  assert.match(src, /function handleRecallNotice\(event\)/);
  assert.match(src, /import \{ applyRecallV2 \} from '\.\/social-v2\/recall\.js';/);
  // handleRecallNotice 内必须清理三个派生缓存并落盘
  const fn = src.slice(src.indexOf('function handleRecallNotice'), src.indexOf('async function handlePokeNotice'));
  assert.match(fn, /replyInfoCache\.delete/, '引用解析缓存必须清');
  assert.match(fn, /messageMediaStore\.get/, '一代媒体缓存必须清');
  assert.match(fn, /seenForwardIds\.get/, '转发白名单必须清');
  assert.match(fn, /saveSocialV2State\(\)/, '替换后必须落盘');
  const harness = fs.readFileSync(new URL('./audit-bridge-harness.mjs', import.meta.url), 'utf8');
  assert.match(harness, /social-v2\/recall\.js/, 'VM 夹具必须注入 recall 模块');
});
