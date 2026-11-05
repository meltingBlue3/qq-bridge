// Shared persistence safeguards. Domain modules retain their schemas and in-memory state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteText } from './json-file.js';

export const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function readDocument(file, { fallback, validate, quarantine = false, onCorrupt }) {
  const text = readText(file);
  if (text === null) return { text, value: fallback() };
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!validate(value)) throw new Error('结构异常');
    return { text, value };
  } catch (cause) {
    let copy = '';
    if (quarantine) {
      const target = `${file}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(target, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        copy = `，原文另存为 ${target}`;
      } catch { /* the original file remains untouched even if a copy cannot be made */ }
    }
    const error = new Error(`${path.basename(file)} 内容损坏（${cause.message}）${copy}；已拒绝覆盖原文件`, { cause });
    onCorrupt?.(error.message);
    throw error;
  }
}

/** Strict one-shot reader for callers that handle read failures themselves. */
export function readJsonDocument(file, { fallback = () => null, validate = () => true, ...options } = {}) {
  return readDocument(file, { fallback, validate, ...options }).value;
}

/**
 * A missing file is writable. Failed reads or external edits make the store read-only
 * until an explicit reload; failed writes can be retried. Content comparison also
 * detects same-size/same-mtime edits. This is optimistic protection, not a cross-process lock.
 */
export function createJsonStore({ file, fallback, validate = () => true, log = () => {}, ...options }) {
  if (!file || typeof fallback !== 'function') throw new TypeError('createJsonStore requires file and fallback()');
  let loaded = false;
  let writable = true;
  let snapshot = null;
  let lastError = null;
  const report = (error) => { lastError = error; log(`⚠️ ${path.basename(file)}：${error.message}`); };

  function load() {
    loaded = true;
    try {
      const document = readDocument(file, { fallback, validate, ...options });
      snapshot = document.text;
      writable = true;
      lastError = null;
      return document.value;
    } catch (error) {
      writable = false;
      report(new Error(`${error.message}；已降级为只读，不会覆盖原文件`, { cause: error }));
      return fallback();
    }
  }

  function save(value) {
    if (!loaded) load();
    if (!writable) return false;
    try {
      if (!validate(value)) throw new Error('待保存数据结构异常，未写入');
      const serialized = JSON.stringify(value, null, 2);
      if (typeof serialized !== 'string') throw new Error('待保存数据不是 JSON');
      const text = `${serialized}\n`;
      let current;
      try { current = readText(file); }
      catch (error) { writable = false; throw error; }
      if (current !== snapshot) {
        writable = false;
        throw new Error('文件被其它进程改写，已切换只读以免覆盖更新的状态；修复或确认后重新加载');
      }
      if (text !== current) atomicWriteText(file, text);
      snapshot = text;
      lastError = null;
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  return { load, save, get writable() { return writable; }, get lastError() { return lastError; } };
}

/** Read fresh, preserve unrelated fields, and reject corruption or intervening edits. */
export function updateJsonDocument(file, update, { fallback = () => ({}), validate = isJsonObject } = {}) {
  const store = createJsonStore({ file, fallback, validate });
  const value = store.load();
  if (!store.writable) throw store.lastError;
  const next = update(value);
  if (!store.save(next)) throw store.lastError;
  return next;
}
