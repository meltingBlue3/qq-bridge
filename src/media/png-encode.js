// PNG 编码：纯 JS、零依赖（zlib 是 node 内置）。
//
// 为什么自己写：动图拼图的纯 JS 兜底需要一个能被 DSH 接住的图片容器，
// 而 node 生态里不引第三方库的话没有现成编码器。RGBA → PNG（color type 6、
// 每行 filter 0）是几十行的稳定规范，zlib.deflateSync 负责压缩主体。

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * RGBA 像素 → PNG Buffer。
 * @param rgba 长度必须等于 width*height*4
 */
export function encodePngRgba(rgba, width, height) {
  if (!Buffer.isBuffer(rgba)) throw new Error('rgba 必须是 Buffer');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('尺寸非法');
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba 长度 ${rgba.length} 与 ${width}×${height}×4 不符`);
  }
  // 每行前置 filter 字节（0 = None）。表情/拼图是平面色块，None + zlib 足够小，
  // 不为省 20% 字节引入 Paeth 的复杂度。
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
