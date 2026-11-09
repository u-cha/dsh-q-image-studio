/**
 * Stand-in OpenAI-compatible provider for the end-to-end check (plan Task 7).
 *
 * Serves:
 *   GET  /v1/models               -> a model list (style detection)
 *   POST /v1/images/generations   -> {"data":[{"url": "<self>/files/1x1.png"}]}
 *   GET  /files/1x1.png           -> a real 1x1 PNG
 *
 * Failure modes for negative checks (env FAKE_PROVIDER_MODE or ?mode=):
 *   ok      (default) answer normally
 *   429     always HTTP 429
 *   slow    wait FAKE_PROVIDER_DELAY_MS (default 5000) before answering
 *   401     reject the key
 *
 * Usage: node test/fake-provider.js [port]
 * Prints one line `fake-provider listening on http://127.0.0.1:<port>`.
 */

import { createServer } from "node:http"

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
)

const MODELS = ["qwen-image-3.0", "qwen-image-2.1", "fake-image-1"]

export function startFakeProvider({ port = 0, mode = process.env.FAKE_PROVIDER_MODE ?? "ok", delayMs = Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 5000) } = {}) {
  const state = { mode, delayMs, requests: [], port: 0 }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const effective = url.searchParams.get("mode") ?? state.mode
    state.requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? "", body: undefined })

    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" })
      res.end(body)
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      if (effective === "401") return send(401, JSON.stringify({ error: { message: "invalid api key" } }))
      return send(200, JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model" })) }))
    }

    if (url.pathname === "/v1/images/generations" && req.method === "POST") {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const entry = state.requests[state.requests.length - 1]
      try {
        entry.body = JSON.parse(raw)
      } catch {
        entry.body = raw
      }
      if (effective === "401") return send(401, JSON.stringify({ error: { message: "invalid api key" } }))
      if (effective === "429") return send(429, JSON.stringify({ error: { message: "rate limit" } }))
      if (effective === "slow") await new Promise((resolve) => setTimeout(resolve, state.delayMs))
      const base = `http://127.0.0.1:${state.port}`
      return send(200, JSON.stringify({ created: Date.now(), data: [{ url: `${base}/files/1x1.png` }] }))
    }

    if (url.pathname === "/files/1x1.png" && req.method === "GET") {
      return send(200, PNG_1X1, "image/png")
    }

    if (url.pathname === "/__requests" && req.method === "GET") {
      return send(200, JSON.stringify(state.requests))
    }

    return send(404, JSON.stringify({ error: { message: "not found" } }))
  })

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      state.port = server.address().port
      resolve({ server, state, port: state.port })
    })
  })
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const port = Number(process.argv[2] ?? 0)
  startFakeProvider({ port }).then(({ port: actual }) => {
    console.log(`fake-provider listening on http://127.0.0.1:${actual}`)
  })
}
