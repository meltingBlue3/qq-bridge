// qq-persona：把人格卡从「用户消息前缀」搬到「system prompt」里。
//
// 背景：DSH 的 sessions.prompt 只接受 user 角色的内容，sessions.create 也没有
// system prompt 参数；但 system prompt 的 section 支持模板变量，变量回调能拿到
// 当前 agent（= 会话）。于是这里注册一个 {{qq_persona}} 变量：
//   - 桥接在每次投递前，把当前人格卡写到 <DSH_HOME>/qq-persona/<sessionId>.md
//   - 本插件在装配 system prompt 时按会话读取它
//   - 人格卡正文因此进入 system prompt，随每轮重新渲染，改卡不用重启
//
// 对应契约：docs/guides/PROMPT_LAYERING.md §4（v2：system prompt 注入）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'qq-persona';
export const inject = ['systemPrompt'];

/** 诊断日志：设置 QQ_PERSONA_DIAG 指向一个文件即可记录每次解析结果。 */
const DIAG = process.env.QQ_PERSONA_DIAG ?? '';

function personaDir() {
  return (
    process.env.QQ_PERSONA_DIR ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'qq-persona')
  );
}

/** 会话 id 只允许安全字符，避免把路径拼出目录之外。 */
function safeSessionId(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function readPersona(sessionId) {
  const safe = safeSessionId(sessionId);
  if (!safe) return '';
  try {
    return fs.readFileSync(path.join(personaDir(), `${safe}.md`), 'utf8').trim();
  } catch {
    return '';
  }
}

export function apply(ctx) {
  // DSH 0.2.x 起 prompt 变量名强制 /^[a-z][a-z0-9_]*$/（全小写 snake_case），
  // 驼峰的 qqPersona 会在插件注册时被拒（invalid prompt variable name），
  // 进而导致 preset 里的引用变成未知变量、整个 agent 回合装配失败。
  ctx.systemPrompt.variable('qq_persona', (context) => {
    const id = context?.agent?.id ?? context?.agent?.session?.id ?? '';
    const text = readPersona(id);
    if (DIAG) {
      try {
        fs.appendFileSync(DIAG, `${new Date().toISOString()} session=${id} len=${text.length}\n`);
      } catch {
        /* 诊断失败不影响主流程 */
      }
    }
    return text;
  });
}
