import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { CONDUIT_FRAME } from "../src/conduit-rules.js";
import { gameMiningDuration, updatePlayerVisualEffects } from "../src/game-conduit-services.js";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { armorItemId } from "../src/gear-content.js";
import { ITEM } from "../src/items.js";
import { progressionStack } from "./progression-live-fixture.js";
import { CONDUIT_AT, buildConduit, conduitFixture, putCell } from "./conduit-fixture.js";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const wet = { underwater: true, inWater: true };
const airState = (f) => ({
  air: f.gameplay.air, phase: f.gameplay.airPhase,
  rng: f.progression.services.stations.randomState,
});
const frameCell = (index = 0) => {
  const [dx, dy, dz] = CONDUIT_FRAME[index];
  return { x: CONDUIT_AT.x + dx, y: CONDUIT_AT.y + dy, z: CONDUIT_AT.z + dz };
};
function effects(f, entries) {
  assert.equal(f.coordinator.commit([f.progression.services.effects.prepare({
    version: 1, tickRemainder: 0, effects: entries.map(([id, amplifier, remainingTicks = 100]) =>
      ({ id, amplifier, remainingTicks })),
  })]).ok, true);
}
function helmet(f, enchantments) {
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.equipment.head = progressionStack(armorItemId("diamond", "head"), 1, { enchantments });
    return true;
  }), true);
}

test("actual Gameplay air clock combines conduit and potion with max, restores normally, preserves RNG", async (t) => {
  const f = await conduitFixture(t);
  buildConduit(f.world, 16);
  helmet(f, { respiration: 3 });
  f.gameplay.air = 5;
  const rng = airState(f).rng;
  f.gameplay.update(0.1, { ...wet, protectedAirSeconds: 0.025 });
  near(f.gameplay.air, 5 + 0.1 * (20 / 3.75));
  assert.equal(airState(f).rng, rng);
  assert.equal(f.gameplay.airPhase, 0);
  putCell(f.world, frameCell(), BLOCK.WATER);
  f.gameplay.update(0.025, wet);
  near(f.gameplay.airPhase, 0.025);
  assert.equal(airState(f).rng, rng);
  f.gameplay.update(0.025, wet);
  assert.equal(airState(f).rng, nextEnchantingSeed(rng));
  f.gameplay.update(0.1, { ...wet, restoreAir: true });
  assert.equal(f.gameplay.air, 20);
  assert.equal(f.gameplay.airPhase, 0);
});

test("prepared protected air rejects source mutation/unload/owner replacement and unknown stays frozen", async (t) => {
  const f = await conduitFixture(t);
  buildConduit(f.world, 16);
  f.gameplay.air = 5;
  const before = airState(f);
  const plan = f.progression.prepareAir(0.1, {
    underwater: true, restoreAir: false, protectedSeconds: 0,
  });
  assert.ok(plan);
  putCell(f.world, CONDUIT_AT, BLOCK.WATER);
  assert.equal(f.progression.commit(plan).ok, false);
  assert.deepEqual(airState(f), before);
  buildConduit(f.world, 16);
  const source = f.conduit.observePlayer();
  const chunk = f.world.chunks.get("0,0");
  f.world.chunks.delete("0,0");
  assert.equal(source.validate(), false);
  f.gameplay.update(0.1, { ...wet, airKnown: false });
  assert.deepEqual(airState(f), before);
  f.world.chunks.set("0,0", chunk);
  const current = f.conduit.observePlayer();
  f.game.player = { ...f.player };
  assert.equal(current.validate(), false);
  assert.equal(f.conduit.observePlayer(), null);
  f.game.player = f.player;
});

test("a fully protecting pre-tick potion does not borrow an unnecessary conduit guard", async (t) => {
  const f = await conduitFixture(t);
  const remote = { x: 18, y: 68, z: 8 };
  buildConduit(f.world, 16, remote);
  f.gameplay.air = 5;
  const plan = f.progression.prepareAir(0.1, {
    underwater: true, restoreAir: false, protectedSeconds: 0.1,
  });
  assert.ok(plan);
  putCell(f.world, remote, BLOCK.WATER);
  assert.equal(f.progression.commit(plan).ok, true);
  near(f.gameplay.air, 5 + 0.1 * (20 / 3.75));
});

test("live overlap never stacks; dry player, inclusive vertical range and foreign owner fail closed", async (t) => {
  const f = await conduitFixture(t);
  buildConduit(f.world, 16);
  buildConduit(f.world, 16, { x: 18, y: 68, z: 8 });
  f.player.setPosition({ x: 8.5, y: 100.5, z: 8.5 });
  assert.ok(f.conduit.observePlayer(), "inclusive vertical 32");
  f.player.setPosition({ x: 8.5, y: 100.500001, z: 8.5 });
  assert.equal(f.conduit.observePlayer(), null);
  f.player.setPosition({ x: 8.5, y: 106, z: 8.5 });
  assert.equal(f.conduit.observePlayer(), null, "dry player");
  f.player.setPosition({ x: 8.5, y: 68, z: 12.5 });
  f.gameplay.air = 5;
  f.gameplay.update(0.1, wet);
  near(f.gameplay.air, 5 + 0.1 * (20 / 3.75));
  const other = await conduitFixture(t);
  other.game.conduitServices = f.conduit;
  assert.deepEqual(updatePlayerVisualEffects(other.game), { nightVision: 0, conduitPower: false });
  other.gameplay.air = 5;
  other.gameplay.update(0.1, wet);
  near(other.gameplay.air, 5 - 0.1 * (20 / 15));
  other.game.conduitServices = other.conduit;
});

test("actual Game.frame sends fresh combined visuals immediately before graphics.update; pause freezes", async (t) => {
  const f = await conduitFixture(t);
  buildConduit(f.world, 16);
  effects(f, [["night_vision", 0, 500]]);
  const calls = [];
  f.game.graphics.setPlayerVisualEffects = (value) => calls.push({ ...value });
  f.game.graphics.update = () => {
    assert.ok(calls.length);
    assert.equal(calls.at(-1).conduitPower, !!f.conduit.observePlayer());
  };
  f.gameplay.air = 5;
  f.frame();
  near(f.gameplay.air, 5 + 0.05 * (20 / 3.75));
  assert.deepEqual(calls.at(-1), { nightVision: 1, conduitPower: true });
  const before = f.progression.services.effects.serialize();
  f.game.paused = true;
  f.frame(2);
  assert.deepEqual(f.progression.services.effects.serialize(), before);
  assert.deepEqual(calls.at(-1), { nightVision: 1, conduitPower: true });
  putCell(f.world, frameCell(), BLOCK.WATER);
  f.frame();
  assert.deepEqual(calls.at(-1), { nightVision: 1, conduitPower: false });
  f.gameplay.dead = true;
  f.frame();
  assert.deepEqual(calls.at(-1), { nightVision: 0, conduitPower: false });
  f.gameplay.dead = false;
});

test("actual Game.primary applies Efficiency/penalties/stronger Haste/fatigue once and pays a completed break", async (t) => {
  const f = await conduitFixture(t);
  const hit = { x: 8, y: 69, z: 11 };
  putCell(f.world, hit, BLOCK.STONE);
  f.game.target = { ...hit, ...f.world.getCell(hit.x, hit.y, hit.z) };
  f.hold("IRON_PICKAXE", { data: { version: 1, enchantments: { efficiency: 2 } } });
  f.player.grounded = true;
  // Iron raw=6, Efficiency II +5 => 11. Underwater /5 until Aqua Affinity.
  near(gameMiningDuration(f.game, BLOCK.STONE), 1.5 * 1.5 / (11 / 5));
  helmet(f, { aqua_affinity: 1 });
  near(gameMiningDuration(f.game, BLOCK.STONE), 2.25 / 11);
  f.player.grounded = false;
  near(gameMiningDuration(f.game, BLOCK.STONE), 2.25 / (11 / 5));
  f.player.grounded = true;
  buildConduit(f.world, 16);
  near(gameMiningDuration(f.game, BLOCK.STONE), 2.25 / (11 * 1.2));
  effects(f, [["haste", 0]]);
  near(gameMiningDuration(f.game, BLOCK.STONE), 2.25 / (11 * 1.2));
  effects(f, [["haste", 1]]);
  near(gameMiningDuration(f.game, BLOCK.STONE), 2.25 / (11 * 1.4));
  // Use the real ecology modifier consumer with a controlled projection; this
  // asserts composition, not elder-beam acquisition.
  t.mock.method(f.ecology, "modifiers", () => ({ miningSpeedMultiplier: 0.0027 }));
  near(gameMiningDuration(f.game, BLOCK.STONE), 2.25 / (11 * 1.4 * 0.0027));
  f.withGlobals(() => f.game.primary(gameMiningDuration(f.game, BLOCK.STONE) * 0.2));
  near(f.game.miningProgress, 0.2, "actual primary consumes ecology fatigue once");
  f.game.miningKey = "";
  f.game.miningProgress = 0;
  t.mock.restoreAll();
  const duration = gameMiningDuration(f.game, BLOCK.STONE);
  const durability = f.gameplay.getHandStack().durability;
  f.withGlobals(() => f.game.primary(duration * 0.5));
  near(f.game.miningProgress, 0.5);
  assert.equal(f.world.getCell(hit.x, hit.y, hit.z).id, BLOCK.STONE);
  f.withGlobals(() => f.game.primary(duration * 0.50001));
  assert.equal(f.world.getCell(hit.x, hit.y, hit.z).id, BLOCK.AIR);
  assert.equal(f.gameplay.getHandStack().durability, durability - 1);
  assert.ok(f.game.pickups.serialize().items.some((drop) => drop.id === BLOCK.COBBLESTONE) ||
    f.overflow.serialize().entries.some((entry) => entry.id === BLOCK.COBBLESTONE));
});

test("unenchant on-land duration remains baseline and fresh unknown coverage cannot mine", async (t) => {
  const f = await conduitFixture(t);
  f.hold("IRON_PICKAXE");
  f.player.setPosition({ x: 8.5, y: 105, z: 12.5 });
  f.player.grounded = true;
  near(gameMiningDuration(f.game, BLOCK.STONE), f.gameplay.miningDuration(BLOCK.STONE));
  const chunk = f.world.chunks.get("0,0");
  f.world.chunks.delete("0,0");
  assert.equal(gameMiningDuration(f.game, BLOCK.STONE), Infinity);
  f.world.chunks.set("0,0", chunk);
});

test("actual travel rollback retires old observations and reconstructs source cells under the recovered epoch", async (t) => {
  const f = await conduitFixture(t);
  buildConduit(f.world, 16);
  const old = f.conduit.observePlayer(), epoch = f.world.epoch;
  const visuals = [];
  f.game.graphics.setPlayerVisualEffects = (value) => visuals.push(value);
  updatePlayerVisualEffects(f.game);
  assert.equal(visuals.at(-1).conduitPower, true);
  const ensure = f.world.ensureArea;
  t.mock.method(f.world, "ensureArea", async function (...args) {
    if (this.dimension === "nether") {
      assert.equal(old.validate(), false);
      assert.deepEqual(visuals.at(-1), { nightVision: 0, conduitPower: false });
      throw new Error("controlled destination admission failure");
    }
    return Reflect.apply(ensure, this, args);
  });
  const result = await f.game.travel.teleport({ x: 40.5, y: 65, z: 40.5, dimension: "nether" });
  assert.equal(result.ok, false);
  assert.equal(result.rollbackFailed, undefined);
  assert.match(result.message, /controlled destination/);
  assert.equal(f.world.dimension, "overworld");
  assert.ok(f.world.epoch > epoch);
  assert.equal(old.validate(), false);
  assert.equal(f.conduit.active, true);
  for (let i = 0; i < 80; i++) f.conduit.frame(0);
  assert.ok(f.conduit.observePlayer());
  assert.equal(updatePlayerVisualEffects(f.game).conduitPower, true);
});

test("whole archive reload contains world conduit cells but no derived buff, RNG or cooldown ownership", async (t) => {
  const f = await conduitFixture(t);
  buildConduit(f.world, 16);
  f.gameplay.air = 7;
  const before = f.snapshot();
  assert.equal(JSON.stringify(before).includes("conduitPower"), false);
  assert.equal(JSON.stringify(before).includes("conduitServices"), false);
  assert.equal(f.progression.services.effects.serialize().effects.length, 0);
  const reloaded = await conduitFixture(t, { saved: before });
  for (let i = 0; i < 80; i++) reloaded.conduit.frame(0);
  assert.ok(reloaded.conduit.observePlayer());
  reloaded.gameplay.update(0.1, wet);
  near(reloaded.gameplay.air, 7 + 0.1 * (20 / 3.75));
  assert.equal(reloaded.progression.services.stations.randomState, airState(f).rng);
});

test("600 actual mining-duration reads never clone or traverse a named full backpack", async (t) => {
  const f = await conduitFixture(t);
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots.fill(null);
    for (let i = 0; i < draft.slots.length; i++)
      draft.slots[i] = progressionStack(BLOCK.STONE, 64, { name: `named backpack ${i}` });
    draft.slots[f.gameplay.selected] = progressionStack(ITEM.IRON_PICKAXE, 1, {
      name: "named mining tool", enchantments: { efficiency: 2 },
    });
    draft.equipment.head = progressionStack(armorItemId("diamond", "head"), 1, {
      name: "named helmet", enchantments: { aqua_affinity: 1 },
    });
    return true;
  }), true);
  buildConduit(f.world, 16);
  effects(f, [["haste", 1]]);
  f.player.grounded = true;
  const before = f.gameplay.serialize(), owned = f.gameplay._owned;
  let equipmentReads = 0, backpackReads = 0;
  const equipment = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f.gameplay), "equipment").get;
  t.mock.getter(f.gameplay, "equipment", function () {
    equipmentReads++;
    return Reflect.apply(equipment, this, []);
  });
  // Observe actual untouched backpack slot accesses, so avoiding just the
  // named equipment getter cannot hide a replacement whole-inventory clone.
  f.gameplay._owned = { ...owned, slots: new Proxy(owned.slots, {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property)) && Number(property) >= 9) backpackReads++;
      return Reflect.get(target, property, receiver);
    },
  }) };
  try {
    for (let i = 0; i < 600; i++)
      near(gameMiningDuration(f.game, BLOCK.STONE), 2.25 / (11 * 1.4));
  } finally {
    f.gameplay._owned = owned;
  }
  assert.equal(equipmentReads, 0);
  assert.equal(backpackReads, 0);
  assert.deepEqual(f.gameplay.serialize(), before);
  t.diagnostic(JSON.stringify({ miningCalls: 600, equipmentReads, backpackReads }));
});
