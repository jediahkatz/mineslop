import assert from "node:assert/strict";
import test from "node:test";
import {
  explorationMarkerFromStructure,
  memberIdentity,
  normalizeExplorationMarker,
  selectTreasureMapTarget,
  structureIdentity,
} from "../src/exploration-markers.js";
import { isValidStack } from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import {
  getLootTable,
  LOOT_ACQUISITION,
  LOOT_TABLES,
  lootNeedsMap,
  MAX_LOOT_STACKS,
  rollLootTable,
  rollStructureLoot,
} from "../src/loot-tables.js";
import {
  MissingProgressionItemsError,
  progressionStack,
  requireProgressionItems,
} from "../src/progression-items.js";
import {
  progressionContext,
  structureMarker,
} from "./exploration-ledger-fixture.js";

function destination(context, id = "fixture:buried-treasure", x = 40) {
  return {
    id,
    seed: context.seed,
    generatorVersion: context.generatorVersion,
    kind: "buried_treasure",
    dimension: "overworld",
    origin: { x, y: -20, z: -8 },
  };
}

test("structure and member identities are contextual, stable and collision-free by composition", () => {
  const context = progressionContext();
  const marker = structureMarker();
  assert.equal(
    memberIdentity(marker, context),
    memberIdentity(structuredClone(marker), progressionContext())
  );
  const keys = [
    memberIdentity(marker, context),
    memberIdentity(
      structureMarker("shipwreck_treasure", { key: "treasure" }),
      context
    ),
    memberIdentity(
      structureMarker("shipwreck_supply", { key: "second" }),
      context
    ),
    memberIdentity(
      structureMarker("shipwreck_supply", { structureId: "fixture:other" }),
      context
    ),
    memberIdentity(marker, progressionContext("another-seed")),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.notEqual(
    structureIdentity(
      { id: marker.structureId, dimension: "overworld" },
      context
    ),
    structureIdentity({ id: marker.structureId, dimension: "nether" }, context)
  );
  assert.throws(() =>
    normalizeExplorationMarker({ ...marker, id: "wrong" }, context)
  );
  assert.deepEqual(
    explorationMarkerFromStructure(
      {
        id: marker.structureId,
        dimension: marker.dimension,
        seed: context.seed,
      },
      { ...marker, extraGeneratorDetail: true },
      context
    ),
    marker
  );
});

test("every authored role rolls deterministically into real bounded canonical stacks", () => {
  // Parent must register real required resources before authorizing this suite.
  requireProgressionItems(Object.keys(LOOT_ACQUISITION));
  const context = progressionContext();
  for (const role of Object.keys(LOOT_TABLES)) {
    const marker = structureMarker(role);
    const options = lootNeedsMap(role)
      ? {
          mapTarget: selectTreasureMapTarget(
            marker,
            [destination(context)],
            context
          ),
        }
      : {};
    const first = rollStructureLoot(marker, context, options);
    const second = rollStructureLoot(
      structuredClone(marker),
      context,
      structuredClone(options)
    );
    assert.deepEqual(first, second);
    assert.ok(first.length > 0 && first.length <= MAX_LOOT_STACKS);
    assert.ok(first.every((stack) => isValidStack(stack, context)));
    first[0].count = 0;
    assert.deepEqual(rollStructureLoot(marker, context, options), second);
  }
});

test("buried treasure guarantees one genuine heart of the sea across seeds", () => {
  assert.ok(
    getItem(ITEM.HEART_OF_THE_SEA),
    "Register the real heart-of-the-sea item"
  );
  for (let seed = 0; seed < 12; seed++) {
    const loot = rollStructureLoot(
      structureMarker("buried_treasure"),
      progressionContext(`buried-fixture-${seed}`)
    );
    assert.equal(
      loot
        .filter((stack) => stack.id === ITEM.HEART_OF_THE_SEA)
        .reduce((sum, stack) => sum + stack.count, 0),
      1
    );
  }
});

test("monuments cannot accidentally obtain a chest table", () => {
  assert.equal(getLootTable("ocean_monument"), null);
  assert.throws(
    () =>
      rollStructureLoot(
        structureMarker("ocean_monument"),
        progressionContext()
      ),
    /No chest loot table/
  );
  assert.throws(() =>
    rollStructureLoot(
      structureMarker("shipwreck_supply", { dimension: "nether" }),
      progressionContext()
    )
  );
});

test("treasure targets are stable real contextual descriptors, independent of candidate ordering", () => {
  const context = progressionContext();
  const source = structureMarker("shipwreck_map");
  const near = destination(context, "fixture:near", 20);
  const far = destination(context, "fixture:far", 2000);
  const target = selectTreasureMapTarget(source, [far, near], context);
  assert.deepEqual(
    target,
    selectTreasureMapTarget(source, [near, far], context)
  );
  assert.equal(target.structureId, near.id);
  assert.equal(target.y, -20);
  const map = rollStructureLoot(source, context, { mapTarget: target })[0];
  assert.equal(map.id, ITEM.TREASURE_MAP);
  assert.equal(getItem(map.id).map, true);
  assert.deepEqual(map.data.mapTarget, target);
  target.x = 999;
  assert.equal(map.data.mapTarget.x, near.origin.x);
});

test("missing, foreign, duplicate and out-of-bounds map destinations do not become fake coordinates", () => {
  const context = progressionContext();
  const source = structureMarker("shipwreck_map");
  const valid = destination(context);
  for (const candidates of [
    [],
    [valid, valid],
    [{ ...valid, seed: "other" }],
    [{ ...valid, generatorVersion: 3 }],
    [{ ...valid, dimension: "nether" }],
    [{ ...valid, kind: "village" }],
    [{ ...valid, origin: { ...valid.origin, y: -65 } }],
    [{ ...valid, origin: { ...valid.origin, x: 30_000_000 } }],
  ]) {
    assert.throws(() => selectTreasureMapTarget(source, candidates, context));
  }
  assert.throws(() => rollStructureLoot(source, context));
});

test("unknown symbolic loot refuses the whole table without unrelated replacements", () => {
  const definition = {
    dimension: "overworld",
    rolls: [1, 1],
    guaranteed: [],
    entries: [
      { symbol: "COAL", weight: 1000, min: 1, max: 1 },
      { symbol: "NOT_A_REGISTERED_LOOT_ITEM", weight: 1, min: 1, max: 1 },
    ],
  };
  assert.throws(
    () =>
      rollLootTable(definition, "authored-missing-item", progressionContext()),
    (error) =>
      error instanceof MissingProgressionItemsError &&
      error.requirements[0].symbol === "NOT_A_REGISTERED_LOOT_ITEM"
  );
});

test("an authored empty table is empty, not a signal to roll a fallback table", () => {
  assert.deepEqual(
    rollLootTable(
      {
        dimension: "overworld",
        rolls: [0, 0],
        entries: [],
        guaranteed: [],
      },
      "authored-empty-table",
      progressionContext()
    ),
    []
  );
});

test("bounded table and member normalizers reject malformed fields without invoking getters", () => {
  const context = progressionContext();
  const source = structuredClone(LOOT_TABLES.shipwreck_supply);
  for (const definition of [
    { ...source, rolls: [1, MAX_LOOT_STACKS + 1] },
    { ...source, entries: new Array(33) },
    { ...source, entries: [{ symbol: "COAL", weight: 0, min: 1, max: 1 }] },
    { ...source, entries: [{ symbol: "COAL", weight: 1, min: 1, max: 65 }] },
    {
      ...source,
      entries: [{ symbol: "X".repeat(65), weight: 1, min: 1, max: 1 }],
    },
    {
      ...source,
      entries: [
        { symbol: "COAL", weight: 1, min: 1, max: 1, metadata: "treasure_map" },
      ],
    },
    { ...source, unknown: true },
  ]) {
    assert.throws(() => rollLootTable(definition, "malformed", context));
  }
  const marker = structureMarker();
  Object.defineProperty(marker, "role", {
    enumerable: true,
    get() {
      assert.fail("snapshot accessors must not execute");
    },
  });
  assert.throws(() => normalizeExplorationMarker(marker, context), RangeError);
});

test("map and potion data cannot be attached to ordinary registered placeholder items", () => {
  const context = progressionContext();
  const mapTarget = selectTreasureMapTarget(
    structureMarker("shipwreck_map"),
    [destination(context)],
    context
  );
  assert.throws(() =>
    progressionStack("PAPER", 1, context, {
      version: 1,
      mapTarget,
    })
  );
  assert.throws(() =>
    progressionStack("BOOK", 1, context, {
      version: 1,
      potion: { id: "water_breathing", form: "drinkable" },
    })
  );
});
