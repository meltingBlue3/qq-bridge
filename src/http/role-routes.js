// 控制台「人格与角色」路由组。
//
// 从 bridge.js 的 startConsoleServer() 里整块搬出：只要 `handleRoleRoutes()` 返回 true，
// 调用方就不继续匹配其它路由。依赖由 deps 显式传入，路由本身不接触 bridge 闭包。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readConfigObject } from '../json-file.js';
import { roleCharStats, roleSectionReport } from '../role-card.js';
import { applyRoleInjectLimit } from '../config.js';
import { ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX } from '../roles.js';

/**
 * @param {object} input
 * @param {import('node:http').IncomingMessage} input.req
 * @param {URL} input.url
 * @param {(obj: object, status?: number) => void} input.sendJson
 * @param {() => Promise<object>} input.readBody
 * @param {object} input.deps
 * @returns {Promise<boolean>} true = 已处理，调用方不再匹配其它路由
 */
export async function handleRoleRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    roleSummaries,
    roleFilePath,
    validateRoleName,
    validateRoleContent,
    readRoleContent,
    writeRoleContent,
    roleWarnings,
    readRoleState,
    writeRoleState,
    getRoleInjectMaxChars,
    setRoleInjectMaxChars,
    root,
    cfg,
    log
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/roles') {
    const rs = readRoleState();
    const summaries = roleSummaries();
    sendJson({
      // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
      // 富信息放在 summaries 里，新老调用方互不影响。
      roles: summaries.map((role) => role.name),
      summaries,
      current: rs.role ?? null,
      limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: getRoleInjectMaxChars() },
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/roles/content') {
    let name;
    try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return true; }
    if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; }
    const content = readRoleContent(name);
    sendJson({
      ok: true,
      name,
      content,
      chars: content.length,
      bytes: Buffer.byteLength(content, 'utf8'),
      warnings: roleWarnings(content),
      limits: { injectMaxChars: getRoleInjectMaxChars() },
      stats: roleCharStats(content),
      // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
      sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
    const body = await readBody();
    const next = applyRoleInjectLimit(body.maxInjectChars);
    const configFile = path.join(root, 'config.json');
    const file = readConfigObject(configFile);
    file.role = { ...(file.role ?? {}), maxInjectChars: next };
    atomicWriteJson(configFile, file);
    cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
    setRoleInjectMaxChars(next);
    log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
    sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/roles/create') {
    const body = await readBody();
    let name; let content;
    try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
    catch (error) { sendJson({ ok: false, error: error.message }, 400); return true; }
    if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return true; }
    writeRoleContent(name, content);
    log(`控制台：创建人格「${name}」（${content.length} 字符）`);
    sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/roles/update') {
    const body = await readBody();
    let name; let content;
    try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
    catch (error) { sendJson({ ok: false, error: error.message }, 400); return true; }
    if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; }
    writeRoleContent(name, content);
    log(`控制台：更新人格「${name}」（${content.length} 字符）`);
    sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
    const body = await readBody();
    let from; let to;
    try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
    catch (error) { sendJson({ ok: false, error: error.message }, 400); return true; }
    if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return true; }
    if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return true; }
    if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return true; }
    fs.renameSync(roleFilePath(from), roleFilePath(to));
    const rs = readRoleState();
    const switched = rs.role === from;
    if (switched) writeRoleState(to, rs.mode);
    log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
    sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
    const body = await readBody();
    let name;
    try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return true; }
    if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; }
    fs.rmSync(roleFilePath(name));
    const rs = readRoleState();
    const cleared = rs.role === name;
    if (cleared) writeRoleState(null, rs.mode);
    log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
    sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
    return true;
  }

  return false;
}
