import { createJsonStore, isJsonObject } from './json-store.js';

export function createSessionStateStore({ file, log }) {
  const store = createJsonStore({
    file, log, fallback: () => ({ sessions: {}, sessionPolicies: {} }),
    validate: (value) => isJsonObject(value) && isJsonObject(value.sessions)
      && Object.values(value.sessions).every((id) => typeof id === 'string' && id.length > 0)
      && (value.sessionPolicies === undefined || isJsonObject(value.sessionPolicies)),
  });
  return {
    load() { const value = store.load(); return { ...value, sessionPolicies: value.sessionPolicies ?? {} }; },
    save: store.save,
    get writable() { return store.writable; },
  };
}
