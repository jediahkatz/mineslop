import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK } from "../src/blocks.js";
import { FLUID as F } from "../src/block-state.js";
import { KELP_GROW_TICKS } from "../src/fluid-constants.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { ITEM } from "../src/items.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "../src/storage.js";
import { fluidFixture } from "./fluid-fixture.js";
import { kelpTimer } from "./fluid-kelp-fixture.js";
import { fluidLifecycleHost } from "./game-fluid-lifecycle-fixture.js";
import { aimAt, kelpGame, serviceTo } from "./kelp-game-fixture.js";

const BASE = { x: 8, y: 1, z: 8 };
const TOP = { x: 8, y: 2, z: 8 };
const FEET = { x: 8.5, y: 1.1, z: 8.5 };
const FURNACE = { x: 8, y: 1, z: 4, id: BLOCK.FURNACE };
const TABLE = { x: 7, y: 1, z: 4, id: BLOCK.CRAFTING_TABLE };
const pool = () => {
  const cells = [];
  for (let x = 5; x <= 11; x++)
    for (let z = 5; z <= 11; z++)
      for (let y = 1; y <= 6; y++) cells.push([x, y, z, BLOCK.WATER]);
  return [...cells, [8, 1, 8, BLOCK.KELP], [8, 2, 8, BLOCK.KELP],
    [8, 1, 4, BLOCK.FURNACE], [7, 1, 4, BLOCK.CRAFTING_TABLE]];
};

function gameFixture(t, { saved = null, ...options } = {}) {
  const f = fluidFixture(t, { radius: 0, base: BLOCK.STONE, initial: pool(), connect: false });
  f.fluids.dispose();
  if (saved) assert.equal(f.world.loadEdits(saved.world), true);
  return kelpGame(t, f.world, { saved, ...options });
}

function renew(f, targetCount) {
  const before = f.gameplay.count(BLOCK.KELP);
  for (let i = before; i < targetCount; i++) {
    assert.equal(f.fluid.frame(0.25, { simulating: true }).ok, true);
    const timer = kelpTimer(f.fluid.fluids);
    assert.ok(timer);
    serviceTo(f.fluid, timer[4] - 1);
    assert.equal(f.world.get(TOP.x, TOP.y, TOP.z), BLOCK.WATER);
    serviceTo(f.fluid, timer[4]);
    assert.equal(f.world.get(TOP.x, TOP.y, TOP.z), BLOCK.KELP);
    f.harvest(TOP);
    f.collect(FEET);
    assert.equal(f.gameplay.count(BLOCK.KELP), i + 1);
    assert.equal(f.world.get(BASE.x, BASE.y, BASE.z), BLOCK.KELP);
  }
}

test("actual harvest, overflow, pickups and Gameplay collection earn repeated surplus while retaining a kelp base", (t) => {
  const f = gameFixture(t);
  assert.equal(f.gameplay.count(BLOCK.KELP), 0);
  const { plan } = f.harvest(TOP);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.world, f.gameplay, f.overflow]));
  assert.equal(f.world.getFluid(8, 2, 8), F.WATER_SOURCE);
  assert.equal(f.gameplay.count(BLOCK.KELP), 0, "harvest is not an inventory grant");
  assert.equal(f.pickups.serialize().items.reduce((sum, item) => sum + item.count, 0), 1);
  f.collect(FEET);
  assert.equal(f.gameplay.count(BLOCK.KELP), 1);
  assert.equal(f.game.harvestActions.commit(plan).ok, false, "a source cannot pay twice");
  renew(f, 3);
  assert.equal(f.overflow.size, 0);
  assert.deepEqual(f.pickups.serialize().items, []);
  t.diagnostic("Retained base: 1 initial collected kelp -> 3 collected kelp after 2 paid active-time renewals; base remains planted.");
});

test("harvesting the whole column retains support-loss drops and pays one finite GameUseActions replant", (t) => {
  const f = gameFixture(t);
  f.harvest(BASE);
  assert.equal(f.world.get(8, 1, 8), BLOCK.WATER);
  assert.equal(f.fluid.frame(0.25, { simulating: true }).ok, true);
  assert.equal(f.world.get(8, 2, 8), BLOCK.WATER);
  assert.equal(f.overflow.size, 1, "upper kelp uses the real fluid-retention owner");
  f.collect(FEET);
  assert.equal(f.gameplay.count(BLOCK.KELP), 2);
  const hit = aimAt(f, { x: 8.5, y: 1, z: 8.5 }, { x: 8.5, y: 1, z: 11.5 });
  assert.deepEqual([hit.x, hit.y, hit.z, hit.normal.y], [8, 0, 8, 1]);
  assert.equal(f.game.useActions.place("main", BLOCK.KELP), true);
  assert.equal(f.gameplay.count(BLOCK.KELP), 1);
  assert.equal(f.world.get(8, 1, 8), BLOCK.KELP);
  renew(f, 3);
  assert.equal(f.gameplay.count(BLOCK.KELP), 3, "three loose + one replanted exceeds the original two");
});

test("a real break/replant between ticks cannot inherit the almost-expired former tip cooldown", (t) => {
  const f = gameFixture(t);
  f.harvest(TOP);
  f.collect(FEET);
  f.fluid.frame(0.25, { simulating: true });
  const original = kelpTimer(f.fluid.fluids);
  serviceTo(f.fluid, original[4] - 1);
  f.harvest(BASE);
  f.collect(FEET);
  assert.equal(kelpTimer(f.fluid.fluids), undefined);
  aimAt(f, { x: 8.5, y: 1, z: 8.5 }, { x: 8.5, y: 1, z: 11.5 });
  assert.equal(f.game.useActions.place("main", BLOCK.KELP), true);
  f.fluid.frame(0.25, { simulating: true });
  assert.equal(f.world.get(8, 2, 8), BLOCK.WATER);
  assert.equal(kelpTimer(f.fluid.fluids)[4], original[4] + KELP_GROW_TICKS);
});

for (const fluid of [F.BUBBLE_UP, F.BUBBLE_DOWN]) {
  test(`real paid kelp placement explicitly accepts source-like bubble fluid ${fluid}`, (t) => {
    const f = gameFixture(t);
    f.harvest(TOP);
    f.harvest(BASE);
    f.collect(FEET);
    const before = f.world.getCell(8, 1, 8);
    assert.equal(f.world.applyCells([{ ...BASE, before, after: { ...before, fluid } }]), true);
    aimAt(f, { x: 8.5, y: 1, z: 8.5 }, { x: 8.5, y: 1, z: 11.5 });
    assert.equal(f.game.useActions.place("main", BLOCK.KELP), true);
    assert.equal(f.world.getFluid(8, 1, 8), F.WATER_SOURCE);
    assert.equal(f.gameplay.count(BLOCK.KELP), 1);
  });
}

test("full retention refuses harvest without spending the source; full inventory keeps the actual pickup until space exists", (t) => {
  const f = gameFixture(t, { maxEntries: 1 });
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots.fill(null);
    for (let i = 0; i < owned.slots.length; i++) owned.slots[i] = { id: BLOCK.STONE, count: 64 };
    return true;
  }), true);
  assert.equal(f.overflow.enqueue([{ id: BLOCK.DIRT, count: 1 }], FEET, "overworld"), true);
  const before = f.snapshot();
  assert.equal(f.game.harvestActions.prepareBreak({ ...TOP, id: BLOCK.KELP }), null);
  assert.deepEqual(f.snapshot(), before);
  f.overflow.flush(f.world, f.pickups);
  const { plan } = f.harvest(TOP);
  f.collect(FEET);
  assert.equal(f.gameplay.count(BLOCK.KELP), 0);
  assert.ok(f.pickups.serialize().items.some((item) => item.id === BLOCK.KELP));
  assert.equal(f.game.harvestActions.commit(plan).ok, false);
  assert.equal(f.gameplay.consume(BLOCK.STONE, 128), true);
  f.collect(FEET);
  assert.equal(f.gameplay.count(BLOCK.KELP), 1);
  assert.equal(f.world.getFluid(8, 2, 8), F.WATER_SOURCE);
});

for (const gate of ["paused", "dead", "hidden", "not-simulating"]) {
  test(`real saved fluid owner ${gate} gate freezes the whole kelp scheduler`, (t) => {
    const f = gameFixture(t);
    f.harvest(TOP);
    f.fluid.frame(0.25, { simulating: true });
    const timer = kelpTimer(f.fluid.fluids);
    serviceTo(f.fluid, timer[4] - 1);
    if (gate === "paused") f.game.paused = true;
    if (gate === "dead") f.gameplay.damage(20, "authored death");
    const before = f.fluid.serialize();
    for (let i = 0; i < 4; i++)
      assert.equal(f.fluid.frame(1000000, { simulating: gate !== "hidden" && gate !== "not-simulating" }).advanced, false);
    assert.deepEqual(f.fluid.serialize(), before);
    assert.equal(f.world.get(8, 2, 8), BLOCK.WATER);
  });
}

test("real Game.frame pause/death gates freeze an already scheduled kelp tip before physics", (t) => {
  for (const gate of ["paused", "dead"]) {
    const f = fluidLifecycleHost(t, {
      cells: [[8, 1, 8, BLOCK.KELP], [8, 2, 8, BLOCK.WATER]],
      position: { x: 9.5, y: 1.1, z: 8.5 },
    });
    f.fluid.onMutation(f.world, {
      epoch: f.world.epoch, dimension: f.world.dimension, changes: [{ ...BASE }],
    });
    f.fluid.frame(0.25, { simulating: true });
    assert.ok(kelpTimer(f.fluid.fluids));
    if (gate === "paused") f.game.paused = true;
    else f.gameplay.damage(20, "authored death");
    const before = f.fluid.serialize();
    for (let i = 0; i < 4; i++) f.frame(1000);
    assert.deepEqual(f.fluid.serialize(), before);
  }
});

test("corrupt present marine state rejects owner staging and archive preflight without touching live owners", (t) => {
  const f = gameFixture(t);
  f.harvest(TOP);
  f.fluid.frame(0.25, { simulating: true });
  const before = f.snapshot(), bytes = f.coordinator.budget.totalBytes;
  for (const marine of [null, { version: 7, kelp: [] }, { version: 1, kelp: [[8, 1, 8, 26, 1951]] }]) {
    const saved = structuredClone(before);
    saved.fluids.dimensions[0].marine = marine;
    assert.throws(() => normalizeWorldComponents(saved), /fluid simulation/);
    assert.throws(() => new GameFluidServices({
      world: f.world, overflow: f.overflow, settlement: f.settlement,
      context: f.context, saved,
    }), /fluid services/);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.fluid.active, true);
  }
});

const click = (area, index) => ({ type: "click", area, index, button: 0 });
function intoFurnace(f, id, index) {
  const slot = f.gameplay.slots.findIndex((stack) => stack?.id === id);
  assert.ok(slot >= 0);
  for (const action of [click("inventory", slot), click("container", index)])
    assert.equal(f.settlement.containerAction(f.world, FURNACE, f.gameplay, action).ok, true);
}
function craft(f, recipeId) {
  assert.equal(f.game.inventoryActions.openStation(TABLE), true);
  for (const action of [
    { type: "fillRecipe", recipeId }, { type: "takeCraftResult", shift: true }, { type: "close" },
  ])
    assert.equal(f.game.inventoryActions.action(action).ok, true);
}
function extract(f) {
  assert.equal(f.settlement.containerAction(f.world, FURNACE, f.gameplay, {
    type: "quickMove", area: "container", index: 2,
  }).ok, true);
}

test("renewed kelp becomes real smelted food, reversible nine-to-one crafting and furnace fuel across a cold IndexedDB reload", async (t) => {
  const a = gameFixture(t);
  // Declared starting equipment: an authored furnace/table and two finite coal.
  // No kelp or dried kelp is ever injected into the inventory.
  assert.equal(a.gameplay.add(ITEM.COAL, 2), true);
  a.harvest(TOP);
  a.collect(FEET);
  renew(a, 12);
  assert.equal(a.gameplay.count(BLOCK.KELP), 12);
  intoFurnace(a, BLOCK.KELP, 0);
  intoFurnace(a, ITEM.COAL, 1);
  assert.equal(a.gameplay.count(BLOCK.KELP), 0);
  assert.equal(a.settlement.update(5, a.world), true);
  const partial = a.settlement.getContainerState(a.world, FURNACE, a.gameplay);
  assert.equal(partial.cookTime, 5);
  assert.equal(partial.burnTime, 75);
  assert.equal(partial.slots[0].count, 12);
  assert.equal(partial.slots[1].count, 1);
  assert.equal(partial.slots[2], null);

  const file = parseWorldFile(exportWorldFile(a.snapshot()));
  normalizeWorldComponents(file);
  const indexedDB = new IDBFactory();
  const storage = new WorldStorage({ indexedDB });
  await storage.save(file);
  await storage.close();
  const reopened = new WorldStorage({ indexedDB });
  const saved = normalizeWorldComponents(await reopened.load());
  await reopened.close();
  const b = gameFixture(t, { saved });
  assert.deepEqual(b.world.serialize(), a.world.serialize());
  assert.deepEqual(b.gameplay.serialize(), a.gameplay.serialize());
  assert.deepEqual(b.settlement.serialize(), a.settlement.serialize());
  assert.deepEqual(b.overflow.serialize(), a.overflow.serialize());
  assert.deepEqual(b.pickups.serialize(), a.pickups.serialize());
  assert.deepEqual(kelpTimer(b.fluid.fluids), kelpTimer(a.fluid.fluids));
  for (let i = 0; i < 115; i++) b.settlement.update(1, b.world);
  const cooked = b.settlement.getContainerState(b.world, FURNACE, b.gameplay);
  assert.deepEqual(cooked.slots, [null, null, { id: ITEM.DRIED_KELP, count: 12 }]);
  assert.equal(cooked.burnTime, 40);
  extract(b);
  assert.equal(b.gameplay.count(ITEM.DRIED_KELP), 12);
  b.player.setPosition(FEET);
  craft(b, "dried_kelp_block");
  assert.equal(b.gameplay.count(ITEM.DRIED_KELP), 3);
  assert.equal(b.gameplay.count(BLOCK.DRIED_KELP_BLOCK), 1);
  craft(b, "dried_kelp_from_block");
  assert.equal(b.gameplay.count(ITEM.DRIED_KELP), 12);
  assert.equal(b.gameplay.count(BLOCK.DRIED_KELP_BLOCK), 0);
  craft(b, "dried_kelp_block");

  b.gameplay.hunger = 18;
  b.gameplay.saturation = 0;
  const foodSlot = b.gameplay.slots.findIndex((stack) => stack?.id === ITEM.DRIED_KELP);
  assert.ok(foodSlot >= 0);
  assert.equal(b.game.inventoryActions.action({
    type: "swapHotbar", area: "inventory", index: foodSlot, hotbarIndex: 0,
  }).ok, true);
  b.gameplay.select(0);
  assert.equal(b.gameplay.getHandStack().id, ITEM.DRIED_KELP);
  b.game.useActions.held = true;
  assert.equal(b.game.useActions.useHand("main", b.gameplay.getHandStack(), true), true);
  for (let i = 0; i < 15; i++) b.game.useActions.update(0.05);
  assert.equal(b.gameplay.hunger, 18);
  assert.equal(b.gameplay.count(ITEM.DRIED_KELP), 3);
  b.game.useActions.update(0.05);
  assert.equal(b.gameplay.hunger, 19);
  assert.equal(b.gameplay.saturation, 0.6);
  assert.equal(b.gameplay.count(ITEM.DRIED_KELP), 2);
  b.game.useActions.reset();

  renew(b, 3);
  b.settlement.update(40, b.world); // Expire the already-paid leftover coal.
  intoFurnace(b, BLOCK.KELP, 0);
  intoFurnace(b, BLOCK.DRIED_KELP_BLOCK, 1);
  b.settlement.update(1, b.world);
  const fueled = b.settlement.getContainerState(b.world, FURNACE, b.gameplay);
  assert.equal(fueled.burnDuration, 200);
  assert.equal(fueled.burnTime, 199);
  assert.equal(fueled.slots[1], null);
  assert.equal(fueled.slots[0].count, 3);
  b.settlement.update(29, b.world);
  assert.deepEqual(b.settlement.getContainerState(b.world, FURNACE, b.gameplay).slots,
    [null, null, { id: ITEM.DRIED_KELP, count: 3 }]);
  assert.equal(b.gameplay.count(BLOCK.DRIED_KELP_BLOCK), 0);
  extract(b);
  assert.equal(b.gameplay.count(ITEM.DRIED_KELP), 5);
  assert.equal(b.world.get(8, 1, 8), BLOCK.KELP);
  normalizeWorldComponents(parseWorldFile(exportWorldFile(b.snapshot())));
  t.diagnostic("15 collected kelp (14 natural extensions): 12 coal-smelted, 9 compacted/unpacked/recompacted, 1 eaten at 0.8 s, 3 further kelp smelted using one 200-second kelp block; cold save preserves live plant, timer, all owners and half-cooked input.");
});
