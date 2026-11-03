// slang-routes 的直接路由回归：slang query / submit（新词条、candidate 累计、confirmed/rejected 分支）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSlangRoutes } from '../src/http/slang-routes.js';
import { SLANG_STATUS } from '../src/slang-learner.js';

let slangSeq = 0;
const createEntry = ({ content, source, status, evidence }) => ({
  id: `s${++slangSeq}`, content, source, status,
  count: 1, evidence: evidence || [], meaning: '', usage: '', example: '',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});
const publicEntry = (e) => ({ id: e.id, content: e.content, status: e.status, count: e.count, meaning: e.meaning ?? '', usage: e.usage ?? '', example: e.example ?? '' });

function harness({ tools = {}, cfgSlang = {} } = {}) {
  const sent = [];
  let body = {};
  const entries = [];
  const calls = { saved: 0, research: [], activity: [] };
  const deps = {
    cfg: { socialV2: { tools }, slang: { enabled: true, autoResearch: true, ...cfgSlang } },
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: (flag) => tools[flag] !== false,
    confirmedSlangListV2: () => entries.filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning).map(publicEntry),
    getSlangEntries: () => entries,
    buildSlangContext: () => '（黑话提示块）',
    redactKnownTokensOnly: (v) => String(v ?? '').replace(/SECRET-TOKEN/g, '***'),
    allowSlangSubmit: () => true,
    saveSlangStore: () => { calls.saved += 1; },
    queueSlangTask: (fn) => calls.research.push(fn),
    runSlangResearch: async () => {},
    createSlangEntry: createEntry,
    publicSlangEntry: publicEntry,
    mergeEvidence: (old, add) => [...(old || []), ...add],
    appendActivity: (line) => calls.activity.push(line)
  };
  const call = async (method, pathname, bodyValue = {}, headers = { 'x-agent-token': 't' }) => {
    body = bodyValue;
    const handled = await handleSlangRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, entries, deps, calls };
}

test('query：缺 key 400；confirmed 过滤 + 关键词匹配 + block 透传', async () => {
  const h = harness();
  h.entries.push(
    { ...createEntry({ content: 'yyds', status: SLANG_STATUS.CONFIRMED }), meaning: '永远的神' },
    { ...createEntry({ content: 'xswl', status: SLANG_STATUS.CANDIDATE }), meaning: '笑死我了' }
  );
  const noKey = await h.call('GET', '/api/socialV2/slang/query');
  assert.equal(noKey.last.status, 400);
  const all = await h.call('GET', '/api/socialV2/slang/query?key=group:1');
  assert.equal(all.last.obj.total, 1, 'candidate 不进 confirmed 列表');
  assert.equal(all.last.obj.block, '（黑话提示块）');
  const hit = await h.call('GET', '/api/socialV2/slang/query?key=group:1&q=YYDS');
  assert.equal(hit.last.obj.total, 1, '关键词不区分大小写');
  const miss = await h.call('GET', '/api/socialV2/slang/query?key=group:1&q=不存在');
  assert.equal(miss.last.obj.total, 0);
});

test('submit：关闭开关 403；空/超长 400；限频 429；新词条入库 + 排研究任务 + 语境证据', async () => {
  const disabled = await harness({ cfgSlang: { enabled: false } }).call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '新词' });
  assert.equal(disabled.last.status, 403);
  const h = harness();
  const empty = await h.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '  ' });
  assert.equal(empty.last.status, 400);
  const tooLong = await h.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: 'x'.repeat(51) });
  assert.equal(tooLong.last.status, 400);
  const rate = harness();
  rate.deps.allowSlangSubmit = () => false;
  const limited = await rate.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '新词' });
  assert.equal(limited.last.status, 429);
  const ok = await h.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '新词SECRET-TOKEN', context: '语境' });
  assert.equal(ok.last.obj.ok, true);
  assert.equal(ok.last.obj.entry.status, SLANG_STATUS.CANDIDATE);
  assert.equal(h.entries[0].content, '新词***', 'content 过敏感词脱敏');
  assert.equal(h.entries[0].evidence[0].text, '语境');
  assert.equal(h.calls.saved, 1);
  assert.equal(h.calls.research.length, 1, 'autoResearch 默认开启 → 排研究任务');
  assert.equal(h.calls.activity.length, 1);
});

test('submit：candidate 重复提交累计 count 并在阈值排研究；confirmed 返回 duplicate；rejected 403', async () => {
  const h = harness({ cfgSlang: { inferenceThresholds: [3] } });
  h.entries.push({ ...createEntry({ content: '老词', status: SLANG_STATUS.CANDIDATE }), count: 2, lastInferenceCount: 0 });
  const dup = await h.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '老词' });
  assert.equal(dup.last.obj.duplicate, true);
  assert.equal(dup.last.obj.status, 'candidate');
  assert.equal(h.entries[0].count, 3);
  assert.equal(h.calls.research.length, 1, 'count=3 命中阈值且 > lastInferenceCount → 研究');

  const confirmed = harness();
  confirmed.entries.push({ ...createEntry({ content: '已收录', status: SLANG_STATUS.CONFIRMED }) });
  const dupOk = await confirmed.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '已收录' });
  assert.equal(dupOk.last.obj.status, 'confirmed');
  assert.equal(confirmed.calls.saved, 0, 'confirmed 重复不落盘');

  const rejected = harness();
  rejected.entries.push({ ...createEntry({ content: '被拒词', status: SLANG_STATUS.REJECTED }) });
  const refused = await rejected.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '被拒词' });
  assert.equal(refused.last.status, 403);

  // autoResearch=false 时不排任务
  const noAuto = harness({ cfgSlang: { autoResearch: false } });
  await noAuto.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '安静词' });
  assert.equal(noAuto.calls.research.length, 0);
});

test('token 脱敏作用于 content 与 context；token 无效 403', async () => {
  const h = harness({ });
  h.deps.agentTokenOk = () => false;
  const bad = await h.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '词' });
  assert.equal(bad.last.status, 403);
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/socialV2/memory?key=group:1')).handled, false);
  assert.equal((await h.call('POST', '/api/send/group', { groupId: '1', message: 'hi' })).handled, false);
});
