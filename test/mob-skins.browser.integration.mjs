// Opt-in, disposable headless WebGL regression. No connection to the user's
// browser, no imported saves, and no visual-gallery claims.
// node --test test/mob-skins.browser.integration.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { MOB_SPECIES } from "../src/mob-species.js";
import { chromeExecutable } from "./realtime/config.mjs";

const url = new URL(
  "/__mob-skin-gpu-regression__",
  process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173"
);

// Real browser startup, shader compilation, and GPU readback are integration work.
test("production mob atlas lights all species and blends bounded slime shells over opaque cores", {
  timeout: 60000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /THREE|WebGL|shader/i.test(message.text())
    )
      errors.push(message.text());
  });
  await page.route(url.href, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Automated mob GPU regression</title><script type="module" src="/test/mob-skins-webgl.js"></script>',
    })
  );
  await page.goto(url.href);
  await page.waitForFunction(() => globalThis.__mobSkinGpuProbe, undefined, {
    timeout: 45000,
  });
  const probe = await page.evaluate(() => globalThis.__mobSkinGpuProbe);
  assert.equal(probe.error, null);
  assert.deepEqual(errors, []);
  const result = probe.result;
  assert.ok(
    result.maxTexelError <= 2,
    `six-face sRGB pixel error: ${result.maxTexelError}`
  );
  assert.equal(result.faceResults.length, 6);
  assert.ok(result.faceResults.every((face) => face.calls === 1));
  assert.ok(result.lit.mean > 30);
  assert.ok(
    result.fuse.mean > result.lit.mean + 40,
    "white fuse flashes brighten the actual textured surface"
  );
  assert.ok(
    result.damage.rgb[0] > result.damage.rgb[1] * 1.4,
    "damage visibly tints the skin red"
  );
  assert.equal(result.dark.max, 0, "unlit skin cannot glow");
  assert.equal(result.darkFuse.max, 0, "a fuse tint is not a free cave light");
  assert.ok(result.eyes.max > 60);
  assert.ok(result.eyes.litFraction > 0 && result.eyes.litFraction < 0.15);
  assert.equal(
    result.back.max,
    0,
    "Enderman emission is restricted to the front eye pixels"
  );
  assert.deepEqual(
    result.species.map((entry) => entry.kind).sort(),
    Object.keys(MOB_SPECIES).sort()
  );
  for (const species of result.species) {
    const batches = species.kind === "slime" ? 2 : 1;
    assert.equal(
      species.calls,
      batches,
      `${species.kind}: bounded production batches`
    );
    assert.ok(
      species.parts > 0 && species.texturedPixels > 0.005,
      species.kind
    );
    assert.equal(species.textures, 1, `${species.kind}: one atlas`);
    assert.equal(
      species.geometries,
      batches,
      `${species.kind}: one cube per active batch`
    );
    assert.equal(species.gelParts, species.kind === "slime" ? 6 : 0);
    assert.ok(species.opaqueParts > 0);
  }
  const gel = result.gel;
  const difference = (a, b) =>
    a.reduce(
      (max, value, index) => Math.max(max, Math.abs(value - b[index])),
      0
    );
  assert.ok(
    Math.abs(gel.measuredOpacity - gel.expectedOpacity) < 0.08,
    `actual background blending gives opacity ${gel.measuredOpacity}`
  );
  assert.ok(
    difference(gel.litA.edge, gel.litB.edge) > 50,
    "background transmits through the gel rim"
  );
  assert.ok(
    difference(gel.litA.edge, gel.litA.background) > 10,
    "the shell is visible, not discarded"
  );
  assert.deepEqual(
    gel.litA.core,
    gel.litB.core,
    "the inner core stays opaque over changing backgrounds"
  );
  assert.deepEqual(
    gel.bareCore.edge,
    gel.bareCore.background,
    "the clear rim lies outside the opaque core"
  );
  assert.ok(
    difference(gel.bareCore.core, gel.litB.core) > 3,
    "gel also blends over the nucleus"
  );
  assert.ok(
    gel.litA.eye[1] < gel.litA.core[1] - 5,
    "the inset face remains visible through gel"
  );
  assert.equal(gel.bareCore.calls, 1);
  assert.equal(gel.litA.calls, 2);
  assert.equal(gel.dark.max, 0, "neither gel nor core emits in a dark cave");
  assert.equal(
    gel.darkDamage.max,
    0,
    "damage tint does not turn gel into a light source"
  );
  assert.ok(gel.damage.core[0] > gel.damage.core[1] * 1.2);
  assert.ok(gel.spawnOrderError <= 1, "overlaps do not depend on spawn order");
  assert.ok(
    gel.reverseViewOrderError <= 1,
    "overlap ordering follows a reversed view"
  );
  assert.ok(
    gel.unsortedOverlapDifference > 3,
    "negative control catches incorrect alpha ordering"
  );
  const checkBudget = (entry, calls, geometries) => {
    assert.equal(entry.calls, calls);
    assert.equal(entry.textures, 1);
    assert.equal(entry.geometries, geometries);
    assert.equal(entry.sharedAtlas, true);
  };
  checkBudget(gel.litBudget, 2, 2);
  for (const cycle of gel.cycles) {
    checkBudget(cycle.hidden, 0, 1);
    checkBudget(cycle.visible, 2, 2);
    assert.equal(cycle.hidden.gelParts, 0);
    assert.equal(cycle.visible.gelParts, 12);
  }
  checkBudget(gel.population, 2, 2);
  assert.equal(gel.population.count, 28);
  assert.equal(gel.population.capacity, 168);
  assert.equal(gel.population.capacity, gel.population.expectedCapacity);
  assert.equal(gel.population.gelParts, gel.population.capacity);
  assert.equal(gel.population.opaqueParts, gel.population.count);
  assert.equal(gel.population.sameBatch, true);
  checkBudget(gel.sulfurBudget, 1, 1);
  assert.equal(gel.sulfurBudget.gelParts, 0);
  assert.deepEqual(
    gel.sulfurA.edge,
    gel.sulfurB.edge,
    "sulfur never inherits slime translucency"
  );
  assert.equal(result.remainingTextures, 0);
  assert.equal(result.remainingGeometries, 0);
  console.log(JSON.stringify(result));
});
