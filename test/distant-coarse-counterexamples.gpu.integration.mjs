import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

test("coarse publication requires reconciled native edges and valid interiors", {
  timeout: 60000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const base = process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:6819/mineslop/";
  await page.route("**/test/coarse-counterexamples.html", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Coarse coverage counterexamples</title>" }));
  await page.goto(new URL("test/coarse-counterexamples.html", base).href);
  const result = await page.evaluate(async base =>
    (await import(new URL("test/distant-coarse-counterexamples-gpu-probe.js", base).href)).runCoarseCounterexamplesGPU(), base);
  writeFileSync(process.env.COARSE_GPU_REPORT ?? "/tmp/coarse-counterexamples-gpu.json",
    JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.ok(result.coarse.nativeMeshes > 0, "real native mesher must participate");
  assert.equal(result.hiddenDrawn, 0, "background must not impersonate terrain");
  assert.ok(result.refined.drawn > 3500, "paired fine reference must visibly cover the target");
  await t.test("coarse/native mismatch cannot expose an underground background horizon", () => {
    assert.ok(result.coarse.drawn > 3500,
      `coarse drew ${result.coarse.drawn}/4096 pixels, refined drew ${result.refined.drawn}`);
  });
  await t.test("an unknown interior cannot be advertised as a complete 192-block surface", () => {
    assert.ok(result.unknownRefined.unknown.includes("0,0"), "fine reference must find the invalid interior");
    assert.equal(result.unknownRefined.horizon, 0);
    assert.equal(result.unknownCoarse.complete, false);
    assert.equal(result.unknownCoarse.horizon, 0);
  });
});
