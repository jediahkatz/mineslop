import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  chooseMobSpawnSpecies,
  countMobSpawnPopulation,
  createMobSpawnClock,
  MOB_SPAWN_LIMITS,
  MOB_SPAWN_POOLS,
  mobPopulationPool,
  mobSpawnDistanceAllowed,
  naturalMobSpawnCandidates,
  planMobSpawnGroup,
  remainingMobSpawnCapacity,
  sampleMobSpawnColumn,
  stepMobSpawnClock,
} from "../src/mob-spawn-policy.js";
import { MAX_MOBS } from "../src/mob-species.js";

const empty = () => countMobSpawnPopulation([]);
const site = (changes = {}) => ({
  loaded: true, dimension: "overworld", biomeId: "plains",
  timeOfDay: 0.5, underground: false, water: false,
  groundId: BLOCK.GRASS, blockLight: 0, skyLight: 15,
  ...changes,
});
const kinds = (name, sample, population = empty(), options) =>
  naturalMobSpawnCandidates(name, sample, population, options).map((entry) => entry.kind);
const dueClock = () => {
  const clock = createMobSpawnClock("seed:overworld");
  for (const lane of Object.values(clock.lanes)) lane.remaining = 0;
  return clock;
};

test("startup and pause/resume cannot create an immediate refill or accumulated spawn debt", () => {
  const clock = createMobSpawnClock("seed:overworld");
  const before = structuredClone(clock);
  assert.deepEqual(stepMobSpawnClock(clock, 0.2).pulses, []);
  const paused = stepMobSpawnClock(clock, 3600, { paused: true });
  assert.equal(paused.state, clock);
  assert.deepEqual(paused.pulses, []);
  assert.deepEqual(stepMobSpawnClock(clock, 3600), stepMobSpawnClock(clock, MOB_SPAWN_LIMITS.step));
  assert.deepEqual(clock, before);
  const due = stepMobSpawnClock(dueClock(), 3600);
  assert.equal(due.pulses.length, Object.keys(MOB_SPAWN_POOLS).length);
  assert.deepEqual(stepMobSpawnClock(due.state, 0.2).pulses, []);
  for (const dt of [0, -1, NaN, Infinity])
    assert.equal(stepMobSpawnClock(clock, dt).state, clock);
});

test("restoring cannot bypass replenishment cooldowns through repeated reloads", () => {
  const fresh = createMobSpawnClock("seed:overworld", { restored: false });
  const restored = createMobSpawnClock("seed:overworld");
  for (const [name, rule] of Object.entries(MOB_SPAWN_POOLS)) {
    assert.ok(fresh.lanes[name].remaining >= rule.initialMin);
    assert.ok(fresh.lanes[name].remaining <= rule.initialMax);
    assert.ok(restored.lanes[name].remaining >= rule.intervalMax);
    assert.ok(restored.lanes[name].remaining < rule.intervalMax + 1);
  }
  assert.deepEqual(restored, createMobSpawnClock("seed:overworld", { restored: true }));
  assert.throws(() => createMobSpawnClock("seed:overworld", { restored: "yes" }), RangeError);
});

test("difficulty does not alter passive schedules, seeds, sites or species choices", () => {
  const recorded = [];
  for (const difficulty of ["peaceful", "easy", "normal", "hard", undefined]) {
    let clock = createMobSpawnClock("the-same-world:overworld");
    const passivePulses = [];
    for (let frame = 0; frame < 200; frame++) {
      const step = stepMobSpawnClock(clock, 0.2, { difficulty });
      clock = step.state;
      for (const pulse of step.pulses) {
        if (difficulty === "peaceful") assert.notEqual(pulse.pool, "hostile");
        if (pulse.pool === "passive") {
          const column = sampleMobSpawnColumn(pulse, { x: 0, y: 9, z: 0 }, 0);
          const choices = naturalMobSpawnCandidates("passive", site(), empty(), { difficulty });
          passivePulses.push({ frame, pulse, column,
            kind: chooseMobSpawnSpecies(choices, column.speciesRoll) });
        }
      }
    }
    assert.ok(passivePulses.length > 0);
    recorded.push({ clock, passivePulses });
  }
  for (const result of recorded.slice(1)) assert.deepEqual(result, recorded[0]);
});

test("blocked and Peaceful pulses are spent, not refunded when admission becomes possible", () => {
  const ready = dueClock();
  const quiet = stepMobSpawnClock(ready, 0.1, { difficulty: "peaceful" });
  const normal = stepMobSpawnClock(ready, 0.1, { difficulty: "normal" });
  assert.deepEqual(quiet.state, normal.state);
  assert.ok(normal.pulses.some((pulse) => pulse.pool === "hostile"));
  assert.deepEqual(stepMobSpawnClock(quiet.state, 0.1, { difficulty: "hard" }).pulses, []);
  for (const difficulty of [null, "invalid", false]) {
    assert.throws(() => stepMobSpawnClock(ready, 0, { difficulty }), RangeError);
    assert.throws(
      () => naturalMobSpawnCandidates("passive", site(), empty(), { difficulty }),
      RangeError
    );
  }
});

test("column work is bounded, deterministic, independent of a world or shared RNG", () => {
  const player = Object.freeze({ x: -17.5, y: 9, z: 100.5 });
  const pulse = Object.freeze({ pool: "passive", seed: 123, serial: 5 });
  const columns = [];
  for (let attempt = 0; attempt < MOB_SPAWN_LIMITS.candidatesPerPulse; attempt++) {
    const result = sampleMobSpawnColumn(pulse, player, attempt);
    assert.deepEqual(result, sampleMobSpawnColumn(pulse, player, attempt));
    assert.ok([result.x, result.z, result.cellX, result.cellZ].every(Number.isFinite));
    assert.ok(result.speciesRoll >= 0 && result.speciesRoll < 1);
    assert.ok(result.groupRoll >= 0 && result.groupRoll < 1);
    columns.push(`${result.cellX},${result.cellZ}`);
  }
  assert.ok(new Set(columns).size > 1);
  for (const attempt of [-1, 0.5, MOB_SPAWN_LIMITS.candidatesPerPulse, Infinity])
    assert.equal(sampleMobSpawnColumn(pulse, player, attempt), null);
});

test("natural distance is checked after jitter, altitude and every group offset", () => {
  const player = { x: 0, y: 9, z: 0 };
  assert.equal(mobSpawnDistanceAllowed({ x: 24, y: 9, z: 0 }, player), true);
  assert.equal(mobSpawnDistanceAllowed({ x: 23.99, y: 9, z: 0 }, player), false);
  assert.equal(mobSpawnDistanceAllowed({ x: 48.01, y: 9, z: 0 }, player), false);
  assert.equal(mobSpawnDistanceAllowed({ x: 30, y: 90, z: 0 }, player), false);
  assert.equal(mobSpawnDistanceAllowed({ x: NaN, y: 9, z: 0 }, player), false);
  const members = planMobSpawnGroup("horse", { x: 24, y: 9, z: 0 }, 0.9);
  assert.ok(members.some((member) => !mobSpawnDistanceAllowed({
    x: member.x, y: member.nearY, z: member.z,
  }, player)), "a safe group anchor cannot bypass a too-close member");
});

test("population counts retain owned/dormant slots and separate animals from NPCs", () => {
  const residents = Object.freeze([
    Object.freeze({ kind: "horse", tamed: true, saddled: true, dormant: true }),
    Object.freeze({ kind: "villager" }),
    Object.freeze({ kind: "guardian" }),
    Object.freeze({ kind: "dolphin" }),
    Object.freeze({ kind: "turtle" }),
    Object.freeze({ kind: "enderman" }),
    Object.freeze({ kind: "sheep", dead: true }),
  ]);
  const population = countMobSpawnPopulation(residents);
  assert.equal(population.total, 6);
  assert.deepEqual(population.pools, { passive: 2, aquatic: 1, hostile: 2 });
  assert.equal(population.species.horse, 1);
  assert.equal(mobPopulationPool("villager"), null);
  assert.equal(mobPopulationPool("enderman"), "hostile");
  assert.throws(() => { population.pools.passive = 0; }, TypeError);
  assert.throws(() => countMobSpawnPopulation(new Array(MAX_MOBS + 1).fill({ kind: "sheep" })), RangeError);
  assert.throws(() => countMobSpawnPopulation([{ kind: "unknown" }]), RangeError);
});

test("total, pool, species and frame caps independently limit groups without culling", () => {
  const land = countMobSpawnPopulation(new Array(12).fill({ kind: "sheep", tamed: true }));
  assert.equal(remainingMobSpawnCapacity("horse", land), 0);
  assert.ok(remainingMobSpawnCapacity("cod", land) > 0);
  const hostiles = countMobSpawnPopulation(new Array(10).fill({ kind: "zombie" }));
  assert.equal(remainingMobSpawnCapacity("creeper", hostiles), 0);
  assert.ok(remainingMobSpawnCapacity("horse", hostiles) > 0);
  const herd = countMobSpawnPopulation(new Array(3).fill({ kind: "horse", saddled: true }));
  assert.equal(remainingMobSpawnCapacity("horse", herd), 0);
  const full = countMobSpawnPopulation(new Array(MAX_MOBS).fill({ kind: "villager" }));
  assert.equal(remainingMobSpawnCapacity("sheep", full), 0);
  assert.equal(remainingMobSpawnCapacity("sheep", empty(), { maxEntities: 1 }), 1);
  assert.equal(remainingMobSpawnCapacity("sheep", empty(), { frameRemaining: 0 }), 0);
  assert.equal(remainingMobSpawnCapacity("zombie", empty(), { difficulty: "peaceful" }), 0);
  for (const difficulty of ["easy", "normal", "hard"])
    assert.ok(remainingMobSpawnCapacity("zombie", empty(), { difficulty }) > 0);
  assert.equal(land.total, 12, "over-cap existing species remain retained");
});

test("daytime land animals require real habitat support and adequate local light", () => {
  const ordinary = kinds("passive", site());
  assert.ok(ordinary.includes("horse") && ordinary.includes("sheep"));
  assert.deepEqual(kinds("passive", site({ groundId: BLOCK.STONE })), []);
  assert.deepEqual(kinds("passive", site({ skyLight: 0 })), []);
  assert.deepEqual(kinds("passive", site({ skyLight: undefined })), []);
  assert.deepEqual(kinds("passive", site({ loaded: false })), []);
  assert.deepEqual(kinds("passive", site({ timeOfDay: 0, skyLight: 0 })), []);
  const desert = kinds("passive", site({ biomeId: "desert", groundId: BLOCK.SAND }));
  assert.ok(desert.includes("camel") && desert.includes("rabbit"));
  assert.equal(desert.includes("cow"), false);
  assert.ok(kinds("passive", site({
    biomeId: "mushroom_fields", groundId: BLOCK.MYCELIUM,
  })).includes("mooshroom"));
});

test("nocturnal and cave specialists do not inherit daytime pasture rules", () => {
  assert.ok(kinds("passive", site({
    biomeId: "taiga", timeOfDay: 0, skyLight: 0,
  })).includes("fox"));
  assert.equal(kinds("passive", site({ biomeId: "taiga" })).includes("fox"), false);
  const cave = site({
    biomeId: "sulfur_caves", underground: true, skyLight: 0,
    groundId: BLOCK.SULFUR,
  });
  assert.deepEqual(kinds("passive", cave), ["sulfur_cube"]);
  assert.deepEqual(kinds("passive", { ...cave, underground: false }), []);
});

test("hostile biome/night/cave/light rules preserve End dimensions and reject lit danger", () => {
  const dark = site({ timeOfDay: 0, skyLight: 0 });
  assert.ok(kinds("hostile", dark).includes("zombie"));
  assert.ok(kinds("hostile", dark).includes("enderman"));
  assert.deepEqual(kinds("hostile", { ...dark, blockLight: 1 }), []);
  assert.deepEqual(kinds("hostile", { ...dark, blockLight: undefined }), []);
  assert.deepEqual(kinds("hostile", site()), []);
  assert.ok(kinds("hostile", site({
    underground: true, skyLight: 0, groundId: BLOCK.STONE,
  })).includes("zombie"));
  assert.deepEqual(kinds("hostile", dark, empty(), { difficulty: "peaceful" }), []);
  assert.ok(kinds("hostile", site({
    dimension: "nether", biomeId: "warped_forest", groundId: BLOCK.STONE,
  })).includes("enderman"));
  assert.ok(kinds("hostile", site({
    dimension: "end", biomeId: "the_end", groundId: BLOCK.STONE,
  })).includes("enderman"));
  assert.equal(kinds("hostile", site({
    dimension: "nether", biomeId: "nether_wastes", groundId: BLOCK.STONE,
  })).includes("enderman"), false);
});

test("aquatic depth is explicit and native encounters remain owned by ecology", () => {
  const water = site({
    biomeId: "river", water: true, waterDepth: 3, skyLight: 0, timeOfDay: 0,
  });
  assert.ok(kinds("aquatic", water).includes("cod"));
  assert.equal(kinds("aquatic", water).includes("squid"), false);
  assert.ok(kinds("aquatic", { ...water, waterDepth: 4 }).includes("squid"));
  assert.deepEqual(kinds("aquatic", { ...water, waterDepth: undefined }), []);
  const native = site({ biomeId: "deep_ocean", water: true, waterDepth: 8 });
  for (const name of ["passive", "aquatic", "hostile"]) {
    const choices = kinds(name, native);
    for (const kind of ["dolphin", "turtle", "guardian", "elder_guardian", "drowned", "villager", "blaze"])
      assert.equal(choices.includes(kind), false);
  }
});

test("weighted selection uses cumulative weights and fails invalid explicit rolls", () => {
  const choices = Object.freeze([
    Object.freeze({ kind: "horse", weight: 1 }),
    Object.freeze({ kind: "sheep", weight: 3 }),
  ]);
  assert.equal(chooseMobSpawnSpecies(choices, 0), "horse");
  assert.equal(chooseMobSpawnSpecies(choices, 0.249), "horse");
  assert.equal(chooseMobSpawnSpecies(choices, 0.25), "sheep");
  assert.equal(chooseMobSpawnSpecies(choices, 0.999), "sheep");
  assert.equal(chooseMobSpawnSpecies([], 0), null);
  for (const roll of [-1, 1, NaN, Infinity, "0.5"])
    assert.throws(() => chooseMobSpawnSpecies(choices, roll), RangeError);
  assert.throws(() => chooseMobSpawnSpecies([{ kind: "horse", weight: -1 }], 0), RangeError);
});

test("groups are bounded stable slots with separated columns, never fabricated safe y values", () => {
  const anchor = Object.freeze({ x: -30, y: -8.5, z: 0 });
  const group = planMobSpawnGroup("horse", anchor, 0.9);
  assert.deepEqual(group, planMobSpawnGroup("horse", anchor, 0.9));
  assert.ok(group.length > 1 && group.length <= MOB_SPAWN_LIMITS.maxGroup);
  for (let index = 0; index < group.length; index++) {
    assert.equal(group[index].slot, index);
    assert.equal(group[index].nearY, anchor.y);
    assert.equal(Object.hasOwn(group[index], "y"), false);
    for (const previous of group.slice(0, index))
      assert.ok(Math.hypot(group[index].x - previous.x, group[index].z - previous.z) > 2);
  }
  assert.equal(planMobSpawnGroup("creeper", anchor, 0.9).length, 1);
  assert.deepEqual(planMobSpawnGroup("elder_guardian", anchor, 0.9), []);
});

test("a deterministic refill simulation respects one shared per-frame budget and every pool", (t) => {
  const residents = [];
  let frameRemaining = MOB_SPAWN_LIMITS.admissionsPerFrame;
  const attempts = ["horse", "horse", "horse", "cow", "cod", "zombie", "guardian"];
  for (const kind of attempts) {
    if (remainingMobSpawnCapacity(kind, countMobSpawnPopulation(residents), { frameRemaining }) > 0) {
      residents.push({ kind });
      frameRemaining--;
    }
  }
  assert.ok(residents.length <= MOB_SPAWN_LIMITS.admissionsPerFrame);
  assert.equal(frameRemaining, 0);
  t.diagnostic(`shared-frame admissions=${residents.length}; owned residents are never evicted`);
});
