import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID as F } from "../src/block-state.js";
import { normalizeFluidServicesSnapshot } from "../src/game-fluid-services.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  fluidChannel,
  fluidServicesFixture,
  serviceSteps,
} from "./game-fluid-services-fixture.js";

const emptyDimension = (dimension = "overworld") => ({
  dimension,
  clock: 0,
  accumulator: 0,
  generation: 0,
  queue: [],
  sections: [],
  scans: [],
  regions: [],
});
const snapshot = (context) => ({
  fluids: {
    version: 1,
    seed: context.seed,
    generatorVersion: context.generatorVersion,
    dimensions: [emptyDimension()],
  },
});

test("fluid sidecar migration is pure, detached and rejects explicit malformed state in every dimension", () => {
  const context = createWorldContext({
    seed: "authored-sidecar",
    generatorVersion: 4,
  });
  for (const old of [null, undefined, {}, { version: 1, time: 0.36 }])
    assert.deepEqual(normalizeFluidServicesSnapshot(old, context), {
      fluids: {
        version: 1,
        seed: context.seed,
        generatorVersion: 4,
        dimensions: [],
      },
    });
  const saved = snapshot(context);
  saved.fluids.dimensions[0].queue.push([8, -63, 8, 1, false, null, null]);
  saved.fluids.dimensions.push(emptyDimension("nether"), emptyDimension("end"));
  const clean = normalizeFluidServicesSnapshot(saved, context);
  assert.deepEqual(clean, saved);
  clean.fluids.dimensions[0].queue[0][1] = 300;
  assert.equal(saved.fluids.dimensions[0].queue[0][1], -63);
  for (const bad of [
    [],
    { fluids: null },
    { fluids: undefined },
    { fluids: { ...saved.fluids, version: 2 } },
    { fluids: { ...saved.fluids, seed: "different" } },
    { fluids: { ...saved.fluids, generatorVersion: 3 } },
  ])
    assert.equal(normalizeFluidServicesSnapshot(bad, context), null);
  const inactive = structuredClone(saved);
  inactive.fluids.dimensions[2].queue = [[1, -1, 1, 1, false, null, null]];
  assert.equal(normalizeFluidServicesSnapshot(inactive, context), null);
  assert.equal(
    normalizeFluidServicesSnapshot(saved, {
      ...context,
      specForDimension: (dimension) => ({
        ...context.specForDimension(dimension),
        ...(dimension === "nether" ? { maxY: 999 } : {}),
      }),
    }),
    null
  );
});

test("staging/load acquire only their reservation and never subscribe, tick or replace live owners", (t) => {
  const f = fluidServicesFixture(t, { stage: false });
  const before = f.snapshot(),
    bytes = f.coordinator.budget.totalBytes;
  const mutation = f.world.onMutation,
    admitted = f.world.onChunkAdmitted;
  const service = f.create();
  assert.equal(service.context, f.context);
  assert.equal(service.coordinator, f.coordinator);
  assert.equal(service.active, false);
  assert.equal(f.game.fluidServices, undefined);
  assert.equal(f.world.onMutation, mutation);
  assert.equal(f.world.onChunkAdmitted, admitted);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(service.diagnostics().fluid.scanJobs, 0);
  assert.equal(service.frame(1, { simulating: true }).ok, false);
  const pending = snapshot(f.context);
  pending.fluids.dimensions[0].queue = [[8, 1, 8, 1, false, null, null]];
  assert.equal(service.load(pending), true);
  assert.deepEqual(service.serialize(), pending);
  const owned = service.serialize();
  assert.equal(service.load({ fluids: null }), false);
  assert.deepEqual(service.serialize(), owned);
  assert.equal(service.onChunkLoaded(f.world, f.admission()), true);
  assert.equal(
    service.load(pending),
    false,
    "restore must precede initial admissions"
  );
  assert.equal(service.activate(f.game).ok, true);
  assert.equal(
    service.load(pending),
    false,
    "live sidecars are never replaced in place"
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(service.dispose(), true);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(f.world._disposed, false);
  assert.equal(f.overflow._disposed, false);
  assert.equal(f.settlement._disposed, false);
});

test("invalid construction and capacity failures leave no partially registered service", (t) => {
  const f = fluidServicesFixture(t, { stage: false });
  const bytes = f.coordinator.budget.totalBytes,
    before = f.snapshot();
  for (const options of [
    { saved: { fluids: null } },
    { allowOverBudget: "true" },
    { limits: { maxQueued: 0 } },
    { context: createWorldContext({ seed: "wrong", generatorVersion: 4 }) },
    { overflow: {} },
    { coordinator: {} },
  ]) {
    assert.throws(() => f.create(options));
    assert.equal(f.coordinator.budget.totalBytes, bytes);
    assert.deepEqual(f.snapshot(), before);
  }
  const filler = {};
  f.coordinator.register(filler, MAX_RESERVED_BYTES - bytes);
  const full = f.coordinator.budget.totalBytes;
  assert.throws(() => f.create(), /capacity/);
  assert.equal(f.coordinator.budget.totalBytes, full);
  const restored = f.create({ allowOverBudget: true });
  assert.ok(f.coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
  assert.equal(restored.activate(f.game).ok, true);
  assert.equal(restored.dispose(), true);
  assert.equal(f.coordinator.budget.totalBytes, full);
  f.coordinator.release(filler);
});

test("activation is explicit/idempotent and rejects a stale stage or occupied host before any alias changes", (t) => {
  const f = fluidServicesFixture(t, { activate: false });
  const other = fluidServicesFixture(t);
  assert.equal(f.service.activate(other.game).ok, false);
  assert.equal(f.service.activate(f.game).ok, true);
  assert.equal(f.service.activate(f.game).ok, true);
  assert.equal(f.game.fluids, f.service.fluids);
  assert.equal(f.service.active, true);
  const replacement = f.create();
  assert.equal(replacement.activate(f.game).ok, false);
  assert.equal(f.game.fluidServices, f.service);
  const stale = fluidServicesFixture(t, { activate: false });
  stale.world.setDimension("nether");
  assert.equal(stale.service.activate(stale.game).ok, false);
  assert.throws(() => stale.service.serialize(), /stale/);
  const blocked = fluidServicesFixture(t, { activate: false });
  Object.defineProperty(blocked.game, "fluids", {
    value: null,
    configurable: false,
  });
  assert.equal(blocked.service.activate(blocked.game).ok, false);
  assert.equal(blocked.game.fluidServices, undefined);
});

test("admissions consume the actual frozen World envelope and reject every stale identity without losing queued work", (t) => {
  const f = fluidServicesFixture(t);
  let actual;
  f.world.onChunkAdmitted = (event) => {
    actual = event;
    assert.equal(f.service.onChunkLoaded(f.world, event), true);
  };
  const chunk = f.world._generateSync(1, 0);
  assert.ok(Object.isFrozen(actual));
  assert.equal(actual.chunk, chunk);
  const before = f.service.serialize();
  const other = fluidServicesFixture(t);
  for (const event of [
    { ...actual },
    Object.freeze({ ...actual, world: other.world }),
    Object.freeze({ ...actual, seed: "wrong" }),
    Object.freeze({ ...actual, generatorVersion: 3 }),
    Object.freeze({ ...actual, epoch: actual.epoch + 1 }),
    Object.freeze({ ...actual, dimension: "nether" }),
    Object.freeze({ ...actual, key: "0,0" }),
    Object.freeze({ ...actual, chunk: { ...chunk } }),
    Object.freeze({ ...actual, incarnation: chunk.incarnation + 1 }),
    Object.freeze({ ...actual, revision: chunk.revision + 1 }),
  ]) {
    assert.equal(f.service.onChunkLoaded(f.world, event), false);
    assert.deepEqual(f.service.serialize(), before);
  }
  assert.equal(f.service.onChunkLoaded(other.world, actual), false);
  assert.equal(f.service.onChunkLoaded(f.world, actual), true);
  assert.deepEqual(
    f.service.serialize(),
    before,
    "duplicate admissions coalesce"
  );
  const old = actual;
  f.world._removeChunk("1,0", chunk);
  f.world._generateSync(1, 0);
  assert.notEqual(actual.incarnation, old.incarnation);
  assert.equal(f.service.onChunkLoaded(f.world, old), false);
});

test("mutation hooks validate source/epoch, schedule only, and frame advances active time exactly once", (t) => {
  const f = fluidServicesFixture(t);
  const other = fluidServicesFixture(t);
  f.put(8, 1, 8, BLOCK.WATER);
  const pending = f.service.serialize();
  const event = {
    epoch: f.world.epoch,
    dimension: f.world.dimension,
    changes: [{ x: 8, y: 1, z: 8 }],
  };
  assert.equal(f.service.onMutation(other.world, event), false);
  assert.equal(f.service.onMutation(f.world, { ...event, epoch: -1 }), false);
  assert.deepEqual(f.service.serialize(), pending);
  for (const flag of ["paused", "building", "failed"]) {
    f.game[flag] = true;
    assert.equal(f.service.frame(1, { simulating: true }).advanced, false);
    f.game[flag] = false;
  }
  for (const dt of [0, 1])
    assert.equal(f.service.frame(dt, { simulating: false }).advanced, false);
  for (const dt of [-1, NaN, Infinity])
    assert.equal(f.service.frame(dt, { simulating: true }).ok, false);
  assert.deepEqual(f.service.serialize(), pending);
  const vitals = f.gameplay.serialize();
  f.gameplay.update = () =>
    assert.fail("host invokes Gameplay once, not the fluid service");
  f.gameplay.damage = () => assert.fail("fluid service does not own damage");
  f.service.frame(0.249, { simulating: true });
  assert.equal(f.world.getFluid(9, 1, 8), F.NONE);
  f.service.frame(0.001, { simulating: true });
  assert.equal(f.world.getFluid(9, 1, 8), F.WATER_1);
  assert.equal(f.world.getFluid(10, 1, 8), F.NONE);
  assert.deepEqual(f.gameplay.serialize(), vitals);
});

test("host replacement during a World prepare vetoes even a plant-free fluid tick", (t) => {
  const f = fluidServicesFixture(t),
    other = fluidServicesFixture(t);
  f.put(8, 1, 8, BLOCK.WATER);
  const before = f.snapshot(),
    replacement = other.snapshot();
  const prepare = f.world.prepareMutation.bind(f.world);
  f.world.prepareMutation = (...args) => {
    const participant = prepare(...args);
    f.game.world = other.world;
    return participant;
  };
  assert.equal(f.service.frame(0.25, { simulating: true }).ok, true);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(other.snapshot(), replacement);
  assert.equal(f.service.active, false);
  assert.ok(f.service.diagnostics().fluid.queued > 0);
  assert.equal(f.service.frame(1, { simulating: true }).ok, false);
  assert.throws(() => f.service.serialize(), /stale/);
});

test("post-publication replacement stops remaining catch-up ticks without rejecting the published water", (t) => {
  const f = fluidServicesFixture(t),
    other = fluidServicesFixture(t);
  f.put(8, 1, 8, BLOCK.WATER);
  f.world.onMutation = (event) => {
    f.service.onMutation(f.world, event);
    f.game.world = other.world;
  };
  const result = f.service.frame(1000, { simulating: true });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.ticks, 1);
  assert.equal(f.world.getFluid(9, 1, 8), F.WATER_1);
  assert.equal(f.world.getFluid(10, 1, 8), F.NONE);
  assert.equal(f.service.active, false);
});

test("lifecycle reentry from transaction validation cannot partially dispose, load or activate", (t) => {
  for (const action of ["dispose", "load", "activate"]) {
    const f = fluidServicesFixture(t, { activate: action === "dispose" });
    const before = f.service.serialize(),
      bytes = f.coordinator.budget.totalBytes;
    const inventory = f.gameplay.prepareInventory(() => true);
    let accepted;
    const result = f.coordinator.commit([
      {
        ...inventory,
        validate() {
          accepted =
            action === "activate"
              ? f.service.activate(f.game).ok
              : action === "load"
                ? f.service.load(before)
                : f.service.dispose();
          return inventory.validate();
        },
      },
    ]);
    assert.equal(accepted, false);
    assert.equal(result.ok, false);
    assert.deepEqual(f.service.serialize(), before);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
    assert.equal(f.service.fluids._disposed, false);
  }
});

test("saved frontier work restores before initial admissions and resumes only when the missing column is resident", (t) => {
  const a = fluidServicesFixture(t, { initial: fluidChannel(13, 20) });
  a.put(15, 1, 8, BLOCK.WATER);
  serviceSteps(a.service, 8);
  assert.ok(a.service.diagnostics().fluid.deferredSections > 0);
  const saved = a.service.serialize(),
    worldState = a.world.serialize();
  const b = fluidServicesFixture(t, {
    stage: false,
    initial: fluidChannel(13, 20),
  });
  assert.equal(b.world.loadEdits(worldState), true);
  b.service = b.create({ saved, limits: { maxScanCellsPerUpdate: 4096 } });
  assert.equal(b.service.activate(b.game).ok, true);
  assert.equal(b.service.onChunkLoaded(b.world, b.admission()), true);
  assert.equal(b.world.getCell(16, 1, 8), null);
  const generate = b.world.generator.generateChunk.bind(b.world.generator);
  b.world.generator.generateChunk = () =>
    assert.fail("fluid frame cannot generate a frontier");
  serviceSteps(b.service, 4);
  b.world.generator.generateChunk = generate;
  b.world._generateSync(1, 0);
  serviceSteps(b.service, 64);
  assert.equal(b.world.getFluid(16, 1, 8), F.WATER_1);
  assert.equal(b.world.getFluid(17, 1, 8), F.WATER_2);
  assert.equal(b.world.chunks.size, 2);
});

test("diagnostics retain scheduler/retention bounds through a saturated authored frame", (t) => {
  const f = fluidServicesFixture(t, {
    limits: {
      maxQueued: 1,
      maxDirtySections: 1,
      maxScanJobs: 1,
      maxRecoveryRegions: 1,
      maxUpdatesPerTick: 1,
      maxScanCellsPerUpdate: 32,
    },
  });
  f.service.onChunkLoaded(f.world, f.admission());
  f.put(8, 1, 8, BLOCK.WATER);
  const result = f.service.frame(1000, { simulating: true });
  const state = f.service.diagnostics();
  assert.equal(result.ok, true);
  assert.ok(state.fluid.queued <= 1);
  assert.ok(state.fluid.dirtySections <= 1);
  assert.ok(state.fluid.recoveryRegions <= 1);
  assert.ok(state.fluid.last.ticks <= 4);
  assert.ok(state.fluid.last.scanCells <= 32);
  assert.equal(state.retentionLimits.plants, 256);
  assert.equal(state.retentionLimits.drops, 512);
  assert.ok(state.fluid.reservedBytes > 0);
});
