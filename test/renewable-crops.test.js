import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK } from "../src/blocks.js";
import { CROP_SPECIES, cropDrops } from "../src/crop-rules.js";
import { ITEM } from "../src/items.js";
import { GameHarvestActions } from "../src/game-harvest-actions.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { Settlement, normalizeSettlementSnapshot } from "../src/settlement.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "../src/storage.js";
import { cropBatchFixture, prepareCropRemoval, cropDropCounts } from "./settlement-crop-batch-fixture.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";
import { inventoryStacks, traderFixture, tradeOptions } from "./progression-fixture.js";

export function renewableFixture(t, species = "carrot", age = 0, options = {}) {
  const f = cropBatchFixture(t, { crops: [], ...options });
  const rule = CROP_SPECIES[species];
  f.put(7, 0, 8, rule.soil);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots.fill(null);
    owned.slots[0] = { id: rule.item, count: 2 };
    return true;
  }), true);
  f.hit = { x: 7, y: 0, z: 8, id: rule.soil };
  f.cropHit = { x: 7, y: 1, z: 8, id: rule.young };
  assert.equal(f.settlement.plant(f.world, f.hit, f.gameplay), true);
  if (age) assert.equal(f.settlement.update(age, f.world), true);
  f.cropHit.id = f.world.get(7, 1, 8);
  f.plants = () => [{ ...f.cropHit, before: f.world.getCell(7, 1, 8) }];
  return f;
}

test("actual right click plants carrot before food only on valid farmland/space", () => {
  for (const hand of ["main", "offhand"]) {
    for (const targetKind of ["valid", "wrong-soil", "occupied", "reservation-veto"]) {
      const { game } = parityGame("survival", { generatorVersion: 4 });
      setOwnedSlots(game,
        [[3, { id: ITEM.CARROT, count: 8 }],
          [0, { id: hand === "main" ? ITEM.CARROT : ITEM.STICK, count: 2 }]],
        hand === "offhand" ? { id: ITEM.CARROT, count: 2 } : null);
      game.gameplay.hunger = 10;
      const soil = targetKind === "wrong-soil" ? BLOCK.DIRT : BLOCK.FARMLAND;
      game.world.set(2, 9, 0, soil);
      game.target = { x: 2, y: 9, z: 0, id: soil };
      if (targetKind === "occupied") game.world.set(2, 10, 0, BLOCK.STONE);
      if (targetKind === "reservation-veto")
        game.world.blocked.add(game.world.key(2, 10, 0));
      const before = game.gameplay.serialize();
      const result = game.useActions.begin();
      assert.equal(game.gameplay.getState().slots[3].count, 8);
      if (targetKind === "valid") {
        assert.equal(result, true);
        assert.equal(game.useActions.use.active, false);
        assert.equal(game.gameplay.getHandStack(hand).count, 1);
        assert.equal(game.world.get(2, 10, 0), BLOCK.CARROT_CROP);
        assert.equal(game.settlement.serialize().crops[0].species, "carrot");
      } else {
        assert.deepEqual(game.gameplay.serialize(), before);
        assert.equal(game.settlement.crops.size, 0);
        assert.equal(game.useActions.use.active, targetKind !== "reservation-veto");
      }
    }
  }
});

test("full hunger still plants; wart accepts soul sand only; metadata cannot be planted", () => {
  for (const [species, rule] of Object.entries(CROP_SPECIES)) {
    for (const soil of [BLOCK.FARMLAND, BLOCK.SOUL_SAND, BLOCK.STONE]) {
      const { game } = parityGame("survival", { generatorVersion: 4 });
      setOwnedSlots(game, [[0, { id: rule.item, count: 1 }]]);
      game.world.set(2, 9, 0, soil);
      game.target = { x: 2, y: 9, z: 0, id: soil };
      const accepted = soil === rule.soil;
      assert.equal(game.useActions.begin(), accepted, `${species}:${soil}`);
      assert.equal(game.settlement.crops.size, Number(accepted));
      assert.equal(game.gameplay.getHandStack()?.count ?? 0, accepted ? 0 : 1);
    }
  }
  const { game } = parityGame("survival", { generatorVersion: 4 });
  setOwnedSlots(game, [[0, { id: ITEM.CARROT, count: 1,
    data: { version: 1, name: "keepsake" } }]]);
  game.world.set(2, 9, 0, BLOCK.FARMLAND);
  game.target = { x: 2, y: 9, z: 0, id: BLOCK.FARMLAND };
  assert.equal(game.useActions.begin(), false);
  assert.equal(game.settlement.crops.size, 0);
});

test("right-click planting rejects replaced active owners without spending or eating", () => {
  for (const owner of ["world", "gameplay", "player", "settlement"]) {
    const { game } = parityGame("survival", { generatorVersion: 4 });
    setOwnedSlots(game, [[0, { id: ITEM.CARROT, count: 2 }]]);
    game.gameplay.hunger = 10;
    game.world.set(2, 9, 0, BLOCK.FARMLAND);
    game.target = { x: 2, y: 9, z: 0, id: BLOCK.FARMLAND };
    const { world, gameplay, settlement } = game;
    const before = [gameplay.serialize(), settlement.serialize(), world.getCell(2, 10, 0)];
    const prepare = gameplay.prepareInventory.bind(gameplay);
    gameplay.prepareInventory = (...args) => {
      const plan = prepare(...args);
      game[owner] = Object.create(game[owner]);
      return plan;
    };
    assert.equal(game.useActions.begin(), false);
    assert.equal(game.useActions.use.active, false);
    assert.deepEqual([gameplay.serialize(), settlement.serialize(), world.getCell(2, 10, 0)], before);
  }
});

test("planting cannot debit a different selected slot after World preparation", () => {
  const { game } = parityGame("survival", { generatorVersion: 4 });
  setOwnedSlots(game, [[0, { id: ITEM.CARROT, count: 2 }],
    [1, { id: ITEM.CARROT, count: 4 }]]);
  game.world.set(2, 9, 0, BLOCK.FARMLAND);
  game.target = { x: 2, y: 9, z: 0, id: BLOCK.FARMLAND };
  const slots = game.gameplay.getState().slots;
  const prepare = game.world.prepareMutation.bind(game.world);
  game.world.prepareMutation = (...args) => {
    const plan = prepare(...args);
    game.gameplay.select(1);
    return plan;
  };
  assert.equal(game.useActions.begin(), false);
  assert.deepEqual(game.gameplay.getState().slots, slots);
  assert.equal(game.settlement.crops.size, 0);
  assert.equal(game.world.get(2, 10, 0), BLOCK.AIR);
});

test("each species immature refund and mature surplus supports finite harvest/replant", (t) => {
  for (const [species, rule] of Object.entries(CROP_SPECIES)) {
    for (const mature of [false, true]) {
      const f = renewableFixture(t, species, mature ? rule.maxAge : 0);
      let samples = 0;
      f.gameplay.random = () => { samples++; return 0.5; };
      const expected = cropDrops([...f.settlement.crops.values()][0]);
      const before = f.snapshot();
      const plan = f.settlement.prepareHarvestCrop(f.world, f.cropHit, f.gameplay);
      assert.ok(plan);
      assert.deepEqual(f.snapshot(), before, "preparation publishes nothing");
      assert.equal(f.coordinator.commit(plan.participants).ok, true);
      assert.equal(f.world.get(7, 1, 8), BLOCK.AIR);
      assert.equal(f.settlement.crops.size, 0);
      assert.equal(f.gameplay.count(rule.item), 1 + expected.find(s => s.id === rule.item).count);
      assert.equal(samples, 0, "owned crop yields never reroll on retries");
      assert.equal(f.coordinator.commit(plan.participants).ok, false);
      assert.equal(f.settlement.plant(f.world, f.hit, f.gameplay), true);
      assert.equal(f.settlement.serialize().crops[0].age, 0);
    }
  }
});

test("growth freezes unloaded/inactive crops and partitions equivalently with bounded steps", (t) => {
  for (const species of Object.keys(CROP_SPECIES)) {
    const f = renewableFixture(t, species);
    const before = f.settlement.serialize();
    const chunk = f.world.chunks.get("0,0");
    f.world.chunks.delete("0,0");
    assert.equal(f.settlement.update(100000, f.world), false);
    assert.deepEqual(f.settlement.serialize(), before);
    f.world.chunks.set("0,0", chunk);
    f.world.dimension = "nether";
    assert.equal(f.settlement.update(100000, f.world), false);
    assert.deepEqual(f.settlement.serialize(), before);
    f.world.dimension = "overworld";
    for (let i = 0; i < 40; i++) f.settlement.update(0.25, f.world);
    assert.equal(f.settlement.serialize().crops[0].age, 10);
    const g = renewableFixture(t, species);
    g.settlement.update(10, g.world);
    assert.deepEqual(f.settlement.serialize().crops, g.settlement.serialize().crops);
    for (const dt of [NaN, Infinity, -1]) {
      assert.equal(f.settlement.update(dt, f.world), false);
      assert.equal(f.settlement.serialize().crops[0].age, 10);
    }
    f.settlement.update(100000, f.world);
    assert.equal(f.settlement.serialize().crops[0].age, CROP_SPECIES[species].maxAge);
  }
});

test("legacy position/age migration is lossless; unknown versions/species/fields fail closed", (t) => {
  const f = renewableFixture(t);
  for (const version of [1, 2, 3]) {
    const crops = [0, 12.375, 45].map((age, index) => ({
      dimension: "overworld", x: index, y: 20, z: 1, age,
    }));
    const legacy = { version, chests: [], ...(version === 1 ? {} : { furnaces: [] }), crops };
    const normalized = normalizeSettlementSnapshot(legacy, f.context);
    assert.equal(normalized.version, 4);
    assert.deepEqual(normalized.crops, crops.map(c => ({ ...c, version: 1, species: "wheat" })));
    assert.deepEqual(legacy.crops, crops);
    assert.equal(f.settlement.load(legacy, { world: f.world }), true);
    const canonical = f.settlement.serialize();
    assert.deepEqual(canonical, normalized);
    for (const edit of [
      c => c.version = 2, c => c.species = "future",
      c => c.age = 46, c => c.extra = "do not discard",
      c => delete c.species,
    ]) {
      const bad = structuredClone(canonical);
      edit(bad.crops[0]);
      assert.equal(f.settlement.load(bad, { world: f.world }), false);
      assert.deepEqual(f.settlement.serialize(), canonical);
    }
    const disguised = structuredClone(legacy);
    disguised.crops[0].species = "carrot";
    assert.equal(normalizeSettlementSnapshot(disguised, f.context), null);
  }
});

test("species washout pays once and overflow veto preserves cell, record, inventory and RNG", (t) => {
  for (const species of ["carrot", "nether_wart"]) {
    for (const age of [0, CROP_SPECIES[species].maxAge]) {
      const f = renewableFixture(t, species, age);
      let samples = 0;
      f.gameplay.random = () => { samples++; return 0; };
      const expected = cropDrops([...f.settlement.crops.values()][0])[0];
      const before = f.snapshot();
      const plan = prepareCropRemoval(f);
      assert.ok(plan);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.coordinator.commit(plan.participants).ok, true);
      assert.equal(f.settlement.crops.size, 0);
      assert.equal(cropDropCounts(f.overflow).get(expected.id), expected.count);
      assert.equal(f.coordinator.commit(plan.participants).ok, false);
      assert.equal(samples, 0);
      const g = renewableFixture(t, species, age, { maxEntries: 1 });
      assert.equal(g.overflow.enqueue([{ id: ITEM.STICK, count: 1 }],
        { x: 8, y: 1, z: 8 }, "overworld"), true);
      const blocked = g.snapshot();
      assert.equal(prepareCropRemoval(g), null);
      assert.deepEqual(g.snapshot(), blocked);
    }
  }
});

test("real fluid service replaces generic carrot/wart loot with owned age yields exactly once", (t) => {
  for (const species of ["carrot", "nether_wart"]) {
    for (const mature of [false, true]) {
      const f = renewableFixture(t, species, mature ? CROP_SPECIES[species].maxAge : 0);
      const service = new GameFluidServices({
        world: f.world, settlement: f.settlement, overflow: f.overflow,
        coordinator: f.coordinator, context: f.context,
      });
      t.after(() => service.dispose());
      assert.equal(service.activate({
        ...f, worldContext: f.context, simulating: true, paused: false,
        building: false, failed: false,
      }).ok, true);
      f.world.onMutation = event => service.onMutation(f.world, event);
      f.world.onChunkAdmitted = event => service.onChunkLoaded(f.world, event);
      const expected = cropDrops([...f.settlement.crops.values()][0])[0];
      const inventory = f.gameplay.serialize();
      f.put(8, 1, 8, BLOCK.WATER);
      for (let i = 0; i < 8; i++)
        assert.equal(service.frame(0.25, { simulating: true }).ok, true);
      assert.equal(f.settlement.crops.size, 0);
      assert.equal(cropDropCounts(f.overflow).get(expected.id), expected.count);
      assert.deepEqual(f.gameplay.serialize(), inventory);
    }
  }
});

test("mixed wheat/carrot/wart removal shares one bounded source and destination", (t) => {
  const f = renewableFixture(t);
  for (const [x, species] of [[9, "wheat"], [11, "nether_wart"]]) {
    const rule = CROP_SPECIES[species];
    f.put(x, 0, 8, rule.soil);
    assert.equal(f.gameplay.inventoryTransaction(owned => {
      owned.slots[0] = { id: rule.item, count: 1 };
      return true;
    }), true);
    assert.equal(f.settlement.plant(f.world, { x, y: 0, z: 8, id: rule.soil }, f.gameplay), true);
  }
  f.settlement.update(45, f.world);
  f.plants = () => [7, 9, 11].map(x => ({ x, y: 1, z: 8, before: f.world.getCell(x, 1, 8) }));
  const plan = prepareCropRemoval(f);
  assert.ok(plan);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.deepEqual(cropDropCounts(f.overflow),
    new Map([[ITEM.CARROT, 3], [ITEM.WHEAT, 2], [ITEM.SEEDS, 1], [ITEM.NETHER_WART, 2]]));
  assert.equal(f.settlement.crops.size, 0);
});

test("stale source, world epoch and inventory veto never half-pay crop transactions", (t) => {
  for (const invalidate of [
    f => f.world._epoch++,
    f => f.settlement.load(f.settlement.serialize(), { world: f.world }),
    f => f.gameplay.add(ITEM.STICK, 1),
    f => f.coordinator.release(f.settlement),
  ]) {
    const f = renewableFixture(t, "carrot", 40);
    const plan = f.settlement.prepareHarvestCrop(f.world, f.cropHit, f.gameplay);
    assert.ok(plan);
    invalidate(f);
    const before = f.snapshot();
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("full-inventory harvest reserves the exact species overflow before removing anything", (t) => {
  for (const species of ["carrot", "nether_wart"]) {
    const f = renewableFixture(t, species, CROP_SPECIES[species].maxAge);
    assert.equal(f.gameplay.inventoryTransaction(owned => {
      owned.slots.fill(null);
      for (let i = 0; i < owned.slots.length; i++)
        owned.slots[i] = { id: BLOCK.STONE, count: 64 };
      return true;
    }), true);
    let samples = 0;
    f.gameplay.random = () => { samples++; return 0.5; };
    const before = f.snapshot();
    assert.equal(f.settlement.prepareHarvestCrop(f.world, f.cropHit, f.gameplay), null);
    assert.deepEqual(f.snapshot(), before);
    const plan = f.settlement.prepareHarvestCrop(f.world, f.cropHit, f.gameplay, {
      prepareDrops: drops => f.overflow.prepareAddBatch(drops.map(stack => ({
        ...stack, x: 7, y: 1, z: 8, dimension: "overworld",
      }))),
    });
    assert.ok(plan);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.coordinator.commit(plan.participants).ok, true);
    assert.equal(f.settlement.crops.size, 0);
    assert.equal(f.world.get(7, 1, 8), BLOCK.AIR);
    assert.equal(cropDropCounts(f.overflow).get(CROP_SPECIES[species].item),
      species === "carrot" ? 3 : 2);
    assert.equal(samples, 0);
    assert.deepEqual(f.gameplay.serialize(), before.gameplay);
  }
});

test("unsupported growth tick never silently destroys a crop without a reward destination", (t) => {
  const f = renewableFixture(t);
  f.put(7, 0, 8, BLOCK.AIR);
  const before = f.snapshot();
  assert.equal(f.settlement.update(45, f.world), false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.settlement.harvestCrop(f.world, f.cropHit, f.gameplay), true);
});

test("real harvest soil break pays crop plus soil atomically, once, including overflow refusal", (t) => {
  for (const species of ["carrot", "nether_wart"]) {
    for (const explosion of [false, true]) {
      const f = renewableFixture(t, species, CROP_SPECIES[species].maxAge, { maxEntries: 2 });
      const game = { ...f, prepareDropItems: drops => f.overflow.prepareAddBatch(
        drops.map(stack => ({ ...stack, x: 7, y: 1, z: 8, dimension: "overworld" }))
      ) };
      const actions = new GameHarvestActions(game);
      const before = f.snapshot();
      const plan = actions.prepareBreak(f.hit, { explosion });
      assert.ok(plan);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(actions.commit(plan).ok, true);
      assert.equal(f.world.get(7, 0, 8), BLOCK.AIR);
      assert.equal(f.world.get(7, 1, 8), BLOCK.AIR);
      assert.equal(f.settlement.crops.size, 0);
      assert.equal(cropDropCounts(f.overflow).get(CROP_SPECIES[species].item),
        species === "carrot" ? 3 : 2);
      assert.equal(actions.commit(plan).ok, false);
      assert.equal(f.settlement.plant(f.world, f.hit, f.gameplay), false);
      const g = renewableFixture(t, species, 0, { maxEntries: 1 });
      const blockedActions = new GameHarvestActions({
        ...g, prepareDropItems: drops => g.overflow.prepareAddBatch(
          drops.map(stack => ({ ...stack, x: 7, y: 1, z: 8, dimension: "overworld" }))
        ),
      });
      const blocked = g.snapshot();
      assert.equal(blockedActions.prepareBreak(g.hit), null);
      assert.deepEqual(g.snapshot(), blocked);
    }
  }
});

test("natural wart remains generic loot and never creates or double-pays a crop record", (t) => {
  const f = cropBatchFixture(t, { crops: [] });
  f.put(7, 0, 8, BLOCK.SOUL_SAND);
  f.put(7, 1, 8, BLOCK.NETHER_WART_CROP);
  const actions = new GameHarvestActions({
    ...f, prepareDropItems: drops => f.overflow.prepareAddBatch(
      drops.map(stack => ({ ...stack, x: 7, y: 1, z: 8, dimension: "overworld" }))
    ),
  });
  const hit = { x: 7, y: 1, z: 8, id: BLOCK.NETHER_WART_CROP };
  assert.equal(f.settlement.hasCrop(f.world, hit), false);
  assert.equal(actions.break(hit).ok, true);
  const count = cropDropCounts(f.overflow).get(ITEM.NETHER_WART);
  assert.ok(count >= 2 && count <= 4);
  assert.equal(actions.break(hit).ok, false);
  assert.equal(cropDropCounts(f.overflow).get(ITEM.NETHER_WART), count);
  assert.equal(f.settlement.crops.size, 0);
});

test("mixed legacy wheat and new species survive world-file and IndexedDB roundtrips", async (t) => {
  const f = renewableFixture(t);
  const legacy = { version: 3, chests: [{
    dimension: "overworld", x: 1, y: 20, z: 1,
    slots: [{ id: ITEM.DIAMOND, count: 3 }, ...Array(26).fill(null)],
  }], furnaces: [], crops: [{
    dimension: "overworld", x: 9, y: 1, z: 8, age: 12.375,
  }] };
  const migrated = normalizeSettlementSnapshot(legacy, f.context);
  const saved = f.settlement.serialize();
  saved.chests = migrated.chests;
  saved.crops.push(...migrated.crops, {
    dimension: "nether", x: 10, y: 1, z: 8, age: 17.25, version: 1, species: "nether_wart",
  });
  assert.equal(f.settlement.load(saved, { world: f.world }), true);
  const archive = {
    version: 3, world: f.world.serialize(),
    settlement: f.settlement.serialize(), gameplay: f.gameplay.serialize(),
  };
  const file = parseWorldFile(exportWorldFile(archive));
  assert.deepEqual(file.settlement, archive.settlement);
  const indexedDB = new IDBFactory();
  const storage = new WorldStorage({ indexedDB });
  await storage.save(file);
  await storage.close();
  const reopened = new WorldStorage({ indexedDB });
  const loaded = await reopened.load();
  await reopened.close();
  const restored = new Settlement({ coordinator: f.coordinator, context: f.context });
  t.after(() => restored.dispose());
  assert.equal(restored.load(loaded.settlement), true);
  assert.deepEqual(restored.serialize(), archive.settlement);
  assert.deepEqual(loaded.gameplay, archive.gameplay);
});

test("novice farmer supplies initial carrots for paid, persistent finite stock", () => {
  const f = traderFixture("farmer");
  const offer = f.trading.offers(f.id).find(o => o.id === "farmer/planting-carrots");
  assert.ok(offer);
  assert.equal(offer.level, 1);
  assert.deepEqual(offer.inputs, [{ id: ITEM.EMERALD, count: 1 }]);
  assert.deepEqual(offer.output, { id: ITEM.CARROT, count: 2 });
  assert.equal(offer.maxUses, 4);
  inventoryStacks(f, []);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
  inventoryStacks(f, [{ id: ITEM.EMERALD, count: 5 }]);
  const plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f, 2000, 0, { count: 4 }));
  assert.ok(plan);
  assert.equal(f.trading.commit(plan).ok, true);
  assert.equal(f.inventory.count(ITEM.CARROT), 8);
  assert.equal(f.inventory.count(ITEM.EMERALD), 1);
  const saved = f.trading.serialize();
  assert.equal(f.trading.load(JSON.parse(JSON.stringify(saved))), true);
  assert.deepEqual(f.trading.serialize(), saved);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
});
