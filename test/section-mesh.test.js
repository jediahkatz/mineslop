import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { finishMeshData } from "../src/mesh-geometry.js";
import { disposeBatches } from "../src/mesh-palette.js";
import { disposeMeshPartitions } from "../src/mesh-partitions.js";
import { getColumnLighting, snapshotSection } from "../src/mesh-snapshot.js";
import { createRangeMesher } from "../src/resolved-mesh.js";
import { createSectionMeshJob } from "../src/section-mesh.js";
import {
  assertPartLimits,
  assertPartitionGeometryEqual,
  partitionGeometries,
  partitionTotals,
} from "./mesh-partition-fixture.js";
import { authoredColumns, shapeAtlas } from "./shape-fixture.js";

test("section snapshots are detached bounded aprons, with one separately cached column-light input", () => {
  const world = authoredColumns([[0, 0]], [[1, -17, 1, BLOCK.COPPER_BLOCK]]);
  const a = snapshotSection(world, 0, 0, -2);
  const b = snapshotSection(world, 0, 0, 12);
  assert.equal(a.ids.length, b.ids.length);
  assert.equal(a.ids.length, 20 * 20 * 20);
  assert.ok(a.bytes < world.chunks.get("0,0").blocks.byteLength / 2);
  assert.equal(a.lighting, b.lighting);
  assert.equal(getColumnLighting(world, 0, 0), a.lighting);
  world.put(1, -17, 1, BLOCK.STONE);
  assert.equal(a.cellAt(1, -17, 1).id, BLOCK.COPPER_BLOCK);
  assert.notEqual(getColumnLighting(world, 0, 0), a.lighting);
});

test("yielded jobs reject their own edits without acknowledging a newer dirty ticket", () => {
  const world = authoredColumns([[0, 0]], [[1, 0, 1, BLOCK.STONE]]);
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  const ticket = job.stamp.ticket;
  job.step({ maxCells: 1 });
  assert.equal(job.done, false);
  world.put(1, 0, 1, BLOCK.OAK_SLAB);
  assert.notEqual(world.dirtySectionRevisions.get("0,0,0"), ticket);
  assert.equal(job.step({ flush: true }), "stale");
  assert.equal(job.takeResult(), null);
  assert.equal(job.acknowledge(), false);
  assert.equal(world.acknowledgments.length, 0);
  assert.equal(job.snapshotBytes, 0);
  job.dispose();
});

test("neighbor cells and neighbor-only dirty tickets invalidate jobs independently", () => {
  for (const mutate of [
    (world) => world.put(16, 0, 0, BLOCK.OAK_SLAB),
    (world) => world.dirty(0, 0, 0),
    (world) => world.put(0, 16, 0, BLOCK.STONE),
  ]) {
    const world = authoredColumns(
      [
        [0, 0],
        [1, 0],
      ],
      [[15, 0, 0, BLOCK.STONE]]
    );
    const revision = world.chunks.get("0,0").sectionRevisions.get(0);
    const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
    mutate(world);
    assert.equal(world.chunks.get("0,0").sectionRevisions.get(0), revision);
    assert.equal(job.step({ flush: true }), "stale");
    assert.equal(world.acknowledgments.length, 0);
    job.dispose();
  }
});

test("unrelated column/vertical revisions do not invalidate a section-local job", () => {
  const world = authoredColumns(
    [
      [0, 0],
      [2, 0],
    ],
    [[1, 0, 1, BLOCK.STONE]]
  );
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  world.put(32, 0, 0, BLOCK.STONE);
  world.put(0, 160, 0, BLOCK.STONE);
  assert.equal(job.current(), true);
  assert.equal(job.step({ flush: true }), "ready");
  disposeMeshPartitions(job.takeResult());
  job.dispose();
});

test("epoch, incarnation, neighbor readmission and a previously missing neighbor reject old output", () => {
  for (const mutate of [
    (world) => {
      world.epoch++;
    },
    (world) => {
      world.dimension = "nether";
    },
    (world) => {
      world.admit(0, 0);
    },
    (world) => {
      world.admit(1, 0);
    },
    (world) => {
      world.admit(-1, 0);
    },
  ]) {
    const world = authoredColumns(
      [
        [0, 0],
        [1, 0],
      ],
      [[1, 0, 1, BLOCK.STONE]]
    );
    const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
    mutate(world);
    assert.equal(job.step({ flush: true }), "stale");
    assert.equal(job.takeResult(), null);
    job.dispose();
  }
});

test("a final stale check rejects changes made during assembly or after the result became ready", () => {
  const world = authoredColumns([[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  let changed = false;
  const during = createSectionMeshJob(world, 0, 0, 0, {
    uvFor() {
      if (!changed) {
        changed = true;
        world.put(0, 0, 0, BLOCK.OAK_SLAB);
      }
      return [0, 0, 1, 1];
    },
  });
  assert.equal(during.step({ flush: true }), "stale");
  assert.equal(during.result, null);
  const after = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  assert.equal(after.step({ flush: true }), "ready");
  world.dirty(0, 0, 0);
  assert.equal(after.takeResult(), null);
  assert.equal(after.status, "stale");
  assert.equal(world.acknowledgments.length, 0);
  during.dispose();
  after.dispose();
});

test("acknowledgments clear exactly the installed section ticket, never adjacent work", () => {
  const world = authoredColumns([[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  const count = world.dirtySectionRevisions.size;
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  const ticket = job.stamp.ticket;
  job.step({ flush: true });
  assert.equal(job.acknowledge(), false, "ready buffers are not yet installed");
  const geometry = job.takeResult();
  assert.equal(job.acknowledge(), true);
  assert.equal(world.dirtySectionRevisions.size, count - 1);
  assert.equal(world.dirtySectionRevisions.has("0,0,1"), true);
  assert.deepEqual(world.acknowledgments, [{ cx: 0, cz: 0, sy: 0, ticket }]);
  disposeMeshPartitions(geometry);
  job.dispose();
});

test("a newer dirty ticket between transfer and acknowledgement survives", () => {
  const world = authoredColumns([[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  job.step({ flush: true });
  const geometry = job.takeResult();
  const newer = world.dirty(0, 0, 0);
  assert.equal(job.acknowledge(), false);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), newer);
  disposeMeshPartitions(geometry);
  job.dispose();
});

test("impossibly small part limits reject before allocating buffers or clearing work", (t) => {
  const world = authoredColumns([[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  const vertices = createSectionMeshJob(world, 0, 0, 0, shapeAtlas, {
    maxVertices: 3,
  });
  assert.equal(vertices.step({ flush: true }), "budget");
  assert.equal(vertices.snapshotBytes, 0);
  assert.equal(world.dirtySectionRevisions.has("0,0,0"), true);
  vertices.dispose();
  let disposed = 0;
  const original = THREE.BufferGeometry.prototype.dispose;
  t.mock.method(THREE.BufferGeometry.prototype, "dispose", function () {
    disposed++;
    original.call(this);
  });
  const bytes = createSectionMeshJob(world, 0, 0, 0, shapeAtlas, {
    maxBytes: 1,
  });
  assert.equal(bytes.step({ flush: true }), "budget");
  assert.equal(bytes.result, null);
  assert.equal(disposed, 0, "an oversized quad is rejected before allocation");
  bytes.dispose();
  assert.equal(disposed, 0);
  assert.equal(world.acknowledgments.length, 0);
});

test("partitions split inside complex cells without changing materials, UVs, AO or faces", () => {
  const world = authoredColumns(
    [[0, 0]],
    [
      [0, 0, 0, BLOCK.OAK_FENCE],
      [1, 0, 0, BLOCK.STONE],
      [0, 1, 0, BLOCK.OAK_SLAB, BLOCK_STATE.TOP, FLUID.WATER_SOURCE],
      [2, 0, 0, BLOCK.WHITE_BED],
      [4, 0, 0, BLOCK.OAK_DOOR],
      [4, 1, 0, BLOCK.OAK_DOOR, BLOCK_STATE.PART],
      [6, 0, 0, BLOCK.GLOW_BERRIES],
      [8, 0, 0, BLOCK.TORCH],
      [10, 0, 0, BLOCK.GLASS],
    ]
  );
  const baseline = createRangeMesher(
    snapshotSection(world, 0, 0, 0),
    shapeAtlas,
    world
  );
  baseline.stepCells(Infinity);
  const expected = finishMeshData(baseline.context);
  const limits = { maxVertices: 16, maxBytes: 600 };
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas, limits);
  try {
    assert.equal(job.step({ flush: true }), "ready");
    assert.ok(job.result.parts.length > 1);
    assertPartLimits(job.result, limits);
    assertPartitionGeometryEqual(job.result, expected);
    assert.equal(job.bytes, partitionTotals(job.result).bytes);
    assert.equal(job.draws, partitionTotals(job.result).draws);
    assert.equal(job.acknowledge(), false);
    assert.equal(world.acknowledgments.length, 0);
  } finally {
    disposeBatches(expected);
    job.dispose();
  }
});

test("yielded partial results stay private and stale/cancelled jobs dispose every sealed part", (t) => {
  t.mock.method(performance, "now", () => 0);
  for (const stale of [true, false]) {
    const world = authoredColumns([[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
    const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas, {
      maxVertices: 4,
    });
    job.step({ maxCells: 1 });
    assert.equal(job.lastSlice.cells, 1);
    assert.equal(job.status, "pending");
    assert.equal(job.result, null);
    assert.equal(job.takeResult(), null);
    assert.equal(job.acknowledge(), false);
    const context = job.mesher.context;
    const geometries = partitionGeometries({ parts: context.parts });
    assert.equal(
      geometries.length,
      5,
      "the last cube face is still in CPU arrays"
    );
    let disposed = 0;
    for (const geometry of geometries)
      geometry.addEventListener("dispose", () => disposed++);
    if (stale) {
      world.dirty(0, 0, 0);
      assert.equal(job.step({ flush: true }), "stale");
    } else job.dispose();
    assert.equal(job.snapshotBytes, 0);
    assert.equal(job.result, null);
    assert.equal(context.parts.length, 0);
    assert.equal(disposed, geometries.length);
    job.dispose();
    assert.equal(disposed, geometries.length, "no double disposal");
    assert.equal(world.acknowledgments.length, 0);
    assert.equal(world.dirtySectionRevisions.has("0,0,0"), true);
  }
});

test("a ready multi-part result is disposed in full when its ticket changes before transfer", () => {
  const world = authoredColumns([[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas, {
    maxVertices: 4,
  });
  assert.equal(job.step({ flush: true }), "ready");
  const geometries = partitionGeometries(job.result);
  assert.equal(geometries.length, 6);
  let disposed = 0;
  for (const geometry of geometries)
    geometry.addEventListener("dispose", () => disposed++);
  const ticket = world.dirty(0, 0, 0);
  assert.equal(job.takeResult(), null);
  assert.equal(job.status, "stale");
  assert.equal(disposed, geometries.length);
  assert.equal(job.acknowledge(), false);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), ticket);
  job.dispose();
  assert.equal(disposed, geometries.length);
});

test("aggregate staging refusal disposes earlier partitions without clearing a dirty ticket", (t) => {
  const world = authoredColumns([[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  let disposed = 0;
  const original = THREE.BufferGeometry.prototype.dispose;
  t.mock.method(THREE.BufferGeometry.prototype, "dispose", function () {
    disposed++;
    original.call(this);
  });
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas, {
    maxVertices: 4,
    maxDrawCalls: 2,
  });
  const ticket = job.stamp.ticket;
  assert.equal(job.step({ flush: true }), "budget");
  assert.equal(job.result, null);
  assert.equal(job.snapshotBytes, 0);
  assert.equal(disposed, 2);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), ticket);
  assert.equal(job.acknowledge(), false);
  job.dispose();
  assert.equal(disposed, 2);
});
