// Shared preset bundle rendering and source/bundle persistence for CLI and console.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { atomicWriteText } from './json-file.js';

/** Legacy + canonical presets; order is also the bundle patch order. */
export const PRESETS = ['qq-chat', 'qq-chat-v2', 'qsh-sim', 'qsh-sim-v2', 'qsh-closed'];

/** preset 行 id：与 config.id（桥接解析的 preset 名）区分开，方便在 profile patch 里按行定位。 */
export function presetRowId(name) {
  return `preset-${name}`;
}

/**
 * 守卫行的引用方式：从 profile 目录可解析的裸说明符。
 *
 * 子行 name 按声明它的 loader 上下文解析（profile 目录），不是按 patch 文件或 preset 目录；
 * bundle patch 的「相对路径锚定」只作用于 insert 行自身（见 dsh-app-boot 的
 * anchorInsertedPluginNames），走不进 preset 行的 config.plugins。因此这里用
 * `<bundle 包名>/<子路径>`：profile package.json 以 link: 依赖声明该包，
 * node_modules junction 由 setup-dsh.mjs 或 dev_heal_links 维护。
 */
export const GUARD_SPECIFIER = 'qq-agent-presets/qq-tool-restrict.mjs';
export const CLOSED_GUARD_SPECIFIER = 'qq-agent-presets/qq-closed-tool-restrict.mjs';
export const presetGuardSpecifier = (name) => name === 'qsh-closed' ? CLOSED_GUARD_SPECIFIER : GUARD_SPECIFIER;

/** 源里允许出现的相对行名 → 新机制下的等价引用。其它相对名一律报错（避免静默装不上）。 */
const RELATIVE_ROW_REWRITES = new Map([
  ['./qq-tool-restrict.mjs', GUARD_SPECIFIER],
]);

function parseYaml(text, label) {
  try { return yaml.load(text); }
  catch (error) { throw new Error(`${label} 不是合法 YAML：${error?.message ?? error}`); }
}

/**
 * 校验并改写行列表：只允许已知的相对行名（守卫），其余相对名视为错误。
 * @param {unknown} rows agent.cordis.yml 解析出的行列表
 * @param {string} preset preset 名（诊断用）
 * @returns {object[]} 可写进 patch 的行列表（深拷贝后的新对象）
 */
function normalizeRows(rows, preset) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${preset}: agent.cordis.yml 必须是「非空的插件行列表」（顶层数组）`);
  }
  const seen = new Set();
  const walk = (list, at) => list.map((row, index) => {
    const label = `${preset}: ${at} 第 ${index + 1} 行`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label} 不是插件行（应为带 name 的映射）`);
    if (typeof row.name !== 'string' || row.name === '') throw new Error(`${label} 缺少 name`);
    if (typeof row.id !== 'string' || row.id === '') throw new Error(`${label} 缺少 id`);
    if (seen.has(row.id)) throw new Error(`${preset}: 行 id 重复：${row.id}`);
    seen.add(row.id);
    const next = { ...row };
    if (next.name.startsWith('.') || path.isAbsolute(next.name)) {
      const rewrite = RELATIVE_ROW_REWRITES.get(next.name);
      if (rewrite === undefined) {
        throw new Error(`${label}: 相对/绝对插件名 ${JSON.stringify(next.name)} 在 0.1.7 下会按 profile 目录解析，`
          + '必须改写为「bundle 包名/子路径」或去掉；请在 src/preset-patches.js 里显式登记改写规则');
      }
      next.name = next.name === './qq-tool-restrict.mjs' ? presetGuardSpecifier(preset) : rewrite;
    }
    if (row.group === true) {
      if (!Array.isArray(row.config)) throw new Error(`${label} 是 group 行但 config 不是行列表`);
      next.config = walk(row.config, `${at}/${row.id}`);
    }
    return next;
  });
  const normalized = walk(rows, 'plugins');
  for (const required of ['persona', 'qq-tool-restrict']) {
    if (!seen.has(required)) throw new Error(`${preset}: 行列表缺少 ${required} 行（安全/人格边界不允许缺失）`);
  }
  const findGuard = (list) => list.flatMap((row) => row.group === true ? [row, ...findGuard(row.config)] : [row]);
  const guard = findGuard(normalized).find((row) => row.id === 'qq-tool-restrict');
  if (guard.name !== presetGuardSpecifier(preset)) throw new Error(`${preset}: 工具守卫与 preset 权限不匹配`);
  return normalized;
}

/** 渲染一个 preset 的 patch 文件内容。 */
export function renderPresetPatch(name, metadataText, agentText) {
  const meta = parseYaml(metadataText, `${name}/preset.yml`);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`${name}: preset.yml 必须是映射`);
  for (const field of ['name', 'description', 'order']) {
    if (meta[field] === undefined) throw new Error(`${name}: preset.yml 缺少 ${field}`);
  }
  const plugins = normalizeRows(parseYaml(agentText, `${name}/agent.cordis.yml`), name);
  const row = {
    id: presetRowId(name),
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: name,
      name: meta.name,
      description: meta.description,
      order: meta.order,
      plugins,
    },
  };
  const header = [
    `# 本文件由 scripts/build-agent-preset-patches.mjs 生成，请勿手工编辑。`,
    `# 源：dsh/agent-presets/${name}/preset.yml + agent.cordis.yml（人格正文与工具面都在那里改）。`,
    `# 作用：把 ${name} 作为一条 @deepseek-ai/dsh-agent-preset 行插入 profile（DSH 0.1.7+ 的 preset 机制）。`,
    `# 守卫行 qq-tool-restrict 用裸说明符 ${presetGuardSpecifier(name)}：子行 name 按 profile 目录解析，`,
    `# 该包以 link: 依赖注册在 profile package.json（node_modules junction 由 setup-dsh.mjs 维护）。`,
    '',
  ].join('\n');
  // lineWidth: -1 —— 长行不折行，产物与源逐字对应，diff 只反映真实改动。
  return `${header}${yaml.dump([{ insert: [row] }], { lineWidth: -1, noRefs: true })}`;
}

function readPatch(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function renderForSource(name, sourceFile, text) {
  return renderPresetPatch(name,
    fs.readFileSync(path.join(path.dirname(sourceFile), 'preset.yml'), 'utf8'), text);
}

/** Artifact state only: this does not assert that a running DSH loaded the bundle. */
export function getPresetPatchStatus(name, { sourceFile, patchFile }) {
  const bundled = fs.existsSync(patchFile);
  try {
    const expected = renderForSource(name, sourceFile, fs.readFileSync(sourceFile, 'utf8'));
    return { bundled, synced: readPatch(patchFile) === expected };
  } catch { return { bundled, synced: false }; }
}

/**
 * Prepare both contents before writing. Each file is replaced atomically; a failed
 * patch replacement rolls back a completed source replacement. Cross-file crash
 * atomicity is not available: saving unchanged text repairs any stale patch.
 */
export function writePresetAndPatch(name, { sourceFile, patchFile, text }) {
  const previousSource = fs.readFileSync(sourceFile, 'utf8');
  const content = renderForSource(name, sourceFile, text);
  const previousPatch = readPatch(patchFile);
  const sourceChanged = text !== previousSource;
  const patchChanged = content !== previousPatch;
  let sourceWritten = false;
  try {
    if (sourceChanged) {
      atomicWriteText(sourceFile, text);
      sourceWritten = true;
    }
    if (patchChanged) atomicWriteText(patchFile, content);
  } catch (error) {
    if (sourceWritten) {
      try { atomicWriteText(sourceFile, previousSource); }
      catch (rollbackError) {
        throw new Error(`同步失败：${error.message}；源文件回滚失败：${rollbackError.message}；请检查源文件与备份`);
      }
    }
    throw error;
  }
  return { sourceChanged, patchChanged, synced: true, requiresRestart: sourceChanged || patchChanged };
}
