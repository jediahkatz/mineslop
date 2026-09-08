import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

test("cedar-valley first draw and first game frame have real fresh R1 surfaces", { timeout: 90000 }, async t => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN), headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("voxelcraft-controls-v1",
    JSON.stringify({ inputMode: "remote", mouseSensitivity: 1.25 })));
  const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:6819/mineslop/");
  await page.route("**/test/arrival-surfaces.html", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><div id="game"></div><div id="ui"></div><script type="module">
      await import("./arrival-surfaces-gpu-probe.js"); await import("../src/main.js");</script>`,
  }));
  await page.goto(new URL("test/arrival-surfaces.html", base).href);
  await page.waitForFunction(() => window.arrivalSurfaceProof?.firstFrame, undefined, { timeout: 60000 });
  const proof = await page.evaluate(() => {
    const { firstDraw, firstFrame, readyMs } = window.arrivalSurfaceProof;
    return { firstDraw, firstFrame, readyMs };
  });
  assert.deepEqual(errors, []);
  for (const [label, result] of Object.entries({ firstDraw: proof.firstDraw, firstFrame: proof.firstFrame })) {
    assert.ok(result.ready, `${label}: fresh physical R1`);
    assert.ok(result.surfaces.filter(s => s.status === "native-match").length >= 7, `${label}: non-vacuous surfaces`);
    assert.equal(result.surfaces.filter(s => s.status === "missing-surface").length, 0, label);
    assert.equal(result.surfaces.filter(s => s.status === "duplicate-ownership").length, 0, label);
  }
  assert.equal(proof.firstFrame.radius, 12);
  t.diagnostic(JSON.stringify(proof));
});
