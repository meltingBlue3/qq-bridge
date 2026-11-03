// JSON/文本文件的安全读写。
//
// 这组函数原本散落在 bridge.js 顶部，被 48 处调用点共享。抽出来的原因不是"文件太大"，
// 而是它们承载着几条**不能各写一份**的硬约束：
//   · 读配置失败必须能区分「文件不存在」和「文件坏了」；
//   · config.json 顶层必须是普通对象，否则任何"读-改-写"都会把整份配置抹掉；
//   · 写文件必须是同目录唯一临时名 + rename，否则进程中断/并发会写坏 state；
//   · Windows 上 rename 会被 Defender/编辑器短暂占用，需要有限退避重试。
// 调用方只需要知道这 5 个函数，不需要重新实现这些细节。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 读 JSON；文件缺失/损坏时返回 fallback；required=true 时抛带路径的错误。 */
export function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不写成 `readJsonSafe(file, null, true) ?? {}`：JSON.parse 对字面量 `null` 是成功的，
 * 于是 file 可能是 null（后续 file.socialV2 直接 TypeError）；用 `?? {}` 兜底更糟 ——
 * 回写会把整份配置替换成只含本次提交字段的新对象。所以不是普通对象就抛错。
 */
export function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：Windows 上 rename 覆盖一个正被打开的目标会抛 EPERM/EBUSY（Defender、
 * 编辑器预览、云同步都可能碰到）。有限退避重试，仍失败则抛出由调用方提示。
 */
export function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

function writeAtomic(file, data, encoding) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding, mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/** 原子写 JSON：统一 2 空格缩进 + 末尾换行，方便 diff 与人工编辑。 */
export function atomicWriteJson(file, obj) {
  writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/** 原子写文本。 */
export function atomicWriteText(file, text) {
  writeAtomic(file, text, 'utf8');
}
