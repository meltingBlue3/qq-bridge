// 普通聊天并入 per-session 投递队列：提交顺序 = 到达顺序（修「后到文本先于带图消息」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('带图消息解析慢，后到的纯文本也不得插队（提交顺序=到达顺序）', async () => {
  const h = await bridgeHarness({
    globals: {
      fetchHook: async (url) => {
        if (String(url).includes('slow-image.example')) await sleep(400); // 图片字节解析慢
      }
    }
  });
  try {
    h.setMode('chat');
    const imageEvent = {
      self_id: 999,
      user_id: 123,
      group_id: 456,
      message_id: 6001,
      message: [
        { type: 'text', data: { text: '看这张图' } },
        { type: 'image', data: { url: 'https://slow-image.example/x.jpg', file: 'x.jpg' } }
      ],
      raw_message: '看这张图[图片]'
    };
    const textEvent = {
      self_id: 999, user_id: 123, group_id: 456, message_id: 6002,
      message: [{ type: 'text', data: { text: '跟一句纯文本' } }], raw_message: '跟一句纯文本'
    };
    const p1 = h.handleIncoming('group', '456', imageEvent, h.cfg);
    await sleep(30); // 让带图消息先进队、开始慢解析
    const p2 = h.handleIncoming('group', '456', textEvent, h.cfg);
    await Promise.all([p1, p2]);
    for (let i = 0; i < 100 && h.calls.prompts.length < 2; i += 1) await sleep(30);
    assert.equal(h.calls.prompts.length, 2, '两条都要提交');
    const first = h.calls.prompts[0].content.map((c) => String(c?.text ?? '')).join('\n');
    const second = h.calls.prompts[1].content.map((c) => String(c?.text ?? '')).join('\n');
    assert.match(first, /看这张图/, '带图消息先提交（尽管它的媒体解析慢 400ms）');
    assert.match(second, /跟一句纯文本/, '纯文本不得插队');
  } finally { await h.close(); }
});

test('引用查询尚未完成时，后到文本也必须按接收顺序投递', async () => {
  const h = await bridgeHarness();
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  h.cfg.ackMessage = '';
  h.bot.getMessage = async () => {
    began();
    await new Promise((resolve) => { release = resolve; });
    return { group_id: 456, user_id: 111, sender: { nickname: 'fixture', user_id: 111 }, message: '引用原文' };
  };
  const event = (message, message_id) => ({ self_id: 999, user_id: 111, group_id: 456, message_id, message });
  try {
    const first = h.handleIncoming('group', '456', event([
      { type: 'reply', data: { id: '1234' } }, { type: 'text', data: { text: '前置带引用消息' } },
    ], 6101), h.cfg);
    await started;
    const second = h.handleIncoming('group', '456', event('后到文本', 6102), h.cfg);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    assert.equal(h.calls.prompts.length, 2);
    assert.match(h.calls.prompts[0].content.map((part) => part.text ?? '').join(''), /前置带引用消息/);
    assert.match(h.calls.prompts[1].content.map((part) => part.text ?? '').join(''), /后到文本/);
  } finally { release?.(); await h.close(); }
});

test('一个群的引用解析阻塞时，另一群仍能独立处理', async () => {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456', '789'] } } });
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  h.cfg.ackMessage = '';
  h.bot.getMessage = async () => {
    began();
    await new Promise((resolve) => { release = resolve; });
    return { group_id: 456, user_id: 111, message: 'quote' };
  };
  try {
    const first = h.handleIncoming('group', '456', { self_id: 999, user_id: 111, group_id: 456,
      message: [{ type: 'reply', data: { id: '500' } }, { type: 'text', data: { text: 'slow' } }] }, h.cfg);
    await started;
    await h.handleIncoming('group', '789', { user_id: 111, group_id: 789, message: 'other conversation' }, h.cfg);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].sessionId, h.state.sessions['group:789']);
    release();
    await first;
  } finally { release?.(); await h.close(); }
});

test('重置取消待解析消息，旧引用返回后不得投递到新上下文', async () => {
  const h = await bridgeHarness();
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  h.cfg.ackMessage = '';
  h.bot.getMessage = async () => {
    began();
    await new Promise((resolve) => { release = resolve; });
    return { group_id: 456, user_id: 111, message: 'old quote' };
  };
  const event = (message) => ({ self_id: 999, user_id: 111, group_id: 456, message });
  try {
    const active = h.handleIncoming('group', '456', event([
      { type: 'reply', data: { id: '501' } }, { type: 'text', data: { text: 'obsolete active' } },
    ]), h.cfg);
    await started;
    const waiting = h.handleIncoming('group', '456', event('obsolete waiting'), h.cfg);
    const rejected = assert.rejects(waiting, /权限已变化/);
    h.retireSession('group:456', { discardQueued: true });
    await rejected;
    await h.handleIncoming('group', '456', event('new generation'), h.cfg);
    release();
    await active;
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content.map((part) => part.text ?? '').join(''), /new generation/);
  } finally { release?.(); await h.close(); }
});
