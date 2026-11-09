/**
 * Vault-backed provider keys.
 *
 * The plugin config never stores a key — only the name of a credential
 * reference. All reads and writes go through `ctx.credentials`, and every
 * outbound error text passes through {@link maskSecrets}.
 */

/** Prefix used when a profile does not name its own credential reference. */
export const KEY_REF_PREFIX = "DSH_Q_IMAGE_STUDIO_KEY_"
/** Historical prefix, read only to migrate a key into the new reference. */
export const LEGACY_KEY_REF_PREFIX = "IMAGE_STUDIO_KEY_"

/** Thrown when a profile has no usable key in the vault. */
export class KeyMissingError extends Error {
  constructor(provider) {
    super(`ключ не задан для профиля ${providerLabel(provider)}`)
    this.name = "KeyMissingError"
    this.code = "key-missing"
  }
}

export function providerLabel(provider) {
  const label = typeof provider?.label === "string" && provider.label.trim().length > 0
    ? provider.label.trim()
    : provider?.id
  return typeof label === "string" && label.length > 0 ? label : "без имени"
}

function providerIdSuffix(provider) {
  const id = String(provider?.id ?? "default").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return id || "DEFAULT"
}

function migrateRef(ref) {
  if (ref.startsWith(LEGACY_KEY_REF_PREFIX)) return `${KEY_REF_PREFIX}${ref.slice(LEGACY_KEY_REF_PREFIX.length)}`
  return ref
}

/** Stable credential reference: explicit `apiKeyRef` or a derived upper-case id. */
export function keyRefFor(provider) {
  const explicit = typeof provider?.apiKeyRef === "string" ? provider.apiKeyRef.trim() : ""
  if (explicit.length > 0) return migrateRef(explicit)
  return `${KEY_REF_PREFIX}${providerIdSuffix(provider)}`
}

/** Pre-rename reference for the same profile (empty for custom non-legacy refs). */
export function legacyKeyRefFor(provider) {
  const explicit = typeof provider?.apiKeyRef === "string" ? provider.apiKeyRef.trim() : ""
  if (explicit.length > 0) return explicit.startsWith(LEGACY_KEY_REF_PREFIX) ? explicit : ""
  return `${LEGACY_KEY_REF_PREFIX}${providerIdSuffix(provider)}`
}

async function readCredential(ctx, ref) {
  if (!ref) return ""
  try {
    const hit = await ctx.credentials.resolve(ref)
    return typeof hit?.value === "string" ? hit.value.trim() : ""
  } catch {
    return ""
  }
}

const TOKEN_PATTERN = /\b(?:sk|ak|dash)[-_A-Za-z0-9]{8,}/g
const BEARER_PATTERN = /Bearer\s+[^\s"',;}]+/g

/**
 * Remove credentials from an arbitrary string before it reaches a log, an HTTP
 * response or a tool result.
 *
 * @param {string} text
 * @param {string|string[]} [secrets] exact secret values to redact
 */
export function maskSecrets(text, secrets) {
  let out = String(text ?? "")
  out = out.replace(BEARER_PATTERN, "Bearer ***")
  const values = (Array.isArray(secrets) ? secrets : [secrets])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length)
  for (const value of values) out = out.split(value).join("***")
  out = out.replace(TOKEN_PATTERN, "***")
  return out
}

/** Mask an error message (never the stack that may embed request options). */
export function maskError(error, secrets) {
  return maskSecrets(error instanceof Error ? error.message : String(error ?? "неизвестная ошибка"), secrets)
}

/**
 * Read one profile's key from the vault.
 *
 * @returns {Promise<string>} non-empty trimmed key
 * @throws {KeyMissingError} when the vault has no value for the reference
 */
export async function resolveKey(ctx, provider) {
  const ref = keyRefFor(provider)
  const value = await readCredential(ctx, ref)
  if (value.length > 0) return value

  // One-time migration: copy the old reference into the new one, and only
  // remove the old value after the new write succeeded.
  const legacy = legacyKeyRefFor(provider)
  if (legacy && legacy !== ref) {
    const oldValue = await readCredential(ctx, legacy)
    if (oldValue.length > 0) {
      try {
        await ctx.credentials.set(ref, oldValue)
        if (typeof ctx.credentials.unset === "function") await ctx.credentials.unset(legacy)
      } catch {
        /* keep the old key usable even if the vault refuses the copy */
      }
      return oldValue
    }
  }
  throw new KeyMissingError(provider)
}

/** Describe a key without revealing length, prefix or value. */
export async function describeKey(ctx, provider) {
  const ref = keyRefFor(provider)
  try {
    const info = await ctx.credentials.describe(ref)
    let configured = info?.configured === true
    let writable = info?.writable === true
    if (!configured) {
      const legacy = legacyKeyRefFor(provider)
      if (legacy && legacy !== ref) {
        const old = await ctx.credentials.describe(legacy).catch(() => undefined)
        configured = old?.configured === true
        writable = writable || old?.writable === true
      }
    }
    return { ref, configured, writable }
  } catch {
    return { ref, configured: false, writable: false }
  }
}

/** Store a key in the vault. */
export async function saveKey(ctx, provider, value) {
  const ref = keyRefFor(provider)
  const next = typeof value === "string" ? value.trim() : ""
  if (next.length === 0) throw new Error("пустой ключ не сохраняется")
  await ctx.credentials.set(ref, next)
  const legacy = legacyKeyRefFor(provider)
  if (legacy && legacy !== ref && typeof ctx.credentials.unset === "function") {
    await ctx.credentials.unset(legacy).catch(() => {})
  }
  return { ok: true, ref }
}

/** Forget a key in the vault (missing reference is not an error). */
export async function clearKey(ctx, provider) {
  const ref = keyRefFor(provider)
  if (typeof ctx.credentials.unset === "function") {
    await ctx.credentials.unset(ref)
    const legacy = legacyKeyRefFor(provider)
    if (legacy && legacy !== ref) await ctx.credentials.unset(legacy).catch(() => {})
  }
  return { ok: true, ref }
}
