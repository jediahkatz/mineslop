import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { meshRevisionCurrent } from "../src/mesh-snapshot.js";
import { clearSectionJobs, DETAIL_MESH_LIMITS, REGIONAL_MESH_LIMITS } from "../src/section-renderer.js";
import { authoredColumns, disposeShapeRenderer, shapeRenderer } from "./shape-fixture.js";

function fixture(t, columns = [[0, 0]], entries = []) {
  let clock = 0, ticketCost = 0;
  t.mock.method(performance, "now", () => clock);
  const world = authoredColumns(columns, entries);
  const get = world.dirtySectionRevisions.get.bind(world.dirtySectionRevisions);
  t.mock.method(world.dirtySectionRevisions, "get", (key) => {
    clock += ticketCost;
    return get(key);
  });
  const renderer = shapeRenderer(world);
  renderer.camera.position.set(8, 8, 8);
  renderer.renderDistanceOverride = 12;
  renderer.meshLimits = { regionalPages: true, maxSliceMs: 2 };
  t.after(() => { clearSectionJobs(renderer); disposeShapeRenderer(renderer); });
  return { world, renderer, chargeTickets: (cost) => { ticketCost = cost; } };
}

function assertFresh(renderer, world, columns) {
  assert.equal(renderer.detailCoverage().size, columns);
  for (const column of renderer.chunks.values()) {
    assert.equal(column.userData.sections.size, 24);
    for (const { stamp } of column.userData.sections.values())
      assert.ok(meshRevisionCurrent(world, { ...stamp, ticket: undefined }));
  }
  assert.equal(world.dirtySectionRevisions.size, 0);
}

for (const maxJobs of [1, 2]) {
  test(`R12 ticket metadata cannot starve a retained job with maxJobs=${maxJobs}`, (t) => {
    const columns = [];
    for (let z = -12; z <= 12; z++)
      for (let x = -12; x <= 12; x++) columns.push([x, z]);
    const { world, renderer, chargeTickets } = fixture(t, columns);
    // Whichever near-view slot wins the priority tie must contain actual work.
    // These are initial authored inputs, before any snapshots exist.
    for (const chunk of world.chunks.values())
      for (let i = 0; i < chunk.blocks.length; i += 4096) chunk.blocks[i] = BLOCK.STONE;
    renderer.meshLimits.maxJobs = 1;
    renderer.sectionMeshLimits = { maxCellsPerSlice: 32 };
    renderer.rebuildDirty(1);
    const job = [...renderer.sectionJobs.values()][0];
    assert.ok(job && !job.done, "start with real yielded mesher work");
    const jobKey = `${job.stamp.cx},${job.stamp.cz},${job.stamp.sy}`;
    const ticket = world.dirtySectionRevisions.get(jobKey);
    renderer.meshLimits.maxJobs = maxJobs;
    // 15,000 ticket reads cost 3ms. This deterministic cost is larger than the
    // unchanged 2ms slice; wall-clock timing assertions would be host-dependent.
    chargeTickets(0.0002);
    const before = job.mesher.cursor;
    for (let slice = 0; slice < 4; slice++) {
      renderer.rebuildDirty(1);
      assert.ok(renderer.meshStats.lastSliceCells > 0, "metadata-only slice starved existing work");
      assert.ok(renderer.meshStats.lastSliceSteps > 0);
      assert.ok(renderer.meshStats.lastSliceCells <= DETAIL_MESH_LIMITS.maxCellsPerSlice);
      assert.ok(renderer.meshStats.lastSliceMs <= 2);
      assert.ok(renderer.sectionJobs.size <= maxJobs);
      assert.equal(renderer.meshStats.limits.maxSliceMs, 2);
      assert.equal(renderer.meshStats.limits.maxGpuBytes, REGIONAL_MESH_LIMITS.maxGpuBytes);
    }
    assert.ok(job.mesher.cursor > before);
    assert.equal(world.dirtySectionRevisions.get(jobKey), ticket);
    assert.equal(renderer.detailCoverage().size, 0, "partial work never becomes full-column coverage");
  });
}

function deferredCandidate(t) {
  const f = fixture(t);
  f.renderer.rebuildDirty(Infinity);
  const layout = f.renderer.sectionQueueLayout;
  const last = layout.slots.at(-1);
  const column = f.renderer.chunks.get(last.columnKey);
  // Remove one empty logical section to put the only missing slot at the end
  // of the retained lattice without changing its view/coordinate identity.
  const section = column.userData.sections.get(last.sy);
  column.remove(section.group);
  column.userData.sections.delete(last.sy);
  column.userData.meshed = false;
  f.world.dirty(last.cx, last.cz, last.sy);
  f.chargeTickets(0.1);
  const ticket = f.world.dirtySectionRevisions.get(last.key);
  assert.equal(f.renderer.rebuildDirty(1), 0);
  assert.equal(f.renderer.sectionJobs.size, 0, "expired selection cannot begin a snapshot");
  assert.equal(f.renderer.meshStats.lastSliceSteps, 0, "no stale prior-slice step metadata");
  assert.equal(f.renderer.sectionQueueLayout.candidate, last);
  return { ...f, last, layout, ticket };
}

test("a deadline-expired selection resumes without repeating the full ticket scan", (t) => {
  const { renderer, world, ticket, last } = deferredCandidate(t);
  assert.equal(renderer.rebuildDirty(1), 1);
  assert.ok(renderer.meshStats.lastSliceMs <= 2);
  assert.ok(world.acknowledgments.some((ack) => ack.sy === last.sy && ack.ticket === ticket));
  assertFresh(renderer, world, 1);
});

test("retained admission rereads edits and acknowledges only the newest ticket", (t) => {
  const { renderer, world, ticket, last, chargeTickets } = deferredCandidate(t);
  world.put(last.cx * 16 + 8, last.sy * 16 + 8, last.cz * 16 + 8, BLOCK.STONE);
  // authoredColumns only dirties the edited section; emulate the world's
  // neighbor invalidation for snapshots that captured this section as apron.
  for (const sy of [last.sy - 1, last.sy + 1])
    if (world.chunks.get(last.columnKey).sectionRevisions.has(sy)) world.dirty(last.cx, last.cz, sy);
  const latest = world.dirtySectionRevisions.get(last.key);
  assert.notEqual(latest, ticket);
  chargeTickets(0);
  renderer.rebuildDirty(Infinity);
  assert.ok(!world.acknowledgments.some((ack) => ack.ticket === ticket));
  assert.ok(world.acknowledgments.some((ack) => ack.ticket === latest));
  assertFresh(renderer, world, 1);
});

test("unload/ABA discards retained admission even when coordinates and map sizes match", (t) => {
  const { renderer, world, layout, ticket, chargeTickets } = deferredCandidate(t);
  const incarnation = world.chunks.get("0,0").incarnation;
  world.chunks.delete("0,0");
  world.removedChunks.add("0,0");
  world.admit(0, 0);
  world.put(8, 8, 8, BLOCK.STONE);
  chargeTickets(0);
  renderer.rebuildDirty(Infinity);
  assert.notEqual(renderer.sectionQueueLayout, layout);
  assert.notEqual(renderer.chunks.get("0,0").userData.incarnation, incarnation);
  assert.ok(!world.acknowledgments.some((ack) => ack.ticket === ticket));
  assertFresh(renderer, world, 1);
});

test("world, radius, camera and projection changes invalidate the retained priority lattice", (t) => {
  const { renderer, layout, chargeTickets } = deferredCandidate(t);
  chargeTickets(0);
  const world = authoredColumns([[0, 0], [3, 0]], [[48, 8, 8, BLOCK.STONE]]);
  renderer.world = world;
  renderer.renderDistanceOverride = 1;
  renderer.rebuildDirty(0);
  assert.notEqual(renderer.sectionQueueLayout, layout);
  assert.equal(renderer.sectionQueueLayout.slots.length, 24);
  let previous = renderer.sectionQueueLayout;
  renderer.renderDistanceOverride = 4;
  renderer.rebuildDirty(0);
  assert.notEqual(renderer.sectionQueueLayout, previous);
  assert.equal(renderer.sectionQueueLayout.slots.length, 48);
  previous = renderer.sectionQueueLayout;
  renderer.camera.rotation.y = Math.PI;
  renderer.rebuildDirty(0);
  assert.notEqual(renderer.sectionQueueLayout, previous);
  previous = renderer.sectionQueueLayout;
  renderer.camera.fov = 100;
  renderer.camera.updateProjectionMatrix();
  renderer.rebuildDirty(0);
  assert.notEqual(renderer.sectionQueueLayout, previous);
  previous = renderer.sectionQueueLayout;
  renderer.camera.position.x += 16;
  renderer.rebuildDirty(0);
  assert.notEqual(renderer.sectionQueueLayout, previous);
  renderer.rebuildDirty(Infinity);
  assertFresh(renderer, world, 2);
});

test("live missing work precedes replacement work without dropping either ticket", (t) => {
  const { renderer, world } = fixture(t);
  renderer.rebuildDirty(Infinity);
  world.put(8, 8, 8, BLOCK.STONE);
  world.admit(1, 0);
  // Loading a neighbor invalidates every previously captured apron.
  for (const sy of world.chunks.get("0,0").sectionRevisions.keys()) world.dirty(0, 0, sy);
  const replacement = world.dirtySectionRevisions.get("0,0,0");
  const count = world.acknowledgments.length;
  renderer.rebuildDirty(1);
  assert.equal(world.acknowledgments[count].cx, 1);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), replacement);
  renderer.rebuildDirty(Infinity);
  assertFresh(renderer, world, 2);
});

test("retained admission refreshes rejection tokens after budget changes", (t) => {
  const { renderer, world } = fixture(t, [[0, 0]], [[8, 8, 8, BLOCK.STONE]]);
  renderer.meshLimits.maxDrawCalls = 0;
  renderer.rebuildDirty(Infinity);
  const ticket = world.dirtySectionRevisions.get("0,0,0");
  const rejections = renderer.meshStats.budgetRejections;
  assert.ok(rejections > 0);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.meshStats.budgetRejections, rejections, "unchanged refusal must stay cached");
  renderer.meshLimits.maxDrawCalls = DETAIL_MESH_LIMITS.maxDrawCalls;
  renderer.rebuildDirty(Infinity);
  assert.ok(world.acknowledgments.some((ack) => ack.ticket === ticket));
  assertFresh(renderer, world, 1);
  assert.ok(renderer.meshStats.peakCombinedCpuBytes <= REGIONAL_MESH_LIMITS.maxCpuBytes);
  assert.ok(renderer.meshStats.peakReservedGpuBytes <= REGIONAL_MESH_LIMITS.maxGpuBytes);
  assert.ok(renderer.meshStats.peakStagingBytes <= REGIONAL_MESH_LIMITS.maxStagingBytes);
});
