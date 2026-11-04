// 稳定规则入 system（会话方反馈第二轮）：persona 载荷 = 角色卡 + 身份/令牌/规则后缀；
// 唤醒提示词只留动态数据。身份/令牌/机制规则每回合随用户消息重发既拉低优先级、
// 也吃不到 prompt cache——迁移后 system 段稳定，用户消息逐回合变化互不影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildReserved2PersonaSuffix, buildTimeSenseRulesText } from '../src/social-v2/persona-suffix.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('buildTimeSenseRulesText：档位渲染 + 阈值抬平 + 中间档省略', () => {
  const t = buildTimeSenseRulesText({ chatMin: 10, silentMin: 120 });
  assert.match(t, /【时间感规则】/);
  assert.match(t, /10 分钟以内：正常接/);
  assert.match(t, /10～120 分钟/);
  assert.match(t, /超过 120 分钟：默认不回/);
  const flat = buildTimeSenseRulesText({ chatMin: 60, silentMin: 15 });
  assert.doesNotMatch(flat, /60～60/, '抬平后不能出现自相矛盾的「60～60」');
  assert.match(flat, /超过 60 分钟/);
});

test('buildReserved2PersonaSuffix：空段跳过、段落顺序稳定', () => {
  const bare = buildReserved2PersonaSuffix({});
  assert.match(bare, /【反AI味】/);
  assert.match(bare, /【积极性】/);
  assert.match(bare, /【首回复节奏】/);
  assert.ok(!bare.includes('【你的身份】'), '身份未知时不产生空段');
  assert.ok(!bare.includes('【会话令牌】'));
  assert.ok(!bare.includes('【时间感规则】'), '不传 timeSense 就不含时间感档位');

  const full = buildReserved2PersonaSuffix({
    identity: '【你的身份】你在 QQ 上的昵称是「樰」（QQ 10001）。',
    token: '【会话令牌】tok-1（调用二代状态工具时请在参数中带上此令牌）',
    stickerStrategy: '【表情包策略：像真人一样用，别当装饰】',
    timeSense: { chatMin: 10, silentMin: 120 }
  });
  const markers = ['【你的身份】', '【会话令牌】', '【反AI味】', '【积极性】', '【表情包策略', '【首回复节奏】', '【时间感规则】'];
  const order = markers.map((k) => full.indexOf(k));
  assert.deepEqual([...order].sort((a, b) => a - b), order, '段落顺序稳定（身份→令牌→规则）');
});

test('persona 载荷：身份/令牌/规则进 system，唤醒提示词只留动态数据', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.setSelfIdentity('樰', '10001');
    const st = h.getSocialV2State('group:456');
    for (let i = 1; i <= 3; i += 1) {
      h.appendSocialV2Message('group:456', `群友${i}`, `消息${i}`, `消息${i}`, false, false, 2000 + i);
    }
    h.syncPersonaForSession('fixture-1', 'reserved2', 'group:456');
    const personaFile = path.join(h.temp, 'qq-persona', 'fixture-1.md');
    const persona = fs.readFileSync(personaFile, 'utf8');
    assert.match(persona, /【你的身份】/);
    assert.match(persona, /10001/);
    assert.match(persona, new RegExp(`【会话令牌】${st.agentToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(persona, /【反AI味】/);
    assert.match(persona, /【积极性】/);
    assert.match(persona, /【首回复节奏】/);
    assert.match(persona, /【时间感规则】/);

    // 唤醒提示词：稳定段全部退场，动态数据全部在场
    const prompt = h.buildWakePromptV2('group:456', 'atMention');
    for (const gone of ['【你的身份】', '【会话令牌】', '【反AI味】', '【积极性】', '【首回复节奏】', '【时间感规则】', '【沉睡前强制等待】', '【当前角色】']) {
      assert.ok(!prompt.includes(gone), `唤醒提示词不应再携带 ${gone}`);
    }
    assert.match(prompt, /【此刻状态】/);
    assert.match(prompt, /【当前唤醒】/);
    assert.match(prompt, /【唤醒】/);
    assert.match(prompt, /【时间感】/, '时间感的「此刻判断」仍在用户消息');

    // 令牌轮换 → persona 按内容比对重写
    st.agentToken = 'rotated-token-x';
    h.syncPersonaForSession('fixture-1', 'reserved2', 'group:456');
    assert.match(fs.readFileSync(personaFile, 'utf8'), /rotated-token-x/);

    // 表情体系关闭 → persona 不含表情策略段
    const h2 = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false } } } });
    try {
      h2.setMode('reserved2');
      h2.syncPersonaForSession('fixture-1', 'reserved2', 'group:456');
      assert.doesNotMatch(fs.readFileSync(path.join(h2.temp, 'qq-persona', 'fixture-1.md'), 'utf8'), /【表情包策略/);
    } finally { await h2.close(); }
  } finally { await h.close(); }
});

test('引导/收尾提醒同样瘦身（身份/令牌只来自 system）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.setSelfIdentity('樰', '10001');
    const bootstrap = h.buildWakePromptV2('group:456', 'bootstrap');
    assert.match(bootstrap, /【引导唤醒】/);
    assert.ok(!bootstrap.includes('【你的身份】'));
    assert.ok(!bootstrap.includes('【会话令牌】'));
    const reminder = h.buildWakeReminderPromptV2('group:456');
    assert.match(reminder, /【提醒】/);
    assert.ok(!reminder.includes('【你的身份】'));
    assert.ok(!reminder.includes('【会话令牌】'));
    assert.ok(!reminder.includes('timeoutMs=300000'), '提醒不再硬编码观察窗口');
  } finally { await h.close(); }
});
