// GIF 解码：纯 JS、零依赖（会话方反馈④的核心）。
//
// 为什么自己写：动图抽帧拼图原先只靠外部 ffmpeg；没装 ffmpeg 的机器上一张
// 48 帧的表情包模型只能看到第 1 帧的静态图（媒体归一化的首帧退化路径），
// 表情包等于废了。GIF 的块结构和 LZW 都是 30 年没变过的规范，纯 JS 解码
// 一个 QQ 表情（几百帧、240p）在毫秒级，没必要为一个兜底路径引入子进程依赖。
//
// 设计约束：
//  · 只解码「抽帧需要的信息」：全帧顺序合成（透明/处置法必须逐帧推进），
//    但 RGBA 快照只对 keep 命中的帧留存——拼图只取 6~12 帧，内存 O(画布×保留数)。
//  · 坏数据宁短勿炸：所有游标前进都带守卫，解析不动就返回 null 交给上层退化。
//  · 口径对齐生产已验证的 media-normalize.parseGif（帧数/时长可交叉校验）。

const MAX_LZW_CODES = 4096;
const MAX_FRAMES = 2000;

/** GIF 子块链跳过：每个子块首字节是长度，0 结束。返回新游标（越界返回 -1）。 */
function skipSubBlocks(buf, pos) {
  let p = pos;
  let guard = 0;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return p;
    p += size;
    if (++guard > 1_000_000) return -1;
  }
  return -1;
}

/** 读取一帧图像数据的子块链并拼成连续缓冲（LZW 位流按字节连续读取）。 */
function readSubBlockData(buf, pos) {
  const chunks = [];
  let p = pos;
  let guard = 0;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) break;
    if (p + size > buf.length) return null;
    chunks.push(buf.subarray(p, p + size));
    p += size;
    if (++guard > 1_000_000) return null;
  }
  return { data: Buffer.concat(chunks), end: p };
}

/**
 * GIF LZW 解码（LSB-first 变长码）。
 *
 * 码宽增长规则（与主流解码器一致）：字典新增一个条目后 next 恰好等于
 * 2^codeSize 时码宽 +1（封顶 12 位）；收到 CLEAR 码重置字典与码宽。
 */
function lzwDecode(minCodeSize, data, pixelCount) {
  if (minCodeSize < 1 || minCodeSize > 11) return null;
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  const prefix = new Int32Array(MAX_LZW_CODES);
  const suffix = new Uint8Array(MAX_LZW_CODES);
  const first = new Uint8Array(MAX_LZW_CODES);
  const length = new Uint16Array(MAX_LZW_CODES);
  for (let i = 0; i < clearCode; i += 1) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }
  let next = eoiCode + 1;
  const out = new Uint8Array(pixelCount);
  let outPos = 0;
  let prev = -1;
  let bitBuf = 0;
  let bitCnt = 0;
  let bytePos = 0;
  while (outPos < pixelCount) {
    // 读一个 codeSize 位的码（LSB first）
    while (bitCnt < codeSize) {
      if (bytePos >= data.length) return outPos > 0 ? out : null; // 数据截断：已解出的部分仍可用
      bitBuf |= data[bytePos] << bitCnt;
      bytePos += 1;
      bitCnt += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCnt -= codeSize;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      next = eoiCode + 1;
      prev = -1;
      continue;
    }
    if (code === eoiCode) break;
    if (code < 0 || code > MAX_LZW_CODES) break;
    let firstChar;
    if (prev === -1) {
      // 首码必须是字面量
      if (code >= clearCode) break;
      firstChar = code;
      if (outPos < pixelCount) out[outPos++] = code;
    } else if (code < next) {
      // 输出既有序列，记下首字符
      let len = length[code];
      if (outPos + len > pixelCount) len = pixelCount - outPos;
      let c = code;
      for (let i = len - 1; i >= 0; i -= 1) {
        out[outPos + i] = suffix[c];
        c = prefix[c];
      }
      outPos += len;
      firstChar = first[code];
    } else if (code === next) {
      // KwKwK：prev 序列 + prev 首字符
      const ch = first[prev];
      let len = length[prev];
      if (outPos + len + 1 > pixelCount) len = Math.max(0, pixelCount - outPos - 1);
      let c = prev;
      for (let i = len - 1; i >= 0; i -= 1) {
        out[outPos + i] = suffix[c];
        c = prefix[c];
      }
      outPos += len;
      if (outPos < pixelCount) out[outPos++] = ch;
      firstChar = ch;
    } else {
      break; // code > next 是坏码
    }
    if (prev !== -1 && next < MAX_LZW_CODES) {
      prefix[next] = prev;
      suffix[next] = firstChar;
      first[next] = first[prev];
      length[next] = length[prev] + 1;
      next += 1;
      if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prev = code;
  }
  return out;
}

/** 交错 GIF 的行序还原：四个通道 [0,8..] [4,8..] [2,4..] [1,2..]。 */
function deinterleaveRows(indices, width, height) {
  const out = new Uint8Array(indices.length);
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 }
  ];
  let srcRow = 0;
  for (const { start, step } of passes) {
    for (let y = start; y < height; y += step) {
      out.set(indices.subarray(srcRow * width, (srcRow + 1) * width), y * width);
      srcRow += 1;
    }
  }
  return out;
}

/**
 * 解码 GIF 的全部帧（顺序合成，含透明/处置法/交错）。
 *
 * @param buf   GIF 字节
 * @param opts.keep    (index, totalKnown?) => boolean——只对这些帧留存 RGBA 快照；
 *                     注意 GIF 流里帧数事前未知，谓词只拿到「当前是第几帧」，
 *                     需要均匀抽样的调用方先用 parseGif/帧数探测再传集合。
 * @param opts.maxFrames 解码帧数硬上限（防畸形/恶意超长流）
 * @returns null（解析失败）或 { width, height, frames: [{ index, delayMs, dispose, rgba }] }
 */
export function decodeGifFrames(buf, { keep = null, maxFrames = MAX_FRAMES } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 13) return null;
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height || width > 65535 || height > 65535) return null;
  const packed = buf[10];
  let pos = 13;
  // 全局颜色表
  let gct = null;
  if (packed & 0x80) {
    const size = 3 * (2 << (packed & 0x07));
    if (pos + size > buf.length) return null;
    gct = buf.subarray(pos, pos + size);
    pos += size;
  }

  const frames = [];
  // 合成画布（RGBA）
  const canvas = Buffer.alloc(width * height * 4, 0x00);
  let savedCanvas = null;
  // 最近的 GCE 参数
  let delayMs = 0;
  let dispose = 0;
  let transparentIndex = -1;
  let guard = 0;
  // keep 兼容三种形态：谓词函数 / Set / 数组（拼图传 Set）。
  const wantCheck = typeof keep === 'function' ? keep
    : Array.isArray(keep) ? ((i) => keep.includes(i))
    : (keep && typeof keep.has === 'function') ? ((i) => keep.has(i))
    : null;
  let decodedCount = 0;

  while (pos >= 0 && pos < buf.length) {
    if (++guard > 5_000_000 || decodedCount >= maxFrames) break;
    const block = buf[pos];
    pos += 1;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) { // extension
      if (pos >= buf.length) break;
      const label = buf[pos];
      pos += 1;
      if (label === 0xf9 && pos < buf.length) {
        const size = buf[pos];
        if (size >= 4 && pos + 5 <= buf.length) {
          const gcePacked = buf[pos + 1];
          delayMs = buf.readUInt16LE(pos + 2) * 10;
          dispose = (gcePacked >> 2) & 0x07;
          transparentIndex = (gcePacked & 0x01) ? buf[pos + 4] : -1;
        }
      }
      pos = skipSubBlocks(buf, pos);
      continue;
    }
    if (block === 0x2c) { // image descriptor
      if (pos + 9 > buf.length) break;
      const left = buf.readUInt16LE(pos);
      const top = buf.readUInt16LE(pos + 2);
      const fw = buf.readUInt16LE(pos + 4);
      const fh = buf.readUInt16LE(pos + 6);
      const descPacked = buf[pos + 8];
      pos += 9;
      let lct = gct;
      if (descPacked & 0x80) {
        const size = 3 * (2 << (descPacked & 0x07));
        if (pos + size > buf.length) break;
        lct = buf.subarray(pos, pos + size);
        pos += size;
      }
      if (pos >= buf.length) break;
      const minCodeSize = buf[pos];
      pos += 1;
      const sub = readSubBlockData(buf, pos);
      if (!sub || !lct) break;
      pos = sub.end;
      if (!fw || !fh || left + fw > width || top + fh > height) {
        // 越界帧：按规范裁剪处理代价高，直接判坏（QQ 表情不会这样）
        break;
      }
      let indices = lzwDecode(minCodeSize, sub.data, fw * fh);
      if (!indices) break;
      if (descPacked & 0x40) indices = deinterleaveRows(indices, fw, fh);

      // 处置法 3：合成前保存画布
      if (dispose === 3) savedCanvas = Buffer.from(canvas);

      // 合成到画布（跳过透明索引）
      for (let y = 0; y < fh; y += 1) {
        const dstRow = (top + y) * width;
        const srcRow = y * fw;
        for (let x = 0; x < fw; x += 1) {
          const idx = indices[srcRow + x];
          if (transparentIndex >= 0 && idx === transparentIndex) continue;
          const o = (dstRow + left + x) * 4;
          const c = idx * 3;
          if (c + 2 >= lct.length) continue;
          canvas[o] = lct[c];
          canvas[o + 1] = lct[c + 1];
          canvas[o + 2] = lct[c + 2];
          canvas[o + 3] = 0xff;
        }
      }
      const index = decodedCount;
      decodedCount += 1;
      if (!wantCheck || wantCheck(index)) {
        frames.push({ index, delayMs, dispose, rgba: Buffer.from(canvas) });
      }
      // 处置法：0/1 不动；2 清帧区域回透明；3 恢复保存的画布
      if (dispose === 2) {
        for (let y = 0; y < fh; y += 1) {
          const dstRow = (top + y) * width;
          canvas.fill(0x00, (dstRow + left) * 4, (dstRow + left + fw) * 4);
        }
      } else if (dispose === 3 && savedCanvas) {
        canvas.set(savedCanvas);
        savedCanvas = null;
      }
      // 帧已消费 GCE，重置到「无 GCE」默认，避免下一帧继承
      delayMs = 0;
      dispose = 0;
      transparentIndex = -1;
      continue;
    }
    break; // 未知块：解析不了就别硬猜
  }
  if (!frames.length) return null;
  return { width, height, frames };
}
