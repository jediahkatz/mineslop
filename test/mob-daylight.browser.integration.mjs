import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";
import { installWebGLCallTrace } from "./webgl-call-trace.js";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const url = new URL("test/__mob-daylight-regression__.html", base);
const readbackWarning = /^(?:\[\.WebGL-0x[0-9a-f]+\])?GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/;
const samePixels = (actual, expected, label) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((point, i) => {
    assert.equal(point.name, expected[i].name);
    assert.deepEqual(point.point, expected[i].point, `${label}: fixed world point`);
    assert.deepEqual(point.uv, expected[i].uv, `${label}: fixed skin UV`);
    for (let c = 0; c < 4; c++)
      assert.ok(Math.abs(point.rgba[c] - expected[i].rgba[c]) <= 1,
        `${label}/${point.name}: ${point.rgba} != ${expected[i].rgba}`);
  });
};

test("instanced mob daylight survives observer motion, late gel and renderer replacement", { timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN), headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await page.addInitScript(installWebGLCallTrace);
  const errors = [], performanceWarnings = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (readbackWarning.test(message.text())) performanceWarnings.push(message.text());
    else if (["warning", "error"].includes(message.type()) && /THREE|WebGL|shader|GL_INVALID|compile/i.test(message.text()))
      errors.push(message.text());
  });
  await page.route(url.href, (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><div id="probe" style="width:65px;height:65px"></div>',
  }));
  await page.goto(url.href);
  const result = await page.evaluate(async () => {
    const { runMobDaylightProbe } = await import("./mob-daylight-gpu.js");
    const result = runMobDaylightProbe(document.querySelector("#probe"));
    return { ...result, glTrace: window.__glCallTrace.reports };
  });
  if (process.env.MINESLOP_MOB_LIGHTING_REPORT)
    writeFileSync(process.env.MINESLOP_MOB_LIGHTING_REPORT, JSON.stringify({ result, errors, performanceWarnings }, null, 2) + "\n");
  assert.deepEqual(errors, []);
  assert.ok(result.glTrace.length > 0);
  assert.ok(result.glTrace.every((trace) => trace.errors === 0 && trace.contextLosses.length === 0));
  assert.equal(result.failedPrograms, 0);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.anchor, [16, 0, 16]);
  assert.ok(result.readbacks <= 100);
  assert.equal(result.lateBeforeDraw, false);
  assert.deepEqual(result.binding, { opaque: true, gel: true, sharedAtlas: true, fog: true });
  const reference = result.stations[0];
  assert.equal(reference.exposure, 1);
  assert.equal(result.stations[2].exposure, 0);
  assert.equal(reference.natural.find((p) => p.name === "outside").mask.direct, 1);
  const inside = reference.natural.find((p) => p.name === "inside");
  assert.equal(inside.mask.direct, 0);
  assert.ok(inside.mask.ambient > 0 && inside.mask.ambient < 1);
  const deep = reference.natural.find((p) => p.name === "deep");
  assert.deepEqual(deep.mask, { direct: 0, ambient: 0 });
  assert.ok(reference.natural.find((p) => p.name === "outside").luma > deep.luma + 10,
    "same cow skin must distinguish open sky from deep cave; identical black samples cannot pass");
  samePixels(result.beforeLateGel, reference.natural.slice(0, 3), "late gel preserves opaque batches");
  for (const station of result.stations) {
    assert.ok(station.known);
    assert.equal(station.pending, 0);
    for (const pixel of [...station.natural, ...station.fullbright]) {
      assert.ok(pixel.luma > 2 && pixel.rgba[3] === 255, `${pixel.name}: actual visible nonblack texel`);
      assert.equal(pixel.fogFactor, 0);
      assert.equal(pixel.backingUnfogged, true, "transparent gel must not inherit observer-dependent background fog");
      assert.ok(Number.isInteger(pixel.instance));
    }
    samePixels(station.natural, reference.natural, `observer ${station.x}`);
    samePixels(station.fullbright, reference.fullbright, `Fullbright ${station.x}`);
    samePixels(station.restored, station.natural, `restored ${station.x}`);
  }
  for (const name of ["eyes", "fire"]) {
    const glow = reference.natural.find((p) => p.name === name);
    assert.deepEqual(glow.mask, { direct: 0, ambient: 0 });
    assert.ok(glow.sourceRGBA[3] > 0 && glow.luma > 20, `${name}: original atlas emission survives darkness`);
  }
  assert.ok(reference.fullbright.find((p) => p.name === "deep").luma > deep.luma + 10);
  assert.ok(result.torch.luma > result.unlit.luma + 10);
  samePixels([result.restoredTorch], [result.unlit], "point light removal");
  assert.deepEqual(result.reboundBinding, { keyChanged: true, opaque: true, gel: true });
  const reboundInside = result.rebound.find((p) => p.name === "inside");
  assert.deepEqual(reboundInside.mask, { direct: 0, ambient: 0 });
  assert.ok(reboundInside.luma > 2 && reboundInside.luma < inside.luma - 10, "replacement world must change the bound field");
  samePixels(result.reboundFullbright, reference.fullbright, "retained skin texels after renderer replacement");
  assert.equal(result.freshBindings, true);
  samePixels(result.rebound, result.freshRebound, "retained versus freshly-created opaque/gel materials");
  t.diagnostic(JSON.stringify({
    readbacks: result.readbacks, glErrors: 0, performanceWarnings: performanceWarnings.length,
    stations: result.stations.map((s) => ({ x: s.x, exposure: s.exposure,
      pixels: Object.fromEntries(s.natural.map((p) => [p.name, p.rgba])) })),
    reboundInside: reboundInside.rgba, torch: result.torch.rgba,
  }));
});
