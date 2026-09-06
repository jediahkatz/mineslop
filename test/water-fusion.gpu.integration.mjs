import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const files = ["src/water-fusion.js", "src/water-fusion-geometry.js", "src/water-fusion-gpu.js",
  "src/water-fusion-ledger.js",
  "src/water-fusion-material.js", "src/context-resources.js", "test/water-fusion-gpu-probe.js",
  "test/water-fusion-gl-trace.js", "test/water-pull-fixture.js", "test/water-pull-native-fixture.js",
  "test/water-pull-light-fixture.js", "src/daylight-material.js", "src/renderer.js"];
const hash = text => createHash("sha256").update(text).digest("hex");
const hashes = () => Object.fromEntries(files.map(path => [path, hash(readFileSync(new URL(`../${path}`, import.meta.url)))]));

test("bounded production water ownership, exact pixels, native census and context recovery", { timeout: 180000 }, async () => {
  const start = hashes(), errors = [], warnings = [];
  const browser = await chromium.launch({ executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => {
      if (m.type() === "error") errors.push(m.text());
      if (m.type() === "warning") warnings.push(m.text());
    });
    await page.route("**/test/water-fusion-proof.html", r => r.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    const base = process.env.WATER_FUSION_TEST_URL ?? "http://127.0.0.1:6791/mineslop/";
    await page.goto(new URL("test/water-fusion-proof.html", base).href);
    const served = await page.evaluate(async ({ files, base }) => Object.fromEntries(await Promise.all(files.map(async path =>
      [path, (await import(new URL(`${path}?raw`, base).href)).default]))), { files, base });
    assert.deepEqual(Object.fromEntries(Object.entries(served).map(([p, s]) => [p, hash(s)])), start);
    let result;
    try {
      result = await page.evaluate(async base => (await import(new URL("test/water-fusion-gpu-probe.js", base).href)).runWaterFusionProbe(), base);
    } catch (error) {
      if (process.env.WATER_FUSION_REPORT) writeFileSync(`${process.env.WATER_FUSION_REPORT}.failure.json`,
        JSON.stringify({ errors, warnings, message: String(error), progress: await page.evaluate(() => globalThis.waterFusionProgress) }, null, 2));
      throw error;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(hashes(), start, "frozen source revisions");
    for (const p of result.programs) {
      const sampler = p.samplers.find(s => s.name === "uWaterFusion");
      if (!sampler) continue;
      assert.ok(p.attributes.every(a => a.location === -1), "no active conventional attribute storage");
      assert.ok(p.samplers.length <= 16);
    }
    const native = result.fixtures.find(f => f.name === "native");
    assert.equal(native.native.sources, 33);
    assert.equal(native.resources.retainedInputGpuBytes, 0);
    const census = result.pairs.find(p => p.label === "allocation-no-object-culling");
    assert.equal(census.referenceWaterCalls, 66);
    assert.equal(census.fusedWaterCalls, 33);
    const proof = [
      "Production water core, default OFF: bounded isolated verification passed.",
      `${result.pairs.length} paired RGBA comparisons: zero differing bytes; exact expanded object order.`,
      `${result.recovery.length} actual WebGL loss/restoration cases: canonical array identity and exact pixels.`,
      "Actual failed texSubImage2D prevents publication; retry succeeds.",
      "Every traced GL allocation and upload separately fits its GPU-specific debit; individual work <= 1 MiB.",
      `Native 16-column census: water ${census.referenceWaterCalls} -> ${census.fusedWaterCalls} actual GL calls.`,
      `Native canonical CPU: ${native.resources.allocatedCpuBytes}; owned GPU: ${native.resources.allocatedOwnedGpuBytes} bytes.`,
      `Native RGBA32F textures: ${native.measuredTexture}; original single-stream index storage: ${native.measuredIndex} bytes.`,
      "Quality-key refresh, daylight rebinding, clipping fallback, raycast CPU tests and explicit-owner context collector exercised.",
      "No Game/UI activation, whole-R12 fit/readiness or throughput claim. Extra rasterization/shading remains a risk.",
    ].join("\n") + "\n";
    if (process.env.WATER_FUSION_REPORT) {
      writeFileSync(process.env.WATER_FUSION_REPORT, JSON.stringify({ hashes: start, errors, ...result }, null, 2));
      writeFileSync(`${process.env.WATER_FUSION_REPORT}.proof.txt`, proof);
    }
    console.log(proof);
  } finally { await browser.close(); }
});
