import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

test("GPU ownership survives signed large origins, all batches, reversal and context replacement", {
  timeout: 60000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const base = process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:6819/mineslop/";
  await page.route("**/test/distant-mask-gpu.html", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Mask GPU regression</title>" }));
  await page.goto(new URL("test/distant-mask-gpu.html", base).href);
  const result = await page.evaluate(async base =>
    (await import(new URL("test/distant-detail-mask-gpu-probe.js", base).href)).runDistantMaskGPU(), base);
  writeFileSync(process.env.MASK_GPU_REPORT ?? "/tmp/distant-mask-gpu.json", JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  const failures = result.results.filter(row =>
    !row.cpuOwned || row.unowned !== 1024 || row.otherBatch !== 1024 ||
    row.owned !== 0 || row.moved !== 0 || row.reversed !== 0);
  assert.deepEqual(failures, [], "paired drawn/discarded pixels must agree with CPU ownership");
  assert.equal(result.results.length, 96);
  assert.equal(result.replacementOwned, 0);
  assert.equal(result.replacementUnowned, 1024);
});
