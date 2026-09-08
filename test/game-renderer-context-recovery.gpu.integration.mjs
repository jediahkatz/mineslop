// NEW regression authored during recovery validation, not historical recovery.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";
import { installWebGLCallTrace } from "./webgl-call-trace.js";

test("combined final GameRenderer flushes before draw and restores palette/light/shadows at frozen time", { timeout: 180000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await page.addInitScript(installWebGLCallTrace);
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204, body: "" }));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
  await page.goto(process.env.MINESLOP_LIGHT_TEST_URL ?? new URL("test/daylight-surface-probe.html", base).href);
  const result = await page.evaluate(async () => {
    const { runCombinedContextProbe } = await import("./game-renderer-context-probe.js");
    return runCombinedContextProbe();
  });
  result.browserVersion = browser.version();
  t.diagnostic(JSON.stringify({ ...result, errors }));
  if (process.env.MINESLOP_CONTEXT_CANDIDATE_REPORT)
    writeFileSync(process.env.MINESLOP_CONTEXT_CANDIDATE_REPORT, JSON.stringify({ ...result, errors }, null, 2));
  assert.equal(result.failure, undefined, JSON.stringify(result.failure));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.glErrors, []);
  assert.equal(result.glErrorAfterDisposal, 0);
  assert.deepEqual(result.contextEpochs, [1]);
  assert.equal(result.disposed, true);
  assert.equal(result.pixelDifferences, 0);
  assert.equal(result.repeatedPixelDifferences, 0);
  assert.ok(result.shadowOffDifferences > 32);
  assert.ok(result.distinctColors > 10);
  assert.equal(result.firstRestoredShadow.hasGPUFramebuffer, true);
  assert.equal(result.firstRestoredShadow.lastTime, 10);
  assert.equal(result.firstRestoredShadow.dirty, false);
  assert.equal(result.firstRestoredPalette.pendingUploadBytes, 0);
  assert.equal(result.firstRestoredLighting.latch, false);
  assert.equal(result.flushFailureBlockedDraw, true);
  assert.equal(result.cpuRetained, true);
  assert.ok(result.physicalPagesByKind.block > 0);
  assert.ok(result.physicalPagesByKind.surface > 0);
  assert.deepEqual(result.lostDraws, [
    { phase: "before-loss-event", lossEventSeen: false, returned: false, flushes: 0, draws: 0, latch: true },
    { phase: "after-loss-event", lossEventSeen: true, returned: false, flushes: 0, draws: 0, latch: true },
  ]);
  assert.equal(result.lighting.pendingRequired, 0);
  assert.ok(result.afterPrograms.every(program => program.linked));
  assert.ok(result.afterPrograms.some(program =>
    program.uniforms.includes("uRegionalColors") && program.uniforms.includes("uBlockLightPalette")));
});
