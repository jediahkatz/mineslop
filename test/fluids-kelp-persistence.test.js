import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  fluidLimits, fluidReservedBytes, KELP_GROW_TICKS, MAX_FLUID_CLOCK,
} from "../src/fluid-constants.js";
import { normalizeFluidSnapshot } from "../src/fluid-save.js";
import { FluidWork } from "../src/fluid-work.js";
import { FluidSystem } from "../src/fluids.js";
import { encodedBytes } from "../src/save-budget.js";
import { WORLD_MIN, WORLD_MAX } from "../src/terrain.js";
import { fluidFixture, fluidSteps } from "./fluid-fixture.js";
import { activateKelp, fluidTo, kelpColumn, kelpTimer } from "./fluid-kelp-fixture.js";

test("old seven-tuple queues migrate byte-for-byte with all due times, coral deadlines and flags intact", (t) => {
  const { world, fluids } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
  const old = {
    version: 1, seed: world.seed, generatorVersion: world.generatorVersion,
    dimensions: [
      {
        dimension: "overworld", clock: 121, accumulator: 0.125, generation: 1,
        queue: [
          [8, 1, 8, 700, true, null, null],
          [-17, -30, 16, 122, false, BLOCK.FIRE_CORAL_BLOCK, 138],
          [15, 319, 15, 1, true, null, null],
        ],
        sections: [[1, 0, 1, 0, true, [[2, 0]]]],
        scans: [[0, 0, 0, false, "recover", 1]],
        regions: [[0, 1, 0, 1, 1, "recover"]],
      },
      {
        dimension: "nether", clock: 17, accumulator: 0.2, generation: 0,
        queue: [[1, 1, 1, 37, false, BLOCK.TUBE_CORAL_BLOCK, 39]],
        sections: [], scans: [], regions: [],
      },
    ],
  };
  assert.deepEqual(normalizeFluidSnapshot(old, world), old);
  assert.equal(fluids.load(old), true);
  assert.deepEqual(fluids.serialize(), old);
  assert.equal(fluids.diagnostics().kelpTimers, 0, "absence does not fabricate old age or elapsed growth");
  const detached = normalizeFluidSnapshot(old, world);
  detached.dimensions[0].queue[0][3] = 0;
  assert.deepEqual(fluids.serialize(), old);
});

test("absent marine state initializes a full interval when an old queued kelp is actually evaluated", (t) => {
  const { world, fluids } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
  activateKelp(fluids);
  const old = fluids.serialize();
  delete old.dimensions[0].marine;
  old.dimensions[0].queue = [[8, 1, 8, 1, false, null, null]];
  old.dimensions[0].clock = 9999;
  assert.equal(fluids.load(old), true);
  fluids.update(0.25);
  assert.equal(world.get(8, 2, 8), BLOCK.WATER);
  assert.equal(kelpTimer(fluids)[4], 10000 + KELP_GROW_TICKS);
});

test("present malformed marine snapshots reject atomically, including corrupt inactive dimensions", (t) => {
  const { world, fluids } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
  activateKelp(fluids);
  const before = fluids.serialize();
  const invalid = [
    null, undefined, [], {}, { version: 2, kelp: [] },
    { version: 1, kelp: null },
    { version: 1, kelp: [], unknownTimers: [] },
    ...[
      (entries) => { entries[0][3] = 26; },
      (entries) => { entries[0][3] = -1; },
      (entries) => { entries[0][3] = 0.5; },
      (entries) => { entries[0][4] = Infinity; },
      (entries) => { entries[0][4] = MAX_FLUID_CLOCK + KELP_GROW_TICKS + 1; },
      (entries) => { entries[0][4] = null; },
      (entries) => { entries[0][0] = 200; },
      (entries) => { entries[0][1] = 320; },
      (entries) => { entries[0].push(0); },
      (entries) => { entries.push([...entries[0]]); },
    ].map((mutate) => {
      const marine = structuredClone(before.dimensions[0].marine);
      mutate(marine.kelp);
      return marine;
    }),
  ];
  for (const marine of invalid) {
    const saved = structuredClone(before);
    saved.dimensions[0].marine = marine;
    assert.equal(normalizeFluidSnapshot(saved, world), null);
    assert.equal(fluids.load(saved), false);
    assert.deepEqual(fluids.serialize(), before);
  }
  const mixed = structuredClone(before);
  const q = mixed.dimensions[0].queue.find(([x, y, z]) => x === 8 && y === 1 && z === 8);
  q[5] = BLOCK.FIRE_CORAL_BLOCK;
  q[6] = 12;
  assert.equal(fluids.load(mixed), false, "one timer cannot claim to be both coral and kelp");
  const inactive = structuredClone(before);
  inactive.dimensions.push({
    dimension: "end", clock: 1, accumulator: 0, generation: 0,
    queue: [], sections: [], scans: [], regions: [],
    marine: { version: 1, kelp: [[8, -1, 8, 2, 1951]] },
  });
  assert.equal(fluids.load(inactive), false);
  assert.deepEqual(fluids.serialize(), before);
});

test("cold World reconstruction retains the exact partial cooldown and age, not a full restart or instant extension", (t) => {
  const options = { base: BLOCK.STONE, initial: kelpColumn() };
  const a = fluidFixture(t, options);
  const timer = activateKelp(a.fluids);
  fluidTo(a.fluids, 1500);
  a.fluids.update(0.125);
  const world = a.world.serialize(), saved = a.fluids.serialize();
  const b = fluidFixture(t, options);
  assert.equal(b.world.loadEdits(world), true);
  assert.equal(b.fluids.load(saved), true);
  assert.deepEqual(b.fluids.serialize(), saved);
  const cloned = normalizeFluidSnapshot(saved, a.world);
  cloned.dimensions[0].marine.kelp[0][3] = 25;
  assert.deepEqual(a.fluids.serialize(), saved);
  for (const f of [a, b]) {
    fluidTo(f.fluids, timer[4] - 1);
    assert.equal(f.world.get(8, 2, 8), BLOCK.WATER);
    f.fluids.update(0.125);
    assert.equal(f.world.get(8, 2, 8), BLOCK.KELP);
  }
  assert.deepEqual(a.world.serialize(), b.world.serialize());
  assert.deepEqual(a.fluids.serialize(), b.fluids.serialize());
});

test("inactive dimensions freeze both timer and accumulator independently", (t) => {
  const { world, fluids } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
  activateKelp(fluids);
  fluids.update(0.125);
  const before = fluids.serialize().dimensions[0];
  world.setDimension("nether");
  fluidSteps(fluids, 1024, 1);
  assert.deepEqual(fluids.serialize().dimensions[0], before);
  world.setDimension("overworld");
  world._generateSync(0, 0);
  fluids.update(0.125);
  assert.equal(fluids.diagnostics().clock, before.clock + 1);
  assert.equal(world.get(8, 2, 8), BLOCK.WATER);
});

test("runtime shrink refuses to discard marine deadlines; a compatible smaller pool preserves the exact timer", (t) => {
  const { world, fluids } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
  const timer = activateKelp(fluids);
  const saved = fluids.serialize();
  const tooSmall = new FluidSystem(world, { limits: { maxQueued: 1 } });
  const small = new FluidSystem(world, { limits: { maxQueued: 4 } });
  t.after(() => { small.dispose(); tooSmall.dispose(); });
  const before = tooSmall.serialize();
  assert.equal(tooSmall.load(saved), false);
  assert.deepEqual(tooSmall.serialize(), before);
  assert.equal(small.load(saved), true);
  assert.deepEqual(kelpTimer(small), timer);
  assert.ok(small.diagnostics().queued <= 4);
  assert.ok(encodedBytes(small.serialize()) <= small.reservedBytes);
});

test("the existing fixed reservation covers maximal queues plus all marine projections at extreme coordinates/clocks", () => {
  const limits = fluidLimits();
  const dimensions = ["overworld", "nether", "end"].map((dimension) => {
    const work = new FluidWork(dimension, 4, limits);
    work.clock = MAX_FLUID_CLOCK;
    for (let i = 0; i < limits.maxQueued; i++) {
      const entry = { x: WORLD_MIN + i, y: work.spec.maxY - 1, z: WORLD_MAX - 1 };
      const due = MAX_FLUID_CLOCK + KELP_GROW_TICKS;
      assert.equal(work.offer(entry.x, entry.y, entry.z, { due }), true);
      if (i < work.maxKelp)
        assert.equal(work.keepKelp(entry, { age: 25, due }), true);
    }
    assert.equal(work.queue.size, 4096);
    assert.equal(work.kelpCount, 1024);
    return work.serialize();
  });
  const saved = { version: 1, seed: "k".repeat(80), generatorVersion: 4, dimensions };
  assert.deepEqual(normalizeFluidSnapshot(saved, saved), saved);
  assert.ok(encodedBytes(saved) <= fluidReservedBytes(limits));
});
