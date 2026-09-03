// Opt-in DOM interactions against the real app and domain in a disposable
// browser profile. This is not a substitute for the parent's visual QA pass.
// Run after publishing: node --test test/ui.browser.integration.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { chromeExecutable } from "./realtime/config.mjs";

const url = new URL(
  "/test/realtime/index.html?quality=low&seed=cedar-valley",
  process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173"
).href;

// Real world generation/WebGL and browser startup make this an integration test.
test("Java-style menus, HUD, finite slots, crafting and containers use real state", {
  timeout: 180000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(
    () => window.__voxelBot?.ready || window.__voxelBot?.error,
    undefined,
    { timeout: 60000 }
  );
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  const state = () =>
    page.evaluate(() => window.__voxelBot.game.gameplay.getState());
  const inventory = page.locator(".inventory-overlay");
  const slot = (index) =>
    inventory.locator(`[data-area="inventory"][data-index="${index}"]`);
  const closed = () =>
    page.waitForFunction(
      () =>
        !window.__voxelBot.game.ui.isInventoryOpen &&
        !window.__voxelBot.game.containerUI.isOpen
    );
  const openInventory = async () => {
    await page.keyboard.press("e");
    await inventory.waitFor({ state: "visible" });
  };
  const appleOwnership = () =>
    page.evaluate((id) => {
      const game = window.__voxelBot.game;
      const current = game.gameplay.getState();
      const count = (stacks) =>
        stacks.reduce(
          (total, stack) => total + (stack?.id === id ? stack.count : 0),
          0
        );
      const owned = count([
        ...current.slots,
        current.cursor,
        current.offhand,
        ...Object.values(current.equipment),
        ...current.craftingGrid,
      ]);
      const retained = count([
        ...game.pickups.serialize().items,
        ...game.overflow.serialize().entries,
      ]);
      return {
        slot0: current.slots[0],
        owned,
        retained,
        total: owned + retained,
      };
    }, ITEM.APPLE);
  const seedOwned = async (entries, mode = "survival") => {
    const ok = await page.evaluate(
      ({ entries, mode }) => {
        const game = window.__voxelBot.game;
        // Each seed starts an independent fixture in this disposable world.
        // Assert Q retention before reseeding; old drops must not refill the
        // next fixture's supplies while the real frame loop keeps running.
        if (
          !game.pickups.load({ version: 1, items: [] }) ||
          !game.overflow.load({ version: 1, entries: [] })
        )
          throw new Error("Could not reset disposable-world fixture drops");
        game.gameplay.setMode(mode);
        const success = game.gameplay.inventoryTransaction((draft) => {
          draft.slots = Array(36).fill(null);
          for (const [index, stack] of entries) draft.slots[index] = stack;
          draft.cursor = null;
          draft.offhand = null;
          draft.equipment = { head: null, chest: null, legs: null, feet: null };
          draft.craftingGrid = Array(9).fill(null);
          draft.craftingSize = 2;
          draft.experienceTotal = 31;
          return true;
        });
        game.gameplay.select(0);
        game.refreshHud();
        return success;
      },
      { entries, mode }
    );
    assert.equal(ok, true, "test supplies enter the actual domain transaction");
  };

  await page.locator(".settings-toggle").click();
  await page.locator(".controls-settings-button").click();
  await page.locator("#input-mode-setting").selectOption("remote");
  assert.match(await page.locator("#input-mode-help").innerText(), /Hold V/);
  await page.locator(".menu-back-button").click();
  await page.locator(".video-settings-button").click();
  await page.locator("#gui-scale-setting").selectOption("2");
  assert.equal(await page.locator("#ui").getAttribute("data-gui-scale"), "2");
  await page.locator("#fullbright-inspection-setting").check();
  assert.equal(
    await page.locator("#fullbright-inspection-badge").isVisible(),
    true
  );
  await page.locator("#fullbright-inspection-setting").uncheck();
  const preferences = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("voxelcraft-view-v1"))
  );
  assert.equal(preferences.guiScale, 2);
  assert.equal(preferences.fullbrightInspection, false);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator(".play-button").click();
  await page.waitForFunction(() => window.__voxelBot.game.active);
  assert.equal(await page.locator(".coordinates").isVisible(), false);
  await page.keyboard.press("F3");
  assert.equal(await page.locator(".coordinates").isVisible(), true);
  await page.keyboard.press("F3");
  await page.keyboard.press("F1");
  assert.equal(await page.locator(".game-hud").isHidden(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".menu-screen").isVisible(), true);
  assert.equal(await page.locator(".title-copy").isHidden(), true);
  await page.keyboard.press("F1");
  assert.equal(
    await page.locator(".menu-screen").isVisible(),
    true,
    "F1 cannot hide menus"
  );
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__voxelBot.game.active);

  await seedOwned([
    [0, { id: ITEM.APPLE, count: 5 }],
    [9, { id: ITEM.APPLE, count: 7 }],
    [10, { id: ITEM.WOOD_PICKAXE, count: 1, durability: 12 }],
    [11, { id: ITEM.WOOD_PICKAXE, count: 1, durability: 50 }],
  ]);
  await openInventory();
  assert.equal(await inventory.locator('[data-area="inventory"]').count(), 36);
  assert.equal(await inventory.locator('[data-area="crafting"]').count(), 4);
  await slot(0).click({ button: "right" });
  assert.equal((await state()).cursor.count, 3);
  assert.equal((await state()).slots[0].count, 2);
  await slot(18).click({ button: "right" });
  await slot(19).click();
  assert.equal((await state()).slots[18].count, 1);
  assert.equal((await state()).slots[19].count, 2);
  await slot(9).click({ modifiers: ["Shift"] });
  assert.equal((await state()).slots[0].count, 9);
  await slot(10).hover();
  await page.keyboard.press("2");
  assert.equal((await state()).slots[1].durability, 12);
  await slot(11).hover();
  await page.keyboard.press("f");
  assert.equal((await state()).offhand.durability, 50);
  await slot(0).hover();
  await page.keyboard.press("q");
  assert.deepEqual(
    await appleOwnership(),
    {
      slot0: { id: ITEM.APPLE, count: 8 },
      owned: 11,
      retained: 1,
      total: 12,
    },
    "Q retains its one dropped apple without losing ownership"
  );
  await page.keyboard.press("Control+q");
  assert.deepEqual(
    await appleOwnership(),
    { slot0: null, owned: 3, retained: 9, total: 12 },
    "Q and Control+Q retain all nine dropped apples before fixture cleanup"
  );
  await slot(18).click();
  await inventory.locator('[data-area="equipment"][data-index="0"]').click();
  assert.equal(
    (await state()).cursor.count,
    1,
    "rejected armor placement keeps ownership"
  );
  assert.equal(
    await inventory.locator(".inventory-status").getAttribute("data-state"),
    "error"
  );
  await inventory.locator(".inventory-close").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector(".inventory-overlay")
        .contains(document.activeElement)
    ),
    true
  );
  await page.keyboard.press("Escape");
  await closed();

  await seedOwned([[0, { id: ITEM.APPLE, count: 12 }]]);
  await openInventory();
  await slot(0).click();
  const points = await Promise.all(
    [9, 10, 11].map(async (index) => {
      const box = await slot(index).boundingBox();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })
  );
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y);
  await page.mouse.up();
  assert.deepEqual(
    (await state()).slots.slice(9, 12).map((stack) => stack?.count),
    [4, 4, 4]
  );
  await slot(9).dblclick();
  assert.equal((await state()).cursor.count, 12);
  await page.keyboard.press("e");
  await closed();
  assert.equal(
    (await state()).cursor,
    null,
    "E returns cursor contents through the domain"
  );

  await seedOwned([[9, { id: BLOCK.OAK_LOG, count: 2 }]]);
  await openInventory();
  await inventory.locator(".recipe-book-toggle").click();
  await inventory.locator('[data-recipe="planks"]').click();
  assert.equal((await state()).craftingGrid[0].id, BLOCK.OAK_LOG);
  assert.equal((await state()).craftingResult.count, 4);
  await inventory.locator('[data-area="result"]').click();
  assert.equal((await state()).cursor.count, 4);
  await slot(0).click();
  await page.keyboard.press("Escape");
  await closed();
  assert.equal((await state()).slots[0].id, BLOCK.PLANKS);
  assert.ok((await state()).craftingGrid.every((stack) => stack === null));

  await seedOwned([
    [9, { id: BLOCK.PLANKS, count: 3 }],
    [10, { id: ITEM.STICK, count: 2 }],
  ]);
  await page.evaluate((tableId) => {
    const game = window.__voxelBot.game;
    const p = game.player.position;
    const hit = {
      x: Math.floor(p.x) + 2,
      y: Math.floor(p.y),
      z: Math.floor(p.z),
      id: tableId,
    };
    game.world.set(hit.x, hit.y, hit.z, tableId);
    if (!game.openStation(hit))
      throw new Error("Could not open the real crafting table");
  }, BLOCK.CRAFTING_TABLE);
  assert.equal(await inventory.locator('[data-area="crafting"]').count(), 9);
  if (await inventory.locator(".recipe-book").isHidden())
    await inventory.locator(".recipe-book-toggle").click();
  await inventory.locator('[data-recipe="wood_pickaxe"]').click();
  await inventory
    .locator('[data-area="result"]')
    .click({ modifiers: ["Shift"] });
  assert.ok(
    (await state()).slots.some((stack) => stack?.id === ITEM.WOOD_PICKAXE)
  );
  await page.keyboard.press("Escape");
  await closed();
  assert.equal((await state()).craftingSize, 2);

  await seedOwned([], "creative");
  const originalPalette = (await state()).creativeHotbar;
  await openInventory();
  const search = inventory.locator(".inventory-search");
  await search.fill("apple");
  await page.keyboard.press("e");
  assert.equal(
    await inventory.isVisible(),
    true,
    "typing E in search does not close the inventory"
  );
  await search.fill("apple");
  await inventory
    .locator(`[data-area="catalog"][data-index="${ITEM.APPLE}"]`)
    .click();
  assert.equal((await state()).cursor.count, 64);
  await slot(0).click({ button: "right" });
  assert.equal((await state()).slots[0].count, 1);
  const editedPalette = [...originalPalette];
  editedPalette[0] = ITEM.APPLE;
  assert.deepEqual(
    (await state()).creativeHotbar,
    editedPalette,
    "an explicit owned-hotbar edit changes only its matching palette entry"
  );
  await inventory
    .locator(`[data-area="catalog"][data-index="${ITEM.APPLE}"]`)
    .hover();
  await page.keyboard.press("2");
  assert.equal((await state()).slots[1].count, 64);
  assert.equal((await state()).creativeHotbar[1], ITEM.APPLE);
  await page.keyboard.press("Escape");
  await closed();

  await seedOwned([
    [9, { id: ITEM.RAW_IRON, count: 2 }],
    [10, { id: ITEM.COAL, count: 1 }],
  ]);
  const containerOrigin = await page.evaluate(() => {
    const position = window.__voxelBot.game.player.position;
    return {
      x: Math.floor(position.x),
      y: Math.floor(position.y) + 1,
      z: Math.floor(position.z),
    };
  });
  const openContainer = async (id) => {
    const ok = await page.evaluate(
      ({ id, origin, offset }) => {
        const game = window.__voxelBot.game;
        const hit = {
          x: origin.x + offset,
          y: origin.y,
          z: origin.z,
          id,
        };
        game.world.set(hit.x, hit.y, hit.z, id);
        // A separate position for each container avoids changing its identity.
        if (id !== game.world.get(hit.x, hit.y, hit.z)) return false;
        return game.containerUI.open(
          game.world,
          hit,
          game.gameplay,
          game.settlement
        );
      },
      { id, origin: containerOrigin, offset: id === BLOCK.CHEST ? 2 : 5 }
    );
    assert.equal(ok, true);
    await page.locator(".settlement-overlay").waitFor({ state: "visible" });
  };
  await openContainer(BLOCK.CHEST);
  assert.equal(
    await page.locator('.settlement-chest [data-area="container"]').count(),
    27
  );
  await page
    .locator('.settlement-backpack [data-index="9"]')
    .click({ modifiers: ["Shift"] });
  assert.equal((await state()).slots[9], null);
  await page
    .locator('.settlement-chest [data-index="0"]')
    .click({ modifiers: ["Shift"] });
  assert.ok((await state()).slots.some((stack) => stack?.id === ITEM.RAW_IRON));
  await page.keyboard.press("e");
  await closed();
  await seedOwned([
    [9, { id: ITEM.RAW_IRON, count: 2 }],
    [10, { id: ITEM.COAL, count: 1 }],
  ]);
  // Use a distinct real block so the previous chest record remains valid.
  await openContainer(BLOCK.FURNACE);
  await page.locator('.settlement-backpack [data-index="9"]').click();
  await page.locator('.furnace-input [data-index="0"]').click();
  await page.locator('.settlement-backpack [data-index="10"]').click();
  await page.locator('.furnace-fuel [data-index="1"]').click();
  const progress = await page.evaluate(() => {
    const game = window.__voxelBot.game;
    game.settlement.update(5, game.world);
    game.containerUI.refresh();
    const { world, hit } = game.containerUI._session;
    const actual = game.settlement.getContainerState(world, hit, game.gameplay);
    return {
      actualCook: Math.round(actual.cookProgress * 100),
      displayedCook: Number(
        document.querySelector(".furnace-cook").getAttribute("aria-valuenow")
      ),
      actualBurn: Math.round(actual.burnProgress * 100),
      displayedBurn: Number(
        document.querySelector(".furnace-burn").getAttribute("aria-valuenow")
      ),
    };
  });
  assert.equal(progress.displayedCook, progress.actualCook);
  assert.equal(progress.displayedBurn, progress.actualBurn);
  assert.ok(progress.actualCook > 0);
  assert.ok(progress.actualBurn > 0 && progress.actualBurn < 100);
  await page.keyboard.press("Escape");
  await closed();
  await page.evaluate(() => {
    const game = window.__voxelBot.game;
    game.settlement.update(5, game.world);
  });
  await openContainer(BLOCK.FURNACE);
  assert.equal(
    await page.locator(".furnace-output .stack-slot").getAttribute("data-item"),
    String(ITEM.IRON_INGOT)
  );
  await page.locator(".furnace-output .stack-slot").click();
  assert.equal((await state()).cursor.id, ITEM.IRON_INGOT);
  await page.keyboard.press("Escape");
  await closed();
  await page.keyboard.press("Escape");
  await page.locator(".world-settings-button").click();
  const previousSeed = await page.evaluate(
    () => window.__voxelBot.game.world.seed
  );
  await page.locator(".import-file").setInputFiles({
    name: "invalid-ui-save.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":"invalid"}'),
  });
  await page
    .locator('.storage-status[data-state="error"]')
    .waitFor({ state: "visible" });
  assert.ok((await page.locator(".storage-status").innerText()).length > 0);
  await page.locator(".new-world-button").click();
  await page.locator("#world-seed").fill("do-not-replace-the-current-world");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator(".generate-button").click();
  await page.waitForFunction(
    () => document.querySelector(".generate-button").disabled === false
  );
  assert.equal(
    await page.evaluate(() => window.__voxelBot.game.world.seed),
    previousSeed
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: menu Escape/F1/F3, GUI preferences, half/one/quick move, hovered shortcuts, drag/collect, real crafting grids, Creative copy policy, chest slots and closed-screen furnace progress."
  );
});
