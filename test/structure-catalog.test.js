import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import {
  createStructureDecorators,
  describeStructure,
  getStructureMarkers,
  STRUCTURE_CONTENT_REQUIREMENTS,
  STRUCTURE_KINDS,
  STRUCTURE_LIMITS,
  STRUCTURE_REQUIRED_CONTENT,
} from "../src/structure-catalog.js";
import { requireStructureContent } from "../src/structure-content.js";
import {
  createStructureSite,
  selectStructureKind,
} from "../src/structure-placement.js";
import {
  authoredColumn,
  authoredContext,
  insideStructureBounds,
  namedStructureCells,
  structureFixture,
} from "./structure-fixtures.js";

for (const kind of STRUCTURE_KINDS) {
  test(`authored ${kind} descriptors and named layouts are detached, deterministic and owner-stable`, () => {
    const fixture = structureFixture(kind);
    const { context, descriptor, gx, gz, calls } = fixture;
    const before = structuredClone(descriptor);
    const first = namedStructureCells(descriptor);
    describeStructure(kind, context, gx + 1, gz - 1);
    const repeat = describeStructure(kind, { ...context }, gx, gz);
    assert.deepEqual(repeat, before);
    assert.deepEqual(namedStructureCells(repeat).cells, first.cells);
    assert.deepEqual(descriptor, before);
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(Object.isFrozen(descriptor.markers));
    calls.samples = 0;
    describeStructure(kind, context, gx, gz);
    assert.ok(calls.samples <= STRUCTURE_LIMITS.describeSamples);
    assert.ok(descriptor.bounds.minX < 0 && descriptor.bounds.minZ < 0);
    assert.ok(descriptor.bounds.minX >= gx * STRUCTURE_LIMITS.spacing);
    assert.ok(descriptor.bounds.maxX <= (gx + 1) * STRUCTURE_LIMITS.spacing);
    for (const entry of descriptor.entries)
      assert.ok(
        insideStructureBounds(descriptor.bounds, entry.x, entry.y, entry.z)
      );
    const markers = getStructureMarkers(descriptor);
    assert.equal(new Set(markers.map((m) => m.id)).size, markers.length);
    for (const marker of markers) {
      assert.equal(marker.structureId, descriptor.id);
      assert.equal(marker.dimension, descriptor.dimension);
      assert.equal(marker.id, `${descriptor.id}/${marker.type}/${marker.key}`);
      for (const field of ["slots", "inventory", "items", "loot"])
        assert.equal(Object.hasOwn(marker, field), false);
    }
    if (markers.length) markers[0].position.x++;
    assert.deepEqual(
      descriptor,
      before,
      "a caller cannot mutate the canonical declarations"
    );
  });
}

test("authored owner cells select at most one surface site across all decorators", () => {
  for (const biome of [
    "village",
    "shipwreck",
    "ocean_monument",
    "buried_treasure",
    "nether_fortress",
  ]) {
    const { context } = authoredContext(biome, `authored-ownership-${biome}`);
    for (const [gx, gz] of [
      [-1, -1],
      [0, 0],
      [-2, 3],
      [4, -5],
    ]) {
      const descriptions = STRUCTURE_KINDS.flatMap((kind) => {
        const descriptor = describeStructure(kind, context, gx, gz);
        return descriptor ? [descriptor] : [];
      });
      assert.ok(descriptions.length <= 1);
      if (descriptions.length)
        assert.equal(
          selectStructureKind(createStructureSite(context, gx, gz)),
          descriptions[0].kind
        );
    }
  }
});

test("authored canonical marker filtering partitions anchors without adding new identities", () => {
  const { descriptor } = structureFixture("village");
  const { bounds } = descriptor;
  const mid = Math.floor((bounds.minX + bounds.maxX) / 2);
  const left = getStructureMarkers(descriptor, {
    bounds: { ...bounds, maxX: mid },
  });
  const right = getStructureMarkers(descriptor, {
    bounds: { ...bounds, minX: mid },
  });
  assert.deepEqual(
    [...left, ...right].map((m) => m.id).sort(),
    getStructureMarkers(descriptor)
      .map((m) => m.id)
      .sort()
  );
  assert.deepEqual(
    getStructureMarkers(structuredClone(descriptor)),
    getStructureMarkers(descriptor),
    "re-ingested or clipped descriptors retain ledger keys, not fresh reward identities"
  );
});

test("structure registration reports missing semantic names and rejects silent aliases/metadata", () => {
  const missing = { ...BLOCK };
  delete missing.GOLD_BLOCK;
  delete missing.NETHER_BRICKS;
  assert.throws(
    () =>
      requireStructureContent(["GOLD_BLOCK", "NETHER_BRICKS"], missing, BLOCKS),
    (error) =>
      error.message.includes("GOLD_BLOCK") &&
      error.message.includes("NETHER_BRICKS")
  );
  assert.throws(
    () =>
      requireStructureContent(
        ["GOLD_BLOCK"],
        { ...BLOCK, GOLD_BLOCK: BLOCK.STONE },
        BLOCKS
      ),
    /own registered ID/
  );
  const bad = {
    ...BLOCKS,
    [BLOCK.OAK_STAIRS]: { ...BLOCKS[BLOCK.OAK_STAIRS], shape: "cube" },
  };
  assert.throws(
    () => requireStructureContent(["OAK_STAIRS"], BLOCK, bad),
    /OAK_STAIRS.shape/
  );
  assert.throws(
    () => requireStructureContent(["NOT_A_STRUCTURE_BLOCK"]),
    /Undeclared/
  );
  assert.deepEqual(
    STRUCTURE_CONTENT_REQUIREMENTS.map((r) => r.name),
    STRUCTURE_REQUIRED_CONTENT
  );
  assert.ok(STRUCTURE_CONTENT_REQUIREMENTS.every((r) => r.properties));
});

test("parent-registered decorators fit the real seam and declare an honest write/sample budget", () => {
  const decorators = createStructureDecorators();
  assert.equal(decorators.length, STRUCTURE_KINDS.length);
  assert.ok(decorators.length <= 8);
  for (const kind of STRUCTURE_KINDS) {
    const { context, descriptor, gx, gz } = structureFixture(kind);
    const decorator = decorators.find(
      (entry) => entry.id === `structure:${kind}:v${descriptor.layoutVersion}`
    );
    assert.deepEqual(decorator.describe({ ...context, gx, gz }), [descriptor]);
    let calls = 0;
    decorator.emit(descriptor, () => {
      calls++;
    });
    assert.equal(calls, namedStructureCells(descriptor).writes);
    assert.ok(calls <= decorator.maxWrites);
    assert.ok(decorator.maxWrites <= 65536 && decorator.maxSamples <= 256);
  }
  assert.throws(
    () => createStructureDecorators({ kinds: ["village", "village"] }),
    /unique/
  );
  assert.throws(
    () => createStructureDecorators({ kinds: ["unknown"] }),
    /Unknown/
  );
});

test("authored invalid dimensions and out-of-world sites remain absent without sampling", () => {
  const { context, calls } = authoredContext("village", "authored-world-edge");
  assert.equal(
    describeStructure("village", { ...context, dimension: "end" }, 0, 0),
    null
  );
  assert.equal(describeStructure("village", context, 1000000, 0), null);
  assert.equal(calls.samples, 0);
  assert.throws(() => describeStructure("village", context, 0.5, 0), /integer/);
  assert.throws(() => describeStructure("unknown", context, 0, 0), /Unknown/);
  const absent = { ...context, sampleColumn: () => null };
  assert.equal(describeStructure("village", absent, -1, -1), null);
  const voidField = {
    ...context,
    sampleColumn: () => authoredColumn("village", { top: null, landTop: null }),
  };
  assert.equal(describeStructure("village", voidField, -1, -1), null);
});
