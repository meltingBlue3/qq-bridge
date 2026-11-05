// 配置加载与默认值。
//
// 这个模块是桥接 config.json 的解析入口：默认值来自 config-defaults.js；section 深度合并、
// ownerQQ/思考强度/人格注入上限的收敛都在这里。bridge.js 只负责把 ROOT 与日志函数传进来，
// 不再散落第二份默认值。测试可直接 import loadConfig({ root: 临时目录 }) 验证，不需要启动桥接。

import path from 'node:path';
import { readConfigObject } from './json-file.js';
import { createDefaultConfig } from './config-defaults.js';
export { createDefaultConfig } from './config-defaults.js';
import { discoverDshLaunchToken as defaultDiscoverDshLaunchToken } from './dsh-client.js';

// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
export const REASONING_EFFORT_OPTIONS = Object.freeze(['low', 'high', 'max']);
export const REASONING_EFFORT_DEFAULT = createDefaultConfig().dsh.reasoningEffort;

export function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

/** 人格卡注入上限（字符）：默认 8000，允许 1000~20000。 */
export const ROLE_INJECT_MAX_CHARS_DEFAULT = createDefaultConfig().role.maxInjectChars;

export function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}

/** 管理员 QQ（ownerQQ）：空值=未设置；必须是正整数 QQ 号。 */
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

/** 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。 */
export function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

const isSection = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Merge objects recursively; arrays replace arrays; null sections keep their defaults. */
export function mergeConfigDefaults(defaults, overrides) {
  const input = isSection(overrides) ? overrides : {};
  const result = { ...defaults };
  for (const [key, value] of Object.entries(input)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (isSection(defaults[key])) result[key] = mergeConfigDefaults(defaults[key], value);
    else result[key] = value == null && Object.hasOwn(defaults, key) ? defaults[key] : value;
  }
  return result;
}

export function loadConfig({ root = process.cwd(), log = () => {}, discoverDshLaunchToken = defaultDiscoverDshLaunchToken } = {}) {
  const p = path.join(root, 'config.json');
  const file = readConfigObject(p);
  const cfg = mergeConfigDefaults(createDefaultConfig(), file);
  cfg.ownerQQ = normalizeOwnerQQ(file.ownerQQ);
  cfg.allow = {
    private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
    groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
  };
  cfg.deny = {
    private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
    groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
  };
  cfg.allowAllWhenEmpty = file.allowAllWhenEmpty === true;

  // socialV2.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
  // 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
  {
    const raw = Number(cfg.socialV2?.initialPromptMaxChars);
    cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : createDefaultConfig().socialV2.initialPromptMaxChars;
  }

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  const roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return { cfg, roleInjectMaxChars };
}

