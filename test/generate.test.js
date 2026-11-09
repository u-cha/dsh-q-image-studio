import assert from "node:assert/strict"
import test from "node:test"

import { MAX_SEED, ProviderError, buildBody, formatDuration, parseResponse, randomSeed, requestGeneration, slugify } from "../lib/generate.js"

test("randomSeed covers the whole 31-bit range", () => {
  assert.equal(randomSeed(() => 0), 0)
  assert.equal(randomSeed(() => 0.999999999999), MAX_SEED)
  for (let index = 0; index < 50; index += 1) {
    const value = randomSeed()
    assert.equal(Number.isInteger(value), true)
    assert.equal(value >= 0 && value <= MAX_SEED, true)
  }
})

test("buildBody emits only the protocol fields that are set", () => {
  assert.deepEqual(
    buildBody({ model: "m", prompt: "p", n: 1, size: "1024x1024" }),
    { model: "m", prompt: "p", n: 1, size: "1024x1024" },
  )
})

test("buildBody adds image, seed and toggles", () => {
  assert.deepEqual(
    buildBody({
      model: "m",
      prompt: "p",
      n: 2,
      size: "1328x1328",
      seed: 7,
      images: ["data:image/png;base64,AAA"],
      promptExtend: true,
      watermark: false,
    }),
    {
      model: "m",
      prompt: "p",
      n: 2,
      size: "1328x1328",
      seed: 7,
      prompt_extend: true,
      watermark: false,
      image: "data:image/png;base64,AAA",
    },
  )
})

test("buildBody uses the native DashScope multimodal envelope", () => {
  const image = "data:image/png;base64,AAA"
  assert.deepEqual(
    buildBody({ model: "qwen-image-2.0", prompt: "p", n: 2, size: "1024x1024", images: [image] }, "dashscope-native"),
    {
      model: "qwen-image-2.0",
      input: {
        messages: [
          { role: "user", content: [{ image }, { text: "p" }] },
        ],
      },
      parameters: { size: "1024*1024", n: 2 },
    },
  )
})

test("native body keeps parameters flat and uses a star in size", () => {
  const body = buildBody(
    { model: "m", prompt: "p", n: 1, size: "1328x1328", seed: 5, promptExtend: false, watermark: true },
    "dashscope-native",
  )
  assert.equal(body.input.messages[0].content.length, 1)
  assert.deepEqual(body.parameters, {
    size: "1328*1328",
    n: 1,
    seed: 5,
    prompt_extend: false,
    watermark: true,
  })
})

test("parseResponse accepts compatible-mode and native payloads", () => {
  assert.deepEqual(parseResponse({ data: [{ url: "https://cdn.test/a.png" }] }), { urls: ["https://cdn.test/a.png"] })
  assert.deepEqual(parseResponse({ output: { results: [{ url: "https://cdn.test/b.png" }] } }), { urls: ["https://cdn.test/b.png"] })
})

test("parseResponse collects every native content image", () => {
  const json = {
    output: {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: [{ image: "https://cdn.test/one.png" }, { text: "x" }, { image: "https://cdn.test/two.png" }],
          },
        },
      ],
    },
  }
  assert.deepEqual(parseResponse(json), { urls: ["https://cdn.test/one.png", "https://cdn.test/two.png"] })
})

test("parseResponse rejects a picture-less payload", () => {
  assert.throws(() => parseResponse({ data: [] }), /не вернул картинку/)
  assert.throws(() => parseResponse({}), ProviderError)
})

test("slugify transliterates and trims", () => {
  assert.equal(slugify("Кот в шляпе!! / 2024"), "kot-v-shlyape-2024")
  assert.equal(slugify(""), "image")
  assert.equal(slugify("a".repeat(100)).length, 40)
})

test("requestGeneration posts JSON and parses the URL list", async () => {
  const calls = []
  const mockFetch = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://cdn.test/x.png" }] }) }
  }
  const hit = await requestGeneration({
    baseUrl: "https://dash.test/compatible-mode/v1",
    style: "dashscope-compat",
    key: "secret-key",
    body: { model: "m", prompt: "p" },
    fetchImpl: mockFetch,
  })
  assert.deepEqual(hit, { urls: ["https://cdn.test/x.png"] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://dash.test/compatible-mode/v1/images/generations")
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-key")
  assert.equal(calls[0].options.body, JSON.stringify({ model: "m", prompt: "p" }))
})

test("requestGeneration posts a native body to the multimodal endpoint", async () => {
  const calls = []
  const nativeFetch = async (url, options) => {
    calls.push({ url, body: options.body })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: { choices: [{ message: { content: [{ image: "https://cdn.test/native.png" }] } }] },
      }),
    }
  }
  const body = buildBody({ model: "m", prompt: "p", n: 1, size: "1024x1024" }, "dashscope-native")
  const hit = await requestGeneration({
    baseUrl: "https://dashscope-intl.aliyuncs.com",
    style: "dashscope-native",
    key: "secret-key",
    body,
    fetchImpl: nativeFetch,
  })
  assert.deepEqual(hit, { urls: ["https://cdn.test/native.png"] })
  assert.equal(calls[0].url, "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation")
  assert.deepEqual(JSON.parse(calls[0].body), body)
})

test("requestGeneration retries once on 429 and masks provider errors", async () => {
  let attempt = 0
  const transient = async () => {
    attempt += 1
    if (attempt === 1) return { ok: false, status: 429, text: async () => "slow down" }
    return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://cdn.test/y.png" }] }) }
  }
  const hit = await requestGeneration({
    baseUrl: "https://dash.test",
    style: "dashscope-compat",
    key: "secret-key",
    body: { model: "m", prompt: "p" },
    fetchImpl: transient,
  })
  assert.deepEqual(hit, { urls: ["https://cdn.test/y.png"] })
  assert.equal(attempt, 2)

  const failing = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ code: "AllocationQuota.FreeTierOnly", message: "bad Bearer secret-key" }),
  })
  await assert.rejects(
    requestGeneration({
      baseUrl: "https://dash.test",
      style: "dashscope-compat",
      key: "secret-key",
      body: { model: "m", prompt: "p" },
      fetchImpl: failing,
    }),
    (error) => {
      assert.match(error.message, /HTTP 400 AllocationQuota\.FreeTierOnly: bad Bearer \*\*\*/)
      assert.equal(error.httpStatus, 400)
      assert.equal(error.providerCode, "AllocationQuota.FreeTierOnly")
      assert.doesNotMatch(error.message, /secret-key/)
      return true
    },
  )
})

test("timeout message reports the real limit", async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      }, { once: true })
    })
  await assert.rejects(
    requestGeneration({
      baseUrl: "https://dash.test",
      style: "dashscope-compat",
      key: "secret-key",
      body: { model: "m", prompt: "p" },
      fetchImpl: hanging,
      timeoutMs: 60,
    }),
    /поставщик не ответил за 60 мс/,
  )
  assert.equal(formatDuration(120_000), "2 мин")
  assert.equal(formatDuration(5_000), "5 сек")
})
