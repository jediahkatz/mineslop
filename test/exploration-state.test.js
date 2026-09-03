import assert from "node:assert/strict";
import test from "node:test";
import {
  ExplorationState,
  MAX_EXPLORATION_CONTAINERS,
  normalizeExplorationSnapshot,
} from "../src/exploration-state.js";
import { selectTreasureMapTarget } from "../src/exploration-markers.js";
import { rollStructureLoot } from "../src/loot-tables.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "../src/transactions.js";
import {
  ExplorationDestination,
  progressionContext,
  structureMarker,
  veto,
} from "./exploration-ledger-fixture.js";

function fixture(options = {}) {
  const context = progressionContext();
  const coordinator = new TransactionCoordinator();
  const ledger = new ExplorationState({ context, coordinator, ...options });
  const destination = new ExplorationDestination(coordinator, context);
  const prepareDestination = (claims) => destination.prepare(claims);
  return {
    context,
    coordinator,
    ledger,
    destination,
    options: { prepareDestination, validate: () => true },
  };
}

const amount = (stacks) => stacks.reduce((sum, stack) => sum + stack.count, 0);

test("first-open plans are detached and install ownership plus one claim exactly once", () => {
  const f = fixture();
  const marker = structureMarker();
  const before = [
    f.ledger.serialize(),
    f.destination.view(),
    f.coordinator.budget.totalBytes,
  ];
  const plan = f.ledger.prepareFirstOpen(marker, f.options);
  assert.ok(plan);
  assert.deepEqual(
    [
      f.ledger.serialize(),
      f.destination.view(),
      f.coordinator.budget.totalBytes,
    ],
    before
  );
  assert.equal(f.ledger.commit(plan).ok, true);
  assert.equal(f.ledger.container(marker).state, "materialized");
  assert.equal(f.destination.containers.size, 1);
  assert.equal(f.destination.retained.length, 0);
  assert.equal(f.ledger.prepareFirstOpen(marker, f.options), null);
  assert.equal(f.ledger.commit(plan).ok, false);
  assert.equal(f.destination.revision, 1);
});

test("an empty materialized container is claimed, not uninitialized", () => {
  let rolls = 0;
  const f = fixture({
    rollLoot: () => {
      rolls++;
      return [];
    },
  });
  const marker = structureMarker();
  const plan = f.ledger.prepareFirstOpen(marker, f.options);
  assert.ok(plan);
  assert.deepEqual(f.destination.received[0][0].stacks, []);
  assert.equal(f.ledger.commit(plan).ok, true);
  assert.ok(
    [...f.destination.containers.values()][0].every((stack) => stack === null)
  );
  assert.equal(f.ledger.container(marker).state, "materialized");
  assert.equal(f.ledger.prepareFirstOpen(marker, f.options), null);
  assert.equal(rolls, 1);
});

test("first-break races with first-open atomically and retained loot is never duplicated", () => {
  const f = fixture();
  const marker = structureMarker("shipwreck_treasure");
  const opened = f.ledger.prepareFirstOpen(marker, f.options);
  const broken = f.ledger.prepareFirstBreak(marker, f.options);
  const expected = amount(f.destination.received[1][0].stacks);
  assert.equal(f.ledger.commit(broken).ok, true);
  assert.equal(f.ledger.commit(opened).ok, false);
  assert.equal(f.ledger.container(marker).claim, "break");
  assert.equal(f.ledger.container(marker).state, "destroyed");
  assert.equal(f.destination.containers.size, 0);
  assert.equal(amount(f.destination.retained), expected);
  assert.equal(f.ledger.prepareFirstBreak(marker, f.options), null);
});

test("breaking already-materialized ownership drains actual slots without another loot roll", () => {
  let rolls = 0;
  const f = fixture({
    rollLoot: (...args) => {
      rolls++;
      return rollStructureLoot(...args);
    },
  });
  const marker = structureMarker();
  assert.equal(
    f.ledger.commit(f.ledger.prepareFirstOpen(marker, f.options)).ok,
    true
  );
  const expected = amount(
    [...f.destination.containers.values()][0].filter(Boolean)
  );
  const breakPlan = f.ledger.prepareContainerState(
    marker,
    "destroyed",
    f.options
  );
  assert.deepEqual(f.destination.received.at(-1)[0].stacks, []);
  assert.equal(f.ledger.commit(breakPlan).ok, true);
  assert.equal(rolls, 1);
  assert.equal(amount(f.destination.retained), expected);
  assert.equal(f.destination.containers.size, 0);
});

test("an already-initialized empty legacy container is adopted without a loot or fake map roll", () => {
  const f = fixture({ rollLoot: () => assert.fail("adoption must not roll") });
  const marker = structureMarker("shipwreck_map");
  const legacy = f.destination.prepare([
    {
      marker,
      action: "open",
      firstClaim: true,
      stacks: [],
    },
  ]);
  assert.equal(f.coordinator.commit([legacy]).ok, true);
  const existing = f.destination.prepare([
    {
      marker,
      action: "clear",
      firstClaim: false,
      stacks: [],
    },
  ]);
  const adopted = f.ledger.prepareAdoptContainer(marker, {
    state: "cleared",
    validate: () => true,
    participants: [existing],
  });
  assert.equal(f.ledger.commit(adopted).ok, true);
  assert.equal(f.ledger.container(marker).claim, "adopted");
  assert.equal(f.ledger.container(marker).lootVersion, null);
  assert.equal(f.ledger.container(marker).mapTarget, undefined);
  assert.equal(f.ledger.prepareFirstOpen(marker, f.options), null);
  assert.equal(
    f.ledger.commit(
      f.ledger.prepareContainerState(marker, "destroyed", f.options)
    ).ok,
    true
  );
  assert.equal(f.destination.retained.length, 0);
  assert.ok(normalizeExplorationSnapshot(f.ledger.serialize(), f.context));
});

test("cleared/destroyed and replacement-coordinate tombstones survive import permanently", () => {
  let rolls = 0;
  const f = fixture({
    rollLoot: (...args) => {
      rolls++;
      return rollStructureLoot(...args);
    },
  });
  const marker = structureMarker();
  assert.equal(
    f.ledger.commit(f.ledger.prepareFirstOpen(marker, f.options)).ok,
    true
  );
  assert.equal(
    f.ledger.commit(
      f.ledger.prepareContainerState(marker, "cleared", f.options)
    ).ok,
    true
  );
  const saved = f.ledger.serialize();
  const restored = new ExplorationState({
    context: f.context,
    rollLoot: () => assert.fail("retained marker must not reroll"),
  });
  assert.equal(restored.load(saved), true);
  assert.equal(restored.container(marker).state, "cleared");
  assert.equal(restored.prepareFirstOpen(marker, f.options), null);
  assert.equal(
    f.ledger.commit(
      f.ledger.prepareContainerState(marker, "destroyed", f.options)
    ).ok,
    true
  );
  const replacement = structureMarker("shipwreck_treasure", {
    structureId: "fixture:replacement-structure",
  });
  assert.equal(f.ledger.prepareFirstOpen(replacement, f.options), null);
  assert.equal(
    f.ledger.containerAt(marker.dimension, marker.position).state,
    "destroyed"
  );
  assert.equal(
    rolls,
    1,
    "replacement coordinates do not even request fresh loot"
  );
  assert.equal(restored.load(f.ledger.serialize()), true);
  assert.equal(restored.container(marker).state, "destroyed");
});

test("joint capacity refusal and caller prerequisite failure claim and transfer nothing", () => {
  const f = fixture();
  const marker = structureMarker();
  const blocker = {};
  assert.equal(f.coordinator.register(blocker, MAX_RESERVED_BYTES), true);
  const before = [
    f.ledger.serialize(),
    f.destination.view(),
    f.coordinator.budget.totalBytes,
  ];
  const full = f.ledger.prepareFirstOpen(marker, f.options);
  assert.ok(full);
  assert.equal(f.ledger.commit(full).ok, false);
  assert.deepEqual(
    [
      f.ledger.serialize(),
      f.destination.view(),
      f.coordinator.budget.totalBytes,
    ],
    before
  );
  f.coordinator.release(blocker);
  const rejected = f.ledger.prepareFirstOpen(marker, {
    ...f.options,
    participants: [veto(f.coordinator)],
  });
  assert.ok(rejected);
  assert.equal(f.ledger.commit(rejected).ok, false);
  assert.equal(f.ledger.container(marker), null);
  assert.equal(f.destination.revision, 0);
  f.destination.refuse = true;
  assert.equal(f.ledger.prepareFirstOpen(marker, f.options), null);
  assert.equal(f.ledger.container(marker), null);
});

test("a participant freeing space can fund exploration and retained ownership together", () => {
  const f = fixture();
  const owner = {};
  f.coordinator.register(owner, MAX_RESERVED_BYTES);
  let freed = false;
  const plan = f.ledger.prepareFirstBreak(structureMarker(), {
    ...f.options,
    participants: [
      {
        owner,
        beforeBytes: MAX_RESERVED_BYTES,
        afterBytes: 0,
        validate: () => !freed,
        publish: () => {
          freed = true;
        },
      },
    ],
  });
  assert.ok(plan);
  assert.equal(f.ledger.commit(plan).ok, true);
  assert.equal(freed, true);
  assert.ok(f.destination.retained.length > 0);
});

test("read-revision staleness and same-byte reload invalidate prepared claims", () => {
  const f = fixture();
  let revision = 0;
  const initialRevision = revision;
  const marker = structureMarker();
  const stale = f.ledger.prepareFirstOpen(marker, {
    ...f.options,
    validate: () => revision === initialRevision,
  });
  revision++;
  assert.equal(f.ledger.commit(stale).ok, false);
  const beforeLoad = f.ledger.prepareFirstOpen(marker, f.options);
  assert.equal(f.ledger.load(f.ledger.serialize()), true);
  assert.equal(f.ledger.commit(beforeLoad).ok, false);
  assert.equal(f.ledger.container(marker), null);
  assert.equal(f.destination.revision, 0);
});

test("a bounded batch coalesces the exploration and destination owners only once", () => {
  const f = fixture();
  const supply = structureMarker();
  const treasure = structureMarker("shipwreck_treasure", {
    position: { x: 12 },
  });
  const plan = f.ledger.prepareContainers(
    [
      { marker: supply, action: "open" },
      { marker: treasure, action: "break" },
    ],
    f.options
  );
  assert.equal(plan.participants.length, 2);
  assert.equal(f.ledger.commit(plan).ok, true);
  assert.equal(f.ledger.container(supply).state, "materialized");
  assert.equal(f.ledger.container(treasure).state, "destroyed");
  assert.equal(f.ledger.revision, 1);
  assert.equal(f.destination.revision, 1);
});

test("unique encounter completions retain old progress instead of a killed-ID LRU", () => {
  const f = fixture();
  const markers = Array.from({ length: 260 }, (_, i) =>
    structureMarker("elder_guardian", {
      type: "encounter",
      key: "elder-left",
      structureId: `fixture:authored-monument-${i}`,
      position: { x: i * 4 },
    })
  );
  for (const marker of markers) {
    const plan = f.ledger.prepareEncounterComplete(marker, {
      validate: () => true,
    });
    assert.equal(f.ledger.commit(plan).ok, true);
  }
  assert.equal(f.ledger.completed(markers[0]), true);
  assert.equal(
    f.ledger.prepareEncounterComplete(markers[0], { validate: () => true }),
    null
  );
  const other = structureMarker("elder_guardian", {
    type: "encounter",
    key: "elder-right",
  });
  const rejected = f.ledger.prepareEncounterComplete(other, {
    validate: () => true,
    participants: [veto(f.coordinator)],
  });
  assert.equal(f.ledger.commit(rejected).ok, false);
  assert.equal(f.ledger.completed(other), false);
  const restored = new ExplorationState({ context: f.context });
  assert.equal(restored.load(f.ledger.serialize()), true);
  assert.equal(restored.serialize().encounters.length, markers.length);
  assert.ok(markers.every((marker) => restored.completed(marker)));
});

test("stable treasure-map metadata survives materialization and contextual marker import", () => {
  const f = fixture();
  const marker = structureMarker("shipwreck_map");
  const mapTarget = selectTreasureMapTarget(
    marker,
    [
      {
        id: "fixture:real-locator-contract",
        kind: "buried_treasure",
        seed: f.context.seed,
        generatorVersion: 4,
        dimension: "overworld",
        origin: { x: 48, y: -20, z: 16 },
      },
    ],
    f.context
  );
  const plan = f.ledger.prepareFirstOpen(marker, { ...f.options, mapTarget });
  assert.equal(f.ledger.commit(plan).ok, true);
  const stored = [...f.destination.containers.values()][0].find(
    (stack) => stack?.data?.mapTarget
  );
  assert.deepEqual(stored.data.mapTarget, mapTarget);
  assert.deepEqual(f.ledger.container(marker).mapTarget, mapTarget);
  const normalized = normalizeExplorationSnapshot(
    f.ledger.serialize(),
    f.context
  );
  normalized.containers[0].mapTarget.x++;
  assert.equal(f.ledger.container(marker).mapTarget.x, mapTarget.x);
});

test("incremental reservation matches archived record arrays without serializing the whole ledger", () => {
  const f = fixture();
  const marker = structureMarker();
  const serialize = f.ledger.serialize.bind(f.ledger);
  f.ledger.serialize = () =>
    assert.fail("action must not serialize the whole ledger");
  assert.equal(
    f.ledger.commit(f.ledger.prepareFirstOpen(marker, f.options)).ok,
    true
  );
  const saved = serialize();
  assert.equal(
    f.ledger.reservedBytes,
    encodedBytes(saved.containers) - 2 + encodedBytes(saved.encounters) - 2
  );
});

test("bounded malformed imports leave all prior markers and reservations intact", () => {
  const f = fixture();
  const marker = structureMarker();
  assert.equal(
    f.ledger.commit(f.ledger.prepareFirstBreak(marker, f.options)).ok,
    true
  );
  const saved = f.ledger.serialize();
  const record = saved.containers[0];
  const other = {
    ...structuredClone(record),
    marker: structureMarker("shipwreck_treasure", {
      structureId: "fixture:alias",
    }),
  };
  for (const value of [
    null,
    { ...saved, version: 99 },
    { ...saved, seed: "foreign" },
    { ...saved, unknown: true },
    { ...saved, containers: [record, record] },
    { ...saved, containers: [record, other] },
    { ...saved, containers: [{ ...record, state: "uninitialized" }] },
    { ...saved, containers: new Array(MAX_EXPLORATION_CONTAINERS + 1) },
    { ...saved, encounters: [{ marker, completed: true }] },
  ]) {
    assert.equal(normalizeExplorationSnapshot(value, f.context), null);
    const bytes = f.ledger.reservedBytes;
    assert.equal(f.ledger.load(value), false);
    assert.deepEqual(f.ledger.serialize(), saved);
    assert.equal(f.ledger.reservedBytes, bytes);
  }
  const restored = new ExplorationState({ context: f.context });
  const blocker = {};
  restored.coordinator.register(blocker, MAX_RESERVED_BYTES);
  assert.equal(restored.load(saved), false);
  assert.equal(restored.container(marker), null);
  assert.equal(restored.load(saved, { allowOverBudget: true }), true);
  assert.deepEqual(restored.serialize(), saved);
});

test("inactive-dimension progress survives import and every dimension uses its own bounds", () => {
  const f = fixture();
  const overworld = structureMarker("shipwreck_supply", {
    position: { y: -64 },
  });
  const nether = structureMarker("nether_fortress", { position: { y: 0 } });
  const plan = f.ledger.prepareContainers(
    [
      { marker: overworld, action: "open" },
      { marker: nether, action: "break" },
    ],
    f.options
  );
  assert.equal(f.ledger.commit(plan).ok, true);
  const saved = f.ledger.serialize();
  const restored = new ExplorationState({ context: f.context });
  assert.equal(restored.load(saved), true);
  assert.equal(restored.container(overworld).state, "materialized");
  assert.equal(restored.container(nether).state, "destroyed");
  const invalid = structuredClone(saved);
  invalid.containers.find(
    (record) => record.marker.dimension === "nether"
  ).marker.position.y = -1;
  assert.equal(normalizeExplorationSnapshot(invalid, f.context), null);
});

test("a supplied invalid inactive-dimension specification cannot fall back to permissive bounds", () => {
  const f = fixture();
  const context = {
    ...f.context,
    specForDimension: (dimension) =>
      dimension === "nether" ? null : f.context.specForDimension(dimension),
  };
  assert.throws(() => new ExplorationState({ context }));
  assert.equal(
    normalizeExplorationSnapshot(f.ledger.serialize(), context),
    null
  );
});

test("fatal peer publication errors propagate, never masquerade as a retryable loot rejection", () => {
  const f = fixture();
  const peer = veto(f.coordinator, () => true);
  peer.publish = () => {
    throw new Error("deliberately invalid installation");
  };
  const plan = f.ledger.prepareFirstOpen(structureMarker(), {
    ...f.options,
    participants: [peer],
  });
  assert.throws(() => f.ledger.commit(plan), TransactionInvariantError);
});
