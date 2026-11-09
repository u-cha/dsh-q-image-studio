/**
 * Plugin configuration schema and Volatile helpers.
 *
 * DSH 0.1.7+ serves a plugin's settings form only for fields marked
 * `.volatile()`, and hands `apply` a `Volatile<T>` box per marked field
 * (`{ get(): T }`). `volatile` stays defensive so the same code also loads on
 * older hosts whose schemastery has no such method.
 */

import z from "./vendor/schemastery.mjs"

/** Mark one schema field live; a no-op when the schema has no `.volatile()`. */
export function volatile(schema) {
  const mark = schema?.volatile
  return typeof mark === "function" ? mark.call(schema) : schema
}

/** Read one config value, transparently unwrapping a Volatile box. */
export function unwrap(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value
}

/** Unwrap every top-level field of a config object (Volatile boxes or plain values). */
export function unwrapConfig(source) {
  if (source === null || typeof source !== "object") return {}
  const out = {}
  for (const [key, value] of Object.entries(source)) out[key] = unwrap(value)
  return out
}

/** One provider profile. Only the credential *reference* is stored. */
export const ProviderConfig = z.object({
  id: z.string().description("Стабильный идентификатор профиля"),
  label: z.string().default("").description("Подпись в интерфейсе"),
  baseURL: z.string().default("").description("Базовый URL; пусто = DashScope по умолчанию"),
  model: z.string().default("").description("Модель; пусто = qwen-image-3.0"),
  apiKeyRef: z.string().default("").description("Имя credential-ссылки в волте DSH (не ключ!)"),
  models: z.array(z.string()).default([]).description("Модели, полученные при успешной проверке"),
  verifiedAt: z.string().default("").description("Когда подключение последний раз проверялось"),
  unavailableModels: z.array(z.string()).default([]).description("Модели, вызов которых уже отклонён этим ключом"),
})

export const Config = z.object({
  providers: volatile(z.array(ProviderConfig).default([]).description("Профили подключения")),
  activeProviderId: volatile(z.string().default("").description("Выбранный профиль")),
  defaultSize: volatile(z.string().default("1024x1024").description("Размер по умолчанию, WxH")),
  promptExtend: volatile(z.boolean().default(true).description("Расширять промпт на стороне провайдера")),
  watermark: volatile(z.boolean().default(false).description("Водяной знак провайдера")),
  saveDir: volatile(z.string().default("~/Images/Q-Image-Studio").description("Папка сохранения: только абсолютный путь")),
  language: volatile(z.union([z.const("en"), z.const("ru")]).default("en").description("Язык интерфейса плагина")),
  animations: volatile(z.boolean().default(true).description("Пульсирующая обводка во время генерации")),
})

/**
 * Plain, freshly unwrapped view of the config. Call it at use time rather than
 * caching the result so live settings edits are visible without a restart.
 */
export function readConfig(config) {
  if (config === undefined || config === null) return unwrapConfig(Config({}))
  return unwrapConfig(config)
}
