import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { parseStructureIdentity } from "../src/canonical-structure-identity.js";
import {
  explorationAdmission,
  nativeExplorationContext,
} from "../src/exploration-host-state.js";
import {
  mapResolutionFromStructure,
  selectTreasureMapTarget,
} from "../src/exploration-markers.js";
import { ExplorationState } from "../src/exploration-state.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { GameExplorationServices } from "../src/game-exploration-services.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { GameProjectileServices } from "../src/game-projectile-services.js";
import { harvestDrops } from "../src/gameplay-harvest.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { resolveStructureMapTarget } from "../src/structure-catalog.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { World } from "../src/world.js";
import {
  admitNativeStructure,
  expectedExplorationSlots,
  holdExplorationTool,
  itemTotals,
  nativeExplorationSite,
} from "./exploration-services-fixture.js";
import {
  assertOwners,
  authoredArchive,
  authoredExplorationHost,
  authorStageTerrain,
  disposeExplorationStage,
  emptyExploration,
  hostFromExplorationStage,
  looseStacks,
  nativeExplorationHost,
  OBSERVED_METHODS,
  OBSERVED_SERVICES,
  observeExplorationServices,
  traceCommits,
} from "./game-exploration-host-fixture.js";

// No source-text assertions or successful transaction substitutes. Authored
// columns are explicitly lifecycle-only; every loot/map case uses native v4.
const key = ({ x, y, z }) => `${x},${y},${z}`;
const chestDrops = (f) =>
  harvestDrops(BLOCK.CHEST, {
    mode: f.gameplay.mode,
    context: f.context,
    explosion: true,
  });
const firstEntry = (f) => {
  const entry = f.entries()[0];
  assert.ok(entry, "a real admitted native container is required");
  return entry;
};
const chartEntry = (f) => {
  const entry = f
    .entries()
    .find(({ marker }) => marker.role === "shipwreck_map");
  assert.ok(entry);
  return entry;
};

function immediateAnimationFrames(t, shell) {
  t.mock.method(globalThis, "requestAnimationFrame", (callback) => {
    queueMicrotask(() => callback(0));
    return ++shell.rafRequests;
  });
}

function assertAdmission(world, event) {
  assert.equal(Object.isFrozen(event), true);
  assert.equal(event.world, world);
  assert.equal(event.chunk, world.chunks.get(event.key));
  assert.equal(event.seed, world.seed);
  assert.equal(event.generatorVersion, world.generatorVersion);
  assert.equal(event.dimension, world.dimension);
  assert.equal(event.epoch, world.epoch);
  assert.equal(event.key, `${event.cx},${event.cz}`);
  assert.equal(event.incarnation, event.chunk.incarnation);
  assert.equal(event.revision, event.chunk.revision);
}

test("Game.prepareWorld stages v4 and explicit legacy exploration, but keeps absent legacy sidecars absent", async (t) => {
  const live = authoredExplorationHost(t);
  const before = live.snapshot(),
    bytes = live.coordinator.budget.totalBytes;
  const worlds = authorStageTerrain(t);
  for (const generatorVersion of [1, 2, 3, 4]) {
    for (const withExploration of [false, true]) {
      const saved = authoredArchive({ generatorVersion, withExploration });
      const original = structuredClone(saved);
      const normalized = normalizeWorldComponents(saved);
      const wanted = generatorVersion === 4 || withExploration;
      assert.equal(Object.hasOwn(normalized, "exploration"), wanted);
      // Keep absence intact here: v4 must not depend on preflight having added
      // its sidecar, whereas legacy versions must not acquire one accidentally.
      const staged = await live.game.prepareWorld(saved.world.seed, saved, {
        context: normalized.context,
      });
      let candidate;
      try {
        assert.equal(staged.world, worlds.at(-1));
        assert.equal(staged.world.chunks.size, 1);
        assert.equal(staged.world.onMutation, undefined);
        assert.equal(staged.world.onChunkAdmitted, undefined);
        assert.ok(staged.projectileServices instanceof GameProjectileServices);
        if (wanted) {
          const service = staged.explorationServices;
          assert.ok(service instanceof GameExplorationServices);
          assert.equal(service.active, false);
          assert.equal(service.diagnostics().notificationsStarted, false);
          assert.equal(service.diagnostics().resident.markers, 0);
          assert.equal(service.diagnostics().mapSearches, 0);
          assert.equal(service.world, staged.world);
          assert.equal(service.gameplay, staged.gameplay);
          assert.equal(service.settlement, staged.settlement);
          assert.equal(service.overflow, staged.overflow);
          for (const owner of [
            staged.world,
            staged.gameplay,
            staged.settlement,
            staged.overflow,
            service,
            service.exploration,
            staged.projectileServices,
            staged.projectileServices.projectiles,
          ]) {
            assert.equal(owner.coordinator, staged.world.coordinator);
            assert.notEqual(staged.world.coordinator.usage(owner), undefined);
          }
          assert.equal(staged.world.coordinator.usage(service), 0);
          assert.equal(staged.world.coordinator.usage(service.exploration), 0);
          assert.deepEqual(service.serialize(), {
            exploration: emptyExploration(saved.world),
          });
        } else {
          assert.equal(
            staged.explorationServices,
            null,
            "not undefined or a dormant legacy host"
          );
        }
        candidate = hostFromExplorationStage(t, staged, {
          saved: normalized,
          activate: false,
          bind: false,
        });
        candidate.activate();
        // Authored v4 has no native sampler/manifest and is NOT admitted as native.
        if (generatorVersion < 4) candidate.bind();
        const archive = candidate.snapshot();
        assert.equal(Object.hasOwn(archive, "exploration"), wanted);
        assert.equal(
          Object.hasOwn(
            parseWorldFile(exportWorldFile(archive)),
            "exploration"
          ),
          wanted
        );
        if (wanted)
          assert.deepEqual(archive.exploration, emptyExploration(saved.world));
        assert.deepEqual(
          saved,
          original,
          "preflight and staging cannot rewrite the input archive"
        );
        assert.deepEqual(live.snapshot(), before);
        assert.equal(live.coordinator.budget.totalBytes, bytes);
      } finally {
        if (candidate) candidate.dispose();
        else disposeExplorationStage(staged);
      }
      assert.equal(staged.world.coordinator.budget.totalBytes, 0);
      assert.equal(
        staged.world.coordinator.usage(staged.projectileServices.projectiles),
        undefined
      );
    }
  }
});

for (const withExploration of [false, true]) {
  test(`historical ordinary chest keeps its original open/break ownership with exploration=${withExploration}`, (t) => {
    const saved = authoredArchive({ generatorVersion: 3, withExploration });
    const f = authoredExplorationHost(t, { saved });
    f.mutate([[8, 1, 8, BLOCK.CHEST]]);
    holdExplorationTool(f);
    const hit = f.hit({ x: 8, y: 1, z: 8 });
    assert.equal(f.game.inventoryActions.openStation(hit), true);
    assert.ok(
      f.settlement
        .inspectContainer(f.world, hit)
        .slots.every((slot) => slot === null)
    );
    const plan = f.game.harvestActions.prepareBreak(hit);
    assert.ok(plan);
    assertOwners(plan.participants, [
      f.gameplay,
      f.settlement,
      f.world,
      f.overflow,
    ]);
    assert.equal(f.game.harvestActions.commit(plan).ok, true);
    assert.deepEqual(itemTotals(looseStacks(f)), itemTotals(chestDrops(f)));
    assert.equal(Object.hasOwn(f.snapshot(), "exploration"), withExploration);
    if (withExploration)
      assert.deepEqual(f.service.serialize().exploration.containers, []);
    else assert.equal(f.explorationServices, null);
    assert.equal(Object.hasOwn(saved, "exploration"), withExploration);
  });
}

test("raw World seeds survive Game staging and preflight without trimming or changing canonical URI spelling", async (t) => {
  const f = authoredExplorationHost(t);
  authorStageTerrain(t);
  for (const seed of [
    "",
    " \tcoast\n\u0000 ",
    "\ud800",
    '"\\'.repeat(40),
    "雪".repeat(80),
  ]) {
    const saved = authoredArchive({ seed, withExploration: true });
    const normalized = normalizeWorldComponents(saved);
    const staged = await f.game.prepareWorld(seed, normalized);
    try {
      assert.equal(staged.world.seed, seed);
      assert.equal(staged.context.seed, seed);
      assert.equal(
        staged.explorationServices.serialize().exploration.seed,
        seed
      );
      // Grammar-only assertion, not a declaration that this authored site exists.
      const id = `structure:v1:${encodeURIComponent(JSON.stringify(seed))}:overworld:shipwreck:-1:2`;
      assert.deepEqual(parseStructureIdentity(id, seed, 4, "overworld"), {
        layoutVersion: 1,
        generatorVersion: 4,
        dimension: "overworld",
        kind: "shipwreck",
        gx: -1,
        gz: 2,
        spacing: 192,
      });
      assert.equal(saved.world.seed, seed);
    } finally {
      disposeExplorationStage(staged);
    }
  }
});

test("late exploration load failure in real initialize releases every staged host including projectiles, not live owners", async (t) => {
  const f = authoredExplorationHost(t);
  const worlds = authorStageTerrain(t);
  immediateAnimationFrames(t, f.shell);
  const before = f.ownership();
  const registered = new Set(),
    released = [];
  const register = TransactionCoordinator.prototype.register;
  t.mock.method(
    TransactionCoordinator.prototype,
    "register",
    function (owner, ...args) {
      const result = register.call(this, owner, ...args);
      if (this !== f.coordinator && result) registered.add(owner);
      return result;
    }
  );
  const failure = new Error(
    "authored failure after the real exploration ledger load"
  );
  const load = ExplorationState.prototype.load;
  t.mock.method(ExplorationState.prototype, "load", function (...args) {
    const result = load.apply(this, args);
    assert.equal(result, true);
    if (this.coordinator !== f.coordinator) throw failure;
    return result;
  });
  for (const Type of [
    GameBuildingServices,
    GameFluidServices,
    GameProjectileServices,
    GameExplorationServices,
  ]) {
    const dispose = Type.prototype.dispose;
    t.mock.method(Type.prototype, "dispose", function (...args) {
      released.push(this);
      return dispose.apply(this, args);
    });
  }
  const saved = authoredArchive({ withExploration: true });
  await assert.rejects(
    () => f.game.initialize(saved.world.seed, saved),
    (error) => error === failure
  );
  assert.equal(worlds.length, 1);
  const candidate = worlds[0];
  assert.equal(candidate._disposed, true);
  assert.equal(candidate.coordinator.budget.totalBytes, 0);
  for (const owner of registered)
    assert.equal(
      candidate.coordinator.usage(owner),
      undefined,
      "zero-byte owners must be released too"
    );
  for (const Type of [
    GameBuildingServices,
    GameFluidServices,
    GameProjectileServices,
    GameExplorationServices,
  ]) {
    const hosts = [...registered].filter((owner) => owner instanceof Type);
    assert.equal(hosts.length, 1, `the staged ${Type.name} is present`);
    assert.equal(hosts[0]._disposed, true);
    assert.ok(released.includes(hosts[0]));
  }
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.game.world, f.world);
  assert.equal(f.service.active, true);
  assert.equal(f.game.projectileServices.active, true);
  assert.equal(f.game.building, false);
  assert.equal(f.calls.archives.length, 0);
});

test("initialize retires exploration before Settlement, Gameplay and World at the renderer boundary", async (t) => {
  const f = authoredExplorationHost(t);
  authorStageTerrain(t);
  immediateAnimationFrames(t, f.shell);
  const order = [],
    old = f.service,
    ledger = old.exploration;
  for (const [label, owner] of [
    ["exploration", old],
    ["settlement", f.settlement],
    ["gameplay", f.gameplay],
    ["projectiles", f.projectileServices],
    ["world", f.world],
  ]) {
    const dispose = owner.dispose;
    t.mock.method(owner, "dispose", function (...args) {
      order.push(label);
      return dispose.apply(this, args);
    });
  }
  let candidate;
  const prepare = f.game.prepareWorld;
  t.mock.method(f.game, "prepareWorld", async function (...args) {
    candidate = await prepare.apply(this, args);
    return candidate;
  });
  const boundary = new Error("intentional Node-only renderer boundary");
  // Stop BEFORE any WebGL is constructed; no successful renderer is fabricated.
  f.shell.document.createElementNS = () => {
    throw boundary;
  };
  const saved = authoredArchive();
  try {
    await assert.rejects(
      () => f.game.initialize(saved.world.seed, saved),
      (error) => error === boundary
    );
    assert.ok(candidate);
    for (const later of ["settlement", "gameplay", "world"])
      assert.ok(
        order.indexOf("exploration") >= 0 &&
          order.indexOf("exploration") < order.indexOf(later)
      );
    assert.equal(old._disposed, true);
    assert.equal(ledger._disposed, true);
    assert.equal(f.coordinator.usage(old), undefined);
    assert.equal(f.coordinator.usage(ledger), undefined);
    assert.equal(f.coordinator.budget.totalBytes, 0);
    assert.equal(f.game.world, candidate.world);
    assert.equal(f.game.explorationServices, null);
    assert.equal(f.game.exploration, null);
  } finally {
    delete f.shell.document.createElementNS;
    disposeExplorationStage(candidate);
  }
});

test("malformed-present exploration fails initialize/import before closing, staging, saving or teardown", async (t) => {
  const f = authoredExplorationHost(t);
  const before = f.ownership(),
    snapshot = f.snapshot();
  let closed = 0,
    prepared = 0,
    disposed = 0;
  const close = f.game.closeScreens;
  t.mock.method(f.game, "closeScreens", function (...args) {
    closed++;
    return close.apply(this, args);
  });
  t.mock.method(f.game, "prepareWorld", async () => {
    prepared++;
    assert.fail("malformed sidecars cannot reach staging");
  });
  for (const owner of [
    f.world,
    f.gameplay,
    f.settlement,
    f.overflow,
    f.service,
    f.projectileServices,
  ]) {
    const dispose = owner.dispose;
    t.mock.method(owner, "dispose", function (...args) {
      disposed++;
      return dispose.apply(this, args);
    });
  }
  for (const exploration of [
    null,
    undefined,
    {},
    { ...snapshot.exploration, version: 99 },
    { ...snapshot.exploration, seed: "wrong-world" },
    { ...snapshot.exploration, generatorVersion: 4 },
    { ...snapshot.exploration, containers: [{}] },
    { ...snapshot.exploration, encounters: [{}] },
  ]) {
    const saved = { ...snapshot, exploration };
    assert.equal(Object.hasOwn(saved, "exploration"), true);
    assert.throws(() => normalizeWorldComponents(saved), /exploration/i);
    await assert.rejects(
      () => f.game.initialize(f.world.seed, saved),
      /exploration/i
    );
    // JSON cannot represent present undefined; test that distinction in memory.
    if (exploration !== undefined) {
      const text = exportWorldFile(saved);
      const result = await f.game.archive.importFile({
        size: new TextEncoder().encode(text).byteLength,
        text: async () => text,
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /exploration/i);
    }
  }
  assert.equal(closed + prepared + disposed, 0);
  assert.equal(f.shell.confirms, 0);
  assert.equal(f.shell.rafRequests, 0);
  assert.equal(f.calls.archives.length, 0);
  assert.deepEqual(f.ownership(), before);
  assert.deepEqual(f.snapshot(), snapshot);
});

test("preflight validates the ORIGINAL sidecar and never invokes its top-level, nested or array getters", async (t) => {
  const f = authoredExplorationHost(t);
  const snapshot = f.snapshot(),
    before = f.ownership();
  let reads = 0,
    closed = 0;
  const getter = () => {
    reads++;
    return snapshot.exploration;
  };
  const close = f.game.closeScreens;
  t.mock.method(f.game, "closeScreens", function (...args) {
    closed++;
    return close.apply(this, args);
  });
  for (const form of ["root", "nonenumerable", "seed", "container-index"]) {
    const saved = structuredClone(snapshot);
    if (form === "root")
      Object.defineProperty(saved, "exploration", {
        enumerable: true,
        get: getter,
      });
    else if (form === "nonenumerable")
      Object.defineProperty(saved, "exploration", {
        enumerable: false,
        value: saved.exploration,
      });
    else if (form === "seed")
      Object.defineProperty(saved.exploration, "seed", {
        enumerable: true,
        get: getter,
      });
    else {
      saved.exploration.containers = Array(1);
      Object.defineProperty(saved.exploration.containers, "0", {
        enumerable: true,
        get: getter,
      });
    }
    assert.throws(() => normalizeWorldComponents(saved), /exploration/i);
    await assert.rejects(
      () => f.game.initialize(f.world.seed, saved),
      /exploration/i
    );
    assert.equal(reads, 0, `${form} must be rejected before structuredClone`);
  }
  assert.equal(closed, 0);
  assert.equal(f.shell.rafRequests, 0);
  assert.equal(f.service.active, true);
  assert.equal(f.world._disposed, false);
  assert.deepEqual(f.ownership(), before);
});

test("activation precedes real native replay and admission never rolls or initializes loot", async (t) => {
  const f = await nativeExplorationHost(t, { activate: false, bind: false });
  assert.equal(f.world.onMutation, undefined);
  assert.equal(f.world.onChunkAdmitted, undefined);
  assert.equal(f.service.active, false);
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("admission cannot roll loot")
  );
  const admission = f.service.onChunkLoaded,
    events = [];
  t.mock.method(f.service, "onChunkLoaded", function (world, event) {
    assert.equal(this.active, true);
    assert.equal(f.game.exploration, this.exploration);
    assert.equal(f.settlement.ownsContainerAccess(this), true);
    assertAdmission(world, event);
    events.push(event);
    return admission.call(this, world, event);
  });
  f.activate();
  const before = f.ownership();
  f.bind();
  assert.equal(events.length, f.world.chunks.size);
  assert.equal(f.service.diagnostics().notificationsStarted, true);
  assert.equal(f.entries().length, 3);
  assert.deepEqual(f.ownership(), before);
  for (const entry of f.entries())
    assert.equal(
      f.settlement.inspectContainer(f.world, f.hit(entry.marker)).initialized,
      false
    );
});

test("Game multiplexes replay, later admissions and one post-publication mutation to all three independent services", (t) => {
  const f = authoredExplorationHost(t, {
    bind: false,
    columns: [
      [0, 0],
      [1, 0],
    ],
  });
  const seen = observeExplorationServices(t, f),
    before = f.ownership();
  f.bind();
  for (const slot of OBSERVED_SERVICES) {
    assert.equal(seen[slot].onChunkLoaded.length, 2);
    for (const { world, event, result } of seen[slot].onChunkLoaded) {
      assertAdmission(world, event);
      assert.equal(result, true);
    }
    assert.equal(
      seen[slot].onChunkLoaded[0].event,
      seen.buildingServices.onChunkLoaded[0].event
    );
  }
  assert.deepEqual(f.ownership(), before);
  const chunk = f.world._generateSync(0, 1);
  f.world._generateSync(0, 1);
  for (const slot of OBSERVED_SERVICES) {
    assert.equal(seen[slot].onChunkLoaded.length, 3);
    assert.equal(seen[slot].onChunkLoaded.at(-1).event.chunk, chunk);
  }
  const saves = f.calls.saves;
  const result = f.mutate([[8, 1, 8, BLOCK.WATER]]);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(f.calls.saves, saves + 1);
  for (const slot of OBSERVED_SERVICES) {
    assert.equal(seen[slot].onMutation.length, 1);
    const call = seen[slot].onMutation[0];
    assert.equal(call.result, true);
    assert.equal(call.event, seen.buildingServices.onMutation[0].event);
    assert.equal(Object.isFrozen(call.event), true);
    assert.deepEqual(call.event.changes[0].after, f.world.getCell(8, 1, 8));
  }
  assert.ok(f.fluidServices.diagnostics().fluid.queued > 0);
  assert.ok(f.buildingServices.supportStatus().queuedColumns > 0);
  assert.equal(f.service.diagnostics().resident.columns, 3);
  assert.deepEqual(f.service.serialize().exploration.containers, []);
});

for (const failed of OBSERVED_SERVICES) {
  for (const method of OBSERVED_METHODS) {
    test(`${failed}.${method} failure cannot starve either peer or undo publication`, (t) => {
      const f = authoredExplorationHost(t);
      const seen = observeExplorationServices(t, f);
      const failure = new Error(`authored ${failed}.${method} failure`);
      t.mock.method(f.game[failed], method, () => {
        throw failure;
      });
      let error;
      if (method === "onMutation") {
        const saves = f.calls.saves;
        const result = f.mutate([[8, 1, 8, BLOCK.WATER]]);
        assert.equal(f.world.get(8, 1, 8), BLOCK.WATER);
        assert.equal(result.observerErrors.length, 1);
        assert.equal(f.calls.saves, saves + 1);
        error = result.observerErrors[0];
      } else {
        const chunk = f.world._generateSync(1, 0);
        assert.equal(f.world.chunks.get("1,0"), chunk);
        assert.equal(f.world.admissionObserverErrors.length, 1);
        error = f.world.admissionObserverErrors[0].error;
      }
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      for (const healthy of OBSERVED_SERVICES.filter(
        (slot) => slot !== failed
      )) {
        assert.equal(seen[healthy][method].length, 1);
        assert.equal(seen[healthy][method][0].result, true);
      }
    });
  }
}

test("failed exploration replay still visits every initial resident for its peers and leaves no half-installed observer", (t) => {
  const f = authoredExplorationHost(t, {
    bind: false,
    columns: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
  });
  const seen = observeExplorationServices(t, f);
  const failure = new Error("authored first exploration admission failure");
  const admitted = f.service.onChunkLoaded;
  t.mock.method(f.service, "onChunkLoaded", function (world, event) {
    if (event.key === "0,0") throw failure;
    return admitted.call(this, world, event);
  });
  assert.throws(() => f.bind(), AggregateError);
  for (const slot of ["buildingServices", "fluidServices"])
    assert.deepEqual(
      seen[slot].onChunkLoaded.map(({ event }) => event.key).sort(),
      ["0,0", "0,1", "1,0"]
    );
  assert.equal(f.world.onMutation, undefined);
  assert.equal(f.world.onChunkAdmitted, undefined);
  assert.equal(f.world.chunks.size, 3);
  assert.equal(f.service.exploration.reservedBytes, 0);
});

test("revocation during an earlier observer skips the retired exploration host and requires replay for its replacement", (t) => {
  const f = authoredExplorationHost(t),
    old = f.service;
  const retiredMutation = f.world.onMutation,
    retiredUnbind = f.game.unbindWorldEvents;
  const seen = observeExplorationServices(t, f);
  const mutation = f.buildingServices.onMutation;
  let replacement,
    replacementCalls = 0;
  t.mock.method(f.buildingServices, "onMutation", function (...args) {
    const result = mutation.apply(this, args);
    if (!replacement) {
      const saved = old.serialize();
      assert.equal(old.dispose(), true);
      replacement = f.createExploration({ saved });
      assert.equal(replacement.activate(f.game).ok, true);
      const observe = replacement.onMutation;
      t.mock.method(replacement, "onMutation", function (...event) {
        replacementCalls++;
        return observe.apply(this, event);
      });
    }
    return result;
  });
  assert.deepEqual(f.mutate([[8, 1, 8, BLOCK.WATER]]).observerErrors, []);
  assert.equal(seen.fluidServices.onMutation.length, 1);
  assert.equal(seen.explorationServices.onMutation.length, 0);
  assert.equal(replacementCalls, 0);
  assert.equal(f.coordinator.usage(old), undefined);
  assert.equal(f.coordinator.usage(old.exploration), undefined);
  f.bind();
  const current = f.world.onMutation;
  retiredUnbind();
  retiredMutation(seen.buildingServices.onMutation[0].event);
  assert.equal(f.world.onMutation, current);
  assert.equal(replacementCalls, 0);
  assert.equal(replacement.diagnostics().notificationsStarted, true);
  f.mutate([[9, 1, 8, BLOCK.WATER]]);
  assert.equal(replacementCalls, 1);
  old.dispose();
  assert.equal(f.game.explorationServices, replacement);
});

test("stale epoch, replaced World and unbound callbacks cannot touch any current service or schedule a save", (t) => {
  const f = authoredExplorationHost(t, { bind: false });
  const other = authoredExplorationHost(t);
  const seen = observeExplorationServices(t, f);
  const unbind = f.bind();
  f.mutate([[8, 1, 8, BLOCK.WATER]]);
  const mutation = f.world.onMutation,
    admission = f.world.onChunkAdmitted;
  const event = seen.explorationServices.onMutation[0].event;
  const resident = seen.explorationServices.onChunkLoaded[0].event;
  const counts = () =>
    OBSERVED_SERVICES.map((slot) =>
      OBSERVED_METHODS.map((method) => seen[slot][method].length)
    );
  const before = counts(),
    saves = f.calls.saves,
    untouched = other.ownership();
  f.game.world = other.world;
  mutation(event);
  admission(resident);
  f.game.world = f.world;
  f.world.setDimension("nether");
  assert.notEqual(f.world.epoch, event.epoch);
  mutation(event);
  admission(resident);
  unbind();
  mutation(event);
  admission(resident);
  assert.deepEqual(counts(), before);
  assert.equal(f.calls.saves, saves);
  assert.deepEqual(other.ownership(), untouched);
});

test("real Game.frame performs one bounded exploration maintenance step while paused without rolling loot", (t) => {
  const f = authoredExplorationHost(t, {
    columns: [
      [0, 0],
      [1, 0],
    ],
    limits: { columns: 2, scanColumns: 1 },
  });
  const ledger = f.service.serialize(),
    frames = [],
    frame = f.service.frame;
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("maintenance cannot roll loot")
  );
  t.mock.method(f.service, "frame", function (...args) {
    const result = frame.apply(this, args);
    frames.push({ dt: args[0], result });
    return result;
  });
  f.game.paused = true;
  f.game.unbindWorldEvents();
  f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
  f.world._generateSync(2, 0);
  for (const [milliseconds, dt] of [
    [50, 0.05],
    [1000, 0.1],
  ]) {
    const count = frames.length;
    f.frame(milliseconds);
    assert.equal(frames.length, count + 1);
    assert.equal(frames.at(-1).dt, dt);
    assert.equal(frames.at(-1).result.ok, true);
    assert.ok(frames.at(-1).result.scanned <= 1);
    assert.ok(f.service.diagnostics().resident.columns <= 2);
    assert.equal(f.service.index.columns.has("0,0"), false);
  }
  assert.deepEqual(f.service.serialize(), ledger);
  f.game.building = true;
  f.frame();
  assert.equal(frames.length, 2, "loading does not run the maintenance frame");
});

test("actual GameInventoryActions first-open commits exactly ledger plus Settlement before UI reads, preserving a native Unicode map", async (t) => {
  const f = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "mapped",
    seed: "雪".repeat(80),
  });
  const entry = chartEntry(f),
    hit = f.hit(entry.marker),
    order = [];
  f.approachContainer(entry.marker);
  const commits = traceCommits(t, f.coordinator);
  const open = f.service.openContainer,
    read = f.settlement.getContainerState;
  const rolls = t.mock.method(f.service.exploration, "_rollLoot");
  t.mock.method(f.service, "openContainer", function (...args) {
    order.push("exploration");
    return open.apply(this, args);
  });
  t.mock.method(f.settlement, "getContainerState", function (...args) {
    order.push("container-read");
    assert.ok(
      f.service.exploration.container(entry.marker),
      "claim is published BEFORE lazy UI ownership"
    );
    assert.equal(this.inspectContainer(f.world, hit).initialized, true);
    return read.apply(this, args);
  });
  const counters = f.world.generator.counters;
  assert.equal(f.game.inventoryActions.openStation(hit), true);
  assert.deepEqual(order, ["exploration", "container-read"]);
  assert.equal(commits.length, 1);
  assertOwners(commits[0].participants, [f.service.exploration, f.settlement]);
  assert.equal(commits[0].result.ok, true);
  assert.equal(f.calls.uiReads.length, 1);
  assert.equal(rolls.mock.callCount(), 1);
  assert.equal(
    f.world.generator.counters.chunkGenerations,
    counters.chunkGenerations
  );
  assert.ok(
    f.world.generator.counters.surfaceQueries - counters.surfaceQueries <=
      entry.declaration.mapTarget.search.maxSamples
  );
  assert.equal(f.service.diagnostics().mapSearches, 1);
  const raw = resolveStructureMapTarget(
    entry.declaration.mapTarget,
    nativeExplorationContext(f.world)
  );
  const resolution = mapResolutionFromStructure(raw, f.context);
  assert.ok(resolution.target);
  const target = selectTreasureMapTarget(
    entry.marker,
    [resolution.target],
    f.context
  );
  const claim = f.service.exploration.container(entry.marker);
  assert.deepEqual(claim.mapTarget, target);
  assert.ok(claim.marker.id.length > 700);
  const slots = f.settlement.inspectContainer(f.world, hit).slots;
  assert.deepEqual(slots, expectedExplorationSlots(entry, f.context, target));
  assert.deepEqual(
    slots.find((stack) => stack?.id === ITEM.TREASURE_MAP).data.mapTarget,
    target
  );
  assert.deepEqual(f.calls.uiReads[0].state.slots, slots);
  const archive = f.snapshot();
  const normalized = normalizeWorldComponents(
    parseWorldFile(exportWorldFile(archive))
  );
  assert.deepEqual(normalized.exploration, archive.exploration);
  assert.deepEqual(normalized.settlement, archive.settlement);
  assert.equal(f.game.inventoryActions.openStation(hit), true);
  assert.equal(rolls.mock.callCount(), 1);
  assert.equal(f.service.diagnostics().mapSearches, 1);
  assertOwners(commits[1].participants, [f.settlement]);
  assert.deepEqual(f.settlement.inspectContainer(f.world, hit).slots, slots);
});

test("actual first-open adopts initialized archive slots without rerolling or searching their existing map", async (t) => {
  const source = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "mapped",
  });
  const entry = chartEntry(source);
  source.approachContainer(entry.marker);
  assert.equal(
    source.game.inventoryActions.openStation(source.hit(entry.marker)),
    true
  );
  const saved = parseWorldFile(exportWorldFile(source.snapshot()));
  // Model a pre-ledger archive using slots produced by the real first-open
  // transaction, never fixture-granted contents or a synthetic successful roll.
  delete saved.exploration;
  const f = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "mapped",
    saved,
  });
  f.approachContainer(entry.marker);
  const before = f.settlement.serialize();
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("initialized ownership is adoption only")
  );
  const commits = traceCommits(t, f.coordinator);
  assert.equal(f.game.inventoryActions.openStation(f.hit(entry.marker)), true);
  assertOwners(commits[0].participants, [f.service.exploration, f.settlement]);
  assert.equal(commits.length, 1);
  assert.equal(f.service.exploration.container(entry.marker).claim, "adopted");
  assert.equal(f.service.exploration.container(entry.marker).lootVersion, null);
  assert.equal(f.service.diagnostics().mapSearches, 0);
  assert.deepEqual(f.settlement.serialize(), before);
});

test("first-open budget refusal and missing canonical admission never fall through to a lazy empty chest", async (t) => {
  const f = await nativeExplorationHost(t);
  const entry = firstEntry(f),
    hit = f.hit(entry.marker),
    blocker = {};
  // The structure origin is not necessarily within reach of its containers.
  const distant = f.ownership();
  assert.equal(f.game.inventoryActions.openStation(hit), false);
  assert.equal(f.calls.uiReads.length, 0);
  assert.deepEqual(f.ownership(), distant);
  f.approachContainer(entry.marker);
  assert.equal(
    f.coordinator.register(
      blocker,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  try {
    const before = f.ownership();
    assert.equal(f.game.inventoryActions.openStation(hit), false);
    assert.equal(f.calls.uiReads.length, 0);
    assert.equal(f.service.exploration.container(entry.marker), null);
    assert.equal(
      f.settlement.inspectContainer(f.world, hit).initialized,
      false
    );
    assert.deepEqual(f.ownership(), before);
  } finally {
    f.coordinator.release(blocker);
  }
  const chunk = f.world.chunks.get(
    `${Math.floor(hit.x / 16)},${Math.floor(hit.z / 16)}`
  );
  const structures = chunk.structures;
  try {
    // Adversarial admission packet, not a fake generator or a successful discovery.
    chunk.structures = [];
    f.service.index.reset();
    const before = f.ownership();
    assert.equal(f.game.inventoryActions.openStation(hit), false);
    assert.equal(f.calls.uiReads.length, 0);
    assert.equal(
      f.settlement.inspectContainer(f.world, hit).initialized,
      false
    );
    assert.deepEqual(f.ownership(), before);
  } finally {
    chunk.structures = structures;
  }
  assert.equal(
    f.service.onChunkAdmitted(f.world, explorationAdmission(f.world, chunk)),
    true
  );
  assert.equal(f.game.inventoryActions.openStation(hit), true);
});

test("actual GameHarvestActions first-break owns five participants, retains native map loot and pays the tool once", async (t) => {
  const f = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "mapped",
  });
  const held = holdExplorationTool(f),
    entry = chartEntry(f),
    hit = f.hit(entry.marker);
  const before = f.ownership(),
    exhaustion = f.gameplay.exhaustion;
  const plan = f.game.harvestActions.prepareBreak(hit);
  assert.ok(plan);
  assertOwners(plan.participants, [
    f.service.exploration,
    f.settlement,
    f.world,
    f.overflow,
    f.gameplay,
  ]);
  assert.deepEqual(
    f.ownership(),
    before,
    "preparation cannot consume or publish"
  );
  const raw = resolveStructureMapTarget(
    entry.declaration.mapTarget,
    nativeExplorationContext(f.world)
  );
  const resolution = mapResolutionFromStructure(raw, f.context);
  assert.ok(resolution.target);
  const target = selectTreasureMapTarget(
    entry.marker,
    [resolution.target],
    f.context
  );
  const expected = [
    ...chestDrops(f),
    ...expectedExplorationSlots(entry, f.context, target).filter(Boolean),
  ];
  assert.deepEqual(itemTotals(plan.result.drops), itemTotals(expected));
  assert.equal(f.game.harvestActions.commit(plan).ok, true);
  assert.equal(f.world.get(hit.x, hit.y, hit.z), BLOCK.AIR);
  assert.equal(f.service.exploration.container(entry.marker).claim, "break");
  assert.equal(
    f.service.exploration.container(entry.marker).state,
    "destroyed"
  );
  assert.deepEqual(
    f.service.exploration.container(entry.marker).mapTarget,
    target
  );
  assert.equal(f.settlement.serialize().chests.length, 0);
  assert.deepEqual(itemTotals(looseStacks(f)), itemTotals(expected));
  assert.deepEqual(
    looseStacks(f).find((stack) => stack.id === ITEM.TREASURE_MAP).data
      .mapTarget,
    target
  );
  assert.deepEqual(f.gameplay.getHandStack(), {
    ...held,
    durability: held.durability - 1,
  });
  assert.equal(f.gameplay.exhaustion, exhaustion + 0.025);
  assert.equal(f.orbs.size, 0);
  const committed = f.ownership();
  assert.equal(f.game.harvestActions.commit(plan).ok, false);
  assert.equal(f.game.harvestActions.break(hit).ok, false);
  assert.deepEqual(f.ownership(), committed);
});

test("a real full retained-drop destination refuses first-break without losing the block, contents, claim or hand", async (t) => {
  const f = await nativeExplorationHost(t, { maxEntries: 1 });
  holdExplorationTool(f);
  const entry = firstEntry(f),
    hit = f.hit(entry.marker);
  assert.ok(
    expectedExplorationSlots(entry, f.context).filter(Boolean).length > 1
  );
  const before = f.ownership();
  assert.equal(f.game.harvestActions.break(hit).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.service.exploration.container(entry.marker), null);
  assert.equal(f.settlement.inspectContainer(f.world, hit).initialized, false);
});

for (const changed of ["hand", "world", "settlement", "service"]) {
  test(`parent first-break rejects stale ${changed} ownership with no second destination or partial loot`, async (t) => {
    const f = await nativeExplorationHost(t);
    holdExplorationTool(f);
    const entry = firstEntry(f),
      plan = f.game.harvestActions.prepareBreak(f.hit(entry.marker));
    assert.ok(plan);
    assertOwners(plan.participants, [
      f.service.exploration,
      f.settlement,
      f.world,
      f.overflow,
      f.gameplay,
    ]);
    if (changed === "hand") f.gameplay.select(1);
    else if (changed === "world") f.world.setDimension("nether");
    else if (changed === "settlement") {
      const other = f
        .entries()
        .find(({ marker }) => marker.id !== entry.marker.id);
      const empty = f.settlement.prepareContainers(f.world, [
        {
          hit: f.hit(other.marker),
          action: "initialize",
          expectedInitialized: false,
          stacks: [],
        },
      ]);
      assert.ok(empty);
      assert.equal(f.coordinator.commit(empty.participants).ok, true);
    } else {
      assert.equal(f.service.dispose(), true);
    }
    const before = f.ownership();
    assert.equal(f.game.harvestActions.commit(plan).ok, false);
    assert.deepEqual(f.ownership(), before);
    assert.deepEqual(looseStacks(f), []);
  });
}

test("per-block native dungeon explosion conserves every accepted block and chest while a budget-refused chest remains wholly owned", async (t) => {
  const f = await nativeExplorationHost(t, { kind: "dungeon" });
  holdExplorationTool(f);
  const random = () => 0.5;
  f.gameplay.random = random; // Deterministic block loot only; native terrain is untouched.
  const entries = f.entries();
  assert.equal(entries.length, 2);
  const refusedHit = f.hit(entries[0].marker),
    acceptedEntry = entries[1];
  const center = {
    ...f.descriptor.origin,
    x: f.descriptor.origin.x + 0.5,
    y: f.descriptor.origin.y + 1.5,
    z: f.descriptor.origin.z + 0.5,
  };
  const attempts = [],
    commit = f.game.harvestActions.commit;
  const player = f.gameplay.serialize(),
    blocker = {};
  t.mock.method(f.game.harvestActions, "commit", function (plan) {
    const refused = key(plan.result.hit) === key(refusedHit);
    const before = refused ? f.ownership() : null;
    if (refused)
      assert.equal(
        f.coordinator.register(
          blocker,
          MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
        ),
        true
      );
    let result;
    try {
      result = commit.call(this, plan);
    } finally {
      if (refused) f.coordinator.release(blocker);
    }
    attempts.push({ plan, result });
    if (refused) {
      assert.equal(
        result.ok,
        false,
        "the real aggregate budget must veto this whole block"
      );
      assert.deepEqual(f.ownership(), before);
    }
    return result;
  });
  const changed = f.game.harvestActions.explode(center, 4);
  assert.ok(changed.some((hit) => hit.id !== BLOCK.CHEST));
  assert.equal(changed.filter((hit) => hit.id === BLOCK.CHEST).length, 1);
  assert.equal(attempts.filter(({ result }) => !result.ok).length, 1);
  assert.equal(
    attempts.filter(({ result }) => result.ok).length,
    changed.length
  );
  for (const { plan } of attempts.filter(
    ({ plan }) => plan.result.hit.id === BLOCK.CHEST
  ))
    assertOwners(plan.participants, [
      f.service.exploration,
      f.settlement,
      f.world,
      f.overflow,
    ]);
  const expected = [
    ...changed.flatMap((hit) =>
      harvestDrops(hit.id, {
        mode: "survival",
        context: f.context,
        explosion: true,
        random,
      })
    ),
    ...expectedExplorationSlots(acceptedEntry, f.context).filter(Boolean),
  ];
  assert.deepEqual(itemTotals(looseStacks(f)), itemTotals(expected));
  assert.equal(
    f.world.get(refusedHit.x, refusedHit.y, refusedHit.z),
    BLOCK.CHEST
  );
  assert.equal(
    f.settlement.inspectContainer(f.world, refusedHit).initialized,
    false
  );
  assert.equal(f.service.exploration.container(entries[0].marker), null);
  assert.equal(
    f.service.exploration.container(acceptedEntry.marker).state,
    "destroyed"
  );
  assert.deepEqual(
    f.gameplay.serialize(),
    player,
    "explosions never spend the held tool"
  );
  assert.deepEqual(
    f.service.serialize().exploration.encounters,
    [],
    "breaking terrain is not encounter completion"
  );
});

test("emptied native map chest stays consumed through actual open, break, paid replacement and owner reload", async (t) => {
  const f = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "mapped",
  });
  const held = holdExplorationTool(f),
    entry = chartEntry(f),
    hit = f.hit(entry.marker);
  f.approachContainer(entry.marker);
  assert.equal(f.game.inventoryActions.openStation(hit), true);
  const original = f.settlement.inspectContainer(f.world, hit).slots;
  const claim = f.service.exploration.container(entry.marker);
  for (const [index, stack] of original.entries())
    if (stack)
      assert.equal(
        f.settlement.containerAction(f.world, hit, f.gameplay, {
          type: "quickMove",
          area: "container",
          index,
        }).ok,
        true
      );
  assert.deepEqual(
    itemTotals(f.gameplay.getState().slots),
    itemTotals([held, ...original.filter(Boolean)])
  );
  assert.ok(
    f.settlement
      .inspectContainer(f.world, hit)
      .slots.every((slot) => slot === null)
  );
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("an emptied or replaced chest cannot reroll")
  );
  assert.equal(f.game.inventoryActions.openStation(hit), true);
  assert.deepEqual(f.service.exploration.container(entry.marker), claim);
  assert.equal(f.game.harvestActions.break(hit).ok, true);
  assert.deepEqual(itemTotals(looseStacks(f)), itemTotals(chestDrops(f)));
  assert.equal(f.gameplay.getHandStack().durability, held.durability - 1);
  // Recover the actual paid-out block, then spend that same item in a joint
  // Gameplay + World placement. No replacement block is granted by the fixture.
  const index = Array.from({ length: f.pickups.size }, (_, i) => i).find(
    (i) => f.pickups.getStack(i)?.id === BLOCK.CHEST
  );
  assert.notEqual(index, undefined);
  const take = f.pickups.prepareTake(index);
  const receive = f.gameplay.prepareAddStack(take.stack);
  assert.ok(receive);
  assert.equal(f.coordinator.commit([take.participant, receive]).ok, true);
  const equip = f.gameplay.prepareInventory((owned) => {
    const slot = owned.slots.findIndex((stack) => stack?.id === BLOCK.CHEST);
    assert.ok(slot >= 0);
    [owned.slots[0], owned.slots[slot]] = [owned.slots[slot], owned.slots[0]];
    return true;
  });
  assert.equal(f.coordinator.commit([equip]).ok, true);
  const pay = f.gameplay.prepareHandCost("main", { count: 1 });
  const place = f.world.prepareMutation([
    {
      x: hit.x,
      y: hit.y,
      z: hit.z,
      before: f.world.getCell(hit.x, hit.y, hit.z),
      after: { id: BLOCK.CHEST },
    },
  ]);
  assert.ok(pay && place);
  assert.equal(f.coordinator.commit([pay, place]).ok, true);
  assert.deepEqual(looseStacks(f), []);
  assert.equal(f.game.inventoryActions.openStation(f.hit(entry.marker)), true);
  assert.ok(
    f.settlement
      .inspectContainer(f.world, f.hit(entry.marker))
      .slots.every((slot) => slot === null)
  );
  const destroyed = f.service.exploration.container(entry.marker);
  assert.equal(destroyed.state, "destroyed");
  assert.deepEqual(destroyed.mapTarget, claim.mapTarget);
  const saved = normalizeWorldComponents(
    parseWorldFile(exportWorldFile(f.snapshot()))
  );
  const restored = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "mapped",
    saved,
  });
  t.mock.method(restored.service.exploration, "_rollLoot", () =>
    assert.fail("a restored claim cannot reroll")
  );
  restored.approachContainer(entry.marker);
  assert.equal(
    restored.game.inventoryActions.openStation(restored.hit(entry.marker)),
    true
  );
  assert.equal(restored.service.diagnostics().mapSearches, 0);
  assert.deepEqual(
    restored.service.exploration.container(entry.marker),
    destroyed
  );
  assert.deepEqual(restored.gameplay.serialize(), saved.gameplay);
  assert.deepEqual(restored.settlement.serialize(), saved.settlement);
  assert.deepEqual(
    restored.gameplay
      .getState()
      .slots.find((stack) => stack?.id === ITEM.TREASURE_MAP).data.mapTarget,
    claim.mapTarget
  );
});

test("actual first-open persists an explicit null map destination across archive and replay, without another search", async (t) => {
  const f = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "unmapped",
  });
  const entry = chartEntry(f);
  f.approachContainer(entry.marker);
  assert.equal(f.game.inventoryActions.openStation(f.hit(entry.marker)), true);
  const claim = f.service.exploration.container(entry.marker);
  assert.equal(Object.hasOwn(claim, "mapTarget"), true);
  assert.equal(claim.mapTarget, null);
  const slots = f.settlement.inspectContainer(
    f.world,
    f.hit(entry.marker)
  ).slots;
  assert.deepEqual(slots, expectedExplorationSlots(entry, f.context, null));
  assert.equal(
    slots.some((stack) => stack?.id === ITEM.TREASURE_MAP),
    false
  );
  const saved = normalizeWorldComponents(
    parseWorldFile(exportWorldFile(f.snapshot()))
  );
  const restored = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "unmapped",
    saved,
  });
  t.mock.method(restored.service.exploration, "_rollLoot", () =>
    assert.fail("null destination is final")
  );
  restored.approachContainer(entry.marker);
  assert.equal(
    restored.game.inventoryActions.openStation(restored.hit(entry.marker)),
    true
  );
  assert.deepEqual(restored.service.exploration.container(entry.marker), claim);
  assert.equal(restored.service.diagnostics().mapSearches, 0);
  assert.deepEqual(
    restored.settlement.inspectContainer(
      restored.world,
      restored.hit(entry.marker)
    ).slots,
    slots
  );
});

test("real GameTravel and Game.prepareWorld preserve current/inactive claims, exact slots and map metadata", async (t) => {
  const f = await nativeExplorationHost(t, {
    kind: "shipwreck",
    variant: "mapped",
  });
  const entry = chartEntry(f),
    service = f.service,
    ledger = service.exploration;
  f.approachContainer(entry.marker);
  assert.equal(f.game.inventoryActions.openStation(f.hit(entry.marker)), true);
  const overworldClaim = ledger.container(entry.marker);
  const overworldSlots = f.settlement.inspectContainer(
    f.world,
    f.hit(entry.marker)
  ).slots;
  // Bare real native locator for the destination dimension; no voxels or loot
  // are authored, and the World we actually travel in remains the same owner.
  const locator = new World(f.world.seed, {
    generatorVersion: 4,
    dimension: "nether",
    useWorker: false,
  });
  let fortress;
  try {
    fortress = nativeExplorationSite(locator, "nether_fortress");
  } finally {
    locator.dispose();
  }
  const epoch = f.world.epoch;
  const destination = { ...fortress.entries[0], dimension: "nether" };
  assert.equal((await f.game.teleport(destination)).ok, true);
  assert.equal(f.world.dimension, "nether");
  assert.ok(f.world.epoch > epoch);
  assert.equal(f.game.explorationServices, service);
  assert.equal(f.game.exploration, ledger);
  assert.deepEqual(ledger.container(entry.marker), overworldClaim);
  await admitNativeStructure(f.world, fortress);
  const nether = service.index
    .list("container")
    .find(({ marker }) => marker.structureId === fortress.id);
  assert.ok(nether);
  f.game.paused = false;
  f.player.enabled = true;
  f.approachContainer(nether.marker);
  assert.equal(f.game.inventoryActions.openStation(f.hit(nether.marker)), true);
  const netherClaim = ledger.container(nether.marker);
  const saved = normalizeWorldComponents(
    parseWorldFile(exportWorldFile(f.snapshot()))
  );
  assert.deepEqual(
    new Set(saved.exploration.containers.map(({ marker }) => marker.dimension)),
    new Set(["overworld", "nether"])
  );
  assert.equal(saved.exploration.containers.length, 2);
  const original = structuredClone(saved.exploration);
  const staged = await f.game.prepareWorld(saved.world.seed, saved);
  let restored;
  try {
    assert.equal(staged.explorationServices.active, false);
    assert.deepEqual(
      staged.explorationServices.serialize().exploration,
      saved.exploration
    );
    assert.deepEqual(staged.settlement.serialize(), saved.settlement);
    restored = hostFromExplorationStage(t, staged, { saved });
    t.mock.method(restored.service.exploration, "_rollLoot", () =>
      assert.fail("travel/reload cannot roll either saved claim")
    );
    restored.approachContainer(nether.marker);
    assert.equal(
      restored.game.inventoryActions.openStation(restored.hit(nether.marker)),
      true
    );
    assert.deepEqual(
      restored.service.exploration.container(nether.marker),
      netherClaim
    );
    const back = { ...f.descriptor.entries[0], dimension: "overworld" };
    const returned = await restored.game.teleport(back);
    assert.equal(returned.ok, true, JSON.stringify({
      destination: back,
      dimension: restored.world.dimension,
      message: returned.message,
      rollbackFailed: returned.rollbackFailed,
      observerErrors: returned.observerErrors?.map((error) => error.message),
    }));
    await admitNativeStructure(restored.world, f.descriptor);
    restored.game.paused = false;
    restored.player.enabled = true;
    restored.approachContainer(entry.marker);
    assert.equal(
      restored.game.inventoryActions.openStation(restored.hit(entry.marker)),
      true
    );
    assert.deepEqual(
      restored.service.exploration.container(entry.marker),
      overworldClaim
    );
    assert.deepEqual(
      restored.settlement.inspectContainer(
        restored.world,
        restored.hit(entry.marker)
      ).slots,
      overworldSlots
    );
    assert.deepEqual(
      restored.service.exploration.container(nether.marker),
      netherClaim
    );
    assert.equal(restored.service.diagnostics().mapSearches, 0);
    assert.deepEqual(saved.exploration, original);
    assert.equal(
      restored.calls.archives.length,
      1,
      "travel saves through the real archive to memory only"
    );
  } finally {
    if (restored) restored.dispose();
    else disposeExplorationStage(staged);
  }
});
