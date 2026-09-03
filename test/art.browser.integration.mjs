// Real GPU smoke test, not visual-quality, AI, or performance evidence.
// The authored asset fixture exists only in a disposable browser/profile.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { BLOCK } from "../src/blocks.js";
import { chromeExecutable } from "./realtime/config.mjs";

const url = new URL(
  "/test/realtime/index.html?quality=low&seed=artpass-internal-gallery-v1",
  process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173"
);
const kinds = [
  "creeper",
  "zombie",
  "skeleton",
  "enderman",
  "spider",
  "slime",
  "sheep",
  "cow",
  "pig",
  "chicken",
  "wolf",
  "camel",
  "sulfur_cube",
];

test("real WebGL compiles and draws textured creatures with bounded shared resources", {
  timeout: 180000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 960, height: 640 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    errors.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  page.setDefaultTimeout(60000);
  await page.goto(url.href, { waitUntil: "load" });
  await page.waitForFunction(
    () => window.__voxelBot?.ready || window.__voxelBot?.error
  );
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  await page.waitForFunction(() => {
    const game = window.__voxelBot.game;
    return !game.building && game.world._requests.size === 0;
  });

  await page.evaluate(
    async ({ stone, air }) => {
      const game = window.__voxelBot.game;
      if (!game.paused) game.pause();
      cancelAnimationFrame(game.animation);
      game.player.enabled = false;
      game.wildlife.autoSpawn = false;
      for (const mob of [...game.wildlife.entities]) game.wildlife.remove(mob);
      await game.world.ensureArea({ x: 0.5, y: 83, z: 0.5 }, 4);
      // Authored Creative footing exercises the production spawn/pick/render path.
      // This setup is not asserted to be naturally generated terrain.
      for (let x = -5; x <= 5; x++) {
        for (let z = -5; z <= 8; z++) {
          game.world.set(x, 82, z, stone);
          for (let y = 83; y < 96; y++) game.world.set(x, y, z, air);
        }
      }
      game.player.setPosition({ x: 0.5, y: 83, z: 5.5 });
      game.player.update(0);
      game.currentTime = 0.4;
      game.graphics.setTime(game.currentTime);
      game.graphics.rebuildDirty(Infinity);
      game.ui.hideMenu();
    },
    { stone: BLOCK.STONE, air: BLOCK.AIR }
  );

  let expectedTextures;
  for (const quality of ["low", "medium", "high"]) {
    const records = await page.evaluate(
      ({ kinds, quality }) => {
        const { graphics, wildlife, player } = window.__voxelBot.game;
        graphics.setQuality(quality);
        graphics.rebuildDirty(Infinity);
        const results = [];
        for (const kind of kinds) {
          for (const mob of [...wildlife.entities]) wildlife.remove(mob);
          const mob = wildlife.spawn(kind, { x: 0.5, y: 83, z: 0.5 });
          if (!mob) throw new Error(`Authored footing rejected ${kind}`);
          mob.root.rotation.y = mob.targetYaw = 0;
          mob.root.updateMatrixWorld(true);
          const target = mob.model.parts
            .find((part) => !part.condition)
            .node.getWorldPosition(graphics.camera.position.clone());
          const camera = graphics.camera.clone();
          camera.position
            .copy(mob.position)
            .add(
              mob.position.clone().set(3, Math.max(1.8, mob.spec.height), 5)
            );
          camera.lookAt(target);
          camera.updateMatrixWorld(true);
          const direction = camera.getWorldDirection(camera.position.clone());
          // Supply this alternate camera through the normal zero-delta view
          // update, including the depth order of translucent shell instances.
          wildlife.update(0, 0, player.position, {
            mode: "creative",
            timeOfDay: 0.4,
            playerEye: camera.position,
            playerForward: direction,
          });
          const picked = wildlife.raycast(camera.position, direction, 12);
          const batches = [];
          wildlife.group.traverse((object) => {
            if (
              !object.isInstancedMesh ||
              !object.visible ||
              object.count === 0
            )
              return;
            const materials = Array.isArray(object.material)
              ? object.material
              : [object.material];
            batches.push({
              count: object.count,
              textures: materials
                .filter((material) => material.map)
                .map(({ map }) => ({
                  id: map.uuid,
                  width: map.image.width,
                  height: map.image.height,
                })),
              finite: Object.values(object.geometry.attributes).every(
                (attribute) => attribute.array.every(Number.isFinite)
              ),
            });
          });
          const frames = [];
          for (const fullbright of [false, true]) {
            graphics.fullbrightInspection = fullbright;
            graphics.update(0, 0, player.position);
            graphics.renderer.render(graphics.scene, camera);
            const gl = graphics.renderer.getContext();
            frames.push({
              fullbright,
              contextLost: gl.isContextLost(),
              error: gl.getError(),
              triangles: graphics.renderer.info.render.triangles,
              failedPrograms: graphics.renderer.info.programs.filter(
                (program) => program.diagnostics?.runnable === false
              ).length,
            });
          }
          results.push({ kind, picked: picked?.entity.kind, batches, frames });
        }
        return results;
      },
      { kinds, quality }
    );

    for (const record of records) {
      assert.equal(
        record.picked,
        record.kind,
        `${quality}/${record.kind}: model picking`
      );
      assert.ok(
        record.batches.length > 0 && record.batches.length <= 2,
        `${quality}/${record.kind}: bounded shared draw batches`
      );
      const textures = record.batches.flatMap((batch) => batch.textures);
      assert.ok(
        textures.length > 0,
        `${record.kind}: actual textured GPU material`
      );
      for (const texture of textures) {
        assert.ok(
          texture.width <= 512 && texture.height <= 512,
          "bounded skin atlas"
        );
      }
      const ids = [...new Set(textures.map((texture) => texture.id))].sort();
      expectedTextures ??= ids;
      assert.deepEqual(
        ids,
        expectedTextures,
        "species and quality reuse the same skin texture"
      );
      assert.ok(
        record.batches.every((batch) => batch.finite),
        "finite instance attributes"
      );
      for (const frame of record.frames) {
        assert.equal(frame.contextLost, false);
        assert.equal(frame.error, 0, `${record.kind}: WebGL error`);
        assert.equal(
          frame.failedPrograms,
          0,
          `${record.kind}: shader compile/link failure`
        );
        assert.ok(frame.triangles > 0);
      }
    }
    t.diagnostic(
      `${quality}: ${records.length} textured species, natural + Fullbright, picking and GPU checks pass`
    );
  }
  assert.deepEqual(errors, []);
});
