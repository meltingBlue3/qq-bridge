// qq_get_prompt 的 role.hint 出口：必须返回真实卡文，不再是空串死胡同。
// 背景：唤醒/收尾提示词里的「当前角色」行长期写着「完整角色卡请调用
// qq_get_prompt 查看」，但 qq_get_prompt 的 role.hint 恒为空串——模型按
// 指引调了工具也拿不到卡文，是一条例行却从没人踩过的死胡同。
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const notifySrc = fs.readFileSync(path.join(root, 'src/http/notify-routes.js'), 'utf8');
const configExample = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));

test('currentRoleHintV2 返回真实卡文（roleTextV2），不再空串', () => {
  assert.match(bridgeSrc, /function currentRoleHintV2\(\)[\s\S]{0,400}return roleTextV2\(\);/);
});

test('「完整角色卡请调用 qq_get_prompt 查看」的死胡同文案已消失', () => {
  assert.ok(!bridgeSrc.includes('完整角色卡请调用'), 'bridge.js 不得再引导模型去调一个拿不到卡文的工具');
  assert.ok(!notifySrc.includes('完整角色卡请调用'), 'notify-routes.js 同样');
  // N2 分层迁移：角色指针行（【当前角色】X（角色卡已随系统提示注入…））整体退场——
  // 卡文本身随 persona 载荷进 system（syncPersonaForSession 每次投递前同步）。
  assert.ok(!bridgeSrc.includes('角色卡已随系统提示注入'), '角色指针已迁 system（persona 载荷）');
  assert.ok(!notifySrc.includes('角色卡已随系统提示注入'), 'notify 同样');

});

test('每次投递前会按目标会话模式同步 persona 载荷', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    let checked = 0;
    h.api.sessions.prompt = async ({ sessionId }) => {
      const persona = fs.readFileSync(path.join(h.temp, 'qq-persona', `${sessionId}.md`), 'utf8');
      assert.ok(persona.includes(h.getSocialV2State('group:456').agentToken));
      checked++;
      return { result: { ok: true, value: {} } };
    };
    await h.deliverPrompt('group:456', 'fixture');
    assert.equal(checked, 1);
  } finally { await h.close(); }
});

test('config.example.json 的 maxInjectChars 与代码默认（8000）对齐', () => {
  assert.equal(configExample.role?.maxInjectChars, 8000);
});

test('qq_get_prompt 路由把 currentRoleHintV2 的返回透传给 role.hint（有卡文时）', async () => {
  // 路由级验证：stub 的 currentRoleHintV2 返回卡文时，响应 role.hint 必须是它。
  const { handleSocialV2SessionRoutes } = await import('../src/http/socialv2-session-routes.js');
  const deps = {
    cfg: { socialV2: { tools: {}, wake: {}, send: {}, wait: {}, sticker: { enabled: false }, voice: { enabled: false } }, slang: { enabled: false } },
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getCurrentMode: () => 'reserved2',
    getSocialV2State: () => ({
      wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true }, batchWindowMs: 8000 },
      unread: [], recentMessages: [], lastUnreadSeq: 0, lastIncomingAt: 0,
      preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, preSleepWaitAccumMs: 0
    }),
    saveSocialV2State: () => {},
    computeWakeSafetyV2: () => ({ hard: true, timed: false, soft: false, guaranteed: true, stale: false }),
    isSleepingConfigV2: () => true,
    preSleepWaitBlockedV2: () => false,
    pickWakeTriggersV2: (s, fb) => fb ?? {},
    normalizeSpeakerIdsV2: () => [],
    readThroughSeqV2: () => 0,
    requestedReadThroughSeqV2: () => null,
    noteModelMessagesV2: () => 0,
    readRoleState: () => ({ role: '测试卡', mode: 'active' }),
    currentRoleHintV2: () => '【测试卡正文】你是谁谁。',
    stickerEnabled: () => false,
    getSelfIdentity: () => ({ nickname: 'N', userId: '1', line: '你是 N' }),
    replyTimingV2: () => ({ purpose: 'reply', quietMs: 10000, remainingQuietMs: 0 }),
    formatMemoryV2: () => '',
    formatParticipationV2: () => '',
    confirmedSlangListV2: () => [],
    slangEntries: [],
    buildSlangContext: () => '',
    stickerEntries: [],
    buildStickerContext: () => '',
    buildStickerStrategyHint: () => '',
    voiceLibrary: () => [],
    voiceCfg: () => ({ maxSeconds: 300 })
  };
  const sent = [];
  await handleSocialV2SessionRoutes({
    req: { method: 'GET', headers: { 'x-agent-token': 'tok' } },
    url: new URL('http://127.0.0.1/api/socialV2/prompt?key=group:456'),
    sendJson: (obj, status = 200) => sent.push({ obj, status }),
    readBody: async () => ({}),
    deps
  });
  assert.equal(sent.at(-1).obj.role?.hint, '【测试卡正文】你是谁谁。', 'role.hint 必须承载真实卡文');
});

test('本文件与被改文件语法均可解析（防锚点编辑残骸）', () => {
  execFileSync(process.execPath, ['--check', path.join(root, 'src/bridge.js')]);
  execFileSync(process.execPath, ['--check', path.join(root, 'src/http/notify-routes.js')]);
});
