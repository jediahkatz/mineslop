import assert from "node:assert/strict";
import test from "node:test";
import { armorItemId } from "../src/gear-content.js";
import { Gameplay } from "../src/gameplay.js";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { dolphinSwimFixture, neutralNextStep, closePoint } from "./dolphin-swim-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

const wet = { underwater: true, inWater: true };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

// Finite authored equipment for consumer acceptance, NOT Survival acquisition.
function equip(f, name, level) {
  const slot = name === "respiration" ? "head" : "feet";
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.equipment[slot] = level === null ? null : progressionStack(
      armorItemId("diamond", slot), 1,
      level ? { enchantments: { [name]: level } } : undefined,
    );
    return true;
  }), true);
}
const airState = (f) => ({
  air: f.gameplay.air, phase: f.gameplay.airPhase,
  drowning: f.gameplay.serialize().timers.drowning,
  rng: f.progression.services.stations.randomState,
});

test("live Gameplay keeps unenchant air at 15 seconds and one drowning pulse/second", async (t) => {
  const f = await gameMobFixture(t, { generatorVersion: 4 });
  const plain = new Gameplay();
  t.after(() => plain.dispose());
  const rng = airState(f).rng;
  for (const dt of [0.013, 0.147, 0.09, 1.25, 4.5, 8, 1, 0.5, 0.5]) {
    f.gameplay.update(dt, wet);
    plain.update(dt, wet);
    near(f.gameplay.air, plain.air);
    near(f.gameplay.health, plain.health);
    near(f.gameplay.serialize().timers.drowning, plain.serialize().timers.drowning);
  }
  assert.equal(f.gameplay.air, 0);
  assert.equal(f.gameplay.health, 18);
  assert.equal(airState(f).rng, rng, "plain breathing consumes no RNG");
});

for (const level of [1, 2, 3]) {
  test(`Respiration ${level}: saved RNG probability, fixed clock, partition + archive reload`, async (t) => {
    const whole = await gameMobFixture(t, { generatorVersion: 4 });
    equip(whole, "respiration", level);
    const saved = whole.snapshot();
    const split = await gameMobFixture(t, { saved });
    let rng = airState(whole).rng, loss = 0;
    for (let tick = 0; tick < 300; tick++) {
      rng = nextEnchantingSeed(rng);
      loss += Number(rng / 0x100000000 < 1 / (level + 1));
    }
    whole.gameplay.update(15, wet);
    // Deliberately not multiples of a physics/air tick, save with a remainder.
    for (let i = 0; i < 37; i++) split.gameplay.update(0.017, wet);
    const resumed = await gameMobFixture(t, { saved: split.snapshot() });
    assert.ok(resumed.gameplay.airPhase > 0);
    for (let i = 0; i < 143; i++) resumed.gameplay.update(0.1, wet);
    resumed.gameplay.update(15 - 37 * 0.017 - 14.3, wet);
    near(whole.gameplay.air, 20 - loss * (20 / 300));
    near(resumed.gameplay.air, whole.gameplay.air);
    near(resumed.gameplay.airPhase, whole.gameplay.airPhase);
    assert.equal(airState(whole).rng, rng);
    assert.equal(airState(resumed).rng, rng);
    assert.ok(whole.gameplay.air > 7, "actual extended underwater survival");
    t.diagnostic(`L${level}: 300 opportunities, ${loss} decrements, air=${whole.gameplay.air}`);
  });
}

test("Respiration gates the SAME drowning countdown; no second RNG/damage timer", async (t) => {
  const f = await gameMobFixture(t, { generatorVersion: 4 });
  equip(f, "respiration", 3);
  assert.equal(f.coordinator.commit([f.gameplay._prepareState((draft) => {
    draft.air = 0;
    return true;
  })]).ok, true);
  let rng = airState(f).rng, ticks = 0;
  for (let i = 0; i < 120; i++) {
    rng = nextEnchantingSeed(rng);
    ticks += Number(rng / 0x100000000 < 0.25);
  }
  f.gameplay.update(6, wet);
  assert.equal(airState(f).rng, rng);
  assert.equal(f.gameplay.health, 20 - Math.floor(ticks / 20) * 2);
  near(airState(f).drowning, (ticks % 20) / 20);
});

test("unknown air, paused host and rejected prepared transactions retain air phase and RNG", async (t) => {
  const f = await gameMobFixture(t, { generatorVersion: 4 });
  equip(f, "respiration", 3);
  f.gameplay.update(0.023, wet);
  const before = airState(f);
  f.gameplay.update(1, { ...wet, airKnown: false, restoreAir: true });
  assert.deepEqual(airState(f), before);
  f.game.paused = true;
  f.gameplay.update(1, wet);
  assert.deepEqual(airState(f), before);
  f.game.paused = false;
  for (const invalidate of [
    () => { f.game.paused = true; },
    () => { f.player.world = {}; },
    () => { f.projectiles.cancel("test", { advanceLife: true }); },
  ]) {
    const plan = f.progression.prepareAir(0.1, { ...wet, restoreAir: false, protectedSeconds: 0 });
    assert.ok(plan);
    invalidate();
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(airState(f), before);
    f.game.paused = false;
    f.player.world = f.world;
  }
  const plan = f.progression.prepareAir(0.1, { ...wet, restoreAir: false, protectedSeconds: 0 });
  const key = "0,0", chunk = f.world.chunks.get(key);
  f.world.chunks.delete(key); // Controlled eviction between prepare and commit.
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(airState(f), before);
  f.world.chunks.set(key, chunk);
});

test("restore-air bubbles outrank Respiration; removing helmet immediately restores plain drain", async (t) => {
  const f = await gameMobFixture(t, { generatorVersion: 4 });
  equip(f, "respiration", 2);
  f.gameplay.update(0.073, wet);
  const rng = airState(f).rng;
  f.gameplay.update(0.1, { ...wet, restoreAir: true });
  assert.deepEqual(airState(f), { air: 20, phase: 0, drowning: 0, rng });
  f.gameplay.update(0.023, wet);
  equip(f, "respiration", null);
  f.gameplay.update(0.1, wet);
  near(f.gameplay.air, 20 - 0.1 * (20 / 15));
  assert.equal(f.gameplay.airPhase, 0);
  assert.equal(airState(f).rng, rng);
});

test("real Game consumes native Water Breathing PRE-tick expiry before Respiration", async (t) => {
  const f = await dolphinSwimFixture(t);
  equip(f, "respiration", 3);
  f.gameplay.air = 5;
  const effects = f.progression.services.effects;
  assert.equal(f.coordinator.commit([effects.prepare({
    version: 1, tickRemainder: 0.5,
    effects: [{ id: "water_breathing", amplifier: 0, remainingTicks: 1 }],
  })]).ok, true);
  const rng = airState(f).rng;
  f.frameMs(50);
  near(f.gameplay.air, 5 + 0.025 * (20 / 3.75));
  near(f.gameplay.airPhase, 0.025);
  assert.equal(airState(f).rng, rng, "last half-protected frame has no complete exposed tick");
  assert.equal(effects.modifiers.waterBreathing, false);
  f.frameMs(25);
  assert.equal(airState(f).rng, nextEnchantingSeed(rng), "exactly one exposed tick next frame");
});

test("actual Game unknown-fluid, hidden-tab and pause paths freeze air/RNG, not catch up", async (t) => {
  const f = await dolphinSwimFixture(t);
  equip(f, "respiration", 2);
  f.frameMs(23);
  const before = airState(f);
  f.game.paused = true;
  f.frameMs(100);
  assert.deepEqual(airState(f), before);
  f.game.paused = false;
  f.document.hidden = true;
  f.frameMs(100);
  assert.deepEqual(airState(f), before);
  f.document.hidden = false;
  const key = "0,0", chunk = f.world.chunks.get(key);
  f.world.chunks.delete(key);
  f.frameMs(25);
  assert.equal(f.player.fluidMovementBlocked, true);
  assert.deepEqual(airState(f), before);
  f.world.chunks.set(key, chunk);
  f.frameMs(27);
  near(f.gameplay.airPhase, 0);
  assert.equal(airState(f).rng, nextEnchantingSeed(before.rng));
});

test("saved air phase is validated atomically and mode/respawn reset it", () => {
  const gameplay = new Gameplay();
  try {
    const saved = gameplay.serialize();
    for (const airPhase of [-1, 0.05, NaN, Infinity, "0.01", null, {}]) {
      assert.equal(gameplay.load({ ...saved, airPhase }), false);
      assert.deepEqual(gameplay.serialize(), saved);
    }
    assert.equal(gameplay.load({ ...saved, airPhase: 0.023 }), true);
    assert.equal(gameplay.airPhase, 0.023);
    assert.equal(gameplay.setMode("creative"), true);
    assert.equal(gameplay.airPhase, 0);
    assert.equal(gameplay.load({ ...saved, airPhase: 0.023 }), true);
    gameplay.respawn();
    assert.equal(gameplay.airPhase, 0);
  } finally { gameplay.dispose(); }
});

test("real Game wires each Depth Strider level, sprint and Dolphin's Grace, with removal", async (t) => {
  const f = await dolphinSwimFixture(t);
  const distances = [];
  for (const level of [0, 1, 2, 3]) {
    equip(f, "depth_strider", level);
    f.swimStart();
    const air = f.gameplay.air;
    const update = f.frameMs(100);
    near(f.gameplay.air, air - 0.1 * (20 / 15)); // Exactly one Game air advance.
    distances.push(update.before.z - update.after.z);
    assert.equal(f.player.grounded, false);
  }
  for (let i = 1; i < distances.length; i++) assert.ok(distances[i] > distances[i - 1]);
  f.feed();
  f.swimStart();
  f.key("ControlLeft");
  const update = f.frameMs(100);
  near(update.before.z - update.after.z, distances[3] * 1.3 * 1.6);
  f.key("ControlLeft", false);
  // Remove boots and the temporary dolphin source, without resetting inertia.
  equip(f, "depth_strider", null);
  assert.equal(f.ecology.hurt(f.dolphin, 1000, null).killed, true);
  const expected = neutralNextStep(t, f, 0.05);
  f.frameMs();
  closePoint(f.player.position, expected.position);
  closePoint(f.player.velocity, expected.velocity);
  t.diagnostic(`airborne 100ms displacement levels 0–3: ${distances.join(", ")}`);
});

test("a foreign live progression host cannot lend water gear to another Game", async (t) => {
  const f = await dolphinSwimFixture(t), other = await dolphinSwimFixture(t);
  equip(other, "depth_strider", 3);
  f.swimStart();
  const expected = neutralNextStep(t, f, 0.05);
  const host = f.game.progressionIntegration;
  try {
    f.game.progressionIntegration = other.progression;
    assert.equal(other.progression.active, true);
    f.frameMs();
    closePoint(f.player.position, expected.position);
    closePoint(f.player.velocity, expected.velocity);
  } finally { f.game.progressionIntegration = host; }
});
