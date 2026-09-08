import assert from "node:assert/strict";
import test from "node:test";
import { prepareArrivalMeshes, arrivalMeshesReady } from "../src/renderer-arrival.js";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";
import { BLOCK } from "../src/blocks.js";
import { meshRevisionCurrent } from "../src/mesh-snapshot.js";

const columns = Array.from({ length: 25 }, (_, i) => [i % 5 - 2, Math.floor(i / 5) - 2]);
const pose = { position: { x: 8, y: 53.01, z: 8 }, yaw: 0, pitch: -0.12 };

test("arrival publishes fresh physical R1 before presentation using unchanged slice caps", async t => {
  const world = authoredColumns(columns, [[8, 52, 8, BLOCK.STONE]]);
  const renderer = shapeRenderer(world);
  renderer.meshLimits = { regionalPages: true, maxCellsPerSlice: 512 };
  renderer.renderDistanceOverride = 12;
  let yields = 0, maxUnits = 0, maxCopy = 0;
  try {
    assert.equal(arrivalMeshesReady(renderer, pose.position), false);
    await prepareArrivalMeshes(renderer, pose, { yieldFrame: async () => {
      yields++;
      maxUnits = Math.max(maxUnits, renderer.meshStats?.lastSliceCells ?? 0);
      maxCopy = Math.max(maxCopy, renderer.meshStats?.lastSliceCopyBytes ?? 0);
      assert.ok(yields < 2000, "arrival work failed to finish");
    } });
    assert.ok(yields > 1);
    assert.ok(maxUnits <= 512);
    assert.ok(maxCopy <= 1024 * 1024);
    assert.equal(renderer.renderRadius, 12);
    assert.equal(renderer.arrivalCenter, undefined);
    assert.ok(arrivalMeshesReady(renderer, pose.position));
    assert.ok([...world.dirtySectionRevisions.keys()].some(k => k.startsWith("2,2,")),
      "arrival must not drain the R2/far cohort");
    const section = renderer.chunks.get("0,0").userData.sections.get(3);
    assert.ok(section.bytes > 0);
    assert.ok(meshRevisionCurrent(world, { ...section.stamp, ticket: undefined }));
    world.put(8, 52, 8, BLOCK.DIRT);
    assert.equal(arrivalMeshesReady(renderer, pose.position), false, "freshness cannot be cached across edits");
    t.diagnostic(JSON.stringify({ yields, maxUnits, maxCopy, nativeSectionBytes: section.bytes }));
  } finally { disposeShapeRenderer(renderer); }
});

test("arrival cancellation releases its queue restriction and never acknowledges missing surfaces", async () => {
  const world = authoredColumns(columns);
  const renderer = shapeRenderer(world);
  renderer.meshLimits = { regionalPages: true };
  let cancelled = false;
  try {
    await assert.rejects(prepareArrivalMeshes(renderer, pose, {
      yieldFrame: async () => { cancelled = true; },
      validate: () => { if (cancelled) throw new Error("cancelled"); },
    }), /cancelled/);
    assert.equal(renderer.arrivalCenter, undefined);
    assert.equal(arrivalMeshesReady(renderer, pose.position), false);
  } finally { disposeShapeRenderer(renderer); }
});

test("arrival never loops indefinitely on a refused resource admission", async () => {
  const world = authoredColumns(columns, [[8, 52, 8, BLOCK.STONE]]);
  const renderer = shapeRenderer(world);
  renderer.meshLimits = { regionalPages: true, maxCpuBytes: 1, maxStagingBytes: 1 };
  try {
    await assert.rejects(prepareArrivalMeshes(renderer, pose, { yieldFrame: async () => {} }), /arrival.*budget/i);
    assert.equal(renderer.arrivalCenter, undefined);
  } finally { disposeShapeRenderer(renderer); }
});

test("arrival rechecks world identity after yielding, before any meshing", async () => {
  const world = authoredColumns(columns), renderer = shapeRenderer(world);
  renderer.meshLimits = { regionalPages: true };
  try {
    await assert.rejects(prepareArrivalMeshes(renderer, pose, { yieldFrame: async () => { world.epoch++; } }),
      /Arrival world changed/);
    assert.equal(renderer.sectionJobs?.size ?? 0, 0);
    assert.equal(renderer.chunks.size, 0);
    assert.equal(renderer.arrivalCenter, undefined);
  } finally { disposeShapeRenderer(renderer); }
});

test("arrival rejects a lost context without spending or acknowledging work", async () => {
  const world = authoredColumns(columns), renderer = shapeRenderer(world);
  renderer.renderer = { getContext: () => ({ isContextLost: () => true }) };
  try {
    await assert.rejects(prepareArrivalMeshes(renderer, pose, { yieldFrame: async () => assert.fail("yielded") }),
      /Arrival GPU context/);
    assert.equal(renderer.chunks.size, 0);
  } finally { disposeShapeRenderer(renderer); }
});
