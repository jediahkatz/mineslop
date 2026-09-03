import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE, FLUID, normalizeCell } from "../src/block-state.js";
import { resolveShape } from "../src/block-shapes.js";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import {
  consumeCraftingInputs,
  matchCraftingRecipe,
  planRecipeFill,
} from "../src/crafting.js";
import { getItem, ITEM } from "../src/items.js";
import { getRecipe, RECIPES } from "../src/recipes.js";

const names = [
  "GOLD_BLOCK",
  "MOSSY_COBBLESTONE",
  "NETHER_BRICKS",
  "NETHER_BRICK_STAIRS",
  "NETHER_BRICK_SLAB",
  "NETHER_BRICK_FENCE",
  "NETHER_WART_CROP",
  "SPAWNER",
  "COMPOSTER",
  "LECTERN",
  "CARTOGRAPHY_TABLE",
  "SMITHING_TABLE",
];

test("structure construction materials have stable, distinct native block identities", () => {
  for (const [offset, name] of names.entries()) {
    const id = 1092 + offset;
    assert.equal(BLOCK[name], id, name);
    assert.equal(BLOCKS[id].id, id, name);
    assert.equal(getItem(id).blockId, id, name);
    assert.equal(getItem(id).kind, "block", name);
    assert.equal(getItem(id).placeable, true, name);
    assert.deepEqual(normalizeCell({ id }), {
      id,
      state: 0,
      fluid: FLUID.NONE,
    });
  }
  assert.equal(ITEM.NETHER_WART, 65544);
  assert.equal(ITEM.NETHER_BRICK, 65545);
  for (const id of [ITEM.NETHER_WART, ITEM.NETHER_BRICK]) {
    assert.equal(BLOCKS[id], undefined);
    assert.equal(getItem(id).kind, "material");
    assert.equal(getItem(id).placeable, false);
  }
});

test("Nether brick building pieces use real partial shapes and source-water coexistence", () => {
  for (const [id, kind] of [
    [BLOCK.NETHER_BRICK_STAIRS, "stairs"],
    [BLOCK.NETHER_BRICK_SLAB, "slab"],
    [BLOCK.NETHER_BRICK_FENCE, "fence"],
  ]) {
    const shape = resolveShape(
      normalizeCell({ id, fluid: FLUID.WATER_SOURCE })
    );
    assert.equal(shape.kind, kind);
    assert.equal(shape.fluid, FLUID.WATER_SOURCE);
    assert.ok(shape.collision.length > 0);
    assert.equal(BLOCKS[id].tool, "pickaxe");
    assert.equal(getItem(id).fuel, 0);
  }
  for (let facing = 0; facing < 4; facing++)
    for (const half of [0, BLOCK_STATE.TOP])
      assert.equal(
        normalizeCell({ id: BLOCK.NETHER_BRICK_STAIRS, state: facing | half })
          .state,
        facing | half
      );
  assert.throws(() =>
    normalizeCell({
      id: BLOCK.NETHER_BRICK_SLAB,
      state: BLOCK_STATE.DOUBLE,
      fluid: FLUID.WATER_SOURCE,
    })
  );
  const fence = normalizeCell({ id: BLOCK.NETHER_BRICK_FENCE });
  assert.ok(resolveShape(fence, () => fence).connections.every(Boolean));
  assert.ok(
    resolveShape(fence, () =>
      normalizeCell({ id: BLOCK.OAK_FENCE })
    ).connections.every((connected) => !connected)
  );
});

test("structure rewards retain material meaning instead of becoming unrelated portable blocks", () => {
  assert.equal(BLOCKS[BLOCK.GOLD_BLOCK].drop, BLOCK.GOLD_BLOCK);
  assert.equal(BLOCKS[BLOCK.GOLD_BLOCK].tier, 3);
  assert.equal(BLOCKS[BLOCK.NETHER_WART_CROP].drop, ITEM.NETHER_WART);
  assert.deepEqual(BLOCKS[BLOCK.NETHER_WART_CROP].dropCount, [2, 4]);
  assert.equal(BLOCKS[BLOCK.NETHER_WART_CROP].substrate, BLOCK.SOUL_SAND);
  assert.equal(BLOCKS[BLOCK.NETHER_WART_CROP].solid, false);
  assert.equal(BLOCKS[BLOCK.SPAWNER].drop, BLOCK.AIR);
  assert.ok(!RECIPES.some(({ output }) => output.id === BLOCK.SPAWNER));
  for (const [name, profession] of [
    ["COMPOSTER", "farmer"],
    ["LECTERN", "librarian"],
    ["CARTOGRAPHY_TABLE", "cartographer"],
    ["SMITHING_TABLE", "toolsmith"],
  ]) {
    assert.equal(BLOCKS[BLOCK[name]].jobSite, profession);
    assert.equal(getItem(BLOCK[name]).fuel, 15);
  }
});

test("construction recipes fill and debit their exact finite crafting ingredients", () => {
  for (const id of [
    "gold_block",
    "gold_ingots",
    "mossy_cobblestone",
    "nether_bricks",
    "nether_brick_slab",
    "nether_brick_stairs",
    "nether_brick_fence",
    "composter",
    "lectern",
    "cartography_table",
    "smithing_table",
  ]) {
    const recipe = getRecipe(id);
    assert.ok(recipe, id);
    const size = recipe.station === "hand" ? 2 : 3;
    const slots = Array(36).fill(null);
    recipe.ingredients.forEach((input, index) => {
      slots[index] = { id: input.id, count: input.count };
    });
    const before = structuredClone(slots);
    const plan = planRecipeFill(slots, Array(9).fill(null), size, recipe);
    assert.equal(plan.ok, true, id);
    assert.deepEqual(
      slots,
      before,
      "planning does not spend the source inventory"
    );
    assert.ok(
      plan.slots.every((stack) => stack === null),
      id
    );
    const match = matchCraftingRecipe(plan.craftingGrid, size);
    assert.equal(match?.recipe.id, id);
    assert.deepEqual(match.output, recipe.output);
    consumeCraftingInputs(plan.craftingGrid, match);
    assert.ok(
      plan.craftingGrid.every((stack) => stack === null),
      id
    );
  }
  const smelting = getRecipe("nether_brick");
  assert.equal(smelting.station, "furnace");
  assert.equal(smelting.duration, 10);
  assert.deepEqual(smelting.ingredients, [{ id: BLOCK.NETHERRACK, count: 1 }]);
  assert.deepEqual(smelting.output, { id: ITEM.NETHER_BRICK, count: 1 });
});
