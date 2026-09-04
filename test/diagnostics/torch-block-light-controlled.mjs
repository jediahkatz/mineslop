import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { chromeExecutable } from "../realtime/config.mjs";
import { runBlockLightProbe } from "./torch-block-light-gpu.js";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5596/mineslop/");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const url = new URL("test/diagnostics/__torch-block-light__.html", base);
const mode = process.env.MINESLOP_TORCH_MODE ?? "field";
assert.ok(["field", "baseline"].includes(mode));
const output = resolve(process.env.MINESLOP_TORCH_OUTPUT ?? mkdtempSync(join(tmpdir(), "torch-field-report-")));
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "torch-field-browser-"));
const report = { complete: false, url: url.href, mode, profile, errors: [], performanceWarnings: [] };
const readbackWarning = /^(?:\[\.WebGL-0x[0-9a-f]+\])?GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/;
const closeRGB = (a, b) => a.slice(0, 3).every((value, i) => Math.abs(value - b[i]) <= 1);
try {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: await chromeExecutable(process.env.CHROME_BIN), headless: true,
    viewport: { width: 160, height: 160 }, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--remote-debugging-port=0"],
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.stack ?? String(error)));
  page.on("console", (message) => {
    if (readbackWarning.test(message.text())) report.performanceWarnings.push(message.text());
    else if (["warning", "error"].includes(message.type()) && /THREE|WebGL|shader|GL_INVALID|compile/i.test(message.text()))
      report.errors.push(message.text());
  });
  await page.route(url.href, (route) => route.fulfill({
    contentType: "text/html", body: '<!doctype html><div id="probe" style="width:129px;height:129px"></div>',
  }));
  const rendererURL = new URL("src/renderer.js", base);
  const rendererText = await (await context.request.get(rendererURL.href)).text();
  const threePath = rendererText.match(/from\s*["']([^"']*three[^"']*)["']/)?.[1];
  assert.ok(threePath, "served renderer Three import");
  const rigSource = readFileSync(new URL("../block-light-rig-fixture.js", import.meta.url), "utf8")
    .replace('from "three";', `from ${JSON.stringify(new URL(threePath, rendererURL).href)};`);
  // A test-only rig helper is also supplied when the baseline checkout does
  // not contain this new regression. Production modules are never substituted.
  await page.route(new URL("test/block-light-rig-fixture.js", base).href, (route) => route.fulfill({
    contentType: "text/javascript", body: rigSource,
  }));
  await page.goto(url.href);
  report.debugEndpoint = `http://127.0.0.1:${readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]}`;
  console.log(JSON.stringify({ started: true, output, mode, debugEndpoint: report.debugEndpoint }));
  report.result = await page.evaluate(runBlockLightProbe, { mode });
  const result = report.result;
  for (const frame of result.frames) {
    if (frame.png) writeFileSync(join(output, `${frame.label}.png`), Buffer.from(frame.png.split(",")[1], "base64"));
    delete frame.png;
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.failedPrograms, 0);
  assert.equal(result.singleEmitterCount, 1);
  assert.ok(result.competingEmitterCount > 12);
  assert.equal(result.singleUnchanged, true);
  assert.equal(result.competitionUnchanged, true);
  assert.equal(result.localLightObjects, 2);
  const first = result.frames[0];
  for (const frame of result.frames) {
    assert.equal(frame.fullbright, false);
    assert.equal(frame.point.fogFactor, 0);
    assert.equal(frame.point.fogEnabled, true);
    assert.ok(frame.point.luma > 2);
    assert.equal(frame.receiverInFrustum, true);
    assert.deepEqual(frame.point.daylight, { direct: 0, ambient: 0 });
    assert.deepEqual(frame.point.point, first.point.point);
    assert.deepEqual(frame.point.uv, first.point.uv);
    if (mode === "field") {
      assert.ok(closeRGB(frame.point.rgba, first.point.rgba), `${frame.label}: fixed texel changed`);
      assert.ok(frame.selected.every((light) => light.intensity === 0), "voxel PointLight double counting");
      if (!frame.immediate) assert.equal(frame.pending, 0);
      assert.deepEqual(frame.point.field, first.point.field);
      for (let i = 0; i < frame.mobs.length; i++) {
        assert.equal(frame.mobs[i].fieldBound, true);
        assert.ok(frame.mobs[i].luma > 2);
        assert.ok(closeRGB(frame.mobs[i].rgba, first.mobs[i].rgba), `${frame.label}/${frame.mobs[i].kind}`);
        assert.deepEqual(frame.mobs[i].uv, first.mobs[i].uv);
        assert.deepEqual(frame.mobs[i].field, first.mobs[i].field);
      }
    }
  }
  if (mode === "field") {
    assert.equal(result.boundary.unchanged, true);
    assert.equal(result.boundary.ownerValid, 0, "return must exercise a cold primary page");
    assert.equal(result.boundary.neighborValid, 255);
    assert.ok(result.boundary.initial.luma > result.boundary.unlit.luma);
    assert.equal(result.boundary.initial.observerVisible, true);
    for (const point of [result.boundary.outside, result.boundary.returned]) {
      assert.equal(point.observerVisible, true);
      assert.ok(closeRGB(point.rgba, result.boundary.initial.rgba), "visible return-boundary texel lost light");
      assert.deepEqual(point.field, result.boundary.initial.field);
      assert.deepEqual(point.uv, result.boundary.initial.uv);
      assert.deepEqual(point.daylight, result.boundary.initial.daylight);
      assert.equal(point.fogEnabled, true);
      assert.equal(point.fogFactor, 0);
    }
    assert.equal(result.controls.fieldDisabledInFullbright, true);
    assert.ok(result.controls.dynamicPoint.luma > result.controls.normal.luma + 3);
    assert.ok(result.controls.fullbright.luma > result.controls.normal.luma + 3);
    assert.ok(closeRGB(result.controls.returned.rgba, result.controls.normal.rgba));
    for (let i = 0; i < result.controls.mobNormal.length; i++)
      assert.ok(result.controls.mobNormal[i].luma > result.controls.mobNoField[i].luma,
        "actual opaque/late gel materials must respond to block light");
    assert.ok(result.maxima.scans <= 8192 && result.maxima.visits <= 32768 && result.maxima.uploadLayers <= 2);
    for (const curve of result.calibration) {
      assert.ok(curve.lit.luma > curve.unlit.luma, `${curve.surface}/${curve.horizontalDistance}: no light response`);
      assert.ok(curve.unlit.luma > 2, "all-black negative control");
      assert.deepEqual(curve.lit.uv, curve.unlit.uv);
      assert.equal(curve.lit.fogFactor, 0);
      assert.equal(curve.lit.fogEnabled, true);
    }
  }
  report.complete = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const r = report.result;
  const summary = { complete: report.complete, failure: report.failure, errors: report.errors,
    mode, output, debugEndpoint: report.debugEndpoint, singleEmitterCount: r?.singleEmitterCount,
    competingEmitterCount: r?.competingEmitterCount, unchanged: r?.singleUnchanged && r?.competitionUnchanged,
    gain: r?.gain, maxima: r?.maxima,
    frames: r?.frames.map((f) => ({ label: f.label, rgba: f.point.rgba, field: f.point.field,
      mobs: f.mobs.map((m) => ({ kind: m.kind, rgba: m.rgba, field: m.field })),
      sourceViewerDistance: f.sourceViewerDistance, sourceGroupVisible: f.sourceGroupVisible })),
    calibration: r?.calibration.map((c) => ({ surface: c.surface, distance: c.horizontalDistance,
      actualDistance: c.sourceDistance, rgba: c.lit.rgba, unlit: c.unlit?.rgba, field: c.lit.field })),
    controls: r?.controls, boundary: r?.boundary };
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  // The isolated browser remains available; run this command under tmux.
}
