// 控制台「DSH 模型与思考强度」路由组。
//
// 从 startConsoleServer() 整块搬出。模型目录的在途请求去重（modelCatalogInFlight）
// 是跨请求状态：通过 getInFlight/setInFlight 回调由调用方持有。

import path from 'node:path';
import { unwrap } from '../dsh-client.js';
import { atomicWriteJson, readConfigObject } from '../json-file.js';
import { normalizeReasoningEffort, REASONING_EFFORT_DEFAULT, REASONING_EFFORT_OPTIONS } from '../config.js';

/**
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleDshRoutes({ req, url, sendJson, readBody, deps }) {
  const {
    cfg,
    fetchModelCatalog,
    withTimeout,
    getCatalogInFlight,
    setCatalogInFlight,
    catalogErrorsLogged,
    bumpModelSelectionEpoch,
    root,
    log
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
    let options = REASONING_EFFORT_OPTIONS.slice();
    let labels = {};
    let providerDefault = null;
    let catalogSource = 'fallback';
    try {
      if (!getCatalogInFlight()) {
        setCatalogInFlight(withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
          .finally(() => setCatalogInFlight(null)));
      }
      const catalog = unwrap(await getCatalogInFlight(), 'session.modelCatalog');
      const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
      const entry = (group?.models ?? []).find((m) => m?.id === model);
      const efforts = entry?.reasoning?.efforts ?? [];
      const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
      if (advertised.length) {
        options = advertised;
        labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
        providerDefault = entry.reasoning.defaultEffort ?? null;
        catalogSource = 'dsh';
      }
    } catch (error) {
      // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
      const reason = String(error?.message ?? error);
      if (!catalogErrorsLogged.has(reason)) {
        catalogErrorsLogged.add(reason);
        log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
      }
    }
    sendJson({
      provider,
      model,
      reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
      options,
      labels,
      default: REASONING_EFFORT_DEFAULT,
      providerDefault,
      catalogSource,
      // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
      // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
      globalSideEffect: true,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
    const body = await readBody();
    let effort;
    try { effort = normalizeReasoningEffort(body.reasoningEffort); }
    catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return true; }
    const configFile = path.join(root, 'config.json');
    // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
    const file = readConfigObject(configFile);
    file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
    atomicWriteJson(configFile, file);
    cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
    // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
    bumpModelSelectionEpoch();
    log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
    sendJson({ ok: true, reasoningEffort: effort });
    return true;
  }

  return false;
}
