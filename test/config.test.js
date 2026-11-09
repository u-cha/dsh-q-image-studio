/**
 * Config schema contract: every field must be marked volatile so DSH serves
 * the plugin settings form, while the rest of the code keeps seeing plain
 * values through readConfig/unwrap.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { Config, readConfig, unwrap, unwrapConfig, volatile } from "../lib/config.js"

test("every config field is volatile in the serialized schema", () => {
  const json = Config.toJSON()
  const root = json.refs[json.uid]
  const fields = Object.keys(root.dict)
  assert.deepEqual(fields, [
    "providers",
    "activeProviderId",
    "defaultSize",
    "promptExtend",
    "watermark",
    "saveDir",
    "language",
    "animations",
  ])
  for (const field of fields) {
    const ref = json.refs[root.dict[field]]
    assert.equal(ref.meta?.volatile, true, `${field} must be volatile`)
  }
})

test("volatile() is defensive when the schema has no method", () => {
  const plain = { type: "string" }
  assert.equal(volatile(plain), plain)
  assert.equal(volatile(undefined), undefined)
})

test("unwrap reads a Volatile box and leaves plain values intact", () => {
  const box = { get: () => "live" }
  assert.equal(unwrap(box), "live")
  assert.equal(unwrap("plain"), "plain")
  assert.equal(unwrap(1), 1)
})

test("readConfig unwraps every Volatile box of the validated config", () => {
  const config = Config({ providers: [{ id: "qwen", label: "Qwen", baseURL: "https://dash.test" }] })
  assert.equal(typeof config.providers?.get, "function")
  const plain = readConfig(config)
  assert.equal(plain.defaultSize, "1024x1024")
  assert.deepEqual(plain.providers, [
    { id: "qwen", label: "Qwen", baseURL: "https://dash.test", model: "", apiKeyRef: "", models: [], verifiedAt: "", unavailableModels: [] },
  ])
  assert.equal(Object.values(plain).some((value) => typeof value?.get === "function"), false)
})

test("readConfig tolerates missing and plain config objects", () => {
  assert.equal(readConfig(undefined).saveDir, "~/Images/Q-Image-Studio")
  assert.equal(readConfig(undefined).language, "en")
  assert.equal(readConfig(undefined).animations, true)
  assert.deepEqual(unwrapConfig({ a: { get: () => 1 }, b: 2 }), { a: 1, b: 2 })
})
