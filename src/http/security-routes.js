// 控制台「访问与安全」路由组：安全拦截通知设置 + state/ ACL 重试 + 控制台令牌修改。
//
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。
// 令牌是本文件唯一"易变原语"：通过 getConsoleToken/setConsoleToken 回调读写。

import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJson, atomicWriteText, readConfigObject } from '../json-file.js';
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
    getConsoleToken,
    setConsoleToken,
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

  if (req.method === 'POST' && url.pathname === '/api/console/token') {
    const body = await readBody();
    let newToken = String(body.token ?? '').trim();
    const generated = !newToken;
    if (generated) {
      newToken = crypto.randomBytes(24).toString('hex');
    }
    if (newToken.length < 16) {
      sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
      return true;
    }
    if (newToken.length > 128) {
      sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
      return true;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
      sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
      return true;
    }
    const configFile = path.join(root, 'config.json');
    const file = readConfigObject(configFile);
    // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
    file.consoleToken = generated ? '' : newToken;
    atomicWriteJson(configFile, file);
    cfg.consoleToken = generated ? '' : newToken;
    atomicWriteText(path.join(stateDir, 'console-token'), newToken);
    setConsoleToken(newToken);
    log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
    sendJson({ ok: true, token: newToken, generated });
    return true;
  }

  return false;
}
