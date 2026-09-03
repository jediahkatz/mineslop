import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { ItemUse } from "../src/item-use.js";
import { ITEM } from "../src/items.js";
import { MAX_ACTIVE_BREWING_STANDS, normalizeProgressionStationsSnapshot } from "../src/progression-station-state.js";
import { brewingStand, potionStack } from "./brewing-fixture.js";
import { progressionLiveFixture, progressionStack } from "./progression-live-fixture.js";

function brew(t) {
  const f = progressionLiveFixture(t);
  f.place("brewing");
  f.editInventory((owned) => {
    for (let i = 0; i < 3; i++)
      owned.slots[i] = potionStack(f.services.catalog, "water", { name: `Bottle ${i + 1}` });
    owned.slots[3] = progressionStack(ITEM.NETHER_WART, 2);
    owned.slots[4] = progressionStack(ITEM.BLAZE_POWDER, 2);
    return true;
  });
  assert.equal(f.open().opened, true);
  for (let i = 0; i < 5; i++) f.transfer(i, i);
  return f;
}

const stand = (f, at = f.at) => f.services.stations.get(at).record;
const advance = (f, frames, dt = 0.25) => {
  for (let i = 0; i < frames; i++) assert.equal(f.services.frame(dt).ok, true);
};
const drinkUse = (f, hand = "main") => {
  const use = new ItemUse();
  assert.equal(use.start("drink", hand, f.gameplay.getHandStack(hand), f.gameplay.getHandRevision(hand)), true);
  return use;
};
const finishUse = (use) => { for (let i = 0; i < 7; i++) use.advance(0.25); };

test("paid brewing retains fractional progress/fuel across close, sleep, travel and detached reload", (t) => {
  const f = brew(t);
  advance(f, 28);
  advance(f, 1, 0.0375);
  const progress = stand(f);
  assert.equal(progress.progressTicks, 140);
  assert.ok(Math.abs(progress.tickRemainder - 0.75) < 1e-9);
  assert.equal(progress.fuelOperations, 19);
  assert.equal(progress.slots[4].count, 1);
  assert.equal(progress.slots[3].count, 2, "ingredient is charged at completion, not ignition");
  assert.equal(f.services.close().ok, true);
  f.game.paused = true;
  advance(f, 4);
  f.game.paused = false;
  assert.equal(f.building.worldClock.advance(1200), true);
  assert.deepEqual(stand(f), progress, "calendar advancement is not brewing time");
  f.services.onDimensionChange();
  f.world.setDimension("nether").generate(0);
  advance(f, 4);
  assert.deepEqual(stand(f), progress);
  f.world.setDimension("overworld").generate(0);
  const restored = progressionLiveFixture(t, { saved: f.snapshot() });
  assert.deepEqual(stand(restored), progress);
  let frames = 0;
  while (stand(restored).batch && frames++ < 80) advance(restored, 1);
  assert.ok(frames < 80);
  const completed = stand(restored);
  assert.equal(completed.batch, null);
  assert.equal(completed.fuelOperations, 19);
  assert.equal(completed.slots[3].count, 1);
  for (let i = 0; i < 3; i++) {
    assert.equal(completed.slots[i].data.potion.id, "awkward");
    assert.equal(completed.slots[i].data.name, `Bottle ${i + 1}`);
  }
  assert.equal(restored.services.stations.brewingCount, 0);
  const revision = restored.services.stations.revision;
  advance(restored, 10);
  assert.equal(restored.services.stations.revision, revision, "idle stands do not rebuild or publish");
});

test("bottle replacement cannot inherit another bottle's paid batch progress", (t) => {
  const f = brew(t);
  advance(f, 20);
  const before = stand(f);
  assert.equal(f.action({ type: "click", area: "container", index: 0, button: 0 }).ok, true);
  assert.equal(f.action({ type: "click", area: "inventory", index: 9, button: 0 }).ok, true);
  f.editInventory((owned) => {
    owned.slots[10] = potionStack(f.services.catalog, "water", { name: "Replacement" });
    return true;
  });
  f.transfer(10, 0);
  assert.equal(stand(f).batch.bottles[0], null);
  assert.equal(stand(f).progressTicks, before.progressTicks);
  advance(f, 60);
  assert.equal(stand(f).slots[0].data.potion.id, "water");
  assert.equal(stand(f).slots[1].data.potion.id, "awkward");
  assert.equal(stand(f).slots[2].data.potion.id, "awkward");
  assert.equal(stand(f).fuelOperations, 19);
  advance(f, 1);
  assert.equal(stand(f).fuelOperations, 18, "replacement starts a separately paid batch");
});

test("all 64 active stands get equal fractional time; a 65th recipe refuses its insertion", (t) => {
  const staged = progressionLiveFixture(t, { activate: false });
  const positions = Array.from({ length: MAX_ACTIVE_BREWING_STANDS }, (_, i) => ({
    dimension: "overworld", x: 2 + i % 8, y: 65, z: 2 + Math.floor(i / 8),
  }));
  for (const at of positions) staged.place("brewing", at);
  const extra = { dimension: "overworld", x: 8, y: 65, z: 12 };
  staged.place("brewing", extra);
  const saved = staged.snapshot();
  saved.progression.stations.stations = positions.map((at) => ({
    ...at, kind: "brewing", record: brewingStand(staged.services.catalog),
  }));
  const f = progressionLiveFixture(t, { saved });
  const before = f.services.stations.serialize();
  assert.equal(f.services.stations.prepareBrewingAdvance(0.25, {
    limit: 63, validate: () => f.services.active,
  }), null);
  assert.deepEqual(f.services.stations.serialize(), before);
  advance(f, 1, 0.0125);
  advance(f, 1);
  for (const at of positions) {
    assert.equal(stand(f, at).progressTicks, 5);
    assert.ok(Math.abs(stand(f, at).tickRemainder - 0.25) < 1e-9);
    assert.equal(stand(f, at).fuelOperations, 19);
  }
  assert.equal(f.open(extra).opened, true);
  f.editInventory((owned) => {
    owned.slots[0] = potionStack(f.services.catalog, "water");
    owned.slots[1] = progressionStack(ITEM.NETHER_WART);
    owned.cursor = progressionStack(ITEM.BLAZE_POWDER);
    return true;
  });
  // Preserve the carried fuel while moving the other ingredients by quick move.
  assert.equal(f.action({ type: "quickMove", area: "inventory", index: 0 }).ok, true);
  assert.equal(f.action({ type: "quickMove", area: "inventory", index: 1 }).ok, true);
  const filled = f.snapshot();
  assert.equal(f.action({ type: "click", area: "container", index: 4, button: 0 }).ok, false);
  assert.deepEqual(f.snapshot(), filled);
  assert.equal(f.services.stations.brewingCount, 64);
  assert.throws(() => normalizeProgressionStationsSnapshot({
    ...saved.progression.stations,
    stations: [...saved.progression.stations.stations,
      { ...extra, kind: "brewing", record: brewingStand(f.services.catalog) }],
  }, f.services.catalog, f.context), /active brewing/);
});

test("source-water filling keeps water and names, rejects flowing water and refuses a full destination", (t) => {
  const f = progressionLiveFixture(t);
  f.player.pitch = -0.5;
  f.player.setPosition(f.player.position.clone());
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.GLASS_BOTTLE, 3, { name: "River" });
    return true;
  });
  f.put(8, 65, 9, BLOCK.WATER, 0, FLUID.WATER_1);
  const flowing = f.snapshot();
  assert.equal(f.services.fillBottle("main").ok, false);
  assert.deepEqual(f.snapshot(), flowing);
  f.put(8, 65, 9, BLOCK.WATER, 0, FLUID.WATER_SOURCE);
  const water = f.world.serialize();
  assert.equal(f.services.fillBottle("main").ok, true);
  assert.deepEqual(f.world.serialize(), water);
  assert.equal(f.gameplay.getHandStack().count, 2);
  const filled = f.gameplay.slots.find((stack) => stack?.data?.potion);
  assert.equal(filled.data.potion.id, "water");
  assert.equal(filled.data.name, "River");
  f.editInventory((owned) => {
    for (let i = 1; i < 36; i++) owned.slots[i] = progressionStack(BLOCK.STONE, 64);
    return true;
  });
  const full = f.snapshot();
  assert.equal(f.services.fillBottle("main").reason, "inventory_full");
  assert.deepEqual(f.snapshot(), full);
});

test("held drinking requires real completion/hand identity and atomically replaces offhand potion with a bottle", (t) => {
  const f = progressionLiveFixture(t);
  f.editInventory((owned) => {
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    owned.offhand = potionStack(f.services.catalog, "healing", { strong: true });
    return true;
  });
  f.gameplay.damage(14, "fall");
  const use = drinkUse(f, "offhand"), before = f.snapshot();
  assert.equal(f.services.completeDrink(use).reason, "drink_not_complete");
  assert.deepEqual(f.snapshot(), before);
  finishUse(use);
  assert.equal(f.services.completeDrink(use).ok, true);
  assert.equal(f.gameplay.health, 14);
  assert.deepEqual(f.gameplay.offhand, progressionStack(ITEM.GLASS_BOTTLE));
  assert.equal(use.active, false);
  assert.equal(f.services.completeDrink(use).ok, false);
  const restored = progressionLiveFixture(t, { saved: f.snapshot() });
  assert.equal(restored.gameplay.health, 14, "instant healing never replays on import");
  f.editInventory((owned) => {
    owned.offhand = potionStack(f.services.catalog, "swiftness");
    return true;
  });
  const stale = drinkUse(f, "offhand");
  finishUse(stale);
  const bottle = f.gameplay.offhand;
  f.editInventory((owned) => { owned.offhand = null; return true; });
  f.editInventory((owned) => { owned.offhand = bottle; return true; });
  const replaced = f.snapshot();
  assert.equal(f.services.completeDrink(stale).reason, "stale_drink");
  assert.deepEqual(f.snapshot(), replaced);
});

test("timed drink effects advance only active dt and reload without a second application", (t) => {
  const f = progressionLiveFixture(t);
  f.editInventory((owned) => {
    owned.slots[0] = potionStack(f.services.catalog, "swiftness");
    return true;
  });
  const use = drinkUse(f);
  finishUse(use);
  assert.equal(f.services.completeDrink(use).ok, true);
  assert.equal(f.services.effects.serialize().effects[0].remainingTicks, 3600);
  assert.equal(f.services.gear.movementSpeed(10), 12);
  advance(f, 4);
  assert.equal(f.services.effects.serialize().effects[0].remainingTicks, 3580);
  f.game.paused = true;
  advance(f, 4);
  assert.equal(f.services.effects.serialize().effects[0].remainingTicks, 3580);
  const saved = f.snapshot();
  const restored = progressionLiveFixture(t, { saved });
  assert.deepEqual(restored.services.effects.serialize(), saved.progression.statusEffects);
  restored.gameplay.damage(100, "fall");
  assert.equal(restored.services.effects.hasActiveEffects, false);
  assert.equal(restored.services.gear.movementSpeed(10), 10);
});

test("drink completion rejects the legacy ID-only timer adapter instead of accepting a replacement potion", (t) => {
  const f = progressionLiveFixture(t);
  f.editInventory((owned) => {
    owned.slots[0] = potionStack(f.services.catalog, "healing");
    return true;
  });
  const use = new ItemUse();
  assert.equal(use.start("drink", "main", ITEM.POTION), true);
  finishUse(use);
  const before = f.snapshot();
  assert.equal(f.services.completeDrink(use).ok, false);
  assert.deepEqual(f.snapshot(), before);
});

test("hosted poison pulses real health on active ticks, respects the one-health floor and preserves its phase on reload", (t) => {
  const f = progressionLiveFixture(t);
  f.editInventory((owned) => {
    owned.slots[0] = potionStack(f.services.catalog, "poison");
    return true;
  });
  f.gameplay.damage(17, "fall");
  const use = drinkUse(f);
  finishUse(use);
  assert.equal(f.services.completeDrink(use).ok, true);
  assert.equal(f.gameplay.health, 3);
  advance(f, 1, 0.05);
  assert.equal(f.gameplay.health, 2, "the first duration-modulo poison pulse is applied by Gameplay");
  const saved = f.snapshot(), restored = progressionLiveFixture(t, { saved });
  advance(restored, 1, 0.05);
  assert.equal(restored.gameplay.health, 2, "import does not restart a fresh poison interval");
  restored.game.paused = true;
  advance(restored, 10);
  assert.equal(restored.gameplay.health, 2);
  restored.game.paused = false;
  advance(restored, 40);
  assert.equal(restored.gameplay.health, 1);
  assert.equal(restored.gameplay.dead, false);
});
