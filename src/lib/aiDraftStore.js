// src/lib/aiDraftStore.js
const store = new Map();

/**
 * Draft structure:
 * { id, type: "meta"|"google", createdAt, payload }
 */

function uid() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10).toUpperCase()
  );
}

function putDraft(type, payload, ttlMs = 1000 * 60 * 60 * 24) {
  const id = uid();
  const createdAt = Date.now();
  const expiresAt = createdAt + ttlMs;

  store.set(id, { id, type, createdAt, expiresAt, payload });
  return { id, type, createdAt, expiresAt };
}

function getDraft(id) {
  const d = store.get(String(id || ""));
  if (!d) return null;
  if (Date.now() > d.expiresAt) {
    store.delete(d.id);
    return null;
  }
  return d;
}

function delDraft(id) {
  store.delete(String(id || ""));
}

function gc() {
  const now = Date.now();
  for (const [id, d] of store.entries()) {
    if (now > d.expiresAt) store.delete(id);
  }
}

// nettoyage périodique
setInterval(gc, 1000 * 60 * 10).unref?.();

module.exports = { putDraft, getDraft, delDraft };
