import fs from 'node:fs';

const changed = () => new Error('会话创建期间已重置或权限已变化');

// Owns session creation, reuse and stale-result rejection. Feature-specific
// retirement (tokens, wake timers, collectors) stays in the supplied retire hook.
export function createSessionLifecycle({
  state, reverse, pending = new Map(), api, unwrap, getEpoch, getPlan,
  isAllowed, selectModel, retire, persist, archive, log = () => {},
  ensureDirectory = (dir) => fs.mkdirSync(dir, { recursive: true }),
}) {
  function isCurrent(key, id) {
    return isAllowed(key) && state.sessions[key] === id
      && state.sessionPolicies[key] === getPlan(key).policy;
  }

  async function ensure(key) {
    const epoch = getEpoch();
    const plan = getPlan(key);
    if (!isAllowed(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      if (!isCurrent(key, existing)) retire(key);
      else {
        const applied = await selectModel(existing);
        // A stale model-selection completion must not retire a replacement.
        if (epoch !== getEpoch() || !isCurrent(key, existing)) throw changed();
        if (applied !== 'not-found') return existing;
        log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
        retire(key);
      }
    }
    if (pending.has(key)) return pending.get(key);
    // Register before calling any adapters, including synchronous/reentrant ones.
    const promise = Promise.resolve().then(async () => {
      const stillValid = () => epoch === getEpoch() && pending.get(key) === promise
        && isAllowed(key) && plan.policy === getPlan(key).policy;
      if (!stillValid()) throw changed();
      if (plan.strictPreset && !plan.preset) throw new Error(plan.missingPresetError);
      ensureDirectory(plan.directory);
      let id;
      let lastError;
      for (const withPreset of plan.strictPreset ? [true] : [true, false]) {
        try {
          const ws = unwrap(await api.workspace.create({ path: plan.directory }), 'workspace.create');
          if (!stillValid()) throw changed();
          if (ws.created && plan.workspaceTitle) {
            await api.workspace.rename({ workspaceId: ws.workspace.workspaceId, title: plan.workspaceTitle });
          }
          if (!stillValid()) throw changed();
          const params = { workspaceId: ws.workspace.workspaceId };
          if (withPreset && plan.preset) params.agentPreset = plan.preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          id = value.sessionId;
          if (!id) throw new Error('DSH 未返回 sessionId');
          if (withPreset && plan.preset) log(`会话 ${key} 已挂载 preset ${plan.preset}`);
          else if (plan.preset) log(`⚠️ 会话 ${key} 未能挂载 preset ${plan.preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 preset bundle 后重启 DSH`);
          break;
        } catch (error) {
          if (!stillValid()) throw changed();
          lastError = error;
        }
      }
      if (!id) throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${plan.mode}，preset ${plan.preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      if (!stillValid()) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${id}）`);
        try { await archive(id); } catch {}
        throw changed();
      }
      api.events.follow(id);
      state.sessions[key] = id;
      state.sessionPolicies[key] = plan.policy;
      reverse.set(id, key);
      persist();
      await selectModel(id);
      if (!stillValid() || !isCurrent(key, id)) {
        if (state.sessions[key] === id) retire(key);
        throw changed();
      }
      log(`新会话 ${key} -> ${id}（模式 ${plan.mode}，preset: ${plan.preset ?? '默认'}）`);
      return id;
    });
    pending.set(key, promise);
    try { return await promise; }
    finally { if (pending.get(key) === promise) pending.delete(key); }
  }

  return { ensure, isCurrent, pending };
}
