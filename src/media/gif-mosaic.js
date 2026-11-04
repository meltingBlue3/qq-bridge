// 动图抽帧拼图：纯 JS 路径（会话方反馈④）。
//
// ffmpeg 缺失/失败时，媒体归一化退到「只提供首帧」，动图表情等于废了。
// 这里用自研 GIF 解码 + PNG 编码（都零依赖）把同一件事做掉：
// 均匀抽 N 帧 → 最近邻缩放到格子宽 → 拼进白底网格 → PNG。
// 布局参数（margin/padding=4、白底）与 ffmpeg tile 滤镜的历史输出保持一致，
// 让两条路径产出视觉上同构的拼图。

import { decodeGifFrames } from './gif-decode.js';
import { encodePngRgba } from './png-encode.js';

/**
 * 从 totalFrames 里均匀抽 sample 帧（时间上尽量铺满整段动画）。
 * 返回升序去重的帧下标；sample=1 时取第 0 帧。
 */
export function pickSampleIndices(totalFrames, sampleFrames) {
  const total = Math.max(1, Math.floor(totalFrames) || 1);
  const want = Math.max(1, Math.min(Math.floor(sampleFrames) || 1, total));
  const set = new Set();
  for (let i = 0; i < want; i += 1) {
    const idx = want === 1 ? 0 : Math.round((i * (total - 1)) / (want - 1));
    set.add(idx);
  }
  return [...set].sort((a, b) => a - b);
}

function blitNearest(srcRgba, srcW, srcH, dst, dstW, dstH, ox, oy, tileW, tileH) {
  for (let ty = 0; ty < tileH; ty += 1) {
    const sy = Math.min(srcH - 1, Math.floor((ty * srcH) / tileH));
    for (let tx = 0; tx < tileW; tx += 1) {
      const sx = Math.min(srcW - 1, Math.floor((tx * srcW) / tileW));
      const s = (sy * srcW + sx) * 4;
      if (srcRgba[s + 3] < 128) continue; // 透明像素露出白底
      const d = ((oy + ty) * dstW + (ox + tx)) * 4;
      if (d + 3 >= dst.length) continue;
      dst[d] = srcRgba[s];
      dst[d + 1] = srcRgba[s + 1];
      dst[d + 2] = srcRgba[s + 2];
      dst[d + 3] = 0xff;
    }
  }
}

/**
 * 把一张 GIF 拼成「N 帧网格图」PNG。
 *
 * @returns {Promise<{ok:true, buffer:Buffer, mimeType:'image/png', framesUsed:number,
 *                     width:number, height:number, layout:{cols,rows,tileWidth,tileH}} |
 *                   {ok:false, error:string}>}
 */
export async function gifMosaic(buf, { cols, rows, tileWidth, totalFrames, sampleFrames, maxFrames } = {}) {
  try {
    if (!Buffer.isBuffer(buf)) return { ok: false, error: '输入不是 Buffer' };
    if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
      return { ok: false, error: '网格布局非法' };
    }
    if (!Number.isInteger(tileWidth) || tileWidth < 8 || tileWidth > 800) {
      return { ok: false, error: '格子宽度非法' };
    }
    const indices = pickSampleIndices(totalFrames ?? 1, sampleFrames ?? 1);
    const decoded = decodeGifFrames(buf, { keep: new Set(indices), maxFrames });
    if (!decoded) return { ok: false, error: 'GIF 解析失败' };
    const { width, height } = decoded;
    const tileH = Math.max(1, Math.round((height * tileWidth) / width));
    const margin = 4;
    const padding = 4;
    const outW = margin * 2 + cols * tileWidth + (cols - 1) * padding;
    const outH = margin * 2 + rows * tileH + (rows - 1) * padding;
    if (outW * outH > 64_000_000) return { ok: false, error: '拼图尺寸过大' };
    const canvas = Buffer.alloc(outW * outH * 4, 0xff); // 白底
    decoded.frames.forEach((frame, slot) => {
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const ox = margin + col * (tileWidth + padding);
      const oy = margin + row * (tileH + padding);
      blitNearest(frame.rgba, width, height, canvas, outW, outH, ox, oy, tileWidth, tileH);
    });
    const png = encodePngRgba(canvas, outW, outH);
    if (!decoded.frames.length) return { ok: false, error: '没有可用的帧' };
    return {
      ok: true,
      buffer: png,
      mimeType: 'image/png',
      framesUsed: decoded.frames.length,
      width: outW,
      height: outH,
      layout: { cols, rows, tileWidth, tileH }
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}
