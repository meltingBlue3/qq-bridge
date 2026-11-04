// 表情/黑话 scope 归属：库函数直测 + 路由注入过滤（#87 跨会话信息流边界）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStickerScope, stickerVisibleInScope, normalizeStickerEntry,
  buildStickerContext, formatStickerList, applyStickerNote
} from '../src/sticker-lib.js';
import {
  normalizeSlangScope, slangVisibleInScope, normalizeSlangEntry,
  createSlangEntry, buildSlangContext, SLANG_STATUS
} from '../src/slang-learner.js';

test('scope 归一化：global/会话 key/非法值/空值', () => {
  assert.equal(normalizeStickerScope(''), 'global');
  assert.equal(normalizeStickerScope(undefined), 'global');
  assert.equal(normalizeStickerScope('global'), 'global');
  assert.equal(normalizeStickerScope('group:456'), 'group:456');
  assert.equal(normalizeStickerScope('private:123'), 'private:123');
  assert.equal(normalizeStickerScope('group:abc'), 'global', '非法 key 归 global（fail-safe）');
  assert.equal(normalizeStickerScope('别的会话'), 'global');
  assert.equal(normalizeSlangScope('group:789'), 'group:789');
});

test('可见性：global 永远可见；会话条目只在本会话可见；空视角=全量（控制台）', () => {
  const globalEntry = { scope: 'global' };
  const sessionEntry = { scope: 'group:456' };
  const legacyEntry = {}; // 旧数据无 scope
  assert.equal(stickerVisibleInScope(globalEntry, 'group:456'), true);
  assert.equal(stickerVisibleInScope(sessionEntry, 'group:456'), true);
  assert.equal(stickerVisibleInScope(sessionEntry, 'group:789'), false);
  assert.equal(stickerVisibleInScope(legacyEntry, 'group:789'), true, '旧数据按 global 兼容');
  assert.equal(stickerVisibleInScope(sessionEntry, ''), true, '空视角=控制台全量');
  assert.equal(slangVisibleInScope({ scope: 'private:1' }, 'group:456'), false);
});

test('normalize 往返保留 scope；normalizeStickerEntry/slangEntry 都带 scope 字段', () => {
  assert.equal(normalizeStickerEntry({ id: 'x', scope: 'group:456' }).scope, 'group:456');
  assert.equal(normalizeStickerEntry({ id: 'x' }).scope, 'global');
  assert.equal(normalizeSlangEntry({ content: '梗', scope: 'group:456' }).scope, 'group:456');
  assert.equal(normalizeSlangEntry({ content: '梗' }).scope, 'global');
});

test('buildStickerContext / formatStickerList / buildSlangContext 按 scope 过滤', () => {
  const entries = [
    { id: 'g', desc: '全局表情', useCount: 5 },
    { id: 'a', desc: 'A群专用', useCount: 9, scope: 'group:456' },
    { id: 'b', desc: 'B群专用', useCount: 7, scope: 'group:789' }
  ];
  const ctxA = buildStickerContext(entries, 8, 'group:456');
  assert.match(ctxA, /全局表情/);
  assert.match(ctxA, /A群专用/);
  assert.ok(!ctxA.includes('B群专用'), '别的会话的表情不得注入');
  const ctxConsole = buildStickerContext(entries, 8, '');
  assert.match(ctxConsole, /B群专用/, '控制台全量视角');

  const listA = formatStickerList(entries, '', 48, 'group:456');
  assert.equal(listA.stickers.length, 2);
  assert.ok(!JSON.stringify(listA).includes('B群专用'));

  const slangEntries = [
    { content: '梗A', meaning: 'A群的意思', status: SLANG_STATUS.CONFIRMED, count: 9, scope: 'group:456' },
    { content: '梗G', meaning: '全局的意思', status: SLANG_STATUS.CONFIRMED, count: 3 }
  ];
  const blockA = buildSlangContext(slangEntries, 8, 'group:456');
  assert.match(blockA, /梗A/);
  assert.match(blockA, /梗G/);
  const blockB = buildSlangContext(slangEntries, 8, 'group:789');
  assert.ok(!blockB.includes('梗A'), 'A 群黑话不得注入 B 群');
  assert.match(blockB, /梗G/);
});

test('applyStickerNote 保留条目归属：global 不被私有化，会话条目不升级', () => {
  const globalEntries = normalizeStickerEntryPlain([{ id: 'g', desc: '全局', scope: 'global' }]);
  const r1 = applyStickerNote(globalEntries, 'g', { note: 'AI 写的备注' });
  assert.equal(r1.entry.scope, 'global', '给 global 条目写备注不改变归属');
  const sessionEntries = normalizeStickerEntryPlain([{ id: 's', scope: 'group:456' }]);
  const r2 = applyStickerNote(sessionEntries, 's', { note: '会话内备注' });
  assert.equal(r2.entry.scope, 'group:456', '会话条目写备注不升级为 global');
});

test('createSlangEntry 带 scope；与现有测试的 createSlangEntry({content,...}) 兼容', () => {
  const e = createSlangEntry({ content: '新词', scope: 'group:456' });
  assert.equal(e.scope, 'group:456');
  assert.equal(createSlangEntry({ content: '默认词' }).scope, 'global');
});

function normalizeStickerEntryPlain(rawList) {
  return (Array.isArray(rawList) ? rawList : []).map((e) => normalizeStickerEntry(e)).filter(Boolean);
}
