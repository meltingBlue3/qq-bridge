// voice-routes 的直接路由回归：内存语音配置 + stub 发送/校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleVoiceRoutes } from '../src/http/voice-routes.js';

function harness({ voiceEnabled = false, sendError = null, mode = 'reserved2' } = {}) {
  const cfg = { socialV2: { tools: {} }, allow: { groups: ['456'], private: ['123'] } };
  const sent = [];
  let body = {};
  const budgetChecks = [];
  const budgetCommits = [];
  const deps = {
    cfg,
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getCurrentMode: () => mode,
    modeAllowed: () => true,
    shouldBlockSilentReply: () => false,
    voiceCfg: () => ({
      enabled: voiceEnabled, dir: 'C:/audio', maxSeconds: 300, maxBytes: 20 * 1024 * 1024,
      maxPerMinute: 2, maxPerHour: 10, defaultVolume: 1, loudness: 'normal'
    }),
    inspectAudio: async (file) => ({ ok: true, size: 1024, duration: 3, codec: 'mp3', warnings: [] }),
    resolveVoicePathForOperator: (input) => ({ path: 'C:/audio/hello.mp3', via: 'library' }),
    resolveVoicePathForV2: (input) => ({ path: 'C:/audio/hello.mp3', via: 'library' }),
    voiceBudgetCheck: (scope) => budgetChecks.push(scope),
    voiceBudgetCommit: (scope) => budgetCommits.push(scope),
    sendVoiceV2: async () => { if (sendError) throw new Error(sendError); return { messageId: 1, detail: '3s', audioMode: 'original', audioProcessing: '原始音量' }; },
    sendVoiceForV2: async (key, file, opts) => {
      if (sendError) throw new Error(sendError);
      return { messageId: 2, file: 'C:/audio/hello.mp3', detail: '3s', audioProcessing: '原始音量', verification: { confirmed: true }, readback: null, warnings: [] };
    },
    verifyVoiceMessageSent: async () => ({ confirmed: true }),
    appendActivity: () => {}
  };
  const call = async (method, pathname, bodyValue = {}, headers = {}) => {
    body = bodyValue;
    const handled = await handleVoiceRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, budgetChecks, budgetCommits, deps };
}

test('操作者通道：AI 带 agent token 走 /api/send/voice 被指引改道', async () => {
  const h = harness();
  const result = await h.call('POST', '/api/send/voice', { target: 'group:456', file: 'hello' }, { 'x-agent-token': 't' });
  assert.equal(result.last.status, 403);
  assert.match(result.last.obj.error, /socialV2\/send-voice/);
});

test('操作者通道：dryRun 不预支额度；真发走预算检查+提交+落地校验', async () => {
  const h = harness({ voiceEnabled: true });
  const dry = await h.call('POST', '/api/voice/send', { target: 'group:456', file: 'hello', dryRun: true });
  assert.equal(dry.last.obj.dryRun, true);
  assert.deepEqual(h.budgetChecks, []);
  const real = await h.call('POST', '/api/voice/send', { target: 'group:456', file: 'hello' });
  assert.equal(real.last.obj.ok, true);
  assert.equal(real.last.obj.verified, true);
  assert.deepEqual(h.budgetChecks, ['operator:cli']);
  assert.deepEqual(h.budgetCommits, ['operator:cli']);
});

test('操作者通道不受 voice.enabled 关闭影响', async () => {
  const h = harness({ voiceEnabled: false });
  const result = await h.call('POST', '/api/voice/send', { target: 'group:456', file: 'hello' });
  assert.equal(result.last.obj.ok, true);
});

test('AI 通道：voice.enabled 关闭 403；reserved2 才可用；成功带 verified', async () => {
  const h = harness({ voiceEnabled: false });
  assert.equal((await h.call('POST', '/api/socialV2/send-voice', { key: 'group:456', voice: 'hello' }, { 'x-agent-token': 't' })).last.status, 403);
  const h2 = harness({ voiceEnabled: true, mode: 'chat' });
  assert.equal((await h2.call('POST', '/api/socialV2/send-voice', { key: 'group:456', voice: 'hello' }, { 'x-agent-token': 't' })).last.status, 403);
  const h3 = harness({ voiceEnabled: true });
  const ok = await h3.call('POST', '/api/socialV2/send-voice', { key: 'group:456', voice: 'hello' }, { 'x-agent-token': 't' });
  assert.equal(ok.last.obj.verified, true);
  assert.equal(ok.last.obj.file, 'hello.mp3', 'AI 通道只回文件名，不回绝对路径');
});

test('AI 通道 dryRun 校验音频但不发送', async () => {
  const h = harness({ voiceEnabled: true });
  const dry = await h.call('POST', '/api/socialV2/send-voice', { key: 'group:456', voice: 'hello', dryRun: true }, { 'x-agent-token': 't' });
  assert.equal(dry.last.obj.dryRun, true);
  assert.equal(dry.last.obj.messageId, undefined);
});

test('voices 列表：AI 通道隐藏 dir，操作者通道可见', async () => {
  const h = harness({ voiceEnabled: true });
  const agent = await h.call('GET', '/api/socialV2/voices?key=group:456&probe=0', {}, { 'x-agent-token': 't' });
  assert.equal(agent.last.obj.dir, undefined);
  const operator = await h.call('GET', '/api/voice/list?probe=0');
  assert.equal(operator.last.obj.dir, 'C:/audio');
});

test('发送失败回 500 且错误可读', async () => {
  const h = harness({ voiceEnabled: true, sendError: 'gateway down' });
  const result = await h.call('POST', '/api/socialV2/send-voice', { key: 'group:456', voice: 'hello' }, { 'x-agent-token': 't' });
  assert.equal(result.last.status, 500);
  assert.match(result.last.obj.error, /gateway down/);
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/status')).handled, false);
});
