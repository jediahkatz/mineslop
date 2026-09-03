import assert from "node:assert/strict";
import test from "node:test";
import {
  ExplorationState,
  MAX_EXPLORATION_RECORD_BYTES,
  normalizeExplorationSnapshot,
} from "../src/exploration-state.js";
import {
  explorationMarkerFromStructure,
  mapCandidateFromStructureTarget,
  mapResolutionFromStructure,
  normalizeTreasureMapTarget,
  selectTreasureMapTarget,
} from "../src/exploration-markers.js";
import { isValidStack } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import {
  lootItemSymbols,
  rollLootTable,
  rollStructureLoot,
} from "../src/loot-tables.js";
import {
  MissingProgressionItemsError,
  requireProgressionItems,
} from "../src/progression-items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  describeStructure,
  getStructureMarkers,
  locateStructure,
  STRUCTURE_LIMITS,
  structureTarget,
} from "../src/structure-catalog.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  catalogDescriptor,
  catalogFixture,
  catalogMapSearch,
  emptyClaimFixture,
} from "./progression-marker-fixture.js";

function mapFixture(seed = "catalog-map-雪") {
  const f = catalogFixture("shipwreck", {
    seed,
    matches: (d) => d.plan.damage === "whole",
  });
  const raw = getStructureMarkers(f.descriptor, { type: "container" }).find(
    (m) => m.table === "shipwreck/map"
  );
  const marker = explorationMarkerFromStructure(f.descriptor, raw, f.context);
  const search = catalogMapSearch(f, raw);
  const resolution = mapResolutionFromStructure(search.result, f.context);
  assert.ok(
    resolution.target,
    "The authored regional field must locate real beach treasure"
  );
  const mapTarget = selectTreasureMapTarget(
    marker,
    [resolution.target],
    f.context
  );
  return { ...f, raw, marker, search, resolution, mapTarget };
}

test("actual structureTarget position projects to contextual candidates without searching or claiming", (t) => {
  t.mock.method(Math, "random", () =>
    assert.fail("Catalog projections are deterministic")
  );
  const f = mapFixture();
  const rawTarget = f.search.result.target;
  const described = describeStructure(
    "buried_treasure",
    f.search.terrainContext,
    rawTarget.gx,
    rawTarget.gz
  );
  assert.deepEqual(structureTarget(described), rawTarget);
  assert.equal(rawTarget.origin, undefined);
  assert.equal(rawTarget.seed, undefined);
  const before = structuredClone({ descriptor: f.descriptor, rawTarget });
  const samples = f.calls.samples;
  const candidate = mapCandidateFromStructureTarget(rawTarget, f.context);
  assert.equal(candidate.id, described.id);
  assert.equal(candidate.seed, f.context.seed);
  assert.equal(candidate.generatorVersion, 4);
  assert.deepEqual(candidate.origin, rawTarget.position);
  assert.deepEqual(
    selectTreasureMapTarget(f.marker, [candidate], f.context),
    selectTreasureMapTarget(f.marker, [described], f.context)
  );
  assert.throws(
    () => selectTreasureMapTarget(f.marker, [rawTarget], f.context),
    RangeError
  );
  assert.equal(
    f.calls.samples,
    samples,
    "pure projection must not perform another search"
  );
  assert.deepEqual({ descriptor: f.descriptor, rawTarget }, before);
  candidate.origin.x++;
  assert.equal(rawTarget.position.x, before.rawTarget.position.x);
  for (const value of [f.descriptor, ...getStructureMarkers(f.descriptor)])
    for (const field of ["loot", "slots", "items", "inventory"])
      assert.equal(Object.hasOwn(value, field), false);
});

test("real locator results retain null, exhaustion, completion, work counts and world identity", () => {
  const f = mapFixture();
  const at = f.search.result.target.position;
  const results = [
    locateStructure("buried_treasure", f.search.terrainContext, at, {
      radius: 0,
      maxCells: 1,
      maxSamples: 256,
    }),
    locateStructure("buried_treasure", f.search.terrainContext, at, {
      radius: 1,
      maxCells: 1,
      maxSamples: 256,
    }),
    locateStructure("buried_treasure", f.search.terrainContext, at, {
      radius: 1,
      maxCells: 9,
      maxSamples: 1,
    }),
    locateStructure("buried_treasure", f.terrainContext, f.descriptor.origin, {
      radius: 0,
      maxCells: 1,
      maxSamples: 256,
    }),
  ];
  assert.ok(results[0].target && results[0].complete);
  assert.ok(results[1].target && results[1].exhausted);
  assert.ok(results[2].target === null && results[2].exhausted);
  assert.ok(results[3].target === null && results[3].complete);
  for (const result of results) {
    const projected = mapResolutionFromStructure(result, f.context);
    assert.equal(projected.seed, f.context.seed);
    assert.equal(projected.generatorVersion, 4);
    for (const key of [
      "examinedCells",
      "sampledColumns",
      "exhausted",
      "complete",
    ])
      assert.equal(projected[key], result[key]);
    assert.deepEqual(
      projected.target,
      mapCandidateFromStructureTarget(result.target, f.context)
    );
    if (result.target) assert.equal(projected.target.id, result.target.id);
    else assert.equal(projected.target, null);
  }
  assert.equal(mapCandidateFromStructureTarget(null, f.context), null);
  for (const changed of [
    { ...results[0], complete: false },
    { ...results[0], exhausted: "false" },
    { ...results[0], examinedCells: STRUCTURE_LIMITS.locatorCells + 1 },
    { ...results[0], sampledColumns: -1 },
    { ...results[0], target: undefined },
  ]) {
    assert.throws(
      () => mapResolutionFromStructure(changed, f.context),
      RangeError
    );
  }
});

test("actual target projection rejects foreign seed/version, owner aliases, wrong kinds and coordinates", () => {
  const f = mapFixture("雪".repeat(80));
  const raw = f.search.result.target;
  assert.throws(
    () =>
      mapCandidateFromStructureTarget(
        raw,
        createWorldContext({
          seed: "foreign-world",
          generatorVersion: 4,
        })
      ),
    RangeError
  );
  assert.throws(
    () =>
      mapCandidateFromStructureTarget(
        raw,
        createWorldContext({
          seed: f.context.seed,
          generatorVersion: 3,
        })
      ),
    RangeError
  );
  for (const changed of [
    { ...raw, kind: "ocean_monument" },
    { ...raw, dimension: "nether" },
    { ...raw, layoutVersion: 2 },
    { ...raw, gx: raw.gx + 1 },
    { ...raw, gx: String(raw.gx) },
    { ...raw, id: raw.id.replace("%E9", "%e9") },
    {
      ...raw,
      position: {
        ...raw.position,
        x: raw.position.x + STRUCTURE_LIMITS.spacing,
      },
    },
    { ...raw, position: { ...raw.position, y: -65 } },
  ]) {
    assert.throws(
      () => mapCandidateFromStructureTarget(changed, f.context),
      RangeError
    );
  }
  const monument = catalogFixture("ocean_monument", {
    seed: f.context.seed,
  }).descriptor;
  const monumentCandidate = mapCandidateFromStructureTarget(
    structureTarget(monument),
    f.context
  );
  assert.throws(
    () => selectTreasureMapTarget(f.marker, [monumentCandidate], f.context),
    RangeError
  );
  assert.throws(
    () =>
      normalizeTreasureMapTarget(
        {
          seed: f.context.seed,
          generatorVersion: 4,
          dimension: monument.dimension,
          structureId: monument.id,
          ...monument.origin,
        },
        f.context
      ),
    RangeError
  );
  assert.throws(
    () =>
      selectTreasureMapTarget(
        f.marker,
        [f.resolution.target, f.resolution.target],
        f.context
      ),
    RangeError
  );
});

test("stable treasure selection is independent of candidate order, chunk packets and context instances", () => {
  const f = mapFixture();
  const other = catalogDescriptor(
    "buried_treasure",
    f.search.terrainContext,
    (d) => d.id !== f.search.result.target.id
  );
  const candidate = mapCandidateFromStructureTarget(
    structureTarget(other),
    f.context
  );
  const first = selectTreasureMapTarget(
    f.marker,
    [candidate, f.resolution.target],
    f.context
  );
  const second = selectTreasureMapTarget(
    structuredClone(f.marker),
    [f.resolution.target, candidate],
    createWorldContext({ seed: f.context.seed, generatorVersion: 4 })
  );
  assert.deepEqual(first, second);
  const distance = (position) =>
    (position.x - f.marker.position.x) ** 2 +
    (position.z - f.marker.position.z) ** 2;
  assert.equal(
    distance(first),
    Math.min(distance(candidate.origin), distance(f.mapTarget))
  );
  const repeated = explorationMarkerFromStructure(
    structuredClone(f.descriptor),
    getStructureMarkers(structuredClone(f.descriptor), {
      type: "container",
    }).find((m) => m.key === "chart"),
    f.context
  );
  assert.deepEqual(
    selectTreasureMapTarget(
      repeated,
      [f.resolution.target, candidate],
      f.context
    ),
    first
  );
});

test("an explicitly accepted null lookup stays permanent through empty ownership, clearing and destruction", () => {
  const f = mapFixture();
  const limited = locateStructure(
    "buried_treasure",
    f.search.terrainContext,
    f.descriptor.origin,
    { radius: 12, maxCells: 625, maxSamples: 1 }
  );
  const projected = mapResolutionFromStructure(limited, f.context);
  assert.equal(projected.target, null);
  assert.equal(projected.exhausted, true);
  const claim = emptyClaimFixture(f.context);
  assert.equal(
    claim.ledger.prepareFirstOpen(f.marker, claim.options),
    null,
    "omitted lookup is not explicit absence"
  );
  assert.equal(claim.rolls.length, 0);
  const plan = claim.ledger.prepareFirstOpen(f.marker, {
    ...claim.options,
    mapTarget: projected.target,
  });
  assert.ok(plan);
  assert.equal(claim.rolls[0].options.mapTarget, null);
  assert.equal(claim.ledger.commit(plan).ok, true);
  assert.equal(claim.ledger.container(f.marker).mapTarget, null);
  assert.equal(
    claim.ledger.prepareContainers(
      [
        {
          marker: f.marker,
          action: "break",
          mapTarget: f.mapTarget,
        },
      ],
      claim.options
    ),
    null,
    "later searches cannot rewrite the first claim"
  );
  for (const state of ["cleared", "destroyed"]) {
    assert.equal(
      claim.ledger.commit(
        claim.ledger.prepareContainerState(f.marker, state, claim.options)
      ).ok,
      true
    );
    assert.equal(claim.ledger.container(f.marker).mapTarget, null);
  }
  assert.equal(claim.rolls.length, 1);
  const restored = new ExplorationState({
    context: f.context,
    rollLoot() {
      assert.fail("Persistent null destinations must not reroll");
    },
  });
  assert.equal(restored.load(claim.ledger.serialize()), true);
  assert.equal(restored.container(f.marker).mapTarget, null);
  assert.equal(
    restored.prepareFirstOpen(f.marker, {
      ...claim.options,
      mapTarget: f.mapTarget,
    }),
    null
  );
});

test("maximum Unicode IDs use exact 4-KiB-bounded records without expanding aggregate save capacity", () => {
  const f = mapFixture("雪".repeat(80));
  const claim = emptyClaimFixture(f.context);
  const blocker = {};
  assert.equal(claim.coordinator.register(blocker, MAX_RESERVED_BYTES), true);
  const before = {
    saved: claim.ledger.serialize(),
    destination: structuredClone(claim.destination),
    total: claim.coordinator.budget.totalBytes,
  };
  const plan = claim.ledger.prepareFirstOpen(f.marker, {
    ...claim.options,
    mapTarget: f.mapTarget,
  });
  assert.ok(plan);
  assert.equal(claim.ledger.commit(plan).ok, false);
  assert.deepEqual(
    {
      saved: claim.ledger.serialize(),
      destination: claim.destination,
      total: claim.coordinator.budget.totalBytes,
    },
    before
  );
  const cost = plan.participants.reduce(
    (sum, participant) =>
      sum + participant.afterBytes - participant.beforeBytes,
    0
  );
  assert.ok(cost > 2048 && cost < MAX_RESERVED_BYTES);
  let freed = false;
  const serialize = claim.ledger.serialize.bind(claim.ledger);
  claim.ledger.serialize = () =>
    assert.fail("Action must not serialize the whole ledger");
  const funded = claim.ledger.prepareFirstOpen(f.marker, {
    ...claim.options,
    mapTarget: f.mapTarget,
    participants: [
      {
        owner: blocker,
        beforeBytes: MAX_RESERVED_BYTES,
        afterBytes: MAX_RESERVED_BYTES - cost,
        validate: () => !freed,
        publish() {
          freed = true;
        },
      },
    ],
  });
  assert.ok(funded);
  assert.equal(claim.ledger.commit(funded).ok, true);
  assert.equal(claim.coordinator.budget.totalBytes, MAX_RESERVED_BYTES);
  const saved = serialize();
  const bytes = encodedBytes(saved.containers[0]);
  assert.equal(MAX_EXPLORATION_RECORD_BYTES, 4096);
  assert.ok(bytes > 2048 && bytes <= MAX_EXPLORATION_RECORD_BYTES);
  assert.equal(
    claim.ledger.reservedBytes,
    encodedBytes(saved.containers) - 2 + encodedBytes(saved.encounters) - 2
  );
  assert.equal(
    claim.ledger.reservedBytes,
    claim.coordinator.usage(claim.ledger)
  );
  assert.equal(saved.containers[0].marker.id, f.raw.id);
  assert.equal(
    saved.containers[0].mapTarget.structureId,
    f.search.result.target.id
  );
  assert.deepEqual(normalizeExplorationSnapshot(saved, f.context), saved);
  const restored = new ExplorationState({ context: f.context });
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.container(f.marker).mapTarget, f.mapTarget);
  assert.equal(restored.reservedBytes, claim.ledger.reservedBytes);
});

test("real map metadata retains maximum catalog IDs at the canonical inventory boundary", () => {
  // Parent-owned normalizeMapTarget() must admit full catalog IDs before running.
  // This intentionally fails if the item registry/canonical schema is unfinished.
  requireProgressionItems(lootItemSymbols("shipwreck_map"));
  const f = mapFixture("雪".repeat(80));
  const stacks = rollStructureLoot(f.marker, f.context, {
    mapTarget: f.mapTarget,
  });
  const map = stacks.find((stack) => stack.id === ITEM.TREASURE_MAP);
  assert.ok(map && isValidStack(map, f.context));
  assert.deepEqual(map.data.mapTarget, f.mapTarget);
  assert.ok(map.data.mapTarget.structureId.length > 128);
  assert.equal(map.data.mapTarget.structureId, f.search.result.target.id);
});

test("null destinations never excuse missing required loot resources or substitute unrelated rewards", () => {
  const f = catalogFixture("buried_treasure");
  assert.throws(
    () =>
      rollLootTable(
        {
          dimension: "overworld",
          rolls: [0, 0],
          entries: [],
          guaranteed: [
            {
              symbol: "TREASURE_MAP",
              weight: 1,
              min: 1,
              max: 1,
              metadata: "treasure_map",
            },
            { symbol: "UNREGISTERED_MARKER_REWARD", weight: 1, min: 1, max: 1 },
          ],
        },
        f.descriptor.id,
        f.context,
        { mapTarget: null }
      ),
    (error) =>
      error instanceof MissingProgressionItemsError &&
      error.requirements.some(
        ({ symbol }) => symbol === "UNREGISTERED_MARKER_REWARD"
      )
  );
});
