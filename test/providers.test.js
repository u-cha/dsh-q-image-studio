import assert from "node:assert/strict"
import test from "node:test"

import {
  ConnectionError,
  candidatePaths,
  detectStyle,
  endpointFor,
  imagesPath,
  isDashScopeBase,
  listIGModels,
  nativeEndpointFor,
  supportsReferenceEditing,
  testConnection,
  verifyConnection,
} from "../lib/providers.js"

function jsonResponse(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json }
}

const nativeUrl = "https://example.test/api/v1/services/aigc/multimodal-generation/generation"

function nativeProbe(fetchImpl) {
  return async (url, options = {}) => {
    if (url === nativeUrl && options.method === "POST") return jsonResponse({}, 400)
    return fetchImpl(url, options)
  }
}

const modelsFetch = async (url) => {
  if (url.endsWith("/compatible-mode/v1/models")) {
    return jsonResponse({ data: [{ id: "qwen-image-3.0-pro" }] })
  }
  return jsonResponse({}, 404)
}

test("candidatePaths keeps the documented probe order", () => {
  assert.deepEqual(candidatePaths("https://example.test"), [
    "/v1/models",
    "/compatible-mode/v1/models",
  ])
})

test("detectStyle prefers the native DashScope route", async () => {
  const hit = await detectStyle("https://example.test", "k", nativeProbe(modelsFetch), { useCache: false })
  assert.deepEqual(hit, { style: "dashscope-native", models: ["qwen-image-3.0-pro"] })
})

test("detectStyle falls back to compatible-mode when native returns 404", async () => {
  const hit = await detectStyle("https://example.test", "k", modelsFetch, { useCache: false })
  assert.deepEqual(hit, { style: "dashscope-compat", models: ["qwen-image-3.0-pro"] })
})

test("detectStyle reports auth failures with code auth", async () => {
  const unauthorized = async () => jsonResponse({ error: "bad key" }, 401)
  await assert.rejects(
    detectStyle("https://other.test", "k", unauthorized, { useCache: false }),
    (error) => {
      assert.ok(error instanceof ConnectionError)
      assert.equal(error.code, "auth")
      assert.doesNotMatch(error.message, /k$/)
      return true
    },
  )
})

test("imagesPath and reference support follow the style", () => {
  assert.equal(imagesPath("openai"), "/v1/images/generations")
  assert.equal(imagesPath("dashscope-compat"), "/compatible-mode/v1/images/generations")
  assert.equal(imagesPath("dashscope-native"), "/api/v1/services/aigc/multimodal-generation/generation")
  assert.equal(supportsReferenceEditing("dashscope-compat"), true)
  assert.equal(supportsReferenceEditing("dashscope-native"), true)
  assert.equal(supportsReferenceEditing("openai"), false)
})

test("endpointFor does not duplicate an API prefix", () => {
  assert.equal(endpointFor("https://dash.test", "dashscope-compat"), "https://dash.test/compatible-mode/v1/images/generations")
  assert.equal(endpointFor("https://dash.test/compatible-mode/v1", "dashscope-compat"), "https://dash.test/compatible-mode/v1/images/generations")
  assert.equal(endpointFor("https://open.test/v1", "openai"), "https://open.test/v1/images/generations")
  const dashNative = "https://dash.test/api/v1/services/aigc/multimodal-generation/generation"
  assert.equal(endpointFor("https://dash.test/compatible-mode/v1", "dashscope-native"), dashNative)
  assert.equal(nativeEndpointFor("https://dash.test"), dashNative)
  assert.equal(nativeEndpointFor("https://dash.test/"), dashNative)
})

test("testConnection returns a human message without leaking the key", async () => {
  const failing = async () => jsonResponse({ error: { message: "nope" } }, 500)
  const hit = await testConnection("https://down.test", "sk-livekey12345", failing)
  assert.equal(hit.ok, false)
  assert.match(hit.message, /HTTP 500|списка моделей/)
  assert.doesNotMatch(hit.message, /livekey12345/)
})


test("isDashScopeBase only trusts *.aliyuncs.com", () => {
  assert.equal(isDashScopeBase("https://dashscope-intl.aliyuncs.com"), true)
  assert.equal(isDashScopeBase("https://dashscope.aliyuncs.com/compatible-mode/v1"), true)
  assert.equal(isDashScopeBase("https://api.openai.com/v1"), false)
  assert.equal(isDashScopeBase("not a url"), false)
})

test("DashScope catalogue paginates and keeps only IG qwen-image models", async () => {
  const pages = []
  const fetchImpl = async (url) => {
    pages.push(url)
    const page = Number(new URL(url).searchParams.get("page_no"))
    if (page === 1) {
      return jsonResponse({
        total: 5,
        data: [
          { model: "qwen-image-3.0", capabilities: ["T2I", "IG"] },
          { model: "qwen-image-2.1", capabilities: ["IG"] },
          { model: "qwen-image-edit", capabilities: ["T2I"] },
          { model: "qwen-mt-image-1.0", capabilities: ["IG"] },
        ],
      })
    }
    return jsonResponse({ total: 5, data: [{ model: "qwen-image-3.0-pro", capabilities: ["IG"] }] })
  }
  const models = await listIGModels("https://dashscope-intl.aliyuncs.com", "k", fetchImpl, { pageSize: 2 })
  assert.deepEqual(models, ["qwen-image-3.0", "qwen-image-2.1", "qwen-image-3.0-pro"])
  assert.equal(pages.length, 2)
  assert.match(pages[0], /page_size=2/)
  assert.match(pages[0], /page_no=1/)
})

test("non-DashScope servers list only qwen-image-* from compatible-mode", async () => {
  let seen
  const fetchImpl = async (url) => {
    seen = url
    return jsonResponse({
      data: [
        { id: "qwen-image-3.0" },
        { id: "qwen-mt-image-1.0" },
        { id: "gpt-image-1" },
      ],
    })
  }
  const models = await listIGModels("https://proxy.test", "k", fetchImpl)
  assert.deepEqual(models, ["qwen-image-3.0"])
  assert.equal(seen, "https://proxy.test/compatible-mode/v1/models")
})

test("verifyConnection reports auth and 404 codes without generating", async () => {
  const auth = await verifyConnection("https://dashscope.aliyuncs.com", "k", async () => jsonResponse({}, 401))
  assert.equal(auth.ok, false)
  assert.equal(auth.code, "auth")
  const missing = await verifyConnection("https://dashscope.aliyuncs.com", "k", async () => jsonResponse({}, 404))
  assert.equal(missing.ok, false)
  assert.equal(missing.code, "not-found")
  const ok = await verifyConnection("https://dashscope.aliyuncs.com", "k", async () =>
    jsonResponse({ data: [{ model: "qwen-image-3.0", capabilities: ["IG"] }] }),
  )
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.models, ["qwen-image-3.0"])
  assert.match(ok.verifiedAt, /^\d{4}-/)
})

test("native catalogue reads output.models and normalizes model/capabilities", async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.includes("/api/v1/models")) {
      return jsonResponse({
        output: {
          total: 3,
          models: [
            { model: "qwen-image-3.0", capabilities: ["T2I", "IG"] },
            { model: "qwen-image-2.1-pro", capabilities: "IG, T2I" },
            { model: "qwen-mt-image-1.0", capabilities: ["IG"] },
          ],
        },
      })
    }
    return jsonResponse({ data: [{ id: "qwen-image-3.0" }] })
  }
  const models = await listIGModels("https://dashscope-intl.aliyuncs.com", "key", fetchImpl)
  assert.deepEqual(models, ["qwen-image-3.0", "qwen-image-2.1-pro"])
  assert.equal(seen.length, 1, "single page covers total=3")
  const verified = await verifyConnection("https://dashscope-intl.aliyuncs.com", "key", fetchImpl)
  assert.equal(verified.ok, true)
  assert.equal(verified.style, "dashscope-native")
  assert.equal(verified.models.length, 2)
})

test("native catalogue with zero parsed rows falls back to compatible-mode", async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url.includes("/api/v1/models")) return jsonResponse({ output: { total: 0, models: [] } })
    if (url.endsWith("/compatible-mode/v1/models")) {
      return jsonResponse({ data: [{ id: "qwen-image-3.0-pro" }, { id: "qwen-mt-image-1.0" }, { id: "gpt-image-1" }] })
    }
    return jsonResponse({}, 404)
  }
  const models = await listIGModels("https://dashscope-intl.aliyuncs.com", "key", fetchImpl)
  assert.deepEqual(models, ["qwen-image-3.0-pro"])
  assert.ok(urls.some((url) => url.endsWith("/compatible-mode/v1/models")))
})
