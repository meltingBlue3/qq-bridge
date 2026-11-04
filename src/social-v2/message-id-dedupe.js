// messageId 幂等去重（进程内，插入序 LRU）。
//
// 为什么需要：OneBot 网关断线重连/重试会把同一消息重投一次。旧实现无任何去重，
// 重复消息会再次入库：seq 水位被推高、unread 里出现两条一样的消息、AI 可能对着
// 同一句话回两遍。
//
// 设计：
//   · 只认 messageId 非空的条目——拍一拍等合成条目没有 id，内容上允许重复，不去重；
//   · 容量有界（默认 500，插入序淘汰最旧）：重连风暴窗口通常只有几秒到几分钟；
//   · 不持久化——重启后 LRU 清空，但「切片内查重」在 bridge 的 appendSocialV2Message
//     里兜底（recent/unread 来自持久化状态），两层合起来覆盖重启场景。
export function createMessageIdDedupe({ capacity = 500, log = () => {} } = {}) {
  const raw = Number(capacity);
  // 非法/零/负容量一律回退默认值（负数是真值，不能靠 `||` 兜底）；极小正值收敛到 1。
  const cap = Math.max(1, Math.round(Number.isFinite(raw) && raw > 0 ? raw : 500));
  const seen = new Set(); // 插入序：最旧在前
  return {
    /** true = 第一次见到（并登记）；false = 重复（已见过） */
    isFirstSeen(id) {
      const key = String(id ?? '');
      if (!key) return true; // 无 id 不去重
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > cap) {
        for (const oldest of seen) {
          seen.delete(oldest);
          break; // 只淘汰最旧一个
        }
      }
      return true;
    },
    get size() { return seen.size; },
    get capacity() { return cap; }
  };
}
