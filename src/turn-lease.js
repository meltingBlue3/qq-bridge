// 回合判忙租约的纯函数层（bridge 与 VM 夹具共用）。
//
// TURN_BUSY_LEASE_MS：`turn/start` 的结束信号（turn/end）丢失时，会话判忙的最长时限。
// 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖
// 任何**还活着**的回合；过期只是不再判忙——collector 本身保留，真回复照常 flush，
// 只是允许新唤醒排队（防「它不理我了，只能重启」，issue #11/#23/#26/#19）。
//
// RESTORED_TURN_GRACE_MS：断线快照恢复出来的「进行中」回合不知道真实起点。若按恢复
// 时刻起算，每次桥接重启都会让该会话按满租约判忙，期间所有 @/私聊只能排队。把起点
// 回拨到「只剩宽限期」的位置：活着的回合会在 turn/end 清掉忙标记，宽限只对真丢了
// end 的死回合生效——45 秒足够覆盖重连抖动，又不把误判拖满一个租约期。
export const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
export const RESTORED_TURN_GRACE_MS = 45 * 1000;

/** 恢复回合的忙标记起点：now 回拨到「租约只剩 graceMs」的时间戳。 */
export function restoredTurnStartAt(now, { leaseMs = TURN_BUSY_LEASE_MS, graceMs = RESTORED_TURN_GRACE_MS } = {}) {
  const lease = Math.max(0, Number(leaseMs) || 0);
  const grace = Math.max(0, Number(graceMs) || 0);
  return Number(now) - Math.max(0, lease - grace);
}
