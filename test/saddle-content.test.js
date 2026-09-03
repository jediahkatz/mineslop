import assert from "node:assert/strict";
import test from "node:test";
import {
  bindFishingLootSymbols,
  FISHING_TREASURE_ADDITIONS,
} from "../src/content-bindings.js";
import { paintContentItem } from "../src/content-item-art.js";
import {
  compileFishingLootTables,
  DEFAULT_FISHING_TABLES,
  fishingCategoryWeights,
  rollFishingCatch,
} from "../src/fishing-loot.js";
import { Gameplay } from "../src/gameplay.js";
import { usesHeldSprite } from "../src/held-item.js";
import { isValidStack, normalizeStack } from "../src/inventory-slots.js";
import { getItem, isBlockItem, ITEM } from "../src/items.js";
import { getRecipe } from "../src/recipes.js";
import { itemTexturePixels } from "../src/textures.js";
import { createWorldContext } from "../src/world-spec.js";

function emptyGameplay(t) {
  const gameplay = new Gameplay();
  t.after(() => gameplay.dispose());
  assert.equal(gameplay.inventoryTransaction((draft) => {
    draft.slots.fill(null);
    draft.craftingGrid.fill(null);
    draft.cursor = null;
    return true;
  }), true);
  return gameplay;
}

test("the appended saddle is one non-placeable equipment item with lossless named metadata", () => {
  assert.equal(ITEM.SADDLE, 65633);
  assert.equal(ITEM.ROTTEN_FLESH, 65632);
  const item = getItem(ITEM.SADDLE);
  assert.equal(item.name, "Saddle");
  assert.equal(item.kind, "equipment");
  assert.equal(item.saddle, true);
  assert.equal(item.stackSize, 1);
  assert.equal(item.durability, undefined);
  assert.equal(item.armorSlot, undefined);
  assert.equal(isBlockItem(item.id), false);
  assert.equal(usesHeldSprite(item.id), true);
  const stack = {
    id: item.id, count: 1, data: { version: 1, name: "Trail saddle" },
  };
  assert.deepEqual(normalizeStack(stack), stack);
  assert.equal(isValidStack(stack), true);
  assert.equal(isValidStack({ ...stack, count: 2 }), false);
});

test("table crafting consumes exactly three leather and one iron, only once", (t) => {
  const gameplay = emptyGameplay(t);
  gameplay.add(ITEM.LEATHER, 3);
  gameplay.add(ITEM.IRON_INGOT, 1);
  const recipe = getRecipe("saddle");
  assert.equal(recipe.station, "table");
  assert.deepEqual(recipe.pattern, ["LLL", " I "]);
  const before = gameplay.serialize();
  assert.equal(gameplay.inventoryAction({ type: "fillRecipe", recipeId: "saddle" }).ok, false);
  assert.deepEqual(gameplay.serialize(), before, "The personal grid cannot make a saddle");
  assert.equal(gameplay.setCraftingSize(3), true);
  assert.equal(gameplay.inventoryAction({ type: "fillRecipe", recipeId: "saddle" }).ok, true);
  assert.deepEqual(gameplay.getState().craftingResult, { id: ITEM.SADDLE, count: 1 });
  assert.equal(gameplay.count(ITEM.SADDLE), 0, "Previewing is not acquiring an item");
  assert.equal(gameplay.inventoryAction({ type: "takeCraftResult" }).ok, true);
  assert.deepEqual(gameplay.cursor, { id: ITEM.SADDLE, count: 1 });
  const crafted = gameplay.serialize();
  assert.equal(gameplay.inventoryAction({ type: "takeCraftResult" }).ok, false);
  assert.deepEqual(gameplay.serialize(), crafted);
  assert.equal(gameplay.inventoryAction({ type: "close" }).ok, true);
  assert.equal(gameplay.count(ITEM.SADDLE), 1);
  assert.equal(gameplay.count(ITEM.LEATHER), 0);
  assert.equal(gameplay.count(ITEM.IRON_INGOT), 0);
});

test("a missing leather payment cannot partially fill or mint a saddle", (t) => {
  const gameplay = emptyGameplay(t);
  gameplay.add(ITEM.LEATHER, 2);
  gameplay.add(ITEM.IRON_INGOT, 1);
  assert.equal(gameplay.setCraftingSize(3), true);
  const before = gameplay.serialize();
  assert.equal(gameplay.inventoryAction({ type: "fillRecipe", recipeId: "saddle" }).ok, false);
  assert.deepEqual(gameplay.serialize(), before);
});

test("the real composed fishing table can award one saddle only from treasure", () => {
  const context = createWorldContext({ seed: "saddle-loot", generatorVersion: 4 });
  const tables = compileFishingLootTables(bindFishingLootSymbols({
    ...DEFAULT_FISHING_TABLES,
    treasure: [...DEFAULT_FISHING_TABLES.treasure, ...FISHING_TREASURE_ADDITIONS],
  }), context);
  assert.equal(tables.treasure.filter((entry) => entry.item === "SADDLE").length, 1);
  assert.equal(tables.fish.some((entry) => entry.item === "SADDLE"), false);
  assert.equal(tables.junk.some((entry) => entry.item === "SADDLE"), false);
  assert.equal(fishingCategoryWeights(3, false).treasure, 0);
  let reward = null;
  for (let state = 0; state < 4096 && reward === null; state++) {
    const rolled = rollFishingCatch(state, { luck: 3, openWater: true, tables, context });
    if (rolled.item === "SADDLE") reward = rolled;
  }
  assert.ok(reward, "The registered saddle must be reachable through the actual loot resolver");
  assert.equal(reward.category, "treasure");
  assert.deepEqual(reward.stack, { id: ITEM.SADDLE, count: 1 });
  assert.ok(reward.experience >= 1 && reward.experience <= 6);
});

test("the actual saddle sprite uses its authored leather seat and metal stirrups", () => {
  const expected = new Uint8ClampedArray(16 * 16 * 4);
  assert.equal(paintContentItem(expected, { kind: "saddle" }), true);
  const actual = itemTexturePixels(ITEM.SADDLE);
  assert.deepEqual(actual, expected);
  assert.notDeepEqual(actual, itemTexturePixels(ITEM.LEATHER));
  let opaque = 0, metal = 0;
  for (let i = 0; i < actual.length; i += 4) {
    assert.ok(actual[i + 3] === 0 || actual[i + 3] === 255);
    if (actual[i + 3]) opaque++;
    if (actual[i] === 158 && actual[i + 1] === 166 && actual[i + 2] === 162)
      metal++;
  }
  assert.ok(opaque > 40 && opaque < 200);
  assert.ok(metal >= 2, "Both stirrups have real metal pixels");
});
