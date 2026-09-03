import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { experienceForLevel } from "../src/experience.js";
import {
  GameProgressionServices, normalizeProgressionServicesSnapshot,
} from "../src/game-progression-services.js";
import { ITEM } from "../src/items.js";
import {
  createProgressionStationsSnapshot, normalizeProgressionStationsSnapshot,
  stationEntryBytes, stationHeaderBytes,
} from "../src/progression-station-state.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { createWorldContext } from "../src/world-spec.js";
import { progressionLiveFixture, progressionStack } from "./progression-live-fixture.js";

function enchanting(t, options = {}) {
  const f = progressionLiveFixture(t, options);
  f.place("enchanting");
  f.shelfPositions = f.shelves();
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.DIAMOND_PICKAXE, 1, { name: "Deep pick ⛏" }, 1400);
    owned.slots[1] = progressionStack(ITEM.LAPIS, 8);
    return true;
  });
  assert.equal(f.open().opened, true);
  f.transfer(0, 0);
  f.transfer(1, 1);
  return f;
}

const enchantAction = (f) => {
  const view = f.services.view();
  assert.equal(view.bookshelfPower, 15);
  assert.equal(view.offers[2].available, true);
  return { type: "enchant", index: 2, offerKey: view.offers[2].key };
};

test("live table pays exactly three levels/lapis, preserves metadata and advances one saved seed", (t) => {
  const f = enchanting(t);
  const before = f.snapshot(), seed = f.services.stations.playerState.seed;
  const action = enchantAction(f);
  const plan = f.prepare(action);
  assert.equal(plan.ok, true);
  assert.deepEqual(f.snapshot(), before, "previews never own output or charge inputs");
  assert.equal(new Set(plan.participants.map((part) => part.owner)).size, 2);
  assert.equal(f.services.commit(plan).ok, true);
  const record = f.services.stations.get(f.at).record;
  assert.equal(record.input.id, ITEM.DIAMOND_PICKAXE);
  assert.equal(record.input.durability, 1400);
  assert.equal(record.input.data.name, "Deep pick ⛏");
  assert.ok(Object.keys(record.input.data.enchantments).length > 0);
  assert.equal(record.lapis.count, 5);
  assert.equal(f.gameplay.getState().experience.total, experienceForLevel(37));
  assert.notEqual(f.services.stations.playerState.seed, seed);
  const paid = f.snapshot();
  assert.equal(f.services.commit(plan).ok, false, "single-use participants cannot pay twice");
  assert.deepEqual(f.snapshot(), paid);
  const entries = f.services.stations.serialize().stations;
  assert.equal(f.services.stations.reservedBytes, stationHeaderBytes(f.context) +
    entries.reduce((sum, entry) => sum + stationEntryBytes(entry, f.services.catalog, f.context), 0) - 1);
});

test("closing, saving, full bags, death and dimension travel conserve table escrow and offer seed", (t) => {
  const f = enchanting(t, { seed: "" });
  const offers = f.services.view().offers;
  f.editInventory((owned) => {
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    owned.cursor = progressionStack(ITEM.APPLE, 3, { name: "Kept cursor" });
    return true;
  });
  const escrow = f.services.stations.serialize(), cursor = f.gameplay.cursor;
  assert.equal(f.services.close().escrowRetained, true);
  assert.equal(f.open().opened, true);
  assert.deepEqual(f.services.view().offers, offers);
  assert.deepEqual(f.services.stations.serialize(), escrow);
  f.gameplay.damage(100, "fall");
  assert.equal(f.services.isOpen, false);
  assert.deepEqual(f.services.stations.serialize(), escrow);
  assert.deepEqual(f.gameplay.cursor, cursor);
  assert.equal(f.gameplay.respawn(), true);
  f.services.onDimensionChange();
  f.world.setDimension("nether").generate(0);
  assert.deepEqual(f.services.stations.serialize(), escrow);
  assert.equal(f.services.stations.prepareOpen(f.at, { validate: () => true }), null);
  f.world.setDimension("overworld").generate(0);
  assert.equal(f.open().opened, true);
  assert.deepEqual(f.services.view().offers, offers);
  const reloaded = progressionLiveFixture(t, { saved: f.snapshot() });
  assert.equal(reloaded.world.seed, "");
  assert.deepEqual(reloaded.services.stations.serialize(), escrow);
  assert.equal(reloaded.open().opened, true);
  assert.deepEqual(reloaded.services.view().offers, offers);
  assert.deepEqual(reloaded.gameplay.cursor, cursor);
});

test("shelf ABA, physical pose ABA, hand revisions and closed sessions reject prepared payment", (t) => {
  const f = enchanting(t);
  for (const invalidate of [
    () => {
      const shelf = f.shelfPositions[0];
      f.put(shelf.x, shelf.y, shelf.z, BLOCK.AIR);
      f.put(shelf.x, shelf.y, shelf.z, BLOCK.BOOKSHELF);
    },
    () => {
      const position = f.player.position.clone();
      f.player.setPosition({ ...position, x: position.x + 1 });
      f.player.setPosition(position);
    },
    () => { f.gameplay.select(2); f.gameplay.select(0); },
    () => { f.services.close(); assert.equal(f.open().opened, true); },
  ]) {
    const plan = f.prepare(enchantAction(f));
    assert.equal(plan.ok, true);
    invalidate();
    const before = f.snapshot();
    assert.equal(f.services.commit(plan).ok, false);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("real obstruction, reach and ungenerated columns cannot admit an interactive station", (t) => {
  const f = progressionLiveFixture(t);
  f.place("enchanting");
  f.player.setPosition({ x: 8.5, y: 65, z: 14.5 });
  assert.equal(f.open().ok, false);
  f.player.setPosition({ x: 8.5, y: 65, z: 11.5 });
  f.put(8, 66, 10, BLOCK.STONE);
  assert.equal(f.open().ok, false);
  f.put(8, 66, 10, BLOCK.AIR);
  assert.equal(f.open().opened, true);
  f.services.close();
  const before = f.services.serialize(), columns = f.world.chunks.size;
  assert.equal(f.services.openStation({ x: 40, y: 65, z: 8, id: BLOCK.ENCHANTING_TABLE }).ok, false);
  assert.equal(f.world.chunks.size, columns);
  assert.deepEqual(f.services.serialize(), before);
});

test("unfunded enchanting refuses without spending seed, while a full bag keeps the paid result in escrow", (t) => {
  const f = enchanting(t);
  const action = enchantAction(f);
  f.editInventory((owned) => { owned.experienceTotal = experienceForLevel(29); return true; });
  const poor = f.snapshot();
  assert.equal(f.action(action).reason, "required_level");
  assert.deepEqual(f.snapshot(), poor);
  f.editInventory((owned) => {
    owned.experienceTotal = experienceForLevel(40);
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    return true;
  });
  assert.equal(f.action(action).ok, true);
  const paid = f.snapshot();
  assert.equal(f.action({ type: "quickMove", area: "container", index: 0 }).ok, false);
  assert.deepEqual(f.snapshot(), paid);
});

test("break/explosion prepares one World, station and retained-drop transfer, exactly once", (t) => {
  const f = enchanting(t);
  const input = f.services.stations.get(f.at).record.input;
  const changes = [{
    ...f.at, before: f.world.getCell(f.at.x, f.at.y, f.at.z),
    after: normalizeCell({ id: BLOCK.AIR }),
  }];
  const plan = f.services.prepareStationRemoval(changes, {
    extraDrops: [progressionStack(BLOCK.ENCHANTING_TABLE)],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.participants.length, 3);
  assert.equal(f.world.get(f.at.x, f.at.y, f.at.z), BLOCK.ENCHANTING_TABLE);
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.world.get(f.at.x, f.at.y, f.at.z), BLOCK.AIR);
  assert.equal(f.services.stations.get(f.at), null);
  const retained = f.overflow.serialize().entries;
  assert.equal(retained.find((stack) => stack.id === ITEM.LAPIS).count, 8);
  const tool = retained.find((stack) => stack.id === input.id);
  assert.deepEqual(tool.data, input.data);
  assert.equal(tool.wear, input.durability);
  assert.equal(retained.find((stack) => stack.id === BLOCK.ENCHANTING_TABLE).count, 1);
  const after = f.snapshot();
  assert.equal(f.services.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), after);
});

test("failed drop retention and post-preview escrow changes leave the station untouched", (t) => {
  const full = enchanting(t, { maxDropEntries: 1 });
  const changes = [{
    ...full.at, before: full.world.getCell(full.at.x, full.at.y, full.at.z),
    after: normalizeCell({ id: BLOCK.AIR }),
  }];
  const before = full.snapshot();
  assert.equal(full.services.prepareStationRemoval(changes).ok, false);
  assert.deepEqual(full.snapshot(), before);
  const f = enchanting(t);
  const plan = f.services.prepareStationRemoval([{
    ...f.at, before: f.world.getCell(f.at.x, f.at.y, f.at.z), after: normalizeCell({ id: BLOCK.AIR }),
  }]);
  assert.equal(plan.ok, true);
  assert.equal(f.action({ type: "click", area: "container", index: 1, button: 2 }).ok, true);
  const changed = f.snapshot();
  assert.equal(f.services.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), changed);
});

test("strict detached preflight preserves legacy seeds and rejects corruption without resetting escrow", (t) => {
  const f = progressionLiveFixture(t, { activate: false, seed: "" });
  const saved = f.services.serialize();
  for (const seed of ["", " ", "\u0000".repeat(80), "雪".repeat(80)]) {
    const context = createWorldContext({ seed, generatorVersion: 4 });
    const migrated = normalizeProgressionServicesSnapshot(undefined, context);
    assert.ok(migrated);
    assert.equal(migrated.stations.seed, seed);
    assert.deepEqual(normalizeProgressionServicesSnapshot(migrated, context), migrated);
  }
  for (const corrupt of [null, { ...saved, stations: undefined },
    { ...saved, version: 99 }, { ...saved, trading: null }])
    assert.equal(normalizeProgressionServicesSnapshot(corrupt, f.context), null);
  const station = { dimension: "overworld", x: 8, y: -64, z: 8,
    kind: "anvil", record: { version: 1, left: progressionStack(ITEM.BOOK, 1, { name: "Saved" }), right: null } };
  const snapshot = { ...createProgressionStationsSnapshot(f.context), stations: [station] };
  const clean = normalizeProgressionStationsSnapshot(snapshot, f.services.catalog, f.context);
  station.record.left.data.name = "Mutated caller";
  assert.equal(clean.stations[0].record.left.data.name, "Saved");
  assert.throws(() => normalizeProgressionStationsSnapshot({ ...snapshot,
    stations: [{ ...station, dimension: "nether", y: -1 }] }, f.services.catalog, f.context));
  assert.throws(() => normalizeProgressionStationsSnapshot({ ...snapshot,
    stations: [station, station] }, f.services.catalog, f.context));
  assert.deepEqual(f.services.serialize(), saved);
  assert.equal(f.game.progressionServices, undefined);
});

test("over-budget staged imports retain every owner; failed staging leaks no reservation", (t) => {
  const f = progressionLiveFixture(t, { activate: false });
  f.place("anvil");
  const saved = f.services.serialize();
  saved.stations.stations.push({ ...f.at, kind: "anvil",
    record: { version: 1, left: null, right: null } });
  const ballast = {};
  assert.equal(f.coordinator.register(ballast,
    MAX_RESERVED_BYTES + 1 - f.coordinator.budget.totalBytes, { allowOverBudget: true }), true);
  t.after(() => f.coordinator.release(ballast));
  const before = f.coordinator.budget.totalBytes;
  assert.throws(() => new GameProgressionServices({
    world: f.world, gameplay: f.gameplay, context: f.context, saved,
  }), /reserve|register/);
  assert.equal(f.coordinator.budget.totalBytes, before);
  const candidate = new GameProgressionServices({
    world: f.world, gameplay: f.gameplay, context: f.context, saved, allowOverBudget: true,
  });
  t.after(() => candidate.dispose());
  assert.deepEqual(candidate.serialize(), saved);
  assert.equal(candidate.activate(f.game, { getOwner: f.getOwner }).ok, true);
  const loadedBytes = f.coordinator.budget.totalBytes;
  const removal = candidate.prepareStationRemoval([{
    ...f.at, before: f.world.getCell(f.at.x, f.at.y, f.at.z), after: normalizeCell({ id: BLOCK.AIR }),
  }]);
  assert.equal(candidate.commit(removal).ok, true);
  assert.ok(f.coordinator.budget.totalBytes < loadedBytes);
  assert.equal(candidate.stations.size, 0);
});

test("detached activation is callback-free, rejects stale stages/live replacements and seals sidecar reloads", (t) => {
  const f = progressionLiveFixture(t, { activate: false });
  const before = f.snapshot();
  assert.equal(f.services.active, false);
  assert.equal(f.services.frame(0.25).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.calls.sessions.length, 0);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.activate().ok, true);
  assert.equal(f.activate().ok, true, "the same host activation is idempotent");
  assert.equal(f.calls.sessions.length, 0);
  assert.equal(f.services.stations.load(before.progression.stations), false);
  assert.equal(f.services.trading.load(before.progression.trading), false);
  assert.equal(f.services.effects.load(before.progression.statusEffects), false);
  assert.deepEqual(f.snapshot(), before);

  const candidate = new GameProgressionServices({
    world: f.world, gameplay: f.gameplay, context: f.context, saved: before.progression,
  });
  t.after(() => candidate.dispose());
  assert.equal(candidate.activate(f.game, { getOwner: f.getOwner }).reason, "progression_host_owned");
  assert.equal(f.services.active, true);
  assert.equal(candidate.active, false);
  assert.deepEqual(candidate.serialize(), before.progression);

  const stale = progressionLiveFixture(t, { activate: false });
  stale.world.setDimension("nether").generate(0);
  assert.equal(stale.activate().reason, "stale_progression_stage");
  assert.equal(stale.game.progressionServices, undefined);
  assert.throws(() => stale.services.serialize(), /stale/);
});

test("paused post-commit menu observers cannot discard newly retained physical station ownership", (t) => {
  let f;
  f = progressionLiveFixture(t, { onChange: () => { f.game.paused = true; } });
  f.place("anvil");
  const result = f.open();
  assert.equal(result.ok, true);
  assert.equal(result.opened, false);
  assert.equal(f.services.isOpen, false);
  assert.equal(f.services.stations.size, 1);
  const saved = f.services.stations.serialize();
  f.game.paused = false;
  assert.equal(f.open().opened, true, "an existing record is not re-admitted or re-notified");
  assert.deepEqual(f.services.stations.serialize(), saved);
});

test("the same coordinates in different dimensions own separate escrow and removal affects only the active one", (t) => {
  const f = progressionLiveFixture(t);
  f.place("anvil");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.BOOK, 1, { name: "Overworld escrow" });
    owned.slots[1] = progressionStack(ITEM.BOOK, 1, { name: "Nether escrow" });
    return true;
  });
  assert.equal(f.open().opened, true);
  f.transfer(0, 0);
  const overworld = f.services.stations.get(f.at);
  assert.equal(f.services.onDimensionChange().ok, true);
  f.world.setDimension("nether").generate(0);
  const nether = { ...f.at, dimension: "nether" };
  f.place("anvil", nether);
  assert.equal(f.open(nether).opened, true);
  f.transfer(1, 0);
  assert.equal(f.services.stations.size, 2);
  assert.equal(f.services.stations.get(nether).record.left.data.name, "Nether escrow");
  const removal = f.services.prepareStationRemoval([{
    ...nether, before: f.world.getCell(nether.x, nether.y, nether.z),
    after: normalizeCell({ id: BLOCK.AIR }),
  }]);
  assert.equal(f.services.commit(removal).ok, true);
  assert.equal(f.services.stations.get(nether), null);
  assert.deepEqual(f.services.stations.get(f.at), overworld);
  assert.equal(f.overflow.serialize().entries[0].dimension, "nether");
  assert.equal(f.overflow.serialize().entries[0].data.name, "Nether escrow");
  assert.equal(f.services.onDimensionChange().ok, true);
  f.world.setDimension("overworld").generate(0);
  assert.equal(f.open().opened, true);
  assert.deepEqual(f.services.stations.get(f.at), overworld);
});

test("closed idle host performs no progress publications, seed changes or inventory rebuild notifications", (t) => {
  const f = progressionLiveFixture(t);
  const before = f.snapshot();
  const revisions = [
    f.gameplay.revision, f.services.stations.revision,
    f.services.effects.revision, f.services.trading.revision, f.services.potions.revision,
  ];
  const calls = structuredClone(f.calls);
  for (let i = 0; i < 120; i++) assert.equal(f.services.frame(1 / 60).ok, true);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual([
    f.gameplay.revision, f.services.stations.revision,
    f.services.effects.revision, f.services.trading.revision, f.services.potions.revision,
  ], revisions);
  assert.deepEqual(f.calls, calls);
});
