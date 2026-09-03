import assert from "node:assert/strict";
import test from "node:test";
import { ITEM } from "../src/items.js";
import { hurtFixture, loadVitals } from "./hurt-fixture.js";

test("accepted damage reports actual health loss once; invalid, busy and refused damage is silent", (t) => {
  const { gameplay, feedback, events } = hurtFixture(t);
  for (const amount of [0, -1, NaN, Infinity, undefined, "3"])
    assert.equal(gameplay.damage(amount), 0);
  assert.equal(events.length, 0);
  assert.equal(feedback.update(0).visible, false);
  assert.equal(
    gameplay.prepareInventory(() => {
      assert.equal(gameplay.damage(3), 0, "busy preparation rejects damage");
      return false;
    }),
    null
  );
  assert.equal(gameplay.damage(3, "fall"), 3);
  assert.deepEqual(events, [
    { previousHealth: 20, health: 17, damage: 3, dead: false },
  ]);
  assert.equal(Object.isFrozen(events[0]), true);
  assert.equal(feedback.update(0).visible, true);

  feedback.reset();
  assert.equal(gameplay.coordinator.release(gameplay), true);
  assert.equal(gameplay.damage(2), 0);
  assert.equal(gameplay.health, 17);
  assert.equal(events.length, 1);
  assert.equal(feedback.update(0).visible, false);
  assert.equal(
    gameplay.coordinator.register(gameplay, gameplay.reservedBytes),
    true
  );
});

test("armor, lethal health and reservations publish before hurt; wear/death/change ordering is retained", (t) => {
  const { gameplay } = hurtFixture(t);
  assert.equal(
    gameplay.inventoryTransaction((owned) => {
      owned.equipment.chest = { id: ITEM.IRON_ARMOR, count: 1, durability: 1 };
      return true;
    }),
    true
  );
  loadVitals(gameplay, { health: 2 });
  const revision = gameplay.revision;
  const observations = [];
  gameplay.onHurt = (event) =>
    observations.push({
      type: "hurt",
      event,
      health: gameplay.health,
      dead: gameplay.dead,
      chest: gameplay.equipment.chest,
      revision: gameplay.revision,
      bytes: gameplay.reservedBytes,
      reservation: gameplay.coordinator.usage(gameplay),
    });
  gameplay.onToast = (message) => observations.push({ type: "wear", message });
  gameplay.onDeath = (cause) => observations.push({ type: "death", cause });
  gameplay.onChange = (state) =>
    observations.push({
      type: "change",
      health: state.health,
      dead: state.dead,
    });
  assert.equal(gameplay.damage(10, "skeleton"), 2);
  assert.deepEqual(
    observations.map(({ type }) => type),
    ["hurt", "wear", "death", "change"]
  );
  const seen = observations[0];
  assert.deepEqual(seen.event, {
    previousHealth: 2,
    health: 0,
    damage: 2,
    dead: true,
  });
  assert.equal(seen.health, 0);
  assert.equal(seen.dead, true);
  assert.equal(seen.chest, null);
  assert.ok(seen.revision > revision);
  assert.equal(seen.bytes, seen.reservation);
  assert.equal(observations[2].cause, "skeleton");
  assert.equal(gameplay.damage(10), 0);
  assert.equal(observations.length, 4);
});

test("a broken hurt observer cannot roll health back or skip death or the health snapshot", (t) => {
  const { gameplay } = hurtFixture(t);
  const failure = new Error("visual observer failed");
  const observations = [];
  gameplay.onHurt = () => {
    observations.push("hurt");
    throw failure;
  };
  gameplay.onDeath = () => observations.push("death");
  gameplay.onChange = () => observations.push("change");
  assert.equal(gameplay.damage(30, "the void"), 20);
  assert.equal(gameplay.health, 0);
  assert.equal(gameplay.dead, true);
  assert.deepEqual(observations, ["hurt", "death", "change"]);
});

test("load/migration, healing, inventory changes, Creative and respawn never manufacture hurt", (t) => {
  const { gameplay, feedback, events } = hurtFixture(t);
  loadVitals(gameplay, { health: 8 });
  const save = gameplay.serialize();
  assert.equal(gameplay.load(save), true);
  const legacy = {
    version: 1,
    mode: "survival",
    health: 6,
    hunger: 20,
    air: 20,
    saturation: 5,
    exhaustion: 0,
    dead: false,
    deathCause: null,
    inventory: [{ id: ITEM.APPLE, count: 4 }],
    hotbar: [ITEM.APPLE, ...Array(8).fill(0)],
    survivalHotbar: [ITEM.APPLE, ...Array(8).fill(0)],
    selected: 0,
    durability: {},
    crafting: [],
    fuelTime: 0,
    timers: { drowning: 0, lava: 0, starvation: 0, regen: 0 },
  };
  assert.equal(gameplay.load(legacy), true);
  gameplay.update(4);
  assert.equal(gameplay.health, 7, "natural regeneration really healed");
  assert.equal(gameplay.add(ITEM.STICK), true);
  gameplay.notifyInventoryChange();
  assert.equal(gameplay.setMode("creative"), true);
  assert.equal(gameplay.damage(100, "fall"), 0);
  gameplay.update(60, { inLava: true, underwater: true, fallDistance: 30 });
  assert.equal(gameplay.health, 20);
  assert.equal(gameplay.setMode("survival"), true);
  assert.equal(gameplay.respawn(), true);
  assert.equal(events.length, 0);
  assert.equal(feedback.update(0).visible, false);
  gameplay.dispose();
  assert.equal(gameplay.damage(1), 0);
  assert.equal(events.length, 0);
});

test("fall, lava, drowning and starvation use the same committed-loss observer", (t) => {
  for (const source of ["fall", "lava", "drowning", "starvation"]) {
    const { gameplay, feedback, events } = hurtFixture(t);
    if (source === "drowning") loadVitals(gameplay, { air: 0 });
    if (source === "starvation")
      loadVitals(gameplay, { hunger: 0, saturation: 0 });
    gameplay.update(source === "starvation" ? 4 : source === "fall" ? 0.1 : 1, {
      fallDistance: source === "fall" ? 6 : 0,
      inLava: source === "lava",
      underwater: source === "drowning",
    });
    assert.ok(gameplay.health < 20, source);
    assert.ok(events.length > 0, source);
    assert.equal(
      events.reduce((sum, event) => sum + event.damage, 0),
      20 - gameplay.health,
      "each committed health loss appears exactly once"
    );
    assert.equal(feedback.update(0).visible, true, source);
  }
});
