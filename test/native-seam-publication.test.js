import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { publishedNativeBoundaries } from "../src/native-boundary-profile.js";
import { registerTotalSurface } from "../src/surface-availability.js";
import { WORLD_MIN, WORLD_MAX } from "../src/terrain.js";
import { clearSectionJobs } from "../src/section-renderer.js";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";

test("native geometry and its seam publish together after bounded staging, including removal", t => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([[0, 0]], [[15, 31, 8, BLOCK.STONE]]);
  world.generator = { terrainHeight: () => 63, getBiome: () => ({ id: "plains", color: "#83ac52" }) };
  registerTotalSurface(world.generator, { minX: WORLD_MIN, maxX: WORLD_MAX, minZ: WORLD_MIN, maxZ: WORLD_MAX });
  const renderer = shapeRenderer(world);
  renderer.quality = "medium";
  renderer.renderDistanceOverride = 12;
  renderer.meshLimits = { regionalPages: true, maxCellsPerSlice: 64 };
  renderer.camera.position.set(8, 80, 8);
  const lod = renderer.distant = new DistantTerrain(renderer.scene, world);
  const update = () => {
    const batches = renderer.detailBatchCoverage(), owners = new Set();
    lod.update(renderer.camera.position, { radius: 12, quality: "medium", outdoors: true,
      detailBatches: batches, nativeBoundaries: publishedNativeBoundaries(renderer.chunks, batches, undefined, owners),
      nativeBoundaryOwners: owners, budgetMs: 1 });
    assert.ok(lod.lastWork.units <= 512, `work ${lod.lastWork.units}`);
    assert.ok(lod.fogDistance >= 192, `publication contracted the valid horizon: ${lod.fogDistance}`);
  };
  try {
    for (let i = 0; i < 2000 && !lod.ready; i++)
      lod.update(renderer.camera.position, { radius: 12, quality: "medium", outdoors: true,
        nativeBoundaries: new Map(), budgetMs: 4 });
    assert.ok(lod.ready);
    let staged = 0, seen = false;
    const drain = () => {
      for (let i = 0; i < 2000; i++) {
        renderer.rebuildDirty(1);
        for (const job of renderer.sectionJobs?.values() ?? []) {
          if (job.nativeSeamPlan && !job.nativeSeamPlan.done) {
            staged++;
            const published = renderer.chunks.get("0,0")?.userData.sections.get(1);
            assert.notEqual(published?.stamp.ticket, job.stamp.ticket, "native published before its seam");
          }
        }
        update();
        const column = renderer.chunks.get("0,0");
        const profile = column?.userData.nativeBoundarySources?.get(1);
        if (profile) {
          assert.ok(lod._seams.columns.get("0,0")?.profiles.some(p => p.data === profile));
          seen = true;
        }
        if (!world.dirtySectionRevisions.size && !renderer.sectionJobs.size) return;
      }
      assert.fail("bounded native publication did not finish");
    };
    drain();
    assert.ok(seen && staged > 1);
    world.put(15, 31, 8, BLOCK.AIR);
    drain();
    assert.equal(lod._seams.columns.size, 0, "removed native retained a published seam");
    assert.equal(lod._seams.layers[0].edge.array[2], -1e9);
    t.diagnostic(JSON.stringify({ stagedSlices: staged, horizon: lod.fogDistance,
      lastWork: lod.lastWork.units, lastNativeCopyBytes: renderer.meshStats.lastSliceCopyBytes }));
  } finally {
    clearSectionJobs(renderer);
    disposeShapeRenderer(renderer);
    lod.dispose();
  }
});
