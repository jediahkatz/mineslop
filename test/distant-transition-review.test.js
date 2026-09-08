import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantTerrain } from "../src/distant-terrain.js";
import { createGenerator } from "../src/terrain.js";
import {
  publishReviewSurface, REVIEW_OPTIONS, reviewPendingBacking,
  reviewTerrainBacking, syntheticReviewTerrain,
} from "./distant-transition-review-fixtures.js";

function unknownReport(height, refined = false) {
  const lod = syntheticReviewTerrain(height, { refined });
  try {
    publishReviewSurface(lod);
    return {
      refined, bootstrap: lod._active.data.request.bootstrap,
      unknownChunks: [...lod._active.data.unknownChunks],
      ready: lod.ready, complete: lod.terrainCoverageComplete, fog: lod.fogDistance,
      drawnIndices: lod._active.terrain.geometry.drawRange.count,
    };
  } finally { lod.dispose(); }
}

test("review control: unknown corner and refined unknown interior both reject coverage", (t) => {
  t.mock.method(performance, "now", () => 0);
  const corner = unknownReport((x, z) => x === 0 && z === 0 ? NaN : 31);
  const interior = unknownReport((x, z) => x === 8 && z === 8 ? NaN : 31, true);
  t.diagnostic(JSON.stringify({ corner, interior }));
  for (const report of [corner, interior]) {
    assert.ok(report.drawnIndices > 0, "real nonempty geometry must be published");
    assert.ok(report.unknownChunks.includes("0,0"));
    assert.equal(report.ready, false);
    assert.equal(report.complete, false);
    assert.equal(report.fog, 0);
  }
});

test("review regression: coarse startup must reject an unknown chunk interior", (t) => {
  t.mock.method(performance, "now", () => 0);
  const report = unknownReport((x, z) => x === 8 && z === 8 ? NaN : 31);
  t.diagnostic(JSON.stringify(report));
  assert.ok(report.drawnIndices > 0, "a blank scene is not a coverage test");
  assert.equal(report.complete, false, "finite corner samples do not certify an unknown interior");
  assert.equal(report.ready, false);
  assert.equal(report.fog, 0);
});

function nativeLifecycle(quality) {
  const generator = createGenerator("cedar-valley", "overworld", 7);
  let treeQueries = 0;
  const trees = generator.getTrees.bind(generator);
  generator.getTrees = (...args) => { treeQueries++; return trees(...args); };
  generator.generateChunk = generator.generateRegion = () => {
    throw new Error("Review LOD fixture must not generate native chunks");
  };
  const scene = new THREE.Scene();
  const world = {
    generator, seed: "cedar-valley", generatorVersion: 7,
    dimension: "overworld", spec: generator.spec, chunks: new Map(),
  };
  const atlas = {
    texture: new THREE.DataTexture(new Uint8Array(4), 1, 1),
    uvFor: () => [0, 0, 1, 1],
  };
  const lod = new DistantTerrain(scene, world, { atlas });
  const options = { ...REVIEW_OPTIONS, quality };
  const position = { x: 0, z: 0 };
  let peakTerrainBacking = 0, peakPendingBacking = 0, rejectionFrame = null;
  let coarsePublications = 0, refinementPublications = 0, previous = null;
  let report;
  try {
    // Fixed work opportunities, not elapsed-time/performance assertions. This
    // also gives a rejected job ample time to settle after the initial event.
    for (let frame = 0; frame < 1600; frame++) {
      lod.update(position, options);
      if (lod._active && lod._active !== previous) {
        if (lod._active.data.request.bootstrap) coarsePublications++;
        else refinementPublications++;
        previous = lod._active;
      }
      if (lod.vegetationRejections && rejectionFrame === null) rejectionFrame = frame;
      peakTerrainBacking = Math.max(peakTerrainBacking, reviewTerrainBacking(lod));
      peakPendingBacking = Math.max(peakPendingBacking, reviewPendingBacking(lod));
    }
    report = {
      quality, treeQueries, rejectionFrame, rejections: lod.vegetationRejections,
      coarsePublications, refinementPublications,
      ready: lod.ready, fog: lod.fogDistance,
      bootstrap: lod._active?.data.request.bootstrap,
      pendingPhase: lod._job?.phase ?? null,
      pendingBytes: reviewPendingBacking(lod),
      terrainBackingBytes: reviewTerrainBacking(lod),
      peakTerrainBacking, peakPendingBacking,
      vegetationReady: !!lod._vegetation,
      vegetationPending: !!lod._vegetationJob,
      nativeChunks: world.chunks.size,
    };
  } finally {
    lod.dispose();
    atlas.texture.dispose();
  }
  report.afterDispose = {
    terrainBackingBytes: reviewTerrainBacking(lod),
    pendingBytes: reviewPendingBacking(lod),
    sceneChildren: scene.children.length,
    maskBytes: lod.detailMask.resources().cpuBytes,
    sampleCacheSize: lod._samples.size,
    treeCacheSize: lod._treeSamples.size,
  };
  return report;
}

function assertLifecycleControls(report) {
  assert.ok(report.treeQueries > 0, "use actual native forest queries, not an empty-tree stub");
  assert.ok(report.coarsePublications > 0, "exercise the R12 startup path");
  assert.ok(report.peakPendingBacking > 0, "exercise actual typed staging allocations");
  assert.equal(report.nativeChunks, 0);
  assert.deepEqual(report.afterDispose, {
    terrainBackingBytes: 0, pendingBytes: 0, sceneChildren: 0,
    maskBytes: 0, sampleCacheSize: 0, treeCacheSize: 0,
  }, "dispose releases ownership; this does not claim a garbage-collector measurement");
}

test("review control: v7 medium settles, releases staging and disposes retained resources", (t) => {
  t.mock.method(performance, "now", () => 0);
  const report = nativeLifecycle("medium");
  t.diagnostic(JSON.stringify(report));
  assertLifecycleControls(report);
  assert.ok(report.refinementPublications > 0);
  assert.equal(report.ready, true);
  assert.equal(report.fog, 320);
  assert.equal(report.pendingBytes, 0);
  assert.equal(report.pendingPhase, null);
});

test("review regression: v7 high canopy rejection cannot retain publish staging indefinitely", (t) => {
  t.mock.method(performance, "now", () => 0);
  const report = nativeLifecycle("high");
  t.diagnostic(JSON.stringify(report));
  assertLifecycleControls(report);
  // A repair may admit the forest successfully, or settle into a documented
  // degraded view. Neither outcome needs a permanently blocked terrain job.
  assert.ok(report.rejections > 0 || report.refinementPublications > 0,
    "must exercise either native forest admission or its real rejection path");
  assert.equal(report.vegetationPending, false);
  assert.equal(report.pendingPhase, null, "terminal canopy admission must settle terrain publication");
  assert.equal(report.pendingBytes, 0, "do not retain the rejected view's refinement staging");
});
