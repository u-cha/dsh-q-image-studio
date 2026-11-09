import assert from "node:assert/strict"
import test from "node:test"

import {
  KEY_REF_PREFIX,
  LEGACY_KEY_REF_PREFIX,
  KeyMissingError,
  describeKey,
  keyRefFor,
  legacyKeyRefFor,
  maskError,
  maskSecrets,
  resolveKey,
  saveKey,
} from "../lib/secrets.js"

const key = "sk-abc123def456"

test("maskSecrets hides a bearer token", () => {
  assert.equal(maskSecrets(`Authorization: Bearer ${key}`, key), "Authorization: Bearer ***")
})

test("maskSecrets hides bare provider tokens", () => {
  assert.equal(maskSecrets("upstream said sk-abc123def456 invalid"), "upstream said *** invalid")
})

test("maskSecrets leaves ordinary words alone", () => {
  assert.equal(maskSecrets("модель qwen-image-3.0 недоступна"), "модель qwen-image-3.0 недоступна")
})

test("keyRefFor derives an upper-case reference", () => {
  assert.equal(keyRefFor({ id: "qwen" }), `${KEY_REF_PREFIX}QWEN`)
  assert.equal(keyRefFor({ id: "my-profile-1" }), `${KEY_REF_PREFIX}MY_PROFILE_1`)
})

test("keyRefFor honours an explicit apiKeyRef", () => {
  assert.equal(keyRefFor({ id: "x", apiKeyRef: "MY_KEY" }), "MY_KEY")
})

test("resolveKey reads the vault and rejects a missing key", async () => {
  const ctx = { credentials: { resolve: async (ref) => (ref === "MY_KEY" ? { value: "  secret-value  " } : undefined) } }
  assert.equal(await resolveKey(ctx, { apiKeyRef: "MY_KEY" }), "secret-value")
  await assert.rejects(resolveKey(ctx, { id: "other" }), (error) => {
    assert.ok(error instanceof KeyMissingError)
    assert.match(error.message, /ключ не задан для профиля/)
    return true
  })
})

test("saveKey refuses an empty value and describeKey reports configuration", async () => {
  const stored = new Map()
  const ctx = {
    credentials: {
      set: async (ref, value) => { stored.set(ref, value) },
      describe: async (ref) => ({ configured: stored.has(ref), writable: true }),
    },
  }
  await assert.rejects(saveKey(ctx, { id: "qwen" }, "   "), /пустой ключ не сохраняется/)
  await saveKey(ctx, { id: "qwen" }, " k ")
  assert.equal(stored.get(`${KEY_REF_PREFIX}QWEN`), "k")
  assert.deepEqual(await describeKey(ctx, { id: "qwen" }), { ref: `${KEY_REF_PREFIX}QWEN`, configured: true, writable: true })
})

test("legacy refs migrate the key to the new prefix and remove the old one", async () => {
  const stored = new Map([[`${LEGACY_KEY_REF_PREFIX}QWEN`, "old-secret"]])
  const ctx = {
    credentials: {
      resolve: async (ref) => (stored.has(ref) ? { value: stored.get(ref) } : undefined),
      describe: async (ref) => ({ configured: stored.has(ref), writable: true }),
      set: async (ref, value) => { stored.set(ref, value) },
      unset: async (ref) => { stored.delete(ref) },
    },
  }
  assert.equal(legacyKeyRefFor({ id: "qwen" }), `${LEGACY_KEY_REF_PREFIX}QWEN`)
  assert.deepEqual(await describeKey(ctx, { id: "qwen" }), { ref: `${KEY_REF_PREFIX}QWEN`, configured: true, writable: true })
  assert.equal(await resolveKey(ctx, { id: "qwen" }), "old-secret")
  assert.equal(stored.get(`${KEY_REF_PREFIX}QWEN`), "old-secret")
  assert.equal(stored.has(`${LEGACY_KEY_REF_PREFIX}QWEN`), false)
})

test("legacy explicit key refs map to the new reference", () => {
  assert.equal(keyRefFor({ id: "x", apiKeyRef: `${LEGACY_KEY_REF_PREFIX}X` }), `${KEY_REF_PREFIX}X`)
  assert.equal(legacyKeyRefFor({ id: "x", apiKeyRef: `${LEGACY_KEY_REF_PREFIX}X` }), `${LEGACY_KEY_REF_PREFIX}X`)
  assert.equal(legacyKeyRefFor({ id: "x", apiKeyRef: "MY_KEY" }), "")
})

test("maskError masks messages only", () => {
  assert.equal(maskError(new Error(`bad Bearer ${key}`), key), "bad Bearer ***")
})
