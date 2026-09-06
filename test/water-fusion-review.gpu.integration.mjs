import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const files = ["src/water-fusion.js", "src/water-fusion-geometry.js", "src/water-fusion-gpu.js",
  "src/water-fusion-material.js", "src/water-fusion-ledger.js", "src/renderer.js",
  "test/water-fusion-review-gpu-probe.js", "test/water-pull-fixture.js",
  "test/water-fusion-gl-trace.js", "test/water-pull-gl-trace.js"];
const hash = value => createHash("sha256").update(value).digest("hex");
const hashes = () => Object.fromEntries(files.map(path => [path, hash(readFileSync(new URL(`../${path}`, import.meta.url)))]));

test("water fusion review GPU: mixed material, constant blend, mirrored visibility and ownership transitions", { timeout: 120000 }, async () => {
  const start = hashes(), errors = [];
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("**/test/water-fusion-review.html", route =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    const base = process.env.WATER_FUSION_TEST_URL ?? "http://127.0.0.1:6791/mineslop/";
    await page.goto(new URL("test/water-fusion-review.html", base).href);
    const served = await page.evaluate(async ({ files, base }) => Object.fromEntries(await Promise.all(
      files.map(async path => [path, (await import(new URL(`${path}?raw`, base).href)).default]))), { files, base });
    assert.deepEqual(Object.fromEntries(Object.entries(served).map(([path, text]) => [path, hash(text)])), start);
    let result;
    try {
      result = await page.evaluate(async base =>
        (await import(new URL("test/water-fusion-review-gpu-probe.js", base).href)).runWaterFusionReviewGPU(), base);
    } catch (error) {
      if (process.env.WATER_FUSION_REVIEW_REPORT)
        writeFileSync(`${process.env.WATER_FUSION_REVIEW_REPORT}.failure.json`, JSON.stringify({
          errors, message: String(error), progress: await page.evaluate(() => globalThis.waterFusionReviewProgress),
        }, null, 2));
      throw error;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(hashes(), start, "stable source revisions, including incremental ledger");
    assert.ok(result.frames.every(frame => frame.stableClone));
    assert.ok(result.gpuDebits.some(debit => debit.actual > 0));
    assert.ok(result.pairs.every(pair => pair.differingBytes === 0 && pair.ownedVisibleBytes > 0));
    const proof = [
      "Default-OFF water fusion review GPU checks passed.",
      `${result.pairs.length} paired RGBA comparisons: zero differing bytes; owned-source visibility and exact expanded order.`,
      "Four real mixed conventional/fused frames retain the same clone and publication count.",
      "Explicit version-only refresh remains active; constant blend color/alpha mutation changes visible pixels.",
      "Mirrored owned source contributes pixels; live-shadow fallback supersedes pending replacement.",
      "Renderer rebind retains canonical arrays/decoder and exact pixels.",
      "Actual GL allocation/upload bytes fit GPU-only debits, independently of CPU copy/allocation charges.",
      "GL/shader errors: 0; served/start/end hashes match, including the new ledger.",
      "No whole-R12 readiness, full native admission, throughput or hardware FPS claim.",
    ].join("\n") + "\n";
    if (process.env.WATER_FUSION_REVIEW_REPORT) {
      writeFileSync(process.env.WATER_FUSION_REVIEW_REPORT, JSON.stringify({ hashes: start, errors, ...result }, null, 2));
      writeFileSync(`${process.env.WATER_FUSION_REVIEW_REPORT}.proof.txt`, proof);
    }
    console.log(proof);
  } finally { await browser.close(); }
});
