// reserved2 撤回事件的入库替换（纯函数层）。
//
// 为什么原地换而不是删除：seq 是未读水位与唤醒补发/切片淘汰的锚点，
// 删除会在消息流里留下 seq 空洞，让「unread 里还有 >= seq 的消息」这类
// 判定失真。撤回只换掉**内容与派生字段**：文本三件套（text/plain/tail）、
// 媒体（media/hasMedia）、转发（forwardIds/hasForward），并打 recalled 标记。
// seq / time / sender / userId / isOwner / quoteTargetIsSelf 一律保留。
//
// 模型侧语义：下次唤醒或读 unread 看到的就是「[该消息已被撤回]」占位，
// 不需要也无法再还原原文；幂等（重复的撤回事件不会二次替换）。

export const RECALLED_PLACEHOLDER = '[该消息已被撤回]';

/**
 * 把会话状态里匹配 messageId 的消息替换为撤回占位。
 * @returns {{ replaced: number, forwardIds: string[] }} replaced = 替换条数
 *          （recent 与 unread 里是同一对象的引用时只算一次）；forwardIds =
 *          被撤回消息带出的转发 id（调用方应把它们从转发白名单里移除）。
 */
export function applyRecallV2(st, messageId) {
  const idText = String(messageId ?? '');
  if (!st || typeof st !== 'object' || !idText) return { replaced: 0, forwardIds: [] };
  const seen = new Set(); // recent 与 unread 共享同一对象时防重复计数
  const forwardIds = [];
  let replaced = 0;
  for (const listName of ['recentMessages', 'unread']) {
    const list = Array.isArray(st[listName]) ? st[listName] : [];
    for (const m of list) {
      if (!m || typeof m !== 'object' || seen.has(m)) continue;
      if (m.messageId == null || String(m.messageId) !== idText) continue;
      seen.add(m);
      if (m.recalled === true) continue; // 已替换过：幂等
      m.text = RECALLED_PLACEHOLDER;
      m.plain = RECALLED_PLACEHOLDER;
      m.tail = RECALLED_PLACEHOLDER;
      m.recalled = true;
      if (Array.isArray(m.forwardIds) && m.forwardIds.length) forwardIds.push(...m.forwardIds.map(String));
      m.forwardIds = [];
      m.hasForward = false;
      m.media = [];
      m.hasMedia = false;
      replaced += 1;
    }
  }
  return { replaced, forwardIds };
}
