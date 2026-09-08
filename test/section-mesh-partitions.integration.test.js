import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createSectionMeshJob,
  SECTION_MESH_LIMITS,
} from "../src/section-mesh.js";
import {
  DETAIL_MESH_LIMITS,
  detailMeshResources,
} from "../src/section-renderer.js";
import {
  assertPartLimits,
  denseFenceColumn,
  partitionGeometries,
  partitionTotals,
} from "./mesh-partition-fixture.js";
import {
  disposeShapeRenderer,
  shapeAtlas,
  shapeRenderer,
} from "./shape-fixture.js";

function geometryDigest(result) {
  const hash = createHash("sha256");
  for (const geometry of partitionGeometries(result))
    for (const [name, attribute] of Object.entries({
      ...geometry.attributes,
      index: geometry.index,
    })) {
      hash.update(JSON.stringify([
        name, attribute.itemSize, attribute.normalized, attribute.array.constructor.name,
      ]));
      hash.update(new Uint8Array(
        attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength
      ));
    }
  return hash.digest("hex");
}

// A full dense section is intentional: the isolated runtime failure needs more
// than one default-sized part. Small fixtures exercise the same mechanics in units.
test("the reproduced 4096-fence section finishes in bounded parts without losing geometry", {
  timeout: 30000,
}, (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = denseFenceColumn();
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  t.after(() => job.dispose());
  const mesher = job.mesher;
  const ticket = job.stamp.ticket;
  let sawStagedPart = false;
  for (let slice = 0; slice < 32; slice++) {
    job.step({ maxCells: 128 });
    assert.ok(job.lastSlice.cells <= 128);
    if (!job.done) {
      sawStagedPart ||= mesher.context.parts.length > 0;
      // Finished geometry may be private while its boundary scan is pending.
      // Test the publication API; dumping a million-index private result on an
      // obsolete null assertion can exhaust the test runner's heap.
      if (!mesher.done) assert.ok(job.result === null, "unfinished geometry stays private");
      assert.equal(job.takeResult(), null);
      assert.equal(world.dirtySectionRevisions.get("0,0,0"), ticket);
    }
  }
  assert.equal(sawStagedPart, true);
  assert.equal(mesher.cursor, 4096);
  assert.equal(job.status, "pending", "voxel completion does not bypass boundary work");
  assert.ok(job.boundary && !job.boundary.done);
  assert.ok(job.result !== null, "assembled geometry waits for its certificate");
  const privateResult = job.result;
  const beforeBoundary = geometryDigest(privateResult);
  const triangleWork = 1207296 / 3;
  const maxBoundarySlices = Math.ceil(triangleWork / 128) + 1;
  let boundaryWork = 0, boundarySlices = 0;
  while (!job.done && boundarySlices < maxBoundarySlices) {
    job.step({ maxCells: 128 });
    boundarySlices++;
    boundaryWork += job.lastSlice.cells;
    assert.ok(job.lastSlice.cells <= 128, "boundary scan shares the original slice cap");
    assert.ok(job.result === privateResult, "scan retains the same private geometry");
    assert.equal(job.acknowledge(), false, "scanning is not publication");
    assert.equal(world.dirtySectionRevisions.get("0,0,0"), ticket);
    if (!job.done) assert.equal(job.takeResult(), null);
  }
  assert.equal(boundaryWork, triangleWork, "every opaque triangle is accounted for");
  assert.equal(job.status, "ready");
  assert.equal(geometryDigest(job.result), beforeBoundary, "certificate scan changes no geometry bytes");
  assert.equal(job.snapshotBytes, 0);
  assertPartLimits(job.result, SECTION_MESH_LIMITS);
  const totals = partitionTotals(job.result);
  // The immutable pre-fix full-count probe emitted these faces, but production
  // stopped at cell 705. Partitioning must preserve that complete geometry.
  assert.equal(totals.vertices, 804864);
  assert.equal(totals.indices, 1207296);
  assert.equal(mesher.context.vertices, totals.vertices);
  assert.equal(job.bytes, totals.bytes);
  assert.equal(job.draws, totals.draws);
  assert.ok(totals.draws > 1);
  assert.ok(totals.bytes > SECTION_MESH_LIMITS.maxBytes);
  assert.ok(totals.bytes <= DETAIL_MESH_LIMITS.maxGpuBytes);
  assert.ok(totals.draws <= DETAIL_MESH_LIMITS.maxDrawCalls);
  assert.equal(job.acknowledge(), false);
  assert.equal(world.acknowledgments.length, 0);
});

test("the real scheduler completes all 24 sections at default limits instead of caching a permanent hole", {
  timeout: 30000,
}, (t) => {
  const world = denseFenceColumn();
  const renderer = shapeRenderer(world);
  t.after(() => disposeShapeRenderer(renderer));
  const ticket = world.dirtySectionRevisions.get("0,0,0");
  assert.equal(renderer.rebuildDirty(Infinity), 24);
  const column = renderer.chunks.get("0,0");
  const target = column.userData.sections.get(0);
  assert.equal(column.userData.sections.size, 24);
  assert.equal(column.userData.meshed, true);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  assert.ok(target.draws > 1);
  assert.equal(target.group.children.length, target.draws);
  assert.equal(
    target.group.children.reduce(
      (sum, mesh) => sum + mesh.geometry.getAttribute("position").count,
      0
    ),
    804864
  );
  assert.deepEqual(
    world.acknowledgments.filter(({ sy }) => sy === 0),
    [{ cx: 0, cz: 0, sy: 0, ticket }]
  );
  assert.equal(world.dirtySectionRevisions.size, 0);
  assert.equal(world.dirtyChunks.size, 0);
  assert.equal(renderer.sectionRejections.size, 0);
  const resources = detailMeshResources(renderer);
  assert.equal(resources.sourceBytes, target.bytes);
  assert.equal(resources.gpuBytes, target.bytes - 804864 * 9);
  assert.equal(resources.drawCalls, target.draws);
  assert.equal(resources.activeJobs, 0);
  assert.equal(resources.snapshotBytes, 0);
  assert.equal(renderer.meshStats.budgetRejections, 0);
  assert.equal(renderer.rebuildDirty(Infinity), 0);
  assert.deepEqual(detailMeshResources(renderer), resources);
});
