// reserved2 会话的 persona 载荷「稳定段」（会话方反馈：稳定规则不该随用户消息
// 每回合重发——它们属于 system prompt，既修正优先级，又吃到 prompt cache）。
//
// 分层归属（docs/guides/PROMPT_LAYERING.md）：
//   · 身份/令牌 = 每会话稳定的**数据**，由桥接写入 persona 文件（L2 通道，热生效）；
//   · 反AI味/积极性/首回复节奏/时间感档位/表情策略 = 机制**规则**，同样随 persona
//     载荷注入 system——放在桥接-owned 的后缀里而不是 L1 yaml，是因为它们由
//     代码/配置派生（阈值可调、策略随表情库），走 L1 就得为改一句话重启 DSH。
//   · 用户消息（唤醒提示词）只保留动态数据：此刻状态、唤醒原因、快照、记忆。
//
// 纯函数：不读 bridge 闭包、不碰文件，输入全是明文参数。

/**
 * 时间感「规则档位」（静态文本，阈值随 cfg 变化时由调用方重算并触发 persona 重写）。
 * silentMin < chatMin 会被抬平；两档相等时省略中间档（「60～60 分钟」是自相矛盾的废话）。
 */
export function buildTimeSenseRulesText({ chatMin, silentMin } = {}) {
  const chat = Math.max(1, Math.round(Number(chatMin) || 10));
  const silent = Math.max(chat, Math.round(Number(silentMin) || chat));
  const lines = [
    '【时间感规则】开口前先看最新一条消息的 ago（本地时间），不要凭感觉当成“刚刚”。',
    `- ${chat} 分钟以内：正常接，当实时对话。`
  ];
  if (silent > chat) {
    lines.push(`- ${chat}～${silent} 分钟：可以接，但别用“刚”“哈哈哈刚看到”这类实时语气；先确认这个话题还在不在、对方还在不在。`);
  }
  lines.push(`- 超过 ${silent} 分钟：默认不回，直接 qq_mark_read 收尾；只有当那条明确是找你/提问你、而且回答现在仍然有用时才回，并且开头要带时间感（“这条我才看到”“过了挺久才看到”）。`);
  return lines.join('\n');
}

/**
 * 组装 reserved2 会话 persona 文件的稳定后缀（跟在角色卡正文之后）。
 * 空段落自动跳过；身份/令牌缺失（例如无角色卡且身份未知）不产生空行。
 *
 * @param opts.identity   【你的身份】…（selfIdentityTextV2 的产物，可为空）
 * @param opts.token      【会话令牌】…（可为空——理论上只在状态缺失时发生）
 * @param opts.stickerStrategy 【表情包策略：…】（表情体系关闭时为空）
 * @param opts.timeSense  { chatMin, silentMin } —— 传 null/省略则不含时间感规则
 */
export function buildReserved2PersonaSuffix({ identity = '', token = '', stickerStrategy = '', timeSense = null } = {}) {
  const sections = [];
  if (String(identity).trim()) sections.push(String(identity).trim());
  if (String(token).trim()) sections.push(String(token).trim());
  sections.push('【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。');
  sections.push('【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。');
  if (String(stickerStrategy).trim()) sections.push(String(stickerStrategy).trim());
  sections.push('【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply") 做短静默确认（quietMs 参考 qq_get_prompt 返回的 replyTiming.quietMs）；从最后来信计时，合批和读提示词的耗时也算。已安静够久会立即返回，并补上思考期间到达的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。');
  if (timeSense && (Number(timeSense.chatMin) > 0 || Number(timeSense.silentMin) > 0)) {
    sections.push(buildTimeSenseRulesText(timeSense));
  }
  return sections.join('\n\n');
}
