import { createJsonStore, isJsonObject } from '../json-store.js';
import { SessionRouter, migrateLegacyMode, canonicalConversationKey } from './session-router.mjs';

// The request adapter must derive this context after authentication. Never pass
// request-body fields as auth; updatedBy in a policy payload is not an identity.
export function policyOperator(auth, ownerQQ) {
  if (auth?.authenticated !== true) throw new Error('策略修改需要已认证的操作者');
  if (auth.kind === 'console') return 'console';
  const ownerKey = canonicalConversationKey(`private:${ownerQQ}`);
  if (auth.kind === 'qq' && ownerKey && auth.conversationKey === ownerKey
    && canonicalConversationKey(`private:${auth.senderId}`) === ownerKey) return `command:${ownerKey}`;
  throw new Error('策略修改仅允许控制台或 owner 本人私聊');
}

function routerFor(policy, ownerQQ) {
  return new SessionRouter({ ownerQQ, state: policy, defaultMode: policy.defaults.mode });
}

function validDocument(value) {
  if (!isJsonObject(value) || value.version !== 1 || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Array.isArray(value.audit) || value.audit.length !== value.revision
    || !isJsonObject(value.legacy) || typeof value.legacy.mode !== 'string') return false;
  try {
    routerFor(value.policy, value.ownerQQ);
    migrateLegacyMode(value.legacy);
    return value.audit.every((event, i) => isJsonObject(event) && event.seq === i + 1
      && Number.isSafeInteger(event.at) && event.at >= 0
      && typeof event.type === 'string' && typeof event.updatedBy === 'string');
  } catch { return false; }
}

// Policy + audit share one atomic document, so a successful save cannot publish
// policy without its audit event. Legacy mode/config files are never rewritten.
export function createConversationPolicyStore({ file, now = Date.now, log = () => {} }) {
  const storage = createJsonStore({ file, fallback: () => null, validate: validDocument, log });
  let document = storage.load();
  let cachedDocument;
  let cachedRouter;
  const snapshot = () => document === null ? null : structuredClone(document);
  function currentRouter() {
    if (!document?.enabled) throw new Error('逐会话路由尚未启用');
    if (cachedDocument !== document) {
      cachedRouter = routerFor(document.policy, document.ownerQQ);
      cachedDocument = document;
    }
    return cachedRouter;
  }
  function commit(next, event) {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('审计时间必须是非负整数');
    const revision = (document?.revision ?? 0) + 1;
    const candidate = { ...next, revision, audit: [...(document?.audit ?? []), { ...event, seq: revision, at }] };
    if (!storage.save(candidate)) throw storage.lastError ?? new Error('策略与审计保存失败');
    document = candidate;
    return snapshot();
  }

  function migrate({ mode, ownerQQ }, auth) {
    const updatedBy = policyOperator(auth, ownerQQ);
    if (document?.enabled) throw new Error('逐会话路由已启用，不能重复迁移');
    const migration = migrateLegacyMode({ mode, ownerQQ });
    return commit({ version: 1, enabled: true, ownerQQ: ownerQQ ?? null,
      policy: migration.state, legacy: { mode, ownerQQ: ownerQQ ?? null } }, {
      type: 'routing-migrated', updatedBy, before: document?.policy ?? null,
      after: migration.state, legacy: { mode, ownerQQ: ownerQQ ?? null }, events: migration.events,
    });
  }

  function update(key, record, auth) {
    const updatedBy = policyOperator(auth, document?.ownerQQ);
    currentRouter();
    const router = routerFor(document.policy, document.ownerQQ);
    const result = router.setConversation(key, { ...record, updatedBy });
    commit({ ...document, policy: router.snapshot() }, result.auditEvent);
    return { ...result, auditEvent: structuredClone(document.audit.at(-1)), revision: document.revision };
  }

  function remove(key, auth) {
    const updatedBy = policyOperator(auth, document?.ownerQQ);
    currentRouter();
    const router = routerFor(document.policy, document.ownerQQ);
    const result = router.deleteConversation(key, { updatedBy });
    commit({ ...document, policy: router.snapshot() }, result.auditEvent);
    return { ...result, auditEvent: structuredClone(document.audit.at(-1)), revision: document.revision };
  }

  function reconcileOwner(ownerQQ, auth) {
    if (policyOperator(auth, document?.ownerQQ) !== 'console') throw new Error('owner 变更仅允许控制台');
    currentRouter();
    const nextOwner = new SessionRouter({ ownerQQ }).ownerQQ;
    if (nextOwner === new SessionRouter({ ownerQQ: document.ownerQQ }).ownerQQ) return { changedKeys: [] };
    const policy = structuredClone(document.policy);
    const changedKeys = [];
    for (const [key, record] of Object.entries(policy.conversations)) {
      if (record.mode === 'closed-agent') {
        delete policy.conversations[key];
        changedKeys.push(key);
      } else if (record.updatedBy.startsWith('command:')) {
        // The old command actor remains in the audit trail. Re-provision the
        // retained record so the strict loader can validate against the new owner.
        record.updatedBy = 'migration';
      }
    }
    routerFor(policy, nextOwner);
    commit({ ...document, ownerQQ: nextOwner, policy }, {
      type: 'routing-owner-changed', updatedBy: 'console', beforeOwnerQQ: document.ownerQQ,
      afterOwnerQQ: nextOwner, before: document.policy, after: policy, changedKeys,
    });
    return { changedKeys, revision: document.revision };
  }

  function rollback(auth) {
    const updatedBy = policyOperator(auth, document?.ownerQQ);
    if (!document?.enabled) throw new Error('逐会话路由尚未启用');
    const legacy = structuredClone(document.legacy);
    commit({ ...document, enabled: false }, { type: 'routing-rolled-back', updatedBy, legacy });
    return legacy;
  }

  return {
    migrate, update, remove, rollback, reconcileOwner, snapshot,
    policyFor: (key) => currentRouter().policyFor(key),
    policyFingerprint: (key) => currentRouter().policyFingerprint(key),
    get ownerQQ() { return document?.ownerQQ ?? null; },
    get modes() {
      const policy = currentRouter().snapshot();
      return [...new Set([policy.defaults.mode, ...Object.values(policy.conversations).map((record) => record.mode)])];
    },
    get enabled() { return document?.enabled === true; },
    get writable() { return storage.writable; },
    get error() { return storage.lastError; },
  };
}
