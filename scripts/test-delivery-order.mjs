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
