import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  consumeCraftingInputs,
  matchCraftingRecipe,
  matchesIngredient,
  planRecipeFill,
  recipeOutput,
} from "../src/crafting.js";
import { fitsQueuedOutputs } from "../src/gameplay-save.js";
import { emptyOwnedInventory, returnInputs } from "../src/inventory-domain.js";
import { cloneSlots, cloneStack } from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import { getRecipe } from "../src/recipes.js";

const name = (value) => ({ version: 1, name: value });
const named = (id, count, value) => ({ id, count, data: name(value) });
const emptyGrid = () => Array(9).fill(null);
const emptySlots = () => Array(36).fill(null);

test("generic shaped and shapeless recipes never silently consume decorated inputs", () => {
  const logs = emptyGrid();
  logs[0] = named(BLOCK.OAK_LOG, 2, "Do not saw");
  const before = cloneSlots(logs);
  assert.equal(matchCraftingRecipe(logs, 2), null);
  assert.deepEqual(logs, before);
  assert.equal(matchesIngredient(logs[0], { id: BLOCK.OAK_LOG }), false);
  logs[0] = { id: BLOCK.OAK_LOG, count: 2 };
  assert.equal(matchCraftingRecipe(logs, 2)?.recipe.id, "planks");

  const input = emptyGrid();
  input[0] = named(ITEM.IRON_INGOT, 1, "Do not forge");
  input[3] = { id: ITEM.FLINT, count: 1 };
  assert.equal(matchCraftingRecipe(input, 2), null);
  input[0] = { id: ITEM.IRON_INGOT, count: 1 };
  assert.equal(matchCraftingRecipe(input, 2)?.recipe.id, "flint_and_steel");
});

test("recipe filling chooses eligible plain inputs and returns decorated escrow losslessly", () => {
  const slots = emptySlots();
  slots[0] = named(BLOCK.OAK_LOG, 3, "keep");
  slots[1] = { id: BLOCK.OAK_LOG, count: 1 };
  const grid = emptyGrid();
  grid[0] = named(BLOCK.OAK_LOG, 2, "keep");
  const before = { slots: cloneSlots(slots), grid: cloneSlots(grid) };
  const plan = planRecipeFill(slots, grid, 2, getRecipe("planks"));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.craftingGrid[0], { id: BLOCK.OAK_LOG, count: 1 });
  assert.deepEqual(plan.slots[0], named(BLOCK.OAK_LOG, 5, "keep"));
  assert.equal(plan.slots[1], null);
  assert.deepEqual(slots, before.slots);
  assert.deepEqual(grid, before.grid);
  plan.slots[0].data.name = "mutated plan";
  assert.equal(slots[0].data.name, "keep");
  assert.equal(grid[0].data.name, "keep");
  slots[1] = null;
  assert.equal(
    planRecipeFill(slots, grid, 2, getRecipe("planks")).reason,
    "ingredients"
  );
});

test("specialized recipes explicitly opt into exact decoration or intentional metadata consumption", () => {
  // Recipe-policy fixture using real existing item IDs, not a new catalog recipe.
  const recipe = {
    id: "metadata-policy-fixture",
    station: "hand",
    duration: 0,
    shapeless: true,
    ingredients: [
      { id: BLOCK.PLANKS, count: 1, metadata: "exact", data: name("paid") },
    ],
    output: named(ITEM.STICK, 2, "result"),
  };
  const grid = emptyGrid();
  grid[2] = named(BLOCK.PLANKS, 3, "paid");
  const match = matchCraftingRecipe(grid, 2, [recipe]);
  assert.ok(match);
  assert.deepEqual(match.output, recipe.output);
  assert.equal(consumeCraftingInputs(grid, match), true);
  assert.deepEqual(grid[2], named(BLOCK.PLANKS, 2, "paid"));
  match.output.data.name = "detached output";
  match.inputs[0].expected.data.name = "detached preview";
  assert.equal(recipe.output.data.name, "result");
  assert.equal(grid[2].data.name, "paid");
  assert.equal(
    matchesIngredient(named(BLOCK.PLANKS, 1, "other"), recipe.ingredients[0]),
    false
  );
  assert.equal(
    matchesIngredient(grid[2], { id: BLOCK.PLANKS, data: name("paid") }),
    false
  );
  assert.equal(
    matchesIngredient(grid[2], { id: BLOCK.PLANKS, metadata: "unknown" }),
    false
  );
  assert.equal(
    matchesIngredient(grid[2], { id: BLOCK.PLANKS, metadata: "any" }),
    true
  );
});

test("a stale crafting preview rejects every debit before consuming a replacement item", () => {
  const grid = emptyGrid();
  grid[0] = { id: BLOCK.PLANKS, count: 2 };
  grid[2] = { id: BLOCK.PLANKS, count: 2 };
  const match = matchCraftingRecipe(grid, 2);
  assert.equal(match.recipe.id, "sticks");
  grid[2] = named(BLOCK.PLANKS, 2, "replacement");
  const before = cloneSlots(grid);
  assert.throws(() => consumeCraftingInputs(grid, match), RangeError);
  assert.deepEqual(grid, before);
  const invalidPlan = {
    ...match,
    inputs: [match.inputs[0], { ...match.inputs[1], count: 5 }],
  };
  assert.throws(() => consumeCraftingInputs(grid, invalidPlan), RangeError);
  assert.deepEqual(grid, before);
});

test("durable crafted outputs preserve explicit metadata/wear and default only missing wear", () => {
  const data = {
    version: 1,
    enchantments: { efficiency: 2 },
    name: "Built:here",
  };
  const recipe = {
    output: { id: ITEM.IRON_PICKAXE, count: 1, durability: 19, data },
  };
  const output = recipeOutput(recipe);
  assert.equal(output.durability, 19);
  assert.deepEqual(output.data, data);
  output.data.enchantments.efficiency = 1;
  assert.equal(recipe.output.data.enchantments.efficiency, 2);
  const fresh = recipeOutput({
    output: { id: ITEM.IRON_PICKAXE, count: 1, data },
  });
  assert.equal(fresh.durability, getItem(ITEM.IRON_PICKAXE).durability);
  assert.throws(
    () =>
      recipeOutput({
        output: { id: ITEM.STICK, count: 1, data: { version: 2 } },
      }),
    RangeError
  );
});

test("prepaid plain outputs cannot merge into decorated copies or steal their reserved slot", () => {
  const queue = [{ recipeId: "charcoal", remaining: 10 }];
  const slots = Array.from({ length: 36 }, () => named(ITEM.COAL, 64, "owned"));
  slots[0].count = 63;
  const before = cloneSlots(slots);
  assert.equal(fitsQueuedOutputs(slots, queue), false);
  assert.deepEqual(slots, before);
  slots[0] = { id: ITEM.COAL, count: 63 };
  assert.equal(fitsQueuedOutputs(slots, queue), true);
  assert.equal(slots[0].count, 63, "reservation is not output publication");

  const draft = emptyOwnedInventory();
  draft.slots = Array.from({ length: 36 }, () => ({
    id: BLOCK.DIRT,
    count: 64,
  }));
  draft.slots[34] = named(ITEM.COAL, 63, "owned");
  draft.slots[35] = null;
  draft.cursor = named(ITEM.COAL, 2, "owned");
  const originalCursor = cloneStack(draft.cursor);
  const drops = returnInputs(draft, {
    canFit: (candidate) => fitsQueuedOutputs(candidate, queue),
  });
  assert.deepEqual(drops, [{ ...originalCursor, count: 1 }]);
  assert.equal(draft.slots[34].count, 64);
  assert.equal(draft.slots[35], null);
  assert.equal(fitsQueuedOutputs(draft.slots, queue), true);
  drops[0].data.name = "detached remainder";
  assert.equal(draft.slots[34].data.name, "owned");
});
