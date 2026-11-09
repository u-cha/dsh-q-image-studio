/**
 * Image generation request/response plumbing for the compatible-mode API.
 * Kept free of plugin context so it is trivially testable.
 */

import { DASHSCOPE_NATIVE_STYLE, endpointFor } from "./providers.js"
import { maskSecrets } from "./secrets.js"

export const MAX_SEED = 2147483647

/** One uniform seed in the 31-bit range accepted by DashScope. */
export function randomSeed(random = Math.random) {
  return Math.min(MAX_SEED, Math.floor(random() * (MAX_SEED + 1)))
}

export class ProviderError extends Error {
  constructor(message, code = "provider", details = {}) {
    super(message)
    this.name = "ProviderError"
    this.code = code
    this.httpStatus = details.httpStatus
    this.providerCode = details.providerCode
    this.providerMessage = details.providerMessage
  }
}

const REQUEST_TIMEOUT_MS = 120_000

/** Human-readable duration for timeout errors; keeps the real limit visible. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "неизвестное время"
  if (ms % 60_000 === 0) return `${ms / 60_000} мин`
  if (ms % 1_000 === 0) return `${ms / 1_000} сек`
  return `${Math.round(ms)} мс`
}

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
}

/** File-name-safe transliterated slug, max 40 chars. */
export function slugify(prompt, max = 40) {
  const latin = String(prompt ?? "")
    .toLowerCase()
    .split("")
    .map((char) => (char in TRANSLIT ? TRANSLIT[char] : char))
    .join("")
  const slug = latin
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
  return slug.length > 0 ? slug : "image"
}

const TRANSPARENT_PREFIX = "This is an RGBA image with transparency."
const TRANSPARENT_SUFFIX = "The image has alpha channel and the background is transparent."

/** Exact prompt wrapper requested for transparent PNG generation. */
export function transparentPrompt(prompt) {
  return `${TRANSPARENT_PREFIX} ${String(prompt ?? "").trim()}. ${TRANSPARENT_SUFFIX}`
}

/** Native DashScope wants `W*H`; accept the UI/OpenAI `WxH` spelling too. */
export function nativeSize(size) {
  const text = typeof size === "string" ? size.trim() : ""
  return text.replace(/[x×]/gi, "*")
}

/**
 * Build the JSON body for the detected transport.
 * - `dashscope-native`: `{model, input:{messages:[{role,content:[{image}?,{text}]}]}, parameters:{...}}`
 * - OpenAI-compatible: flat `{model, prompt, image?, ...}`.
 * Only protocol fields that are set are emitted.
 *
 * @param {object} options
 * @param {"openai" | "dashscope-compat" | "dashscope-native"} [style]
 */
export function buildBody(options = {}, style = options.style ?? "openai") {
  const model = typeof options.model === "string" ? options.model.trim() : ""
  const prompt = typeof options.prompt === "string" ? options.prompt.trim() : ""
  const images = Array.isArray(options.images) ? options.images.filter((item) => typeof item === "string" && item.length > 0) : []
  const negative = options.negativePrompt ?? options.negative_prompt

  if (style === DASHSCOPE_NATIVE_STYLE) {
    const content = [...images.map((image) => ({ image })), { text: prompt }]
    const parameters = {}
    const size = nativeSize(options.size)
    if (size.length > 0) parameters.size = size
    if (options.n !== undefined && options.n !== null) parameters.n = options.n
    if (typeof negative === "string" && negative.trim().length > 0) parameters.negative_prompt = negative.trim()
    if (typeof options.seed === "number" && Number.isFinite(options.seed)) parameters.seed = options.seed
    if (typeof options.promptExtend === "boolean") parameters.prompt_extend = options.promptExtend
    if (typeof options.watermark === "boolean") parameters.watermark = options.watermark
    return {
      model,
      input: { messages: [{ role: "user", content }] },
      parameters,
    }
  }

  const body = { model, prompt }
  if (options.n !== undefined && options.n !== null) body.n = options.n
  if (typeof options.size === "string" && options.size.length > 0) body.size = options.size
  if (typeof negative === "string" && negative.trim().length > 0) body.negative_prompt = negative.trim()
  if (typeof options.seed === "number" && Number.isFinite(options.seed)) body.seed = options.seed
  if (typeof options.promptExtend === "boolean") body.prompt_extend = options.promptExtend
  if (typeof options.watermark === "boolean") body.watermark = options.watermark
  if (images.length === 1) body.image = images[0]
  else if (images.length > 1) body.image = images
  return body
}

/**
 * Extract result URLs from a native DashScope payload
 * (`output.choices[].message.content[].image`) or from OpenAI-compatible
 * `data[].url` / legacy `output.results[].url` payloads.
 */
export function parseResponse(json) {
  const urls = []
  const choices = Array.isArray(json?.output?.choices) ? json.output.choices : []
  for (const choice of choices) {
    const content = Array.isArray(choice?.message?.content) ? choice.message.content : []
    for (const item of content) {
      const url = item?.image ?? item?.image_url
      if (typeof url === "string" && /^(https?:|data:image\/)/.test(url) && !urls.includes(url)) urls.push(url)
    }
  }
  if (urls.length > 0) return { urls }
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.output?.results) ? json.output.results : []
  for (const row of rows) {
    const url = typeof row === "string" ? row : row?.url ?? row?.image_url
    if (typeof url === "string" && /^(https?:|data:image\/)/.test(url) && !urls.includes(url)) urls.push(url)
  }
  if (urls.length === 0) throw new ProviderError("поставщик не вернул картинку")
  return { urls }
}

function errorTextFromBody(text, key) {
  if (typeof text !== "string" || text.trim().length === 0) return { code: "", message: "" }
  let message = text.trim()
  let code = ""
  try {
    const json = JSON.parse(message)
    code = String(json?.code ?? json?.error?.code ?? "").trim()
    message = json?.error?.message ?? json?.message ?? json?.error ?? message
    if (typeof message !== "string") message = JSON.stringify(message)
  } catch {
    /* keep raw text */
  }
  return { code: maskSecrets(code, key).slice(0, 80), message: maskSecrets(message, key).slice(0, 300) }
}

/**
 * POST one generation request. Retries once on 429/5xx.
 *
 * @returns {Promise<{urls: string[]}>}
 */
export async function requestGeneration(options) {
  const {
    baseUrl,
    style,
    key,
    body,
    fetchImpl = fetch,
    signal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options
  const url = endpointFor(baseUrl, style)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener?.("abort", abort, { once: true })
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new ProviderError("запрос отменён", "aborted")
        if (error?.name === "AbortError") throw new ProviderError(`поставщик не ответил за ${formatDuration(timeoutMs)}`, "timeout")
        throw new ProviderError("не удалось связаться с поставщиком", "network")
      }
      if (response.ok) {
        let json
        try {
          json = await response.json()
        } catch {
          throw new ProviderError("поставщик вернул не-JSON ответ", "protocol")
        }
        return parseResponse(json)
      }
      const retryable = response.status === 429 || response.status >= 500
      if (retryable && attempt === 0 && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 800))
        continue
      }
      let text = ""
      try {
        text = await response.text()
      } catch {
        /* ignore */
      }
      const detail = errorTextFromBody(text, key)
      const suffix = `${detail.code ? ` ${detail.code}` : ""}${detail.message ? `: ${detail.message}` : ""}`
      throw new ProviderError(`поставщик ответил HTTP ${response.status}${suffix}`, "http", {
        httpStatus: response.status,
        providerCode: detail.code,
        providerMessage: detail.message,
      })
    }
    throw new ProviderError("поставщик не принял запрос", "http")
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", abort)
  }
}
