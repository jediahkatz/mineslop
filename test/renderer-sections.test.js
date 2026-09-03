import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { partitionGeometries } from "./mesh-partition-fixture.js";
import {
  authoredColumns,
  disposeShapeRenderer,
  shapeRenderer,
} from "./shape-fixture.js";

function fixture(t, entries = [[0, 0, 0, BLOCK.STONE]]) {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([[0, 0]], entries);
  const renderer = shapeRenderer(world);
  // Deterministic unit-work slices; no frame-rate/performance claim.
  renderer.sectionMeshLimits = { maxCellsPerSlice: 4096 };
  t.after(() => disposeShapeRenderer(renderer));
  return { world, renderer };
}

test("one finished section cannot hide distant fallback for an unfinished column", (t) => {
  const { world, renderer } = fixture(t);
  assert.equal(renderer.rebuildDirty(1), 1);
  const column = renderer.chunks.get("0,0");
  assert.equal(column.userData.sections.size, 1);
  assert.equal(column.userData.meshed, false);
  assert.equal(renderer.detailCoverage().has("0,0"), false);
  assert.equal(world.acknowledgments.length, 1);
  assert.equal(world.dirtySectionRevisions.size, 23);
  assert.ok(renderer.meshStats.activeJobs <= 2);
  assert.ok(renderer.meshStats.snapshotBytes <= 2 * (20 ** 3 * 5 + 20 ** 2));
  renderer.rebuildDirty(Infinity);
  assert.equal(column.userData.sections.size, 24);
  assert.equal(column.userData.meshed, true);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  assert.equal(world.dirtySectionRevisions.size, 0);
  assert.equal(world.dirtyChunks.size, 0);
});

test("a completely authored empty column becomes intentional coverage only when all sections finish", (t) => {
  const { renderer } = fixture(t, []);
  renderer.rebuildDirty(1);
  assert.equal(renderer.detailCoverage().size, 0);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  assert.equal(detailMeshResources(renderer).gpuBytes, 0);
  assert.equal(detailMeshResources(renderer).drawCalls, 0);
});

test("yielded replacements and stale retries keep old geometry attached until a valid replacement installs", (t) => {
  const { world, renderer } = fixture(t);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const old = column.userData.sections.get(0);
  let disposed = 0;
  old.group.children[0].geometry.addEventListener("dispose", () => disposed++);
  world.put(2, 0, 0, BLOCK.OAK_SLAB);
  renderer.sectionMeshLimits = { maxCellsPerSlice: 32 };
  renderer.rebuildDirty(1);
  assert.equal(column.userData.sections.get(0), old);
  assert.equal(old.group.parent, column);
  assert.equal(disposed, 0);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  world.put(2, 0, 0, BLOCK.STONE);
  renderer.rebuildDirty(0);
  assert.equal(column.userData.sections.get(0), old);
  assert.equal(disposed, 0);
  assert.ok(renderer.meshStats.staleJobs > 0);
  renderer.rebuildDirty(Infinity);
  assert.notEqual(column.userData.sections.get(0), old);
  assert.equal(old.group.parent, null);
  assert.equal(disposed, 1);
  assert.equal(world.dirtySectionRevisions.has("0,0,0"), false);
});

test("re-admitting identical column coordinates removes the old incarnation even when work is paused", (t) => {
  const { world, renderer } = fixture(t);
  renderer.rebuildDirty(Infinity);
  const old = renderer.chunks.get("0,0");
  const oldIncarnation = old.userData.incarnation;
  let disposed = 0;
  old.traverse((mesh) =>
    mesh.geometry?.addEventListener("dispose", () => disposed++)
  );
  world.removedChunks.add("0,0");
  world.admit(0, 0);
  world.put(1, -20, 1, BLOCK.OAK_SLAB);
  renderer.rebuildDirty(0);
  assert.equal(renderer.chunks.has("0,0"), false);
  assert.equal(renderer.detailCoverage().size, 0);
  assert.equal(disposed, 1);
  renderer.rebuildDirty(Infinity);
  const next = renderer.chunks.get("0,0");
  assert.notEqual(next.userData.incarnation, oldIncarnation);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
});

test("GPU/draw admission is bounded, observable, and preserves old buffers plus dirty work on refusal", (t) => {
  const { world, renderer } = fixture(t);
  renderer.sectionMeshLimits.maxVertices = 4;
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const old = column.userData.sections.get(0);
  let disposed = 0;
  for (const mesh of old.group.children)
    mesh.geometry.addEventListener("dispose", () => disposed++);
  const bytes = detailMeshResources(renderer).gpuBytes;
  renderer.meshLimits = { maxGpuBytes: bytes, maxDrawCalls: old.draws };
  world.put(3, 0, 0, BLOCK.WATER);
  const ticket = world.dirtySectionRevisions.get("0,0,0");
  renderer.rebuildDirty(Infinity);
  assert.equal(column.userData.sections.get(0), old);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), ticket);
  assert.equal(renderer.meshStats.gpuBytes, bytes);
  assert.equal(renderer.meshStats.drawCalls, old.draws);
  assert.equal(disposed, 0);
  assert.equal(renderer.meshStats.materials, 6);
  assert.ok(renderer.meshStats.budgetRejections > 0);
  const rejected = renderer.meshStats.budgetRejections;
  renderer.rebuildDirty(Infinity);
  assert.equal(
    renderer.meshStats.budgetRejections,
    rejected,
    "unchanged refusals do not rebuild forever"
  );
  world.put(0, 0, 0, BLOCK.AIR);
  world.put(3, 0, 0, BLOCK.AIR);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.meshStats.gpuBytes, 0);
  assert.equal(renderer.meshStats.drawCalls, 0);
  assert.equal(disposed, old.draws);
  assert.equal(world.dirtySectionRevisions.has("0,0,0"), false);
});

test("a smaller replacement releases capacity for previously rejected sections without a new cell edit", (t) => {
  const { world, renderer } = fixture(t, [
    [0, 0, 0, BLOCK.STONE],
    [0, 16, 0, BLOCK.STONE],
  ]);
  renderer.meshLimits = { maxDrawCalls: 1 };
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  assert.ok(column.userData.sections.has(0));
  assert.equal(column.userData.sections.has(1), false);
  const rejectedTicket = world.dirtySectionRevisions.get("0,0,1");
  world.put(0, 0, 0, BLOCK.AIR);
  renderer.rebuildDirty(Infinity);
  assert.equal(column.userData.sections.has(1), true);
  assert.equal(renderer.meshStats.drawCalls, 1);
  assert.ok(
    world.acknowledgments.some(
      ({ sy, ticket }) => sy === 1 && ticket === rejectedTicket
    )
  );
  assert.equal(renderer.detailCoverage().has("0,0"), true);
});

test("an explicit budget change retries rejected dirty work without losing its ticket", (t) => {
  const { world, renderer } = fixture(t);
  renderer.meshLimits = { maxGpuBytes: 0 };
  renderer.rebuildDirty(Infinity);
  const ticket = world.dirtySectionRevisions.get("0,0,0");
  assert.equal(renderer.chunks.get("0,0").userData.sections.has(0), false);
  renderer.meshLimits = { maxGpuBytes: 4096 };
  renderer.rebuildDirty(Infinity);
  assert.ok(
    world.acknowledgments.some(
      ({ sy, ticket: done }) => sy === 0 && done === ticket
    )
  );
  assert.equal(renderer.detailCoverage().has("0,0"), true);
});

test("emitter/material budgets remain column-wide across sections and disposal releases every geometry", (t) => {
  const entries = Array.from({ length: 32 }, (_, i) => [
    i % 16,
    Math.floor(i / 16) * 16,
    2,
    BLOCK.TORCH,
  ]);
  const { renderer } = fixture(t, entries);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  assert.ok(column.userData.emitters.length <= 12);
  assert.equal(renderer.meshStats.materials, 6);
  let buffers = 0,
    disposed = 0;
  column.traverse((mesh) => {
    if (!mesh.geometry) return;
    buffers++;
    mesh.geometry.addEventListener("dispose", () => disposed++);
  });
  assert.ok(buffers >= 2);
  renderer.removeChunk("0,0");
  assert.equal(disposed, buffers);
  assert.equal(detailMeshResources(renderer).gpuBytes, 0);
  assert.equal(renderer.sectionJobs.size, 0);
});

test("a section publishes no parts or ticket until all cells finish, and coverage needs every draw", (t) => {
  const { world, renderer } = fixture(t);
  renderer.sectionMeshLimits = { maxVertices: 4, maxCellsPerSlice: 1 };
  const ticket = world.dirtySectionRevisions.get("0,0,0");
  assert.equal(renderer.rebuildDirty(1), 0);
  const job = renderer.sectionJobs.get("0,0,0");
  assert.ok(job.mesher.context.parts.length > 1);
  assert.equal(job.result, null);
  assert.equal(renderer.chunks.has("0,0"), false);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), ticket);
  assert.equal(world.acknowledgments.length, 0);
  assert.equal(renderer.detailCoverage().size, 0);

  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const section = column.userData.sections.get(0);
  assert.equal(section.draws, 6);
  assert.equal(section.group.children.length, section.draws);
  assert.equal(renderer.meshStats.drawCalls, section.draws);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  assert.deepEqual(
    world.acknowledgments.filter(({ sy }) => sy === 0),
    [{ cx: 0, cz: 0, sy: 0, ticket }]
  );
  const part = section.group.children[0];
  section.group.remove(part);
  assert.equal(renderer.detailCoverage().has("0,0"), false);
  section.group.add(part);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  part.visible = false;
  assert.equal(renderer.detailCoverage().has("0,0"), false);
  part.visible = true;
  assert.equal(renderer.detailCoverage().has("0,0"), true);
});

test("multi-part replacements retain every old draw while pending and dispose every stale part", (t) => {
  const { world, renderer } = fixture(t);
  renderer.sectionMeshLimits.maxVertices = 4;
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const old = column.userData.sections.get(0);
  assert.equal(old.group.children.length, 6);
  let oldDisposed = 0;
  for (const mesh of old.group.children)
    mesh.geometry.addEventListener("dispose", () => oldDisposed++);
  world.put(2, 0, 0, BLOCK.OAK_SLAB);
  renderer.sectionMeshLimits.maxCellsPerSlice = 1;
  assert.equal(renderer.rebuildDirty(1), 0);
  const pending = renderer.sectionJobs.get("0,0,0");
  const staged = partitionGeometries({ parts: pending.mesher.context.parts });
  assert.ok(staged.length > 1);
  let stagedDisposed = 0;
  for (const geometry of staged)
    geometry.addEventListener("dispose", () => stagedDisposed++);
  assert.equal(column.userData.sections.get(0), old);
  assert.equal(oldDisposed, 0);
  assert.equal(renderer.detailCoverage().has("0,0"), true);

  const newer = world.dirty(0, 0, 0);
  renderer.rebuildDirty(0);
  assert.equal(stagedDisposed, staged.length);
  assert.equal(column.userData.sections.get(0), old);
  assert.equal(old.group.parent, column);
  assert.equal(oldDisposed, 0);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), newer);
  renderer.rebuildDirty(Infinity);
  const replacement = column.userData.sections.get(0);
  assert.notEqual(replacement, old);
  assert.equal(replacement.group.children.length, replacement.draws);
  assert.ok(replacement.draws > old.draws);
  assert.equal(old.group.parent, null);
  assert.equal(oldDisposed, 6);
  assert.equal(
    stagedDisposed,
    staged.length,
    "stale buffers are not disposed twice"
  );
  assert.equal(world.dirtySectionRevisions.has("0,0,0"), false);
  assert.equal(world.acknowledgments.at(-1).ticket, newer);
});

for (const [name, limits] of [
  ["draw", { maxDrawCalls: 6 }],
  ["byte", { maxGpuBytes: 6 * (4 * 11 * 4 + 6 * 2) }],
]) {
  test(`global ${name} admission sums all partitions and retries cached refusals only after capacity changes`, (t) => {
    const { world, renderer } = fixture(t, [
      [0, 0, 0, BLOCK.STONE],
      [0, 16, 0, BLOCK.STONE],
    ]);
    renderer.sectionMeshLimits.maxVertices = 4;
    renderer.meshLimits = limits;
    const ticket = world.dirtySectionRevisions.get("0,0,1");
    renderer.rebuildDirty(Infinity);
    const column = renderer.chunks.get("0,0");
    const first = column.userData.sections.get(0);
    assert.equal(first.draws, 6);
    assert.equal(column.userData.sections.has(1), false);
    assert.equal(renderer.meshStats.drawCalls, first.draws);
    assert.equal(renderer.meshStats.gpuBytes, first.bytes);
    assert.equal(renderer.detailCoverage().has("0,0"), false);
    assert.equal(world.dirtySectionRevisions.get("0,0,1"), ticket);
    const token = renderer.sectionRejections.get("0,0,1");
    const rejections = renderer.meshStats.budgetRejections;
    assert.ok(token);
    assert.equal(renderer.rebuildDirty(Infinity), 0);
    assert.equal(renderer.meshStats.budgetRejections, rejections);
    assert.equal(renderer.sectionRejections.get("0,0,1"), token);

    let disposed = 0;
    for (const mesh of first.group.children)
      mesh.geometry.addEventListener("dispose", () => disposed++);
    world.put(0, 0, 0, BLOCK.AIR);
    renderer.rebuildDirty(Infinity);
    assert.equal(disposed, first.draws);
    assert.equal(column.userData.sections.get(1).draws, 6);
    assert.equal(renderer.meshStats.drawCalls, 6);
    assert.equal(renderer.meshStats.gpuBytes, first.bytes);
    assert.equal(renderer.detailCoverage().has("0,0"), true);
    assert.equal(renderer.sectionRejections.has("0,0,1"), false);
    assert.ok(
      world.acknowledgments.some(
        ({ sy, ticket: acknowledged }) => sy === 1 && acknowledged === ticket
      )
    );
  });
}

test("a failure constructing a later part disposes the entire replacement but retains the installed section", (t) => {
  const { world, renderer } = fixture(t);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const old = column.userData.sections.get(0);
  const oldGeometry = old.group.children[0].geometry;
  const ticket = world.dirty(0, 0, 0);
  renderer.sectionMeshLimits.maxVertices = 4;
  const disposed = [];
  const original = THREE.BufferGeometry.prototype.dispose;
  t.mock.method(THREE.BufferGeometry.prototype, "dispose", function () {
    disposed.push(this);
    original.call(this);
  });
  const materials = renderer.materials;
  let reads = 0;
  renderer.materials = new Proxy(materials, {
    get(target, key) {
      if (key === "opaque" && ++reads === 2)
        throw new Error("later-part assembly failure");
      return target[key];
    },
  });
  try {
    assert.throws(
      () => renderer.rebuildDirty(Infinity),
      /later-part assembly failure/
    );
  } finally {
    renderer.materials = materials;
  }
  assert.equal(disposed.length, 6);
  assert.equal(disposed.includes(oldGeometry), false);
  assert.equal(renderer.sectionJobs.has("0,0,0"), false);
  assert.equal(column.userData.sections.get(0), old);
  assert.equal(old.group.parent, column);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), ticket);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  renderer.rebuildDirty(Infinity);
  assert.notEqual(column.userData.sections.get(0), old);
  assert.equal(
    disposed.filter((geometry) => geometry === oldGeometry).length,
    1
  );
  assert.equal(world.dirtySectionRevisions.has("0,0,0"), false);
});

test("a budget change during staging disposes old work instead of caching its refusal under the new limits", (t) => {
  const { world, renderer } = fixture(t, [
    [0, 0, 0, BLOCK.STONE],
    [3, 0, 0, BLOCK.STONE],
  ]);
  renderer.sectionMeshLimits = { maxVertices: 4, maxCellsPerSlice: 1 };
  renderer.meshLimits = { maxDrawCalls: 6 };
  const ticket = world.dirtySectionRevisions.get("0,0,0");
  renderer.rebuildDirty(1);
  const pending = renderer.sectionJobs.get("0,0,0");
  const staged = partitionGeometries({ parts: pending.mesher.context.parts });
  assert.ok(staged.length > 1);
  let disposed = 0;
  for (const geometry of staged)
    geometry.addEventListener("dispose", () => disposed++);
  renderer.meshLimits = { maxDrawCalls: 12 };
  renderer.rebuildDirty(Infinity);
  assert.equal(pending.status, "disposed");
  assert.equal(disposed, staged.length);
  assert.equal(renderer.sectionRejections.has("0,0,0"), false);
  assert.equal(renderer.meshStats.budgetRejections, 0);
  assert.equal(renderer.meshStats.drawCalls, 12);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  assert.deepEqual(
    world.acknowledgments.filter(({ sy }) => sy === 0),
    [{ cx: 0, cz: 0, sy: 0, ticket }]
  );
});

test("a ticket change while assembling later parts rejects the whole detached group", (t) => {
  const { world, renderer } = fixture(t);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const old = column.userData.sections.get(0);
  const oldGeometry = old.group.children[0].geometry;
  world.dirty(0, 0, 0);
  renderer.sectionMeshLimits.maxVertices = 4;
  const disposed = [];
  const original = THREE.BufferGeometry.prototype.dispose;
  t.mock.method(THREE.BufferGeometry.prototype, "dispose", function () {
    disposed.push(this);
    original.call(this);
  });
  const materials = renderer.materials;
  let reads = 0,
    newer;
  renderer.materials = new Proxy(materials, {
    get(target, key) {
      if (key === "opaque" && ++reads === 2) newer = world.dirty(0, 0, 0);
      return target[key];
    },
  });
  try {
    assert.equal(renderer.rebuildDirty(1), 0);
  } finally {
    renderer.materials = materials;
  }
  assert.equal(disposed.length, 6);
  assert.equal(disposed.includes(oldGeometry), false);
  assert.equal(column.userData.sections.get(0), old);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), newer);
  assert.equal(world.acknowledgments.length, 24);
  assert.equal(renderer.detailCoverage().has("0,0"), true);
  assert.ok(renderer.meshStats.staleJobs > 0);
  renderer.rebuildDirty(Infinity);
  assert.notEqual(column.userData.sections.get(0), old);
  assert.equal(world.acknowledgments.at(-1).ticket, newer);
  assert.equal(
    disposed.filter((geometry) => geometry === oldGeometry).length,
    1
  );
});
