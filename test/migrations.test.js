import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  DEFAULT_SAVE_DIR,
  LEGACY_SAVE_DIR,
  migrateLegacyGallery,
  prepareSaveDirChange,
} from "../lib/store.js"

const PNG = Buffer.from([137, 80, 78, 71])

async function workspace(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-q-image-studio-home-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function seedGallery(dir, ids = ["a", "b"]) {
  await mkdir(dir, { recursive: true })
  const index = []
  for (const id of ids) {
    const file = path.join(dir, `${id}.png`)
    await writeFile(file, PNG)
    index.push({ id, file, prompt: `p-${id}`, model: "qwen", size: "1024x1024", createdAt: "2026-11-08T00:00:00.000Z" })
  }
  await writeFile(path.join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`)
  return index
}

test("startup migration moves legacy files and rewrites index paths", async (t) => {
  const home = await workspace(t)
  const legacy = path.join(home, "Images", "DSH-Image-Studio")
  await seedGallery(legacy, ["old-one", "old-two"])
  const logs = []
  const result = await migrateLegacyGallery({ homeDir: home, saveDir: DEFAULT_SAVE_DIR, log: (line) => logs.push(line) })
  assert.equal(result.migrated, true)
  assert.equal(result.moved, 2)
  const target = path.join(home, "Images", "Q-Image-Studio")
  assert.deepEqual((await readdir(target)).sort(), ["index.json", "old-one.png", "old-two.png"])
  const index = JSON.parse(await readFile(path.join(target, "index.json"), "utf8"))
  assert.ok(index.every((row) => row.file.startsWith(target)))
  assert.equal((await readdir(legacy)).length, 0)
  assert.ok(logs.some((line) => /перенесено 2/.test(line)))
})

test("startup migration skips a non-empty target and keeps both directories", async (t) => {
  const home = await workspace(t)
  const legacy = path.join(home, "Images", "DSH-Image-Studio")
  const target = path.join(home, "Images", "Q-Image-Studio")
  await seedGallery(legacy, ["old"])
  await seedGallery(target, ["new"])
  const logs = []
  const result = await migrateLegacyGallery({ homeDir: home, saveDir: DEFAULT_SAVE_DIR, log: (line) => logs.push(line) })
  assert.equal(result.migrated, false)
  assert.equal(result.reason, "target-not-empty")
  assert.equal((await readdir(legacy)).length, 2)
  assert.equal((await readdir(target)).length, 2)
  assert.ok(logs.some((line) => /не пуста/.test(line)))
})

test("save-dir change asks for confirmation and leaves everything untouched", async (t) => {
  const home = await workspace(t)
  const oldDir = path.join(home, "old")
  const target = path.join(home, "new")
  await seedGallery(oldDir, ["a", "b"])
  const result = await prepareSaveDirChange({ oldSaveDir: oldDir, saveDir: target, homeDir: home })
  assert.equal(result.ok, false)
  assert.equal(result.code, "confirm-migration")
  assert.equal(result.count, 2)
  await assert.rejects(readdir(target), { code: "ENOENT" })
  assert.equal((await readdir(oldDir)).length, 3)
})

test("confirmed save-dir change moves files and index", async (t) => {
  const home = await workspace(t)
  const oldDir = path.join(home, "old")
  const target = path.join(home, "new")
  await seedGallery(oldDir, ["a"])
  const result = await prepareSaveDirChange({ oldSaveDir: oldDir, saveDir: target, migrate: true, homeDir: home })
  assert.equal(result.ok, true)
  assert.equal(result.migrated, 1)
  assert.deepEqual((await readdir(target)).sort(), ["a.png", "index.json"])
  const index = JSON.parse(await readFile(path.join(target, "index.json"), "utf8"))
  assert.equal(index[0].file, path.join(target, "a.png"))
})

test("save-dir change rejects a non-empty destination", async (t) => {
  const home = await workspace(t)
  const oldDir = path.join(home, "old")
  const target = path.join(home, "new")
  await seedGallery(oldDir, ["a"])
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, "keep.txt"), "keep")
  await assert.rejects(
    prepareSaveDirChange({ oldSaveDir: oldDir, saveDir: target, migrate: true, homeDir: home }),
    /папка не пуста, выберите другую/,
  )
  assert.equal((await readdir(oldDir)).length, 2)
  assert.deepEqual(await readdir(target), ["keep.txt"])
})

test("legacy default path itself resolves and is not mistaken for the new target", () => {
  assert.equal(LEGACY_SAVE_DIR, "~/Images/DSH-Image-Studio")
  assert.equal(DEFAULT_SAVE_DIR, "~/Images/Q-Image-Studio")
})
