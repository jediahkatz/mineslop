import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statfsSync, writeFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

test("production terrain and late instanced mobs receive reversible player vision on real WebGL", { timeout: 120000 }, async (t) => {
  // Explicitly bounded Chrome allocation, not just a relocated user profile.
  const allocation = process.env.MINESLOP_GPU_ALLOCATION;
  assert.ok(allocation?.startsWith("/dev/shm/"), "Provide a fresh bounded tmpfs allocation");
  const fs = statfsSync(allocation);
  assert.equal(fs.type, 0x01021994, "Browser allocation must be tmpfs");
  assert.ok(fs.blocks * fs.bsize <= 2 * 1024 ** 3, "Browser allocation must be <= 2 GiB");
  assert.ok(fs.bavail * fs.bsize > 512 * 1024 ** 2, "Keep >= 512 MiB allocation headroom");
  const run = mkdtempSync(`${allocation}/vision-`);
  const env = { ...process.env, TMPDIR: `${run}/tmp`, XDG_CONFIG_HOME: `${run}/config`, XDG_CACHE_HOME: `${run}/cache` };
  delete env.CHROME_CONFIG_HOME;
  for (const directory of [env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) mkdirSync(directory);
  const browser = await chromium.launchPersistentContext(`${run}/profile`, {
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, env, viewport: { width: 128, height: 128 },
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle",
      "--use-angle=swiftshader-webgl", "--disable-breakpad", "--disable-crash-reporter",
      `--disk-cache-dir=${run}/cache/chromium`],
  });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const base = process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/";
  await page.goto(new URL("test/daylight-surface-probe.html", base).href, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const { runPlayerVisionProbe } = await import("./player-visual-effects-gpu.js");
    return runPlayerVisionProbe(document.querySelector("#surface-probe"));
  });
  t.diagnostic(JSON.stringify(result));
  if (process.env.MINESLOP_VISION_REPORT)
    writeFileSync(process.env.MINESLOP_VISION_REPORT, JSON.stringify(result, null, 2) + "\n");
  assert.deepEqual(errors, []);
  assert.equal(result.failedPrograms, 0);
  assert.equal(result.glError, 0);
  assert.equal(result.contextLost, false);
  assert.deepEqual(result.stable, { fields: true, world: true });
  assert.deepEqual(result.restoredStable, { fields: true, world: true });
  assert.deepEqual(result.baselineControl, result.initial[0], "zero effect equals original shader path pixel-for-pixel");
  const zero = result.strengths[0].pixels;
  assert.deepEqual(result.expired, zero);
  assert.deepEqual(result.strengths.at(-1).pixels, zero);
  assert.deepEqual(result.inspectionEffect, result.inspection);
  const luma = (pixel) => pixel.rgba.slice(0, 3).reduce((sum, n) => sum + n, 0);
  for (let target = 0; target < 2; target++) {
    assert.ok(luma(result.active[target]) > luma(zero[target]) + 30, `${zero[target].name} must brighten`);
    for (let i = 1; i < 4; i++)
      assert.ok(luma(result.strengths[i].pixels[target]) >= luma(result.strengths[i - 1].pixels[target]));
  }
  assert.equal(result.lostUniform, 0);
  assert.equal(result.restoredUniform, 0);
  assert.deepEqual(result.afterContext, zero);
  assert.deepEqual(result.reapplied, result.active);
  assert.deepEqual(result.active[2], zero[2], "self-emissive art must not be multiplied");
  assert.equal(result.water[0].vision, 1);
  assert.ok(result.water[0].fog > 20, "vision improves water visibility when actual detail is admitted");
  assert.equal(result.expiredWaterFog, 20, "expiry immediately clears enhanced water fog");
  assert.ok(result.water[0].fog <= result.water[0].cap);
  assert.equal(result.water[0].distant, false);
  assert.equal(result.water[1].vision, 0);
  assert.equal(result.water[1].fog, 4);
  assert.equal(result.water[2].vision, 0);
  assert.equal(result.missingDetail.fog, 2, "streaming hole immediately clamps enhanced visibility");
  assert.ok(result.finalAllocation.textures <= result.allocation.textures);
  assert.ok(result.finalAllocation.programs <= result.allocation.programs + 1);
});
