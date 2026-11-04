// wake-scheduler 的直接单测：mock timers 控制定时器与时钟。
// 钉住部署语义：合并窗口优先级升级、繁忙暂存有界 20、限频延后重试（不丢弃）、
// 投递失败回滚 wakeTimes + 恢复有限睡眠、远未来定时器 100s 续期、
// 回放时「消息类查 unread / 定时器类直接补排」两类语义、判忙租约。
// 注意：mock Date 默认纪元是 0，必须指定 now，否则 Date.now()-偏移 会变负数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeScheduler } from '../src/social-v2/wake-scheduler.js';
import { defaultWakeConfigV2 } from '../src/social-v2/wake-policy.js';

const MOCK_NOW = 1700000000000;

function setup({ mode = 'reserved2', paused = false, enabled = true, proactiveEnabled = false, wakeCfg = {} } = {}) {
  const socialV2 = { paused, conversations: new Map() };
  const pendingWakeKeys = new Set();
  const promptQueues = new Map();
  const v2TurnStartAt = new Map();
  const collectors = new Map();
  const turnLeaseNoted = new Set();
  const sessions = {};
  const calls = { deliver: [], saves: 0, logs: [], armed: [], disarmed: [] };
  let deliverBehavior = null; // null=成功；{ ok:false, error }；Error 实例=抛出
  const stateFor = (key) => {
    if (!socialV2.conversations.has(key)) {
      socialV2.conversations.set(key, {
        wakeConfig: defaultWakeConfigV2(wakeCfg),
        recentMessages: [], unread: [], wakeTimes: [], sendTimes: [],
        pendingWakeTimer: null, pendingWakeReason: null, pendingWakeReasons: [],
        sleepTimer: null, replyCheckTimer: null, proactiveTimer: null, rateLimitRetryTimer: null,
        lastUnreadSeq: 0, lastAiReplyAt: 0, lastIncomingAt: 0, lastWakeReason: '',
        pendingThoughts: [], agentToken: 'tok', preSleepWaitSatisfiedAt: 0
      });
    }
    return socialV2.conversations.get(key);
  };
  const scheduler = createWakeScheduler({
    cfg: { socialV2: { enabled, wake: wakeCfg, proactive: { enabled: proactiveEnabled } }, autoReplyCheckMs: 30000 },
    log: (...a) => calls.logs.push(a.join(' ')),
    socialV2,
    getCurrentMode: () => mode,
    getSocialV2State: stateFor,
    saveSocialV2State: () => { calls.saves += 1; },
    isSessionAllowed: () => true,
    ensureWakeable: () => {},
    buildWakePrompt: (key, reason) => `prompt:${key}:${reason}`,
    deliverPrompt: async (key, text, opts) => {
      calls.deliver.push({ key, text, opts });
      if (deliverBehavior instanceof Error) throw deliverBehavior;
      return deliverBehavior ?? { ok: true };
    },
    pendingWakeKeys,
    armPendingWakeLease: (k) => calls.armed.push(k),
    disarmPendingWakeLease: (k) => calls.disarmed.push(k),
    promptQueues,
    getSessions: () => sessions,
    v2TurnStartAt,
    collectors,
    turnLeaseNoted,
    turnBusyLeaseMs: 15 * 60 * 1000
  });
  return { scheduler, socialV2, pendingWakeKeys, promptQueues, v2TurnStartAt, collectors, turnLeaseNoted, sessions, calls, stateFor, setDeliver: (b) => { deliverBehavior = b; } };
}

test('scheduleWake：合并窗口内按优先级升级原因；到期后按最终原因投递', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.scheduler.scheduleWake('group:1', 'anyMessage:1');
  const st = h.stateFor('group:1');
  assert.ok(st.pendingWakeTimer, '合并窗口定时器已排');
  h.scheduler.scheduleWake('group:1', 'anyMessage:2');
  h.scheduler.scheduleWake('group:1', 'atMention:123');
  assert.equal(st.pendingWakeReason, 'atMention:123', '高优先级原因升级（50 -> 90）');
  await t.mock.timers.tick(8000);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.deliver.length, 1);
  assert.equal(h.calls.deliver[0].text, 'prompt:group:1:atMention:123');
  assert.equal(st.pendingWakeTimer, null);
});

test('scheduleWake：模式关闭直接跳过；繁忙时暂存（有界 20）；回放按 unread 水位分流', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const off = setup({ mode: 'chat' });
  off.scheduler.scheduleWake('group:1', 'atMention:1');
  assert.equal(off.calls.deliver.length, 0);
  const h = setup();
  h.pendingWakeKeys.add('group:1'); // 判忙
  const st0 = h.stateFor('group:1');
  st0.lastUnreadSeq = 5;
  for (let i = 0; i < 25; i++) h.scheduler.scheduleWake('group:1', `keyword:w${i}`);
  const st = h.stateFor('group:1');
  assert.equal(st.pendingWakeReasons.length, 20, '暂存队列有界 20');
  assert.equal(st.pendingWakeReasons[0].reason, 'keyword:w5', '最旧的被挤出');
  // 回放：unread 里已没有 >= seq 的消息 → 被当前回合处理（skipped）
  st.lastUnreadSeq = 99;
  h.pendingWakeKeys.delete('group:1'); // 解除判忙，回放的 scheduleWake 才能真正排窗
  st.unread = [{ seq: 1 }];
  const r1 = h.scheduler.replayPendingWakeReasons('group:1');
  assert.equal(r1.action, 'skipped');
  // unread 里还有 >= seq 的消息 → 仍然相关，补发
  st.unread = [{ seq: 99 }];
  const r2 = h.scheduler.replayPendingWakeReasons('group:1');
  assert.equal(r2.action, 'replayed');
  assert.ok(st.pendingWakeTimer, '补发走 scheduleWake（等合并窗口）');
});

test('replayPendingWakeReasons：定时器类直接补排（timeout→setupSleepTimer，replyCheck→scheduleReplyCheck）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCK_NOW });
  const h = setup();
  const st = h.stateFor('group:1');
  st.pendingWakeReasons = [{ reason: 'timeout', seq: 0 }];
  st.wakeConfig = { ...st.wakeConfig, infinite: false, sleepUntil: new Date(Date.now() + 60000).toISOString() };
  const r = h.scheduler.replayPendingWakeReasons('group:1');
  assert.equal(r.action, 'timer');
  assert.ok(st.sleepTimer, 'timeout 被补排为有限潜水定时器（而不是被 unread 判断吞掉）');
  const h2 = setup();
  h2.stateFor('group:1').pendingWakeReasons = [{ reason: 'replyCheck', seq: 0 }];
  const r2 = h2.scheduler.replayPendingWakeReasons('group:1');
  assert.equal(r2.action, 'timer');
  assert.ok(h2.stateFor('group:1').replyCheckTimer, 'replyCheck 被补排');
  const h3 = setup();
  h3.stateFor('group:1').pendingWakeReasons = [{ reason: 'proactiveCheck', seq: 0 }];
  const r3 = h3.scheduler.replayPendingWakeReasons('group:1');
  assert.equal(r3.action, 'timer');
  assert.equal(h3.stateFor('group:1').proactiveTimer, null, '主动机会错过即跳过，不立刻补刀');
});

test('replayPendingWakeReasons：点名类（@/私聊/名字/拍一拍）已读也补发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCK_NOW });
  // 未读已全部被当前回合标读（unread 空、水位远超 seq）——点名类仍必须补发
  for (const reason of ['atMention', 'atMention:7', 'private', 'nameMention', 'poke']) {
    const h = setup();
    const st = h.stateFor('group:1');
    st.pendingWakeReasons = [{ reason, seq: 3 }];
    st.unread = [];
    st.lastUnreadSeq = 99;
    const r = h.scheduler.replayPendingWakeReasons('group:1');
    assert.equal(r.action, 'replayed', `${reason} 是点名类：已读≠已回应`);
    assert.ok(st.pendingWakeTimer, `${reason} 补发走 scheduleWake`);
  }
  // 非点名类仍按 unread 判断：未读里没有对应 seq → skipped（防每回合被旧消息惊动）
  const h2 = setup();
  h2.stateFor('group:1').pendingWakeReasons = [{ reason: 'keyword:晚安', seq: 3 }];
  h2.stateFor('group:1').unread = [];
  h2.stateFor('group:1').lastUnreadSeq = 99;
  assert.equal(h2.scheduler.replayPendingWakeReasons('group:1').action, 'skipped');
  // 无效条目（历史脏数据）被丢弃并继续取下一条，不占补发机会
  const h3 = setup();
  h3.stateFor('group:1').pendingWakeReasons = [null, '垃圾', { reason: 'atMention', seq: 1 }];
  const r3 = h3.scheduler.replayPendingWakeReasons('group:1');
  assert.equal(r3?.action, 'replayed');
  assert.equal(h3.stateFor('group:1').pendingWakeReasons.length, 0, '无效条目一并清空');
});

test('sendWakePrompt：限频延后重试；重试前消息类原因 unread 清空则跳过', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCK_NOW });
  const h = setup({ wakeCfg: { maxWakePerMinute: 1 } });
  const st = h.stateFor('group:1');
  st.wakeTimes.push(Date.now());
  await h.scheduler.sendWakePrompt('group:1', 'atMention:7');
  assert.equal(h.calls.deliver.length, 0, '限频内不投递');
  assert.ok(st.rateLimitRetryTimer, '但排了重试定时器（不丢弃）');
  // 部署语义：重试等待 ≈ 60s - 已流逝 + 500ms；本次窗口刚用过 → 等 ~60.5s
  // 重试前未读已清空 → 跳过
  await t.mock.timers.tick(60500);
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
  assert.equal(h.calls.deliver.length, 0);
  assert.match(h.calls.logs.join('\n'), /限频重试前发现未读已清空/);
  // 定时器类原因不受 unread 检查约束：重新占满窗口后再来一次 timeout 重试会投递
  st.wakeTimes.push(Date.now());
  await h.scheduler.sendWakePrompt('group:1', 'timeout');
  assert.ok(st.rateLimitRetryTimer);
  await t.mock.timers.tick(60500);
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
  assert.equal(h.calls.deliver.length, 1, 'timeout 是定时器类原因，重试直接投递');
  assert.equal(h.calls.deliver[0].opts.wakeReason, 'timeout');
});

test('sendWakePrompt：成功路径记账 + 重置观察窗口 + 取消回复检查；投递被拒/失败回滚', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCK_NOW });
  const h = setup();
  const st = h.stateFor('group:1');
  st.wakeConfig = { ...st.wakeConfig, infinite: false, sleepUntil: new Date(Date.now() + 60000).toISOString() };
  st.replyCheckTimer = setTimeout(() => {}, 99999);
  st.preSleepWaitSatisfiedAt = 123;
  await h.scheduler.sendWakePrompt('group:1', 'atMention:1');
  assert.equal(h.calls.deliver.length, 1);
  assert.equal(st.wakeConfig.wakeCount, 1);
  assert.equal(st.wakeConfig.sleepUntil, null, '有限睡眠在唤醒时清空');
  assert.equal(st.preSleepWaitSatisfiedAt, 0, '真实唤醒重置观察窗口');
  assert.equal(st.replyCheckTimer, null, '回复检查被取消');
  assert.ok(h.pendingWakeKeys.has('group:1'), '成功投递保留 pendingWakeKeys（等 turn/end 收尾）');

  // 投递失败 → wakeTimes 回滚 + 有限睡眠恢复 + 重新排睡眠定时器
  const h2 = setup();
  const st2 = h2.stateFor('group:1');
  st2.wakeConfig = { ...st2.wakeConfig, infinite: false, sleepUntil: new Date(Date.now() + 60000).toISOString() };
  h2.setDeliver(new Error('DSH 不可用'));
  await h2.scheduler.sendWakePrompt('group:1', 'atMention:2');
  assert.equal(st2.wakeTimes.length, 0, '失败的唤醒时间被回滚');
  assert.equal(st2.wakeConfig.infinite, false);
  assert.ok(st2.wakeConfig.sleepUntil, 'sleepUntil 恢复');
  assert.ok(st2.sleepTimer, '睡眠定时器重新排上');
  assert.equal(h2.pendingWakeKeys.has('group:1'), false);
  assert.ok(h2.calls.disarmed.includes('group:1'));

  // 投递被拒（ok:false）→ 同样回滚
  const h3 = setup();
  const st3 = h3.stateFor('group:1');
  h3.setDeliver({ ok: false, error: '被拒' });
  await h3.scheduler.sendWakePrompt('group:1', 'atMention:3');
  assert.equal(st3.wakeTimes.length, 0);
  assert.equal(h3.pendingWakeKeys.has('group:1'), false);

  // 入队（queued:true）→ 保留 pendingWakeKeys 不回滚
  const h4 = setup();
  h4.setDeliver({ queued: true });
  await h4.scheduler.sendWakePrompt('group:1', 'atMention:4');
  assert.equal(h4.pendingWakeKeys.has('group:1'), true);
  assert.ok(h4.stateFor('group:1').wakeTimes.length, '入队路径不回滚 wakeTimes');
});

test('setupSleepTimer：infinite/无 sleepUntil 不排；已过期立即唤醒；远未来 100s 续期', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCK_NOW });
  const h = setup();
  const st = h.stateFor('group:1');
  h.scheduler.setupSleepTimer('group:1');
  assert.equal(st.sleepTimer, null, 'infinite 默认配置不排定时器');
  st.wakeConfig = { ...st.wakeConfig, infinite: false, sleepUntil: new Date(Date.now() - 1).toISOString() };
  h.scheduler.setupSleepTimer('group:1');
  await Promise.resolve();
  assert.equal(h.calls.deliver.length, 1, '已过期 → 立即 timeout 唤醒');
  assert.equal(h.calls.deliver[0].opts.wakeReason, 'timeout');

  const h2 = setup();
  const st2 = h2.stateFor('group:1');
  st2.wakeConfig = { ...st2.wakeConfig, infinite: false, sleepUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  h2.scheduler.setupSleepTimer('group:1');
  assert.ok(st2.sleepTimer, '远未来首段已排');
  await t.mock.timers.tick(100009);
  await new Promise((r) => setImmediate(r));
  assert.ok(st2.sleepTimer, '100s 后续期而不是提前唤醒');
  assert.equal(h2.calls.deliver.length, 0);

  const h3 = setup();
  const st3 = h3.stateFor('group:1');
  st3.wakeConfig = { ...st3.wakeConfig, infinite: false, sleepUntil: new Date(Date.now() + 5000).toISOString() };
  h3.scheduler.setupSleepTimer('group:1');
  await t.mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
  assert.equal(h3.calls.deliver.length, 1, '到期 timeout 唤醒');
});

test('isConversationBusy：四类忙源 + 租约过期解除（每 sid 只记一次日志）', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: MOCK_NOW });
  const h = setup();
  const st = h.stateFor('group:1');
  st.pendingWakeTimer = setTimeout(() => {}, 999);
  assert.equal(h.scheduler.isConversationBusy('group:1', st), true);
  assert.equal(h.scheduler.busyReason('group:1', st), 'pendingWakeTimer');
  st.pendingWakeTimer = null;

  h.pendingWakeKeys.add('group:1');
  assert.equal(h.scheduler.isConversationBusy('group:1', st), true);
  assert.equal(h.scheduler.busyReason('group:1', st), 'pendingWakeKey');
  h.pendingWakeKeys.delete('group:1');

  h.promptQueues.set('group:1', { running: true, queue: [] });
  assert.equal(h.scheduler.busyReason('group:1', st), 'promptRunning');
  h.promptQueues.set('group:1', { running: false, queue: [{}] });
  assert.equal(h.scheduler.busyReason('group:1', st), 'promptQueued');
  h.promptQueues.delete('group:1');

  h.sessions['group:1'] = 'sid-1';
  h.v2TurnStartAt.set('sid-1', Date.now() - 1000);
  assert.equal(h.scheduler.isConversationBusy('group:1', st), true, '回合租约内判忙');
  h.collectors.set('sid-1', { pending: [] }); // 租约过期日志只在 collector 仍存在时记
  h.v2TurnStartAt.set('sid-1', Date.now() - 16 * 60 * 1000);
  assert.equal(h.scheduler.isConversationBusy('group:1', st), false, '租约过期解除忙碌');
  assert.ok(h.turnLeaseNoted.has('sid-1'), '租约过期日志去重');
});

test('clearTimers / clearAllTimers：清掉全部定时器与暂存队列', () => {
  const h = setup();
  const st = h.stateFor('group:1');
  st.pendingWakeTimer = setTimeout(() => {}, 99999);
  st.sleepTimer = setTimeout(() => {}, 99999);
  st.replyCheckTimer = setTimeout(() => {}, 99999);
  st.proactiveTimer = setTimeout(() => {}, 99999);
  st.rateLimitRetryTimer = setTimeout(() => {}, 99999);
  st.pendingWakeReason = 'atMention:1';
  st.pendingWakeReasons = [{ reason: 'keyword:x', seq: 2 }];
  h.scheduler.clearTimers('group:1');
  assert.equal(st.pendingWakeTimer, null);
  assert.equal(st.sleepTimer, null);
  assert.equal(st.replyCheckTimer, null);
  assert.equal(st.proactiveTimer, null);
  assert.equal(st.rateLimitRetryTimer, null);
  assert.equal(st.pendingWakeReason, null);
  assert.deepEqual(st.pendingWakeReasons, []);
  h.stateFor('group:2').sleepTimer = setTimeout(() => {}, 99999);
  h.scheduler.clearAllTimers();
  assert.equal(h.stateFor('group:2').sleepTimer, null);
});

test('scheduleReplyCheck：排队中不重复安排；提问/连发延长检查间隔', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCK_NOW });
  const h = setup();
  const st = h.stateFor('group:1');
  h.scheduler.scheduleReplyCheck('group:1');
  const first = st.replyCheckTimer;
  assert.ok(first);
  h.scheduler.scheduleReplyCheck('group:1');
  assert.equal(st.replyCheckTimer, first, '已有排队不重复安排');
});
