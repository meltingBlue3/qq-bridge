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
  preSleepWaitWindowMsV2,
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

// ── 会话方反馈⑤：观察窗口按活跃度自适应，显式配置是上限 ──────────────────
const now = 1_000_000;
const inbound = (ageMs, isSelf = false) => ({ isSelf, time: now - ageMs, text: 'x' });

test('preSleepWaitWindowMsV2：冷清会话缩窗、热闹会话保满、自适应只缩短不拉长', () => {
  const cfg = { preSleepWaitMs: 300000 };
  // 冷清（≤2 条/10min）：base/5，不高于地板 60s
  assert.equal(preSleepWaitWindowMsV2({ recentMessages: [inbound(60000)] }, cfg, now), 60000);
  assert.equal(preSleepWaitWindowMsV2({ recentMessages: [] }, cfg, now), 60000);
  // 中等（3–5 条）：base/2
  assert.equal(
    preSleepWaitWindowMsV2({ recentMessages: [inbound(1), inbound(2), inbound(3)] }, cfg, now), 150000
  );
  // 热闹（≥6 条）：保满 base
  assert.equal(
    preSleepWaitWindowMsV2({ recentMessages: Array.from({ length: 6 }, (_, i) => inbound(i + 1)) }, cfg, now),
    300000
  );
  // 自消息不算活跃度；10 分钟外的来信不算
  assert.equal(
    preSleepWaitWindowMsV2({ recentMessages: [inbound(1000, true), inbound(700000), inbound(800000)] }, cfg, now),
    60000
  );
});

test('preSleepWaitWindowMsV2：显式配置是上限，小窗口不被地板拉高', () => {
  // 测试/强力用户把窗口配成 200ms：自适应档位都不该把它拉高（否则既有语义全变）
  const tiny = { preSleepWaitMs: 200 };
  assert.equal(preSleepWaitWindowMsV2({ recentMessages: [] }, tiny, now), 200);
  assert.equal(
    preSleepWaitWindowMsV2({ recentMessages: Array.from({ length: 8 }, (_, i) => inbound(i + 1)) }, tiny, now),
    200
  );
  // 地板可配：preSleepWaitMinMs=0 时冷清档就是 base/5
  const noFloor = { preSleepWaitMs: 300000, preSleepWaitMinMs: 0 };
  assert.equal(preSleepWaitWindowMsV2({ recentMessages: [] }, noFloor, now), 60000);
  // preSleepWaitMs=0 按仓库既有约定回落默认 300000（`|| 300000`，见 session-routes/
  // wait-route 的旧实现）；真想关闭走 preSleepWaitEnabled=false。
  assert.equal(preSleepWaitWindowMsV2({}, { preSleepWaitMs: 0 }, now), 60000);
});

test('preSleepWaitBlockedV2 与自适应窗口联动：冷清会话安静更久即放行', () => {
  const cfg = { preSleepWaitMs: 300000 };
  // 冷清会话窗口 60s：最后来信 61s 前 → 放行（旧实现要等满 300s）
  const quiet = { lastIncomingAt: now - 61000, preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, recentMessages: [inbound(61000)] };
  assert.equal(preSleepWaitBlockedV2(quiet, cfg, now), false, '冷清会话 61s 静默就该放行');
  // 热闹会话窗口仍 300s：61s 静默不放行
  const lively = { lastIncomingAt: now - 61000, preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, recentMessages: Array.from({ length: 6 }, (_, i) => inbound(61000 + i)) };
  assert.equal(preSleepWaitBlockedV2(lively, cfg, now), true, '热闹会话仍需等满长窗口');
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
