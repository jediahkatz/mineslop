// Actual browser/GPU coverage. Passing this does not visually approve any block.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { BLOCK, BLOCK_CATALOG } from "../src/blocks.js";
import { chromeExecutable } from "./realtime/config.mjs";
import { facePartsFor, PAGE_SIZE } from "./block-art-review/cases.js";
import { SURFACES } from "./block-art-review/coverage.js";
import { pageCounts, sheetPlan } from "./block-art-review/plan.js";
import { sourceFingerprint } from "./block-art-review/source-fingerprint.mjs";

async function open(t, selection) {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1536, height: 1100 }, deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => errors.push(request.url()));
  const url = new URL("/test/block-art-review/index.html",
    process.env.MINESLOP_BLOCK_ART_URL ?? "http://127.0.0.1:5176");
  for (const [key, value] of Object.entries(selection))
    if (value !== null) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    window.__mineslopBlockArtReview?.ready || window.__mineslopBlockArtReview?.error);
  assert.equal(await page.evaluate(() => window.__mineslopBlockArtReview.error), null);
  const fingerprint = await sourceFingerprint();
  const render = async (options) => {
    const snapshot = options
      ? await page.evaluate((input) => window.__mineslopBlockArtReview.render(input), options)
      : await page.evaluate(() => window.__mineslopBlockArtReview.snapshot());
    assert.equal(snapshot.build.sourceFingerprint, fingerprint, "Use a fresh frozen review build");
    assert.equal(snapshot.catalogCount, BLOCK_CATALOG.length);
    assert.ok(snapshot.cases.length > 0 && snapshot.cases.length <= PAGE_SIZE);
    for (const entry of snapshot.cases) {
      assert.deepEqual(entry.surfaces, SURFACES);
      assert.deepEqual(entry.faceParts, facePartsFor(entry.id));
      for (const shape of entry.shapes) {
        if (shape.link) assert.equal(shape.link.valid, true);
        if (shape.attachment) assert.equal(shape.attachment.valid, true);
      }
      if (entry.id === BLOCK.AIR) assert.equal(entry.batches.length, 0);
      else assert.ok(entry.batches.reduce((count, batch) => count + batch.triangles, 0) > 0);
      assert.ok(entry.resources.geometries <= 40, "No per-page GPU geometry accumulation");
      assert.ok(entry.resources.textures <= 16, "Bounded real texture resources");
      assert.equal(entry.frames.length, 3);
      for (const frame of entry.frames) {
        assert.equal(frame.glError, 0);
        assert.equal(frame.contextLost, false);
        assert.equal(frame.failedPrograms, 0);
      }
    }
    assert.deepEqual(await page.locator(".inventory img").evaluateAll((images) =>
      images.map((image) => [image.complete, image.naturalWidth, image.naturalHeight])),
    snapshot.cases.flatMap(() => [[true, 64, 64], [true, 64, 64]]));
    assert.deepEqual(errors, []);
    return snapshot;
  };
  return { page, render, errors };
}

test("block art browser smoke renders special cells, linked shapes and blind/lit presentations", {
  timeout: 180000,
}, async (t) => {
  const selection = {
    ids: [BLOCK.AIR, BLOCK.GLASS, BLOCK.WHITE_BED, BLOCK.OAK_DOOR, BLOCK.LADDER, BLOCK.TUBE_CORAL],
    labels: "blind",
  };
  const { page, render } = await open(t, selection);
  const initial = await render();
  assert.deepEqual(initial.cases.map(({ id, key }) => ({ id, key })),
    sheetPlan(selection).cases.map(({ id, key }) => ({ id, key })));
  assert.deepEqual(await page.locator(".card h2").allTextContents(),
    ["Sample A", "Sample B", "Sample C", "Sample D", "Sample E", "Sample F"]);
  assert.ok((await page.locator(".identity").allTextContents()).every(
    (text) => text === "Identity withheld · evaluate silhouette and material"));
  for (const light of ["day", "shadow", "night"])
    await render({ ...selection, labels: "labeled", light });
  for (const id of [BLOCK.OAK_STAIRS, BLOCK.OAK_FENCE, BLOCK.OAK_TRAPDOOR, BLOCK.WATER])
    for (let page = 0; page < pageCounts({ ids: [id], set: "states" }); page++)
      await render({ ids: [id], set: "states", page });
  t.diagnostic("Actual production atlas, GPU geometry, valid multipart/support states, icons and held view rendered; visual approvals remain separate.");
});

test("every catalog ID renders once through the actual browser art path", {
  timeout: 360000,
}, async (t) => {
  const { render } = await open(t, { group: "all", set: "catalog" });
  const seen = [];
  for (let page = 0; page < pageCounts(); page++) {
    const snapshot = page === 0 ? await render()
      : await render({ group: "all", set: "catalog", page });
    seen.push(...snapshot.cases.map(({ id }) => id));
  }
  assert.deepEqual(seen.sort((a, b) => a - b), BLOCK_CATALOG.map(({ id }) => id));
  t.diagnostic(`${seen.length} distinct catalog IDs rendered, including Air and special cells; this is runtime coverage, not visual review.`);
});
