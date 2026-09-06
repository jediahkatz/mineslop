import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const files = ["src/section-water-fusion.js", "src/section-water-resources.js", "src/section-water-visibility.js",
  "src/section-water-attachments.js", "src/section-water-reclaim.js", "src/section-renderer.js",
  "src/regional-section-pages.js", "src/section-pages.js", "src/renderer.js", "src/water-fusion.js",
  "src/water-fusion-ledger.js", "src/water-fusion-gpu.js", "src/water-fusion-geometry.js",
  "src/water-fusion-material.js", "test/shape-fixture.js", "test/water-fusion-gl-trace.js",
  "test/renderer-water-pressure-gpu-probe.js"];
const hash = value => createHash("sha256").update(value).digest("hex");
const hashes = () => Object.fromEntries(files.map(p => [p, hash(readFileSync(new URL(`../${p}`, import.meta.url)))]));

for (const control of ["reclaim", "fallback", "visibility"])
test(`bounded host GPU pressure: ${control}`, { timeout: 240000 }, async () => {
  const before = hashes(), errors = [], warnings = [];
  const reportPath = process.env.WATER_PRESSURE_GPU_REPORT && `${process.env.WATER_PRESSURE_GPU_REPORT}.${control}`;
  const browser = await chromium.launch({ executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => {
      if (m.type() === "error") errors.push(m.text());
      if (m.type() === "warning") warnings.push(m.text());
    });
    await page.route("**/test/water-pressure.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    const base = process.env.WATER_FUSION_TEST_URL ?? "http://127.0.0.1:6791/mineslop/";
    await page.goto(new URL("test/water-pressure.html", base).href);
    const served = await page.evaluate(async ({ files, base }) => Object.fromEntries(await Promise.all(files.map(async p =>
      [p, (await import(new URL(`${p}?raw`, base).href)).default]))), { files, base });
    assert.deepEqual(Object.fromEntries(Object.entries(served).map(([p, text]) => [p, hash(text)])), before);
    let report;
    try {
      report = await page.evaluate(async ({ base, control }) =>
        (await import(new URL("test/renderer-water-pressure-gpu-probe.js", base).href)).runWaterPressureProbe(control),
      { base, control });
    } catch (error) {
      if (reportPath)
        writeFileSync(`${reportPath}.failure.json`, JSON.stringify({
          hashes: before, endHashes: hashes(), control,
          errors, warnings, error: String(error), progress: await page.evaluate(() => globalThis.waterPressureProgress),
        }, null, 2));
      throw error;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(hashes(), before);
    if (control === "visibility") {
      assert.equal(report.visibility.length, 10);
      assert.equal(report.visibility.filter(v => v.allowed && v.again && v.differingBytes === 0).length, 8);
    }
    const proof = [
      `Bounded authored host ${control} control passes with actual WebGL.`,
      `${report.frames.length} frames fit shared operation/copy caps; actual water allocations/uploads fit GPU-specific debits.`,
      ...(report.reclaim ? [`Automatic hidden retention reclaim: cap ${report.reclaim.cap}, peak actual owned backing ${report.reclaim.peakActual} bytes; ${report.reclaim.deletedActualBuffers} actual buffers retired; no manual eviction.`] : []),
      ...(report.fallback ? [`Pending fallback: peak ${report.fallback.peakReserved}/2 reserved calls, actual original-path calls ${report.fallback.calls}; B remains detached.`] : []),
      ...(report.visibility.length ? [
        "Eight excluded-source controls render identical opaque pixels twice with exhausted quotas and zero GL allocation/uploads.",
        "Both visible-unready controls block, including canonical nonempty / physical zero-range recovery.",
      ] : []),
      "Default OFF; no raised caps, native full-R12 capacity, throughput or hardware performance claim.",
    ].join("\n") + "\n";
    if (reportPath) {
      writeFileSync(`${reportPath}.json`, JSON.stringify({ hashes: before, errors, warnings, ...report }, null, 2));
      writeFileSync(`${reportPath}.proof.txt`, proof);
    }
    console.log(proof);
  } finally { await browser.close(); }
});
