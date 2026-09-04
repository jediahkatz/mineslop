import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  authoredColumns,
  shapeRenderer,
  disposeShapeRenderer,
} from "./shape-fixture.js";
import { getWorldSpec } from "../src/world-spec.js";
import { World } from "../src/world.js";
import { drainNativeFallback } from "./native-v4-fixtures.js";
import { SectionMeshJob } from "../src/section-mesh.js";
import { DETAIL_MESH_LIMITS } from "../src/section-renderer.js";

function fixture(t, columns = [[7, 4]]) {
  const world = authoredColumns([]);
  world.generatorVersion = 7;
  world.dimension = "end";
  world.spec = getWorldSpec(7, "end");
  for (const [x, z] of columns) world.admit(x, z);
  const renderer = shapeRenderer(world);
  renderer.camera.position.set(116, 126, 79);
  t.after(() => disposeShapeRenderer(renderer));
  return { world, renderer };
}

test("400 empty sections drain at the unchanged one-publication-per-call floor", (t) => {
  // Deterministic work accounting, not a wall-clock or frame-rate claim.
  t.mock.method(performance, "now", () => 0);
  const columns = [];
  for (let z = 2; z <= 6; z++)
    for (let x = 5; x <= 9; x++) columns.push([x, z]);
  const { world, renderer } = fixture(t, columns);
  let calls = 0;
  while (world.dirtySectionRevisions.size && calls < 401) {
    calls++;
    assert.equal(renderer.rebuildDirty(1), 1);
    assert.ok(
      renderer.meshStats.lastSliceCells <= DETAIL_MESH_LIMITS.maxCellsPerSlice
    );
    assert.ok(renderer.sectionJobs.size <= 2);
    assert.ok(renderer.meshStats.snapshotBytes <= 80800);
  }
  assert.equal(calls, 400);
  assert.equal(renderer.meshStats.sections, 400);
  assert.equal(renderer.detailCoverage().size, 25);
  assert.equal(renderer.sectionJobs.size, 0);
  assert.equal(renderer.meshStats.staleJobs, 0);
  assert.equal(renderer.meshStats.budgetRejections, 0);
});

test("step visits, total cells and zero-progress work remain hard bounded", (t) => {
  t.mock.method(performance, "now", () => 0);
  const { renderer } = fixture(t);
  renderer.meshLimits = { maxCellsPerSlice: 600, maxStepsPerSlice: 3 };
  let visits = 0;
  const step = SectionMeshJob.prototype.step;
  t.mock.method(SectionMeshJob.prototype, "step", function (options) {
    visits++;
    const result = step.call(this, options);
    assert.ok(this.lastSlice.cells <= 512);
    return result;
  });
  assert.equal(renderer.rebuildDirty(2), 0);
  assert.equal(renderer.meshStats.lastSliceCells, 600);
  assert.equal(visits, 2);
  const other = fixture(t).renderer;
  other.meshLimits = { maxStepsPerSlice: 3 };
  other.sectionMeshLimits = { maxCellsPerSlice: 1 };
  visits = 0;
  other.rebuildDirty(2);
  assert.equal(visits, 3);
  assert.equal(other.meshStats.lastSliceCells, 3);
  const stopped = fixture(t).renderer;
  stopped.sectionMeshLimits = { maxCellsPerSlice: 0 };
  visits = 0;
  stopped.rebuildDirty(2);
  assert.equal(visits, 2);
  assert.equal(stopped.meshStats.lastSliceCells, 0);
});

test("time-exhausting jobs alternate across calls and stale or removed work is cancelled", (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const { world, renderer } = fixture(t);
  const step = SectionMeshJob.prototype.step;
  const order = [];
  t.mock.method(SectionMeshJob.prototype, "step", function (options) {
    order.push(this);
    const result = step.call(this, options);
    clock += DETAIL_MESH_LIMITS.maxSliceMs;
    return result;
  });
  for (let i = 0; i < 4; i++) renderer.rebuildDirty(1);
  assert.equal(order.length, 4);
  assert.notEqual(order[0], order[1]);
  assert.equal(order[0], order[2]);
  assert.equal(order[1], order[3]);
  const jobs = [...renderer.sectionJobs.values()];
  assert.deepEqual(jobs.map((job) => job.mesher.cursor), [1024, 1024]);
  const stale = jobs[0];
  world.dirty(7, 4, stale.stamp.sy);
  renderer.rebuildDirty(0);
  assert.equal(stale.status, "disposed");
  assert.equal(stale.snapshotBytes, 0);
  const peer = jobs[1];
  assert.ok([...renderer.sectionJobs.values()].includes(peer));
  renderer.camera.position.x += 1000;
  renderer.rebuildDirty(0);
  assert.equal(renderer.sectionJobs.size, 0);
  assert.equal(peer.status, "disposed");
});

test("a key invalidated during a step is retried next call, not spun within the slice", (t) => {
  t.mock.method(performance, "now", () => 0);
  const { world, renderer } = fixture(t);
  renderer.meshLimits = { maxJobs: 1 };
  const step = SectionMeshJob.prototype.step;
  const attempts = [];
  const invalidating = t.mock.method(
    SectionMeshJob.prototype,
    "step",
    function (options) {
      attempts.push(this);
      world.dirty(this.stamp.cx, this.stamp.cz, this.stamp.sy);
      return step.call(this, options);
    }
  );
  assert.equal(renderer.rebuildDirty(1), 0);
  assert.equal(attempts.length, 1);
  const stale = attempts[0];
  const key = `${stale.stamp.cx},${stale.stamp.cz},${stale.stamp.sy}`;
  assert.equal(stale.status, "disposed");
  assert.equal(stale.snapshotBytes, 0);
  assert.equal(world.acknowledgments.length, 0);
  assert.equal(renderer.sectionRejections.has(key), false);
  const ticket = world.dirtySectionRevisions.get(key);
  assert.notEqual(ticket, stale.stamp.ticket);
  invalidating.mock.restore();
  assert.equal(renderer.rebuildDirty(1), 1);
  assert.equal(world.dirtySectionRevisions.has(key), false);
  assert.equal(world.acknowledgments.at(-1).ticket, ticket);
  assert.equal(renderer.meshStats.staleJobs, 1);
  assert.equal(renderer.meshStats.budgetRejections, 0);
});

function digest(renderer) {
  const hash = createHash("sha256");
  const rows = [...renderer.chunks].sort(([a], [b]) => a.localeCompare(b));
  let vertices = 0;
  for (const [key, column] of rows) {
    for (const [sy, section] of [...column.userData.sections].sort(
      ([a], [b]) => a - b
    )) {
      hash.update(`${key},${sy}`);
      section.group.traverse((mesh) => {
        if (!mesh.geometry) return;
        vertices += mesh.geometry.getAttribute("position").count;
        for (const attribute of [
          mesh.geometry.index,
          ...Object.values(mesh.geometry.attributes),
        ]) {
          if (attribute)
            hash.update(
              new Uint8Array(
                attribute.array.buffer,
                attribute.array.byteOffset,
                attribute.array.byteLength
              )
            );
        }
      });
    }
  }
  return { sha256: hash.digest("hex"), vertices };
}

test("native v7 End jobs rotate fairly and finite detail matches complete geometry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const world = new World("cedar-valley", {
    generatorVersion: 7,
    dimension: "end",
    useWorker: false,
  });
  t.after(() => world.dispose());
  const pending = world.ensureArea({ x: 116, y: 126, z: 79 }, 0);
  drainNativeFallback(t, world);
  await pending;
  const renderer = shapeRenderer(world);
  renderer.camera.position.set(116, 126, 79);
  t.after(() => disposeShapeRenderer(renderer));
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const step = SectionMeshJob.prototype.step;
  const order = [];
  const expensive = t.mock.method(
    SectionMeshJob.prototype,
    "step",
    function (options) {
      order.push(this);
      const result = step.call(this, options);
      clock += DETAIL_MESH_LIMITS.maxSliceMs;
      return result;
    }
  );
  for (let i = 0; i < 4; i++) renderer.rebuildDirty(1);
  assert.equal(order.length, 4);
  assert.notEqual(order[0], order[1]);
  assert.equal(order[0], order[2]);
  assert.equal(order[1], order[3]);
  assert.ok(order[0].mesher.cursor > 0);
  assert.ok(order[1].mesher.cursor > 0);
  expensive.mock.restore();
  let calls = 4;
  while (
    (!renderer.detailCoverage().has("7,4") ||
      world.dirtySectionRevisions.size) &&
    calls < 500
  ) {
    assert.ok(renderer.rebuildDirty(1) <= 1);
    assert.ok(renderer.meshStats.lastSliceCells <= 8192);
    assert.ok(renderer.sectionJobs.size <= 2);
    assert.ok(renderer.meshStats.gpuBytes <= DETAIL_MESH_LIMITS.maxGpuBytes);
    assert.ok(renderer.meshStats.drawCalls <= DETAIL_MESH_LIMITS.maxDrawCalls);
    calls++;
  }
  assert.ok(calls < 500);
  assert.equal(renderer.sectionJobs.size, 0);
  assert.equal(renderer.meshStats.budgetRejections, 0);
  const finite = digest(renderer);
  assert.ok(finite.vertices > 0);
  const reference = shapeRenderer(world);
  reference.camera.position.copy(renderer.camera.position);
  t.after(() => disposeShapeRenderer(reference));
  reference.rebuildDirty(Infinity);
  assert.deepEqual(finite, digest(reference));
  assert.equal(renderer.detailCoverage().size, reference.detailCoverage().size);
});
