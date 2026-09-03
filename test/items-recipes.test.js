import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCK_CATALOG, BLOCKS } from "../src/blocks.js";
import { Gameplay, MAX_CRAFT_QUEUE } from "../src/gameplay.js";
import { FUEL_ITEMS, getItem, ITEM, ITEMS, LOG_ITEMS } from "../src/items.js";
import { getRecipe, RECIPES } from "../src/recipes.js";

test("every block and recipe resolves to a unique, usable catalog entry", () => {
  assert.equal(new Set(ITEMS.map((item) => item.id)).size, ITEMS.length);
  assert.equal(
    new Set(RECIPES.map((recipe) => recipe.id)).size,
    RECIPES.length
  );
  for (const block of BLOCK_CATALOG) {
    assert.equal(getItem(block.id).blockId, block.id);
    assert.equal(getItem(block.id).name, block.name);
  }
  for (const item of ITEMS) {
    assert.ok(Number.isInteger(item.id));
    assert.equal(item.kind === "block", BLOCKS[item.id] !== undefined);
    if (item.kind === "block") assert.equal(item.blockId, item.id);
    assert.ok(item.name && item.color);
    assert.ok(Number.isSafeInteger(item.stackSize) && item.stackSize > 0);
    if (item.durability) assert.equal(item.stackSize, 1);
  }
  for (const recipe of RECIPES) {
    assert.equal(getRecipe(recipe.id), recipe);
    assert.ok(getItem(recipe.output.id));
    assert.ok(recipe.output.count > 0 && Number.isInteger(recipe.output.count));
    assert.ok(["hand", "table", "furnace"].includes(recipe.station));
    assert.equal(recipe.duration > 0, recipe.station === "furnace");
    for (const input of recipe.ingredients) {
      assert.ok(input.count > 0 && Number.isInteger(input.count));
      const ids = [input.id, ...(input.alternatives ?? [])];
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ids) assert.ok(getItem(id), `${recipe.id}: input ${id}`);
    }
  }
  for (const id of FUEL_ITEMS)
    assert.ok(Number.isFinite(getItem(id).fuel) && getItem(id).fuel > 0);
  assert.equal(getItem(9999), null);
  assert.equal(getItem("256"), null);
});

test("every recipe consumes its complete cost and creates exactly its declared output", () => {
  for (const recipe of RECIPES) {
    const game = new Gameplay();
    game.consume(ITEM.APPLE, 4);
    for (const input of recipe.ingredients)
      assert.equal(game.add(input.id, input.count), true);
    if (recipe.duration) game.add(ITEM.COAL, 1);
    const result = game.craft(recipe.id, { station: recipe.station });
    assert.equal(result.ok, true, recipe.id);
    assert.equal(result.queued, recipe.duration > 0, recipe.id);
    if (recipe.duration) {
      assert.deepEqual(
        game.getState().inventory,
        [],
        `${recipe.id} reserves all materials`
      );
      game.update(recipe.duration);
    }
    assert.deepEqual(
      game.getState().inventory,
      [{ ...recipe.output }],
      `${recipe.id} does not duplicate inputs or its output`
    );
    const before = game.serialize();
    assert.equal(
      game.craft(recipe.id, { station: recipe.station }).ok,
      false,
      recipe.id
    );
    assert.deepEqual(game.serialize(), before);
  }
});

test("all biome logs supply four matching planks without silently spending a different wood", () => {
  const families = [
    ["planks", BLOCK.OAK_LOG, BLOCK.PLANKS],
    ["birch_planks", BLOCK.BIRCH_LOG, BLOCK.BIRCH_PLANKS],
    ["spruce_planks", BLOCK.SPRUCE_LOG, BLOCK.SPRUCE_PLANKS],
    ["acacia_planks", BLOCK.ACACIA_LOG, BLOCK.ACACIA_PLANKS],
    ["jungle_planks", BLOCK.JUNGLE_LOG, BLOCK.JUNGLE_PLANKS],
    ["cherry_planks", BLOCK.CHERRY_LOG, BLOCK.CHERRY_PLANKS],
    ["dark_oak_planks", BLOCK.DARK_OAK_LOG, BLOCK.DARK_OAK_PLANKS],
    ["pale_oak_planks", BLOCK.PALE_LOG, BLOCK.PALE_OAK_PLANKS],
    ["mangrove_planks", BLOCK.MANGROVE_LOG, BLOCK.MANGROVE_PLANKS],
    ["crimson_planks", BLOCK.CRIMSON_STEM, BLOCK.CRIMSON_PLANKS],
    ["warped_planks", BLOCK.WARPED_STEM, BLOCK.WARPED_PLANKS],
  ];
  assert.deepEqual(new Set(families.map(([, id]) => id)), new Set(LOG_ITEMS));
  for (const [recipeId, id, planks] of families) {
    const game = new Gameplay();
    const otherLog = id === BLOCK.OAK_LOG ? BLOCK.BIRCH_LOG : BLOCK.OAK_LOG;
    assert.equal(game.add(id, 1), true);
    assert.equal(game.add(otherLog, 1), true);
    assert.equal(game.craft(recipeId).ok, true, recipeId);
    assert.equal(game.count(id), 0);
    assert.equal(game.count(planks), 4);
    assert.equal(game.count(otherLog), 1);
    if (planks !== BLOCK.PLANKS) assert.equal(game.count(BLOCK.PLANKS), 0);
    const before = game.serialize();
    assert.equal(game.craft(recipeId).reason, "ingredients", recipeId);
    assert.deepEqual(game.serialize(), before);
  }
  const mixed = new Gameplay();
  mixed.add(BLOCK.SAND, 2);
  mixed.add(BLOCK.RED_SAND, 2);
  mixed.add(ITEM.GUNPOWDER, 5);
  assert.equal(mixed.craft("tnt", { station: "table" }).ok, true);
  assert.equal(mixed.count(BLOCK.SAND), 0);
  assert.equal(mixed.count(BLOCK.RED_SAND), 0);
  assert.equal(mixed.count(ITEM.GUNPOWDER), 0);
  assert.equal(mixed.count(BLOCK.TNT), 1);
});

test("holding a station is not proximity, and the furnace is not a crafting table", () => {
  const game = new Gameplay();
  game.add(BLOCK.CRAFTING_TABLE, 1);
  game.add(BLOCK.PLANKS, 3);
  game.add(ITEM.STICK, 2);
  const before = game.serialize();
  for (const station of ["hand", "furnace", "table-ish", []]) {
    assert.equal(game.craft("wood_pickaxe", { station }).reason, "station");
    assert.deepEqual(game.serialize(), before);
  }
  assert.equal(
    game.craft("wood_pickaxe", { station: ["table", "furnace"] }).ok,
    true
  );
  assert.equal(game.count(ITEM.WOOD_PICKAXE), 1);
  assert.equal(game.count(BLOCK.CRAFTING_TABLE), 1);
});

test("failed crafting and recipe affordability queries never consume partial costs", () => {
  const game = new Gameplay();
  game.add(BLOCK.PLANKS, 2);
  game.add(ITEM.STICK, 2);
  const before = game.serialize();
  const options = game.getCraftableRecipes("table");
  const pick = options.find((recipe) => recipe.id === "wood_pickaxe");
  const ingredients = getRecipe("wood_pickaxe").ingredients;
  assert.deepEqual(
    ingredients.map(({ id, count }) => ({ id, count })),
    [
      { id: BLOCK.PLANKS, count: 3 },
      { id: ITEM.STICK, count: 2 },
    ]
  );
  assert.equal(pick.canCraft, false);
  assert.deepEqual(pick.missing, [
    { ...ingredients[0], needed: 1, owned: 2 },
  ]);
  assert.equal(
    game.craft("wood_pickaxe", { station: "table" }).reason,
    "ingredients"
  );
  assert.equal(game.craft("not_a_recipe").reason, "unknown_recipe");
  assert.deepEqual(game.serialize(), before);
});

test("craftable snapshots show family-specific ingredients and fuel costs", () => {
  const game = new Gameplay();
  game.add(BLOCK.BIRCH_LOG, 1);
  let recipes = game.getCraftableRecipes("hand");
  const planks = recipes.find((recipe) => recipe.id === "birch_planks");
  assert.equal(planks.canCraft, true);
  assert.deepEqual(planks.ingredients, [{ id: BLOCK.BIRCH_LOG, count: 1 }]);
  assert.deepEqual(planks.output, { id: BLOCK.BIRCH_PLANKS, count: 4 });
  assert.equal(
    recipes.find((recipe) => recipe.id === "planks").canCraft,
    false
  );
  game.consume(BLOCK.BIRCH_LOG, 1);
  game.add(ITEM.RAW_IRON, 2);
  recipes = game.getCraftableRecipes("furnace");
  const unfueled = recipes.find((recipe) => recipe.id === "iron_ingot");
  assert.equal(unfueled.canCraft, false);
  assert.equal(unfueled.reasonCode, "fuel");
  assert.match(unfueled.reason, /coal/);
  assert.deepEqual(unfueled.fuel, [{ id: ITEM.COAL, count: 1 }]);
  game.add(ITEM.COAL, 1);
  const ready = game
    .getCraftableRecipes("furnace")
    .find((recipe) => recipe.id === "iron_ingot");
  assert.equal(ready.canCraft, true);
  assert.deepEqual(ready.fuel, [{ id: ITEM.COAL, count: 1 }]);
  game.craft("iron_ingot", { station: "furnace" });
  const fueled = game
    .getCraftableRecipes("furnace")
    .find((recipe) => recipe.id === "iron_ingot");
  assert.equal(fueled.canCraft, true);
  assert.deepEqual(fueled.fuel, []);
  assert.equal(game.getState().fuelTime, 70);
});

test("a single coal funds eight serial smelts, and a ninth cannot spend absent fuel", () => {
  const game = new Gameplay();
  game.add(ITEM.RAW_IRON, 9);
  game.add(ITEM.COAL, 1);
  for (let i = 0; i < 8; i++)
    assert.equal(game.craft("iron_ingot", { station: "furnace" }).ok, true);
  assert.equal(game.count(ITEM.COAL), 0);
  assert.equal(game.count(ITEM.RAW_IRON), 1);
  assert.equal(game.count(ITEM.IRON_INGOT), 0);
  assert.equal(game.getState().fuelTime, 0);
  const before = game.serialize();
  assert.equal(game.craft("iron_ingot", { station: "furnace" }).reason, "fuel");
  assert.deepEqual(game.serialize(), before);
  game.update(5);
  assert.equal(game.getState().crafting[0].progress, 0.5);
  assert.equal(game.getState().crafting[1].progress, 0);
  assert.equal(game.count(ITEM.IRON_INGOT), 0);
  game.update(5);
  assert.equal(game.count(ITEM.IRON_INGOT), 1);
  game.update(60);
  game.update(10);
  assert.equal(game.count(ITEM.IRON_INGOT), 8);
  assert.equal(game.getState().crafting.length, 0);
  game.update(60);
  assert.equal(game.count(ITEM.IRON_INGOT), 8);
});

test("wood cannot simultaneously be a charcoal ingredient and its own fuel", () => {
  const game = new Gameplay();
  game.add(BLOCK.OAK_LOG, 1);
  const before = game.serialize();
  assert.equal(game.craft("charcoal", { station: "furnace" }).reason, "fuel");
  assert.deepEqual(game.serialize(), before);
  game.add(BLOCK.OAK_LOG, 1);
  assert.equal(game.craft("charcoal", { station: "furnace" }).ok, true);
  assert.equal(game.count(BLOCK.OAK_LOG), 0);
  assert.equal(game.getState().fuelTime, 5);
  game.update(10);
  assert.equal(game.count(ITEM.COAL), 1);
});

test("sticks and bamboo are counted as fuel, and surplus burn time is retained", () => {
  const game = new Gameplay();
  game.add(ITEM.RAW_BEEF, 2);
  game.add(ITEM.STICK, 1);
  game.add(BLOCK.BAMBOO, 2);
  assert.equal(game.craft("steak", { station: "furnace" }).ok, true);
  assert.equal(game.count(ITEM.STICK), 0);
  assert.equal(game.count(BLOCK.BAMBOO), 0);
  assert.equal(game.getState().fuelTime, 0);
  const before = game.serialize();
  assert.equal(game.craft("steak", { station: "furnace" }).reason, "fuel");
  assert.deepEqual(game.serialize(), before);
  game.update(10);
  assert.equal(game.count(ITEM.STEAK), 1);
});

test("furnace queue capacity fails atomically without charging for an extra job", () => {
  const game = new Gameplay();
  game.add(ITEM.RAW_CHICKEN, MAX_CRAFT_QUEUE + 1);
  game.add(ITEM.COAL, 3);
  for (let i = 0; i < MAX_CRAFT_QUEUE; i++) {
    assert.equal(game.craft("cooked_chicken", { station: "furnace" }).ok, true);
  }
  const before = game.serialize();
  assert.equal(
    game.craft("cooked_chicken", { station: "furnace" }).reason,
    "queue_full"
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(game.count(ITEM.COAL), 1);
  assert.equal(game.count(ITEM.RAW_CHICKEN), 1);
});

test("instant crafting must have output space after the ingredients are consumed", () => {
  const game = new Gameplay();
  game.add(BLOCK.DIRT, 64 * 34);
  game.add(BLOCK.PLANKS, 3);
  assert.equal(game.getState().inventorySlotsUsed, 36);
  const before = game.serialize();
  assert.equal(game.craft("sticks").reason, "inventory_full");
  assert.deepEqual(game.serialize(), before);
  game.consume(BLOCK.PLANKS, 1);
  assert.equal(
    game.craft("sticks").ok,
    true,
    "using the last ingredient stack frees its slot"
  );
  assert.equal(game.count(ITEM.STICK), 4);
  assert.equal(game.getState().inventorySlotsUsed, 36);
});

test("queued furnace output reserves its slot against later pickups", () => {
  const game = new Gameplay();
  game.consume(ITEM.APPLE, 4);
  game.add(BLOCK.DIRT, 64 * 34);
  game.add(ITEM.RAW_IRON, 2);
  game.add(ITEM.COAL, 1);
  assert.equal(game.craft("iron_ingot", { station: "furnace" }).ok, true);
  assert.equal(game.getState().inventorySlotsUsed, 35);
  const before = game.serialize();
  assert.equal(game.add(BLOCK.COBBLESTONE, 1), false);
  assert.deepEqual(game.serialize(), before);
  game.update(10);
  assert.equal(game.count(ITEM.IRON_INGOT), 1);
  assert.equal(game.getState().inventorySlotsUsed, 36);
  assert.equal(game.craft("iron_ingot", { station: "furnace" }).ok, true);
  game.update(10);
  assert.equal(game.count(ITEM.IRON_INGOT), 2);
});
