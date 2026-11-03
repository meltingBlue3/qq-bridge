// 人格卡（roles/<名称>.md）的文件层：列目录、校验名称/内容、读写、注入预警与摘要。
//
// 这个模块不读全局配置：注入上限由 createRoleStore({ getInjectLimit }) 动态提供，
// 因此可以直接用临时目录测试，也避免 bridge.js 的 roleInjectMaxChars 全局散落到各处。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteText } from './json-file.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats } from './role-card.js';

export const ROLE_NAME_MAX = 40;
export const ROLE_CONTENT_MAX_BYTES = 64 * 1024;

const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，写入会失败甚至挂起。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** 人格名净化：只保留中文/字母/数字/横线（目录穿越在入口就被去掉）。 */
export function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

export function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const text = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (text) return text.slice(0, 80);
  }
  return '';
}

export function createRoleStore({ rolesDir, getInjectLimit = () => 8000 } = {}) {
  if (!rolesDir) throw new Error('createRoleStore 缺少 rolesDir');

  function roleFilePath(name) {
    return path.join(rolesDir, name + '.md');
  }

  function listRoles() {
    try {
      return fs.readdirSync(rolesDir)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .map((f) => f.slice(0, -3))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } catch {
      return [];
    }
  }

  function roleWarnings(content, mode = 'v2') {
    const text = String(content ?? '');
    const warnings = [];
    const limit = Math.max(0, Number(getInjectLimit()) || 0);
    const stats = roleCharStats(text);
    const injected = mode === 'v1' ? stats.v1 : stats.v2;
    if (injected > limit) {
      warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${limit} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
    }
    // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
    const untagged = parseRoleSections(text)
      .filter((section) => section.mode === 'all')
      .map((section) => section.lines.join('\n'))
      .join('\n');
    if (GEN1_ROLE_LINE_RE.test(untagged)) {
      warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
    }
    if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
      warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
    }
    return warnings;
  }

  function roleSummaries() {
    const limit = Math.max(0, Number(getInjectLimit()) || 0);
    return listRoles().map((name) => {
      const file = roleFilePath(name);
      try {
        const stat = fs.statSync(file);
        const content = fs.readFileSync(file, 'utf8');
        const stats = roleCharStats(content);
        return {
          name,
          bytes: stat.size,
          chars: content.length,
          lines: content.split('\n').length,
          mtime: stat.mtimeMs,
          excerpt: firstMeaningfulLine(content),
          // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
          injectedV1: Math.min(stats.v1, limit),
          injectedV2: Math.min(stats.v2, limit),
          charsV1: stats.v1,
          charsV2: stats.v2,
          hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
          truncated: stats.v1 > limit || stats.v2 > limit,
          warnings: roleWarnings(content).length,
        };
      } catch {
        return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
      }
    });
  }

  function validateRoleName(raw) {
    const name = sanitizeRoleName(raw);
    if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
    if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
    if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
    if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
    return name;
  }

  function readRoleContent(name) {
    return fs.readFileSync(roleFilePath(name), 'utf8');
  }

  function writeRoleContent(name, content) {
    fs.mkdirSync(rolesDir, { recursive: true });
    atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
  }

  return {
    roleFilePath,
    listRoles,
    roleWarnings,
    roleSummaries,
    validateRoleName,
    validateRoleContent,
    readRoleContent,
    writeRoleContent
  };
}
