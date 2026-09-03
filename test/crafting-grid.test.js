import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  consumeCraftingInputs,
  matchCraftingRecipe,
  planRecipeFill,
  recipeLayout,
} from "../src/crafting.js";
import { Gameplay } from "../src/gameplay.js";
import { cloneSlots } from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import { getRecipe, RECIPES } from "../src/recipes.js";

const stack = (id, count = 1) => ({
  id,
  count,
  ...(getItem(id).durability ? { durability: getItem(id).durability } : {}),
});
const grid = () => Array(9).fill(null);

test("every instantaneous recipe has a genuine match whose cells equal its accounting cost", () => {
  for (const recipe of RECIPES.filter((entry) => !entry.duration)) {
    const size = recipe.station === "hand" ? 2 : 3;
    const input = grid();
    const costs = new Map();
    for (const cell of recipeLayout(recipe, size)) {
      input[cell.index] = stack(cell.ingredient.id);
      costs.set(cell.ingredient.id, (costs.get(cell.ingredient.id) ?? 0) + 1);
    }
    assert.deepEqual(
      [...costs].sort(([a], [b]) => a - b),
      recipe.ingredients
        .map(({ id, count }) => [id, count])
        .sort(([a], [b]) => a - b),
      recipe.id
    );
    const before = cloneSlots(input);
    const match = matchCraftingRecipe(input, size);
    assert.equal(match?.recipe.id, recipe.id, recipe.id);
    assert.equal(match.output.id, recipe.output.id);
    assert.equal(match.output.count, recipe.output.count);
    assert.deepEqual(
      input,
      before,
      "reading the result cannot debit ingredients"
    );
    consumeCraftingInputs(input, match);
    assert.ok(
      input.every((entry) => entry === null),
      recipe.id
    );
  }
});

test("shaped recipes permit valid offsets and horizontal mirrors, not rotations or extra cells", () => {
  const input = grid();
  input[4] = stack(BLOCK.PLANKS, 3);
  input[7] = stack(BLOCK.PLANKS, 2);
  assert.equal(matchCraftingRecipe(input, 3)?.recipe.id, "sticks");
  input[4] = null;
  input[7] = null;
  // A mirrored axe, with its stick on the left rather than the right.
  for (const i of [0, 1, 4]) input[i] = stack(BLOCK.PLANKS);
  for (const i of [3, 6]) input[i] = stack(ITEM.STICK);
  assert.equal(matchCraftingRecipe(input, 3)?.recipe.id, "wood_axe");
  input[8] = stack(BLOCK.DIRT);
  assert.equal(matchCraftingRecipe(input, 3), null);
  const horizontal = grid();
  horizontal[0] = horizontal[1] = stack(BLOCK.PLANKS);
  assert.equal(
    matchCraftingRecipe(horizontal, 2),
    null,
    "two horizontal planks are not sticks"
  );
});

test("shapeless ingredients work in any cells and alternatives retain their exact IDs", () => {
  const input = grid();
  input[8] = stack(ITEM.IRON_INGOT);
  input[2] = stack(ITEM.FLINT);
  assert.equal(matchCraftingRecipe(input, 3)?.recipe.id, "flint_and_steel");
  const tnt = grid();
  const recipe = getRecipe("tnt");
  for (const { index, ingredient } of recipeLayout(recipe, 3)) {
    tnt[index] = stack(
      ingredient.id === BLOCK.SAND && index < 4 ? BLOCK.RED_SAND : ingredient.id
    );
  }
  assert.equal(matchCraftingRecipe(tnt, 3)?.recipe.id, "tnt");
  const logs = grid();
  logs[3] = stack(BLOCK.CHERRY_LOG, 2);
  const match = matchCraftingRecipe(logs, 2);
  assert.equal(match?.recipe.id, "cherry_planks");
  assert.deepEqual(match.output, stack(BLOCK.CHERRY_PLANKS, 4));
  consumeCraftingInputs(logs, match);
  assert.deepEqual(logs[3], stack(BLOCK.CHERRY_LOG));
});

test("personal indices are compact 0..3 and a station query never unlocks a table grid", () => {
  const input = grid();
  input[1] = input[3] = stack(BLOCK.PLANKS);
  assert.equal(matchCraftingRecipe(input, 2)?.recipe.id, "sticks");
  input[8] = stack(ITEM.APPLE);
  assert.equal(matchCraftingRecipe(input, 2), null);
  const game = new Gameplay();
  game.add(BLOCK.PLANKS, 3);
  game.add(ITEM.STICK, 2);
  game.getCraftableRecipes(["table", "furnace"]);
  const before = game.serialize();
  assert.equal(
    game.inventoryAction({ type: "fillRecipe", recipeId: "wood_pickaxe" }).ok,
    false
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(game.setCraftingSize(3), true);
  assert.equal(
    game.inventoryAction({ type: "fillRecipe", recipeId: "wood_pickaxe" }).ok,
    true
  );
  assert.equal(game.getState().craftingResult.id, ITEM.WOOD_PICKAXE);
  assert.equal(game.count(ITEM.WOOD_PICKAXE), 0);
});

test("manual personal crafting transfers inputs, exposes a preview, then consumes exactly once", () => {
  const game = new Gameplay();
  game.add(BLOCK.PLANKS, 4);
  const plankSlot = game.slots.findIndex((entry) => entry?.id === BLOCK.PLANKS);
  assert.equal(
    game.inventoryAction({
      type: "click",
      area: "inventory",
      index: plankSlot,
      button: 0,
    }).ok,
    true
  );
  for (let index = 0; index < 4; index++) {
    assert.equal(
      game.inventoryAction({
        type: "click",
        area: "crafting",
        index,
        button: 2,
      }).ok,
      true
    );
  }
  assert.equal(game.cursor, null);
  assert.deepEqual(game.getState().craftingResult, stack(BLOCK.CRAFTING_TABLE));
  assert.equal(game.count(BLOCK.CRAFTING_TABLE), 0);
  assert.equal(game.inventoryAction({ type: "takeCraftResult" }).ok, true);
  assert.deepEqual(game.cursor, stack(BLOCK.CRAFTING_TABLE));
  assert.ok(game.getState().craftingGrid.every((entry) => entry === null));
  const before = game.serialize();
  assert.equal(game.inventoryAction({ type: "takeCraftResult" }).ok, false);
  assert.deepEqual(game.serialize(), before);
  assert.equal(game.inventoryAction({ type: "close" }).ok, true);
  assert.equal(game.count(BLOCK.CRAFTING_TABLE), 1);
  assert.equal(game.count(BLOCK.PLANKS), 0);
});

test("the recipe book fills owned cells and cannot directly mint an output", () => {
  const game = new Gameplay();
  game.add(BLOCK.OAK_LOG, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(
      game.inventoryAction({ type: "fillRecipe", recipeId: "planks" }).ok,
      true
    );
    assert.equal(game.count(BLOCK.PLANKS), 0);
    assert.equal(game.count(BLOCK.OAK_LOG), 1);
    assert.deepEqual(game.getState().craftingGrid[0], stack(BLOCK.OAK_LOG));
  }
  assert.equal(
    game.inventoryAction({ type: "takeCraftResult", shift: true }).ok,
    true
  );
  assert.equal(game.count(BLOCK.PLANKS), 4);
  assert.equal(game.count(BLOCK.OAK_LOG), 1);
  const before = game.serialize();
  assert.equal(
    game.inventoryAction({ type: "fillRecipe", recipeId: "iron_ingot" }).ok,
    false
  );
  assert.deepEqual(game.serialize(), before);
});

test("shift extraction stops before overfilling and only consumes recipes that actually fit", () => {
  const game = new Gameplay();
  assert.equal(
    game.inventoryTransaction((draft) => {
      draft.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
      draft.slots[35] = stack(ITEM.STICK, 60);
      draft.craftingGrid[0] = stack(BLOCK.PLANKS, 3);
      draft.craftingGrid[2] = stack(BLOCK.PLANKS, 3);
      return true;
    }),
    true
  );
  assert.equal(
    game.inventoryAction({ type: "takeCraftResult", shift: true }).ok,
    true
  );
  assert.equal(game.slots[35].count, 64);
  assert.equal(game.getState().craftingGrid[0].count, 2);
  assert.equal(game.getState().craftingGrid[2].count, 2);
  const before = game.serialize();
  assert.equal(
    game.inventoryAction({ type: "takeCraftResult", shift: true }).ok,
    false
  );
  assert.deepEqual(game.serialize(), before);
});

test("a mismatched or nearly-full cursor blocks an entire output without losing inputs", () => {
  const game = new Gameplay();
  game.add(BLOCK.OAK_LOG);
  game.inventoryAction({ type: "fillRecipe", recipeId: "planks" });
  for (const cursor of [stack(ITEM.APPLE), stack(BLOCK.PLANKS, 63)]) {
    game.inventoryTransaction((draft) => {
      draft.cursor = cursor;
      return true;
    });
    const before = game.serialize();
    assert.equal(game.inventoryAction({ type: "takeCraftResult" }).ok, false);
    assert.deepEqual(game.serialize(), before);
  }
});

test("book filling reuses grid inputs before returning leftovers to a full inventory", () => {
  const slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
  const input = grid();
  for (let i = 0; i < 4; i++) input[i] = stack(BLOCK.PLANKS);
  const beforeSlots = cloneSlots(slots);
  const beforeGrid = cloneSlots(input);
  const plan = planRecipeFill(slots, input, 2, getRecipe("crafting_table"));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.craftingGrid, input);
  assert.deepEqual(slots, beforeSlots);
  assert.deepEqual(input, beforeGrid);
  const noRoom = planRecipeFill(slots, input, 2, getRecipe("sticks"));
  assert.equal(
    noRoom.ok,
    false,
    "the two leftover planks must be retained somewhere"
  );
  assert.deepEqual(slots, beforeSlots);
  assert.deepEqual(input, beforeGrid);
});

test("Creative grid crafting still requires finite inputs; legacy Creative craft only changes its palette", () => {
  const game = new Gameplay({ mode: "creative" });
  game.setCraftingSize(3);
  const before = game.serialize();
  assert.equal(
    game.inventoryAction({ type: "fillRecipe", recipeId: "diamond_pickaxe" })
      .ok,
    false
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(game.craft("diamond_pickaxe").ok, true);
  assert.equal(game.selectedItem.id, ITEM.DIAMOND_PICKAXE);
  assert.equal(game.count(ITEM.DIAMOND_PICKAXE), 0);
  assert.deepEqual(game.slots, before.slots);
});
