import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  appendQuad,
  createMeshData,
  finishMeshData,
  MeshBudgetError,
} from "../src/mesh-geometry.js";
import {
  disposeBatches,
  geometryBytes,
  selectEmitters,
} from "../src/mesh-palette.js";
import {
  createPartitionedMeshData,
  disposeMeshPartitions,
} from "../src/mesh-partitions.js";
import {
  assertPartLimits,
  assertPartitionGeometryEqual,
  partitionGeometries,
  partitionTotals,
} from "./mesh-partition-fixture.js";

function quad(context, i = 0, batch = "opaque") {
  appendQuad(
    context,
    batch,
    [
      [i, 0, 0],
      [i + 1, 0, 0],
      [i + 1, 1, 0],
      [i, 1, 0],
    ],
    [0, 0, 1],
    [
      [0.1, 0.2],
      [0.8, 0.2],
      [0.8, 0.9],
      [0.1, 0.9],
    ],
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 1],
    ],
    i % 2 ? [1, 0, 1, 0] : [0, 1, 0, 1]
  );
}

test("vertex and byte rollovers preserve every material, attribute and triangle", () => {
  for (const limits of [
    { maxVertices: 12, maxBytes: Infinity },
    { maxVertices: Infinity, maxBytes: 400 },
    { maxVertices: 12, maxBytes: 350 },
  ]) {
    const context = createPartitionedMeshData(limits);
    const baseline = createMeshData();
    const names = [
      "opaque",
      "opaque",
      "foliage",
      "water",
      "glass",
      "berryFoliage",
      "emissive",
    ];
    for (let i = 0; i < 40; i++) {
      quad(context, i, names[i % names.length]);
      quad(baseline, i, names[i % names.length]);
    }
    const result = context.finish();
    const expected = finishMeshData(baseline);
    try {
      assert.ok(result.parts.length > 1);
      assertPartLimits(result, limits);
      assertPartitionGeometryEqual(result, expected);
      const totals = partitionTotals(result);
      assert.equal(totals.vertices, 160);
      assert.equal(totals.indices, 240);
      assert.equal(totals.vertices, context.vertices);
      assert.equal(totals.bytes, context.bytes);
      assert.equal(totals.draws, context.draws);
    } finally {
      context.dispose();
      disposeMeshPartitions(result);
      disposeBatches(expected);
    }
  }
});

test("byte admission includes whole-batch Uint32 index promotion, not just the next quad", () => {
  const vertices = 65536;
  for (const maxBytes of [vertices * 47, Infinity]) {
    const context = createPartitionedMeshData({
      maxVertices: Infinity,
      maxBytes,
    });
    for (let i = 0; i < vertices / 4; i++) quad(context, i);
    const result = context.finish();
    try {
      assertPartLimits(result, { maxVertices: Infinity, maxBytes });
      assert.equal(partitionTotals(result).vertices, vertices);
      assert.equal(partitionTotals(result).bytes, context.bytes);
      if (Number.isFinite(maxBytes)) {
        assert.equal(result.parts.length, 2);
        assert.equal(
          result.parts[0].opaque.getAttribute("position").count,
          vertices - 4
        );
        assert.ok(
          result.parts.every(
            (part) => part.opaque.index.array instanceof Uint16Array
          )
        );
      } else {
        assert.equal(result.parts.length, 1);
        assert.ok(result.parts[0].opaque.index.array instanceof Uint32Array);
      }
    } finally {
      context.dispose();
      disposeMeshPartitions(result);
    }
  }
});

test("byte accounting keeps index widths local to each material in a part", () => {
  const context = createPartitionedMeshData({
    maxVertices: Infinity,
    maxBytes: 65536 * 47,
  });
  for (let i = 0; i < 16384; i++) quad(context, i, i % 2 ? "water" : "opaque");
  const result = context.finish();
  try {
    assert.equal(result.parts.length, 1);
    const geometries = partitionGeometries(result);
    assert.equal(geometries.length, 2);
    assert.ok(
      geometries.every(
        (geometry) => geometry.index.array instanceof Uint16Array
      )
    );
    assert.equal(
      context.bytes,
      geometries.reduce((sum, geometry) => sum + geometryBytes(geometry), 0)
    );
  } finally {
    context.dispose();
    disposeMeshPartitions(result);
  }
});

test("aggregate byte/draw ceilings stop staging and disposal releases all sealed parts exactly once", () => {
  // One quad uses 176 attribute bytes and 12 Uint16 index bytes.
  for (const limits of [{ maxTotalBytes: 376 }, { maxDrawCalls: 2 }]) {
    const context = createPartitionedMeshData({ maxVertices: 4, ...limits });
    quad(context);
    quad(context, 1);
    assert.throws(() => quad(context, 2), MeshBudgetError);
    assert.equal(context.parts.length, 2);
    assert.equal(context.vertices, 8, "a rejected quad never mutates the mesh");
    let disposed = 0;
    for (const geometry of partitionGeometries({ parts: context.parts }))
      geometry.addEventListener("dispose", () => disposed++);
    context.dispose();
    assert.equal(disposed, 2);
    context.dispose();
    assert.equal(disposed, 2);
  }
});

test("empty sections need no buffers, but an indivisible quad must fit its part limits", () => {
  for (const limits of [{ maxVertices: 3 }, { maxBytes: 187 }]) {
    const context = createPartitionedMeshData(limits);
    assert.throws(() => quad(context), MeshBudgetError);
    assert.equal(context.vertices, 0);
    assert.deepEqual(context.finish(), { parts: [] });
    assert.equal(context.bytes, 0);
    assert.equal(context.draws, 0);
    context.dispose();
  }
});

test("finish transfers all buffers and selects emitter metadata only once across partitions", () => {
  const context = createPartitionedMeshData({ maxVertices: 4 });
  context.emitters = Array.from({ length: 15 }, (_, i) => ({
    id: i < 8 ? BLOCK.GLOW_BERRIES : i < 12 ? BLOCK.LAVA : BLOCK.TORCH,
    x: i,
    y: 1,
    z: 0,
  }));
  const selected = selectEmitters(context.emitters);
  for (let i = 0; i < 6; i++)
    quad(context, i, i % 2 ? "emissive" : "berryFoliage");
  const result = context.finish();
  const geometries = partitionGeometries(result);
  let disposed = 0;
  for (const geometry of geometries)
    geometry.addEventListener("dispose", () => disposed++);
  try {
    const emitters = geometries.flatMap(
      (geometry) => geometry.userData.emitters
    );
    assert.deepEqual(
      emitters.sort((a, b) => a.x - b.x),
      selected.sort((a, b) => a.x - b.x)
    );
    context.dispose();
    assert.equal(disposed, 0, "transferred buffers belong to the caller");
  } finally {
    disposeMeshPartitions(result);
  }
  assert.equal(disposed, geometries.length);
  context.dispose();
  assert.equal(disposed, geometries.length);
});
