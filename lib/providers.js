/**
 * Provider probing: DashScope speaks its native multimodal-generation API for
 * images; third-party servers speak OpenAI's `/images/generations`. The
 * DashScope `compatible-mode` image route does not exist, so style detection
 * probes the native generation endpoint first and only then looks at model
 * lists. Never guessed from a config field.
 */

import { maskSecrets } from "./secrets.js"

export const STATIC_QWEN_MODELS = ["qwen-image-3.0", "qwen-image-2.1", "qwen-image-3.0-pro"]
export const DASHSCOPE_NATIVE_STYLE = "dashscope-native"
/** Native DashScope image generation; the only image route on dashscope-intl. */
export const NATIVE_IMAGES_PATH = "/api/v1/services/aigc/multimodal-generation/generation"
const CACHE_TTL_MS = 5 * 60 * 1000
const PROBE_TIMEOUT_MS = 15_000

const cache = new Map()

/** HTTP status / transport failures carry a machine-readable `code`. */
export class ConnectionError extends Error {
  constructor(message, code) {
    super(message)
    this.name = "ConnectionError"
    this.code = code
  }
}

export function trimBaseUrl(baseUrl) {
  return String(baseUrl ?? "").trim().replace(/\/+$/, "")
}

/** Absolute native generation endpoint; tolerates compat/v1 prefixes in the base URL. */
export function nativeEndpointFor(baseUrl) {
  const base = trimBaseUrl(baseUrl)
    .replace(/\/compatible-mode\/v1$/, "")
    .replace(/\/api\/v1$/, "")
    .replace(/\/v1$/, "")
  if (base.length === 0) throw new ConnectionError("не задан адрес поставщика", "address")
  return base + NATIVE_IMAGES_PATH
}

/** Candidate model-list paths, in probe order. */
export function candidatePaths(_baseUrl) {
  return ["/v1/models", "/compatible-mode/v1/models"]
}

function modelUrls(baseUrl) {
  const base = trimBaseUrl(baseUrl)
  if (base.length === 0) return []
  if (base.endsWith("/compatible-mode/v1")) return [base + "/models"]
  if (base.endsWith("/v1")) return [base + "/models"]
  return [base + "/v1/models", base + "/compatible-mode/v1/models"]
}

function dashscopeIndexUrl(baseUrl) {
  try {
    const url = new URL(trimBaseUrl(baseUrl))
    if (!/dashscope/i.test(url.hostname)) return undefined
    url.pathname = "/api/v1/models"
    url.search = "capabilities=image-generation"
    return url.toString()
  } catch {
    return undefined
  }
}

const NATIVE_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS

/**
 * Whether the base URL exposes DashScope's native multimodal generation.
 * A `{}` POST is rejected with 400 when the route exists; 404 means it does not.
 * 401/403 still prove the route exists, but they also mean the key is refused.
 *
 * @returns {Promise<boolean>} true when the native route exists
 */
async function probeNative(baseUrl, key, fetchImpl, signal) {
  const url = nativeEndpointFor(baseUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NATIVE_PROBE_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener?.("abort", abort, { once: true })
  try {
    let response
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: "{}",
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted) throw new ConnectionError("запрос отменён", "network")
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw new ConnectionError("поставщик не ответил за 15 секунд", "network")
      }
      throw new ConnectionError("не удалось подключиться к поставщику", "network")
    }
    if (response.status === 401 || response.status === 403) {
      throw new ConnectionError("ключ отклонён поставщиком (401/403)", "auth")
    }
    // 400 (invalid body) / auth / validation mean the route is there.
    return response.ok || [400, 401, 403, 415, 422].includes(response.status)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", abort)
  }
}

function styleForUrl(url) {
  return /\/compatible-mode\/v1\/models$/.test(url) ? "dashscope-compat" : "openai"
}

function modelsFromJson(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  const models = []
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id ?? row?.name
    if (typeof id === "string" && id.length > 0 && !models.includes(id)) models.push(id)
  }
  const extra = Array.isArray(json?.output?.models) ? json.output.models : []
  for (const row of extra) {
    const id = row?.name ?? row?.id
    if (typeof id === "string" && id.length > 0 && !models.includes(id)) models.push(id)
  }
  return models
}

async function fetchJson(url, key, fetchImpl, signal) {
  let response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal,
    })
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new ConnectionError("поставщик не ответил за 15 секунд", "network")
    }
    throw new ConnectionError("не удалось подключиться к поставщику", "network")
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConnectionError("ключ отклонён поставщиком (401/403)", "auth")
  }
  if (!response.ok) return { ok: false, status: response.status }
  let json
  try {
    json = await response.json()
  } catch {
    return { ok: false, status: response.status }
  }
  return { ok: true, status: response.status, json }
}

/**
 * Ask the provider which API style it speaks and which models it exposes.
 *
 * @param {string} baseUrl
 * @param {string} key
 * @param {typeof fetch} [fetchImpl]
 * @param {{ signal?: AbortSignal, useCache?: boolean }} [options]
 * @returns {Promise<{style: "openai" | "dashscope-compat", models: string[]}>}
 */
export async function detectStyle(baseUrl, key, fetchImpl = fetch, options = {}) {
  const base = trimBaseUrl(baseUrl)
  const cached = cache.get(base)
  if (options.useCache !== false && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { style: cached.style, models: [...cached.models] }
  }

  const signal = options.signal
  let lastFailure

  // Native DashScope first: compat `/models` answering 200 does not imply that
  // compat `/images/generations` exists (it returns 404 on dashscope-intl).
  let native = false
  try {
    native = await probeNative(base, key, fetchImpl, signal)
  } catch (error) {
    if (error instanceof ConnectionError && error.code === "auth") throw error
    lastFailure = error
  }
  if (native) {
    let models = []
    for (const url of modelUrls(base)) {
      try {
        const hit = await fetchJson(url, key, fetchImpl, signal)
        if (hit.ok) {
          models = modelsFromJson(hit.json)
          if (models.length > 0) break
        }
      } catch {
        /* model lists are optional for generation; keep probing */
      }
    }
    if (models.length === 0) models = [...STATIC_QWEN_MODELS]
    const result = { style: DASHSCOPE_NATIVE_STYLE, models }
    cache.set(base, { ...result, at: Date.now() })
    return result
  }

  for (const url of modelUrls(base)) {
    let hit
    try {
      hit = await fetchJson(url, key, fetchImpl, signal)
    } catch (error) {
      if (error instanceof ConnectionError && error.code === "auth") throw error
      lastFailure = error
      continue
    }
    if (!hit.ok) {
      lastFailure = new ConnectionError(`поставщик ответил HTTP ${hit.status} на ${new URL(url).pathname}`, "address")
      continue
    }
    const style = styleForUrl(url)
    const models = modelsFromJson(hit.json)
    const result = { style, models }
    cache.set(base, { ...result, at: Date.now() })
    return result
  }

  const fallbackUrl = dashscopeIndexUrl(base)
  if (fallbackUrl) {
    let hit
    try {
      hit = await fetchJson(fallbackUrl, key, fetchImpl, signal)
    } catch (error) {
      if (error instanceof ConnectionError && error.code === "auth") throw error
      lastFailure = error
      hit = { ok: false }
    }
    if (hit.ok) {
      const models = modelsFromJson(hit.json)
      const result = { style: "dashscope-compat", models }
      cache.set(base, { ...result, at: Date.now() })
      return result
    }
  }

  throw lastFailure instanceof ConnectionError
    ? lastFailure
    : new ConnectionError("ни один адрес списка моделей не ответил", "address")
}

export function imagesPath(style) {
  if (style === DASHSCOPE_NATIVE_STYLE) return NATIVE_IMAGES_PATH
  return style === "dashscope-compat" ? "/compatible-mode/v1/images/generations" : "/v1/images/generations"
}

/** Absolute images endpoint; tolerates a base URL that already contains the API prefix. */
export function endpointFor(baseUrl, style) {
  if (style === DASHSCOPE_NATIVE_STYLE) return nativeEndpointFor(baseUrl)
  const base = trimBaseUrl(baseUrl)
  if (base.length === 0) throw new ConnectionError("не задан адрес поставщика", "address")
  if (style === "dashscope-compat" && base.endsWith("/compatible-mode/v1")) return base + "/images/generations"
  if (style === "openai" && base.endsWith("/v1")) return base + "/images/generations"
  return base + imagesPath(style)
}

export function supportsReferenceEditing(style) {
  return style === DASHSCOPE_NATIVE_STYLE || style === "dashscope-compat"
}

export function clearStyleCache() {
  cache.clear()
}

/**
 * Whether the profile points at Alibaba DashScope. Qwen image models are only
 * guaranteed there; anything else gets a warning in the UI.
 */
export function isDashScopeBase(baseUrl) {
  try {
    const host = new URL(trimBaseUrl(baseUrl)).hostname.toLowerCase()
    return host === "aliyuncs.com" || host.endsWith(".aliyuncs.com")
  } catch {
    return false
  }
}

/** Native DashScope model catalogue with pagination. */
export function dashscopeModelsUrl(baseUrl, pageNo = 1, pageSize = 100) {
  const base = nativeEndpointFor(baseUrl).replace(NATIVE_IMAGES_PATH, "")
  return `${base}/api/v1/models?page_size=${pageSize}&page_no=${pageNo}`
}

function compatModelsUrl(baseUrl) {
  const base = trimBaseUrl(baseUrl)
  if (base.endsWith("/compatible-mode/v1")) return base + "/models"
  if (base.endsWith("/v1")) return base + "/models"
  return base + "/compatible-mode/v1/models"
}

function modelRows(json) {
  // DashScope's native catalogue returns `{ output: { models: [...] } }`;
  // OpenAI-compatible servers use `data` (and some proxies, `models`).
  const candidates = [json?.output?.models, json?.data, json?.models]
  const rows = candidates.find((value) => Array.isArray(value) && value.length > 0) ?? []
  return rows.filter((row) => row !== null && typeof row === "object")
}

function rowName(row) {
  const value = row?.model ?? row?.id ?? row?.name
  return typeof value === "string" ? value.trim() : ""
}

function capabilitiesOf(row) {
  const raw = row?.capabilities ?? row?.capability
  if (Array.isArray(raw)) return raw.map((item) => String(item).toUpperCase())
  if (typeof raw === "string") return raw.split(/[,\s]+/).map((item) => item.toUpperCase())
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name.toUpperCase())
  }
  return []
}

function isImageModel(name) {
  return /^qwen-image-/i.test(name) && !/^qwen-mt-image-/i.test(name)
}

/** DashScope rows: capabilities must include IG and the name must be qwen-image-*. */
function igModelsFromRows(rows) {
  const out = []
  for (const row of rows) {
    const name = rowName(row)
    if (!isImageModel(name)) continue
    if (!capabilitiesOf(row).includes("IG")) continue
    if (!out.includes(name)) out.push(name)
  }
  return out
}

function qwenModelsFromList(json) {
  const out = []
  for (const row of modelRows(json)) {
    const name = rowName(row)
    if (isImageModel(name) && !out.includes(name)) out.push(name)
  }
  const ids = Array.isArray(json?.data) ? json.data : []
  for (const row of ids) {
    const name = typeof row === "string" ? row.trim() : ""
    if (isImageModel(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * List only Qwen image models suitable for Q Image Studio.
 *
 * DashScope: `/api/v1/models` paginated, capabilities contains `IG`.
 * Other OpenAI-compatible servers: `/compatible-mode/v1/models`, name prefix.
 */
export async function listIGModels(baseUrl, key, fetchImpl = fetch, options = {}) {
  const base = trimBaseUrl(baseUrl)
  if (base.length === 0) throw new ConnectionError("не задан адрес поставщика", "address")
  const signal = options.signal
  const pageSize = options.pageSize ?? 100
  const maxPages = options.maxPages ?? 20

  if (isDashScopeBase(base)) {
    const models = []
    let rawCount = 0
    let total = undefined
    for (let page = 1; page <= maxPages; page += 1) {
      const hit = await fetchJson(dashscopeModelsUrl(base, page, pageSize), key, fetchImpl, signal)
      if (!hit.ok) {
        const code = hit.status === 404 ? "not-found" : "address"
        throw new ConnectionError(`поставщик ответил HTTP ${hit.status} на списке моделей`, code)
      }
      const rows = modelRows(hit.json)
      rawCount += rows.length
      const pageTotal = hit.json?.output?.total ?? hit.json?.total
      if (typeof pageTotal === "number") total = pageTotal
      for (const name of igModelsFromRows(rows)) if (!models.includes(name)) models.push(name)
      if (rows.length < pageSize || page >= maxPages) break
      if (typeof total === "number" && rawCount >= total) break
    }
    if (models.length === 0) {
      // Some DashScope regions do not expose IG capabilities in the native
      // catalogue; the compatible-mode list is a safe last resort.
      try {
        const fallback = await fetchJson(compatModelsUrl(base), key, fetchImpl, signal)
        if (fallback.ok) return qwenModelsFromList(fallback.json)
      } catch {
        /* keep the empty list; the caller shows a clear "no models" state */
      }
    }
    return models
  }

  const hit = await fetchJson(compatModelsUrl(base), key, fetchImpl, signal)
  if (!hit.ok) {
    const code = hit.status === 404 ? "not-found" : "address"
    throw new ConnectionError(`поставщик ответил HTTP ${hit.status} на списке моделей`, code)
  }
  return qwenModelsFromList(hit.json)
}

/**
 * Verify a profile without generating anything: one GET to the model catalogue.
 *
 * @returns {Promise<{ok: boolean, style?: string, models?: string[], verifiedAt?: string, code?: string, message?: string}>}
 */
export async function verifyConnection(baseUrl, key, fetchImpl = fetch, options = {}) {
  const signal = options.signal ?? AbortSignal.timeout(20_000)
  try {
    const models = await listIGModels(baseUrl, key, fetchImpl, { ...options, signal })
    return {
      ok: true,
      style: isDashScopeBase(baseUrl) ? DASHSCOPE_NATIVE_STYLE : "openai",
      models,
      verifiedAt: new Date().toISOString(),
      message: `подключено, моделей ${models.length}`,
    }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ConnectionError ? error.code : "network",
      message: maskSecrets(error?.message ?? "не удалось подключиться", key),
    }
  }
}

/**
 * Human-readable connection probe.
 *
 * @returns {Promise<{ok: boolean, style?: string, models?: string[], code?: string, message: string}>}
 */
export async function testConnection(baseUrl, key, fetchImpl = fetch, options = {}) {
  try {
    const hit = await detectStyle(baseUrl, key, fetchImpl, { ...options, useCache: false })
    const count = hit.models.length
    return {
      ok: true,
      style: hit.style,
      models: hit.models,
      message: `соединение есть: ${hit.style}, моделей ${count}`,
    }
  } catch (error) {
    const code = error instanceof ConnectionError ? error.code : "network"
    return { ok: false, code, message: maskSecrets(error?.message ?? "не удалось подключиться", key) }
  }
}
