import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { detailMeshResources, clearSectionJobs } from "../src/section-renderer.js";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";

function fixture(t, count = 3) {
  t.mock.method(performance, "now", () => 0);
  const columns = Array.from({ length: count }, (_, i) => [i, 0]);
  const world = authoredColumns(columns, columns.flatMap(([cx]) =>
    Array.from({ length: 100 }, (_, i) => [cx * 16 + i % 10, 0, Math.floor(i / 10), BLOCK.OAK_FENCE])));
  const renderer = shapeRenderer(world);
  renderer.renderDistanceOverride = 12;
  renderer.meshLimits = { regionalPages: true };
  renderer.rebuildDirty(Infinity);
  renderer.meshLimits.maxCopyBytesPerSlice = 16384;
  t.after(() => { clearSectionJobs(renderer); disposeShapeRenderer(renderer); });
  return { renderer, world };
}

function unload(renderer, world, key) {
  world.chunks.delete(key);
  renderer.removeChunk(key);
}

function drain(renderer) {
  let slices = 0;
  while ((detailMeshResources(renderer).retainedDeadBytes || renderer.sectionCompaction) && slices++ < 2000) {
    renderer.rebuildDirty(1);
    assert.ok(renderer.meshStats.lastSliceCopyBytes <= 16384);
    assert.ok(detailMeshResources(renderer).stagingBytes <= 16 * 1024 * 1024);
    assert.ok(detailMeshResources(renderer).combinedCpuBytes <= 256 * 1024 * 1024);
  }
  assert.ok(slices < 2000);
  return slices;
}

test("unchanged surviving bands compact incrementally without edits or lost coverage", (t) => {
  const { renderer, world } = fixture(t, 2);
  const survivor = renderer.chunks.get("1,0"), group = survivor.userData.sections.get(0).group;
  const source = group.children[0], original = source.geometry.attributes.position.array;
  const originalPage = survivor.userData.sectionRanges.get(source).mesh.geometry;
  const before = detailMeshResources(renderer);
  unload(renderer, world, "0,0");
  assert.ok(detailMeshResources(renderer).retainedDeadBytes > 0);
  renderer.rebuildDirty(1);
  assert.ok(renderer.sectionCompaction);
  assert.equal(source.geometry.attributes.position.array, original);
  assert.equal(renderer.detailCoverage().has("1,0"), true);
  assert.ok(drain(renderer) > 1);
  const after = detailMeshResources(renderer);
  assert.equal(after.retainedDeadBytes, 0);
  assert.ok(after.gpuBytes < before.gpuBytes);
  assert.equal(survivor.userData.sections.get(0).group, group);
  assert.notEqual(source.geometry.attributes.position.array, original);
  assert.deepEqual(Object.keys(originalPage.attributes), []);
  assert.equal(originalPage.index, null);
  assert.equal(renderer.detailCoverage().size, 1);
  assert.equal(after.palette.references, source.geometry.attributes.position.count);
});

test("peer unload during copying invalidates the plan and releases replacement palette leases", (t) => {
  const { renderer, world } = fixture(t);
  unload(renderer, world, "0,0");
  renderer.rebuildDirty(1);
  const stale = renderer.sectionCompaction.plan;
  unload(renderer, world, "1,0");
  renderer.rebuildDirty(1);
  assert.equal(stale.disposed, true);
  assert.equal(stale.allocatedBytes, 0);
  drain(renderer);
  assert.equal(renderer.detailCoverage().has("2,0"), true);
  const source = renderer.chunks.get("2,0").userData.sections.get(0).group.children[0];
  assert.equal(renderer.geometryPalette.references, source.geometry.attributes.position.count);
  unload(renderer, world, "2,0");
  assert.equal(renderer.geometryPalette, null);
  assert.equal(detailMeshResources(renderer).combinedCpuBytes, 0);
});

test("compaction admission is explicit and retries restored room without a world edit", (t) => {
  const { renderer, world } = fixture(t, 2);
  unload(renderer, world, "0,0");
  const live = detailMeshResources(renderer);
  renderer.meshLimits.maxCpuBytes = live.canonicalBytes;
  renderer.rebuildDirty(1);
  assert.equal(renderer.meshStats.compactionBlocked.reason, "compaction-reservation");
  assert.equal(renderer.sectionCompaction.plan.allocatedBytes, 0);
  assert.equal(renderer.detailCoverage().has("1,0"), true);
  renderer.meshLimits.maxCpuBytes = 256 * 1024 * 1024;
  drain(renderer);
  assert.equal(detailMeshResources(renderer).retainedDeadBytes, 0);
});

test("repeated admission/unload travel plateaus without editing surviving columns", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([]);
  const renderer = shapeRenderer(world);
  renderer.renderDistanceOverride = 12;
  renderer.meshLimits = { regionalPages: true };
  t.after(() => { clearSectionJobs(renderer); disposeShapeRenderer(renderer); });
  let peak = 0;
  for (let x = 0; x < 32; x++) {
    const chunk = world.admit(x, 0);
    // Initial authored generation, not an edit to any surviving section.
    chunk.blocks[-chunk.minY * 256] = BLOCK.STONE;
    renderer.camera.position.x = x * 16;
    if (x >= 2) unload(renderer, world, `${x - 2},0`);
    renderer.rebuildDirty(Infinity);
    renderer.rebuildDirty(Infinity);
    const stats = detailMeshResources(renderer);
    assert.equal(stats.retainedDeadBytes, 0);
    assert.equal(stats.stagingBytes, stats.palette.pendingUploadBytes);
    assert.equal(renderer.detailCoverage().size, Math.min(x + 1, 2));
    assert.ok(renderer.sectionRegions.size <= 2);
    assert.ok(stats.palette.entries <= 6);
    assert.equal(stats.palette.references, Math.min(x + 1, 2) * 24);
    peak = Math.max(peak, stats.canonicalBytes);
  }
  assert.ok(peak < 500000, `bounded canonical footprint: ${peak}`);
});

test("region-coordinate ABA cancels an old compaction before the new incarnation publishes", (t) => {
  const { renderer, world } = fixture(t, 2);
  const oldRegion = renderer.chunks.get("1,0").userData.sectionRegion;
  unload(renderer, world, "0,0");
  renderer.rebuildDirty(1);
  const stale = renderer.sectionCompaction.plan;
  unload(renderer, world, "1,0");
  const chunk = world.admit(0, 0);
  chunk.blocks[-chunk.minY * 256] = BLOCK.STONE;
  renderer.rebuildDirty(Infinity);
  assert.equal(stale.disposed, true);
  assert.equal(renderer.detailCoverage().size, 1);
  assert.notEqual(renderer.chunks.get("0,0").userData.sectionRegion, oldRegion);
  assert.equal(renderer.geometryPalette.references, 24);
});

test("publication attachment failure rolls back private pages and palette references", (t) => {
  const { renderer, world } = fixture(t, 2);
  unload(renderer, world, "0,0");
  const column = renderer.chunks.get("1,0"), region = column.userData.sectionRegion;
  const source = column.userData.sections.get(0).group.children[0];
  const array = source.geometry.attributes.position.array;
  const refs = renderer.geometryPalette.references;
  const mock = t.mock.method(region, "add", () => { throw new Error("injected attachment failure"); });
  assert.throws(() => renderer.rebuildDirty(Infinity), /injected attachment failure/);
  assert.equal(renderer.sectionCompaction, null);
  assert.equal(renderer.geometryPalette.references, refs);
  assert.equal(source.geometry.attributes.position.array, array);
  assert.equal(renderer.detailCoverage().has("1,0"), true);
  mock.mock.restore();
  drain(renderer);
  assert.equal(detailMeshResources(renderer).retainedDeadBytes, 0);
});

test("cancelling during integer-width narrowing releases both staging widths without rebinding peers", (t) => {
  const { renderer, world } = fixture(t, 2);
  const source = renderer.chunks.get("1,0").userData.sections.get(0).group.children[0];
  const original = source.geometry.attributes.color.array;
  const references = renderer.geometryPalette.references;
  world.put(0, 0, 0, BLOCK.STONE);
  let caught = false;
  for (let i = 0; i < 2000; i++) {
    renderer.rebuildDirty(1);
    const plan = [...renderer.sectionJobs.values()][0]?.pagePlan;
    if (plan && plan.allocatedBytes > plan.bytes) {
      caught = true;
      assert.ok(plan.allocatedBytes <= plan.stagingBytes);
      clearSectionJobs(renderer);
      assert.equal(plan.allocatedBytes, 0);
      break;
    }
  }
  assert.equal(caught, true);
  assert.equal(source.geometry.attributes.color.array, original);
  assert.equal(renderer.geometryPalette.references, references);
});

test("reserved page-sized headroom permits standalone reclamation at the exact combined ceiling", (t) => {
  const { renderer, world } = fixture(t, 2);
  const live = detailMeshResources(renderer);
  renderer.meshLimits.maxCpuBytes = live.combinedCpuBytes + live.reservedCompactionHeadroomBytes;
  renderer.meshLimits.maxGpuBytes = live.gpuBytes + live.reservedCompactionHeadroomBytes;
  unload(renderer, world, "0,0");
  for (let i = 0; detailMeshResources(renderer).retainedDeadBytes && i < 1000; i++) {
    renderer.rebuildDirty(1);
    const stats = detailMeshResources(renderer);
    assert.ok(stats.combinedCpuBytes <= renderer.meshLimits.maxCpuBytes);
    assert.ok(stats.gpuBytes + stats.reservedPageBytes <= renderer.meshLimits.maxGpuBytes);
  }
  assert.equal(detailMeshResources(renderer).retainedDeadBytes, 0);
  assert.equal(renderer.detailCoverage().has("1,0"), true);
});
