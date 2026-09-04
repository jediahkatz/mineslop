import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  acceptsFurnaceStack, advanceFurnace, cloneFurnace, createFurnace, furnaceProgress,
  getSmeltingRecipe, isValidFurnace, syncFurnaceRecipe,
} from "../src/furnace.js";
import { FUEL_ITEMS, getItem, ITEM } from "../src/items.js";
import { RECIPES } from "../src/recipes.js";
import { normalizeSettlementSnapshot } from "../src/settlement-state.js";
import { Settlement } from "../src/settlement.js";
import { containerFixture, editOwnership, moveIntoContainer } from "./container-fixture.js";

const stack = (id, count = 1) => ({ id, count });
function blast(input = stack(ITEM.RAW_IRON, 64), fuel = stack(ITEM.COAL)) {
  const furnace = createFurnace("blast_furnace");
  furnace.slots = [input, fuel, null];
  syncFurnaceRecipe(furnace);
  return furnace;
}
function fixture() {
  const f = containerFixture("furnace", { generatorVersion: 4 });
  f.world.set(f.hit.x, f.hit.y, f.hit.z, BLOCK.BLAST_FURNACE);
  f.hit.id = BLOCK.BLAST_FURNACE;
  return f;
}

test("blast accepts registered ores/raw metals only; food, sand, logs and unregistered recycling reject", () => {
  for (const id of [
    ITEM.RAW_IRON, ITEM.RAW_GOLD, ITEM.RAW_COPPER, BLOCK.IRON_ORE,
    BLOCK.DEEPSLATE_IRON_ORE, BLOCK.GOLD_ORE, BLOCK.NETHER_GOLD_ORE,
    BLOCK.COPPER_ORE, BLOCK.ANCIENT_DEBRIS, BLOCK.NETHER_QUARTZ_ORE,
  ]) {
    const recipe = getSmeltingRecipe(stack(id), undefined, "blast_furnace");
    assert.ok(recipe, `missing ${getItem(id).name}`);
    assert.ok(RECIPES.includes(recipe));
    assert.equal(acceptsFurnaceStack(0, stack(id), undefined, "blast_furnace"), true);
  }
  for (const id of [
    ITEM.RAW_BEEF, ITEM.RAW_COD, ITEM.RAW_SALMON, BLOCK.SAND, BLOCK.RED_SAND,
    BLOCK.COBBLESTONE, BLOCK.STONE, BLOCK.CLAY, BLOCK.OAK_LOG,
    BLOCK.NETHERRACK, BLOCK.WET_SPONGE, BLOCK.KELP,
  ]) {
    assert.ok(getSmeltingRecipe(stack(id)));
    assert.equal(getSmeltingRecipe(stack(id), undefined, "blast_furnace"), null);
  }
  // The registry does not currently define gear recycling yields.
  for (const id of [ITEM.IRON_PICKAXE, ITEM.GOLD_HELMET, ITEM.DIAMOND_SWORD]) {
    const tool = { ...stack(id), durability: 7 };
    assert.equal(getSmeltingRecipe(tool), null);
    assert.equal(getSmeltingRecipe(tool, undefined, "blast_furnace"), null);
  }
});

test("every unit fuel buys identical output/progress at twice the smelting and burn rate", () => {
  for (const id of FUEL_ITEMS) {
    const item = getItem(id);
    const fuel = { ...stack(id), ...(item.durability ? { durability: 1 } : {}) };
    const fast = blast(stack(ITEM.RAW_IRON, 64), fuel);
    const ordinary = { ...cloneFurnace(fast), kind: "furnace" };
    advanceFurnace(fast, item.fuel / 2);
    advanceFurnace(ordinary, item.fuel);
    assert.deepEqual(fast.slots, ordinary.slots, item.name);
    assert.equal(fast.cookTime * 2, ordinary.cookTime, item.name);
    assert.equal(fast.experience, ordinary.experience, item.name);
    assert.equal(fast.burnTime, 0, item.name);
    assert.equal(fast.burnDuration * 2, ordinary.burnDuration, item.name);
    assert.equal(isValidFurnace(fast), true, item.name);
  }
  const fast = blast(), ordinary = { ...cloneFurnace(fast), kind: "furnace" };
  advanceFurnace(fast, 10);
  advanceFurnace(ordinary, 10);
  assert.equal(fast.slots[2].count, 2);
  assert.equal(ordinary.slots[2].count, 1);
  assert.equal(furnaceProgress(fast).cookDuration, 5);
});

test("fractional cook/burn/input/fuel/output/XP persist exactly and continue after reload", () => {
  const f = fixture();
  moveIntoContainer(f, 0, stack(ITEM.RAW_IRON, 4));
  moveIntoContainer(f, 1, stack(ITEM.COAL, 2));
  f.settlement.update(6.125, f.world);
  const saved = JSON.parse(JSON.stringify(f.settlement.serialize()));
  assert.equal(saved.furnaces[0].kind, "blast_furnace");
  assert.equal(saved.furnaces[0].cookTime, 1.125);
  assert.equal(saved.furnaces[0].burnTime, 33.875);
  assert.equal(saved.furnaces[0].burnDuration, 40);
  assert.deepEqual(normalizeSettlementSnapshot(saved, f.context), saved);
  f.settlement.dispose();
  const restored = new Settlement({ coordinator: f.coordinator, context: f.context });
  assert.equal(restored.load(saved, { world: f.world }), true);
  assert.deepEqual(restored.serialize(), saved);
  assert.equal(restored.update(3.875, f.world), true);
  const state = restored.getContainerState(f.world, f.hit, f.game);
  assert.equal(state.kind, "blast_furnace");
  assert.equal(state.title, "Blast Furnace");
  assert.equal(state.slots[2].count, 2);
  assert.equal(state.experience, 2);
  assert.equal(state.cookTime, 0);
  assert.equal(state.burnTime, 30);
});

test("blast insertion rejects every ownership route without consuming a stack", () => {
  const f = fixture();
  f.state();
  editOwnership(f.game, (owned) => {
    owned.cursor = stack(BLOCK.SAND, 3);
    owned.slots[0] = stack(ITEM.RAW_BEEF);
    owned.offhand = stack(BLOCK.SAND);
  });
  const before = f.snapshot();
  for (const action of [
    { type: "click", area: "container", index: 0, button: 0 },
    { type: "quickMove", area: "inventory", index: 0 },
    { type: "swapHotbar", area: "container", index: 0, hotbarIndex: 0 },
    { type: "swapOffhand", area: "container", index: 0 },
    { type: "distribute", targets: [{ area: "container", index: 0 }], button: 0 },
  ]) {
    assert.equal(f.action(action).ok, false);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("blast output blockage never ignites fresh fuel; existing fuel still expires", () => {
  const furnace = blast();
  furnace.slots[2] = stack(ITEM.IRON_INGOT, 64);
  const before = cloneFurnace(furnace);
  assert.equal(advanceFurnace(furnace, 40), false);
  assert.deepEqual(furnace, before);
  furnace.slots[2] = stack(ITEM.IRON_INGOT, 63);
  advanceFurnace(furnace, 8);
  assert.equal(furnace.slots[2].count, 64);
  assert.equal(furnace.burnTime, 32);
  assert.equal(furnace.experience, 1);
  assert.equal(furnace.cookTime, 0);
});

test("strict furnace kind validation rejects unknown kinds and legacy disguised blast records", () => {
  const f = fixture();
  f.state();
  const saved = f.settlement.serialize();
  for (const kind of ["smoker", "barrel", null, 1, {}]) {
    const invalid = structuredClone(saved);
    invalid.furnaces[0].kind = kind;
    assert.equal(normalizeSettlementSnapshot(invalid, f.context), null);
    assert.equal(isValidFurnace({ ...createFurnace(), kind }), false);
    assert.throws(() => cloneFurnace({ ...createFurnace(), kind }));
  }
  for (const change of [
    (v) => { delete v.kind; },
    (v) => { v.slots[2] = stack(BLOCK.GLASS); },
    (v) => { v.burnDuration = 101; },
    (v) => { v.slots[0] = stack(ITEM.RAW_IRON); v.recipeId = "iron_ingot"; v.cookTime = 5; },
  ]) {
    const invalid = structuredClone(saved);
    change(invalid.furnaces[0]);
    assert.equal(normalizeSettlementSnapshot(invalid, f.context), null);
  }
  for (const version of [2, 3, 4])
    assert.equal(normalizeSettlementSnapshot({ ...saved, version }, f.context), null);
});

test("blast owner refuses replacement blocks and inactive dimensions never advance", () => {
  const f = fixture();
  moveIntoContainer(f, 0, stack(ITEM.RAW_IRON, 3));
  moveIntoContainer(f, 1, stack(ITEM.COAL));
  f.settlement.update(1.125, f.world);
  f.world.dimension = "nether";
  const before = f.snapshot();
  assert.equal(f.settlement.update(10, f.world), false);
  assert.deepEqual(f.snapshot(), before);
  f.world.dimension = "overworld";
  f.world.set(f.hit.x, f.hit.y, f.hit.z, BLOCK.FURNACE);
  assert.equal(f.settlement.getContainerState(f.world, { ...f.hit, id: BLOCK.FURNACE }, f.game), null);
  assert.equal(f.settlement.update(10, f.world), false);
  assert.deepEqual(f.snapshot(), before);
});
