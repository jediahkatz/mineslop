// Opt-in real UI/save integration, in a disposable profile; never the player's save.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { BLOCK } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import { chromeExecutable } from "./realtime/config.mjs";

const url = new URL(
  "/test/realtime/index.html?quality=low&seed=cedar-valley",
  process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173"
);
const hash = (bytes) =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");

test("the browser preserves old terrain through import/reload and opts into v3 only on Generate", {
  timeout: 120000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ready = async () => {
    await page.waitForFunction(
      () => window.__voxelBot?.ready || window.__voxelBot?.error,
      undefined,
      { timeout: 60000 }
    );
    assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  };
  const version = () =>
    page.evaluate(() => window.__voxelBot.game.world.generatorVersion);
  await page.goto(url.href);
  await ready();
  assert.equal(await version(), 3);
  assert.ok(await page.locator(".terrain-generation-note").isHidden());

  const legacy = createGenerator("cedar-valley", "overworld", 2);
  const archive = {
    version: 2,
    world: {
      version: 2,
      generatorVersion: 2,
      seed: "cedar-valley",
      dimension: "overworld",
      edits: [["overworld", 22, 92, 30, BLOCK.GLASS]],
    },
    player: { ...legacy.getSpawn(), yaw: 0, pitch: -0.25, flying: false },
    quality: "low",
  };
  const expected = legacy.generateChunk(1, 1).blocks;
  expected[92 * 256 + 14 * 16 + 6] = BLOCK.GLASS;
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".import-file").setInputFiles({
    name: "preserved-v2.voxelcraft.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await page.waitForFunction(
    () =>
      window.__voxelBot.game.world.generatorVersion === 2 &&
      !window.__voxelBot.game.building
  );
  assert.ok(await page.locator(".terrain-generation-note").isVisible());
  assert.match(
    await page.locator(".terrain-generation-note").innerText(),
    /export a backup first/
  );
  const voxels = () =>
    page.evaluate(() =>
      Array.from(window.__voxelBot.game.world.chunks.get("1,1").blocks)
    );
  assert.equal(hash(await voxels()), hash(expected));
  assert.ok(
    await page.evaluate(async () => (await window.__voxelBot.game.save()).ok)
  );
  await page.reload();
  await ready();
  assert.equal(await version(), 2);
  assert.equal(
    hash(await voxels()),
    hash(expected),
    "reload must not reshape old builds or untouched voxels"
  );
  console.log(
    "PASS: importing and reloading v2 preserves the complete chunk, edit and generator identity."
  );

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".generate-button").click();
  await page.waitForFunction(
    () =>
      window.__voxelBot.game.world.generatorVersion === 3 &&
      !window.__voxelBot.game.building
  );
  assert.ok(await page.locator(".terrain-generation-note").isHidden());
  assert.equal(
    await page.evaluate(() => window.__voxelBot.game.world.edits.size),
    0
  );
  const spawn = await page.evaluate(() =>
    window.__voxelBot.game.world.generator.getSpawn()
  );
  assert.notDeepEqual(spawn, legacy.getSpawn());
  assert.ok(
    await page.evaluate(async () => (await window.__voxelBot.game.save()).ok)
  );
  await page.reload();
  await ready();
  assert.equal(await version(), 3);
  assert.deepEqual(
    await page.evaluate(() =>
      window.__voxelBot.game.world.generator.getSpawn()
    ),
    spawn
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS: confirmed Generate creates and persists v3 for the same seed, natural spawn ${JSON.stringify(spawn)}.`
  );
});
