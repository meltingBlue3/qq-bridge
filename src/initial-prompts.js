// 会话初始提示词（操作者为每个群/私聊预写的环境说明）。
//
// 设计要点（与 bridge.js 里的旧实现一致，只是抽出可测边界）：
//   · 单独一个 state/initial-prompts.json；重置会话不会清掉它；
//   · 文件读不动/损坏时降级为「只读不写」，绝不把空映射回写覆盖原文件；
//   · 上限只在保存与注入两个出口生效，加载时不截断（截断会静默丢数据）；
//   · set() 写盘失败时回滚内存，保证接口失败与内存状态一致。

import fs from 'node:fs';
import { atomicWriteJson } from './json-file.js';
import { truncateText } from './md-to-plain.js';

/** 归一化操作者输入：统一行尾、去掉 BOM 与控制字符，只裁首尾空白（保留段落换行）。 */
export function normalizeInitialPromptText(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

/**
 * @param {object} options
 * @param {string} options.file state/initial-prompts.json 的绝对路径
 * @param {() => number} [options.maxChars] 当前保存/注入上限（每次调用重新读配置）
 * @param {(key: string) => string|null} options.canonicalKey key 归一化函数
 * @param {(line: string) => void} [options.log]
 */
export function createInitialPromptStore({
  file,
  maxChars = () => 2000,
  canonicalKey,
  log = () => {}
} = {}) {
  if (!file) throw new Error('createInitialPromptStore 缺少 file');
  if (typeof canonicalKey !== 'function') throw new Error('createInitialPromptStore 缺少 canonicalKey');

  const entries = new Map(); // canonical key -> { text, createdAt, updatedAt }
  let writable = true;

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        writable = false;
        log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      writable = false;
      log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writable = false;
      log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      const canonical = canonicalKey(key);
      if (!canonical) continue;
      // 加载时不按上限截断：文件里的内容可能是调小上限前写入的，截断后下次保存会把截断结果写回。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      entries.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (entries.size) log(`已加载 ${entries.size} 条会话初始提示词`);
  }

  function save() {
    if (!writable) {
      log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of entries) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(file, obj);
      return true;
    } catch (error) {
      log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  function get(key) {
    const canonical = canonicalKey(key);
    return canonical ? (entries.get(canonical) ?? null) : null;
  }

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * @returns {{ok:boolean,statusCode?:number,error?:string,key?:string,deleted?:boolean,chars?:number,entry?:object|null}}
   */
  function set(key, rawText) {
    const canonical = canonicalKey(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const limit = Math.max(0, Number(maxChars()) || 0);
    const text = normalizeInitialPromptText(rawText);
    if (text.length > limit) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${limit}）；请精简后重试` };
    }
    const prev = entries.get(canonical) ?? null;
    const rollback = () => { if (prev) entries.set(canonical, prev); else entries.delete(canonical); };
    if (!text) {
      entries.delete(canonical);
      if (!save()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    entries.set(canonical, entry);
    if (!save()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  /** 首次唤醒时插入的环境段；没配置或无法识别 key 时返回空串。 */
  function format(key) {
    const entry = get(key);
    if (!entry?.text) return '';
    const limit = Math.max(0, Number(maxChars()) || 0);
    const body = limit > 0 && entry.text.length > limit
      ? `${truncateText(entry.text, limit)}…（已按上限截断，完整内容见控制台）`
      : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  return {
    entries,
    load,
    save,
    get,
    set,
    format,
    get writable() { return writable; }
  };
}
