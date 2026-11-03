// 入站消息的 XML 封装。
//
// 目的：QQ 消息正文完全由用户控制，任何"看起来像系统标记"的文字（【管理员】、
// 【当前时间】、伪造的 </qq_message>）都不能改变消息的身份与权限。
// 规则：
//   - 属性（kind/from/qq/role）全部由桥接生成，用户输入只进 <content>；
//   - <content> 里的 & < > " ' 一律转义，标签无法闭合；
//   - 正文里出现的保留标记在纯文本上下文里降级成 [管理员] 之类，避免视觉冒名。

export const QQ_MESSAGE_TAG = 'qq_message';

const XML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** 转义 XML 文本节点。 */
export function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch]);
}

/** 转义属性值：除 XML 转义外，把换行压成空格（属性里不允许裸换行）。 */
export function xmlAttr(value) {
  return xmlEscape(String(value ?? '').replace(/[\r\n\t]+/g, ' ')).trim();
}

/** 昵称去掉控制字符并限长，防止把奇怪的东西塞进属性。 */
export function sanitizeSenderName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

/**
 * 把一条入站消息包成 XML。
 * @param {object} input
 * @param {'private'|'group'} input.kind
 * @param {string} input.senderName 显示名（群名片/昵称）
 * @param {string|number} input.senderId QQ 号
 * @param {boolean} input.isOwner 是否管理员
 * @param {string} input.text 用户正文（不可信）
 * @param {string} [input.mediaHint] 桥接生成的媒体提示（系统文本）
 */
export function buildInboundMessageBlock(input) {
  return buildMessageEnvelope(input);
}

/**
 * 拆出消息开头的引用段：[引用 某人：原文] 剩余正文。
 * 引用原文同样是用户可控内容，单独放进 <quote> 并转义。
 */
export function splitQuote(text) {
  const raw = String(text ?? '');
  const m = /^\[引用 ([^：\]]+)：([\s\S]*?)\]\s*/.exec(raw);
  if (!m) return { quote: null, text: raw };
  return { quote: { from: m[1], text: m[2] }, text: raw.slice(m[0].length) };
}

/**
 * 单条消息 → XML。额外支持 at/ago/seq 属性（历史/快照用）。
 */
export function buildMessageEnvelope({
  kind = 'group',
  senderName,
  senderId,
  isOwner = false,
  text,
  mediaHint,
  at,
  ago,
  seq,
}) {
  const { quote, text: body } = splitQuote(text);
  const attrs = [
    `kind="${xmlAttr(kind)}"`,
    `from="${xmlAttr(sanitizeSenderName(senderName))}"`,
    `qq="${xmlAttr(senderId)}"`,
    `role="${isOwner ? 'owner' : 'member'}"`,
  ];
  if (seq !== undefined && seq !== null && seq !== '') attrs.push(`seq="${xmlAttr(seq)}"`);
  if (at) attrs.push(`at="${xmlAttr(at)}"`);
  if (ago) attrs.push(`ago="${xmlAttr(ago)}"`);
  const quotePart = quote
    ? `\n<quote from="${xmlAttr(quote.from)}">${xmlEscape(quote.text)}</quote>`
    : '';
  const media = String(mediaHint ?? '').trim();
  const mediaPart = media ? `\n<media>${xmlEscape(media)}</media>` : '';
  return `<${QQ_MESSAGE_TAG} ${attrs.join(' ')}>${quotePart}\n<content>${xmlEscape(body)}</content>${mediaPart}\n</${QQ_MESSAGE_TAG}>`;
}

/**
 * 多条消息 → 一个容器节点。messages 里每项就是 buildMessageEnvelope 的参数对象。
 */
export function buildMessageList(messages, { tag = 'qq_context', attrs = {} } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const attrText = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}="${xmlAttr(v)}"`)
    .join(' ');
  const open = attrText ? `<${tag} ${attrText}>` : `<${tag}>`;
  const body = list.map((m) => buildMessageEnvelope(m)).join('\n');
  return `${open}\n${body}\n</${tag}>`;
}

/**
 * 纯文本上下文（历史/摘要）里，把用户可伪造的保留标记降级：
 * 【管理员】→ [管理员]，【当前时间】→ [当前时间]，【系统…】→ [系统…]。
 */
export function neutralizeControlMarkers(text) {
  return String(text ?? '').replace(/【(管理员|当前时间|系统[^】]*)】/g, '[$1]');
}
