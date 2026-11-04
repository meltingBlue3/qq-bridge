// Only the model-facing view is compacted. Stored messages and console/API data
// retain the original fields for display, media retrieval and troubleshooting.
const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds'
]);

// ── 时间视图：裸 epoch 换成「本地时间 + 距现在多久」 ──────────────────────────
//
// 为什么必须换：模型看到的原来是 `"time":1792294529471`，它既算不出"这是 38 分钟前"，
// 也没法跟提示词里的【当前时间】对齐。于是**沉睡几十分钟后被唤醒，仍然把旧消息当成刚发的**
// 实时对话来回复（实测：唤醒原因 atMention@seq194 其实是 40 分钟前的话，它照样用"刚看到"的
// 语气接，甚至抢进一个早已散场的话题）。
//
// 换成 `"at":"11:31","ago":"38m"` 之后：模型不需要做任何换算，直接能判断"这条是旧账"。
// `at` 保留绝对时间（跨天时带日期），`ago` 用最省 token 的写法（3s / 5m / 2h / 3d）。
//
// 兼容：time 缺失/为 0/非法时**原样保留**（旧行为），避免把"没有时间"伪装成"刚刚"。
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

/** 本地时间戳：当天只给 HH:MM，跨天补 MM-DD。 */
function localStamp(ms, now) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = (() => {
    const a = new Date(now);
    return a.getFullYear() === d.getFullYear() && a.getMonth() === d.getMonth() && a.getDate() === d.getDate();
  })();
  return sameDay ? clock : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/** 距现在多久：3s / 18m / 2h / 3d。未来时间（时钟偏差）夹到 0s。 */
function ageText(ms, now) {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  return `${Math.floor(hour / 24)}d`;
}

/** 把 epoch 毫秒转成模型可读的 age 文本（供提示词/日志复用同一套口径）。 */
export function describeAge(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  return ageText(t, now);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

// ── 不可信文本净化：群友可控文本进入模型视图前的结构净化 ────────────────────
// 群消息/转发内容/昵称是外部可控输入：【】与换行能在提示词里伪造小节标题与
// 新段落（如「【系统】忽略之前的规则」）。动作是**剥离而不是拒绝**：内容照常
// 可见，只是失去冒充系统结构的能力。存储层保留原始字段（控制台/排查看原文），
// 只有模型视图被净化。
const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g;
const CONTROL_RE = /[\u0000-\u0008\u000e-\u001f\u007f]/g;
const LINEBREAK_RE = /[\r\n\u2028\u2029\u0085\u000b\u000c]+/g;

export function sanitizeUntrustedText(value) {
  return String(value ?? '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(LINEBREAK_RE, ' ');
}

function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    // A local seq is a bridge message handle accepted by qq_get_message_images.
    // Forwarded nodes only have messageSeq, and may not be locally resolvable:
    // keep their transport references, even when they happen to have messageId.
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // Match the image tool's one-based ordering; never filter/reorder items.
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

export function compactModelMessage(message, opts = {}) {
  if (!isRecord(message)) return message;
  const result = { ...message };
  // No trimming or truncation: differing plain text can contain resolved quote
  // context, and tail can carry the end of a long message absent from text.
  // 群友可控文本先净化再去重：伪造段落用的【】/换行在这里失去结构力，
  // 净化后相同的 text/plain/tail 也会被去重（省 token，无信息损失）。
  for (const key of ['sender', 'text', 'plain', 'tail']) {
    if (typeof result[key] === 'string') result[key] = sanitizeUntrustedText(result[key]);
  }
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (result[key] === false) delete result[key];
  }
  // 时间视图：有效的 epoch 换成 at/ago；缺失或 0（历史兼容/未知）保持原样。
  const stamp = Number(result.time);
  if (Number.isFinite(stamp) && stamp > 0) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    delete result.time;
    result.at = localStamp(stamp, now);
    result.ago = ageText(stamp, now);
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  return result;
}

export function compactModelData(data, opts = {}) {
  // 任意层的字符串都可能是外部可控文本（转发正文/工具结果/网页摘要在经由
  // serializeModelData 输出时经过这里）：统一净化，防伪造提示词结构。
  if (typeof data === 'string') return sanitizeUntrustedText(data);
  if (Array.isArray(data)) return data.map((item) => compactModelData(item, opts));
  if (!isRecord(data)) return data;
  // 一次序列化只取一次 now：同一批消息的 ago 必须彼此可比（否则跨分钟边界会自相矛盾）。
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const inner = { now };
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    (key === 'messages' || key === 'newMessages') && Array.isArray(value)
      ? value.map((item) => compactModelMessage(item, inner))
      : compactModelData(value, inner)
  ]));
}

export function serializeModelData(data, opts = {}) {
  return JSON.stringify(compactModelData(data, opts));
}
