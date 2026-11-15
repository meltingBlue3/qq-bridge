// 控制台「访问与安全」路由组：安全拦截通知设置 + state/ ACL 重试。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// （控制台访问令牌已于 2026-11-16 彻底移除，本文件不再有易变原语。）

import path from 'node:path';
import { atomicWriteJson, readConfigObject } from '../json-file.js';
import { manualDirCommand } from '../state-acl.mjs';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleSecurityRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    stateDir,
    getStateDirHardened,
    setStateDirHardened,
    hardenStateDirAcl,
    root,
    log
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/security') {
    sendJson({
      security: cfg.security ?? { interceptNotify: true },
      // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
      // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
      // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
      // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
      stateDir: {
        hardened: getStateDirHardened(),
        path: stateDir,
        manualCommand: process.platform === 'win32'
          ? manualDirCommand(stateDir)
          : `chmod 700 "${stateDir}"`
      }
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/security') {
    const body = await readBody();
    // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
    if (body.rehardenStateDir === true) {
      setStateDirHardened(null);
      hardenStateDirAcl();
      sendJson({ ok: getStateDirHardened() === true, hardened: getStateDirHardened(), path: stateDir });
      return true;
    }
    const configFile = path.join(root, 'config.json');
    const file = readConfigObject(configFile);
    const next = { ...(file.security ?? {}), ...body };
    if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
    else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
    file.security = next;
    atomicWriteJson(configFile, file);
    cfg.security = { ...(cfg.security ?? {}), ...next };
    log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
    sendJson({ ok: true, security: cfg.security });
    return true;
  }

  return false;
}
