import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { ITEM } from "../src/items.js";
import { chromeExecutable } from "./realtime/config.mjs";

const configuredUrl = process.env.VOXELCRAFT_TEST_URL;
if (!configuredUrl) throw new Error("VOXELCRAFT_TEST_URL is required");
const url = new URL("/test/realtime/index.html?quality=low&seed=mob-potion-gui", configuredUrl);

test("rendered horse takes a trusted-input splash instead of mounting", {
  timeout: 120000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await page.goto(url.href, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(
    () => window.__voxelBot?.ready || window.__voxelBot?.error,
    undefined,
    { timeout: 60000 }
  );
  const setup = await page.evaluate(async (potionItem) => {
    const bot = window.__voxelBot, game = bot.game;
    const fixture = bot.fixture.prepareGround();
    const position = {
      x: fixture.spawn.x,
      y: fixture.floorY + 1,
      z: fixture.spawn.z - 3,
    };
    const horse = game.wildlife.spawn("horse", position, {
      id: "browser:potion-horse",
      restoring: true,
    });
    if (!horse) return null;
    game.player.yaw = 0;
    game.player.pitch = -0.25;
    game.player._syncCamera(0);
    await game.setMode("survival");
    game.gameplay.respawn();
    game.gameplay.inventoryTransaction((owned) => {
      owned.slots = Array(36).fill(null);
      owned.slots[0] = {
        id: potionItem,
        count: 1,
        data: {
          version: 1,
          potion: {
            id: "harming",
            form: "splash",
            extended: false,
            strong: false,
          },
        },
      };
      owned.offhand = null;
      return true;
    });
    game.select(0);
    game.updateTarget();
    game.graphics.render();
    return {
      id: horse.id,
      health: horse.health,
      targeted: game.mobTarget?.entity?.id ?? null,
    };
  }, ITEM.SPLASH_POTION);
  assert.ok(setup);
  assert.equal(setup.targeted, setup.id);
  await page.locator(".play-button").click();
  await page.waitForFunction(() => window.__voxelBot.game.active);
  await page.mouse.move(550, 380);
  await page.mouse.down({ button: "right" });
  await page.waitForTimeout(100);
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(1500);
  const result = await page.evaluate((id) => {
    const game = window.__voxelBot.game, horse = game.wildlife.byId.get(id);
    return {
      health: horse.health,
      mounted: game.horses.mountFor(),
      held: game.gameplay.getHandStack("main"),
    };
  }, setup.id);
  assert.deepEqual(result, { health: 18, mounted: null, held: null });
  await page.screenshot({
    path: "/opt/cursor/artifacts/mob_splash_horse_impact.png",
  });
});
