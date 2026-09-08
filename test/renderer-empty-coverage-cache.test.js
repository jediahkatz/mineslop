import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { DistantDetailMask, distantDetailBatches } from "../src/distant-detail-mask.js";
import { emptySectionJob } from "../src/empty-section-job.js";
import { GameRenderer } from "../src/renderer.js";
import { sectionGeometryCovered } from "../src/section-pages.js";
import { regionalRegressionFixture } from "./regional-regression-fixture.js";

function fixture(t, entries = []) {
  const result = regionalRegressionFixture(t, entries, [[0, 0]]);
  const mask = new DistantDetailMask();
  t.after(() => mask.dispose());
  assert.equal(result.renderer.detailBatchCoverage, GameRenderer.prototype.detailBatchCoverage);
  return { ...result, mask };
}

function updateMask(renderer, world, mask) {
  // The same ownership handoff used by Renderer.update -> DistantTerrain.update.
  // Never invalidate the cache or substitute the independent fresh census here.
  const coverage = renderer.detailBatchCoverage();
  mask.update(renderer.camera.position, world.spec, coverage);
  return coverage;
}

function maskBits(mask, key) {
  const [cx, cz, sy] = key.split(",").map(Number);
  const point = new THREE.Vector3(cx * 16 + 8, sy * 16 + 8, cz * 16 + 8);
  const normal = new THREE.Vector3(0, 1, 0);
  return [0, 1, 2, 3].map(batch => mask.owns(point, normal, batch));
}

function assertPublishedCoverage(renderer, world, mask, key) {
  const coverage = updateMask(renderer, world, mask);
  const fresh = distantDetailBatches(renderer.chunks, renderer.camera);
  assert.equal(fresh.get(key), 15, "the independently inspected publication owns all four batches");
  assert.deepEqual({
    cachedBits: coverage.get(key) ?? 0,
    maskBits: maskBits(mask, key),
  }, {
    cachedBits: 15,
    maskBits: [true, true, true, true],
  }, "a published section must reach the production coverage cache and updated mask");
  assert.deepEqual(coverage, fresh);
}

function publishUntil(renderer, predicate) {
  for (let slice = 0; slice < 300 && !predicate(); slice++) renderer.rebuildDirty(1);
  assert.ok(predicate(), "the real bounded section publication path must reach the fixture");
}

test("empty publication after a cached empty publication updates native ownership and the LOD mask", t => {
  const { renderer, world, mask } = fixture(t);
  renderer.rebuildDirty(0);
  const resourceRevision = renderer.meshResourceRevision;
  const coverageRevision = renderer.detailCoverageRevision ?? 0;
  assert.equal(renderer.rebuildDirty(1), 1);
  assert.equal(renderer.detailCoverageRevision, coverageRevision + 1);
  assert.equal(renderer.meshResourceRevision, resourceRevision,
    "empty publication must not signal resource relief and retry budget refusals");
  const column = renderer.chunks.get("0,0");
  const firstYs = [...column.userData.sections.keys()];
  assert.equal(firstYs.length, 1);
  assertPublishedCoverage(renderer, world, mask, `0,0,${firstYs[0]}`);
  const cached = renderer.detailBatchCoverage();
  assert.equal(renderer.detailBatchCoverage(), cached, "prime and reuse the actual production cache");

  assert.equal(renderer.rebuildDirty(1), 1);
  assert.equal(renderer.detailCoverageRevision, coverageRevision + 2,
    "each successful empty publication invalidates coverage independently");
  assert.equal(renderer.meshResourceRevision, resourceRevision,
    "successive empty publications still do not change resource admission");
  const publishedYs = [...column.userData.sections.keys()];
  assert.equal(publishedYs.length, 2, "a second real publication must occur after cache priming");
  const sy = publishedYs.find(y => !firstYs.includes(y));
  const key = `0,0,${sy}`, section = column.userData.sections.get(sy);
  assert.equal(section.bytes, 0);
  assert.equal(section.draws, 0);
  assert.equal(section.group.children.length, 0);
  assert.equal(section.group.parent, column);
  assert.equal(world.dirtySectionRevisions.has(key), false, "publication acknowledged the actual ticket");
  assert.equal(sectionGeometryCovered(column, section, renderer.camera), true);
  assertPublishedCoverage(renderer, world, mask, key);
});

test("ready but unpublished and subsequently stale empty jobs cannot suppress fallback", t => {
  const { renderer, world, mask } = fixture(t);
  renderer.rebuildDirty(0);
  const coverageRevision = renderer.detailCoverageRevision ?? 0;
  const key = "0,0,0";
  const job = emptySectionJob(world, 0, 0, 0, {});
  assert.ok(job);
  assert.equal(job.status, "ready");
  assert.equal(job.done, true);
  assert.equal(job.current(), true);
  renderer.sectionJobs.set(key, job);

  const assertUnowned = () => {
    assert.equal(renderer.detailCoverageRevision ?? 0, coverageRevision,
      "unpublished, stale and retired jobs must not advance the coverage revision");
    assert.equal(renderer.chunks.get("0,0")?.userData.sections?.has(0) ?? false, false);
    assert.equal(updateMask(renderer, world, mask).has(key), false);
    assert.equal(distantDetailBatches(renderer.chunks, renderer.camera).has(key), false);
    assert.deepEqual(maskBits(mask, key), [false, false, false, false]);
  };
  assert.equal(renderer.sectionJobs.get(key), job, "exercise a real retained ready job");
  assertUnowned();
  world.put(1, 0, 1, BLOCK.STONE);
  assert.equal(job.current(), false, "a real voxel revision makes the empty proof stale");
  assertUnowned();
  renderer.rebuildDirty(0);
  assert.equal(renderer.sectionJobs.has(key), false, "the renderer retires the stale job");
  assert.equal(job.status, "disposed");
  assert.equal(world.dirtySectionRevisions.has(key), true, "an unpublished job cannot acknowledge the edit");
  assertUnowned();
});

test("nonempty publication, replacement and eviction preserve fresh cache/mask agreement", t => {
  const { renderer, world, mask } = fixture(t, [[1, 0, 1, BLOCK.STONE]]);
  const key = "0,0,0";
  renderer.rebuildDirty(0);
  assert.equal(updateMask(renderer, world, mask).has(key), false);
  const section = () => renderer.chunks.get("0,0")?.userData.sections.get(0);
  publishUntil(renderer, () => !!section());
  const initial = section();
  assert.ok(initial.bytes > 0 && initial.draws > 0, "exercise actual nonempty geometry");
  assertPublishedCoverage(renderer, world, mask, key);

  world.put(2, 0, 1, BLOCK.STONE);
  const ticket = world.dirtySectionRevisions.get(key);
  assert.notEqual(ticket, initial.stamp.ticket);
  assertPublishedCoverage(renderer, world, mask, key);
  publishUntil(renderer, () => section()?.stamp.ticket === ticket && !world.dirtySectionRevisions.has(key));
  assert.notEqual(section(), initial);
  assert.ok(section().bytes > 0 && section().draws > 0);
  assertPublishedCoverage(renderer, world, mask, key);

  renderer.removeChunk("0,0");
  assert.equal(updateMask(renderer, world, mask).has(key), false);
  assert.equal(distantDetailBatches(renderer.chunks, renderer.camera).has(key), false);
  assert.deepEqual(maskBits(mask, key), [false, false, false, false]);
});
