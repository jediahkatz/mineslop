import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { armorItemId } from "../src/gear-content.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { dolphinSwimFixture } from "./dolphin-swim-fixture.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

const airState = (f) => ({
  air: f.gameplay.air, phase: f.gameplay.airPhase,
  drowning: f.gameplay._timers.drowning,
  rng: f.progression.services.stations.randomState,
});
const exposed = { underwater: true, restoreAir: false, protectedSeconds: 0 };

function fillNamedInventory(f) {
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    for (let i = 0; i < 36; i++)
      owned.slots[i] = progressionStack(ITEM.DIAMOND_PICKAXE, 1, {
        name: `Unworn named inventory ${i}`, enchantments: { efficiency: 3 },
      });
    return true;
  }), true);
}

function observeEquipment(t, gameplay) {
  let reads = 0;
  const get = Object.getOwnPropertyDescriptor(Gameplay.prototype, "equipment").get;
  Object.defineProperty(gameplay, "equipment", {
    configurable: true, get() { reads++; return get.call(this); },
  });
  t.after(() => { delete gameplay.equipment; });
  return () => reads;
}

for (const [label, environment] of [
  ["dry", {}],
  ["restoring", { underwater: true, restoreAir: true }],
  ["fully protected", { underwater: true, protectedAirSeconds: 1 / 60 }],
]) {
  test(`600 ${label} full-air real-host updates perform zero equipment reads/transactions`, async (t) => {
    const f = await gameMobFixture(t, { generatorVersion: 4 });
    fillNamedInventory(f);
    const owned = f.gameplay._owned, slots = owned.slots, before = airState(f);
    const equipmentReads = observeEquipment(t, f.gameplay);
    const slotReads = t.mock.method(f.gameplay, "getEquipmentStack");
    const prepare = t.mock.method(f.gameplay, "_prepareState");
    const commit = t.mock.method(f.coordinator, "commit");
    for (let i = 0; i < 600; i++) f.gameplay.update(1 / 60, environment);
    assert.equal(equipmentReads(), 0);
    assert.equal(slotReads.mock.callCount(), 0);
    assert.equal(prepare.mock.callCount(), 0);
    assert.equal(commit.mock.callCount(), 0);
    assert.equal(f.gameplay._owned, owned);
    assert.equal(f.gameplay._owned.slots, slots);
    assert.deepEqual(airState(f), before);
    t.diagnostic(`${label}: 600 updates, 0 equipment reads, 0 prepared/committed transactions`);
  });
}

test("non-full air, fractional phase and drowning progress never take the idle fast path", async (t) => {
  const f = await gameMobFixture(t, { generatorVersion: 4 });
  const cases = [
    { air: 19, phase: 0, drowning: 0, options: {}, expectedAir: 19.4 },
    { air: 20, phase: 0.023, drowning: 0, options: {}, expectedAir: 20 },
    { air: 20, phase: 0, drowning: 0.8, options: {}, expectedAir: 20 },
    { air: 19, phase: 0.023, drowning: 0.8,
      options: { underwater: true, restoreAir: true }, expectedAir: 20 },
    { air: 19, phase: 0.023, drowning: 0.8,
      options: { underwater: true, protectedAirSeconds: 0.1 }, expectedAir: 19 + 0.1 * (20 / 3.75) },
    { air: 20, phase: 0.023, drowning: 0,
      options: { underwater: true, protectedAirSeconds: 0.1 }, expectedAir: 20 },
  ];
  for (const c of cases) {
    assert.equal(f.coordinator.commit([f.gameplay._prepareState((draft) => {
      draft.air = c.air;
      draft.airPhase = c.phase;
      draft.timers.drowning = c.drowning;
      return true;
    })]).ok, true);
    const rng = airState(f).rng;
    f.gameplay.update(0.1, c.options);
    assert.ok(Math.abs(f.gameplay.air - c.expectedAir) < 1e-9);
    assert.equal(f.gameplay.airPhase, 0);
    assert.equal(f.gameplay._timers.drowning, 0);
    assert.equal(airState(f).rng, rng);
  }
});

for (const source of ["Water Breathing", "eye cell", "body cell"]) {
  test(`prepared exposed air rejects a real ${source} mutation without spending air or RNG`, async (t) => {
    const f = await dolphinSwimFixture(t);
    assert.equal(f.gameplay.inventoryTransaction((owned) => {
      owned.equipment.head = progressionStack(armorItemId("diamond", "head"), 1, {
        enchantments: { respiration: 3 },
      });
      return true;
    }), true);
    f.gameplay.update(0.023, { underwater: true });
    const before = airState(f);
    const plan = f.progression.prepareAir(0.1, exposed);
    assert.ok(plan);
    if (source === "Water Breathing") {
      const effect = f.progression.services.effects.prepare({
        version: 1, tickRemainder: 0,
        effects: [{ id: "water_breathing", amplifier: 0, remainingTicks: 200 }],
      });
      assert.equal(f.coordinator.commit([effect]).ok, true);
    } else {
      const { x, y, z } = f.player.position;
      const at = {
        x: Math.floor(x), z: Math.floor(z),
        y: Math.floor(y + (source === "eye cell" ? f.player.eyeHeight : 0)),
      };
      const chunk = f.world.chunks.get("0,0");
      const revision = chunk.revision;
      const cell = f.world.getCell(at.x, at.y, at.z);
      assert.equal(cell.id, BLOCK.WATER);
      assert.equal(f.world.applyCells([{
        ...at, before: cell, after: { id: BLOCK.AIR, state: 0, fluid: 0 },
      }]), true);
      assert.equal(f.world.chunks.get("0,0"), chunk);
      assert.ok(chunk.revision > revision);
    }
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(airState(f), before);
  });
}

test("Depth Strider substeps never read the whole inventory through equipment", async (t) => {
  const f = await dolphinSwimFixture(t);
  fillNamedInventory(f);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.equipment.feet = progressionStack(armorItemId("diamond", "feet"), 1, {
      enchantments: { depth_strider: 3 },
    });
    return true;
  }), true);
  f.swimStart();
  const equipmentReads = observeEquipment(t, f.gameplay);
  const prepare = t.mock.method(f.gameplay, "_prepareState");
  f.player.update(0.1, { waterMovement: (onGround) => f.progression.waterMovement(onGround) });
  assert.equal(equipmentReads(), 0);
  assert.equal(prepare.mock.callCount(), 0);
  assert.ok(f.player.velocity.z < -2);
});

test("single-slot equipment observations are detached and re-read removal immediately", async (t) => {
  const f = await dolphinSwimFixture(t);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.equipment.feet = progressionStack(armorItemId("diamond", "feet"), 1, {
      name: "Finite owned boots", enchantments: { depth_strider: 3 },
    });
    return true;
  }), true);
  const snapshot = f.gameplay.getEquipmentStack("feet");
  snapshot.data.name = "Detached edit";
  snapshot.data.enchantments.depth_strider = 1;
  assert.equal(f.gameplay.getEquipmentStack("feet").data.name, "Finite owned boots");
  assert.equal(f.progression.waterMovement(true).waterMovementEfficiency, 1);
  assert.equal(f.gameplay.getEquipmentStack("__proto__"), null);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.equipment.feet = null;
    return true;
  }), true);
  assert.equal(f.progression.waterMovement(true).waterMovementEfficiency, 0);
});
