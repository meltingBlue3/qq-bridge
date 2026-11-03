// 控制台「一代仿真（社交引擎）」路由组。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// 注意 /api/social/state 的 phase 分支与 /api/social POST 的字段清洗/钳制
// 是一代引擎的既有契约，控制台 UI 依赖这些响应形状。

import path from 'node:path';
import { atomicWriteJson, readConfigObject } from '../json-file.js';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSocialRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    root,
    social,
    enterActive,
    leaveActive,
    flushSummaries,
    log
  } = deps;

  if (req.method === 'POST' && url.pathname === '/api/social/state') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const phase = body.phase;
    if (phase === 'active') {
      // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
      enterActive(key);
      log(`控制台：手动将 ${key} 设为活跃`);
      sendJson({ ok: true, key, phase: 'active' });
    } else if (phase === 'idle') {
      leaveActive(key);
      log(`控制台：手动将 ${key} 设为观望`);
      sendJson({ ok: true, key, phase: 'idle' });
    } else {
      sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/social') {
    const stats = {};
    for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
    const states = {};
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const k of keys) {
      const st = social.states.get(k);
      states[k] = { phase: st?.phase ?? 'idle' };
    }
    sendJson({ config: cfg.social, pendingSummaries: stats, states });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/social') {
    const body = await readBody();
    const configFile = path.join(root, 'config.json');
    // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
    const file = readConfigObject(configFile);
    const merged = { ...(file.social ?? {}), ...body };
    // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
    for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
      delete merged[k];
    }
    for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
      if (merged[k] !== undefined) {
        const n = Number(merged[k]);
        if (Number.isFinite(n) && n >= 0) merged[k] = n;
      }
    }
    // 分条间隔 clamp 到非负
    for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
      if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
    }
    // 概率字段 clamp 到 0~1
    for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
      if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
    }
    // contextWindow 限制 1~100
    if (merged.contextWindow !== undefined) {
      merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
    }
    // 布尔字段
    for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
      if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
    }
    // 范围字段保证 min <= max
    for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
      if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
        [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
      }
    }
    if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
    file.social = merged;
    atomicWriteJson(configFile, file);
    cfg.social = { ...cfg.social, ...merged };
    log('控制台：社交配置已更新');
    sendJson({ ok: true, config: cfg.social });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/social/flush') {
    const body = await readBody();
    await flushSummaries(body.key || null);
    sendJson({ ok: true });
    return true;
  }

  return false;
}
