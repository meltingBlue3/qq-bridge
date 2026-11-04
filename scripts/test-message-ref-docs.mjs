// 统一消息寻址（会话方反馈 ②）：所有消息寻址参数都接受「QQ 消息 id 或本地 seq」。
//  - 文案契约：MCP 工具描述必须说清两者皆可，否则模型会在 id/seq 之间猜（实测踩坑）；
//  - 行为钉：message-detail 路由按 seq 命中本地消息时，返回真实 messageId + seq。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleSocialV2ReadRoutes } from '../src/http/socialv2-read-routes.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const mcpSource = fs.readFileSync(root + 'src/mcp-snowluma-safe.js', 'utf8');
const bridgeSource = fs.readFileSync(root + 'src/bridge.js', 'utf8');

test('文案契约：reply/send 系参数都声明「id 或本地 seq 都可以」', () => {
  // 4 个 optional 参数（sendGroup/sendPrivate/sendMessage/sendSticker）+ 1 个 required（reply）
  const optionalCount = mcpSource.split("QQ 消息 id 或本地 seq 都可以（非零整数，桥接自动识别换算；消息 id 可能为负数，可选）").length - 1;
  assert.equal(optionalCount, 4, `optional replyToMessageId 描述应出现 4 次，实得 ${optionalCount}`);
  assert.ok(mcpSource.includes('被引用/回复的消息：QQ 消息 id 或本地 seq 都可以'), 'qq_reply 参数应声明双寻址');
  assert.ok(mcpSource.includes('replyToMessageId 填 QQ 消息 id 或本地 seq 都可以'), 'qq_reply 描述应声明双寻址');
  assert.ok(mcpSource.includes('要查看的消息：QQ 消息 id 或本地 seq 都可以'), 'qq_get_message_detail 参数应声明双寻址');
  // 行为面其实早已支持（findMessageMedia / resolveReplyTargetV2 / message-detail 均按 seq 命中），
  // 这条钉住描述不许回退成「只能 id」。
  assert.ok(mcpSource.includes('二代也可用本地 seq'), 'qq_get_message_images 参数应声明 seq 可用');
});

test('文案契约：唤醒提示词的【引用】段说明 id/seq 皆可', () => {
  assert.ok(
    bridgeSource.includes('（填那条消息的 messageId 或本地 seq 都可以，桥接会自动换算）'),
    '唤醒提示词应告诉模型 replyToMessageId 双寻址'
  );
});

// ── 行为钉：message-detail 按 seq 命中本地消息 ─────────────────────────────
function harness({ recentMessages = [] } = {}) {
  const sent = [];
  const deps = {
    cfg: { socialV2: { privacy: {} } },
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getCurrentMode: () => 'reserved2',
    modeAllowed: () => true,
    allowed: () => true,
    getSocialV2State: () => ({ recentMessages, unread: [] }),
    resolveReplyInfo: async () => null,
    seenForwardIds: new Map(),
    botRaw: async () => { throw new Error('不应触发 OneBot 调用'); },
    botRequest: async () => { throw new Error('不应触发 OneBot 调用'); },
    onebotHttpAction: async () => { throw new Error('不应触发 OneBot 调用'); },
    fetchMediaData: async () => [],
    formatForwardResponse: () => ({ messages: [] }),
    truncateText: (s, n) => String(s ?? '').slice(0, n),
    rememberForwardMediaV2: () => {},
    filterForwardMediaV2: () => ({ allowed: [], denied: [] })
  };
  const call = async (pathname) => {
    await handleSocialV2ReadRoutes({
      req: { method: 'GET', headers: { 'x-agent-token': 'tok' } },
      url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => ({}),
      deps
    });
    return sent.at(-1);
  };
  return { call };
}

test('message-detail：按本地 seq 查询返回真实 messageId', async () => {
  const h = harness({
    recentMessages: [{ seq: 12, messageId: '-55432', sender: '阿蓝', text: '看这个', userId: '2434757895' }]
  });
  const bySeq = await h.call('/api/socialV2/message-detail?key=group:456&messageId=12');
  assert.equal(bySeq.status, 200);
  assert.equal(bySeq.obj.info.messageId, '-55432', 'seq 命中本地消息时应映射出真实 messageId');
  assert.equal(bySeq.obj.info.seq, 12);
});

test('message-detail：按真实 messageId 查询走原路径且不受 seq 假命中影响', async () => {
  // messageId 恰好与某条的 seq 字符串相同的边界：先查 messageId（唯一精确匹配），
  // 只有当入参不等于该条 messageId 时才按 seq 展示本地信息。
  const h = harness({
    recentMessages: [{ seq: 12, messageId: '12', sender: '阿蓝', text: '边界' }]
  });
  const hit = await h.call('/api/socialV2/message-detail?key=group:456&messageId=12');
  assert.equal(hit.status, 200);
  assert.equal(hit.obj.info.seq, 12, 'id 与 seq 相同也能命中');
});
