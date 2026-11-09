import assert from "node:assert/strict"
import { access, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { deflateSync } from "node:zlib"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  DEFAULT_SAVE_DIR,
  deleteStoredImage,
  ensureGalleryDir,
  effectiveSaveDir,
  formatGalleryEntry,
  copyFile,
  copyStoredImage,
  openFile,
  openStoredImage,
  listGallery,
  pickFolder,
  normalizeIndexEntries,
  parseClipboardInfo,
  pngAlphaInfo,
  readStoredImage,
  resolveSaveDir,
  revealFile,
  revealStoredImage,
  saveResults,
} from "../lib/store.js"

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

function imageFetch(bytes = PNG, mediaType = "image/png") {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "content-type" ? mediaType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })
}

async function tempCwd(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-q-image-studio-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("saveResults writes the timestamped file and index inside the save directory", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const createdAt = new Date(2024, 0, 2, 3, 4, 5)
  const saved = await saveResults({
    cwd,
    saveDir,
    prompt: "Кот в шляпе",
    model: "qwen-image-3.0",
    size: "1024x1024",
    urls: ["https://cdn.test/cat.png"],
    fetchImpl: imageFetch(),
    createdAt,
  })
  assert.equal(saved.files.length, 1)
  assert.equal(path.basename(saved.files[0]), "20240102-030405-kot-v-shlyape.png")
  assert.ok(path.isAbsolute(saved.files[0]), "tool result paths are absolute")
  const index = JSON.parse(await readFile(path.join(saveDir, "index.json"), "utf8"))
  assert.equal(index.length, 1)
  assert.equal(index[0].file, saved.files[0], "index rows keep absolute paths")
  assert.equal(index[0].prompt, "Кот в шляпе")
})

test("an absolute saveDir is created and keeps its own index", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const target = path.join(cwd, "custom", "gallery")
  await assert.rejects(access(target), /ENOENT/, "directory does not exist yet")
  const saved = await saveResults({
    cwd,
    saveDir: target,
    prompt: "abs",
    model: "m",
    size: "s",
    urls: ["u"],
    fetchImpl: imageFetch(),
  })
  assert.equal(path.dirname(saved.files[0]), target)
  const index = JSON.parse(await readFile(path.join(target, "index.json"), "utf8"))
  assert.equal(index.length, 1)
  assert.equal(index[0].file, saved.files[0])
  await access(target)
})

test("resolveSaveDir accepts absolute and ~ paths but rejects relative paths", () => {
  assert.deepEqual(resolveSaveDir("~/Images/DSH-Image-Studio", { homeDir: "/Users/u" }), {
    dir: "/Users/u/Images/DSH-Image-Studio",
    relative: false,
  })
  assert.equal(
    resolveSaveDir(undefined, { homeDir: "/Users/u" }).dir,
    path.join("/Users/u", DEFAULT_SAVE_DIR.slice(2)),
  )
  assert.throws(() => resolveSaveDir("images", { homeDir: "/Users/u" }), /абсолютный путь/)
  assert.throws(() => resolveSaveDir("", { homeDir: "/Users/u" }), /абсолютный путь/)
  assert.throws(() => resolveSaveDir("../outside", { homeDir: "/Users/u" }), /абсолютный путь/)
  assert.equal(
    effectiveSaveDir("images", { homeDir: "/Users/u" }).dir,
    path.join("/Users/u", DEFAULT_SAVE_DIR.slice(2)),
    "legacy relative config migrates to the default",
  )
})

test("ensureGalleryDir creates a missing absolute directory", async (t) => {
  const cwd = await tempCwd(t)
  const target = path.join(cwd, "fresh", "nested")
  const dir = await ensureGalleryDir({ saveDir: target })
  assert.equal(dir, target)
  await access(dir)
})

test("listGallery survives a corrupt index by scanning the directory", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  await saveResults({ cwd, saveDir, prompt: "one", model: "m", size: "s", urls: ["u1"], fetchImpl: imageFetch() })
  await saveResults({ cwd, saveDir, prompt: "two", model: "m", size: "s", urls: ["u2"], fetchImpl: imageFetch() })
  await writeFile(path.join(saveDir, "index.json"), "{not json", "utf8")
  const gallery = await listGallery({ cwd, saveDir })
  assert.equal(gallery.ok, true)
  assert.equal(gallery.entries.length, 2)
})

test("formatGalleryEntry exposes absolute file and thumb paths", () => {
  assert.deepEqual(formatGalleryEntry({ id: "a", file: "/work/images/a.png", prompt: "x" }), {
    id: "a",
    file: "/work/images/a.png",
    thumb: "/work/images/a.png",
    label: "x",
    prompt: "x",
    model: "",
    size: "",
    createdAt: null,
    finalPrompt: "x",
    seed: undefined,
    promptExtend: undefined,
    transparent: false,
    alphaChecked: false,
    hasAlpha: false,
    transparentPixels: false,
    requestJson: null,
    pluginVersion: "",
    references: [],
  })
})

test("deleteStoredImage removes the file and the index row", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const saved = await saveResults({
    cwd,
    saveDir,
    prompt: "bye",
    model: "m",
    size: "s",
    urls: ["u"],
    fetchImpl: imageFetch(),
  })
  await deleteStoredImage({ cwd, saveDir, id: saved.entries[0].id })
  const gallery = await listGallery({ cwd, saveDir })
  assert.equal(gallery.entries.length, 0)
  const index = JSON.parse(await readFile(path.join(saveDir, "index.json"), "utf8"))
  assert.deepEqual(index, [])
  await assert.rejects(readStoredImage({ cwd, saveDir, id: saved.entries[0].id }), /не найдена/)
})

test("readStoredImage serves bytes only from the gallery directory", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const saved = await saveResults({
    cwd,
    saveDir,
    prompt: "peek",
    model: "m",
    size: "s",
    urls: ["u"],
    fetchImpl: imageFetch(),
  })
  const hit = await readStoredImage({ cwd, saveDir, id: saved.entries[0].id })
  assert.equal(hit.mediaType, "image/png")
  assert.deepEqual(new Uint8Array(hit.data), PNG)
  await assert.rejects(readStoredImage({ cwd, saveDir, id: "../../etc/passwd" }), /не найдена/)
})

test("reveal runs open -R only for files inside the gallery", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const saved = await saveResults({
    cwd,
    saveDir,
    prompt: "show",
    model: "m",
    size: "s",
    urls: ["u"],
    fetchImpl: imageFetch(),
  })
  const calls = []
  const fakeSpawn = (command, args) => {
    calls.push([command, ...args])
    const child = { once(event, handler) { if (event === "exit") setImmediate(() => handler(0)); return child } }
    return child
  }
  const result = await revealStoredImage({
    cwd,
    saveDir,
    id: saved.entries[0].id,
    spawnImpl: fakeSpawn,
    platform: "darwin",
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [["open", "-R", await realpath(saved.files[0])]])
  await assert.rejects(
    revealFile({
      root: saveDir,
      absolute: "/etc/passwd",
      spawnImpl: fakeSpawn,
      platform: "darwin",
    }),
    /вне папки картинок/,
  )
  await assert.rejects(
    revealStoredImage({ cwd, saveDir, id: "nope", spawnImpl: fakeSpawn, platform: "darwin" }),
    /не найдена/,
  )
})

function fakePicker({ code = 0, stdout = "" } = {}) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", stdout)
      child.emit("exit", code)
    })
    return child
  }
}

test("pickFolder handles cancellation, non-macOS and non-directory paths", async (t) => {
  assert.deepEqual(await pickFolder({ platform: "linux" }), {
    error: "выбор папки доступен только в macOS",
  })
  assert.deepEqual(await pickFolder({ platform: "darwin", spawnImpl: fakePicker({ code: 1 }) }), {
    cancelled: true,
  })
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const file = path.join(cwd, "note.txt")
  await writeFile(file, "x")
  assert.deepEqual(
    await pickFolder({ platform: "darwin", spawnImpl: fakePicker({ stdout: `${file}\n` }) }),
    { error: "выбранный путь не является папкой" },
  )
  assert.deepEqual(
    await pickFolder({ platform: "darwin", spawnImpl: fakePicker({ stdout: `${cwd}\n` }) }),
    { path: cwd },
  )
})

test("open and copy validate gallery containment and pass argv paths", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const saved = await saveResults({
    cwd,
    saveDir,
    prompt: "clip",
    model: "m",
    size: "s",
    urls: ["u"],
    fetchImpl: imageFetch(),
  })
  const calls = []
  const fakeSpawn = (command, args) => {
    calls.push([command, ...args])
    const child = { once(event, handler) { if (event === "exit") setImmediate(() => handler(0)); return child } }
    return child
  }
  const target = await realpath(saved.files[0])
  assert.deepEqual(
    await openStoredImage({ cwd, saveDir, id: saved.entries[0].id, spawnImpl: fakeSpawn, platform: "darwin" }),
    { ok: true, path: target },
  )
  assert.deepEqual(calls[0], ["open", target])
  const copied = await copyStoredImage({
    cwd,
    saveDir,
    id: saved.entries[0].id,
    spawnImpl: fakeSpawn,
    platform: "darwin",
    clipboardInfoImpl: async () => "«class PNGf», 1234, TIFF picture, 5678",
  })
  assert.deepEqual(copied, { ok: true, path: target, format: "PNGf", bytes: 1234 })
  assert.equal(calls[1][0], "osascript")
  assert.equal(calls[1][calls[1].length - 1], target)
  assert.match(calls[1].join(" "), /«class PNGf»/)
  await assert.rejects(
    openFile({ root: saveDir, absolute: "/etc/passwd", spawnImpl: fakeSpawn, platform: "darwin" }),
    /вне папки картинок/,
  )
  await assert.rejects(
    copyFile({ root: saveDir, absolute: "/etc/passwd", spawnImpl: fakeSpawn, platform: "darwin" }),
    /вне папки картинок/,
  )
  await assert.rejects(
    openStoredImage({ cwd, saveDir, id: "nope", spawnImpl: fakeSpawn, platform: "darwin" }),
    /не найдена/,
  )
  await assert.rejects(
    copyFile({ root: saveDir, absolute: target, spawnImpl: fakeSpawn, platform: "linux" }),
    /только на macOS/,
  )
})


test("copy verifies the clipboard and fails without a false success", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-q-image-studio-copy-"))
  try {
    const file = path.join(dir, "clip.png")
    await writeFile(file, Buffer.from("not a real png"))
    const calls = []
    const fakeSpawn = (command, args) => {
      calls.push([command, ...args])
      const child = { once(event, handler) { if (event === "exit") setImmediate(() => handler(0)); return child } }
      return child
    }
    await assert.rejects(
      copyFile({ root: dir, absolute: file, spawnImpl: fakeSpawn, platform: "darwin", clipboardInfoImpl: async () => "" }),
      /буфер не подтвердил PNG/,
    )
    assert.equal(calls.length, 2, "PNGf then TIFF are attempted")
    assert.match(calls[1].join(" "), /«class TIFF»/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("clipboard info parser only accepts non-empty image payloads", () => {
  assert.deepEqual(parseClipboardInfo("«class PNGf», 42, TIFF picture, 99"), { ok: true, bytes: 42, format: "PNGf" })
  assert.deepEqual(parseClipboardInfo("TIFF picture, 99"), { ok: true, bytes: 99, format: "TIFF" })
  assert.deepEqual(parseClipboardInfo("«class PNGf», 0"), { ok: false, bytes: 0, format: "" })
  assert.deepEqual(parseClipboardInfo("plain text"), { ok: false, bytes: 0, format: "" })
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

function rgbaPng(alpha) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const scanline = Buffer.from([0, 255, 0, 0, alpha])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanline)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function rgbPng() {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const scanline = Buffer.from([0, 255, 0, 0])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanline)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

test("pngAlphaInfo distinguishes RGBA pixels from an RGB image without alpha", () => {
  const clear = pngAlphaInfo(rgbaPng(0))
  assert.deepEqual(clear, { checked: true, hasAlpha: true, transparent: true })
  const opaque = pngAlphaInfo(rgbaPng(255))
  assert.deepEqual(opaque, { checked: true, hasAlpha: true, transparent: false })
  const rgb = pngAlphaInfo(rgbPng())
  assert.deepEqual(rgb, { checked: true, hasAlpha: false, transparent: false })
  assert.deepEqual(pngAlphaInfo(Buffer.from("not a png")), { checked: false, hasAlpha: false, transparent: false })
})

test("four concurrent saves with the same prompt keep four files and index rows", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const createdAt = new Date(2024, 0, 2, 3, 4, 5)
  const url = `data:image/png;base64,${rgbaPng(255).toString("base64")}`
  const saved = await Promise.all(
    Array.from({ length: 4 }, () =>
      saveResults({
        cwd,
        saveDir,
        prompt: "Vibe cat",
        model: "qwen-image-3.0",
        size: "1024x1024",
        transparent: true,
        urls: [url],
        createdAt,
      }),
    ),
  )
  const files = saved.flatMap((hit) => hit.files)
  assert.equal(new Set(files).size, 4, "every concurrent save gets its own file")
  for (const file of files) await access(file)
  const listing = await readdir(saveDir)
  assert.equal(listing.filter((name) => name.endsWith(".png")).length, 4)
  const index = JSON.parse(await readFile(path.join(saveDir, "index.json"), "utf8"))
  assert.equal(index.length, 4)
  assert.equal(new Set(index.map((entry) => entry.id)).size, 4)
})

test("legacy absolute index paths are normalized to the current gallery", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "Q-Image-Studio")
  await ensureGalleryDir({ saveDir })
  await writeFile(path.join(saveDir, "20240102-030405-cat.png"), rgbaPng(255))
  await writeFile(
    path.join(saveDir, "index.json"),
    JSON.stringify([
      { id: "20240102-030405-cat", file: path.join(cwd, "DSH-Image-Studio", "20240102-030405-cat.png"), prompt: "cat" },
    ]),
  )
  const rows = await (await import("../lib/store.js")).listStoredImages({ cwd, saveDir })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].file, path.join(saveDir, "20240102-030405-cat.png"))
  const index = JSON.parse(await readFile(path.join(saveDir, "index.json"), "utf8"))
  assert.equal(index[0].file, path.join(saveDir, "20240102-030405-cat.png"))
  const normalized = normalizeIndexEntries("/tmp/current", [
    { file: "/tmp/old/DSH-Image-Studio/a.png" },
    { file: "/tmp/current/b.png" },
  ])
  assert.equal(normalized.changed, true)
  assert.deepEqual(normalized.entries.map((entry) => entry.file), ["/tmp/current/a.png", "/tmp/current/b.png"])
})

test("index.json stores generation metadata without secrets", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  await saveResults({
    cwd,
    saveDir,
    prompt: "Кот",
    originalPrompt: "Кот",
    finalPrompt: "This is an RGBA image with transparency. Кот. The image has alpha channel and the background is transparent.",
    model: "qwen-image-3.0",
    size: "1024x1024",
    seed: 42,
    promptExtend: false,
    transparent: true,
    requestBody: { model: "qwen-image-3.0", input: { messages: [] } },
    pluginVersion: "0.2.0",
    references: ["attachment:sha256:x"],
    urls: ["u"],
    fetchImpl: imageFetch(),
  })
  const index = JSON.parse(await readFile(path.join(saveDir, "index.json"), "utf8"))
  assert.equal(index.length, 1)
  assert.equal(index[0].seed, 42)
  assert.equal(index[0].promptExtend, false)
  assert.equal(index[0].transparent, true)
  assert.equal(index[0].prompt, "Кот")
  assert.equal(index[0].finalPrompt.startsWith("This is an RGBA image"), true)
  assert.equal(index[0].requestJson.model, "qwen-image-3.0")
  assert.equal(index[0].pluginVersion, "0.2.0")
  assert.deepEqual(index[0].references, ["attachment:sha256:x"])
  assert.equal("key" in index[0], false)
})

test("saveResults records an RGB image as checked without alpha", async (t) => {
  const cwd = await tempCwd(t)
  const saveDir = path.join(cwd, "images")
  const saved = await saveResults({
    cwd,
    saveDir,
    prompt: "opaque",
    model: "qwen-image-2.0",
    size: "1024x1024",
    transparent: true,
    urls: ["u"],
    fetchImpl: imageFetch(rgbPng()),
  })
  assert.equal(saved.entries[0].alphaChecked, true)
  assert.equal(saved.entries[0].hasAlpha, false)
  assert.equal(saved.entries[0].transparentPixels, false)
  assert.equal(saved.blobs[0].alpha.hasAlpha, false)
})

test("deleting a history row still works when its file is already gone", async () => {
  const { deleteStoredImage, listStoredImages, saveResults } = await import("../lib/store.js")
  const cwd = await mkdtemp(path.join(os.tmpdir(), "qis-gallery-missing-"))
  const saveDir = path.join(cwd, "images")
  await saveResults({
    cwd,
    saveDir,
    prompt: "vanished",
    model: "qwen-image-3.0",
    size: "512x512",
    urls: [`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`],
  })
  const [row] = await listStoredImages({ cwd, saveDir })
  await unlink(path.join(saveDir, path.basename(row.file)))
  const result = await deleteStoredImage({ cwd, saveDir, id: row.id })
  assert.equal(result.ok, true)
  assert.deepEqual(await listStoredImages({ cwd, saveDir }), [])
})
