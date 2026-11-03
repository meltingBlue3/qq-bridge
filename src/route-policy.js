// HTTP 路由的「身份 × 路由」授权策略。
//
// 为什么要有这个模块：`bridge.js` 的控制台鉴权段过去把「agent 调用面」「管理端专用
// 接口」「只读降级」三套规则写成几十行相互嵌套的 if。每新增一个端点，作者都要
// 记得在四个地方各补一句；漏一处就可能把管理端点暴露给会话 agent（confused deputy）。
// 这里把规则收成一张表 + 一个纯函数：bridge 只负责解析请求并调用 `authorizeAgentRequest`。
//
// 设计约束：
//   · **默认拒绝**：带 x-agent-token 的请求只有显式列出的面放行，其余一律 403；
//   · 不依赖任何 bridge 闭包状态：模式、暂停、开关、存储可写性全部由调用方传入，
//     因此可以直接单测，不需要启动 HTTP 服务或桥接主程序；
//   · 所有路径比较都基于 pathname（不含 query）。

export const V2_PREFIX = '/api/socialV2/';
export const SEND_PREFIX = '/api/send/';
export const IMAGES_PREFIX = '/api/images/';

/** 管理端专用、agent token 一律不能访问的 v2 接口。 */
export const ADMIN_ONLY_V2_PATHS = Object.freeze([
  '/api/socialV2/config',
  '/api/socialV2/activity',
  '/api/socialV2/reset',
  '/api/socialV2/states',
  '/api/socialV2/wake',
  '/api/socialV2/initial-prompt'
]);

/** 黑话库的写接口（只读降级时必须拒绝并返回 503）。 */
export const READONLY_SLANG_PATHS = Object.freeze([
  '/api/slang',
  '/api/slang/clear',
  '/api/slang/extract',
  '/api/slang/research',
  '/api/socialV2/slang/submit'
]);

/** 表情库的写接口。 */
export const READONLY_STICKER_PATHS = Object.freeze([
  '/api/stickers/sync',
  '/api/stickers/note',
  '/api/stickers/remark',
  '/api/socialV2/sticker-note',
  '/api/socialV2/sticker-remark',
  '/api/socialV2/collect-sticker'
]);

const SLANG_BATCH_PREFIX = '/api/slang/batch-';

const hasPrefix = (pathname, prefix) => pathname.startsWith(prefix);

export function isV2Path(pathname) {
  return hasPrefix(pathname, V2_PREFIX);
}

export function isSendPath(pathname) {
  return hasPrefix(pathname, SEND_PREFIX);
}

export function isImagesPath(pathname) {
  return hasPrefix(pathname, IMAGES_PREFIX);
}

/** 带有效 agent token 时允许访问的路由面（白名单，不是黑名单）。 */
export function isAgentTokenAllowedPath(pathname) {
  return pathname === '/api/status'
    || pathname === '/api/authorize/read'
    || isV2Path(pathname)
    || isSendPath(pathname)
    || isImagesPath(pathname);
}

/**
 * `x-agent-call`（MCP 标记）存在但**没有**会话令牌时允许的路由。
 * 这个面只覆盖 closed-agent 需要的发送/探测；v2 面绝不在此列，否则会退化成管理端全权。
 */
export function isTokenlessAgentAllowedPath(pathname) {
  return pathname === '/api/status'
    || isSendPath(pathname)
    || isImagesPath(pathname);
}

/** 路由对应的只读降级存储名；无写保护的路由返回空串。 */
export function readonlyStoreForPath(pathname, method = 'POST') {
  if (method === 'GET') return '';
  if (READONLY_SLANG_PATHS.includes(pathname) || hasPrefix(pathname, SLANG_BATCH_PREFIX)) return '黑话库';
  if (READONLY_STICKER_PATHS.includes(pathname)) return '表情库';
  return '';
}

const deny = (status, error) => ({ ok: false, status, error });

/**
 * 判断一个请求在「agent / 控制台」维度上是否允许。
 *
 * @param {object} input
 * @param {string} input.method
 * @param {string} input.pathname
 * @param {Record<string, string|string[]|undefined>} input.headers
 * @param {(token: string) => boolean} [input.isLiveAgentToken]
 * @param {string} [input.mode] 当前运行模式（内部拼写）
 * @param {boolean} [input.socialV2Paused]
 * @param {boolean} [input.socialV2Enabled]
 * @param {boolean} [input.slangStoreWritable]
 * @param {boolean} [input.stickerStoreWritable]
 * @returns {{ok:true, actor:'console'|'agent'|'tokenless-agent'}|{ok:false,status:number,error:string}}
 */
export function authorizeAgentRequest({
  method = 'GET',
  pathname = '/',
  headers = {},
  isLiveAgentToken = () => false,
  mode = 'chat',
  socialV2Paused = false,
  socialV2Enabled = true,
  slangStoreWritable = true,
  stickerStoreWritable = true
} = {}) {
  const agentCallHeader = headers['x-agent-call'];
  const rawAgentToken = headers['x-agent-token'];
  const hasAgentToken = typeof rawAgentToken === 'string' && rawAgentToken !== '';

  // MCP 显式标记的 agent 调用：带令牌必须有效；不带令牌只能走 closed-agent 的窄面。
  if (agentCallHeader !== undefined) {
    if (hasAgentToken && !isLiveAgentToken(rawAgentToken)) {
      return deny(403, '未授权：智能体调用携带的会话令牌无效');
    }
    if (!hasAgentToken && !isTokenlessAgentAllowedPath(pathname)) {
      return deny(403, '未授权：该接口的智能体调用必须携带有效的会话令牌');
    }
  }

  // 空字符串 token 永远不是「管理端」，必须显式拒绝。
  if (rawAgentToken === '') return deny(403, 'agent token 不能为空');

  const tokenScoped = hasAgentToken && (isV2Path(pathname) || isSendPath(pathname) || isImagesPath(pathname));

  if (socialV2Paused && tokenScoped) return deny(403, 'AI 已暂停，当前不允许执行 v2 工具');
  if (!socialV2Enabled && tokenScoped) return deny(403, '二代模式已关闭，当前不允许执行 v2 工具');
  if (hasAgentToken && isV2Path(pathname) && mode !== 'reserved2') {
    return deny(403, '该接口仅 reserved2 模式可用');
  }

  if (hasAgentToken && (
    ADMIN_ONLY_V2_PATHS.includes(pathname)
    || (pathname === '/api/socialV2/feedback' && method === 'GET')
    || (pathname === '/api/socialV2/tool-log' && method === 'GET')
  )) {
    return deny(403, '该接口仅控制台可用');
  }

  if (hasAgentToken && (pathname === '/api/stickers' || hasPrefix(pathname, '/api/stickers/'))) {
    return deny(403, '该接口仅控制台可用');
  }

  if (hasAgentToken && !isAgentTokenAllowedPath(pathname)) {
    return deny(403, '该接口仅控制台可用');
  }

  if (method !== 'GET') {
    const store = readonlyStoreForPath(pathname, method);
    if (store === '黑话库' && !slangStoreWritable) {
      return deny(503, '黑话库处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接');
    }
    if (store === '表情库' && !stickerStoreWritable) {
      return deny(503, '表情库处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接');
    }
  }

  return { ok: true, actor: hasAgentToken ? 'agent' : (agentCallHeader !== undefined ? 'tokenless-agent' : 'console') };
}
