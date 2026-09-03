import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  difficultyMobDamage,
  difficultyPolicy,
  hostileLimitForDifficulty,
  mobDifficultyAction,
  mobSpawnAllowedByDifficulty,
  normalizeDifficulty,
  peacefulMobCombatReset,
} from "../src/mob-difficulty.js";

const spec = (temperament) =>
  Object.freeze({ temperament, cooldown: 1.5, health: 20 });
const passive = spec("passive");
const neutral = spec("neutral");
const hostile = spec("hostile");
const watchful = spec("watchful");

test("missing legacy difficulty defaults, but explicit invalid values never select a mode", () => {
  assert.equal(normalizeDifficulty(), DEFAULT_DIFFICULTY);
  assert.equal(normalizeDifficulty({}.difficulty), "normal");
  for (const value of DIFFICULTIES)
    assert.equal(normalizeDifficulty(value), value);
  for (const value of [
    null,
    "",
    "Normal",
    " normal ",
    "survival",
    "hardcore",
    "toString",
    "__proto__",
    0,
    1,
    true,
    [],
    {},
    Object("normal"),
  ]) {
    assert.throws(() => normalizeDifficulty(value), RangeError);
    assert.throws(() => difficultyPolicy(value), RangeError);
  }
});

test("resolved policies are immutable and have no mutable cross-world state", () => {
  const normal = difficultyPolicy();
  assert.equal(normal, difficultyPolicy("normal"));
  assert.throws(() => {
    normal.mobCombat = false;
  }, TypeError);
  assert.throws(() => {
    DIFFICULTIES.push("other");
  }, TypeError);
  difficultyPolicy("peaceful");
  assert.equal(difficultyPolicy().mobCombat, true);
});

test("combat scales raw damage without amplifying weak Easy hits or altering Normal", () => {
  for (const base of [0, 0.125, 1, 2, 3, 6, 14, 1000]) {
    const easy = difficultyMobDamage(base, "easy");
    const normal = difficultyMobDamage(base, "normal");
    const hard = difficultyMobDamage(base, "hard");
    assert.equal(difficultyMobDamage(base, "peaceful"), 0);
    assert.equal(difficultyMobDamage(base), base, "legacy combat is Normal");
    assert.equal(normal, base);
    assert.ok(easy >= 0 && easy <= normal && normal <= hard);
    assert.ok(hard <= normal * 1.5);
    if (base <= 2)
      assert.equal(easy, base, "small hits must not gain the Easy bonus");
    else assert.equal(easy, base / 2 + 1);
  }
  // Armor is deliberately outside this helper: scaling its output again would
  // both double-scale and incorrectly add the Easy bonus after mitigation.
  const armor = (damage) => damage * 0.6;
  assert.equal(armor(difficultyMobDamage(6, "easy")), 2.4);
});

test("invalid difficulty rejects even otherwise harmless or no-op policy calls", () => {
  for (const value of [null, false, "unknown"]) {
    assert.throws(() => difficultyMobDamage(0, value), RangeError);
    assert.throws(() => hostileLimitForDifficulty(value, 0), RangeError);
    assert.throws(
      () => mobSpawnAllowedByDifficulty(passive, value),
      RangeError
    );
    assert.throws(
      () => mobDifficultyAction({ spec: passive, dead: true }, value),
      RangeError
    );
  }
  for (const value of [null, -1, "3", NaN, Infinity])
    assert.throws(() => difficultyMobDamage(value, "normal"), RangeError);
  assert.throws(
    () => difficultyMobDamage(Number.MAX_VALUE, "hard"),
    RangeError
  );
});

test("hostile admission is separate from passive habitat, density and species data", () => {
  const animal = Object.freeze({
    ...passive,
    habitat: /plains|meadow/,
    weight: 4,
    limit: 3,
  });
  const before = structuredClone(animal);
  for (const value of DIFFICULTIES) {
    assert.equal(mobSpawnAllowedByDifficulty(animal, value), true);
    assert.equal(mobSpawnAllowedByDifficulty(neutral, value), true);
    for (const species of [hostile, watchful])
      assert.equal(
        mobSpawnAllowedByDifficulty(species, value),
        difficultyPolicy(value).hostileSpawns
      );
  }
  assert.deepEqual(animal, before);
  assert.equal(mobSpawnAllowedByDifficulty(hostile), true);
  for (const invalid of [null, {}, { temperament: "unknown" }])
    assert.throws(() => mobSpawnAllowedByDifficulty(invalid), RangeError);
});

test("admission remains bounded by the existing host budget in every mode", () => {
  for (const maximum of [0, 1, 10, 28]) {
    for (const value of DIFFICULTIES) {
      const limit = hostileLimitForDifficulty(value, maximum);
      let population = 0;
      for (let attempt = 0; attempt < 40; attempt++) {
        if (mobSpawnAllowedByDifficulty(hostile, value) && population < limit)
          population++;
      }
      assert.ok(population <= maximum);
      assert.equal(population, value === "peaceful" ? 0 : maximum);
      assert.equal(mobSpawnAllowedByDifficulty(passive, value), true);
    }
  }
  for (const maximum of [undefined, null, -1, 1.5, "10", NaN, Infinity])
    assert.throws(
      () => hostileLimitForDifficulty("normal", maximum),
      RangeError
    );
});

test("Peaceful retains unique encounters without completing, killing or rewarding them", () => {
  for (const species of [hostile, watchful]) {
    const encounter = Object.freeze({
      id: "monument/encounter/elder:west",
      spec: species,
      health: 7,
      position: Object.freeze({ x: 8, y: 40, z: 3 }),
      state: Object.freeze({ alive: true, completed: false, claimed: false }),
    });
    const before = structuredClone(encounter);
    assert.equal(mobDifficultyAction(encounter, "peaceful"), "suspend");
    for (const value of ["easy", "normal", "hard"])
      assert.equal(mobDifficultyAction(encounter, value), "keep");
    assert.deepEqual(encounter, before);
  }
});

test("owned, saddled and tamed creatures are pacified instead of removed or hidden", () => {
  for (const species of [passive, neutral, hostile, watchful]) {
    const mob = Object.freeze({ spec: species, health: 7 });
    assert.equal(
      mobDifficultyAction(mob, "peaceful", { owned: true }),
      "pacify"
    );
    assert.equal(
      mobDifficultyAction(mob, "peaceful", { saddled: true }),
      "pacify"
    );
    assert.equal(
      mobDifficultyAction({ ...mob, tamed: true }, "peaceful"),
      "pacify"
    );
    assert.equal(
      mobDifficultyAction({ ...mob, saddled: true }, "peaceful"),
      "pacify"
    );
    assert.equal(mobDifficultyAction(mob), "keep");
  }
  assert.equal(mobDifficultyAction({ spec: passive }, "peaceful"), "pacify");
  assert.equal(mobDifficultyAction({ spec: neutral }, "peaceful"), "pacify");
  assert.equal(
    mobDifficultyAction({ spec: hostile, dead: true }, "peaceful"),
    "keep"
  );
  for (const options of [{ owned: 1 }, { saddled: "yes" }])
    assert.throws(
      () => mobDifficultyAction({ spec: hostile }, "peaceful", options),
      RangeError
    );
});

test("combat reset disarms stale attacks without altering identity, HP or ownership", () => {
  const mob = Object.freeze({
    id: "retained:1",
    spec: hostile,
    health: 11,
    position: Object.freeze({ x: 0, y: 9, z: 4 }),
    owned: true,
    saddled: true,
    angry: 20,
    fuse: 1.64,
    lookTimer: 0.65,
    attacking: true,
    fusing: true,
    attackCooldown: 0,
    followTime: 10,
    pacified: 30,
    encounter: Object.freeze({ completed: false, rewardClaimed: false }),
  });
  const before = structuredClone(mob);
  const patch = peacefulMobCombatReset(mob.spec);
  assert.deepEqual(mob, before, "obtaining a reset is side-effect free");
  const pacified = { ...mob, ...patch };
  for (const field of [
    "id",
    "spec",
    "health",
    "position",
    "owned",
    "saddled",
    "followTime",
    "pacified",
    "encounter",
  ])
    assert.equal(pacified[field], mob[field], field);
  for (const field of ["angry", "fuse", "lookTimer"])
    assert.equal(pacified[field], 0);
  assert.equal(pacified.attacking, false);
  assert.equal(pacified.fusing, false);
  assert.equal(pacified.attackCooldown, mob.spec.cooldown);
  assert.throws(() => {
    patch.health = 0;
  }, TypeError);
  for (const invalid of [null, {}, { cooldown: -1 }, { cooldown: Infinity }])
    assert.throws(() => peacefulMobCombatReset(invalid), RangeError);
});
