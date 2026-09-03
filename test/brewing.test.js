import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  acceptsBrewingStack,
  advanceBrewing,
  brewingProgress,
  brewingRecordBytes,
  cancelBrewing,
  changeBrewingSlots,
  createBrewingCatalog,
  createBrewingStand,
  fillWaterBottle,
  getBrewingResult,
  isValidBrewingStand,
  normalizeBrewingStand,
} from "../src/brewing.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import {
  brewingCatalog,
  brewingStand,
  ingredientStack,
  potionStack,
  PreparedBrewingRecordFixture,
} from "./brewing-fixture.js";

const reload = (state, catalog) =>
  normalizeBrewingStand(JSON.parse(JSON.stringify(state)), catalog);
const names = ["North shelf", "South shelf", "海の瓶"];

test("one ingredient brews three named bottles in exactly 20 active seconds, charging one operation", () => {
  const catalog = brewingCatalog();
  const original = brewingStand(catalog, {
    bottles: names.map((name) => potionStack(catalog, "water", { name })),
    ingredientCount: 2,
  });
  const before = structuredClone(original);
  const first = advanceBrewing(original, 19.95, catalog);
  assert.deepEqual(original, before);
  assert.equal(first.state.progressTicks, 399);
  assert.equal(first.state.slots[3].count, 2);
  assert.equal(first.state.slots[4], null);
  assert.equal(first.state.fuelOperations, 19);
  assert.equal(first.operationsCompleted, 0);
  const final = advanceBrewing(first.state, 0.05, catalog);
  assert.deepEqual(final.completedSlots, [[0, 1, 2]]);
  assert.equal(final.operationsCompleted, 1);
  assert.equal(final.ingredientsConsumed, 1);
  assert.equal(final.fuelItemsConsumed, 0);
  assert.equal(final.experience, 0, "brewing does not invent furnace XP");
  assert.equal(final.state.slots[3].count, 1);
  assert.equal(final.state.fuelOperations, 19);
  assert.equal(final.state.batch, null);
  for (let index = 0; index < 3; index++)
    assert.deepEqual(final.state.slots[index], potionStack(catalog, "awkward", { name: names[index] }));
  assert.deepEqual(reload(final.state, catalog), final.state);
  assert.equal(advanceBrewing(final.state, 60, catalog).changed, false);
});

test("one blaze powder fuels 20 operations, independent of one versus three bottle outputs", () => {
  const catalog = brewingCatalog();
  let state = brewingStand(catalog, { ingredientCount: 64 });
  let fuelItems = 0;
  let ingredients = 0;
  let bottles = 0;
  for (let operation = 0; operation < 20; operation++) {
    const slots = [...state.slots];
    for (let index = 0; index < 3; index++)
      slots[index] = index === 0 || operation % 2 === 0
        ? potionStack(catalog, "water", { name: `${operation}:${index}` }) : null;
    state = changeBrewingSlots(state, slots, catalog, { touchedBottleSlots: [0, 1, 2] });
    const update = advanceBrewing(state, 20, catalog);
    state = update.state;
    fuelItems += update.fuelItemsConsumed;
    ingredients += update.ingredientsConsumed;
    bottles += update.completedSlots.flat().length;
  }
  assert.equal(fuelItems, 1);
  assert.equal(ingredients, 20);
  assert.equal(bottles, 40);
  assert.equal(state.fuelOperations, 0);
  assert.equal(state.slots[3].count, 44);
  const slots = [...state.slots];
  slots[0] = potionStack(catalog, "water");
  state = changeBrewingSlots(state, slots, catalog);
  const blocked = advanceBrewing(state, 60, catalog);
  assert.equal(blocked.reason, "no-fuel");
  assert.deepEqual(blocked.state, state);
  slots[4] = ingredientStack(catalog, "blaze_powder");
  state = changeBrewingSlots(state, slots, catalog);
  const refueled = advanceBrewing(state, 20, catalog);
  assert.equal(refueled.fuelItemsConsumed, 1);
  assert.equal(refueled.state.fuelOperations, 19);
});

test("mixed valid and invalid bottles retain their identity and charge only one batch", () => {
  const catalog = brewingCatalog();
  const untouched = [
    potionStack(catalog, "awkward", { name: "Keep this" }),
    potionStack(catalog, "night_vision", { name: "Already finished", extended: true }),
  ];
  const original = brewingStand(catalog, {
    bottles: [potionStack(catalog, "water", { name: "Brew this" }), ...untouched],
  });
  const result = advanceBrewing(original, 20, catalog);
  assert.deepEqual(result.completedSlots, [[0]]);
  assert.equal(result.ingredientsConsumed, 1);
  assert.deepEqual(result.state.slots.slice(1, 3), untouched);
  assert.equal(result.state.slots[0].data.name, "Brew this");
  assert.equal(result.state.slots[0].data.potion.id, "awkward");
});

test("a mixed corruption batch can produce three different correctly decorated results", () => {
  const catalog = brewingCatalog();
  const state = brewingStand(catalog, {
    ingredient: "fermented_spider_eye",
    bottles: [
      potionStack(catalog, "swiftness", { extended: true, name: "Long" }),
      potionStack(catalog, "poison", { strong: true, form: "splash", name: "Strong" }),
      potionStack(catalog, "water", { name: "Water" }),
    ],
  });
  const result = advanceBrewing(state, 20, catalog);
  assert.equal(result.ingredientsConsumed, 1);
  assert.deepEqual(result.state.slots.slice(0, 3), [
    potionStack(catalog, "slowness", { extended: true, name: "Long" }),
    potionStack(catalog, "harming", { strong: true, form: "splash", name: "Strong" }),
    potionStack(catalog, "weakness", { name: "Water" }),
  ]);
});

test("new/replaced bottles cannot inherit progress while untouched partial-batch bottles finish", () => {
  const catalog = brewingCatalog();
  let state = brewingStand(catalog, {
    ingredientCount: 3,
    bottles: [
      potionStack(catalog, "water", { name: "Removed" }),
      potionStack(catalog, "water", { name: "Original" }),
      null,
    ],
  });
  state = advanceBrewing(state, 10, catalog).state;
  const slots = [...state.slots];
  slots[0] = potionStack(catalog, "water", { name: "New" });
  slots[2] = potionStack(catalog, "water", { name: "Late" });
  state = changeBrewingSlots(state, slots, catalog);
  state = reload(state, catalog);
  assert.deepEqual(brewingProgress(state, catalog).activeBottleSlots, [1]);
  const first = advanceBrewing(state, 10, catalog);
  assert.deepEqual(first.completedSlots, [[1]]);
  assert.equal(first.state.slots[0].data.potion.id, "water");
  assert.equal(first.state.slots[2].data.potion.id, "water");
  const second = advanceBrewing(first.state, 20, catalog);
  assert.deepEqual(second.completedSlots, [[0, 2]]);
  assert.equal(second.state.fuelOperations, 18);
  assert.equal(second.state.slots[3].count, 1);
  assert.deepEqual(second.state.slots.slice(0, 3).map((stack) => stack.data.name), ["New", "Original", "Late"]);
});

test("an equal-kind physical replacement cancels its paid batch; cancellation never refunds fuel", () => {
  const catalog = brewingCatalog();
  let state = advanceBrewing(brewingStand(catalog), 10, catalog).state;
  const replacement = changeBrewingSlots(state, state.slots, catalog, { touchedBottleSlots: [0] });
  assert.equal(replacement.batch, null);
  assert.equal(replacement.progressTicks, 0);
  assert.equal(replacement.fuelOperations, 19);
  state = advanceBrewing(replacement, 10, catalog).state;
  assert.equal(state.progressTicks, 200);
  assert.equal(state.fuelOperations, 18);
  assert.equal(state.slots[0].data.potion.id, "water");
  const cancelled = cancelBrewing(state, catalog);
  assert.equal(cancelled.fuelOperations, 18);
  assert.equal(cancelled.slots[3].count, 1);
  assert.equal(cancelled.batch, null);
});

test("ingredient refills keep a batch, ingredient replacement/removal interrupts without spending it", () => {
  const catalog = brewingCatalog();
  const original = advanceBrewing(brewingStand(catalog), 10, catalog).state;
  const topped = [...original.slots];
  topped[3] = ingredientStack(catalog, "nether_wart", 3);
  topped[4] = ingredientStack(catalog, "blaze_powder", 2);
  const refill = changeBrewingSlots(original, topped, catalog);
  assert.equal(refill.progressTicks, 200);
  const completed = advanceBrewing(refill, 10, catalog);
  assert.equal(completed.state.slots[3].count, 2);
  assert.equal(completed.state.slots[4].count, 2);
  for (const ingredient of [null, ingredientStack(catalog, "redstone")]) {
    const slots = [...original.slots];
    slots[3] = ingredient;
    const interrupted = changeBrewingSlots(original, slots, catalog);
    assert.equal(interrupted.batch, null);
    assert.equal(interrupted.fuelOperations, 19);
    assert.deepEqual(interrupted.slots[3], ingredient);
    assert.equal(interrupted.slots[0].data.potion.id, "water");
  }
});

test("fractional progress persists across reload; pause and day-time jumps provide no catch-up", () => {
  const catalog = brewingCatalog();
  const partial = advanceBrewing(brewingStand(catalog), 7.075, catalog).state;
  assert.equal(partial.progressTicks, 141);
  assert.ok(Math.abs(partial.tickRemainder - 0.5) < 1e-8);
  const restored = reload(partial, catalog);
  for (const dt of [0, -1, NaN, Infinity, "20"])
    assert.deepEqual(advanceBrewing(restored, dt, catalog).state, restored);
  assert.deepEqual(advanceBrewing(restored, 12000, catalog, { paused: true }).state, restored);
  const finished = advanceBrewing(restored, 12.925, catalog);
  assert.equal(finished.operationsCompleted, 1);
  assert.equal(finished.state.slots[3], null);
  assert.equal(finished.state.fuelOperations, 19);
  assert.equal(advanceBrewing(reload(finished.state, catalog), 60, catalog).ingredientsConsumed, 0);
});

test("output admission blocking spends nothing before start and freezes an already paid batch", () => {
  const catalog = brewingCatalog();
  const original = brewingStand(catalog);
  const blocked = advanceBrewing(original, 20, catalog, { canAcceptResults: () => false });
  assert.equal(blocked.reason, "output-blocked");
  assert.deepEqual(blocked.state, original);
  assert.equal(blocked.operationsStarted, 0);
  const partial = advanceBrewing(original, 10, catalog).state;
  assert.deepEqual(
    advanceBrewing(partial, 20, catalog, { canAcceptResults: () => false }).state,
    partial
  );
  assert.equal(advanceBrewing(partial, 10, catalog).operationsCompleted, 1);
  assert.throws(() => advanceBrewing(original, 20, catalog, { canAcceptResults: async () => true }), RangeError);
});

test("only real declared capabilities and canonical metadata enter station slots", () => {
  const catalog = brewingCatalog();
  assert.throws(() => createBrewingCatalog({ ...ITEM, POTION: ITEM.APPLE }), RangeError);
  assert.equal(acceptsBrewingStack(0, potionStack(catalog, "water"), catalog), true);
  assert.equal(acceptsBrewingStack(0, { id: catalog.bottles.drinkable, count: 1 }, catalog), false);
  assert.equal(acceptsBrewingStack(0, { ...potionStack(catalog, "water"), count: 2 }, catalog), false);
  const namedFuel = { ...ingredientStack(catalog, "blaze_powder"), data: { version: 1, name: "Keepsake" } };
  assert.equal(acceptsBrewingStack(4, namedFuel, catalog), true);
  assert.equal(acceptsBrewingStack(3, namedFuel, catalog), true);
  assert.equal(acceptsBrewingStack(4, {
    ...namedFuel, data: { version: 1, potion: { id: "water", form: "drinkable" } },
  }, catalog), false);
  const empty = { id: catalog.emptyBottle, count: 1, data: { version: 1, name: "Reusable" } };
  assert.equal(acceptsBrewingStack(0, empty, catalog), true);
  assert.equal(getBrewingResult(empty, ingredientStack(catalog, "nether_wart"), catalog), null);
  assert.deepEqual(fillWaterBottle(empty, catalog), potionStack(catalog, "water", { name: "Reusable" }));
  assert.equal(fillWaterBottle({ ...empty, count: 2 }, catalog), null);
  const unsupported = brewingStand(catalog, {
    bottles: [potionStack(catalog, "luck"), null, null],
    ingredient: "gunpowder",
  });
  assert.equal(advanceBrewing(unsupported, 20, catalog).changed, false);
});

test("named ingredient/fuel remainders retain metadata and a changed catalyst identity interrupts", () => {
  const catalog = brewingCatalog();
  const initial = brewingStand(catalog);
  const slots = [...initial.slots];
  slots[3] = {
    ...ingredientStack(catalog, "nether_wart", 2),
    data: { version: 1, name: "🧪".repeat(50) },
  };
  slots[4] = {
    ...ingredientStack(catalog, "blaze_powder", 2),
    data: { version: 1, name: "Fuel reserve" },
  };
  const input = changeBrewingSlots(initial, slots, catalog);
  const partial = reload(advanceBrewing(input, 10, catalog).state, catalog);
  assert.deepEqual(partial.slots[3], slots[3]);
  assert.deepEqual(partial.slots[4], { ...slots[4], count: 1 });
  const result = advanceBrewing(partial, 10, catalog);
  assert.deepEqual(result.state.slots[3], { ...slots[3], count: 1 });
  assert.deepEqual(result.state.slots[4], { ...slots[4], count: 1 });
  assert.deepEqual(input.slots, slots, "preview never mutates the source metadata");

  const replacement = [...partial.slots];
  replacement[3] = { ...replacement[3], data: { version: 1, name: "Other batch" } };
  const interrupted = changeBrewingSlots(partial, replacement, catalog);
  assert.equal(interrupted.batch, null);
  assert.equal(interrupted.fuelOperations, 19);
  assert.equal(interrupted.slots[3].count, 2);
});

test("strict normalization rejects forged progress, batch identity, counts, versions and numeric corruption", () => {
  const catalog = brewingCatalog();
  const valid = advanceBrewing(brewingStand(catalog), 1, catalog).state;
  for (const mutate of [
    (state) => { state.version = 2; },
    (state) => { state.progressTicks = 400; },
    (state) => { state.progressTicks = -1; },
    (state) => { state.tickRemainder = NaN; },
    (state) => { state.tickRemainder = 1; },
    (state) => { state.fuelOperations = 21; },
    (state) => { state.fuelOperations = 20; },
    (state) => { state.batch = null; },
    (state) => { state.batch.ingredient = "wrong"; },
    (state) => { state.batch.bottles[0].identity = "wrong"; },
    (state) => { state.batch.bottles[0].revision++; },
    (state) => { state.batch.bottles.fill(null); },
    (state) => { state.bottleRevisions[0] = Number.MAX_SAFE_INTEGER + 1; },
    (state) => { state.slots[0].data.potion.strong = true; },
    (state) => { state.slots[0].count = 2; },
    (state) => { state.slots.pop(); },
    (state) => { state.unknown = "ignored?"; },
  ]) {
    const corrupted = structuredClone(valid);
    mutate(corrupted);
    assert.equal(isValidBrewingStand(corrupted, catalog), false, mutate.toString());
    assert.throws(() => normalizeBrewingStand(corrupted, catalog), RangeError);
  }
  assert.equal(isValidBrewingStand(valid, catalog), true);
  assert.ok(brewingRecordBytes(valid, catalog) >= encodedBytes(valid));
});

test("shared capacity admission happens before fuel payment and reserves the eventual metadata output", (t) => {
  const catalog = brewingCatalog();
  const coordinator = new TransactionCoordinator();
  const record = new PreparedBrewingRecordFixture(coordinator, catalog, brewingStand(catalog, {
    bottles: names.map((name) => potionStack(catalog, "water", { name })),
  }));
  t.after(() => record.dispose());
  const before = record.snapshot();
  const blocker = {};
  const capacity = MAX_RESERVED_BYTES - coordinator.budget.totalBytes;
  assert.equal(coordinator.register(blocker, capacity), true);
  const started = record.prepareAdvance(1).participant;
  assert.ok(started.afterBytes > started.beforeBytes, "batch identities/results require admission");
  assert.equal(coordinator.commit([started]).ok, false);
  assert.deepEqual(record.snapshot(), before);
  assert.equal(record.notifications, 0);
  const delta = started.afterBytes - started.beforeBytes;
  assert.equal(coordinator.commit([
    started,
    { owner: blocker, beforeBytes: capacity, afterBytes: capacity - delta, validate: () => true, publish: () => {} },
  ]).ok, true);
  assert.equal(record.state.fuelOperations, 19);
  const progress = record.prepareAdvance(1);
  assert.equal(progress.transition.reservationChanged, false);
  assert.equal(progress.participant.afterBytes, progress.participant.beforeBytes);
  assert.equal(coordinator.commit([progress.participant]).ok, true);
  const finished = record.prepareAdvance(18).participant;
  assert.ok(finished.afterBytes <= finished.beforeBytes);
  assert.equal(coordinator.commit([finished]).ok, true);
  assert.equal(coordinator.commit([started]).ok, false, "single-use");
  assert.equal(record.state.slots[3], null);
});

test("stale progress and rejected/full inventory extraction preserve station and metadata ownership", (t) => {
  const catalog = brewingCatalog();
  const coordinator = new TransactionCoordinator();
  const record = new PreparedBrewingRecordFixture(coordinator, catalog, brewingStand(catalog, {
    bottles: [potionStack(catalog, "water", { name: "Station output" }), null, null],
  }));
  const game = new Gameplay({ coordinator });
  t.after(() => { record.dispose(); game.dispose(); });
  const stale = record.prepareAdvance(10).participant;
  assert.equal(coordinator.commit([record.prepareAdvance(20).participant]).ok, true);
  const completed = record.snapshot();
  assert.equal(coordinator.commit([stale]).ok, false);
  assert.deepEqual(record.snapshot(), completed);

  const output = completed.slots[0];
  const slots = [...completed.slots];
  slots[0] = null;
  const source = record.prepare(changeBrewingSlots(completed, slots, catalog));
  const destination = game.prepareAddStack(output);
  const veto = {};
  coordinator.register(veto, 0);
  const beforePlayer = game.serialize();
  assert.equal(coordinator.commit([
    source, destination,
    { owner: veto, beforeBytes: 0, afterBytes: 0, validate: () => false, publish: () => assert.fail("veto published") },
  ]).ok, false);
  assert.deepEqual(record.snapshot(), completed);
  assert.deepEqual(game.serialize(), beforePlayer);
  assert.equal(coordinator.commit([source, destination]).ok, true);
  assert.deepEqual(game.slots.find((stack) => stack?.id === output.id), output);
  assert.equal(record.state.slots[0], null);

  assert.equal(game.inventoryTransaction((owned) => {
    owned.slots = Array.from({ length: 36 }, () => ({ id: BLOCK.DIRT, count: 64 }));
    return true;
  }), true);
  assert.equal(game.prepareAddStack(output), null, "full bag refuses before station extraction");
  assert.deepEqual(record.snapshot().slots, createBrewingStand().slots);
});
