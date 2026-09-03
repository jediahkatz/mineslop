import assert from "node:assert/strict";
import test from "node:test";
import {
  describeStructure,
  getStructureMarkers,
  locateStructure,
  resolveStructureMapTarget,
  STRUCTURE_LIMITS,
  structureTarget,
} from "../src/structure-catalog.js";
import {
  authoredColumn,
  namedStructureCells,
  structureFixture,
} from "./structure-fixtures.js";

function authoredRegionalField(fixture, targetKind) {
  const other = authoredColumn(targetKind);
  return {
    ...fixture.context,
    sampleColumn(x, z) {
      return Math.floor(x / STRUCTURE_LIMITS.spacing) === fixture.gx &&
        Math.floor(z / STRUCTURE_LIMITS.spacing) === fixture.gz
        ? fixture.column
        : other;
    },
    generateChunk() {
      assert.fail("A structure locator must not generate chunks");
    },
    getCaveIntervals() {
      assert.fail("A structure locator must not plan cave voxels");
    },
  };
}

test("authored locator returns a real reproducible descriptor with explicit cell and sample work", (t) => {
  const fixture = structureFixture("village");
  t.mock.method(Math, "random", () =>
    assert.fail("Structure queries must not roll randomness or loot")
  );
  let samples = 0;
  const context = {
    ...fixture.context,
    sampleColumn(x, z) {
      samples++;
      return fixture.context.sampleColumn(x, z);
    },
  };
  const found = locateStructure("village", context, fixture.descriptor.origin, {
    radius: 0,
    maxCells: 1,
    maxSamples: 256,
  });
  assert.deepEqual(found.target, structureTarget(fixture.descriptor));
  assert.equal(found.examinedCells, 1);
  assert.equal(found.sampledColumns, samples);
  assert.ok(samples <= STRUCTURE_LIMITS.describeSamples);
  assert.equal(found.exhausted, false);
  assert.equal(found.complete, true);
  const description = describeStructure(
    "village",
    context,
    found.target.gx,
    found.target.gz
  );
  assert.deepEqual(structureTarget(description), found.target);
});

test("authored locator exhaustion never fabricates a result or exceeds the requested budget", () => {
  const fixture = structureFixture("ocean_monument");
  const samples = locateStructure(
    "ocean_monument",
    fixture.context,
    fixture.descriptor.origin,
    {
      radius: 4,
      maxCells: 20,
      maxSamples: 1,
    }
  );
  assert.deepEqual(samples, {
    target: null,
    examinedCells: 1,
    sampledColumns: 1,
    exhausted: true,
    complete: false,
  });
  const absent = { ...fixture.context, sampleColumn: () => null };
  const cells = locateStructure(
    "ocean_monument",
    absent,
    { x: -1, z: -1 },
    {
      radius: 3,
      maxCells: 5,
      maxSamples: 32,
    }
  );
  assert.equal(cells.target, null);
  assert.equal(cells.examinedCells, 5);
  assert.equal(cells.sampledColumns, 5);
  assert.equal(cells.exhausted, true);
  const complete = locateStructure(
    "ocean_monument",
    absent,
    { x: -1, z: -1 },
    {
      radius: 1,
      maxCells: 9,
      maxSamples: 9,
    }
  );
  assert.equal(complete.complete, true);
  assert.equal(complete.target, null);
  for (const options of [
    { radius: STRUCTURE_LIMITS.locatorRadius + 1 },
    { maxCells: STRUCTURE_LIMITS.locatorCells + 1 },
    { maxSamples: STRUCTURE_LIMITS.locatorSamples + 1 },
    { maxSamples: 0 },
    { maxCells: 0 },
  ])
    assert.throws(
      () => locateStructure("ocean_monument", absent, { x: 0, z: 0 }, options),
      /Locator/
    );
});

test("authored ship chart targets stay stable across emission and resolve only to registered site descriptions", () => {
  const fixture = structureFixture("shipwreck", {
    matches: (d) => d.plan.damage === "whole",
  });
  const context = authoredRegionalField(fixture, "buried_treasure");
  const source = describeStructure(
    "shipwreck",
    context,
    fixture.gx,
    fixture.gz
  );
  const marker = getStructureMarkers(source, { type: "container" }).find(
    (m) => m.role === "map"
  );
  const query = structuredClone(marker.mapTarget);
  assert.equal(query.kind, "buried_treasure");
  assert.equal(query.sourceMarkerId, marker.id);
  const first = resolveStructureMapTarget(query, context);
  assert.ok(first.target);
  assert.equal(first.target.kind, "buried_treasure");
  assert.ok(first.examinedCells <= query.search.maxCells);
  assert.ok(first.sampledColumns <= query.search.maxSamples);
  namedStructureCells(source);
  namedStructureCells(source, {
    ...source.bounds,
    maxX: source.bounds.minX + 1,
  });
  const repeated = resolveStructureMapTarget(marker.mapTarget, context);
  assert.deepEqual(repeated, first);
  assert.deepEqual(marker.mapTarget, query);
  const target = describeStructure(
    "buried_treasure",
    context,
    first.target.gx,
    first.target.gz
  );
  assert.deepEqual(structureTarget(target), first.target);
  assert.deepEqual(getStructureMarkers(target)[0].tableGuarantees, [
    "heart_of_sea",
  ]);
  assert.throws(
    () =>
      resolveStructureMapTarget(query, { ...context, seed: "different-world" }),
    /original seed/
  );
});

test("authored cartographer markers resolve to real submerged monument targets without creating stock", () => {
  const fixture = structureFixture("village");
  const context = authoredRegionalField(fixture, "ocean_monument");
  const source = describeStructure("village", context, fixture.gx, fixture.gz);
  const marker = getStructureMarkers(source, { type: "job_site" }).find(
    (m) => m.profession === "cartographer"
  );
  assert.equal(Object.hasOwn(marker, "stock"), false);
  const result = resolveStructureMapTarget(marker.mapTarget, context);
  assert.ok(result.target);
  const target = describeStructure(
    "ocean_monument",
    context,
    result.target.gx,
    result.target.gz
  );
  assert.equal(target.id, result.target.id);
  assert.ok(target.bounds.maxY <= target.waterLevel - 1);
  assert.equal(getStructureMarkers(target, { type: "encounter" }).length, 3);
  assert.deepEqual(getStructureMarkers(target, { type: "container" }), []);
  const wrongDimension = locateStructure(
    "nether_fortress",
    context,
    marker.position
  );
  assert.equal(wrongDimension.target, null);
  assert.equal(wrongDimension.sampledColumns, 0);
});
