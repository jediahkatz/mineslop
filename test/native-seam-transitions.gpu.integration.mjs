import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

test("GPU native boundary batch ownership, signed movement, replacement and context recovery", { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
    if (message.type() === "warning") t.diagnostic(message.text());
  });
  const base = process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:6819/mineslop/";
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await page.route("**/test/seam-gpu.html", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Native boundary transitions</title>" }));
  await page.goto(new URL("test/seam-gpu.html", base).href);
  let rows;
  try {
    rows = await page.evaluate(async base =>
      (await import(new URL("test/native-seam-transitions-gpu-probe.js", base).href)).runNativeSeamTransitionsGPU(), base);
  } catch (error) {
    t.diagnostic(JSON.stringify({ errors, rows: await page.evaluate(() => globalThis.nativeSeamProgress) }));
    throw error;
  }
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 56);
  t.diagnostic(JSON.stringify(rows));
});
