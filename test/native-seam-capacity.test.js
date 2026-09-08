import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { publishedNativeBoundaries } from "../src/native-boundary-profile.js";
import { registerTotalSurface } from "../src/surface-availability.js";
import { WORLD_MIN, WORLD_MAX } from "../src/terrain.js";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";

test("seam capacity refusal releases the sole job, admits useful work, and retries only after relief or source change", t => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([[0, 0]], [[15, 31, 8, BLOCK.STONE]]);
  world.generator = { terrainHeight: () => 63, getBiome: () => ({ id: "plains", color: "#83ac52" }) };
  registerTotalSurface(world.generator, { minX: WORLD_MIN, maxX: WORLD_MAX, minZ: WORLD_MIN, maxZ: WORLD_MAX });
  const renderer = shapeRenderer(world);
  renderer.camera.position.set(8, 80, 8);
  renderer.renderDistanceOverride = 12;
  const lod = renderer.distant = new DistantTerrain(renderer.scene, world);
  const options = { radius: 12, quality: "medium", outdoors: true, budgetMs: 4, nativeBoundaries: new Map() };
  for (let i = 0; i < 2000; i++) lod.update(renderer.camera.position, options);
  renderer.meshLimits = { regionalPages: true, maxGpuBytes: lod.resources().gpuBytes + 512 * 1024 };
  let refusals = 0;
  const prepare = lod.prepareNativePublication;
  t.mock.method(lod, "prepareNativePublication", function(...args) {
    const result = prepare.apply(this, args);
    if (result.capacity) refusals++;
    return result;
  });
  const step = () => {
    renderer.rebuildDirty(2);
    assert.ok(renderer.meshStats.gpuBytes <= renderer.meshStats.limits.maxGpuBytes);
    const batches = renderer.detailBatchCoverage(), owners = new Set();
    lod.update(renderer.camera.position, {
      ...options, detailBatches: batches,
      nativeBoundaries: publishedNativeBoundaries(renderer.chunks, batches, undefined, owners),
      nativeBoundaryOwners: owners,
      allocationBudget: {
        cpu: Math.max(0, renderer.meshStats.limits.maxCpuBytes - renderer.meshStats.combinedCpuBytes),
        gpu: Math.max(0, renderer.meshStats.limits.maxGpuBytes - renderer.meshStats.gpuBytes),
      },
    });
    assert.ok(lod.lastWork.units <= 512);
    const profile = renderer.chunks.get("0,0")?.userData.nativeBoundarySources?.get(1);
    if (profile) assert.ok(lod._seams?.columns.get("0,0")?.profiles.some(p => p.data === profile),
      "native boundary must never publish without its matching seam");
  };
  try {
    for (let i = 0; i < 201; i++) step();
    assert.deepEqual([...world.dirtySectionRevisions.keys()], ["0,0,1"], "all other sections must progress");
    assert.equal(renderer.sectionJobs.size, 0, "a capacity refusal must not monopolize maxJobs=1");
    assert.equal(renderer.meshStats.blocked?.reason, "native-seam-capacity");
    assert.equal(refusals, 1, "unrelated empty publications cannot churn the rejected job");
    for (let i = 201; i < 1000; i++) step();
    assert.equal(refusals, 1, "stable capacity must not repeatedly admit/remesh the refused source");

    // A paid near edit and new far geometry can both fit without boundary seams.
    world.put(8, 80, 8, BLOCK.STONE);
    const nearTicket = world.dirtySectionRevisions.get("0,0,5");
    world.admit(4, 0);
    world.put(72, 80, 8, BLOCK.STONE);
    for (let i = 0; i < 201; i++) step();
    assert.equal(world.dirtySectionRevisions.has("0,0,5"), false);
    assert.equal(renderer.chunks.get("0,0").userData.sections.get(5).stamp.ticket, nearTicket);
    assert.ok(renderer.chunks.get("4,0").userData.sections.get(5).bytes > 0);
    assert.equal(refusals, 1, "resource use increasing is not capacity relief");

    world.put(15, 31, 8, BLOCK.DIRT);
    const replacement = world.dirtySectionRevisions.get("0,0,1");
    for (let i = 0; i < 201; i++) step();
    assert.equal(refusals, 2, "a changed boundary source gets one new admission decision");
    assert.equal(world.dirtySectionRevisions.get("0,0,1"), replacement);
    renderer.meshLimits.maxGpuBytes = 256 * 1024 * 1024;
    for (let i = 0; i < 1000 && world.dirtySectionRevisions.size; i++) step();
    assert.equal(world.dirtySectionRevisions.size, 0);
    assert.equal(renderer.sectionJobs.size, 0);
    assert.equal(renderer.meshStats.blocked, null);
    assert.equal(renderer.chunks.get("0,0").userData.sections.get(1).stamp.ticket, replacement);
    t.diagnostic(JSON.stringify({ refusals, nearTicket, replacement,
      dirty: world.dirtySectionRevisions.size, activeJobs: renderer.sectionJobs.size }));
  } finally { disposeShapeRenderer(renderer); lod.dispose(); }
});
