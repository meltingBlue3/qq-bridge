// 控制台「访问控制」路由组：白名单可视化编辑 + 测试发送。
//
// 这两条路由是一体的：白名单定义「谁能收发」，测试发送用同一条白名单/模式闸门验证。
// 从 startConsoleServer() 整块搬出；依赖显式传入，路由不接触 bridge 闭包。

import path from 'node:path';
import { text } from '@snowluma/sdk';
import { atomicWriteJson, readConfigObject } from '../json-file.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { normalizeOwnerQQ } from '../config.js';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleAccessRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    root,
    reconcileSessionPolicies,
    allowed,
    modeAllowed,
    getCurrentMode,
    redactKnownTokensOnly,
    escapeCqText,
    bot,
    log
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/whitelist') {
    sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/whitelist') {
    const body = await readBody();
    const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
    const configFile = path.join(root, 'config.json');
    // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
    const file = readConfigObject(configFile);
    const allow = {
      private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
      groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
    };
    const deny = {
      private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
      groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
    };
    // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
    let ownerQQ = cfg.ownerQQ ?? null;
    if (body.ownerQQ !== undefined) {
      try {
        ownerQQ = normalizeOwnerQQ(body.ownerQQ);
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
        return true;
      }
    }
    file.allow = allow;
    file.deny = deny;
    file.ownerQQ = ownerQQ;
    atomicWriteJson(configFile, file);
    cfg.allow = { private: allow.private, groups: allow.groups };
    cfg.deny = { private: deny.private, groups: deny.groups };
    cfg.ownerQQ = ownerQQ;
    reconcileSessionPolicies();
    log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
    sendJson({ ok: true, allow, deny, ownerQQ });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/test-send') {
    const body = await readBody();
    const kind = body.kind === 'private' ? 'private' : 'group';
    const id = Number(body.id);
    const message = String(body.message ?? '').trim();
    const currentMode = getCurrentMode(`${kind}:${id}`);
    if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return true; }
    if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
    if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return true; }
    if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return true; }
    try {
      const safeMessage = escapeCqText(redactKnownTokensOnly(message));
      const result = kind === 'private'
        ? await bot.sendPrivateMessage(id, text(safeMessage))
        : await bot.sendGroupMessage(id, text(safeMessage));
      log(`控制台：测试发送 ${kind}:${id} 成功`);
      sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
    } catch (error) {
      sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
    }
    return true;
  }

  return false;
}
