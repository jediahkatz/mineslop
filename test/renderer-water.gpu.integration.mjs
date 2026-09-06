import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const files = ["src/renderer.js", "src/section-renderer.js", "src/section-pages.js", "src/section-water-fusion.js",
  "src/section-water-resources.js", "test/water-fusion-gl-trace.js",
  "src/section-water-visibility.js", "src/section-water-attachments.js", "src/section-water-reclaim.js",
  "src/regional-section-pages.js", "src/context-resources.js", "src/water-fusion.js", "src/water-fusion-geometry.js",
  "src/water-fusion-gpu.js", "src/water-fusion-material.js", "src/water-fusion-ledger.js", "test/renderer-water-gpu-probe.js"];
const hash = text => createHash("sha256").update(text).digest("hex");
const hashes = () => Object.fromEntries(files.map(p => [p, hash(readFileSync(new URL(`../${p}`, import.meta.url)))]));

test("opt-in GameRenderer bounded native water integration", { timeout: 240000 }, async () => {
  const start = hashes(), errors = [], warnings = [];
  const browser = await chromium.launch({ executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 96, height: 96 } });
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => {
      if (m.type() === "error") errors.push(m.text());
      if (m.type() === "warning") warnings.push(m.text());
    });
    await page.route("**/test/renderer-water.html", r => r.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    const base = process.env.WATER_FUSION_TEST_URL ?? "http://127.0.0.1:6791/mineslop/";
    await page.goto(new URL("test/renderer-water.html", base).href);
    const served = await page.evaluate(async ({ files, base }) => Object.fromEntries(await Promise.all(files.map(async p =>
      [p, (await import(new URL(`${p}?raw`, base).href)).default]))), { files, base });
    assert.deepEqual(Object.fromEntries(Object.entries(served).map(([p, s]) => [p, hash(s)])), start);
    let report;
    try {
      report = await page.evaluate(async base => (await import(new URL("test/renderer-water-gpu-probe.js", base).href)).runRendererWaterProbe(), base);
    } catch (error) {
      if (process.env.WATER_HOST_REPORT) writeFileSync(`${process.env.WATER_HOST_REPORT}.failure.json`,
        JSON.stringify({ errors, warnings, error: String(error),
          progress: await page.evaluate(() => globalThis.rendererWaterProgress) }, null, 2));
      throw error;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(hashes(), start);
    const census = report.pairs.find(p => p.label === "all-native-water-census");
    assert.equal(census.referenceWaterCalls, 66);
    assert.equal(census.fusedWaterCalls, 33);
    assert.equal(report.initial.sections, 384);
    assert.equal(report.transferFailures, 2, "only the two deliberately invalid row transfers fail");
    const proof = [
      "Default-OFF GameRenderer water integration: bounded native verification passed.",
      `${report.frames.length} traced scheduler frames: meshing + water share <=16 steps, <=8192 cells, <=1MiB copy/allocation work and one original 8ms deadline.`,
      "Actual water GL allocation and upload work separately fit GPU-specific debits; CPU work cannot pay for either.",
      `Native 16 receivers / 384 sections / 33 water sources: actual water calls ${census.referenceWaterCalls} -> ${census.fusedWaterCalls}.`,
      `${report.pairs.length} exact reference/fused RGBA pairs and exact source draw order.`,
      "Native edits, unload/reload, quality refresh, canonical context recovery and world-swap retirement verified.",
      "Two actual failed row transfers retry; the failed edit transfer retains the old attached water source.",
      `Native canonical CPU ${report.initial.canonical.allocatedCpuBytes}; owned GPU ${report.initial.canonical.allocatedOwnedGpuBytes} bytes.`,
      `Context before/after pixel difference: ${report.contextPixelDifference} bytes (native lighting may still be streaming; no complete-light readiness claim).`,
      "No 625-column run, full-R12 fit/readiness, pacing throughput or hardware FPS claim.",
    ].join("\n") + "\n";
    if (process.env.WATER_HOST_REPORT) {
      writeFileSync(process.env.WATER_HOST_REPORT, JSON.stringify({ hashes: start, errors, warnings, ...report }, null, 2));
      writeFileSync(`${process.env.WATER_HOST_REPORT}.proof.txt`, proof);
    }
    console.log(proof);
  } finally { await browser.close(); }
});
