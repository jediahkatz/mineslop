import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { regionalRegressionFixture } from "./regional-regression-fixture.js";
import { observeRegionalCensuses, assertCensusAccounting, stageReadyJob } from "./regional-census-fixture.js";

test("regional census: charged admission progresses a real job within the unchanged cooperative budget", (t) => {
  const { renderer } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE],
  ]);
  renderer.meshLimits.maxSliceMs = 2;
  renderer.sectionMeshLimits = { maxCellsPerSlice: 32 };
  renderer.rebuildDirty(0);
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const census = observeRegionalCensuses(t, renderer);
  const resources = renderer.geometryPalette.resources.bind(renderer.geometryPalette);
  // Late-window censuses measured roughly 0.6–0.7ms each. Three censuses
  // before stepping exhaust 2ms; the reservation and peak checks alone do not.
  const charged = t.mock.method(renderer.geometryPalette, "resources", () => {
    clock += 0.7;
    return resources();
  });
  renderer.rebuildDirty(1);
  charged.mock.restore();
  census.stop();
  assert.ok(renderer.meshStats.lastSliceCells > 0, "duplicate census must not starve mesher work");
  assert.ok(renderer.meshStats.lastSliceSteps > 0);
  const [job] = renderer.sectionJobs.values();
  assert.equal(job.constructor.name, "SectionMeshJob");
  assert.ok(!job.done && job.mesher.cursor > 0, "real yielded snapshot/mesher, not a fake job");
  assert.equal(renderer.meshStats.limits.maxSliceMs, 2);
  assert.equal(renderer.meshStats.limits.maxJobs, 1);
  assert.ok(renderer.meshStats.lastSliceCells <= 8192);
  assert.ok(renderer.meshStats.lastSliceSteps <= 16);
  // Reservation, post-insertion peak, final reporting all remain fresh.
  assert.equal(census.events.length, 3);
  assert.equal(census.events[0].state.jobs.length, 0);
  assert.equal(census.events[1].state.jobs.length, 1);
  assertCensusAccounting(renderer);
});

test("regional census: no-eviction admission uses one decision census per real job", (t) => {
  const { renderer } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE],
  ]);
  Object.assign(renderer.meshLimits, { maxJobs: 2, maxStepsPerSlice: 1, maxCopyBytesPerSlice: 0 });
  renderer.rebuildDirty(0);
  const census = observeRegionalCensuses(t, renderer);
  renderer.rebuildDirty(1);
  census.stop();
  assert.equal(renderer.sectionJobs.size, 2);
  assert.ok([...renderer.sectionJobs.values()].every((job) => job.constructor.name === "SectionMeshJob"));
  assertCensusAccounting(renderer);
  // Final slice + two (decision census + post-insertion peak).
  // Never reuse a census across the intervening job insertions.
  assert.equal(census.events.length, 5, "unchanged admission must not enumerate twice inside/after eviction helper");
});

test("regional census: mixed ready/pending publication reuses the no-eviction result", (t) => {
  const { renderer } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE],
  ]);
  Object.assign(renderer.meshLimits, { maxJobs: 2, maxStepsPerSlice: 1, maxCopyBytesPerSlice: 0 });
  const ready = stageReadyJob(renderer, true);
  const before = assertCensusAccounting(renderer);
  const census = observeRegionalCensuses(t, renderer);
  renderer.rebuildDirty(1);
  census.stop();
  const after = assertCensusAccounting(renderer);
  assert.equal(renderer.sectionJobs.size, 2);
  assert.equal(ready.status, "ready");
  assert.ok([...renderer.sectionJobs.values()].some((job) => !job.done));
  assert.deepEqual(after, before, "no copying, allocation, eviction or publication occurred");
  for (const event of census.events) assert.deepEqual(event.state, census.events[0].state);
  // One publication decision + final slice. The latter stays
  // fresh: a normal copy/publication may have changed resources before it.
  assert.equal(census.events.length, 2, "publication must consume the helper's final census");
});

test("regional census: eviction refreshes after removal but does not repeat that final census", (t) => {
  const { world, renderer } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [65, 0, 1, BLOCK.STONE],
  ], [[0, 0], [4, 0]]);
  renderer.renderDistanceOverride = 4;
  renderer.sectionMeshLimits = { maxDrawCalls: 3 };
  renderer.rebuildDirty(Infinity);
  world.put(2, 0, 2, BLOCK.WATER);
  Object.assign(renderer.meshLimits, { maxJobs: 1, maxStepsPerSlice: 1, maxCopyBytesPerSlice: 0 });
  const ready = stageReadyJob(renderer);
  // Reduce the renderer ceiling without changing this existing job's limits.
  // Column 4 becomes the retained hidden ring, in a different physical region.
  renderer.meshLimits.maxDrawCalls = 3;
  renderer.renderDistanceOverride = 2;
  renderer.camera.position.x = 16.5;
  const removed = [];
  const remove = renderer.removeChunk.bind(renderer);
  t.mock.method(renderer, "removeChunk", (key) => { removed.push(key); return remove(key); });
  const census = observeRegionalCensuses(t, renderer);
  renderer.rebuildDirty(1);
  census.stop();
  assertCensusAccounting(renderer);
  assert.deepEqual(removed, ["4,0"]);
  assert.equal(renderer.chunks.has("0,0"), true);
  assert.equal(renderer.chunks.has("4,0"), false);
  assert.equal(ready.status, "ready", "bounded copy is still paused");
  const initial = census.events[0].state, final = census.events.at(-1).state;
  assert.ok(final.physicalBytes < initial.physicalBytes);
  assert.ok(final.revision > initial.revision);
  // Pre-eviction decision + post-removal refresh + final slice.
  assert.equal(census.events.length, 3, "caller must use the refreshed post-eviction census");
  assert.deepEqual(census.events[1].state, final,
    "post-removal decision must already see the final ownership, before the end-of-slice census");
});
