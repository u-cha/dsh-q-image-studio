import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Config, ROUTES, apply, pickFolderRoute, runGeneration } from "../lib/index.js"
import { validateValue } from "../lib/tool.js"

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

function jsonResponse(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: () => "application/json" } }
}

function pngResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "content-type" ? "image/png" : name === "content-length" ? String(PNG.byteLength) : null) },
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
  }
}

function fakeFetch(bodies) {
  return async (url, options = {}) => {
    if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "qwen-image-3.0" }] })
    if (url.includes("/api/v1/models")) {
      return jsonResponse({
        total: 2,
        data: [
          { model: "qwen-image-3.0", capabilities: ["T2I", "IG"] },
          { model: "qwen-image-lora", capabilities: ["T2I"] },
        ],
      })
    }
    if (url.endsWith("/api/v1/services/aigc/multimodal-generation/generation")) {
      const body = options.body === "{}" ? {} : JSON.parse(options.body)
      if (options.body === "{}") return jsonResponse({}, 400)
      if (bodies) bodies.push(body)
      return jsonResponse({
        output: { choices: [{ message: { content: [{ image: "https://cdn.test/cat.png" }] } }] },
      })
    }
    if (url.endsWith("/images/generations")) {
      if (bodies) bodies.push(JSON.parse(options.body))
      return jsonResponse({ data: [{ url: "https://cdn.test/cat.png" }] })
    }
    if (url === "https://cdn.test/cat.png") return pngResponse()
    return jsonResponse({}, 404)
  }
}

function fakeContext() {
  const registered = { tools: [], routes: [] }
  const ctx = {
    credentials: {
      resolve: async () => ({ value: "test-key", source: "vault" }),
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    attachments: {
      imageLimits: { maxImageBytes: 10 * 1024 * 1024 },
      saveImage: async ({ mediaType, name }) => ({
        attachmentId: "sha256:deadbeef",
        mediaType,
        bytes: PNG.byteLength,
        width: 1,
        height: 1,
        name,
      }),
      readImage: async () => ({ ref: { attachmentId: "sha256:deadbeef", mediaType: "image/png" }, data: PNG }),
    },
    tools: { register: (tool) => { registered.tools.push(tool); return () => {} } },
    webServer: { register: (route) => { registered.routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    effect: (fn) => fn(),
    inject: (_deps, callback) => callback(ctx),
  }
  return { ctx, registered }
}

async function tempCwd(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-q-image-studio-host-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("apply registers the tool and all Host routes", () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dash.test", model: "qwen-image-3.0" }] }))
  assert.equal(registered.tools.length, 1)
  assert.equal(registered.tools[0].name, "image_generate")
  const paths = registered.routes.map((route) => route.path).sort()
  assert.deepEqual(paths, Object.values(ROUTES).sort())
})

test("image_generate runs the whole pipeline and saves into images/", async (t) => {
  const cwd = await tempCwd(t)
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch()
  t.after(() => { globalThis.fetch = original })

  const { ctx, registered } = fakeContext()
  const config = Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dash.test", model: "qwen-image-3.0" }], saveDir: path.join(cwd, "images") })
  apply(ctx, config)
  const tool = registered.tools[0]
  const result = await tool.execute({ prompt: "Кот в шляпе" }, { agent: { session: { header: { cwd } } } })
  assert.equal(result.ok, true)
  assert.deepEqual(validateValue(tool.output.schema, result), [], "tool output matches its schema")
  assert.equal(result.prompt, "Кот в шляпе")
  assert.equal(result.files.length, 1)
  assert.equal(path.basename(result.files[0]), path.basename(result.files[0]))
  assert.match(path.basename(result.files[0]), /^\d{8}-\d{6}-kot-v-shlyape\.png$/)
  assert.equal(result.attachments.length, 1)
  assert.equal(result.attachments[0].attachmentId, "sha256:deadbeef")
  const index = JSON.parse(await readFile(path.join(cwd, "images", "index.json"), "utf8"))
  assert.equal(index[0].prompt, "Кот в шляпе")
  assert.equal("url" in index[0], false, "signed provider URLs are never persisted")
  assert.equal(index.length, 1)
})

test("image_generate converts failures into a masked tool error", async (t) => {
  const cwd = await tempCwd(t)
  const original = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({}, 401)
  t.after(() => { globalThis.fetch = original })

  const { ctx } = fakeContext()
  const config = Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://auth.test" }] })
  await assert.rejects(runGeneration(ctx, config, { prompt: "x", cwd }), /ключ отклонён/)
})

function fakeRequest(body, method = "POST") {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

function fakeResponse() {
  const captured = { status: 0, headers: {}, body: "" }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      Object.assign(captured.headers, headers ?? {})
    },
    end(body) {
      captured.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "")
    },
  }
}

async function callRoute(route, payload, method = "POST") {
  const res = fakeResponse()
  await route.handler(fakeRequest(payload, method), res)
  return { status: res.captured.status, headers: res.captured.headers, json: JSON.parse(res.captured.body || "null") }
}

test("plugin icon route serves the packaged PNG and keyStatus exposes limits", async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dash.test" }] }))
  const route = registered.routes.find((entry) => entry.path === ROUTES.icon)
  assert.ok(route, "icon route")
  let status = 0
  let headers = {}
  let body
  await route.handler(
    { method: "GET", url: ROUTES.icon },
    { writeHead(code, next) { status = code; headers = next }, end(value) { body = value } },
  )
  assert.equal(status, 200)
  assert.equal(headers["content-type"], "image/png")
  assert.ok(Buffer.isBuffer(body) && body.byteLength > 1000, "real icon bytes")

  const keyRoute = registered.routes.find((entry) => entry.path === ROUTES.keyStatus)
  const info = await callRoute(keyRoute, {})
  assert.equal(info.json.imageLimits.maxImageBytes, 10 * 1024 * 1024)
})

test("pick-folder route returns cancelled and surfaces picker errors", async () => {
  const cancelled = { path: ROUTES.pickFolder, handler: pickFolderRoute(async () => ({ cancelled: true })) }
  const cancelledOut = await callRoute(cancelled, {})
  assert.deepEqual(cancelledOut.json, { cancelled: true })

  const failed = {
    path: ROUTES.pickFolder,
    handler: pickFolderRoute(async () => ({ error: "выбор папки доступен только в macOS" })),
  }
  const failedOut = await callRoute(failed, {})
  assert.equal(failedOut.json.ok, false)
  assert.match(failedOut.json.error, /только в macOS/)
})

test("host registers the reveal and folder picker routes", () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dash.test" }] }))
  const paths = registered.routes.map((entry) => entry.path)
  assert.ok(paths.includes(ROUTES.reveal), "reveal route")
  assert.ok(paths.includes(ROUTES.open), "open route")
  assert.ok(paths.includes(ROUTES.copy), "copy route")
  assert.ok(paths.includes(ROUTES.pickFolder), "pick-folder route")
  assert.ok(paths.includes(ROUTES.saveDir), "save-dir route")
})

test("key-status and save-key replace the key of an existing profile", async () => {
  const vault = new Map([["IMAGE_STUDIO_KEY_DASH", "sk-old-00000000"]])
  const { ctx, registered } = fakeContext()
  ctx.credentials.describe = async (ref) => ({ configured: vault.has(ref), writable: true })
  ctx.credentials.resolve = async (ref) => (vault.has(ref) ? { value: vault.get(ref) } : undefined)
  ctx.credentials.set = async (ref, value) => { vault.set(ref, value) }
  ctx.credentials.unset = async (ref) => { vault.delete(ref) }
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dash.test" }] }))

  const route = (path) => registered.routes.find((entry) => entry.path === path)
  const before = await callRoute(route(ROUTES.keyStatus), { providerId: "dash" })
  assert.equal(before.status, 200)
  assert.equal(before.json.ok, true)
  assert.equal(before.json.providers[0].configured, true)

  const saved = await callRoute(route(ROUTES.saveKey), { providerId: "dash", value: "sk-live-12345678" })
  assert.equal(saved.json.ok, true)
  const after = await callRoute(route(ROUTES.keyStatus), { providerId: "dash" })
  assert.equal(after.json.providers[0].configured, true)
  assert.equal(vault.get("DSH_Q_IMAGE_STUDIO_KEY_DASH"), "sk-live-12345678")
  assert.equal(vault.has("IMAGE_STUDIO_KEY_DASH"), false)
})

test("list-gallery route returns saved images and rejects GET", async () => {
  const cwd = await tempCwd(test)
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch()
  try {
    const { ctx, registered } = fakeContext()
    apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://gallery.test" }], saveDir: path.join(cwd, "images") }))
    const tool = registered.tools[0]
    await tool.execute({ prompt: "Кот" }, { agent: { session: { header: { cwd } } } })
    const route = registered.routes.find((entry) => entry.path === ROUTES.listGallery)
    const gallery = await callRoute(route, { cwd })
    assert.equal(gallery.json.ok, true)
    assert.equal(gallery.json.entries.length, 1)
    assert.match(gallery.json.entries[0].file, /images\/\d{8}-\d{6}-kot\.png$/)
    const notAllowed = await callRoute(route, {}, "GET")
    assert.equal(notAllowed.status, 405)
  } finally {
    globalThis.fetch = original
  }
})

test("image_generate passes {path} and {attachmentId} references through the argument schema", async (t) => {
  const cwd = await tempCwd(t)
  await writeFile(path.join(cwd, "ref.png"), PNG)
  const bodies = []
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch(bodies)
  t.after(() => { globalThis.fetch = original })

  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dashscope.test/compatible-mode/v1", model: "qwen-image-3.0" }], saveDir: path.join(cwd, "images") }))
  const tool = registered.tools[0]

  // On the old schema additionalProperties:false rejected these fields before execute ran.
  assert.deepEqual(validateValue(tool.parameters, { prompt: "x", references: [{ path: "ref.png" }] }), [])
  assert.deepEqual(validateValue(tool.parameters, { prompt: "x", references: [{ attachmentId: "sha256:deadbeef" }] }), [])
  assert.deepEqual(validateValue(tool.parameters, { prompt: "x", references: [{ url: "https://x/y.png" }] }), [
    "references[0].url: unknown field",
  ])

  const fromPath = await tool.execute(
    { prompt: "кот", references: [{ path: "ref.png" }] },
    { agent: { session: { header: { cwd } } } },
  )
  assert.equal(fromPath.ok, true)
  assert.match(bodies[0].input.messages[0].content[0].image, /^data:image\/png;base64,/)
  assert.deepEqual(bodies[0].input.messages[0].content[1], { text: "кот" })
  assert.equal("size" in bodies[0].parameters, false)

  const fromAttachment = await tool.execute(
    { prompt: "пёс", references: [{ attachmentId: "sha256:deadbeef" }] },
    { agent: { session: { header: { cwd } } } },
  )
  assert.equal(fromAttachment.ok, true)
  assert.match(bodies[1].input.messages[0].content[0].image, /^data:image\/png;base64,/)
})

test("transparent generation wraps the prompt, forces prompt_extend off and keeps the fixed seed", async (t) => {
  const cwd = await tempCwd(t)
  const bodies = []
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch(bodies)
  t.after(() => { globalThis.fetch = original })

  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dashscope.test", model: "qwen-image-3.0" }], saveDir: path.join(cwd, "images") }))
  const tool = registered.tools[0]
  const result = await tool.execute(
    { prompt: "Кот", transparent: true, promptExtend: true, seed: 42 },
    { agent: { session: { header: { cwd } } } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.seed, 42)
  assert.equal(result.transparent, true)
  assert.equal(result.promptExtend, false)
  assert.equal(bodies[0].parameters.seed, 42)
  assert.equal(bodies[0].parameters.prompt_extend, false)
  assert.equal(bodies[0].parameters.n, 1)
  assert.deepEqual(bodies[0].input.messages[0].content[0], {
    text: "This is an RGBA image with transparency. Кот. The image has alpha channel and the background is transparent.",
  })
  const index = JSON.parse(await readFile(path.join(cwd, "images", "index.json"), "utf8"))
  assert.equal(index[0].seed, 42)
  assert.equal(index[0].promptExtend, false)
  assert.equal(index[0].transparent, true)
  assert.equal(index[0].prompt, "Кот")
  assert.match(index[0].finalPrompt, /^This is an RGBA image with transparency\. Кот\./)
})

test("random seed is generated, sent and stored; the same seed repeats the request", async (t) => {
  const cwd = await tempCwd(t)
  const bodies = []
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch(bodies)
  t.after(() => { globalThis.fetch = original })

  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dashscope.test", model: "qwen-image-3.0" }], saveDir: path.join(cwd, "images") }))
  const tool = registered.tools[0]
  const first = await tool.execute(
    { prompt: "Кот", promptExtend: false },
    { agent: { session: { header: { cwd } } } },
  )
  assert.equal(first.ok, true)
  assert.equal(Number.isInteger(first.seed), true)
  assert.equal(first.seed >= 0 && first.seed <= 2147483647, true)
  assert.equal(bodies[0].parameters.seed, first.seed)
  assert.equal(bodies[0].parameters.prompt_extend, false)

  let index = JSON.parse(await readFile(path.join(cwd, "images", "index.json"), "utf8"))
  assert.equal(index[0].seed, first.seed)
  assert.equal(index[0].requestJson.parameters.seed, first.seed)

  const second = await tool.execute(
    { prompt: "Кот", promptExtend: false, seed: first.seed },
    { agent: { session: { header: { cwd } } } },
  )
  assert.equal(second.seed, first.seed)
  assert.deepEqual(bodies[1], bodies[0])

  index = JSON.parse(await readFile(path.join(cwd, "images", "index.json"), "utf8"))
  assert.equal(index.length, 2)
  assert.equal(index[1].seed, first.seed)
})

test("admission rejections keep cache-control: no-store", async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dash.test" }] }))
  ctx.connection.requestRejection = () => 403

  const route = registered.routes.find((entry) => entry.path === ROUTES.keyStatus)
  const forbidden = await callRoute(route, {})
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.headers["cache-control"], "private, no-store")
  assert.equal(forbidden.headers["x-content-type-options"], "nosniff")
})

test("save-dir route confirms migration and rejects a non-empty folder", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dsh-q-image-studio-savedir-"))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const oldDir = path.join(cwd, "old")
  const newDir = path.join(cwd, "new")
  const busyDir = path.join(cwd, "busy")
  await mkdir(oldDir, { recursive: true })
  await writeFile(path.join(oldDir, "one.png"), Buffer.from([137, 80, 78, 71]))
  await mkdir(busyDir, { recursive: true })
  await writeFile(path.join(busyDir, "keep.txt"), "keep")

  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dash.test" }], saveDir: oldDir }))
  const route = registered.routes.find((entry) => entry.path === ROUTES.saveDir)

  const first = await callRoute(route, { saveDir: newDir })
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, false)
  assert.equal(first.json.code, "confirm-migration")
  assert.equal(first.json.count, 1)

  const confirmed = await callRoute(route, { saveDir: newDir, migrate: true })
  assert.equal(confirmed.json.ok, true)
  assert.deepEqual(await readdir(newDir), ["one.png"])

  const busy = await callRoute(route, { saveDir: busyDir })
  assert.equal(busy.json.ok, false)
  assert.match(busy.json.error, /папка не пуста, выберите другую/)
})


test("test-connection verifies with GET only and returns IG models", async (t) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET" })
    if (String(url).includes("/api/v1/models")) {
      return jsonResponse({
        data: [
          { model: "qwen-image-3.0", capabilities: ["IG"] },
          { model: "qwen-mt-image-1.0", capabilities: ["IG"] },
        ],
      })
    }
    return jsonResponse({}, 404)
  }
  t.after(() => { globalThis.fetch = original })
  const { ctx, registered } = fakeContext()
  const config = Config({
    providers: [
      { id: "dash", label: "Dash", baseURL: "https://dashscope-intl.aliyuncs.com", model: "qwen-image-3.0" },
    ],
  })
  apply(ctx, config)
  const route = registered.routes.find((item) => item.path === ROUTES.testConnection)
  const out = await callRoute(route, { providerId: "dash" })
  assert.equal(out.status, 200)
  const body = out.json
  assert.equal(body.ok, true)
  assert.deepEqual(body.models, ["qwen-image-3.0"])
  assert.match(body.verifiedAt, /^\d{4}-/)
  assert.equal(calls.every((call) => call.method === "GET"), true, "connection check never generates")
})

test("the UI generate route forwards seed, transparent and promptExtend", async (t) => {
  const cwd = await tempCwd(t)
  const bodies = []
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch(bodies)
  t.after(() => { globalThis.fetch = original })

  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ providers: [{ id: "dash", label: "Dash", baseURL: "https://dashscope.test", model: "qwen-image-3.0" }], saveDir: path.join(cwd, "images") }))
  const route = registered.routes.find((entry) => entry.path === ROUTES.generate)
  const out = await callRoute(route, {
    providerId: "dash",
    prompt: "Кот",
    size: "1024x576",
    seed: 7,
    transparent: false,
    promptExtend: false,
    cwd,
  })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.seed, 7)
  assert.equal(out.json.promptExtend, false)
  assert.equal(bodies[0].parameters.seed, 7)
  assert.equal(bodies[0].parameters.prompt_extend, false)
  assert.equal(bodies[0].parameters.size, "1024*576")
})
