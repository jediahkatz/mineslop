import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";
import { installWebGLCallTrace } from "./webgl-call-trace.js";

const files = [
  "src/experimental-tail-sealing.js", "src/section-pages.js", "src/regional-section-pages.js",
  "src/section-renderer.js", "src/renderer.js", "src/context-resources.js",
  "src/geometry-color-palette.js", "src/geometry-palette-material.js",
  "test/shape-fixture.js", "test/experimental-tail-sealing-gpu-probe.js",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const hashes = () => Object.fromEntries(files.map((path) =>
  [path, hash(readFileSync(new URL(`../${path}`, import.meta.url)))]));

test("actual experimental sealed pages: exact GPU pixels, reuse, context recovery and dense retirement", {
  timeout: 180000,
}, async () => {
  const before = hashes(), errors = [], warnings = [];
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    page.setDefaultTimeout(15000);
    await page.addInitScript(installWebGLCallTrace);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
    await page.route("**/test/experimental-tail-sealing-gpu.html", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Experimental tail GPU control</title>" }));
    const base = process.env.TAIL_SEALING_GPU_URL ?? "http://127.0.0.1:6795/mineslop/";
    await page.goto(new URL("test/experimental-tail-sealing-gpu.html", base).href, { timeout: 15000 });
    const served = await page.evaluate(async ({ base, files }) =>
      Object.fromEntries(await Promise.all(files.map(async (path) =>
        [path, (await import(new URL(`${path}?raw`, base).href)).default]))), { base, files });
    assert.deepEqual(Object.fromEntries(Object.entries(served).map(([path, source]) => [path, hash(source)])), before);
    const result = await page.evaluate(async (base) =>
      (await import(new URL("test/experimental-tail-sealing-gpu-probe.js", base).href)).runExperimentalTailGPUProbe(), base);
    assert.equal(result.passed, true);
    assert.deepEqual(errors, []);
    assert.deepEqual(hashes(), before, "sources changed during GPU qualification");
    assert.equal(result.candidate.sealedOwners, 1);
    assert.equal(result.candidate.reuseObserved, true);
    assert.equal(result.baseline.colorCalls, 1);
    assert.equal(result.candidate.colorCalls, 2);
    assert.ok(result.pairs.every((pair) => pair.differingBytes === 0));
    assert.deepEqual(result.glErrors, []);
    const image = result.candidateImage;
    delete result.candidateImage;
    const proof = { browser: browser.version(), hashes: before, errors, warnings, ...result };
    if (process.env.TAIL_SEALING_GPU_REPORT) {
      writeFileSync(process.env.TAIL_SEALING_GPU_REPORT, JSON.stringify(proof, null, 2));
      assert.ok(image.startsWith("data:image/png;base64,"));
      writeFileSync(`${process.env.TAIL_SEALING_GPU_REPORT}.png`, Buffer.from(image.split(",")[1], "base64"));
    }
    console.log(JSON.stringify({
      passed: result.passed, baseline: result.baseline, candidate: result.candidate,
      pairs: result.pairs, visibleGeometryDifference: result.visibleGeometryDifference,
      context: result.context, edit: result.edit, afterDisposal: result.afterDisposal, elapsedMs: result.elapsedMs,
    }, null, 2));
  } catch (error) {
    if (process.env.TAIL_SEALING_GPU_REPORT)
      writeFileSync(`${process.env.TAIL_SEALING_GPU_REPORT}.failure.json`, JSON.stringify({
        hashes: before, errors, warnings, error: String(error),
        progress: page && !page.isClosed() ? await page.evaluate(() => globalThis.experimentalTailGPUProgress).catch(() => null) : null,
      }, null, 2));
    throw error;
  } finally {
    await browser.close();
  }
});
