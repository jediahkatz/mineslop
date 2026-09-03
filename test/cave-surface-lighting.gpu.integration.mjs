// Opt-in terminal-driven WebGL regression. Disposable headless profile; no UI
// automation, native world, save import, or connection to the parent's browser.
// Serve this checkout separately, then:
// VOXELCRAFT_TEST_URL=http://127.0.0.1:5173/mineslop/ node --test test/cave-surface-lighting.gpu.integration.mjs
// The default sweep spans 79 blocks. MINESLOP_CAVE_FULL_DEPTH=0 explicitly opts
// into the shorter 61-block material profile; it is not full-depth acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { CAVE_DAYLIGHT_LIMITS } from "../src/cave-daylight.js";
import { SKY_COLUMN_LIMITS } from "../src/sky-columns.js";
import { SURFACE_DAYLIGHT_LIMITS } from "../src/surface-daylight.js";
import { chromeExecutable } from "./realtime/config.mjs";

const files = ["cave-daylight.js", "daylight-material.js", "surface-daylight.js", "sky-columns.js", "atmosphere.js", "renderer.js"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceHashes = async () => Object.fromEntries(await Promise.all(files.map(async (name) =>
  [name, hash(await readFile(new URL(`../src/${name}`, import.meta.url)))])));
const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const url = new URL("test/daylight-surface-probe.html", base);
const surfaceSummary = (station) => ({
  x: station.camera[0], exposure: station.exposure, directSky: station.directSky, skyVisible: station.skyVisible,
  cameraDiagnostics: station.cameraDiagnostics,
  pixels: station.natural.map((point, i) => ({
    name: point.name, rgba: point.rgba, encodedLuma: point.encodedLuma,
    fullbright: station.fullbright[i].rgba, mask: point.mask, vertexColor: point.vertexColor,
  })),
  work: station.work,
});

test("authored cave fixed-surface and darkness-floor WebGL regressions", { timeout: 120000 }, async (t) => {
  const before = await sourceHashes();
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /WebGLProgram|shader|compile|VALIDATE_STATUS/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto(url.href, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => typeof window.runSurfaceLightingProbe === "function");
  const served = await page.evaluate(async (names) => Object.fromEntries(await Promise.all(names.map(async (name) =>
    [name, (await import(new URL(`../src/${name}?raw`, location.href).href)).default]))), files);
  const servedHashes = Object.fromEntries(Object.entries(served).map(([name, value]) => [name, hash(value)]));
  assert.deepEqual(servedHashes, before, "The GPU must execute this checkout, not the native GUI's frozen server");
  const fullDepth = process.env.MINESLOP_CAVE_FULL_DEPTH !== "0";
  const result = await page.evaluate((fullDepth) => window.runSurfaceLightingProbe({ fullDepth }), fullDepth);
  const after = await sourceHashes();
  assert.deepEqual(after, before, "Do not mix production lighting revisions in one measurement");
  const provenance = { url: url.href, sourceHashes: before, servedHashes, settings: result.settings };
  const surfaces = {
    outside: result.outside.map(surfaceSummary), walking: result.walking.map(surfaceSummary),
    coldDeep: surfaceSummary(result.coldDeep), returned: surfaceSummary(result.returned),
  };
  const photometry = Object.fromEntries(Object.entries(result.lanes).map(([name, lane]) =>
    [name, { all: lane.all, faces: lane.faces }]));
  if (process.env.MINESLOP_CAVE_REPORT)
    writeFileSync(process.env.MINESLOP_CAVE_REPORT, JSON.stringify({ provenance, ...result }, null, 2) + "\n");
  t.diagnostic(JSON.stringify({ provenance, surfaces, photometry, readbacks: result.readbacks }));

  const stations = [...result.outside, ...result.walking, result.coldDeep, result.returned, result.closed, result.reopened];
  await t.test("fixture controls: identical texels, real shaders, no state mutation, bounded readbacks", () => {
    assert.deepEqual(errors, []);
    assert.equal(result.failedPrograms, 0);
    assert.equal(result.contextLost, false);
    assert.equal(result.glError, 0);
    assert.equal(result.settings.width, 65);
    assert.equal(result.settings.height, 65);
    assert.equal(result.settings.outputColorSpace, "srgb");
    assert.equal(result.settings.toneMappingExposure, 1.05);
    assert.equal(result.settings.fullDepth, fullDepth);
    assert.equal(result.settings.deepX, fullDepth ? 50.5 : 32.5);
    assert.equal(result.outside[0].camera[0], -28.5);
    assert.equal(result.walking.at(-1).camera[0], result.settings.deepX);
    assert.equal(result.walking.at(-1).camera[0] - result.outside[0].camera[0], fullDepth ? 79 : 61);
    assert.ok(result.readbacks <= result.settings.maxReadbacks);
    assert.ok(result.maxDrawCalls < 32);
    assert.equal(result.signatureBefore, result.signatureAfterPhotometry);
    for (const station of stations) {
      assert.equal(station.known, true);
      assert.ok(station.work.rays <= CAVE_DAYLIGHT_LIMITS.sources + CAVE_DAYLIGHT_LIMITS.directions + 1);
      assert.ok(station.work.cache <= SKY_COLUMN_LIMITS.cachedChunks);
      assert.ok(station.work.cellReads <= result.settings.residentColumns * 16 * 16 * SKY_COLUMN_LIMITS.height);
      assert.equal(station.work.bytes, 144 * 144 * 4);
      assert.ok(station.work.peak.surfaceBuilds <= SURFACE_DAYLIGHT_LIMITS.chunkBuilds);
      assert.ok(station.work.peak.surfaceCellReads <= SURFACE_DAYLIGHT_LIMITS.chunkBuilds * 9 * 256 * SKY_COLUMN_LIMITS.height);
      assert.ok(station.work.surface.cachedChunks <= SURFACE_DAYLIGHT_LIMITS.cachedChunks);
      assert.equal(station.work.surface.atlasBytes, 81 * 256 * SKY_COLUMN_LIMITS.height);
      assert.equal(station.work.surface.pending, 0);
      for (let i = 0; i < station.natural.length; i++)
        for (let channel = 0; channel < 4; channel++)
          assert.ok(
            Math.abs(station.fullbright[i].rgba[channel] - result.walking[0].fullbright[i].rgba[channel]) <= 1,
            `${station.natural[i].name}: the control must prove we sampled the SAME texel/face`
          );
    }
  });
  await t.test("opaque closure stays dark and reopening restores the same roof faces", () => {
    assert.equal(result.closed.exposure, 0);
    assert.equal(result.closed.skyVisible, false);
    assert.ok(result.closed.natural.every((point) => point.mask.direct === 0 && point.mask.ambient === 0));
    assert.equal(result.reopened.skyVisible, true);
    for (let i = 0; i < result.reopened.natural.length; i++)
      assert.ok(Math.abs(result.reopened.natural[i].encodedLuma - result.walking[0].natural[i].encodedLuma) <= 3);
  });
  await t.test("Fullbright, torch contrast and default restoration remain separate from daylight", () => {
    const lanes = result.lanes;
    assert.ok(lanes.fullbright.all.mean > lanes.default.all.mean + 20);
    assert.ok(lanes.fixtureTorch.all.mean > lanes.default.all.mean + 15);
    assert.deepEqual(lanes.restored.points.map((point) => point.rgba), lanes.default.points.map((point) => point.rgba));
    assert.equal(result.restoredSettings.fullbright, false);
    assert.equal(result.restoredSettings.toneMapping, result.settings.toneMapping);
    assert.equal(result.restoredSettings.outputColorSpace, result.settings.outputColorSpace);
    assert.equal(result.restoredSettings.toneMappingExposure, result.settings.toneMappingExposure);
    assert.equal(result.restoredSettings.vertexColors, true);
    assert.equal(result.restoredSettings.atlasRestored, true);
    assert.ok(result.restoredSettings.localIntensities.every((value) => value === 0));
  });
  await t.test("[surface-light] fixed roof/wall pixels do not go black as the camera moves deep", () => {
    assert.equal(result.walking.at(-1).exposure, 0);
    for (const station of [...result.walking, result.coldDeep, result.returned]) {
      assert.equal(station.skyVisible, true);
      for (let i = 0; i < station.natural.length; i++) {
        const reference = result.walking[0].natural[i].encodedLuma;
        assert.ok(reference > result.closed.natural[i].encodedLuma + 3, "the entrance reference must have actual daylight contrast against the closed-mouth control");
        assert.ok(
          Math.abs(station.natural[i].encodedLuma - reference) <= Math.max(3, reference * 0.15),
          `${station.natural[i].name} pixel loses daylight at x=${station.camera[0]}: ${station.natural[i].rgba}`
        );
      }
    }
  });
  await t.test("[surface-light] the same roof/wall pixels are lit before the outside camera reaches the mouth", () => {
    for (const station of result.outside) {
      assert.equal(station.directSky, true);
      assert.equal(station.exposure, 1);
      for (let i = 0; i < station.natural.length; i++) {
        const reference = result.walking[0].natural[i].encodedLuma;
        assert.ok(
          Math.abs(station.natural[i].encodedLuma - reference) <= Math.max(3, reference * 0.15),
          `${station.natural[i].name} pixel follows the outside camera at x=${station.camera[0]}: ${station.natural[i].rgba}`
        );
      }
    }
  });
  await t.test("[surface-light] default source-free stone has nonzero pixels and texture contrast", () => {
    assert.equal(result.deepAccess.exposure, 0);
    assert.ok(result.lanes.default.points.every((point) => point.mask.direct === 0 && point.mask.ambient === 0));
    // Encoded output, not a claim that linear irradiance is displayed brightness.
    for (const [name, face] of Object.entries(result.lanes.default.faces)) {
      assert.ok(face.median >= 3 && face.max <= 24, `${name}: the default darkness floor must be faint but readable`);
      assert.ok(face.max - face.min >= 2, `${name}: stone texture loses display contrast`);
    }
  });
  await t.test("executed pixels preserve exterior shading and clear stale or occluded daylight immediately", () => {
    assert.equal(result.exterior.mask.direct, 1);
    assert.deepEqual(result.exterior.rgba, result.originalExterior.rgba, "direct-sky art is not brightened");
    assert.ok(result.closedFirstFrame.pending > 0, "exercise invalidation before the remote tile can rebuild");
    for (let i = 0; i < result.closedFirstFrame.natural.length; i++) {
      assert.deepEqual(result.closedFirstFrame.natural[i].mask, { direct: 0, ambient: 0 });
      assert.deepEqual(result.closedFirstFrame.natural[i].rgba, result.closed.natural[i].rgba);
    }
    assert.deepEqual(result.sealedRoom.mask, { direct: 0, ambient: 0 });
    assert.ok(result.sealedRoom.encodedLuma >= 3 && result.sealedRoom.encodedLuma < 24);
    assert.ok(result.roomFullbright.encodedLuma > result.sealedRoom.encodedLuma + 30);
  });
});
