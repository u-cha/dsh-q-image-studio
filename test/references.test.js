import assert from "node:assert/strict"
import test from "node:test"

import { describeReferences, resolveReferences } from "../lib/references.js"

const cwd = "/work/s"
const ctx = {
  attachments: {
    imageLimits: { maxImageBytes: 10 * 1024 * 1024 },
    readImage: async () => ({ ref: { mediaType: "image/png", attachmentId: "sha256:abc" }, data: new Uint8Array([1, 2, 3]) }),
  },
}

test("resolveReferences rejects paths outside the working directory", async () => {
  await assert.rejects(resolveReferences(ctx, [{ path: "../../etc/passwd" }], cwd), /вне рабочей папки/)
  await assert.rejects(resolveReferences(ctx, [{ path: "/etc/passwd.png" }], cwd), /вне рабочей папки/)
})

test("resolveReferences rejects unsupported file formats", async () => {
  await assert.rejects(resolveReferences(ctx, [{ path: "notes.txt" }], cwd), /формат/)
})

test("resolveReferences rejects URLs and malformed references", async () => {
  await assert.rejects(resolveReferences(ctx, [{ url: "https://x.test/a.png" }], cwd), /URL/)
  await assert.rejects(resolveReferences(ctx, [{}], cwd), /attachmentId или path/)
  await assert.rejects(resolveReferences(ctx, "nope", cwd), /массивом/)
})

test("resolveReferences converts an attachment to a data URL", async () => {
  const urls = await resolveReferences(ctx, [{ attachmentId: "sha256:abc" }], cwd)
  assert.equal(urls.length, 1)
  assert.match(urls[0], /^data:image\/png;base64,/)
})

test("resolveReferences enforces the reference count", async () => {
  const many = Array.from({ length: 11 }, (_, index) => ({ attachmentId: `sha256:${index}` }))
  await assert.rejects(resolveReferences(ctx, many, cwd), /не больше 10/)
})

test("resolveReferences accepts a data URL uploaded by the studio panel", async () => {
  const urls = await resolveReferences(ctx, [{ data: "data:image/png;base64,AAEC" }], cwd)
  assert.deepEqual(urls, ["data:image/png;base64,AAEC"])
  await assert.rejects(resolveReferences(ctx, [{ data: "data:text/plain;base64,AA==" }], cwd), /формат/)
  await assert.rejects(resolveReferences(ctx, [{ data: "data:image/png,plain" }], cwd), /формат/)
})

test("describeReferences is log-safe", () => {
  assert.deepEqual(
    describeReferences([
      { attachmentId: "sha256:a" },
      { path: "a.png" },
      { url: "x" },
      { data: "data:image/png;base64,AAEC" },
    ]),
    ["attachment:sha256:a", "path:a.png", "data:image/png"],
  )
})
