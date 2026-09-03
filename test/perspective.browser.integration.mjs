// Actual game/Chromium rendering and keyboard interactions in a disposable profile.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { BLOCK } from "../src/blocks.js";
import { chromeExecutable } from "./realtime/config.mjs";

const url = new URL(
  "/test/realtime/index.html?quality=low&seed=cedar-valley",
  process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173"
);

test("F5 renders the original player without moving physical aim; XP and offhand use real GPU state", {
  timeout: 120000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1100, height: 760 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.setDefaultTimeout(20000);
  await page.goto(url.href, { waitUntil: "load" });
  await page.waitForFunction(
    () => window.__voxelBot?.ready || window.__voxelBot?.error
  );
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  await page.locator(".play-button").click();
  await page.waitForFunction(
    () =>
      window.__voxelBot.game.active && window.__voxelBot.game.player.grounded
  );
  const original = await page.evaluate(() => {
    const { player } = window.__voxelBot.game;
    return {
      feet: player.position.toArray(),
      forward: player.forward.toArray(),
    };
  });

  for (const perspective of ["back", "front", "first"]) {
    await page.keyboard.press("F5");
    await page.waitForFunction((expected) => {
      const game = window.__voxelBot.game;
      return (
        game.player.perspective === expected &&
        game.playerVisual.visible === (expected !== "first")
      );
    }, perspective);
    const frame = await page.evaluate(() => {
      const { player, playerVisual, graphics } = window.__voxelBot.game;
      const viewDirection = graphics.camera.getWorldDirection(
        player.forward.clone()
      );
      return {
        feet: player.position.toArray(),
        forward: player.forward.toArray(),
        cameraDot: viewDirection.dot(player.forward),
        playerParts: playerVisual.mesh?.count ?? 0,
        errors: graphics.renderer.info.programs.filter(
          (program) => program.diagnostics?.runnable === false
        ).length,
      };
    });
    frame.feet.forEach((value, i) =>
      assert.ok(Math.abs(value - original.feet[i]) < 0.002)
    );
    frame.forward.forEach((value, i) =>
      assert.ok(Math.abs(value - original.forward[i]) < 1e-9)
    );
    assert.equal(frame.errors, 0);
    if (perspective === "front") assert.ok(frame.cameraDot < -0.99);
    else assert.ok(frame.cameraDot > 0.99);
    if (perspective !== "first") assert.ok(frame.playerParts > 0);
    else assert.equal(frame.playerParts, 0);
  }

  await page.keyboard.press("F1");
  await page.waitForFunction(
    () =>
      !window.__voxelBot.game.ui.isHudVisible &&
      !window.__voxelBot.game.effects.hand.visible
  );
  assert.equal(
    await page.evaluate(() => window.__voxelBot.game.effects.hand.visible),
    false
  );
  await page.keyboard.press("F1");
  await page.keyboard.press("F3");
  await page.waitForFunction(() => window.__voxelBot.game.ui.isDebugVisible);
  await page.keyboard.press("F3");

  // Controlled inventory/XP fixture in the real generated world; no performance
  // claim is made about setup or GPU inspection.
  const seeded = await page.evaluate(
    ({ dirt, torch }) => {
      const game = window.__voxelBot.game;
      if (
        !game.gameplay.inventoryTransaction((draft) => {
          draft.slots = Array.from({ length: 36 }, () => ({
            id: dirt,
            count: 64,
          }));
          draft.offhand = { id: torch, count: 8 };
          return true;
        })
      )
        throw new Error("Could not prepare full-inventory XP fixture");
      game.refreshHud();
      const p = game.player.position;
      const before = game.gameplay.getState();
      if (
        !game.experienceOrbs.spawn(
          5,
          { x: p.x + 3, y: p.y + 2, z: p.z - 2 },
          {
            pickupDelay: 60,
            velocity: { x: 0, y: 0, z: 0 },
          }
        )
      )
        throw new Error("Could not create a visible XP orb");
      if (
        !game.experienceOrbs.spawn(
          7,
          { x: p.x, y: p.y + 0.9, z: p.z },
          {
            velocity: { x: 0, y: 0, z: 0 },
          }
        )
      )
        throw new Error("Could not create a collectible XP orb");
      return { total: before.experience.total, slots: before.slots };
    },
    { dirt: BLOCK.DIRT, torch: BLOCK.TORCH }
  );
  await page.waitForFunction(
    (total) =>
      window.__voxelBot.game.gameplay.getState().experience.total === total + 7,
    seeded.total
  );
  const rendered = await page.evaluate(() => {
    const game = window.__voxelBot.game;
    const gl = game.graphics.renderer.getContext();
    return {
      slots: game.gameplay.getState().slots,
      offhand: game.effects.offhand.hand.visible,
      orbInstances: game.experienceOrbs.mesh.count,
      glError: gl.getError(),
      badPrograms: game.graphics.renderer.info.programs.filter(
        (program) => program.diagnostics?.runnable === false
      ).length,
    };
  });
  assert.deepEqual(
    rendered.slots,
    seeded.slots,
    "XP does not require or consume item capacity"
  );
  assert.equal(rendered.offhand, true);
  assert.ok(rendered.orbInstances > 0);
  assert.equal(rendered.glError, 0);
  assert.equal(rendered.badPrograms, 0);
  assert.deepEqual(errors, []);
  t.diagnostic(
    "Three perspectives, physical aim, F1/F3, offhand rendering and inventory-independent XP pass."
  );
});
