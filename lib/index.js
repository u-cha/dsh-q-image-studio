/**
 * Q Image Studio (dsh-q-image-studio) — Host half.
 *
 * Owns the plugin configuration (provider profiles, defaults), registers the
 * `image_generate` tool and the small Host HTTP surface the browser half reads.
 * Secrets never live here: the configuration stores only credential reference
 * names (`apiKeyRef`), resolved through `ctx.credentials` at call time.
 */

import { readFileSync } from "node:fs"

import { defineTool } from "./tool.js"
import { buildBody, randomSeed, requestGeneration, transparentPrompt } from "./generate.js"
import {
  STATIC_QWEN_MODELS,
  detectStyle,
  listIGModels,
  supportsReferenceEditing,
  verifyConnection,
} from "./providers.js"
import { KeyMissingError, clearKey, describeKey, keyRefFor, maskSecrets, providerLabel, resolveKey, saveKey } from "./secrets.js"
import {
  copyStoredImage,
  deleteStoredImage,
  effectiveSaveDir,
  listGallery,
  migrateLegacyGallery,
  openStoredImage,
  pickFolder,
  prepareSaveDirChange,
  readStoredImage,
  revealStoredImage,
  saveResults,
} from "./store.js"
import { describeReferences, resolveReferences } from "./references.js"

export const name = "dsh-q-image-studio"

/**
 * Hard dependencies. `webServer`/`connection` are optional/lazy: they are
 * injected inside `apply` so a headless Host can still load the plugin.
 */
export const inject = ["tools", "attachments", "credentials"]

/** Default DashScope-compatible endpoint used when a profile leaves baseURL empty. */
export const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
export const DEFAULT_MODEL = "qwen-image-3.0"
export const DEFAULT_KEY_REF = "DASHSCOPE_API_KEY"

export const SIZES = ["512x512", "1024x1024", "1328x1328", "1664x928", "928x1664", "1472x1140", "1140x1472", "auto"]

export const ROUTES = {
  keyStatus: "/plugins/dsh-q-image-studio/key-status",
  saveKey: "/plugins/dsh-q-image-studio/save-key",
  clearKey: "/plugins/dsh-q-image-studio/clear-key",
  testConnection: "/plugins/dsh-q-image-studio/test-connection",
  listModels: "/plugins/dsh-q-image-studio/list-models",
  generate: "/plugins/dsh-q-image-studio/generate",
  listGallery: "/plugins/dsh-q-image-studio/list-gallery",
  deleteImage: "/plugins/dsh-q-image-studio/delete-image",
  reveal: "/plugins/dsh-q-image-studio/reveal",
  open: "/plugins/dsh-q-image-studio/open",
  copy: "/plugins/dsh-q-image-studio/copy",
  pickFolder: "/plugins/dsh-q-image-studio/pick-folder",
  saveDir: "/plugins/dsh-q-image-studio/save-dir",
  image: "/plugins/dsh-q-image-studio/image",
  file: "/plugins/dsh-q-image-studio/file",
  icon: "/plugins/dsh-q-image-studio/icon",
}

/** Kept for the Task 1 route name. */
export const KEY_STATUS_ROUTE = ROUTES.keyStatus

import { Config, readConfig } from "./config.js"

const ICON_BYTES = readFileSync(new URL("../icon.png", import.meta.url))
const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version

/** Last working directory seen by a generation, used by the gallery routes. */
let lastCwd = ""

function rememberCwd(cwd) {
  if (typeof cwd === "string" && cwd.length > 0) lastCwd = cwd
}

export function getLastCwd() {
  return lastCwd
}

function normalizeProvider(provider) {
  const id = String(provider?.id ?? "").trim()
  return {
    id,
    label: String(provider?.label ?? "").trim() || id,
    baseURL: String(provider?.baseURL ?? "").trim() || DEFAULT_BASE_URL,
    model: String(provider?.model ?? "").trim() || DEFAULT_MODEL,
    apiKeyRef: String(provider?.apiKeyRef ?? "").trim() || keyRefFor(provider),
    models: Array.isArray(provider?.models) ? provider.models.filter((model) => typeof model === "string") : [],
    verifiedAt: String(provider?.verifiedAt ?? "").trim(),
    unavailableModels: Array.isArray(provider?.unavailableModels)
      ? provider.unavailableModels.filter((model) => typeof model === "string")
      : [],
  }
}

/** Resolve one provider profile, falling back to the active or first one. */
export function activeProvider(config) {
  const settings = readConfig(config)
  const providers = Array.isArray(settings.providers) ? settings.providers : []
  return (
    providers.find((provider) => provider.id === settings.activeProviderId) ??
    providers[0] ??
    undefined
  )
}

export function providerById(config, providerId) {
  const settings = readConfig(config)
  const providers = Array.isArray(settings.providers) ? settings.providers : []
  if (typeof providerId === "string" && providerId.length > 0) {
    return providers.find((provider) => provider.id === providerId)
  }
  return activeProvider(settings)
}

/** Fill the effective connection settings of a profile without ever resolving the key. */
export function describeProvider(provider) {
  if (provider === undefined) return undefined
  return normalizeProvider(provider)
}

/**
 * Host method `keyStatus`: describes every profile's credential for the UI.
 * Values are never read or returned — only presence/source/writability.
 */
export async function keyStatus(ctx, config) {
  const settings = readConfig(config)
  const profiles = Array.isArray(settings.providers) ? settings.providers : []
  const providers = []
  for (const profile of profiles) {
    const described = describeProvider(profile)
    let info = { configured: false, writable: false }
    try {
      const result = await describeKey(ctx, profile)
      info = {
        configured: result.configured === true,
        writable: result.writable === true,
      }
    } catch (error) {
      info = { configured: false, writable: false, error: errorMessage(error) }
    }
    providers.push({ ...described, ...info })
  }
  const active = activeProvider(settings)
  let saveDir = ""
  try {
    saveDir = effectiveSaveDir(settings.saveDir).dir
  } catch {
    saveDir = ""
  }
  return {
    ok: true,
    activeProviderId: settings.activeProviderId ?? "",
    activeProvider: active?.id ?? "",
    providers,
    defaultSize: settings.defaultSize,
    promptExtend: settings.promptExtend,
    watermark: settings.watermark,
    saveDir,
    cwd: lastCwd,
    sizes: SIZES,
    staticModels: STATIC_QWEN_MODELS,
    imageLimits: ctx.attachments?.imageLimits ?? {},
  }
}

/** Never leak anything but a message: provider/credential errors may echo headers. */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "unknown error"
}

function connectionFailed(error, key) {
  if (error instanceof KeyMissingError) return { code: "key-missing", message: error.message }
  return {
    code: typeof error?.code === "string" ? error.code : "network",
    message: maskErrorText(error, key),
  }
}

function maskErrorText(error, key) {
  const message = errorMessage(error)
  return key ? maskSecrets(message, key) : maskSecrets(message)
}

/** Attach objects for the tool output schema. */
const ATTACHMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    attachmentId: { type: "string", required: true },
    mediaType: { type: "string", required: true },
    bytes: { type: "integer", required: true },
    width: { type: "integer", required: true },
    height: { type: "integer", required: true },
    name: { type: "string" },
  },
}

export const IMAGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    error: { type: "string", description: "Причина, по которой картинка не получена" },
    attachment: ATTACHMENT_SCHEMA,
    attachments: { type: "array", items: ATTACHMENT_SCHEMA },
    files: { type: "array", items: { type: "string" }, description: "Сохранённые файлы" },
    provider: { type: "string" },
    model: { type: "string" },
    prompt: { type: "string" },
    size: { type: "string" },
    seed: { type: "number" },
    promptExtend: { type: "boolean" },
    transparent: { type: "boolean" },
    alphaChecked: { type: "boolean" },
    hasAlpha: { type: "boolean" },
    transparentPixels: { type: "boolean" },
  },
}

function describeGenerationFailure(error, key) {
  const message = maskErrorText(error, key)
  return { ok: false, error: message }
}

/**
 * Full generation pipeline shared by the tool and the UI route.
 *
 * @param {object} ctx
 * @param {object} config
 * @param {object} input
 * @returns {Promise<object>} tool-shaped result
 */
export async function runGeneration(ctx, config, input = {}) {
  const settings = readConfig(config)
  const profile = providerById(settings, input.providerId)
  if (profile === undefined) {
    throw new Error("профиль не настроен: добавьте профиль и ключ в настройках плагина")
  }
  const described = normalizeProvider(profile)
  let key
  try {
    key = await resolveKey(ctx, profile)
  } catch (error) {
    throw new Error(errorMessage(error))
  }
  let style
  try {
    const detected = await detectStyle(described.baseURL, key, fetch, { signal: input.signal })
    style = detected.style
  } catch (error) {
    const failure = connectionFailed(error, key)
    throw new Error(failure.message)
  }

  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : lastCwd || process.cwd()
  let images = []
  try {
    images = await resolveReferences(ctx, input.references, cwd)
  } catch (error) {
    throw new Error(maskErrorText(error, key))
  }
  if (images.length > 0 && !supportsReferenceEditing(style)) {
    throw new Error(
      `профиль ${providerLabel(profile)} не умеет редактирование по референсам, выберите профиль с поддержкой или укажите свои референсы в промпте`,
    )
  }

  const prompt = String(input.prompt ?? "").trim()
  if (prompt.length === 0) throw new Error("промпт не может быть пустым")
  const model = String(input.model ?? "").trim() || described.model
  const size = String(input.size ?? "").trim()
  const transparent = input.transparent === true
  const finalPrompt = transparent ? transparentPrompt(prompt) : prompt
  const promptExtend = transparent
    ? false
    : typeof input.promptExtend === "boolean"
      ? input.promptExtend
      : settings.promptExtend
  const hasSeed = input.seed !== undefined && input.seed !== null && input.seed !== ""
  if (hasSeed && !(Number.isInteger(input.seed) && input.seed >= 0 && input.seed <= 2147483647)) {
    throw new Error("seed должен быть целым числом 0…2147483647")
  }
  // Every image is reproducible: a random run still sends and stores its seed.
  const seed = hasSeed ? input.seed : randomSeed()
  const body = buildBody(
    {
      model,
      prompt: finalPrompt,
      n: 1,
      size,
      seed,
      images,
      promptExtend,
      watermark: settings.watermark,
    },
    style,
  )

  let urls
  try {
    ;({ urls } = await requestGeneration({
      baseUrl: described.baseURL,
      style,
      key,
      body,
      signal: input.signal,
    }))
  } catch (error) {
    throw new Error(maskErrorText(error, key))
  }

  const saved = await saveResults({
    cwd,
    saveDir: settings.saveDir,
    prompt,
    originalPrompt: prompt,
    finalPrompt,
    model,
    size,
    seed,
    promptExtend,
    transparent,
    requestBody: body,
    pluginVersion: PLUGIN_VERSION,
    urls,
    references: describeReferences(input.references),
  })
  rememberCwd(cwd)

  const attachments = []
  for (const blob of saved.blobs ?? []) {
    try {
      const ref = await ctx.attachments.saveImage({
        data: blob.data,
        mediaType: blob.mediaType,
        name: blob.name,
      })
      attachments.push(ref)
    } catch {
      /* a missing attachment should not lose the saved files */
    }
  }
  const result = {
    ok: true,
    files: saved.files,
    attachments,
    provider: described.label,
    model,
    prompt,
    size,
    promptExtend,
    transparent,
    alphaChecked: saved.blobs?.[0]?.alpha?.checked === true,
    hasAlpha: saved.blobs?.[0]?.alpha?.hasAlpha === true,
    transparentPixels: saved.blobs?.[0]?.alpha?.transparent === true,
  }
  result.seed = seed
  if (attachments.length > 0) result.attachment = attachments[0]
  return result
}

function toolResultForError(error, key) {
  return describeGenerationFailure(error, key)
}

/** Build the model-facing tool. */
export function imageGenerateTool(pluginCtx, pluginConfig) {
  return defineTool({
    name: "image_generate",
    description:
      "Сгенерировать или отредактировать изображение по промпту. Референсы передаются как attachmentId или путь внутри рабочей папки сессии. Картинки сохраняются в папку из настроек плагина (по умолчанию ~/Images/Q-Image-Studio).",
    parameters: {
      prompt: { type: "string", required: true, description: "Текст задания" },
      references: {
        type: "array",
        items: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "id картинки из вложения сессии" },
            path: { type: "string", description: "путь к файлу внутри рабочей папки сессии" },
          },
        },
        description: "Референсы: [{attachmentId}] или [{path}]",
      },
      model: { type: "string", description: "Модель (переопределяет профиль)" },
      size: { type: "string", description: "Размер WxH; не задан — авто" },
      seed: { type: "number", description: "Фиксированный сид 0…2147483647" },
      transparent: { type: "boolean", description: "Прозрачный фон (RGBA)" },
      promptExtend: { type: "boolean", description: "Улучшение промпта" },
    },
    output: {
      schema: IMAGE_OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.error !== undefined) return [{ type: "text", text: `image_generate: ${value.error}` }]
        const files = Array.isArray(value.files) ? value.files : []
        return [{ type: "text", text: `image_generate: ${files.length} файл(ов) в ${files[0] ?? "images/"}` }]
      },
      presentationMeta: (_args, value) => ({
        kind: "dsh-q-image-studio",
        status: value.error === undefined ? "ready" : "error",
      }),
    },
    presentResult: (_args, value) => {
      const attachments = Array.isArray(value.attachments) ? value.attachments : []
      if (value.error !== undefined || attachments.length === 0) return undefined
      return {
        card: "generic",
        title: `Q Image Studio: ${attachments.length}`,
        content: attachments.map((attachment) => ({ type: "image", attachment })),
      }
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? exec?.cwd
      try {
        return await runGeneration(pluginCtx, pluginConfig, {
          ...args,
          cwd,
          signal: exec?.signal,
        })
      } catch (error) {
        return toolResultForError(error)
      }
    },
  })
}

export async function generateFromUi(ctx, config, input = {}) {
  try {
    return await runGeneration(ctx, config, input)
  } catch (error) {
    return { ok: false, error: maskErrorText(error) }
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  })
  res.end(JSON.stringify(payload))
}

function jsonError(res, status, code) {
  json(res, status, { ok: false, error: code })
}

async function readBody(req, limit = 1_500_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error("тело запроса слишком большое")
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString("utf8")
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    throw new Error("тело запроса должно быть JSON")
  }
}

/** Wrap a route with Connection's trusted-host/origin/auth admission. */
export function withWebAdmission(route, admission) {
  return {
    ...route,
    handler: (req, res) => {
      const rejection = admission()?.(req)
      if (rejection === undefined) return route.handler(req, res)
      res.writeHead(rejection, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      })
      res.end(JSON.stringify({ error: rejection === 401 ? "unauthorized" : "forbidden" }))
    },
  }
}

function writeBinary(res, data, mediaType, name) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data)
  res.writeHead(200, {
    "content-type": mediaType || "application/octet-stream",
    "content-length": String(body.byteLength),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    ...(name ? { "content-disposition": `inline; filename="${name.replace(/"/g, "")}"` } : {}),
  })
  res.end(body)
}

/** POST routes: method + JSON body + errors as `{ok:false,error}`. */
function postRoute(getHandler, limit) {
  return async (req, res) => {
    if (req.method !== "POST") return jsonError(res, 405, "метод не поддерживается")
    let body
    try {
      body = await readBody(req, limit)
    } catch (error) {
      return jsonError(res, 400, errorMessage(error))
    }
    try {
      const result = await getHandler(body)
      json(res, result?.status ?? 200, result?.payload ?? result)
    } catch (error) {
      json(res, 200, { ok: false, error: maskSecrets(errorMessage(error)) })
    }
  }
}

/** Route handler around the native picker; injectable for tests. */
export function pickFolderRoute(pick = pickFolder) {
  return postRoute(async () => {
    const result = await pick()
    if (result.error) throw new Error(result.error)
    return result
  })
}

/**
 * Plugin entry.
 *
 * @param {object} ctx cordis plugin context
 * @param {object} [config] config validated by {@link Config}
 */
export function apply(ctx, config) {
  const settings = () => readConfig(config)

  // First run after the rename: move the legacy default directory if the new
  // one is still empty. Tests exercise the migration directly, so skip the
  // startup side effect under `node --test` (which would touch the real home).
  if (!process.env.NODE_TEST_CONTEXT) {
    migrateLegacyGallery({ saveDir: settings().saveDir }).catch((error) => {
      console.warn(`[dsh-q-image-studio] миграция каталога не выполнена: ${errorMessage(error)}`)
    })
  }

  // The tool resolves the config on every call, so live settings edits apply
  // without reloading the plugin.
  ctx.effect(() => ctx.tools.register(imageGenerateTool(ctx, config)), "dsh-q-image-studio: image_generate tool")

  let admission
  ctx.inject(["connection"], (connectionCtx) => {
    admission = (request) => connectionCtx.connection.requestRejection(request)
  })

  ctx.inject(["webServer"], (webCtx) => {
    const register = (path, handler, label) => {
      webCtx.effect(
        () =>
          webCtx.webServer.register(
            withWebAdmission({ kind: "exact", path, handler }, () => admission),
          ),
        `dsh-q-image-studio: ${label} route`,
      )
    }

    register(
      ROUTES.keyStatus,
      postRoute(async () => keyStatus(ctx, config)),
      "key-status",
    )

    register(
      ROUTES.saveKey,
      postRoute(async (body) => {
        const profile = providerById(config, body.providerId)
        if (profile === undefined) throw new Error("профиль не найден")
        const result = await saveKey(ctx, profile, body.value)
        return { ok: true, ref: result.ref, ...(await keyStatus(ctx, config)) }
      }),
      "save-key",
    )

    register(
      ROUTES.clearKey,
      postRoute(async (body) => {
        const profile = providerById(config, body.providerId)
        if (profile === undefined) throw new Error("профиль не найден")
        await clearKey(ctx, profile)
        return { ok: true, ...(await keyStatus(ctx, config)) }
      }),
      "clear-key",
    )

    register(
      ROUTES.testConnection,
      postRoute(async (body) => {
        const profile = providerById(config, body.providerId)
        if (profile === undefined) throw new Error("профиль не найден")
        const described = normalizeProvider(profile)
        let key
        try {
          key = await resolveKey(ctx, profile)
        } catch (error) {
          return { ok: false, code: "key-missing", message: errorMessage(error), models: described.models }
        }
        const hit = await verifyConnection(described.baseURL, key)
        return { ...hit, models: hit.models ?? described.models, message: maskSecrets(hit.message, key) }
      }),
      "test-connection",
    )

    register(
      ROUTES.listModels,
      postRoute(async (body) => {
        const profile = providerById(config, body.providerId)
        if (profile === undefined) throw new Error("профиль не найден")
        const described = normalizeProvider(profile)
        let key
        try {
          key = await resolveKey(ctx, profile)
        } catch (error) {
          return { ok: false, code: "key-missing", message: errorMessage(error), models: described.models, source: "saved" }
        }
        try {
          const models = await listIGModels(described.baseURL, key)
          return { ok: true, models, source: "provider" }
        } catch (error) {
          const failure = connectionFailed(error, key)
          return { ok: false, ...failure, models: described.models, source: "saved" }
        }
      }),
      "list-models",
    )

    register(
      ROUTES.generate,
      postRoute(async (body) => generateFromUi(ctx, config, {
        providerId: body.providerId,
        prompt: body.prompt,
        model: body.model,
        size: body.size,
        seed: body.seed,
        transparent: body.transparent,
        promptExtend: body.promptExtend,
        references: body.references,
        cwd: body.cwd,
      }), 26 * 1024 * 1024),
      "generate",
    )

    register(
      ROUTES.listGallery,
      postRoute(async (body) => {
        const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : lastCwd || process.cwd()
        const gallery = await listGallery({ cwd, saveDir: settings().saveDir })
        return { ...gallery, cwd }
      }),
      "list-gallery",
    )

    register(
      ROUTES.deleteImage,
      postRoute(async (body) => {
        const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : lastCwd || process.cwd()
        return deleteStoredImage({ cwd, saveDir: settings().saveDir, id: body.id })
      }),
      "delete-image",
    )

    register(ROUTES.pickFolder, pickFolderRoute(), "pick-folder")

    register(
      ROUTES.saveDir,
      postRoute(async (body) => {
        return prepareSaveDirChange({
          oldSaveDir: settings().saveDir,
          saveDir: body.saveDir,
          migrate: body.migrate === true,
        })
      }),
      "save-dir",
    )

    register(
      ROUTES.reveal,
      postRoute(async (body) => {
        const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : lastCwd || process.cwd()
        return revealStoredImage({ cwd, saveDir: settings().saveDir, id: body.id })
      }),
      "reveal",
    )

    register(
      ROUTES.open,
      postRoute(async (body) => {
        const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : lastCwd || process.cwd()
        return openStoredImage({ cwd, saveDir: settings().saveDir, id: body.id })
      }),
      "open",
    )

    register(
      ROUTES.copy,
      postRoute(async (body) => {
        const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : lastCwd || process.cwd()
        return copyStoredImage({ cwd, saveDir: settings().saveDir, id: body.id })
      }),
      "copy",
    )

    // Binary routes need their own writer, not the JSON envelope above.
    const imageHandler = async (req, res) => {
      if (req.method !== "POST") return jsonError(res, 405, "метод не поддерживается")
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return jsonError(res, 400, errorMessage(error))
      }
      try {
        const attachment = body.attachment
        if (!attachment || typeof attachment.attachmentId !== "string") throw new Error("не передан attachment")
        const hit = await ctx.attachments.readImage(attachment)
        writeBinary(res, hit.data, hit.ref?.mediaType ?? attachment.mediaType, attachment.name)
      } catch (error) {
        jsonError(res, 404, maskSecrets(errorMessage(error)))
      }
    }
    // Replace the JSON-envelope registration for /image: re-register with the binary handler.
    webCtx.effect(
      () => webCtx.webServer.register(withWebAdmission({ kind: "exact", path: ROUTES.image, handler: imageHandler }, () => admission)),
      "dsh-q-image-studio: image bytes route",
    )

    const fileHandler = async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") return jsonError(res, 405, "метод не поддерживается")
      try {
        const url = new URL(req.url ?? "/", "http://localhost")
        const cwd = url.searchParams.get("cwd") || lastCwd || process.cwd()
        const id = url.searchParams.get("id") || ""
        const hit = await readStoredImage({ cwd, saveDir: settings().saveDir, id })
        writeBinary(res, hit.data, hit.mediaType, hit.name)
      } catch (error) {
        jsonError(res, 404, maskSecrets(errorMessage(error)))
      }
    }
    webCtx.effect(
      () => webCtx.webServer.register(withWebAdmission({ kind: "exact", path: ROUTES.file, handler: fileHandler }, () => admission)),
      "dsh-q-image-studio: gallery file route",
    )

    const iconHandler = (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") return jsonError(res, 405, "метод не поддерживается")
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(ICON_BYTES.byteLength),
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      })
      res.end(req.method === "HEAD" ? undefined : ICON_BYTES)
    }
    webCtx.effect(
      () => webCtx.webServer.register(withWebAdmission({ kind: "exact", path: ROUTES.icon, handler: iconHandler }, () => admission)),
      "dsh-q-image-studio: plugin icon route",
    )
  })
}

export { Config, readConfig, unwrap, unwrapConfig, volatile } from "./config.js"
