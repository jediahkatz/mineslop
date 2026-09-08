import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

for (const originX of [0, -32768, 32768, -29999744, 29999744])
test(`actual fog/mask GPU coarse, native, refinement and reversal coverage at ${originX}`, { timeout: 90000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  const base = process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:6819/mineslop/";
  await page.route("**/test/fog-transition-gpu.html", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fog transition GPU gate</title>" }));
  await page.goto(new URL("test/fog-transition-gpu.html", base).href);
  let result;
  try {
    result = await page.evaluate(async ({ base, originX }) =>
      (await import(new URL("test/fog-transition-gpu-probe.js", base).href)).runFogTransitionGPU({ originX }), { base, originX });
    assert.equal(result.passed, true);
    assert.deepEqual(errors, []);
    assert.ok(result.phases.every(p => p.holes === 0 && p.overlap === 0));
    console.log(JSON.stringify(result));
  } finally {
    result ??= await page.evaluate(() => globalThis.fogTransitionProgress).catch(() => null);
    writeFileSync(process.env.FOG_GPU_REPORT ?? `/tmp/fog-transition-gpu${originX ? `-${originX}` : ""}.json`,
      JSON.stringify({ browser: browser.version(), errors, result }, null, 2));
  }
});
