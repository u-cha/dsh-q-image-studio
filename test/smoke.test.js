/**
 * Task 1 smoke tests: the Host half must load under plain Node (no installed
 * @deepseek-ai packages), expose its plugin surface and keep the documented
 * config defaults. Run with `node --test test/`.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { apply, Config, inject, name, readConfig } from "../lib/index.js"

test("host half loads and exports apply/inject/name", () => {
  assert.equal(typeof apply, "function")
  assert.equal(name, "dsh-q-image-studio")
  assert.deepEqual(inject, ["tools", "attachments", "credentials"])
})

test("Config validates an empty object", () => {
  assert.equal(typeof Config["~standard"].validate, "function")
  const result = Config["~standard"].validate({})
  assert.equal(result.issues, undefined)
  assert.equal(typeof result.value, "object")
})

test("Config defaults match the patch file", () => {
  const config = readConfig(Config({}))
  assert.equal(config.defaultSize, "1024x1024")
  assert.equal(config.promptExtend, true)
  assert.equal(config.watermark, false)
  assert.equal(config.saveDir, "~/Images/Q-Image-Studio")
  assert.equal(config.activeProviderId, "")
  assert.deepEqual(config.providers, [])
})
