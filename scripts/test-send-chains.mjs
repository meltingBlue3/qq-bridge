// 按会话分链：跨会话并行互不阻塞、同会话严格保序、链尾清理。
// 夹具的 globals.botSendHook 可注入发送延迟/记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('跨会话并行：A 群慢速发送不阻塞 B 群（单链时代 B 要等 A 排完）', async () => {
  const events = []; // { key, at: 'start'|'end', t }
  const h = await bridgeHarness({
    config: { allow: { private: ['123'], groups: ['456', '789'] } },
    globals: {
      botSendHook: async (kind, id) => {
        const key = `${kind}:${id}`;
        const t0 = Date.now();
        events.push({ key, at: 'start', t: t0 });
        if (key === 'group:456') await sleep(250); // A 群每条都慢
        events.push({ key, at: 'end', t: Date.now() });
      }
    }
  });
  try {
    h.setMode('reserved2');
    await Promise.all([
      h.sendToQQ('group:456', 'A1'),
      h.sendToQQ('group:456', 'A2'),
      h.sendToQQ('group:789', 'B1')
    ]);
    const start = (k, i) => events.filter((e) => e.key === k && e.at === 'start')[i].t;
    const end = (k, i) => events.filter((e) => e.key === k && e.at === 'end')[i].t;
    assert.equal(events.filter((e) => e.key === 'group:789').length, 2);
    // B1 必须在 A2 开始之前就发完（分链）；单链时代 B1 要排在 A1+A2+两条 delay 之后
    assert.ok(end('group:789', 0) < start('group:456', 1),
      `B1(end=${end('group:789', 0)}) 应早于 A2(start=${start('group:456', 1)})`);
    // A 群自己仍然保序
    assert.ok(end('group:456', 0) <= start('group:456', 1), 'A1 完成后 A2 才开始');
  } finally { await h.close(); }
});

test('同会话严格保序：并发发起的 burst 与文本按入链顺序执行', async () => {
  const order = [];
  const h = await bridgeHarness({
    globals: {
      botSendHook: async (kind, id, text) => {
        order.push(`${kind}:${id}:${text}`);
        await sleep(20);
      }
    }
  });
  try {
    h.setMode('reserved2');
    const burstPromise = h.sendBurstToQQ('group:456', ['第一条', '第二条'], { burstIntervalMinMs: 10, burstIntervalMaxMs: 10 });
    const textPromise = h.sendToQQ('group:456', '第三条');
    const [sent] = await Promise.all([burstPromise, textPromise]);
    // 跨 VM 边界数组不能 deepStrictEqual（原型不同），逐元素比较
    assert.equal(sent.length, 2);
    assert.equal(sent[0], '第一条');
    assert.equal(sent[1], '第二条');
    assert.deepEqual(order.filter((o) => o.startsWith('group:456')), ['group:456:第一条', 'group:456:第二条', 'group:456:第三条'],
      'burst 与文本同会话严格按入链顺序');
  } finally { await h.close(); }
});

test('链尾清理：发送完成后 sendChains 里不留空转条目', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    await h.sendToQQ('group:456', '一条');
    await h.sendToQQ('group:789', '两条');
    for (let i = 0; i < 50 && h.sendChains.size > 0; i += 1) await sleep(20);
    assert.equal(h.sendChains.size, 0, `Map 不应无界增长（当前 ${h.sendChains.size}）`);
  } finally { await h.close(); }
});

test('sendMessagesV2 失败路径仍然回滚记账且不炸链（部分成功保留）', async () => {
  const h = await bridgeHarness({
    globals: {
      // sendMessagesV2 → onebotSend 走 HTTP fetch；在 fetch 层注入失败
      fetchHook: async (url, init) => {
        if (String(init?.body ?? '').includes('会失败的')) throw new Error('gateway down');
      }
    }
  });
  try {
    h.setMode('reserved2');
    await assert.rejects(
      h.sendMessagesV2('group:456', ['先成功', '会失败的', '不该发'], [0, 0]),
      /发送失败 1\/3 条：gateway down/
    );
    assert.equal(h.lastSendSucceeded('group:456'), false, '失败要记入 lastSendFailed');
    // 链没有死：下一条照常发送
    await h.sendToQQ('group:456', '恢复后的消息');
    assert.ok(h.calls.sent.some((m) => m.text === '恢复后的消息'));
  } finally { await h.close(); }
});

// ── AI 通道发送前重查：静默 / 暂停 / 关闭，出站瞬间生效 ─────────────────────
test('AI 发送前重查：链排队期间切暂停/关闭，AI 出站被拦；操作者通道不受限', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.socialV2.paused = true;
    await assert.rejects(h.sendMessagesV2('group:456', ['暂停期的消息'], []),
      /二代 AI 活动已被暂停/, '暂停后 AI 出站必须被拦');
    // 操作者通道（sendToQQ 不带 ai）：不受暂停约束
    await h.sendToQQ('group:456', '操作者消息照常');
    assert.ok(h.calls.sent.some((m) => m.text === '操作者消息照常'));
    h.socialV2.paused = false;
    h.cfg.socialV2.enabled = false;
    await assert.rejects(h.sendMessagesV2('group:456', ['关闭后的消息'], []),
      /二代功能已关闭/, '关闭后 AI 出站必须被拦');
  } finally { await h.close(); }
});

test('AI 发送前重查：静默模式（role state 文件）拦截群聊 AI 出站，owner 私聊例外', async () => {
  const h = await bridgeHarness({
    files: { 'state/current-role.json': { role: null, mode: 'silent' } }
  });
  try {
    h.setMode('reserved2');
    await assert.rejects(h.sendMessagesV2('group:456', ['静默期的消息'], []),
      /静默模式已开启/, '静默下 AI 群聊出站必须被拦');
    // owner 私聊例外：照常可发（sendMessagesV2 → onebotSend 走 fetch，落 calls.http）
    await h.sendMessagesV2('private:123', ['主人的私聊'], []);
    assert.ok(h.calls.http.some((c) => String(c?.body?.message?.[0]?.data?.text ?? '') === '主人的私聊'),
      'owner 私聊不受静默限制');
  } finally { await h.close(); }
});
