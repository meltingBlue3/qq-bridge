// wake-policy 纯函数回归：不读 bridge、不碰状态文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWakeSafetyV2,
  defaultWakeConfigV2,
  hasExplicitEndV2,
  isSleepingConfigV2,
  isTimerWakeReason,
  isWakeableConfigV2,
  normalizeSpeakerIdsV2,
  pickWakeTriggersV2,
  preSleepWaitBlockedV2,
  refreshDefaultWakeConfigV2,
  wakePriorityV2,
  wakeReasonSeq
} from '../src/social-v2/wake-policy.js';

test('normalizeSpeakerIdsV2 只保留正整数并去重/限量', () => {
  assert.deepEqual(normalizeSpeakerIdsV2(['123', '00123', 'x', null, 456, '123']), ['123', '456']);
  assert.deepEqual(normalizeSpeakerIdsV2('123,456，789'), ['123', '456', '789']);
  assert.deepEqual(normalizeSpeakerIdsV2(Array.from({ length: 30 }, (_, i) => String(i + 1))).length, 20);
});

test('pickWakeTriggersV2 只允许已知字段', () => {
  const out = pickWakeTriggersV2({ atMention: true, garbage: 'x', probability: 0.1 }, { nameMention: true });
  assert.deepEqual(out, { atMention: true, nameMention: true, probability: 0.1 });
});

test('defaultWakeConfigV2 按推荐值生成且有限潜水时间受上下限约束', () => {
  const wc = defaultWakeConfigV2({
    defaultMode: 'diving',
    recommendedDefaultInfinite: false,
    recommendedSleepMinMs: 1000,
    recommendedSleepMaxMs: 2000,
    sleepMinMs: 5000,
    sleepMaxMs: 8000,
    recommendedKeywords: ['小鲸鱼', 'DeepSeek']
  }, { now: 1000, random: () => 0 });
  assert.equal(wc.infinite, false);
  assert.equal(wc.sleepUntil, new Date(6000).toISOString());
  assert.deepEqual(wc.triggers.keywords, ['小鲸鱼', 'DeepSeek']);
  assert.equal(wc.confirmedBy, 'default');
});

test('refreshDefaultWakeConfigV2 只覆盖默认配置', () => {
  const st = { wakeConfig: { ...defaultWakeConfigV2({}, { now: 0, random: () => 0 }), wakeCount: 3 } };
  assert.equal(refreshDefaultWakeConfigV2(st, {}), true);
  assert.equal(st.wakeConfig.wakeCount, 3);
  st.wakeConfig.confirmedBy = 'set_wake_config';
  assert.equal(refreshDefaultWakeConfigV2(st, {}), false);
});

test('preSleepWaitBlockedV2 覆盖静默已满 / 已观察 / 明确结束 / 关闭开关', () => {
  const base = { lastIncomingAt: 1000, preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0 };
  assert.equal(preSleepWaitBlockedV2(base, { preSleepWaitMs: 1000 }, 3000), false, '已安静满窗口');
  assert.equal(preSleepWaitBlockedV2({ ...base, lastIncomingAt: 0 }, { preSleepWaitMs: 1000 }, 3000), true);
  assert.equal(preSleepWaitBlockedV2({ ...base, lastIncomingAt: 0, preSleepWaitSatisfiedAt: 500 }, { preSleepWaitMs: 1000 }, 3000), false);
  assert.equal(preSleepWaitBlockedV2({ ...base, lastIncomingAt: 0, preSleepWaitObservedAt: 500 }, { preSleepWaitMs: 1000 }, 3000), false);
  assert.equal(preSleepWaitBlockedV2(base, { preSleepWaitEnabled: false }, 3000), false);
  assert.equal(preSleepWaitBlockedV2({ ...base, lastIncomingAt: 0, recentMessages: [{ isSelf: false, text: '晚安' }] }, { preSleepWaitMs: 1000 }, 3000), false);
});

test('isSleepingConfigV2 / isWakeableConfigV2 / computeWakeSafetyV2', () => {
  assert.equal(isSleepingConfigV2({ mode: 'diving' }), true);
  assert.equal(isSleepingConfigV2({ mode: 'active' }), false);
  assert.equal(isSleepingConfigV2({ mode: 'diving', triggers: { anyMessage: true } }), false);
  assert.equal(isWakeableConfigV2({ mode: 'diving', triggers: {} }), false);
  assert.equal(isWakeableConfigV2({ mode: 'diving', triggers: { atMention: true } }), true);
  assert.equal(isWakeableConfigV2({ mode: 'diving', triggers: {}, infinite: false, sleepUntil: new Date(9999).toISOString() }, 0), true);
  const safety = computeWakeSafetyV2({ mode: 'diving', triggers: { keywords: ['x'] }, confirmedAt: 0 }, 1000);
  assert.equal(safety.hard, true);
  assert.equal(safety.guaranteed, true);
  assert.equal(safety.stale, true);
});

test('唤醒优先级 / 定时器原因 / seq 解析', () => {
  assert.ok(wakePriorityV2('atMention') > wakePriorityV2('timeout'));
  assert.equal(wakePriorityV2('speaker:小明'), 75);
  assert.equal(isTimerWakeReason('timeout'), true);
  assert.equal(isTimerWakeReason('atMention@seq3'), false);
  assert.equal(wakeReasonSeq('atMention@seq194'), 194);
  assert.equal(wakeReasonSeq('question'), null);
  assert.equal(wakeReasonSeq('atMention@seq0'), null);
});

test('hasExplicitEndV2 只看最后一条别人发的消息', () => {
  assert.equal(hasExplicitEndV2({ recentMessages: [{ isSelf: false, text: '晚安' }] }), true);
  assert.equal(hasExplicitEndV2({ recentMessages: [{ isSelf: true, text: '晚安' }, { isSelf: false, text: '在吗' }] }), false);
});
