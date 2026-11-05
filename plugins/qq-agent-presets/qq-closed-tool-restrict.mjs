// Owner-private preset: local tools stay available. QQ actions use the legacy
// reply channel, whose target/owner checks are enforced by the bridge HTTP API.
export const name = 'qq-tool-restrict';
export const inject = ['tools'];
export const CLOSED_QQ_TOOLS = Object.freeze([
  'qq_status', 'qq_list_groups', 'qq_get_group_members', 'qq_get_group_history',
  'qq_send_group_message', 'qq_send_private_message', 'qq_reply',
]);
export const SIMULATION_ONLY_QQ_TOOLS = Object.freeze([
  'qq_get_prompt', 'qq_get_unread_messages', 'qq_get_recent_messages',
  'qq_social_state', 'qq_mark_read', 'qq_set_wake_config', 'qq_send_burst',
  'qq_send_message', 'qq_wait_for_messages', 'qq_report_feedback',
  'qq_get_my_recent_messages', 'qq_get_message_detail', 'qq_get_active_members',
  'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
  'qq_slang_query', 'qq_slang_submit', 'qq_send_voice', 'qq_list_voices',
  'qq_send_poke', 'qq_send_sticker',
]);
const prefix = 'mcp__snowluma__';
const allowed = new Set(CLOSED_QQ_TOOLS.map((tool) => prefix + tool));
export function apply(ctx) {
  for (const tool of SIMULATION_ONLY_QQ_TOOLS) {
    try { ctx.tools.restrict({ deny: [prefix + tool] }); } catch { /* optional/not registered */ }
  }
  ctx.tools.guard(({ name }) => {
    if (typeof name !== 'string' || !name) return '工具名称无效';
    if (name.startsWith(prefix) && !allowed.has(name)) return `工具 "${name}" 仅用于仿真会话`;
    return undefined;
  });
}
