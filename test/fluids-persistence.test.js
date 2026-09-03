import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID as F } from "../src/block-state.js";
import { fluidLimits, MAX_FLUID_PLAN_READS } from "../src/fluid-constants.js";
import { normalizeFluidSnapshot } from "../src/fluid-save.js";
import { FluidWork } from "../src/fluid-work.js";
import { FluidSystem } from "../src/fluids.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { fluidFixture, fluidSteps, waterLine } from "./fluid-fixture.js";

const corridor = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, 1, 8, BLOCK.AIR]);

test("unloaded work is deferred, persisted and resumed only after explicit column admission", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    radius: 0,
    base: BLOCK.STONE,
    initial: corridor(13, 20),
  });
  const generation = t.mock.method(world.generator, "generateChunk", () =>
    assert.fail("fluid queries must never generate terrain")
  );
  put(15, 1, 8, BLOCK.WATER);
  fluidSteps(fluids, 16);
  assert.equal(world.isLoaded(16, 8), false);
  assert.equal(world.getCell(16, 1, 8), null);
  assert.ok(fluids.diagnostics().deferredSections > 0);
  const snapshot = fluids.serialize();
  assert.equal(fluids.load(snapshot), true);
  assert.ok(fluids.diagnostics().deferredSections > 0);
  generation.mock.restore();
  const admitted = world._generateSync(1, 0);
  assert.equal(fluids.onChunkLoaded(admitted), true);
  fluidSteps(fluids, 128);
  assert.equal(world.getFluid(16, 1, 8), F.WATER_1);
  assert.equal(world.getFluid(17, 1, 8), F.WATER_2);
  assert.equal(world.chunks.size, 2);
});

test("incarnation replacement invalidates a prepared tick without losing its work", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(7, 9),
  });
  put(8, 1, 8, BLOCK.WATER);
  const prepare = world.prepareMutation.bind(world);
  let replace = true;
  const hook = t.mock.method(world, "prepareMutation", (changes, options) => {
    const plan = prepare(changes, options);
    if (replace && plan) {
      replace = false;
      const previous = world.chunks.get("0,0");
      world._removeChunk("0,0", previous);
      const next = world._generateSync(0, 0);
      assert.notEqual(next.incarnation, previous.incarnation);
      fluids.onChunkLoaded(next);
    }
    return plan;
  });
  fluidSteps(fluids, 1);
  assert.equal(world.getFluid(7, 1, 8), F.NONE);
  assert.equal(fluids.diagnostics().last.rejected, 1);
  assert.ok(fluids.diagnostics().queued > 0);
  hook.mock.restore();
  fluidSteps(fluids, 8);
  assert.equal(world.getFluid(7, 1, 8), F.WATER_1);
});

test("changed prerequisite support rejects the whole prepared tick and leaves a retry", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(7, 9),
  });
  put(8, 1, 8, BLOCK.WATER);
  const prepare = world.prepareMutation.bind(world);
  let changeSupport = true;
  const hook = t.mock.method(world, "prepareMutation", (changes, options) => {
    const plan = prepare(changes, options);
    if (plan && changeSupport) {
      changeSupport = false;
      assert.equal(world.set(9, 0, 8, BLOCK.AIR), true);
    }
    return plan;
  });
  fluidSteps(fluids, 1);
  assert.equal(world.getFluid(7, 1, 8), F.NONE);
  assert.equal(world.getFluid(9, 1, 8), F.NONE);
  assert.equal(fluids.diagnostics().last.rejected, 1);
  hook.mock.restore();
  fluidSteps(fluids, 8);
  assert.equal(world.getFluid(7, 1, 8), F.WATER_1);
});

test("full shared save capacity rejects new water atomically and queued work survives", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(7, 9),
  });
  put(8, 1, 8, BLOCK.WATER);
  const filler = {};
  assert.equal(
    world.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - world.coordinator.budget.totalBytes
    ),
    true
  );
  const before = world.serialize();
  fluidSteps(fluids, 1);
  assert.deepEqual(world.serialize(), before);
  assert.equal(fluids.diagnostics().last.rejected, 1);
  assert.ok(fluids.diagnostics().queued > 0);
  const pending = fluids.serialize();
  assert.equal(
    fluids.load(pending),
    true,
    "loading scheduler state does not consume new capacity"
  );
  world.coordinator.release(filler);
  fluidSteps(fluids, 8);
  assert.equal(world.getFluid(9, 1, 8), F.WATER_1);
});

test("queue coalescing and all overflow tiers stay bounded without dropping distant frontiers", () => {
  const work = new FluidWork(
    "overworld",
    4,
    fluidLimits({
      maxQueued: 1,
      maxDirtySections: 1,
      maxRecoveryRegions: 1,
    })
  );
  for (let i = 0; i < 100; i++) work.offer(8, 1, 8);
  assert.equal(work.queue.size, 1);
  work.offer(24, 1, 8);
  work.offer(40, 1, 8);
  work.offer(56, 1, 8);
  work.offer(WORLD_MIN, -64, WORLD_MIN);
  work.offer(WORLD_MAX - 1, 319, WORLD_MAX - 1);
  assert.equal(work.queue.size, 1);
  assert.equal(work.sections.size, 1);
  assert.equal(work.regions.length, 1);
  const [region] = work.regions;
  assert.equal(region.x0, WORLD_MIN / 16);
  assert.equal(region.x1, WORLD_MAX / 16 - 1);
  assert.equal(region.z0, WORLD_MIN / 16);
  assert.equal(region.z1, WORLD_MAX / 16 - 1);
});

test("one-cell queue overflow and reload still converge in an authored closed channel", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(7, 11),
    limits: {
      maxQueued: 1,
      maxDirtySections: 1,
      maxScanJobs: 1,
      maxRecoveryRegions: 1,
      maxUpdatesPerTick: 1,
      maxScanCellsPerUpdate: 4096,
    },
  });
  put(8, 1, 8, BLOCK.WATER);
  assert.ok(
    fluids.diagnostics().dirtySections + fluids.diagnostics().recoveryRegions >
      0
  );
  fluidSteps(fluids, 5);
  assert.equal(fluids.load(fluids.serialize()), true);
  fluidSteps(fluids, 512);
  assert.deepEqual(waterLine(world, 7, 11), [
    F.WATER_1,
    F.WATER_SOURCE,
    F.WATER_1,
    F.WATER_2,
    F.WATER_3,
  ]);
  assert.ok(fluids.diagnostics().queued <= 1);
  assert.ok(fluids.diagnostics().dirtySections <= 1);
  assert.ok(fluids.diagnostics().scanJobs <= 1);
  assert.ok(fluids.diagnostics().recoveryRegions <= 1);
  put(8, 1, 8, BLOCK.AIR);
  fluidSteps(fluids, 1024);
  assert.ok(waterLine(world, 7, 11).every((fluid) => fluid === F.NONE));
});

test("recovery visits resident columns, not the coordinates between distant dirty markers", (t) => {
  const { world, fluids } = fluidFixture(t, {
    base: BLOCK.STONE,
    limits: {
      maxQueued: 2,
      maxDirtySections: 1,
      maxScanJobs: 1,
      maxRecoveryRegions: 1,
      maxUpdatesPerTick: 2,
      maxScanCellsPerUpdate: 64,
      maxScanVisitsPerUpdate: 4,
      maxRecoveryVisitsPerUpdate: 2,
      maxTicksPerUpdate: 2,
    },
  });
  fluids.onMutation([
    { x: WORLD_MIN, y: -64, z: WORLD_MIN },
    { x: WORLD_MAX - 1, y: 319, z: WORLD_MAX - 1 },
    { x: 8, y: 1, z: 8 },
  ]);
  const get = world.getCell.bind(world);
  let reads = 0;
  t.mock.method(world, "getCell", (...position) => {
    reads++;
    return get(...position);
  });
  t.mock.method(world.generator, "generateChunk", () =>
    assert.fail("no recovery generation")
  );
  fluids.update(1000);
  const { last, limits } = fluids.diagnostics();
  assert.ok(
    last.evaluated <= limits.maxTicksPerUpdate * limits.maxUpdatesPerTick
  );
  assert.ok(last.scanCells <= limits.maxScanCellsPerUpdate);
  assert.ok(last.scanVisits <= limits.maxScanVisitsPerUpdate);
  assert.ok(last.recoveryVisits <= limits.maxRecoveryVisitsPerUpdate);
  assert.ok(last.queueVisits <= limits.maxTicksPerUpdate * limits.maxQueued);
  assert.ok(
    last.reads <= last.evaluated * MAX_FLUID_PLAN_READS + last.scanCells * 7
  );
  assert.ok(
    reads <=
      last.evaluated * MAX_FLUID_PLAN_READS * 3 +
        last.scanCells * 7 +
        last.changedCells
  );
  assert.ok(encodedBytes(fluids.serialize()) <= fluids.reservedBytes);
});

test("historical source oceans stay dormant on incremental admission until a local edit", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    generatorVersion: 3,
    radius: 0,
    initial: [[8, 1, 8, BLOCK.WATER]],
    limits: { maxScanCellsPerUpdate: 4096 },
  });
  const before = world.serialize();
  fluids.onChunkLoaded(world.chunks.get("0,0"));
  for (let i = 0; i < 8; i++) {
    fluids.update(0.25);
    assert.ok(fluids.diagnostics().last.scanCells <= 4096);
  }
  assert.deepEqual(world.serialize(), before);
  assert.equal(fluids.diagnostics().queued, 0);
  assert.equal(world.getFluid(7, 1, 8), F.NONE);
  put(9, 1, 8, BLOCK.STONE);
  fluidSteps(fluids, 4);
  assert.equal(world.getFluid(7, 1, 8), F.WATER_1);
});

test("v4 default source bytes and soul-sand columns are incrementally activated on admission", (t) => {
  const { world, fluids } = fluidFixture(t, {
    radius: 0,
    floor: -64,
    initial: [
      [8, -64, 8, BLOCK.SOUL_SAND],
      ...Array.from({ length: 5 }, (_, i) => [8, i - 63, 8, BLOCK.WATER]),
    ],
    limits: { maxScanCellsPerUpdate: 512 },
  });
  assert.equal(
    world.chunks.get("0,0").sections.size,
    0,
    "authored generator uses implicit source defaults"
  );
  const before = world.serialize();
  fluids.onChunkLoaded(world.chunks.get("0,0"));
  assert.deepEqual(
    world.serialize(),
    before,
    "admission does not synchronously sweep or mutate"
  );
  fluidSteps(fluids, 24);
  for (let y = -63; y <= -59; y++)
    assert.equal(world.getFluid(8, y, 8), F.BUBBLE_UP);
  assert.ok(fluids.diagnostics().last.scanCells <= 512);
});

test("snapshots detach all dimensions, reject malformed state atomically and allow smaller pools", (t) => {
  const { world, fluids } = fluidFixture(t);
  fluids.onMutation([
    { x: 8, y: -2, z: 8 },
    { x: 9, y: -2, z: 8 },
  ]);
  fluids.onMutation({ dimension: "nether", changes: [{ x: 8, y: 1, z: 8 }] });
  const before = fluids.serialize();
  const clean = normalizeFluidSnapshot(before, world);
  assert.deepEqual(clean, before);
  clean.dimensions[0].queue[0][0] = 999;
  assert.deepEqual(fluids.serialize(), before);
  const invalid = [
    { ...before, version: 2 },
    { ...before, seed: "other" },
    { ...before, generatorVersion: 3 },
    { ...before, dimensions: [before.dimensions[0], before.dimensions[0]] },
  ];
  for (const mutate of [
    (copy) => {
      copy.dimensions[0].queue[0][1] = 320;
    },
    (copy) => {
      copy.dimensions[1].queue[0][1] = -1;
    },
    (copy) => {
      copy.dimensions[0].queue.push([...copy.dimensions[0].queue[0]]);
    },
    (copy) => {
      copy.dimensions[0].queue[0][3] = NaN;
    },
    (copy) => {
      copy.dimensions[0].queue[0][5] = BLOCK.STONE;
    },
    (copy) => {
      copy.dimensions[0].accumulator = Infinity;
    },
    (copy) => {
      copy.dimensions[0].regions = [[0, WORLD_MAX, 0, 0, 1, "recover"]];
    },
  ]) {
    const copy = structuredClone(before);
    mutate(copy);
    invalid.push(copy);
  }
  for (const snapshot of invalid) {
    assert.equal(fluids.load(snapshot), false);
    assert.deepEqual(fluids.serialize(), before);
  }
  const small = new FluidSystem(world, {
    limits: { maxQueued: 1, maxDirtySections: 1, maxRecoveryRegions: 1 },
  });
  t.after(() => small.dispose());
  assert.equal(small.load(before), true);
  assert.ok(
    small.diagnostics().queued <= 2,
    "one exact cell per archived active dimension"
  );
  assert.ok(
    small.diagnostics().dirtySections + small.diagnostics().recoveryRegions > 0
  );
  assert.ok(encodedBytes(small.serialize()) <= small.reservedBytes);
});

test("dimension clocks freeze independently, stale events fail and dispose releases its reservation", (t) => {
  const { world, fluids } = fluidFixture(t);
  fluids.onMutation([{ x: 8, y: 1, z: 8 }]);
  fluids.update(0.1);
  const savedOverworld = fluids.serialize().dimensions[0];
  const epoch = world.epoch;
  world.setDimension("nether");
  assert.equal(
    fluids.onMutation({
      epoch,
      dimension: "overworld",
      changes: [{ x: 8, y: 1, z: 8 }],
    }),
    false
  );
  fluidSteps(fluids, 5);
  assert.deepEqual(
    fluids.serialize().dimensions.find((d) => d.dimension === "overworld"),
    savedOverworld
  );
  const bytes = world.coordinator.budget.totalBytes;
  fluids.dispose();
  assert.equal(
    world.coordinator.budget.totalBytes,
    bytes - fluids.reservedBytes
  );
  assert.equal(fluids.update(1), false);
  assert.equal(fluids.onMutation([{ x: 0, y: 1, z: 0 }]), false);
});

test("world cell edits and pending recession round-trip together into a fresh authored World", (t) => {
  const options = { base: BLOCK.STONE, initial: corridor(0, 24) };
  const a = fluidFixture(t, options);
  a.put(8, 1, 8, BLOCK.WATER);
  fluidSteps(a.fluids, 4);
  a.put(8, 1, 8, BLOCK.AIR);
  fluidSteps(a.fluids, 3);
  const savedWorld = a.world.serialize(),
    savedFluids = a.fluids.serialize();
  const b = fluidFixture(t, options);
  assert.equal(b.world.loadEdits(savedWorld), true);
  assert.equal(b.fluids.load(savedFluids), true);
  assert.deepEqual(waterLine(b.world, 0, 24), waterLine(a.world, 0, 24));
  for (const chunk of b.world.chunks.values()) b.fluids.onChunkLoaded(chunk);
  fluidSteps(a.fluids, 64);
  fluidSteps(b.fluids, 64);
  assert.deepEqual(waterLine(b.world, 0, 24), waterLine(a.world, 0, 24));
  assert.ok(waterLine(b.world, 0, 24).every((fluid) => fluid === F.NONE));
  assert.deepEqual(
    b.world.serialize().edits,
    [],
    "full-cell reversion still prunes fluid edits"
  );
});

test("own successful commits keep propagating even when a World observer throws", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    connect: false,
    base: BLOCK.STONE,
    initial: corridor(7, 12),
  });
  world.onMutation = () => {
    throw new Error("authored observer failure");
  };
  put(8, 1, 8, BLOCK.WATER);
  fluids.onMutation([{ x: 8, y: 1, z: 8 }]);
  fluidSteps(fluids, 5);
  assert.equal(world.getFluid(11, 1, 8), F.WATER_3);
  assert.ok(fluids.diagnostics().total.observerErrors > 0);
});

test("loading a waiting frontier already resident clears the wait without requiring another admission", (t) => {
  const { world, fluids } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(7, 9),
  });
  const saved = {
    version: 1,
    seed: world.seed,
    generatorVersion: world.generatorVersion,
    dimensions: [
      {
        dimension: "overworld",
        clock: 0,
        accumulator: 0,
        generation: 0,
        queue: [],
        scans: [],
        regions: [],
        sections: [[0, 0, 0, 0, false, [[1, 0]]]],
      },
    ],
  };
  assert.equal(fluids.load(saved), true);
  assert.equal(fluids.diagnostics().deferredSections, 0);
  assert.equal(fluids.diagnostics().dirtySections, 1);
});

test("validated over-budget import adoption reserves the pool but cannot bypass later fluid capacity", (t) => {
  const { world, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(7, 9),
  });
  put(8, 1, 8, BLOCK.WATER);
  const filler = {};
  assert.equal(
    world.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - world.coordinator.budget.totalBytes
    ),
    true
  );
  const bytes = world.coordinator.budget.totalBytes;
  assert.throws(() => new FluidSystem(world), /capacity/);
  assert.equal(world.coordinator.budget.totalBytes, bytes);
  const imported = new FluidSystem(world, { allowOverBudget: true });
  t.after(() => imported.dispose());
  imported.onMutation([{ x: 8, y: 1, z: 8 }]);
  fluidSteps(imported, 1);
  assert.equal(imported.diagnostics().last.rejected, 1);
  assert.equal(world.getFluid(7, 1, 8), F.NONE);
  world.coordinator.release(filler);
  fluidSteps(imported, 4);
  assert.equal(world.getFluid(7, 1, 8), F.WATER_1);
});

test("a synchronous post-publication autosave includes conservative replay for the next wave", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    connect: false,
    generatorVersion: 3,
    base: BLOCK.STONE,
    initial: corridor(7, 12),
  });
  let saved = null;
  world.onMutation = (event) => {
    if (event.changes.some(({ after }) => after.fluid === F.WATER_1))
      saved = { world: world.serialize(), fluids: fluids.serialize() };
  };
  put(8, 1, 8, BLOCK.WATER);
  fluids.onMutation([{ x: 8, y: 1, z: 8 }]);
  fluidSteps(fluids, 1);
  assert.ok(saved);
  const active = saved.fluids.dimensions[0];
  assert.ok(
    active.queue.length + active.sections.length + active.regions.length > 0
  );
  assert.ok(normalizeFluidSnapshot(saved.fluids, world));
  assert.ok(encodedBytes(saved.fluids) <= fluids.reservedBytes);
});
