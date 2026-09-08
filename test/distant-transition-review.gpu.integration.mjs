// Run against an existing Vite server:
// VOXELCRAFT_TEST_URL=http://127.0.0.1:5173/mineslop/ node --test test/distant-transition-review.gpu.integration.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
const files = [
  "src/distant-terrain.js", "src/distant-grid.js", "src/distant-terraces.js",
  "src/distant-detail-mask.js", "src/distant-surface-material.js",
  "test/distant-transition-review-fixtures.js", "test/distant-transition-review.browser.js",
];
const hash = (source) => createHash("sha256").update(source).digest("hex");
const hashes = () => Object.fromEntries(files.map((path) =>
  [path, hash(readFileSync(new URL(`../${path}`, import.meta.url)))]));

async function probe(t, name) {
  const before = hashes(), errors = [];
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
    // A routed blank document avoids adding an HTML fixture or launching the
    // game/save layer; geometry and shaders are still the real served modules.
    const url = new URL("test/distant-transition-review.html", base).href;
    await page.route(url, (route) => route.fulfill({
      contentType: "text/html", body: "<!doctype html><title>Distant transition review</title>",
    }));
    await page.goto(url);
    const served = await page.evaluate(async ({ base, files }) =>
      Object.fromEntries(await Promise.all(files.map(async (path) =>
        [path, (await import(new URL(`${path}?raw`, base).href)).default]))), { base: base.href, files });
    assert.deepEqual(Object.fromEntries(Object.entries(served).map(([path, source]) => [path, hash(source)])),
      before, "GPU fixture must run this worktree's source, not stale preview assets");
    const result = await page.evaluate(async ({ base, name }) =>
      (await import(new URL("test/distant-transition-review.browser.js", base).href))[name](),
    { base: base.href, name });
    assert.deepEqual(errors, [], "shader/page errors cannot masquerade as missing geometry");
    assert.deepEqual(hashes(), before, "source changed during review qualification; rerun on a stable candidate");
    t.diagnostic(JSON.stringify({ browser: browser.version(), result }));
    return result;
  } finally { await browser.close(); }
}

const isBackground = (pixel) => pixel.join(",") === "255,0,255,255";

test("review GPU: coarse/native boundary has real visible sealing, not only coverage counters", {
  timeout: 120000,
}, async (t) => {
  const rows = await probe(t, "runReviewBoundaryGPU");
  for (const row of rows) assert.equal(row.glError, 0);
  const coarse = rows.find((row) => row.mode === "coarse");
  const refined = rows.find((row) => row.mode === "refined-control");
  const sealed = rows.find((row) => row.mode === "sealed-control");
  await t.test("independent fine-height and explicit-seal controls actually render the witness", () => {
    assert.equal(refined.eastTop, refined.nativeWestTop);
    for (const row of [refined, sealed]) {
      assert.ok(row.colored > 3000, JSON.stringify(row));
      assert.equal(isBackground(row.center), false, JSON.stringify(row));
    }
  });
  await t.test("first coarse surface does not expose background through the native edge", () => {
    assert.equal(coarse.complete, true, "exercise the claimed-complete surface");
    assert.ok(coarse.fog >= 32, "the witness is inside the claimed view");
    assert.equal(isBackground(coarse.center), false,
      `unsealed native Y${coarse.nativeWestTop}/LOD Y${coarse.eastTop} edge: ${JSON.stringify(coarse)}`);
    assert.ok(coarse.colored > 0, "no passing all-background comparison");
  });
});

test("review GPU: signed detail-mask ownership matches exact visible/unowned controls", {
  timeout: 120000,
}, async (t) => {
  const rows = await probe(t, "runReviewMaskGPU");
  for (const row of rows) {
    await t.test(`origin ${row.x}: published +X owner suppresses all 1024 face pixels`, () => {
      assert.equal(row.unowned.glError, 0);
      assert.equal(row.owned.glError, 0);
      assert.equal(row.unowned.green, 1024, "positive visibility control at this exact origin");
      assert.equal(row.unowned.background, 0);
      assert.equal(row.cpuOwns, true);
      assert.equal(row.owned.green, 0, "GPU inward owner must agree with the double-precision oracle");
      assert.equal(row.owned.background, 1024);
    });
  }
});
