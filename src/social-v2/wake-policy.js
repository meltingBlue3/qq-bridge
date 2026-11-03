// reserved2 唤醒策略（纯函数层）。
//
// 这里只处理「配置长什么样、是否还醒得过来、沉睡前观察是否满足、原因优先级」，
// 不读取 bridge 闭包、不写状态文件、不碰定时器。bridge 负责把 cfg.socialV2.wake
// 传入，并保留真正带副作用的调度函数。

export const WAKE_TRIGGER_KEYS = Object.freeze([
  'atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability'
]);

/** 归一化“指定群友发言唤醒”名单：正整数 QQ 号、去重、最多 20 个。 */
export function normalizeSpeakerIdsV2(value) {
  if (value === undefined || value === null) return [];
  const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const seen = new Set();
  const clean = [];
  for (const v of rawList) {
    const s = String(v ?? '').trim();
    if (!/^[1-9]\d*$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
    if (clean.length >= 20) break;
  }
  return clean;
}

/** triggers 的唯一合法字段集合：写入与加载都必须经过它过滤。 */
export function pickWakeTriggersV2(source, fallback = {}) {
  const out = {};
  const src = source && typeof source === 'object' ? source : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  for (const name of WAKE_TRIGGER_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** 默认 WakeConfig；wakeCfg = cfg.socialV2.wake。 */
export function defaultWakeConfigV2(wakeCfg = {}, { now = Date.now(), random = Math.random } = {}) {
  const w = wakeCfg && typeof wakeCfg === 'object' ? wakeCfg : {};
  const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
  const defaultInfinite = w.recommendedDefaultInfinite !== false;
  const recMin = Number(w.recommendedSleepMinMs) || 300000;
  const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
  let finiteMs = recMin + random() * Math.max(0, recMax - recMin);
  const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
  const hardMax = Number(w.sleepMaxMs) || 0;
  if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
  if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
  return {
    mode: defaultMode,
    infinite: defaultInfinite,
    sleepUntil: defaultInfinite ? null : new Date(now + Math.round(finiteMs)).toISOString(),
    triggers: {
      atMention: w.recommendedAtMention !== false,
      nameMention: w.recommendedNameMention !== false,
      speakerIds: [],
      keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
      question: w.recommendedQuestion !== false,
      poke: w.recommendedPoke !== false,
      anyMessage: defaultMode === 'active',
      probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
    },
    batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
    lastWakeAt: 0,
    wakeCount: 0,
    noActionCount: 0,
    confirmedAt: 0,
    confirmedBy: 'default'
  };
}

/** 只刷新仍使用默认配置的会话（AI/管理员显式设置过的不覆盖）。 */
export function refreshDefaultWakeConfigV2(st, wakeCfg, options = {}) {
  if (!st || !st.wakeConfig) return false;
  if (st.wakeConfig.confirmedBy !== 'default') return false;
  const def = defaultWakeConfigV2(wakeCfg, options);
  const old = st.wakeConfig;
  st.wakeConfig = {
    ...def,
    lastWakeAt: old.lastWakeAt || 0,
    wakeCount: old.wakeCount || 0,
    noActionCount: old.noActionCount || 0,
    confirmedAt: old.confirmedAt || 0,
    confirmedBy: 'default'
  };
  return true;
}

export const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

export function hasExplicitEndV2(st) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return false;
  return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
}

export function isSleepingConfigV2(wc) {
  if (!wc) return false;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
  return true;
}

/** 沉睡前强制观察是否仍阻挡收尾；wakeCfg = cfg.socialV2.wake。 */
export function preSleepWaitBlockedV2(st, wakeCfg = {}, now = Date.now()) {
  if (!st) return false;
  const w = wakeCfg && typeof wakeCfg === 'object' ? wakeCfg : {};
  if (w.preSleepWaitEnabled === false) return false;
  if (hasExplicitEndV2(st)) return false;
  const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
  if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
  if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
  if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
  return true;
}

/** WakeConfig 是否有任何一条能唤醒的途径（防永眠）。 */
export function isWakeableConfigV2(wc, now = Date.now()) {
  if (!wc) return false;
  const tr = wc.triggers && typeof wc.triggers === 'object' ? wc.triggers : {};
  const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > now;
  return wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
    normalizeSpeakerIdsV2(tr.speakerIds).length > 0 || Boolean(timed);
}

export function computeWakeSafetyV2(wc, now = Date.now()) {
  const tr = wc?.triggers || {};
  const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
    normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
  const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > now;
  const soft = Number(tr.probability) > 0;
  const guaranteed = hard || timed || soft;
  const confirmedNum = Number(wc?.confirmedAt);
  const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || now - confirmedNum > 24 * 60 * 60 * 1000;
  return { hard, timed, soft, guaranteed, stale };
}

export const WAKE_PRIORITY = Object.freeze({
  private: 100,
  atMention: 90,
  question: 80,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  timeout: 30,
  proactiveCheck: 20
});

/** 唤醒原因可能带子类型（keyword:小鲸鱼 / speaker:昵称），取冒号前基名。 */
export function wakePriorityV2(reason) {
  const base = String(reason ?? '').split(':')[0];
  return WAKE_PRIORITY[base] ?? 0;
}

export const TIMER_WAKE_REASONS = Object.freeze(new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin']));

export function isTimerWakeReason(reason) {
  return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
}

/** 唤醒原因里带的本地 seq（形如 `atMention@seq194`），没有就 null。 */
export function wakeReasonSeq(reason) {
  const match = /@seq(\d+)$/.exec(String(reason ?? '').trim());
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}
