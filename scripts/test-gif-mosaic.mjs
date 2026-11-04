// 纯 JS 动图抽帧拼图（会话方反馈④）：没装 ffmpeg 也能把动图表情看全。
//  - GIF 解码器：真实编码器产出的 1×1 GIF 参照 + 自建 fixture 钉透明/处置法/交错；
//    帧数口径与生产已验证的 parseGif 交叉校验。
//  - PNG 编码器：字节级回读。
//  - 归一化集成：无 ffmpeg 环境下 animate 路径产出拼图而非「只给首帧」。
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodeGifFrames } from '../src/media/gif-decode.js';
import { encodePngRgba } from '../src/media/png-encode.js';
import { gifMosaic, pickSampleIndices } from '../src/media/gif-mosaic.js';
import { sniffImage, normalizeImageForModel } from '../src/media-normalize.js';

// ── fixture：最小 GIF 编码器（测试专用）──────────────────────────────────
function packBits(bits) {
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) {
      if (i + j < bits.length && bits[i + j]) b |= 1 << j;
    }
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * LZW 编码（仅输出字面量码，测试足够）：
 *  - mode='clear'：每个字面量前发 CLEAR——码宽恒为 minCodeSize+1（「无压缩 GIF」技巧）；
 *  - mode='dense'：只发一次 CLEAR，之后靠字典增长——码宽会真实增长，钉住变宽逻辑。
 */
function lzwLiteralEncode(pixels, minCodeSize, mode) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const bits = [];
  const emit = (code) => {
    for (let i = 0; i < codeSize; i += 1) bits.push((code >> i) & 1);
  };
  const bump = () => {
    if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
  };
  emit(clear);
  let prev = -1;
  for (const px of pixels) {
    if (mode === 'clear') emit(clear);
    emit(px);
    if (mode === 'dense' && prev !== -1 && next < 4096) {
      next += 1;
      bump();
    }
    prev = mode === 'clear' ? -1 : px;
  }
  emit(eoi);
  return packBits(bits);
}

function subBlocks(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 255) {
    const c = data.subarray(i, i + 255);
    out.push(Buffer.from([c.length]), c);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

/** 逻辑行序 → 交错存储行序（与解码端 pass 定义互逆）。 */
function interlaceRows(pixels, width, height) {
  const out = new Uint8Array(width * height);
  let dstRow = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) {
      out.set(pixels.subarray(y * width, (y + 1) * width), dstRow * width);
      dstRow += 1;
    }
  }
  return out;
}

function buildGif(width, height, palette, frames, { minCodeSize: minCodeSizeOverride } = {}) {
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const gctFlag = Math.max(0, Math.ceil(Math.log2(Math.max(2, palette.length))) - 1);
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | gctFlag;
  parts.push(lsd);
  const gct = Buffer.alloc(3 * (2 << gctFlag));
  palette.forEach(([r, g, b], i) => {
    gct[i * 3] = r;
    gct[i * 3 + 1] = g;
    gct[i * 3 + 2] = b;
  });
  parts.push(gct);
  const minCodeSize = minCodeSizeOverride ?? Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length))));
  for (const f of frames) {
    const transparentIndex = f.transparentIndex ?? -1;
    const gcePacked = ((f.dispose ?? 0) << 2) | (transparentIndex >= 0 ? 1 : 0);
    parts.push(Buffer.from([
      0x21, 0xf9, 0x04, gcePacked,
      (f.delayCs ?? 5) & 0xff, ((f.delayCs ?? 5) >> 8) & 0xff,
      transparentIndex >= 0 ? transparentIndex : 0, 0x00
    ]));
    const fw = f.w ?? width;
    const fh = f.h ?? height;
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(f.left ?? 0, 1);
    desc.writeUInt16LE(f.top ?? 0, 3);
    desc.writeUInt16LE(fw, 5);
    desc.writeUInt16LE(fh, 7);
    // 注意：descriptor 共 10 字节，packed 字段在 byte 9（byte 7-8 是 fh 的 LE16）——
    // 写错一位会把 fh 高字节覆盖掉（曾让 fh 变成 0x4004，教训钉在这里）。
    if (f.interlace) desc[9] = 0x40;
    parts.push(desc);
    parts.push(Buffer.from([minCodeSize]));
    let pixels = typeof f.pixels === 'function' ? f.pixels(fw, fh) : f.pixels;
    if (f.interlace) pixels = interlaceRows(pixels, fw, fh);
    parts.push(subBlocks(lzwLiteralEncode(pixels, minCodeSize, f.mode ?? 'clear')));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const solid = (color, w, h) => Uint8Array.from({ length: w * h }, () => color);

// ── 解码器 ───────────────────────────────────────────────────────────────
test('解码真实编码器产出的 1×1 GIF（结构与 GCT/GCE/透明）', () => {
  const buf = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const info = sniffImage(buf);
  assert.equal(info.format, 'gif');
  assert.equal(info.frames, 1, 'parseGif 口径');
  const decoded = decodeGifFrames(buf);
  assert.ok(decoded);
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.equal(decoded.frames.length, 1);
  const [frame] = decoded.frames;
  assert.equal(frame.delayMs, 0);
  assert.equal(frame.rgba[3], 0, 'GCE 声明透明索引 0 → 唯一像素透明');
});

test('解码多帧 + 帧数与 parseGif 交叉校验 + keep 抽帧', () => {
  const palette = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
  const frames = [];
  for (let k = 0; k < 6; k += 1) {
    frames.push({ pixels: solid(k, 8, 6), delayCs: 4 });
  }
  const buf = buildGif(8, 6, palette, frames);
  assert.equal(sniffImage(buf).frames, 6, 'parseGif 口径一致');
  const decoded = decodeGifFrames(buf);
  assert.equal(decoded.frames.length, 6);
  assert.deepEqual(decoded.frames.map((f) => f.index), [0, 1, 2, 3, 4, 5]);
  // 每帧颜色正确（跳帧快照不能串色）
  decoded.frames.forEach((f, k) => {
    assert.equal(f.rgba[0], palette[k][0]);
    assert.equal(f.rgba[2], palette[k][2]);
  });
  // keep 只留存指定帧，且索引语义是「解码序中的第几帧」
  const kept = decodeGifFrames(buf, { keep: new Set([1, 3]) });
  assert.deepEqual(kept.frames.map((f) => f.index), [1, 3]);
  assert.equal(kept.frames[0].rgba[2], 255, 'index 1 → 蓝帧');
  assert.equal(kept.frames[1].rgba[0], 255, 'index 3 → 黄帧');
});

test('透明索引跳过像素，露出下层画布；越界索引不动画布', () => {
  const palette = [[255, 0, 0], [0, 0, 255]];
  const buf = buildGif(4, 4, palette, [
    { pixels: solid(0, 4, 4) }, // 红底
    // 偶数位 → 透明索引 0（露红底），奇数位 → 索引 1（蓝）
    { pixels: Uint8Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 0 : 1)), transparentIndex: 0, w: 4, h: 4 }
  ]);
  const { frames } = decodeGifFrames(buf);
  const f1 = frames[1].rgba;
  assert.equal(f1[0], 255, '透明像素不动画布（还是红）');
  assert.equal(f1[1], 0);
  assert.equal(f1[3], 255, '露出的是红底而非透明');
  assert.equal(f1[(0 * 4 + 1) * 4 + 2], 255, '奇数位画成蓝');
  // 越界索引（超出 GCT 但在码域内）按「不动画布」处理，不抛错。
  // 注意 minCodeSize 必须大到能表达索引 9（2 色板默认 2 位码塞不下，曾截成 1 的教训）。
  const bad = buildGif(4, 4, palette, [
    { pixels: solid(0, 4, 4) },
    { pixels: solid(9, 4, 4), w: 4, h: 4 }
  ], { minCodeSize: 4 });
  const d2 = decodeGifFrames(bad);
  assert.equal(d2.frames[1].rgba[0], 255, '越界索引跳过');
});

test('处置法 2 清帧矩形、处置法 3 恢复保存画布（子矩形帧）', () => {
  const palette = [[255, 0, 0], [0, 0, 255], [0, 255, 0]];
  // frame1：只覆盖 (1,1)-(2,2) 的 2×2 蓝色子矩形帧 —— dispose 清的是**帧矩形**，
  // 不是整幅画布（曾用全幅帧测出「清了整屏」的假象，其实是 fixture 错）。
  const buf2 = buildGif(4, 4, palette, [
    { pixels: solid(0, 4, 4) },
    { pixels: solid(1, 2, 2), left: 1, top: 1, w: 2, h: 2, dispose: 2 },
    { pixels: solid(2, 4, 4), transparentIndex: 2 } // 全透明帧：只露出下层画布
  ]);
  const d2 = decodeGifFrames(buf2);
  const f2 = d2.frames[2].rgba;
  assert.equal(f2[(1 * 4 + 1) * 4 + 3], 0, 'dispose=2 清掉的蓝块区域回到透明');
  assert.equal(f2[0], 255, '帧矩形外仍是红底');
  assert.equal(f2[(1 * 4 + 1) * 4 + 1], 0, '不是绿帧整盖（frame2 的绿被透明索引跳过）');

  // dispose=3：恢复到合成 frame1 之前的画布
  const buf3 = buildGif(4, 4, palette, [
    { pixels: solid(0, 4, 4) },
    { pixels: solid(1, 2, 2), left: 1, top: 1, w: 2, h: 2, dispose: 3 },
    { pixels: solid(2, 4, 4), transparentIndex: 2 }
  ]);
  const d3 = decodeGifFrames(buf3);
  const g = d3.frames[2].rgba;
  assert.equal(g[(1 * 4 + 1) * 4], 255, 'dispose=3 后蓝块恢复成红底');
  assert.equal(g[(1 * 4 + 1) * 4 + 3], 255, '恢复的是不透明红底');
});

test('交错 GIF 行序还原', () => {
  const palette = [[10, 0, 0], [20, 0, 0], [30, 0, 0], [40, 0, 0]];
  const pixels = Uint8Array.from({ length: 16 }, (_, i) => Math.floor(i / 4));
  const buf = buildGif(4, 4, palette, [{ pixels, interlace: true }]);
  const { frames } = decodeGifFrames(buf);
  for (let r = 0; r < 4; r += 1) {
    assert.equal(frames[0].rgba[r * 16 + 0], palette[r][0], `第 ${r} 行行序正确`);
  }
});

test('dense 模式：码宽真实增长也能解码（与 parseGif 帧数交叉）', () => {
  const palette = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
  // 64 像素 + minCodeSize=2：字典从 6 长到 ~70，码宽 3→4→5→…，覆盖变宽路径
  const pixels = Uint8Array.from({ length: 64 }, (_, i) => i % 4);
  const buf = buildGif(8, 8, palette, [{ pixels, mode: 'dense' }]);
  assert.equal(sniffImage(buf).frames, 1);
  const decoded = decodeGifFrames(buf);
  assert.equal(decoded.frames.length, 1);
  assert.deepEqual([...decoded.frames[0].rgba.filter((_, i) => i % 4 === 0 && i / 4 < 8)], [1, 4, 7, 10, 1, 4, 7, 10], '像素序列无损');
});

test('坏输入返回 null 而不是抛错', () => {
  assert.equal(decodeGifFrames(Buffer.from('not a gif')), null);
  assert.equal(decodeGifFrames(Buffer.alloc(0)), null);
  const truncated = buildGif(4, 4, [[1, 2, 3], [4, 5, 6]], [{ pixels: solid(0, 4, 4) }]);
  assert.equal(decodeGifFrames(truncated.subarray(0, 20)), null, '截断的流解析不出帧');
});

// ── 抽样下标 ─────────────────────────────────────────────────────────────
test('pickSampleIndices：均匀铺满、去重升序、边界', () => {
  assert.deepEqual(pickSampleIndices(6, 6), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(pickSampleIndices(1, 6), [0]);
  assert.deepEqual(pickSampleIndices(200, 6), [0, 40, 80, 119, 159, 199], '时间上铺满整段');
  assert.deepEqual(pickSampleIndices(5, 2), [0, 4]);
  assert.deepEqual(pickSampleIndices(0, 3), [0], '0 帧兜底成 1 帧');
});

// ── PNG 编码 ─────────────────────────────────────────────────────────────
function pngChunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 签名');
  const out = [];
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    out.push({ type, data: png.subarray(pos + 8, pos + 8 + len) });
    pos += 12 + len;
  }
  return out;
}

test('encodePngRgba：IHDR 尺寸 + IDAT 无损回读', () => {
  const w = 3;
  const h = 2;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = i;
    rgba[i * 4 + 3] = 255;
  }
  const png = encodePngRgba(rgba, w, h);
  const chunks = pngChunks(png);
  assert.equal(chunks[0].type, 'IHDR');
  assert.equal(chunks[0].data.readUInt32BE(0), w);
  assert.equal(chunks[0].data.readUInt32BE(4), h);
  assert.equal(chunks[0].data[9], 6, 'color type RGBA');
  assert.equal(chunks.at(-1).type, 'IEND');
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  assert.equal(raw.length, h * (1 + w * 4));
  for (let y = 0; y < h; y += 1) {
    assert.equal(raw[y * (1 + w * 4)], 0, 'filter 0');
    for (let x = 0; x < w; x += 1) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      assert.equal(raw[o], y * w + x, '像素字节无损');
      assert.equal(raw[o + 3], 255);
    }
  }
});

test('encodePngRgba：长度不符直接抛错', () => {
  assert.throws(() => encodePngRgba(Buffer.alloc(4), 2, 2));
});

// ── 拼图编排 ─────────────────────────────────────────────────────────────
test('gifMosaic：6 帧 24×24 → 3×2 网格，格心颜色与帧对应、边距白底', async () => {
  const palette = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [255, 255, 0], [255, 0, 255], [0, 255, 255], [0, 0, 0]
  ];
  const frames = Array.from({ length: 6 }, (_, k) => ({ pixels: solid(k, 24, 24) }));
  const buf = buildGif(24, 24, palette, frames);
  const result = await gifMosaic(buf, { cols: 3, rows: 2, tileWidth: 32, totalFrames: 6, sampleFrames: 6 });
  assert.ok(result.ok, result.error);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.framesUsed, 6);
  assert.equal(result.width, 4 * 2 + 3 * 32 + 2 * 4, 'margin 4 + 格 + padding 4');
  assert.equal(result.height, 4 * 2 + 2 * 32 + 1 * 4);
  const chunks = pngChunks(result.buffer);
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const W = result.width;
  const at = (x, y) => {
    const o = y * (1 + W * 4) + 1 + x * 4;
    return [raw[o], raw[o + 1], raw[o + 2]];
  };
  // 六个格心 = 六帧颜色（行优先 左上→右下）
  for (let slot = 0; slot < 6; slot += 1) {
    const col = slot % 3;
    const row = Math.floor(slot / 3);
    const [r, g, b] = at(4 + col * 36 + 16, 4 + row * 36 + 16);
    assert.deepEqual([r, g, b], palette[slot], `slot ${slot} 格心颜色`);
  }
  // 边距与格间 padding 露白底
  assert.deepEqual(at(0, 0), [255, 255, 255]);
  assert.deepEqual(at(4 + 32 + 2, 4 + 16), [255, 255, 255], '格间 padding');
});

test('gifMosaic：抽帧数少于总帧数时按抽样下标取格', async () => {
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const frames = Array.from({ length: 10 }, (_, k) => ({ pixels: solid(k % 3, 16, 16), delayCs: 3 }));
  const buf = buildGif(16, 16, palette, frames);
  const result = await gifMosaic(buf, { cols: 2, rows: 2, tileWidth: 16, totalFrames: 10, sampleFrames: 4 });
  assert.ok(result.ok, result.error);
  assert.equal(result.framesUsed, 4, '10 帧抽 4');
  assert.deepEqual(pickSampleIndices(10, 4), [0, 3, 6, 9]);
});

test('gifMosaic：坏输入返回 ok:false', async () => {
  assert.equal((await gifMosaic(Buffer.from('junk'), { cols: 3, rows: 2, tileWidth: 32 })).ok, false);
  assert.equal((await gifMosaic(null, { cols: 3, rows: 2, tileWidth: 32 })).ok, false);
});

// ── 归一化集成：无 ffmpeg 也能拼图 ───────────────────────────────────────
test('normalizeImageForModel：动图走 animate 路径产出网格（ffmpeg 缺失时纯 JS 兜底）', async () => {
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
  const frames = Array.from({ length: 6 }, (_, k) => ({ pixels: solid(k, 24, 24), delayCs: 5 }));
  const buf = buildGif(24, 24, palette, frames);
  const result = await normalizeImageForModel(buf, 'image/gif', {
    maxModelBytes: 1024 * 1024, maxLongEdge: 1280, gifFrames: 6, gifTile: 240
  });
  assert.ok(result.ok, result.error);
  assert.match(result.note, /动图 6 帧\/0\.3s/, `note=${result.note}`);
  assert.match(result.note, /已抽 6 帧拼成 3×2 网格/);
  assert.ok(result.buffer.length > 0);
  // 无 ffmpeg 的机器上必须走纯 JS（png）；有 ffmpeg 的机器上走历史路径（jpeg）。
  assert.match(result.mimeType, /image\/(png|jpeg)/);
  if (result.mimeType === 'image/png') {
    assert.match(result.note, /纯 JS 解码/, `note=${result.note}`);
  }
});

test('normalizeImageForModel：ffmpeg 与纯 JS 都救不回的超大动图如实拒绝', async () => {
  // 高熵像素让 GIF 体积与拼图 PNG 都压不进 64KB 下限的 maxModelBytes；
  // gifTile=400 让纯 JS 拼图的噪声 PNG 也远超上限（最近邻缩放不平均噪声）。
  const palette = Array.from({ length: 4 }, (_, i) => [i * 60, i * 30, 255 - i * 60]);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % 4;
  };
  const frames = [
    { pixels: Uint8Array.from({ length: 800 * 800 }, () => rnd()), mode: 'dense' },
    { pixels: Uint8Array.from({ length: 800 * 800 }, () => rnd()), mode: 'dense' }
  ];
  const big = buildGif(800, 800, palette, frames);
  assert.ok(big.length > 64 * 1024, `fixture 应超过 64KB 下限，实际 ${big.length}`);
  const result = await normalizeImageForModel(big, 'image/gif', {
    maxModelBytes: 64 * 1024, maxLongEdge: 1280, gifFrames: 6, gifTile: 400
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /无法压缩/);
});
