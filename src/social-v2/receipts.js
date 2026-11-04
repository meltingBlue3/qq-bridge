// reserved2「模型已展示回执」（会话方反馈①的纯函数层）。
//
// 问题：同一条消息会同时出现在 唤醒快照、qq_get_unread_messages、qq_get_recent_messages
// 三个面上——未读缓冲在 mark_read 之前不清空，recent 又是全量滚动窗口，
// 模型每多看一眼就多烧一份 token（实测同一批消息在快照/未读/最近里出现三遍）。
//
// 解决：给「已经端到端展示给模型的消息」记一份**已展示回执**（st.modelShownSeqs，
// 进程内、不落盘——重启后模型本来就要重新拉取）。提供两个消费面：
//   · recent 路由：过滤掉已展示的 + 仍在未读缓冲里的（未读有专属工具）；
//   · 唤醒快照的 recent 切片：同样跳过上一回合已展示过的。
// readThroughSeq 水位协议（modelSeenSeqs）不受影响——那是「确认已读」的凭证，
// 这里是「不再重复下发」的凭证，二者语义不同、生命周期也不同。

/** 单条回执容量上限：recentMessages 窗口（默认 100）加未读缓冲（默认 30）再留余量。 */
export const SHOWN_SEQS_CAPACITY_DEFAULT = 400;

function validSeq(seq) {
  return Number.isSafeInteger(seq) && seq > 0;
}

/**
 * 取 modelSeenSeqs（readThrough 凭证集）。用鸭子类型而不是 instanceof Set：
 * 审计 harness 在 VM 里跑 bridge，VM 域的 Set 不是宿主域的 Set，
 * instanceof 会永远为假、把「都看过了」误判成「全都没看过」。
 */
function seenSetOf(st) {
  const seen = st?.modelSeenSeqs;
  return seen && typeof seen.has === 'function' ? seen : null;
}

/**
 * 记录一批「已展示给模型」的消息 seq（FIFO 去重、有界）。
 * messages 允许掺入 undefined/自消息；只记带合法 seq 的条目。
 */
export function rememberShownSeqs(st, messages, { capacity = SHOWN_SEQS_CAPACITY_DEFAULT } = {}) {
  if (!st || !Array.isArray(messages)) return 0;
  if (!Array.isArray(st.modelShownSeqs)) st.modelShownSeqs = [];
  let added = 0;
  for (const msg of messages) {
    const seq = msg?.seq;
    if (!validSeq(seq)) continue;
    if (st.modelShownSeqs.includes(seq)) continue;
    st.modelShownSeqs.push(seq);
    added += 1;
  }
  if (st.modelShownSeqs.length > capacity) {
    st.modelShownSeqs = st.modelShownSeqs.slice(-capacity);
  }
  return added;
}

/**
 * 回执修剪：只保留 recentMessages/unread 里仍存在的 seq。
 * 消息滚出两个缓冲后回执自然失效（想再看那时只能走 detail 工具，谈不上重复下发）。
 */
export function pruneShownSeqs(st) {
  if (!st) return;
  const live = new Set();
  for (const list of [st.recentMessages, st.unread]) {
    for (const m of Array.isArray(list) ? list : []) {
      if (validSeq(m?.seq)) live.add(m.seq);
    }
  }
  if (!Array.isArray(st.modelShownSeqs)) {
    st.modelShownSeqs = [];
    return;
  }
  st.modelShownSeqs = st.modelShownSeqs.filter((seq) => live.has(seq));
}

export function isShownSeq(st, seq) {
  return Array.isArray(st?.modelShownSeqs) && validSeq(seq) && st.modelShownSeqs.includes(seq);
}

/**
 * recent 列表的去重过滤（会话方反馈①的核心）。
 *
 * @param st           会话状态（读 modelShownSeqs / modelSeenSeqs）
 * @param messages     st.recentMessages（或其切片）
 * @param opts.hideUnreadSeqs  Set<seq>：仍在未读缓冲里的 seq（有专属未读工具时传入）
 * @returns {{ messages: Array, excludedShown: number, excludedUnread: number }}
 */
export function filterUnshownRecent(st, messages, { hideUnreadSeqs = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const shown = Array.isArray(st?.modelShownSeqs) ? st.modelShownSeqs : [];
  const seenByModel = seenSetOf(st);
  const out = [];
  let excludedShown = 0;
  let excludedUnread = 0;
  for (const m of list) {
    const seq = m?.seq;
    if (hideUnreadSeqs && validSeq(seq) && hideUnreadSeqs.has(seq)) {
      excludedUnread += 1;
      continue;
    }
    // modelSeenSeqs 是 readThrough 水位的凭证集（readThroughSeqV2 维护，范围=未读缓冲）；
    // 它命中的消息必然已经在快照/未读/等待补发里端到端给过模型，同样属于重复下发。
    if ((validSeq(seq) && shown.includes(seq)) || (seenByModel && validSeq(seq) && seenByModel.has(seq))) {
      excludedShown += 1;
      continue;
    }
    out.push(m);
  }
  return { messages: out, excludedShown, excludedUnread };
}

/**
 * 未读缓冲里「模型还没见过」的条数（会话方反馈③的口径来源）。
 * unreadCount 是缓冲总量（含已展示、等 mark_read 确认的）；这个数才是真正的新消息量。
 * 调用方注意：要在 noteModelMessagesV2 **之前**取——登记回执之后再算恒为 0，
 * 而「本次返回的就是你没见过的那些」才是模型需要的信息。
 */
export function countUnseenUnread(st) {
  if (!st || !Array.isArray(st.unread)) return 0;
  const seen = seenSetOf(st);
  if (!seen) return st.unread.length;
  return st.unread.filter((m) => !(validSeq(m?.seq) && seen.has(m.seq))).length;
}
