/**
 * Local gallery storage: one absolute directory holding
 * `YYYYMMDD-HHMMSS-<slug>.png` files plus an atomically rewritten
 * `index.json`. All paths from the UI are re-validated against the gallery
 * directory before they are served.
 */

import { spawn } from "node:child_process"
import { access, constants, link, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inflateSync } from "node:zlib"

import { formatDuration, slugify } from "./generate.js"

export const DEFAULT_SAVE_DIR = "~/Images/Q-Image-Studio"
export const LEGACY_SAVE_DIR = "~/Images/DSH-Image-Studio"
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 90_000
const EXT_BY_MEDIA = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
}
const MEDIA_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

const ABSOLUTE_SAVE_DIR_ERROR = "укажите абсолютный путь к папке сохранения"
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Inspect an 8-bit PNG for an alpha channel and pixels below 16. `hasAlpha`
 * distinguishes "no alpha channel at all" (RGB) from "alpha but fully opaque".
 * Palette transparency via tRNS is treated as transparent; unsupported formats
 * report checked=false.
 */
export function pngAlphaInfo(data) {
  const bytes = Buffer.from(data ?? [])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { checked: false, hasAlpha: false, transparent: false }
  }
  let offset = 8
  let header
  let trns = false
  const idat = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") header = body
    else if (type === "tRNS") trns = true
    else if (type === "IDAT") idat.push(body)
    else if (type === "IEND") break
    offset += 12 + length
  }
  if (trns) return { checked: true, hasAlpha: true, transparent: true }
  if (!header || header.length < 13) return { checked: false, hasAlpha: false, transparent: false }
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const depth = header[8]
  const colorType = header[9]
  if (depth !== 8) return { checked: false, hasAlpha: false, transparent: false }
  if (colorType === 0 || colorType === 2 || colorType === 3) {
    // Grayscale/RGB/palette without tRNS cannot carry transparency.
    return { checked: true, hasAlpha: false, transparent: false }
  }
  if (colorType !== 4 && colorType !== 6) return { checked: false, hasAlpha: false, transparent: false }
  if (idat.length === 0) return { checked: false, hasAlpha: false, transparent: false }
  const channels = colorType === 6 ? 4 : 2
  const stride = width * channels
  let raw
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return { checked: false, hasAlpha: true, transparent: false }
  }
  if (raw.length < height * (stride + 1)) return { checked: false, hasAlpha: true, transparent: false }
  const pixels = Buffer.alloc(height * stride)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      let value = row[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += Math.floor((left + up) / 2)
      else if (filter === 4) value += paeth(left, up, upLeft)
      out[x] = value & 0xff
    }
  }
  for (let index = channels - 1; index < pixels.length; index += channels) {
    if (pixels[index] < 16) return { checked: true, hasAlpha: true, transparent: true }
  }
  return { checked: true, hasAlpha: true, transparent: false }
}

/** Expand `~` and require an absolute path. */
export function resolveSaveDir(saveDir, { homeDir = os.homedir() } = {}) {
  const raw = saveDir === undefined || saveDir === null ? DEFAULT_SAVE_DIR : String(saveDir).trim()
  if (raw.length === 0) throw new Error(ABSOLUTE_SAVE_DIR_ERROR)
  let expanded = raw
  if (raw === "~") expanded = homeDir
  else if (raw.startsWith("~/") || raw.startsWith("~\\")) expanded = path.join(homeDir, raw.slice(2))
  if (!path.isAbsolute(expanded)) throw new Error(ABSOLUTE_SAVE_DIR_ERROR)
  return { dir: path.resolve(expanded), relative: false }
}

/**
 * Effective save directory for reads and writes. Legacy relative values in the
 * volatile config (`images`, `./photos`) migrate to the new default instead of
 * breaking an installed plugin; the client rewrites the config on first open.
 */
export function effectiveSaveDir(saveDir, { homeDir = os.homedir() } = {}) {
  const raw = saveDir === undefined || saveDir === null ? "" : String(saveDir).trim()
  if (raw.length === 0) return resolveSaveDir(DEFAULT_SAVE_DIR, { homeDir })
  let expanded = raw
  if (raw === "~") expanded = homeDir
  else if (raw.startsWith("~/") || raw.startsWith("~\\")) expanded = path.join(homeDir, raw.slice(2))
  if (!path.isAbsolute(expanded)) return resolveSaveDir(DEFAULT_SAVE_DIR, { homeDir })
  return resolveSaveDir(raw, { homeDir })
}

async function nonEmptyDir(dir) {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return { exists: true, notDir: true, entries: [] }
    const entries = (await readdir(dir)).filter((name) => name !== ".DS_Store")
    return { exists: true, notDir: false, entries }
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, notDir: false, entries: [] }
    throw error
  }
}

/**
 * Move every regular file and `index.json` from one gallery directory to an
 * empty one. Absolute `file` fields in the index are rewritten to the target.
 * Refuses to overwrite anything: on a name clash both directories stay as-is.
 */
export async function moveGalleryFiles({ fromDir, toDir } = {}) {
  const source = path.resolve(String(fromDir ?? ""))
  const target = path.resolve(String(toDir ?? ""))
  if (source === target) return { ok: true, moved: 0, target }
  const listing = await nonEmptyDir(source)
  if (!listing.exists) return { ok: true, moved: 0, target }
  if (listing.notDir) throw new Error("источник не является папкой")
  const names = listing.entries.filter((name) => name !== "index.json" && name !== ".DS_Store")
  const targetInfo = await nonEmptyDir(target)
  if (targetInfo.notDir) throw new Error("целевой путь не является папкой")
  const targetNames = new Set(targetInfo.entries)
  for (const name of names) {
    if (targetNames.has(name)) throw new Error(`конфликт файлов: ${name}`)
  }
  await mkdir(target, { recursive: true })
  let moved = 0
  for (const name of names) {
    const sourceFile = path.join(source, name)
    const info = await stat(sourceFile)
    if (!info.isFile()) continue
    await rename(sourceFile, path.join(target, name))
    moved += 1
  }
  const sourceIndex = path.join(source, "index.json")
  try {
    const raw = await readFile(sourceIndex, "utf8")
    const parsed = JSON.parse(raw)
    const rows = Array.isArray(parsed)
      ? parsed.map((entry) => {
          if (!entry || typeof entry.file !== "string") return entry
          return { ...entry, file: path.join(target, path.basename(entry.file)) }
        })
      : []
    await writeIndex(target, rows)
    await unlink(sourceIndex).catch(() => {})
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // A corrupt index is preserved as index.json.bak by readIndex semantics;
      // images have already moved, so leave the source index in place too.
      if (error instanceof SyntaxError) {
        await rename(sourceIndex, `${sourceIndex}.bak`).catch(() => {})
      } else {
        throw error
      }
    }
  }
  return { ok: true, moved, target }
}

/**
 * First-run migration from the old product directory. Only runs when the
 * effective save directory is the new default; a non-empty target or a file
 * clash is reported and nothing is overwritten.
 */
export async function migrateLegacyGallery({
  saveDir = DEFAULT_SAVE_DIR,
  homeDir = os.homedir(),
  log = console.warn,
} = {}) {
  let target
  try {
    target = effectiveSaveDir(saveDir, { homeDir }).dir
  } catch {
    return { migrated: false, reason: "invalid-target" }
  }
  const defaultDir = resolveSaveDir(DEFAULT_SAVE_DIR, { homeDir }).dir
  if (target !== defaultDir) return { migrated: false, reason: "custom-target" }
  const source = resolveSaveDir(LEGACY_SAVE_DIR, { homeDir }).dir
  const sourceInfo = await nonEmptyDir(source)
  if (!sourceInfo.exists) return { migrated: false, reason: "no-legacy" }
  if (sourceInfo.notDir) return { migrated: false, reason: "legacy-not-dir" }
  const targetInfo = await nonEmptyDir(target)
  if (targetInfo.notDir || targetInfo.entries.length > 0) {
    log(`[dsh-q-image-studio] миграция из ${source} пропущена: ${target} не пуста`)
    return { migrated: false, reason: "target-not-empty" }
  }
  try {
    const result = await moveGalleryFiles({ fromDir: source, toDir: target })
    if (result.moved > 0) log(`[dsh-q-image-studio] перенесено ${result.moved} картинок из ${source} в ${target}`)
    return { migrated: result.moved > 0, moved: result.moved, target }
  } catch (error) {
    log(`[dsh-q-image-studio] миграция из ${source} не выполнена: ${errorMessageForLog(error)}`)
    return { migrated: false, reason: "move-failed", error: errorMessageForLog(error) }
  }
}

function errorMessageForLog(error) {
  return error instanceof Error ? error.message : String(error ?? "неизвестная ошибка")
}

/**
 * Validate a directory change before the client writes the config. The caller
 * must retry with `migrate: true` after the user confirms the move; on any
 * rejection the config and both directories stay untouched.
 */
export async function prepareSaveDirChange({
  oldSaveDir = DEFAULT_SAVE_DIR,
  saveDir,
  migrate = false,
  homeDir = os.homedir(),
} = {}) {
  const oldDir = effectiveSaveDir(oldSaveDir, { homeDir }).dir
  const target = resolveSaveDir(saveDir, { homeDir }).dir
  if (oldDir === target) return { ok: true, saveDir: target, count: 0, migrated: 0 }
  const targetInfo = await nonEmptyDir(target)
  if (targetInfo.notDir) throw new Error("целевой путь не является папкой")
  if (targetInfo.entries.length > 0) throw new Error("папка не пуста, выберите другую")
  const count = (await listStoredImages({ cwd: "", saveDir: oldDir })).length
  if (count > 0 && migrate !== true) {
    return { ok: false, code: "confirm-migration", count, saveDir: target, oldSaveDir: oldDir }
  }
  await mkdir(target, { recursive: true })
  if (count > 0) await moveGalleryFiles({ fromDir: oldDir, toDir: target })
  return { ok: true, saveDir: target, count, migrated: count }
}

/** Resolve and create the gallery directory (absolute path only). */
export async function ensureGalleryDir({ saveDir } = {}) {
  const resolved = effectiveSaveDir(saveDir)
  await mkdir(resolved.dir, { recursive: true })
  return resolved.dir
}

/** Synchronous directory path (without creating it). */
export function galleryDir(_cwd, saveDir) {
  return effectiveSaveDir(saveDir).dir
}

export function formatStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function mediaTypeFor(contentType, url) {
  const header = String(contentType ?? "").split(";")[0].trim().toLowerCase()
  if (EXT_BY_MEDIA[header]) return header
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase()
    if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif") {
      return MEDIA_BY_EXT[ext]
    }
  } catch {
    /* not a URL */
  }
  return "image/png"
}

/** Download one provider URL with hard size and time limits. */
export async function downloadImage(url, { fetchImpl = fetch, signal, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener?.("abort", abort, { once: true })
  try {
    if (/^data:image\//.test(url)) {
      const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
      if (!match) throw new Error("повреждённая data-ссылка на картинку")
      const data = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "binary")
      if (data.byteLength > maxBytes) throw new Error(`картинка больше ${Math.round(maxBytes / 1024 / 1024)} МБ`)
      return { data, mediaType: EXT_BY_MEDIA[match[1]] ? match[1] : "image/png" }
    }
    let response
    try {
      response = await fetchImpl(url, { method: "GET", signal: controller.signal })
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`скачивание картинки заняло больше ${formatDuration(DOWNLOAD_TIMEOUT_MS)}`)
      throw new Error("не удалось скачать картинку по ссылке поставщика")
    }
    if (!response.ok) throw new Error(`поставщик отдал картинку с HTTP ${response.status}`)
    const declared = Number(response.headers?.get?.("content-length") ?? 0)
    if (declared > maxBytes) throw new Error(`картинка больше ${Math.round(maxBytes / 1024 / 1024)} МБ`)
    const data = Buffer.from(await response.arrayBuffer())
    if (data.byteLength > maxBytes) throw new Error(`картинка больше ${Math.round(maxBytes / 1024 / 1024)} МБ`)
    return { data, mediaType: mediaTypeFor(response.headers?.get?.("content-type"), url) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", abort)
  }
}

const indexLocks = new Map()

/** Serialize index.json read-modify-write cycles per directory. */
function withIndexLock(dir, work) {
  const previous = indexLocks.get(dir) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(work)
  const tail = run.catch(() => {})
  indexLocks.set(dir, tail)
  run.finally(() => {
    if (indexLocks.get(dir) === tail) indexLocks.delete(dir)
  })
  return run
}

async function readIndex(dir) {
  const file = path.join(dir, "index.json")
  try {
    const raw = await readFile(file, "utf8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    if (error?.code === "ENOENT") return []
    if (error instanceof SyntaxError) {
      await rename(file, `${file}.bak`).catch(() => {})
      return []
    }
    throw error
  }
}

async function writeIndex(dir, entries) {
  const file = path.join(dir, "index.json")
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8")
  await rename(tmp, file)
}

/**
 * Normalize absolute `file` paths in an index row: after a manual directory
 * move (or an older DSH-Image-Studio layout) rows may still point at the old
 * place. The basename inside the current gallery directory is authoritative.
 */
export function normalizeIndexEntries(dir, entries) {
  const base = path.resolve(String(dir ?? ""))
  let changed = false
  const rows = (Array.isArray(entries) ? entries : []).map((entry) => {
    if (!entry || typeof entry.file !== "string" || entry.file.length === 0) return entry
    const absolute = path.isAbsolute(entry.file) ? path.resolve(entry.file) : path.resolve(base, entry.file)
    if (path.dirname(absolute) === base) return entry
    changed = true
    return { ...entry, file: path.join(base, path.basename(absolute)) }
  })
  return { entries: rows, changed }
}

/**
 * Write image bytes under a name reserved atomically with `link(2)`: the temp
 * file is complete before the final name appears, and a concurrent writer that
 * wins the name makes us retry with the next suffix. Callers hold the directory
 * index lock, so the reservation and index append stay one ordered step.
 */
async function writeUniqueImage(dir, stem, ext, data) {
  for (let counter = 1; ; counter += 1) {
    const candidate = counter === 1 ? stem : `${stem}-${counter}`
    const target = path.join(dir, `${candidate}${ext}`)
    const tmp = path.join(dir, `.${candidate}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
    try {
      await writeFile(tmp, data, { flag: "wx" })
    } catch (error) {
      if (error?.code === "EEXIST") continue
      throw error
    }
    try {
      await link(tmp, target)
      await unlink(tmp).catch(() => {})
      return { stem: candidate, target }
    } catch (error) {
      await unlink(tmp).catch(() => {})
      if (error?.code === "EEXIST") continue
      throw error
    }
  }
}

/**
 * Save downloaded URLs next to `cwd`.
 *
 * @returns {Promise<{files: string[], entries: object[]}>} absolute paths plus index rows
 */
export async function saveResults({
  cwd,
  saveDir = DEFAULT_SAVE_DIR,
  prompt,
  originalPrompt,
  finalPrompt,
  model,
  size,
  seed,
  promptExtend,
  transparent = false,
  requestBody,
  pluginVersion = "",
  urls,
  references = [],
  fetchImpl = fetch,
  signal,
  createdAt = new Date(),
}) {
  const dir = await ensureGalleryDir({ cwd, saveDir })
  const stamp = formatStamp(createdAt)
  const slug = slugify(prompt)
  const files = []
  const entries = []
  const blobs = []
  for (let index = 0; index < urls.length; index += 1) {
    const { data, mediaType } = await downloadImage(urls[index], { fetchImpl, signal })
    const ext = EXT_BY_MEDIA[mediaType] ?? ".png"
    const stemPrefix = `${stamp}-${slug}${index === 0 ? "" : `-${index + 1}`}`
    const alpha = pngAlphaInfo(data)
    // Reservation + index append under one lock: Vibe launches several
    // concurrent saveResults calls with the same prompt and timestamp.
    const saved = await withIndexLock(dir, async () => {
      const { stem, target } = await writeUniqueImage(dir, stemPrefix, ext, data)
      const entry = {
        id: stem,
        file: target,
        prompt: String(originalPrompt ?? prompt ?? ""),
        finalPrompt: String(finalPrompt ?? prompt ?? ""),
        model: String(model ?? ""),
        size: String(size ?? ""),
        seed: Number.isInteger(seed) ? seed : undefined,
        promptExtend: typeof promptExtend === "boolean" ? promptExtend : undefined,
        transparent: Boolean(transparent),
        alphaChecked: alpha.checked,
        hasAlpha: alpha.hasAlpha === true,
        transparentPixels: alpha.transparent,
        requestJson: requestBody ?? null,
        pluginVersion: String(pluginVersion ?? ""),
        createdAt: createdAt.toISOString(),
        references: Array.isArray(references) ? references.map((ref) => String(ref)).slice(0, 10) : [],
      }
      const index = await readIndex(dir)
      const normalized = normalizeIndexEntries(dir, index)
      normalized.entries.push(entry)
      await writeIndex(dir, normalized.entries)
      return { stem, target, name: `${stem}${ext}`, entry }
    })
    files.push(saved.target)
    blobs.push({ data, mediaType, name: saved.name, alpha })
    entries.push(saved.entry)
  }
  return { files, entries, blobs }
}

/** Gallery rows, tolerant of a missing/corrupt index (directory scan wins). */
export async function listStoredImages({ cwd, saveDir = DEFAULT_SAVE_DIR } = {}) {
  const dir = galleryDir(cwd, saveDir)
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
  let index = []
  await withIndexLock(dir, async () => {
    const raw = await readIndex(dir)
    const normalized = normalizeIndexEntries(dir, raw)
    if (normalized.changed) await writeIndex(dir, normalized.entries)
    index = normalized.entries
  })
  const byFile = new Map()
  for (const entry of index) {
    if (!entry || typeof entry.file !== "string") continue
    byFile.set(entry.file, entry)
    byFile.set(path.basename(entry.file), entry)
    if (entry.id) byFile.set(`id:${entry.id}`, entry)
  }
  const rows = []
  for (const name of names) {
    const ext = path.extname(name).toLowerCase()
    if (!MEDIA_BY_EXT[ext]) continue
    const file = path.join(dir, name)
    const entry = byFile.get(file) ?? byFile.get(name) ?? byFile.get(`id:${path.basename(name, ext)}`)
    rows.push({
      id: entry?.id ?? path.basename(name, ext),
      file,
      prompt: entry?.prompt ?? "",
      finalPrompt: entry?.finalPrompt ?? entry?.prompt ?? "",
      model: entry?.model ?? "",
      size: entry?.size ?? "",
      seed: entry?.seed,
      promptExtend: entry?.promptExtend,
      transparent: entry?.transparent === true,
      alphaChecked: entry?.alphaChecked === true,
      hasAlpha: entry?.hasAlpha === true,
      transparentPixels: entry?.transparentPixels === true,
      requestJson: entry?.requestJson ?? null,
      pluginVersion: entry?.pluginVersion ?? "",
      createdAt: entry?.createdAt ?? null,
      references: entry?.references ?? [],
    })
  }
  rows.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || b.file.localeCompare(a.file))
  return rows
}

/** Shape sent to the client gallery grid. */
export function formatGalleryEntry(entry) {
  return {
    id: entry.id,
    file: entry.file,
    thumb: entry.file,
    label: entry.prompt || entry.id,
    prompt: entry.prompt ?? "",
    finalPrompt: entry.finalPrompt ?? entry.prompt ?? "",
    model: entry.model ?? "",
    size: entry.size ?? "",
    seed: entry.seed,
    promptExtend: entry.promptExtend,
    transparent: entry.transparent === true,
    alphaChecked: entry.alphaChecked === true,
    hasAlpha: entry.hasAlpha === true,
    transparentPixels: entry.transparentPixels === true,
    requestJson: entry.requestJson ?? null,
    pluginVersion: entry.pluginVersion ?? "",
    createdAt: entry.createdAt ?? null,
    references: entry.references ?? [],
  }
}

export async function listGallery({ cwd, saveDir = DEFAULT_SAVE_DIR } = {}) {
  const entries = await listStoredImages({ cwd, saveDir })
  return { ok: true, cwd, saveDir: galleryDir(cwd, saveDir), entries: entries.map((entry) => formatGalleryEntry(entry)) }
}

async function resolveInside(dir, file) {
  const dirReal = await realpath(dir)
  const target = path.resolve(dir, file)
  const targetReal = await realpath(target)
  if (targetReal !== dirReal && !targetReal.startsWith(dirReal + path.sep)) {
    throw new Error("файл вне папки картинок")
  }
  return targetReal
}

/** Remove one gallery image by id (or file name) and update the index. */
export async function deleteStoredImage({ cwd, saveDir = DEFAULT_SAVE_DIR, id } = {}) {
  const dir = galleryDir(cwd, saveDir)
  const rows = await listStoredImages({ cwd, saveDir })
  let row = rows.find((entry) => entry.id === id || entry.file === id || path.basename(entry.file) === id)
  if (!row) {
    const index = await readIndex(dir)
    row = normalizeIndexEntries(dir, index).entries.find(
      (entry) => entry.id === id || entry.file === id || path.basename(entry.file) === id,
    )
  }
  if (!row) throw new Error("картинка не найдена")
  const name = path.basename(row.file)
  let target = null
  try {
    target = await resolveInside(dir, name)
  } catch {
    target = path.join(dir, name)
  }
  try {
    await unlink(target)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await withIndexLock(dir, async () => {
    const index = await readIndex(dir)
    const normalized = normalizeIndexEntries(dir, index)
    await writeIndex(
      dir,
      normalized.entries.filter(
        (entry) => entry.file !== row.file && path.basename(String(entry.file ?? "")) !== name && entry.id !== row.id,
      ),
    )
  })
  return { ok: true, id: row.id }
}

/**
 * Reveal an already-resolved file in the OS file manager. Only paths whose
 * realpath stays inside the configured gallery directory are accepted, so the
 * client cannot open arbitrary locations; on macOS this is `open -R <file>`.
 */
export async function revealFile({ root: rootDir, absolute, spawnImpl = spawn, platform = process.platform } = {}) {
  const root = String(rootDir ?? process.cwd())
  const rootReal = await realpath(root)
  let targetReal
  try {
    targetReal = await realpath(path.resolve(String(absolute ?? "")))
  } catch {
    throw new Error("файл не найден")
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new Error("файл вне папки картинок")
  }
  const info = await stat(targetReal)
  if (!info.isFile()) throw new Error("файл не найден")
  if (platform !== "darwin") throw new Error("показ в Finder доступен только на macOS")
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    let child
    try {
      child = spawnImpl("open", ["-R", targetReal], { stdio: "ignore" })
    } catch {
      finish(new Error("не удалось открыть Finder"))
      return
    }
    child.once?.("error", () => finish(new Error("не удалось открыть Finder")))
    child.once?.("exit", (code) => finish(code === 0 ? undefined : new Error("не удалось открыть Finder")))
  })
  return { ok: true, path: targetReal }
}

/** Resolve a gallery path and prove it is an existing file inside `rootDir`. */
async function resolveGalleryFile(rootDir, absolute) {
  const rootReal = await realpath(String(rootDir ?? ""))
  let targetReal
  try {
    targetReal = await realpath(path.resolve(String(absolute ?? "")))
  } catch {
    throw new Error("файл не найден")
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new Error("файл вне папки картинок")
  }
  const info = await stat(targetReal)
  if (!info.isFile()) throw new Error("файл не найден")
  return targetReal
}

function runGuiCommand(spawnImpl, command, args, failureText) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    let child
    try {
      child = spawnImpl(command, args, { stdio: "ignore" })
    } catch {
      finish(new Error(failureText))
      return
    }
    child.once?.("error", () => finish(new Error(failureText)))
    child.once?.("exit", (code) => finish(code === 0 ? undefined : new Error(failureText)))
  })
}

/** Open one image in the OS viewer (macOS `open`). */
export async function openFile({ root: rootDir, absolute, spawnImpl = spawn, platform = process.platform } = {}) {
  const targetReal = await resolveGalleryFile(rootDir, absolute)
  if (platform !== "darwin") throw new Error("открытие в просмотрщике доступно только на macOS")
  await runGuiCommand(spawnImpl, "open", [targetReal], "не удалось открыть картинку")
  return { ok: true, path: targetReal }
}

/** Parse `osascript -e 'clipboard info'` output into a verified image entry. */
export function parseClipboardInfo(text) {
  const source = String(text ?? "")
  const png = /«class PNGf»,\s*(\d+)/.exec(source)
  const tiff = /TIFF picture,\s*(\d+)/.exec(source)
  const match = png ?? tiff
  if (!match) return { ok: false, bytes: 0, format: "" }
  const bytes = Number(match[1])
  const ok = Number.isFinite(bytes) && bytes > 0
  return { ok, bytes: ok ? bytes : 0, format: ok ? (png ? "PNGf" : "TIFF") : "" }
}

/** Read the macOS clipboard descriptor without printing its contents. */
function readClipboardInfo(spawnImpl, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let child
    let output = ""
    let settled = false
    let timer
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(output)
    }
    try {
      child = spawnImpl("osascript", ["-e", "clipboard info"], { stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      resolve("")
      return
    }
    child.stdout?.on?.("data", (chunk) => { output += String(chunk) })
    child.once?.("error", finish)
    child.once?.("exit", finish)
    timer = setTimeout(() => {
      child.kill?.()
      finish()
    }, timeoutMs)
  })
}

/**
 * Copy one image to the system clipboard. Success is only reported after
 * `clipboard info` confirms a non-empty PNGf/TIFF payload.
 */
export async function copyFile({
  root: rootDir,
  absolute,
  spawnImpl = spawn,
  platform = process.platform,
  clipboardInfoImpl,
} = {}) {
  const targetReal = await resolveGalleryFile(rootDir, absolute)
  if (platform !== "darwin") throw new Error("копирование в буфер доступно только на macOS")
  const formats = ["«class PNGf»", "«class TIFF»"]
  for (const format of formats) {
    const script = [
      "on run argv",
      `set the clipboard to (read (POSIX file (item 1 of argv)) as ${format})`,
      "end run",
    ]
    try {
      await runGuiCommand(
        spawnImpl,
        "osascript",
        ["-e", script[0], "-e", script[1], "-e", script[2], targetReal],
        "не удалось скопировать картинку",
      )
      const info = clipboardInfoImpl ? await clipboardInfoImpl() : await readClipboardInfo(spawnImpl)
      const parsed = parseClipboardInfo(info)
      if (parsed.ok) return { ok: true, path: targetReal, format: parsed.format, bytes: parsed.bytes }
    } catch {
      // Try the next representation; the final response is an honest error.
    }
  }
  throw new Error("не удалось скопировать картинку: буфер не подтвердил PNG")
}

/**
 * Open the native folder picker (macOS only). `spawn` receives an argument
 * array — no shell string interpolation — and cancellation is a normal result.
 */
export async function pickFolder({ spawnImpl = spawn, platform = process.platform, timeoutMs = 120_000 } = {}) {
  if (platform !== "darwin") return { error: "выбор папки доступен только в macOS" }
  const script = 'POSIX path of (choose folder with prompt "Папка для сохранения картинок")'
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      resolve({ error: "не удалось открыть диалог выбора папки" })
      return
    }
    let output = ""
    let done = false
    let timer
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => {
      child.kill?.()
      finish({ error: `выбор папки не завершён за ${formatDuration(timeoutMs)}` })
    }, timeoutMs)
    child.stdout?.on?.("data", (chunk) => {
      output += String(chunk)
    })
    child.once?.("error", () => finish({ error: "не удалось открыть диалог выбора папки" }))
    child.once?.("exit", (code) => {
      const target = output.trim()
      if (code !== 0 || target.length === 0) {
        finish({ cancelled: true })
        return
      }
      stat(target)
        .then(async (info) => {
          if (!info.isDirectory()) return finish({ error: "выбранный путь не является папкой" })
          await access(target, constants.W_OK)
          finish({ path: target })
        })
        .catch(() => finish({ error: "выбранная папка недоступна для записи" }))
    })
  })
}

/** Resolve one gallery row and reveal it; the id comes from the gallery list. */
export async function revealStoredImage({ cwd, saveDir = DEFAULT_SAVE_DIR, id, spawnImpl, platform } = {}) {
  const dir = galleryDir(cwd, saveDir)
  const rows = await listStoredImages({ cwd, saveDir })
  const row = rows.find((entry) => entry.id === id || entry.file === id || path.basename(entry.file) === id)
  if (!row) throw new Error("картинка не найдена")
  const target = await resolveInside(dir, path.basename(row.file))
  return revealFile({ root: dir, absolute: target, spawnImpl, platform })
}

/** Resolve one gallery row and open it in the OS viewer. */
export async function openStoredImage({ cwd, saveDir = DEFAULT_SAVE_DIR, id, spawnImpl, platform } = {}) {
  const dir = galleryDir(cwd, saveDir)
  const rows = await listStoredImages({ cwd, saveDir })
  const row = rows.find((entry) => entry.id === id || entry.file === id || path.basename(entry.file) === id)
  if (!row) throw new Error("картинка не найдена")
  const target = await resolveInside(dir, path.basename(row.file))
  return openFile({ root: dir, absolute: target, spawnImpl, platform })
}

/** Resolve one gallery row and copy it to the clipboard. */
export async function copyStoredImage({ cwd, saveDir = DEFAULT_SAVE_DIR, id, spawnImpl, platform, clipboardInfoImpl } = {}) {
  const dir = galleryDir(cwd, saveDir)
  const rows = await listStoredImages({ cwd, saveDir })
  const row = rows.find((entry) => entry.id === id || entry.file === id || path.basename(entry.file) === id)
  if (!row) throw new Error("картинка не найдена")
  const target = await resolveInside(dir, path.basename(row.file))
  return copyFile({ root: dir, absolute: target, spawnImpl, platform, clipboardInfoImpl })
}

/** Read gallery bytes for the GET file route. */
export async function readStoredImage({ cwd, saveDir = DEFAULT_SAVE_DIR, id } = {}) {
  const dir = galleryDir(cwd, saveDir)
  const rows = await listStoredImages({ cwd, saveDir })
  const row = rows.find((entry) => entry.id === id || entry.file === id || path.basename(entry.file) === id)
  if (!row) throw new Error("картинка не найдена")
  const target = await resolveInside(dir, path.basename(row.file))
  const info = await stat(target)
  if (!info.isFile()) throw new Error("картинка не найдена")
  const data = await readFile(target)
  return { data, mediaType: MEDIA_BY_EXT[path.extname(target).toLowerCase()] ?? "image/png", name: path.basename(target) }
}
