/**
 * Turn tool/UI references into data URLs the provider accepts.
 *
 * Allowed forms: `{ attachmentId }` (DSH attachment store), `{ path }`
 * (file inside the session working directory) and `{ data }` (an
 * `data:image/...;base64,...` URL uploaded by the studio panel). URLs are
 * rejected because the provider would have to fetch them and we cannot
 * verify their content.
 */

import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

export const MAX_REFERENCES = 10
const MAX_REFERENCE_BYTES = 25 * 1024 * 1024
const MEDIA_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

function refError(message) {
  return new ReferenceError(message)
}

function byteLength(data) {
  if (data instanceof Uint8Array) return data.byteLength
  if (typeof data === "string") return Buffer.byteLength(data, "utf8")
  return 0
}

/**
 * @param {object} ctx plugin context with `attachments`
 * @param {{attachmentId?: string, path?: string, url?: string}[]} refs
 * @param {string} cwd
 * @returns {Promise<string[]>} `data:image/...;base64,...` strings
 */
export async function resolveReferences(ctx, refs, cwd) {
  if (refs === undefined || refs === null) return []
  if (!Array.isArray(refs)) throw refError("референсы должны быть массивом")
  if (refs.length === 0) return []
  if (refs.length > MAX_REFERENCES) {
    throw refError(`не больше ${MAX_REFERENCES} референсов за один запрос`)
  }

  const limits = ctx?.attachments?.imageLimits ?? {}
  const maxBytes = Number(limits.maxImageBytes) > 0 ? Number(limits.maxImageBytes) : MAX_REFERENCE_BYTES
  const maxDimension = Number(limits.maxImageDimension) > 0 ? Number(limits.maxImageDimension) : 0
  const base = path.resolve(cwd || process.cwd())
  const baseReal = await realpath(base).catch(() => base)

  const urls = []
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") throw refError("референс должен содержать attachmentId или path")
    if (typeof ref.url === "string") {
      throw refError("ссылки на картинки по URL не поддерживаются: приложите файл или укажите путь в рабочей папке")
    }
    if (typeof ref.data === "string" && ref.data.startsWith("data:")) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(ref.data)
      if (match === null) throw refError("формат референса не поддерживается")
      const bytes = Buffer.from(match[2], "base64")
      if (bytes.byteLength === 0) throw refError("референс пустой")
      if (bytes.byteLength > maxBytes) throw refError(`референс больше ${Math.round(maxBytes / 1024 / 1024)} МБ`)
      urls.push(`data:${match[1]};base64,${bytes.toString("base64")}`)
      continue
    }
    if (typeof ref.attachmentId === "string" && ref.attachmentId.length > 0) {
      if (typeof ctx?.attachments?.readImage !== "function") {
        throw refError("вложения недоступны в этом контексте")
      }
      let hit
      try {
        hit = await ctx.attachments.readImage({ attachmentId: ref.attachmentId })
      } catch (error) {
        throw refError(`не удалось прочитать вложение: ${error?.message ?? "ошибка хранилища"}`)
      }
      const mediaType = String(hit?.ref?.mediaType ?? "image/png")
      if (!MEDIA_BY_EXT[`.${mediaType.split("/")[1]}`]) throw refError(`формат ${mediaType} не поддерживается`)
      const data = hit?.data
      const bytes = byteLength(data)
      if (bytes === 0) throw refError("вложение пустое")
      if (bytes > maxBytes) throw refError(`референс больше ${Math.round(maxBytes / 1024 / 1024)} МБ`)
      urls.push(`data:${mediaType};base64,${Buffer.from(data).toString("base64")}`)
      continue
    }
    if (typeof ref.path === "string" && ref.path.trim().length > 0) {
      const raw = ref.path.trim()
      const resolved = path.resolve(base, raw)
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        throw refError(`путь вне рабочей папки: ${raw}`)
      }
      const ext = path.extname(raw).toLowerCase()
      if (!MEDIA_BY_EXT[ext]) throw refError(`формат файла ${ext || "(без расширения)"} не поддерживается`)
      let real
      try {
        real = await realpath(resolved)
      } catch {
        throw refError(`файл не найден: ${raw}`)
      }
      if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
        throw refError(`путь вне рабочей папки: ${raw}`)
      }
      const info = await stat(real)
      if (!info.isFile()) throw refError(`это не файл: ${raw}`)
      if (info.size > maxBytes) throw refError(`референс больше ${Math.round(maxBytes / 1024 / 1024)} МБ`)
      if (maxDimension > 0) {
        // Dimensions are checked by the provider; only flag absurd byte counts here.
      }
      const data = await readFile(real)
      urls.push(`data:${MEDIA_BY_EXT[ext]};base64,${data.toString("base64")}`)
      continue
    }
    throw refError("референс должен содержать attachmentId или path")
  }
  return urls
}

/** Short, log-safe description of references for the gallery index. */
export function describeReferences(refs) {
  if (!Array.isArray(refs)) return []
  return refs
    .map((ref) => {
      if (typeof ref?.attachmentId === "string") return `attachment:${ref.attachmentId}`
      if (typeof ref?.data === "string") return `data:${ref.data.slice(5, ref.data.indexOf(";"))}`
      if (typeof ref?.path === "string") return `path:${ref.path}`
      return undefined
    })
    .filter(Boolean)
    .slice(0, MAX_REFERENCES)
}
