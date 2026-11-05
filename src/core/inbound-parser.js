// OneBot text and media parsing; no runtime configuration, sockets or session state.
import { forwardIdFromData } from '../forward.js';
import { truncateText } from '../md-to-plain.js';

export async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
export function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}

/** Resolve a received event without mutating conversation state or downloading media. */
export function createInboundParser({ resolveMember, resolveReply, isQuoteTargetSelf }) {
  return {
    async parse(kind, id, event) {
      const segments = event.message ?? [];
      const resolveAtName = kind === 'group' ? (qq) => resolveMember(event.group_id, qq) : null;
      const textContent = await segmentsToText(segments, {
        resolveAtName, resolveReply: (messageId) => resolveReply(kind, id, messageId, event.self_id),
      });
      const plainContent = await segmentsToText(segments, { resolveAtName, includeReply: false });
      const mediaList = extractMediaFromSegments(segments);
      const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
      const seqRef = event.message_seq != null ? String(event.message_seq) : '';
      const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
      const quoteTargetIsSelf = await isQuoteTargetSelf(segments, kind, id, event.self_id);
      return { textContent, plainContent, mediaList, messageRef, refsToStore, quoteTargetIsSelf };
    },
  };
}
