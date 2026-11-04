// forward-media 会话登记（纯函数层，bridge 与 VM 夹具共用）。
//
// 安全问题：AI 可以把**任意**媒体对象传给 qq_get_forward_media 的后端
// /api/socialV2/forward-media，桥接会照单抓取——等于一个「帮我抓这个 URL」
// 的原语（配合 SSRF 防护只挡了内网，挡不住模型诱导的公网目标）。
//
// 规则：能抓的媒体必须是「本会话真的见过」的，来源只有两处——
//   1. 合并转发读取（forward-message 路由返回媒体时登记，TTL 默认 10 分钟，
//      容量默认 1000/会话，插入序淘汰）；
//   2. 本会话消息上已入库的 media（recent/unread 消息对象的 url/file/emojiId）。
// 身份判定优先级：url > file > emojiId > faceId（与 MCP 侧收集媒体时的
// keyId 选择一致：url || file || faceId）。
export function createForwardMediaRegistry({ ttlMs = 10 * 60 * 1000, capacity = 1000 } = {}) {
  const ttl = Math.max(1000, Number(ttlMs) || 600000);
  const cap = Math.max(1, Math.round(Number(capacity) || 1000));
  const stores = new Map(); // key -> Map<mediaKey, ts>
  return {
    /** 媒体对象的会话内身份键；空串 = 无法识别（调用方视为未见）。 */
    keyOf(item) {
      const m = item && typeof item === 'object' ? item : {};
      const k = m.url || m.file || m.emojiId || m.faceId || '';
      return k ? String(k) : '';
    },
    /** 登记本会话刚见过的媒体（forward-message 读取成功后调用）。 */
    remember(key, mediaList, now = Date.now()) {
      if (!key) return;
      let store = stores.get(key);
      if (!store) {
        store = new Map();
        stores.set(key, store);
      }
      for (const m of Array.isArray(mediaList) ? mediaList : []) {
        const mk = this.keyOf(m);
        if (!mk) continue;
        store.set(mk, now);
      }
      while (store.size > cap) {
        for (const oldest of store.keys()) {
          store.delete(oldest);
          break;
        }
      }
    },
    /**
     * 过滤请求里的媒体：登记过（未过期）或已在本会话消息 media 里的放行。
     * @param messageLists 已入库消息列表（如 [recentMessages, unread]——是消息列表，
     *        媒体在各消息的 .media 上）
     * @returns {{ allowed: any[], denied: any[] }}
     */
    filter(key, mediaList, messageLists = [], now = Date.now()) {
      const storedKeys = new Set();
      for (const list of Array.isArray(messageLists) ? messageLists : []) {
        for (const msg of Array.isArray(list) ? list : []) {
          for (const m of (msg && Array.isArray(msg.media)) ? msg.media : []) {
            const k = this.keyOf(m);
            if (k) storedKeys.add(k);
          }
        }
      }
      const store = key ? stores.get(key) : null;
      const allowed = [];
      const denied = [];
      for (const m of Array.isArray(mediaList) ? mediaList : []) {
        const mk = this.keyOf(m);
        const ts = mk && store ? store.get(mk) : null;
        if ((ts && now - ts <= ttl) || storedKeys.has(mk)) allowed.push(m);
        else denied.push(m);
      }
      return { allowed, denied };
    },
    /** 会话退役/重置时清登记（防 key 复用后读到旧登记）。 */
    forget(key) {
      stores.delete(key);
    },
    get size() { return stores.size; }
  };
}
