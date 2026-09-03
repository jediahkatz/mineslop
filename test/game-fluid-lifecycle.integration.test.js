import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID as F } from "../src/block-state.js";
import { sampleFluidAtPoint } from "../src/fluid-sampling.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { bindWorldServiceEvents } from "../src/game-world-events.js";
import {
  normalizeWorldComponents,
  preflightWorldComponents,
} from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import {
  authoredPrepareWorld,
  disposeFluidStage,
  fluidLifecycleHost,
  LIFECYCLE_POSE,
  LIFECYCLE_SEED,
  traceFluidFrame,
} from "./game-fluid-lifecycle-fixture.js";

// Node-only authored cells. These exercise actual ownership and host plumbing,
// not WebGL, natural terrain, crop acquisition, or an invented crop-batch API.
const slots = ["buildingServices", "fluidServices"];
const methods = ["onMutation", "onChunkLoaded"];
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const dimensionWork = (service, dimension = "overworld") =>
  service
    .serialize()
    .fluids.dimensions.find((entry) => entry.dimension === dimension);
const emptyWork = (dimension = "overworld") => ({
  dimension,
  clock: 0,
  accumulator: 0,
  generation: 0,
  queue: [],
  sections: [],
  scans: [],
  regions: [],
});
const waterColumn = (fluid = F.WATER_SOURCE) =>
  [1, 2, 3, 4].map((y) => [8, y, 8, { id: BLOCK.WATER, fluid }]);

function observeServices(t, host) {
  const observations = {};
  for (const slot of slots) {
    const service = host.game[slot];
    observations[slot] = {};
    for (const method of methods) {
      const calls = (observations[slot][method] = []);
      const original = service[method];
      t.mock.method(service, method, function (world, event) {
        const result = original.call(this, world, event);
        calls.push({ world, event, result });
        return result;
      });
    }
  }
  return observations;
}

function assertAdmission(world, event) {
  assert.equal(Object.isFrozen(event), true);
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      "world",
      "seed",
      "dimension",
      "generatorVersion",
      "epoch",
      "key",
      "cx",
      "cz",
      "incarnation",
      "revision",
      "chunk",
    ].sort()
  );
  assert.equal(event.world, world);
  assert.equal(event.seed, world.seed);
  assert.equal(event.generatorVersion, world.generatorVersion);
  assert.equal(event.dimension, world.dimension);
  assert.equal(event.epoch, world.epoch);
  assert.equal(event.key, `${event.cx},${event.cz}`);
  assert.equal(event.chunk, world.chunks.get(event.key));
  assert.equal(event.incarnation, event.chunk.incarnation);
  assert.equal(event.revision, event.chunk.revision);
}

test("real Game binding replays frozen current residents to both services and delivers each later publication once", (t) => {
  const f = fluidLifecycleHost(t, {
    bind: false,
    columns: [
      [0, 0],
      [1, 0],
    ],
  });
  const seen = observeServices(t, f);
  const before = f.world.serialize();
  f.bind();
  assert.equal(typeof f.game.unbindWorldEvents, "function");
  for (const slot of slots) {
    assert.equal(seen[slot].onChunkLoaded.length, 2);
    for (const { world, event, result } of seen[slot].onChunkLoaded) {
      assert.equal(world, f.world);
      assertAdmission(world, event);
      assert.equal(result, true, `${slot} accepts the real envelope`);
    }
  }
  assert.equal(
    seen.buildingServices.onChunkLoaded[0].event,
    seen.fluidServices.onChunkLoaded[0].event,
    "consumers receive the same immutable admission identity"
  );
  assert.equal(f.fluid.diagnostics().notificationsStarted, true);
  assert.equal(f.fluid.diagnostics().fluid.scanJobs, 2);
  assert.ok(f.building.supportStatus().queuedColumns > 0);
  assert.deepEqual(
    f.world.serialize(),
    before,
    "replay schedules, never edits"
  );
  assert.equal(f.calls.saves, 0, "residency is not a persisted mutation");

  const admitted = f.world._generateSync(0, 1);
  f.world._generateSync(0, 1);
  for (const slot of slots) {
    assert.equal(seen[slot].onChunkLoaded.length, 3);
    assert.equal(seen[slot].onChunkLoaded.at(-1).event.chunk, admitted);
  }
  const saves = f.calls.saves;
  const schedule = f.game.scheduleSave;
  t.mock.method(f.game, "scheduleSave", () => {
    for (const slot of slots)
      assert.equal(
        seen[slot].onMutation.length,
        1,
        "save follows both observers"
      );
    schedule();
  });
  const result = f.mutate([[8, 1, 8, BLOCK.WATER]]);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(f.calls.saves, saves + 1);
  for (const slot of slots) {
    assert.equal(seen[slot].onMutation.length, 1);
    const call = seen[slot].onMutation[0];
    assert.equal(call.result, true);
    assert.equal(call.world, f.world);
    assert.equal(Object.isFrozen(call.event), true);
    assert.deepEqual(call.event.changes[0].after, f.world.getCell(8, 1, 8));
  }
  assert.equal(
    seen.buildingServices.onMutation[0].event,
    seen.fluidServices.onMutation[0].event
  );
  assert.ok(f.fluid.diagnostics().fluid.queued > 0);
});

for (const failedSlot of slots) {
  for (const method of methods) {
    test(`${failedSlot}.${method} failure does not starve the other real consumer or undo World publication`, (t) => {
      const f = fluidLifecycleHost(t);
      const seen = observeServices(t, f);
      const healthySlot = slots.find((slot) => slot !== failedSlot);
      const failure = new Error(
        `authored ${failedSlot}.${method} observer failure`
      );
      t.mock.method(f.game[failedSlot], method, () => {
        throw failure;
      });
      let aggregate;
      if (method === "onMutation") {
        const saves = f.calls.saves;
        const result = f.mutate([[8, 1, 8, BLOCK.WATER]]);
        assert.equal(f.world.getFluid(8, 1, 8), F.WATER_SOURCE);
        assert.equal(f.calls.saves, saves + 1);
        assert.equal(result.observerErrors.length, 1);
        aggregate = result.observerErrors[0];
      } else {
        const chunk = f.world._generateSync(1, 0);
        assert.equal(f.world.chunks.get("1,0"), chunk);
        assert.equal(f.world.admissionObserverErrors.length, 1);
        aggregate = f.world.admissionObserverErrors[0].error;
      }
      assert.ok(aggregate instanceof AggregateError);
      assert.deepEqual(aggregate.errors, [failure]);
      assert.equal(seen[healthySlot][method].length, 1);
      assert.equal(seen[healthySlot][method][0].result, true);
    });
  }
}

test("both observer failures and scheduleSave failure are aggregated after the one real mutation", (t) => {
  const f = fluidLifecycleHost(t);
  const failures = [
    new Error("building"),
    new Error("fluid"),
    new Error("save"),
  ];
  const called = [];
  for (const [index, slot] of slots.entries())
    t.mock.method(f.game[slot], "onMutation", () => {
      called.push(slot);
      throw failures[index];
    });
  t.mock.method(f.game, "scheduleSave", () => {
    called.push("save");
    assert.equal(f.world.getFluid(8, 1, 8), F.WATER_SOURCE);
    throw failures[2];
  });
  const result = f.mutate([[8, 1, 8, BLOCK.WATER]]);
  assert.deepEqual(called, [...slots, "save"]);
  assert.equal(result.observerErrors.length, 1);
  assert.ok(result.observerErrors[0] instanceof AggregateError);
  assert.deepEqual(result.observerErrors[0].errors, failures);
});

test("async observers are not invoked and returned promises are not treated as synchronous receipts", (t) => {
  for (const kind of ["async-function", "returned-promise"]) {
    const f = fluidLifecycleHost(t);
    const seen = observeServices(t, f);
    let invoked = 0;
    // Install the actual function kind: a mock proxy can retain the original
    // synchronous target's tag and only swap its implementation internally.
    f.building.onMutation =
      kind === "async-function"
        ? async () => {
            invoked++;
          }
        : () => {
            invoked++;
            return Promise.resolve(true);
          };
    const result = f.mutate([[8, 1, 8, BLOCK.WATER]]);
    assert.equal(invoked, kind === "async-function" ? 0 : 1);
    assert.equal(result.observerErrors.length, 1);
    assert.ok(result.observerErrors[0].errors[0] instanceof TypeError);
    assert.equal(seen.fluidServices.onMutation.length, 1);
    assert.equal(seen.fluidServices.onMutation[0].result, true);
    assert.ok(f.fluid.diagnostics().fluid.queued > 0);
  }
});

test("replacing a later fluid consumer during building notification never dispatches into retired or newly unbound services", (t) => {
  const f = fluidLifecycleHost(t);
  const oldFluid = f.fluid;
  let retiredCalls = 0,
    replacementCalls = 0,
    replacement;
  const oldMutation = oldFluid.onMutation;
  t.mock.method(oldFluid, "onMutation", function (...args) {
    retiredCalls++;
    return oldMutation.apply(this, args);
  });
  const buildingMutation = f.building.onMutation;
  t.mock.method(f.building, "onMutation", function (...args) {
    const result = buildingMutation.apply(this, args);
    if (!replacement) {
      const saved = oldFluid.serialize();
      assert.equal(oldFluid.dispose(), true);
      replacement = f.createFluids({ saved });
      assert.equal(replacement.activate(f.game).ok, true);
      const mutation = replacement.onMutation;
      t.mock.method(replacement, "onMutation", function (...eventArgs) {
        replacementCalls++;
        return mutation.apply(this, eventArgs);
      });
    }
    return result;
  });
  f.mutate([[8, 1, 8, BLOCK.WATER]]);
  assert.equal(retiredCalls, 0);
  assert.equal(
    replacementCalls,
    0,
    "new owners need an explicit binding/replay"
  );
  assert.equal(replacement.active, true);
  assert.equal(f.coordinator.usage(oldFluid), undefined);
  assert.equal(f.coordinator.usage(oldFluid.fluids), undefined);
  f.bind();
  assert.equal(replacement.diagnostics().notificationsStarted, true);
  f.mutate([[9, 1, 8, BLOCK.WATER]]);
  assert.equal(retiredCalls, 0);
  assert.equal(replacementCalls, 1);
  assert.equal(oldFluid.dispose(), true);
  assert.equal(
    f.game.fluidServices,
    replacement,
    "late disposal cannot clear the replacement alias"
  );
  for (const owner of [f.world, f.settlement, f.overflow])
    assert.equal(owner._disposed, false);
});

test("a building consumer replacing itself cannot starve the still-current fluid owner", (t) => {
  const f = fluidLifecycleHost(t);
  const seen = observeServices(t, f);
  const next = new GameBuildingServices({
    world: f.world,
    gameplay: f.gameplay,
    context: f.context,
    saved: f.building.serialize(),
    support: { scanCells: 32, candidates: 4 },
  });
  const mutation = f.building.onMutation;
  t.mock.method(f.building, "onMutation", function (...args) {
    const result = mutation.apply(this, args);
    assert.equal(this.dispose(), true);
    assert.equal(next.activate(f.game).ok, true);
    return result;
  });
  try {
    const result = f.mutate([[8, 1, 8, BLOCK.WATER]]);
    assert.deepEqual(result.observerErrors, []);
    assert.equal(seen.fluidServices.onMutation.length, 1);
    assert.equal(seen.fluidServices.onMutation[0].result, true);
    assert.ok(f.fluid.diagnostics().fluid.queued > 0);
    assert.equal(next.active, true);
    assert.equal(f.building.active, false);
  } finally {
    next.dispose();
  }
});

test("World replacement during one observer stops remaining delivery and save into the retired host", (t) => {
  const f = fluidLifecycleHost(t),
    replacement = fluidLifecycleHost(t);
  const seen = observeServices(t, f);
  const mutation = f.building.onMutation;
  const saved = replacement.snapshot();
  const saves = f.calls.saves;
  t.mock.method(f.building, "onMutation", function (...args) {
    const result = mutation.apply(this, args);
    f.game.world = replacement.world;
    return result;
  });
  try {
    const result = f.mutate([[8, 1, 8, BLOCK.WATER]]);
    assert.deepEqual(result.observerErrors, []);
    assert.equal(seen.buildingServices.onMutation.length, 1);
    assert.equal(seen.fluidServices.onMutation.length, 0);
    assert.equal(f.calls.saves, saves);
    assert.equal(f.world.getFluid(8, 1, 8), F.WATER_SOURCE);
    assert.deepEqual(replacement.snapshot(), saved);
    assert.equal(f.fluid.active, false);
  } finally {
    f.game.world = f.world;
  }
});

test("stale epoch and retired World callbacks cannot schedule either current service or a save", (t) => {
  const f = fluidLifecycleHost(t, { bind: false });
  const other = fluidLifecycleHost(t);
  const seen = observeServices(t, f);
  f.bind();
  f.mutate([[8, 1, 8, BLOCK.WATER]]);
  const mutation = f.world.onMutation,
    admission = f.world.onChunkAdmitted;
  const oldMutation = seen.fluidServices.onMutation[0].event;
  const oldAdmission = seen.fluidServices.onChunkLoaded[0].event;
  const saves = f.calls.saves;
  const counts = () =>
    slots.map((slot) => methods.map((method) => seen[slot][method].length));
  const expected = counts();
  f.game.world = other.world;
  mutation(oldMutation);
  admission(oldAdmission);
  assert.deepEqual(counts(), expected);
  assert.equal(f.calls.saves, saves);
  f.game.world = f.world;
  f.world.setDimension("nether");
  assert.notEqual(f.world.epoch, oldMutation.epoch);
  mutation(oldMutation);
  admission(oldAdmission);
  assert.deepEqual(counts(), expected);
  assert.equal(f.calls.saves, saves);
});

test("unbinding retires captured callbacks even while their World and owners remain current", (t) => {
  const f = fluidLifecycleHost(t, { bind: false });
  const seen = observeServices(t, f);
  const unbind = f.bind();
  f.mutate([[8, 1, 8, BLOCK.WATER]]);
  const mutation = f.world.onMutation,
    admission = f.world.onChunkAdmitted;
  const mutationEvent = seen.fluidServices.onMutation[0].event;
  const admissionEvent = seen.fluidServices.onChunkLoaded[0].event;
  const saves = f.calls.saves,
    pending = f.fluid.serialize();
  unbind();
  assert.equal(f.world.onMutation, undefined);
  assert.equal(f.world.onChunkAdmitted, undefined);
  mutation(mutationEvent);
  admission(admissionEvent);
  for (const slot of slots) {
    assert.equal(
      seen[slot].onMutation.length,
      1,
      "retired callback must not redeliver"
    );
    assert.equal(seen[slot].onChunkLoaded.length, 1);
  }
  assert.equal(f.calls.saves, saves);
  assert.deepEqual(f.fluid.serialize(), pending);
});

test("an old unbinder cannot remove a newer binding or keep its captured callbacks live", (t) => {
  const f = fluidLifecycleHost(t, { bind: false });
  const seen = observeServices(t, f);
  const first = bindWorldServiceEvents(f.game);
  const retiredMutation = f.world.onMutation;
  first();
  const second = bindWorldServiceEvents(f.game);
  f.game.unbindWorldEvents = second;
  const currentMutation = f.world.onMutation,
    currentAdmission = f.world.onChunkAdmitted;
  first();
  assert.equal(f.world.onMutation, currentMutation);
  assert.equal(f.world.onChunkAdmitted, currentAdmission);
  f.mutate([[8, 1, 8, BLOCK.WATER]]);
  const event = seen.fluidServices.onMutation[0].event;
  retiredMutation(event);
  for (const slot of slots) assert.equal(seen[slot].onMutation.length, 1);
});

test("one initial replay failure is aggregated only after the healthy consumer sees every initial resident", (t) => {
  const f = fluidLifecycleHost(t, {
    bind: false,
    columns: [
      [0, 0],
      [1, 0],
    ],
  });
  const seen = observeServices(t, f);
  const failure = new Error("authored first-resident observer failure");
  const admission = f.building.onChunkLoaded;
  t.mock.method(f.building, "onChunkLoaded", function (world, event) {
    if (event.key === "0,0") throw failure;
    return admission.call(this, world, event);
  });
  assert.throws(() => f.bind(), AggregateError);
  assert.deepEqual(
    seen.fluidServices.onChunkLoaded.map(({ event }) => event.key).sort(),
    ["0,0", "1,0"],
    "a failing peer must not truncate the healthy consumer's initial residency"
  );
  assert.ok(
    seen.fluidServices.onChunkLoaded.every(({ result }) => result === true)
  );
  assert.equal(
    f.world.onMutation,
    undefined,
    "failed installation leaves no half-binding"
  );
  assert.equal(f.world.onChunkAdmitted, undefined);
  assert.equal(f.world.chunks.size, 2);
});

test("pending multi-dimension fluid work survives real archive export/parse/preflight and restores before admission replay", (t) => {
  const a = fluidLifecycleHost(t);
  a.mutate([[8, 1, 8, BLOCK.WATER]]);
  a.world.setDimension("nether");
  a.world._generateSync(0, 0);
  a.mutate([[10, 1, 8, BLOCK.WATER]]);
  a.world.setDimension("overworld");
  a.world._generateSync(0, 0);
  a.frame(50);
  assert.ok(dimensionWork(a.fluid).queue.length > 0);
  assert.ok(dimensionWork(a.fluid, "nether").queue.length > 0);
  const snapshot = a.game.archive.snapshot();
  const encoded = exportWorldFile(snapshot);
  const parsed = parseWorldFile(encoded);
  assert.equal(preflightWorldComponents(parsed), true);
  const normalized = normalizeWorldComponents(parsed);
  assert.deepEqual(parsed.fluids, snapshot.fluids);
  assert.deepEqual(normalized.fluids, snapshot.fluids);
  const liveBefore = a.snapshot(),
    liveBytes = a.coordinator.budget.totalBytes;
  const b = fluidLifecycleHost(t, { saved: normalized, activate: false });
  assert.equal(b.fluid.active, false);
  assert.equal(b.fluid.diagnostics().notificationsStarted, false);
  assert.equal(b.world.onMutation, undefined);
  assert.equal(b.world.onChunkAdmitted, undefined);
  for (const expected of normalized.fluids.dimensions) {
    const actual = dimensionWork(b.fluid, expected.dimension);
    assert.deepEqual(actual.queue, expected.queue);
    assert.equal(actual.clock, expected.clock);
    assert.equal(actual.accumulator, expected.accumulator);
    assert.notEqual(actual.queue, expected.queue);
    // Interrupted scan cursors may conservatively restart; pending work may not vanish.
    assert.equal(actual.scans.length, expected.scans.length);
  }
  assert.deepEqual(a.snapshot(), liveBefore);
  assert.equal(a.coordinator.budget.totalBytes, liveBytes);
  let replayed = 0;
  const pending = structuredClone(dimensionWork(b.fluid).queue);
  const admitted = b.fluid.onChunkLoaded;
  t.mock.method(b.fluid, "onChunkLoaded", function (world, event) {
    assertAdmission(world, event);
    assert.deepEqual(
      dimensionWork(this).queue,
      pending,
      "restore precedes first admission"
    );
    replayed++;
    return admitted.call(this, world, event);
  });
  b.activate();
  b.bind();
  assert.equal(replayed, 1);
  assert.equal(
    b.fluid.load(normalized),
    false,
    "live replayed owners cannot be loaded in place"
  );
  for (const host of [a, b]) {
    host.frame(100);
    host.frame(100);
    assert.equal(host.world.getFluid(9, 1, 8), F.WATER_1);
    assert.equal(host.fluid.diagnostics().fluid.clock, 1);
  }
  assert.deepEqual(b.world.serialize(), a.world.serialize());
  assert.deepEqual(
    dimensionWork(b.fluid, "nether").queue,
    dimensionWork(a.fluid, "nether").queue
  );
  assert.equal(a.calls.writes + b.calls.writes, 0);
});

test("malformed present sidecars reject in real initialize/import before screen closing, confirmation, saves or owner teardown", async (t) => {
  const f = fluidLifecycleHost(t);
  f.mutate([[8, 1, 8, BLOCK.WATER]]);
  const snapshot = f.snapshot(),
    before = structuredClone(snapshot);
  const bytes = f.coordinator.budget.totalBytes;
  let closed = 0,
    prepared = 0,
    disposed = 0;
  t.mock.method(f.game, "closeScreens", () => {
    closed++;
    return true;
  });
  t.mock.method(f.game, "prepareWorld", async () => {
    prepared++;
    assert.fail("preflight must run first");
  });
  for (const owner of [
    f.player,
    f.world,
    f.gameplay,
    f.settlement,
    f.overflow,
    f.building,
    f.fluid,
  ]) {
    const dispose = owner.dispose;
    t.mock.method(owner, "dispose", function () {
      disposed++;
      return dispose.call(this);
    });
  }
  const badInactive = {
    version: 1,
    seed: f.world.seed,
    generatorVersion: f.world.generatorVersion,
    dimensions: [
      { ...emptyWork("end"), queue: [[8, -1, 8, 1, false, null, null]] },
    ],
  };
  for (const fluids of [
    null,
    { version: 99 },
    { ...snapshot.fluids, seed: "wrong-world" },
    badInactive,
  ]) {
    const saved = { ...snapshot, fluids };
    assert.throws(() => normalizeWorldComponents(saved), /fluid simulation/);
    await assert.rejects(
      () => f.game.initialize(f.world.seed, saved),
      /fluid simulation/
    );
    const text = exportWorldFile(saved);
    const result = await f.game.archive.importFile({
      size: new TextEncoder().encode(text).byteLength,
      text: async () => text,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /fluid simulation/);
  }
  assert.equal(closed, 0);
  assert.equal(prepared, 0);
  assert.equal(disposed, 0);
  assert.equal(f.shell.confirms, 0);
  assert.equal(f.shell.rafRequests, 0);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.fluid.active, true);
  assert.equal(f.building.active, true);
});

test("real Game.prepareWorld stages/restores fluids detached; abandonment releases only the service's ownership", async (t) => {
  const f = fluidLifecycleHost(t);
  const candidateWorlds = authoredPrepareWorld(t);
  const saved = {
    version: 3,
    world: {
      version: 3,
      seed: LIFECYCLE_SEED,
      generatorVersion: 3,
      dimension: "overworld",
      edits: [["overworld", 8, 1, 8, BLOCK.WATER, 0, F.WATER_SOURCE]],
    },
    player: { ...LIFECYCLE_POSE, yaw: 0, pitch: 0, flying: false },
    fluids: {
      version: 1,
      seed: LIFECYCLE_SEED,
      generatorVersion: 3,
      dimensions: [
        { ...emptyWork(), queue: [[8, 1, 8, 1, false, null, null]] },
      ],
    },
  };
  const live = f.snapshot(),
    liveBytes = f.coordinator.budget.totalBytes;
  const staged = await f.game.prepareWorld(saved.world.seed, saved);
  try {
    assert.equal(candidateWorlds.length, 1);
    assert.equal(staged.world, candidateWorlds[0]);
    assert.equal(staged.world.chunks.size, 1);
    assert.equal(staged.world.getFluid(8, 1, 8), F.WATER_SOURCE);
    assert.equal(staged.fluidServices.active, false);
    assert.equal(
      staged.fluidServices.diagnostics().notificationsStarted,
      false
    );
    assert.deepEqual(staged.fluidServices.serialize().fluids, saved.fluids);
    for (const owner of [
      staged.world,
      staged.gameplay,
      staged.settlement,
      staged.overflow,
      staged.buildingServices,
      staged.fluidServices,
      staged.fluidServices.fluids,
    ]) {
      assert.equal(owner.coordinator, staged.world.coordinator);
      assert.notEqual(staged.world.coordinator.usage(owner), undefined);
    }
    assert.equal(staged.world.onChunkAdmitted, undefined);
    assert.equal(staged.world.onMutation, undefined);
    assert.deepEqual(f.snapshot(), live);
    assert.equal(f.coordinator.budget.totalBytes, liveBytes);
    const bytes = staged.world.coordinator.budget.totalBytes;
    const reservation = staged.fluidServices.fluids.reservedBytes;
    assert.equal(staged.fluidServices.dispose(), true);
    assert.equal(
      staged.world.coordinator.budget.totalBytes,
      bytes - reservation
    );
    assert.equal(staged.fluidServices.fluids._disposed, true);
    for (const owner of [
      staged.world,
      staged.gameplay,
      staged.settlement,
      staged.overflow,
    ]) {
      assert.equal(owner._disposed, false);
      assert.notEqual(staged.world.coordinator.usage(owner), undefined);
    }
    assert.equal(staged.fluidServices.dispose(), true);
    assert.equal(
      staged.world.coordinator.budget.totalBytes,
      bytes - reservation
    );
  } finally {
    disposeFluidStage(staged);
  }
  assert.equal(staged.world.coordinator.budget.totalBytes, 0);
  assert.equal(f.fluid.active, true);
});

test("a late fluid-stage failure cleans every candidate reservation without tearing down the live Game", async (t) => {
  const f = fluidLifecycleHost(t);
  const candidateWorlds = authoredPrepareWorld(t);
  const live = f.snapshot(),
    bytes = f.coordinator.budget.totalBytes;
  const saved = {
    version: 3,
    world: {
      version: 3,
      seed: LIFECYCLE_SEED,
      generatorVersion: 3,
      dimension: "overworld",
      edits: [],
    },
    player: { ...LIFECYCLE_POSE, yaw: 0, pitch: 0 },
    fluids: null,
  };
  await assert.rejects(
    () => f.game.prepareWorld(saved.world.seed, saved),
    /fluid services/
  );
  assert.equal(
    candidateWorlds.length,
    1,
    "failure occurs after the authored terrain stage"
  );
  assert.equal(candidateWorlds[0]._disposed, true);
  assert.equal(candidateWorlds[0].coordinator.budget.totalBytes, 0);
  assert.deepEqual(f.snapshot(), live);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(f.game.fluidServices, f.fluid);
  assert.equal(f.fluid.active, true);
  assert.equal(f.calls.writes, 0);
});

test("Game.frame sends one simulation delta to fluids before real Player physics and one reusable projection to Gameplay", (t) => {
  const f = fluidLifecycleHost(t, { position: { x: 9.5, y: 1, z: 8.5 } });
  f.mutate([[8, 1, 8, BLOCK.WATER]]);
  assert.equal(f.fluid.frame(0.2, { simulating: true }).ok, true);
  assert.equal(f.world.getFluid(9, 1, 8), F.NONE);
  const trace = traceFluidFrame(t, f);
  const update = f.player.update;
  t.mock.method(f.player, "update", function (...args) {
    assert.equal(
      f.world.getFluid(9, 1, 8),
      F.WATER_1,
      "water publishes before player physics"
    );
    return update.apply(this, args);
  });
  f.frame(50);
  assert.deepEqual(trace.order, [
    "fluids",
    "fluid-domain",
    "player",
    "environment",
    "gameplay",
  ]);
  assert.equal(trace.fluidFrames.length, 1);
  assert.equal(trace.fluidFrames[0].dt, 0.05);
  assert.deepEqual(trace.fluidFrames[0].options, { simulating: true });
  assert.deepEqual(trace.fluidUpdates, [0.05]);
  assert.deepEqual(trace.playerUpdates, [
    { dt: 0.05, options: { recoverFromVoid: false } },
  ]);
  assert.equal(trace.projections.length, 1);
  assert.equal(trace.projections[0].out, f.game.playerEnvironment);
  assert.equal(trace.projections[0].result, f.game.playerEnvironment);
  assert.equal(trace.gameplayUpdates.length, 1);
  assert.equal(trace.gameplayUpdates[0].environment, f.game.playerEnvironment);
  assert.equal(trace.gameplayUpdates[0].dt, 0.05);
  assert.equal(trace.gameplayUpdates[0].snapshot.inWater, true);
  assert.equal(
    Object.hasOwn(trace.gameplayUpdates[0].snapshot, "fallDistance"),
    false
  );
  const diagnostics = f.fluid.diagnostics().fluid;
  assert.equal(diagnostics.clock, 1);
  assert.equal(diagnostics.last.ticks, 1);
  assert.ok(diagnostics.last.scanCells <= 32);
  assert.ok(diagnostics.last.evaluated <= diagnostics.limits.maxUpdatesPerTick);
  assert.equal(f.coordinator.usage(f.fluid.fluids), diagnostics.reservedBytes);
  assert.ok(f.player.fluidState.waterImmersion > 0);
  assert.deepEqual(trace.damage, []);
  const projection = f.game.playerEnvironment;
  f.frame(50);
  assert.equal(trace.projections.length, 2);
  assert.equal(trace.projections[1].out, projection);
  assert.equal(trace.gameplayUpdates[1].environment, projection);
  assert.equal(
    f.fluid.diagnostics().fluid.clock,
    1,
    "host does not double-step the scheduler"
  );
  assert.equal(f.world.chunks.size, 1);
});

for (const [state, fluidCalls, simulating, playerCalls, gameplayCalls] of [
  ["active", 1, true, 1, 1],
  ["overlay", 1, true, 0, 1],
  ["closingScreens", 1, true, 0, 1],
  ["paused", 1, false, 0, 0],
  ["dead", 1, false, 0, 0],
  ["hidden", 0, false, 0, 0],
  ["building", 0, false, 0, 0],
  ["failed", 0, false, 0, 0],
]) {
  test(`Game.frame ${state} gate preserves exactly-once simulation and overlay breathing semantics`, (t) => {
    const f = fluidLifecycleHost(t, {
      cells: waterColumn(),
      position: { x: 8.5, y: 1, z: 8.5 },
    });
    f.gameplay.update(3, { underwater: true });
    if (state === "overlay") f.game.overlayChanged(true);
    else if (state === "hidden") f.shell.document.hidden = true;
    else if (state === "dead") f.gameplay.damage(20, "authored death");
    else if (state !== "active") f.game[state] = true;
    const before = f.fluid.serialize(),
      air = f.gameplay.air;
    const position = f.player.position.clone();
    const trace = traceFluidFrame(t, f);
    f.frame(50);
    assert.equal(trace.fluidFrames.length, fluidCalls);
    if (fluidCalls) {
      assert.equal(trace.fluidFrames[0].dt, 0.05);
      assert.equal(trace.fluidFrames[0].options.simulating, simulating);
    }
    assert.equal(trace.fluidUpdates.length, Number(simulating));
    assert.equal(trace.playerUpdates.length, playerCalls);
    assert.equal(trace.projections.length, gameplayCalls);
    assert.equal(trace.gameplayUpdates.length, gameplayCalls);
    if (gameplayCalls) {
      close(f.gameplay.air, air - 0.05 * (20 / 15));
      assert.equal(trace.gameplayUpdates[0].snapshot.underwater, true);
    } else {
      assert.equal(f.gameplay.air, air);
      assert.deepEqual(f.fluid.serialize(), before);
    }
    if (!playerCalls) assert.ok(f.player.position.equals(position));
    assert.deepEqual(trace.damage, []);
    assert.equal(f.world.chunks.size, 1);
  });
}

test("the real frame clamps suspended wall time once for fluids, physics and Gameplay", (t) => {
  const f = fluidLifecycleHost(t);
  const trace = traceFluidFrame(t, f);
  f.frame(1000);
  assert.deepEqual(trace.fluidUpdates, [0.1]);
  assert.equal(trace.playerUpdates.length, 1);
  assert.equal(trace.playerUpdates[0].dt, 0.1);
  assert.equal(trace.gameplayUpdates.length, 1);
  assert.equal(trace.gameplayUpdates[0].dt, 0.1);
  assert.equal(f.fluid.diagnostics().fluid.clock, 0);
  assert.equal(f.world.chunks.size, 1);
});

test("overlay drowning uses one physical-eye projection and the existing single damage clock", (t) => {
  const f = fluidLifecycleHost(t, {
    cells: waterColumn(),
    position: { x: 8.5, y: 1, z: 8.5 },
  });
  f.gameplay.update(15.95, { underwater: true });
  assert.equal(f.gameplay.air, 0);
  assert.equal(f.gameplay.health, 20);
  f.game.overlayChanged(true);
  f.player.fallDistance = 12;
  const trace = traceFluidFrame(t, f);
  f.frame(100);
  assert.equal(trace.playerUpdates.length, 0);
  assert.equal(trace.projections.length, 1);
  assert.equal(trace.gameplayUpdates.length, 1);
  assert.equal(trace.gameplayUpdates[0].snapshot.airKnown, true);
  assert.equal(trace.gameplayUpdates[0].snapshot.underwater, true);
  assert.equal(trace.gameplayUpdates[0].snapshot.restoreAir, false);
  assert.equal(
    Object.hasOwn(trace.gameplayUpdates[0].snapshot, "fallDistance"),
    false
  );
  assert.deepEqual(trace.damage, [{ amount: 2, cause: "drowning" }]);
  assert.equal(f.gameplay.health, 18);
  assert.equal(f.calls.hurts.length, 1);
});

test("bubble eye projection reaches the real Gameplay air-restoration branch through an overlay", (t) => {
  const f = fluidLifecycleHost(t, {
    cells: [[8, 0, 8, BLOCK.SOUL_SAND], ...waterColumn(F.BUBBLE_UP)],
    position: { x: 8.5, y: 1, z: 8.5 },
  });
  f.gameplay.update(15.95, { underwater: true });
  f.player.perspective = "back";
  assert.equal(
    sampleFluidAtPoint(f.world, f.game.graphics.camera.position).fluid,
    F.NONE
  );
  f.game.overlayChanged(true);
  const trace = traceFluidFrame(t, f);
  f.frame(100);
  assert.equal(trace.projections.length, 1);
  assert.equal(trace.gameplayUpdates.length, 1);
  assert.equal(trace.gameplayUpdates[0].snapshot.restoreAir, true);
  assert.equal(f.gameplay.air, 20);
  assert.equal(f.gameplay._timers.drowning, 0);
  assert.equal(f.gameplay.health, 20);
  assert.deepEqual(trace.damage, []);
  assert.equal(f.calls.hurts.length, 0);
});

test("unknown body coverage reaches Gameplay as unknown instead of granting air or restoring bubbles", (t) => {
  const f = fluidLifecycleHost(t, {
    cells: [
      [15, 1, 8, BLOCK.WATER],
      [15, 2, 8, BLOCK.WATER],
    ],
    position: { x: 15.9, y: 1, z: 8.5 },
  });
  f.gameplay.update(15.95, { underwater: true });
  const air = f.gameplay.air,
    drowning = f.gameplay._timers.drowning;
  const position = f.player.position.clone();
  const trace = traceFluidFrame(t, f);
  f.frame(100);
  assert.equal(trace.projections.length, 1);
  assert.equal(trace.gameplayUpdates[0].snapshot.airKnown, false);
  assert.equal(trace.gameplayUpdates[0].snapshot.restoreAir, false);
  assert.equal(f.player.fluidMovementBlocked, true);
  assert.ok(f.player.position.equals(position));
  assert.equal(f.gameplay.air, air);
  assert.equal(f.gameplay._timers.drowning, drowning);
  assert.deepEqual(trace.damage, []);
  assert.equal(
    f.world.getCell(16, 1, 8),
    null,
    "sampling never admits the unknown neighbor"
  );
  assert.equal(f.world.chunks.size, 1);
});

test("real dry landing applies onFall once while shallow resolved water cancels the same host damage path", (t) => {
  for (const wet of [false, true]) {
    const f = fluidLifecycleHost(t, {
      cells: wet ? [[8, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_7 }]] : [],
      position: { x: 8.5, y: 1.2, z: 8.5 },
    });
    f.player.velocity.y = -32;
    f.player.fallDistance = 8;
    const trace = traceFluidFrame(t, f);
    f.frame(1000 / 120);
    close(f.player.position.y, 1);
    assert.equal(trace.gameplayUpdates.length, 1);
    assert.equal(
      Object.hasOwn(trace.gameplayUpdates[0].snapshot, "fallDistance"),
      false
    );
    assert.deepEqual(trace.damage, wet ? [] : [{ amount: 6, cause: "fall" }]);
    assert.equal(f.gameplay.health, wet ? 20 : 14);
    assert.equal(f.calls.hurts.length, wet ? 0 : 1);
  }
});

test("the real frame honors signed Survival void bounds and never also invokes Creative recovery", (t) => {
  const f = fluidLifecycleHost(t, { position: { x: 8.5, y: -100, z: 8.5 } });
  const spawn = t.mock.method(f.world, "getSpawn");
  const trace = traceFluidFrame(t, f);
  f.frame(1000 / 60);
  assert.equal(trace.playerUpdates[0].options.recoverFromVoid, false);
  assert.equal(trace.gameplayUpdates[0].snapshot.voidY, -128);
  assert.equal(trace.gameplayUpdates[0].snapshot.inVoid, false);
  assert.deepEqual(trace.damage, []);
  f.player.setPosition({ x: 8.5, y: -129, z: 8.5 });
  f.frame(1000 / 60);
  assert.equal(trace.gameplayUpdates[1].snapshot.inVoid, true);
  assert.equal(spawn.mock.callCount(), 0);
  assert.ok(f.player.position.y < -129);
  assert.deepEqual(trace.damage, [{ amount: 20, cause: "the void" }]);
  assert.equal(f.calls.hurts.length, 1);
  assert.equal(f.gameplay.dead, true);
});

test("Creative frame passes recovery policy to real Player physics before projecting void status", (t) => {
  const f = fluidLifecycleHost(t, {
    mode: "creative",
    position: { x: 8.5, y: -129, z: 8.5 },
  });
  const spawn = t.mock.method(f.world, "getSpawn");
  const trace = traceFluidFrame(t, f);
  f.frame(1000 / 60);
  assert.equal(trace.playerUpdates[0].options.recoverFromVoid, true);
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(
    f.world.chunks.size,
    9,
    "real spawn recovery admits its bounded 3-by-3 authored neighborhood"
  );
  assert.ok(f.player.position.y > f.world.spec.voidY);
  assert.equal(trace.gameplayUpdates[0].snapshot.inVoid, false);
  assert.deepEqual(trace.damage, []);
  assert.equal(f.gameplay.health, 20);
});
