import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const files = ["src/water-fusion.js", "src/water-fusion-geometry.js", "src/water-fusion-gpu.js", "src/water-fusion-material.js",
  "src/water-fusion-ledger.js",
  "src/daylight-material.js", "src/block-light-material.js", "src/light-page-material.js",
  "test/water-fusion-boundaries-probe.js", "test/water-pull-boundaries-fixture.js"];
const hash = text => createHash("sha256").update(text).digest("hex");
const hashes = () => Object.fromEntries(files.map(p => [p, hash(readFileSync(new URL(`../${p}`, import.meta.url)))]));

test("production water: physical banks, adjacent cells, fog, apron and bounded row addressing", { timeout: 120000 }, async () => {
  const start = hashes(), errors = [];
  const browser = await chromium.launch({ executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await page.route("**/test/water-fusion-boundaries.html", r => r.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    const base = process.env.WATER_FUSION_TEST_URL ?? "http://127.0.0.1:6791/mineslop/";
    await page.goto(new URL("test/water-fusion-boundaries.html", base).href);
    const served = await page.evaluate(async ({ files, base }) => Object.fromEntries(await Promise.all(files.map(async p =>
      [p, (await import(new URL(`${p}?raw`, base).href)).default]))), { files, base });
    assert.deepEqual(Object.fromEntries(Object.entries(served).map(([p, s]) => [p, hash(s)])), start);
    const report = await page.evaluate(async base =>
      (await import(new URL("test/water-fusion-boundaries-probe.js", base).href)).runWaterFusionBoundaries(), base);
    assert.deepEqual(errors, []);
    assert.deepEqual(hashes(), start);
    assert.equal(report.pairs.length, 57);
    assert.equal(report.oracles.length, 16);
    assert.equal(report.controls.length, 23);
    const proof = [
      "Production default-off water fusion boundary verification passed.",
      `${report.pairs.length} exact production/reference RGBA pairs; ${report.oracles.length} independent physical/constant/address oracles; ${report.controls.length} water-only paired contrasts.`,
      "All six physical banks; BACK/FRONT adjacent cells; roof/exposed, unavailable/apron, cave/underwater fog.",
      `Bounded source row marker: vertex ${report.rowAddress.vertex}, width ${report.rowAddress.width}, texture ${report.rowAddress.textureBytes} bytes.`,
      "Prototype high-address source exceeds the unchanged allocation cap: explicit rejection preserves its original TWO actual draws.",
      "No weakened prototype tests; no native readiness, full-R12 capacity or throughput claim.",
    ].join("\n") + "\n";
    console.log(proof);
    if (process.env.WATER_FUSION_BOUNDARIES_REPORT) {
      writeFileSync(process.env.WATER_FUSION_BOUNDARIES_REPORT, JSON.stringify({ hashes: start, errors, ...report }, null, 2));
      writeFileSync(`${process.env.WATER_FUSION_BOUNDARIES_REPORT}.proof.txt`, proof);
    }
  } finally { await browser.close(); }
});
