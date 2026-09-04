import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { DETAIL_MESH_LIMITS } from "../src/section-renderer.js";
import { authoredColumns, disposeShapeRenderer, shapeRenderer } from "./shape-fixture.js";

test("a visible neighboring surface is not queued behind the center column's full vertical stack", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([[3, 60], [4, 60]], [
    [60, 184, 967, BLOCK.STONE],
    [66, 186, 968, BLOCK.STONE],
  ]);
  const renderer = shapeRenderer(world);
  t.after(() => disposeShapeRenderer(renderer));
  renderer.camera.position.set(60.90316129391475, 195.62, 969.7048381677617);
  renderer.camera.rotation.set(-1.2, -0.024, 0, "YXZ");
  renderer.camera.fov = 75;
  renderer.camera.aspect = 1.6;
  renderer.camera.updateProjectionMatrix();
  renderer.camera.updateMatrixWorld();
  // Deterministic completed-section allowance, not an increased runtime budget.
  renderer.sectionMeshLimits = { maxCellsPerSlice: 4096 };
  for (let i = 0; i < 4; i++) renderer.rebuildDirty(1);
  const neighbor = renderer.chunks.get("4,60")?.userData.sections.get(11);
  assert.ok(neighbor?.draws > 0, "the neighboring in-frustum surface must publish within four sections");
  assert.ok((renderer.chunks.get("3,60")?.userData.sections.size ?? 0) < 24);
  assert.ok(renderer.meshStats.activeJobs <= 2);
  assert.equal(renderer.meshStats.limits.maxSliceMs, 8);
  renderer.rebuildDirty(Infinity);
  assert.equal(world.dirtyChunks.size, 0, "offscreen work is deferred, never dropped");
  assert.ok([...renderer.chunks.values()].every((column) => column.userData.sections.size === 24));
});

test("default cell slices publish the visible neighbor without raising the two-job budget", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([[3, 60], [4, 60]], [[66, 186, 968, BLOCK.STONE]]);
  const renderer = shapeRenderer(world);
  t.after(() => disposeShapeRenderer(renderer));
  renderer.camera.position.set(60.9, 195.62, 969.7);
  renderer.camera.rotation.set(-1.2, -0.024, 0, "YXZ");
  renderer.camera.fov = 75;
  renderer.camera.aspect = 1.6;
  renderer.camera.updateProjectionMatrix();
  // The bounded scheduler revisits jobs within one callback; its total cell
  // cap is distinct from the unchanged 512-cell individual job step.
  assert.equal(DETAIL_MESH_LIMITS.maxCellsPerSlice, 8192);
  for (let i = 0; i < 4; i++) {
    renderer.rebuildDirty(1);
    assert.ok(renderer.meshStats.lastSliceCells <= DETAIL_MESH_LIMITS.maxCellsPerSlice);
    assert.ok(renderer.meshStats.activeJobs <= 2);
  }
  assert.ok(renderer.chunks.get("4,60")?.userData.sections.get(11)?.draws > 0,
    "the visible neighbor publishes within four default-budget callbacks");
});
