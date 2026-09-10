import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { meshRevisionCurrent } from "../src/mesh-snapshot.js";
import { publishedNativeBoundaries } from "../src/native-boundary-profile.js";
import { MAX_RESIDENT_CHUNKS } from "../src/render-distance.js";
import { resolveRenderMode } from "../src/render-mode-preferences.js";
import {
  clearSectionJobs, detailMeshResources, DETAIL_MESH_LIMITS, REGIONAL_MESH_LIMITS,
} from "../src/section-renderer.js";
import { registerTotalSurface } from "../src/surface-availability.js";
import { CHUNK_SIZE, World, WORLD_MIN, WORLD_MAX } from "../src/world.js";
import { fluidFixture, fluidSteps } from "./fluid-fixture.js";
import { horseFixture } from "./horse-fixture.js";
import { markNativeNeighbors } from "./regional-native-fixture.js";
import { authoredColumns, disposeShapeRenderer, shapeRenderer } from "./shape-fixture.js";

// Separate CPU layers: real World scheduling with controlled transport; real
// section/LOD owners in a small authored host; a bounded native World edit.
// No Game, WebGL output, FPS, complete-scene or simulation-area qualification.
const MAX_UPDATES = 96;
const position = (cx = 0, cz = 0) => ({ x: cx * 16 + 8, z: cz * 16 + 8 });
const square = (cx, cz, radius) => {
  const keys = [];
  for (let z = cz - radius; z <= cz + radius; z++)
    for (let x = cx - radius; x <= cx + radius; x++) keys.push(`${x},${z}`);
  return keys.sort();
};

function assertWorldBounds(world) {
  assert.equal(MAX_RESIDENT_CHUNKS, 841);
  assert.ok(world.chunks.size <= 841);
  assert.ok(world._requests.size <= 841);
  assert.ok(world._inFlight.size <= 2);
  assert.ok(new Set([...world.chunks.keys(),
    ...[...world._inFlight.values()].map((request) => request.key)]).size <= 841);
  assert.equal(world._pins.size, 0, "streaming is not propped up by explicit area pins");
}

function assertResidentSquare(world, cx, cz, radius) {
  const keys = square(cx, cz, radius + 2);
  assert.deepEqual([...world.chunks.keys()].sort(), keys);
  const { inflight } = world.streamingStatus();
  assert.deepEqual(world.streamingStatus(), {
    demand: keys.length, loaded: keys.length, missing: 0, inflight, error: 0,
  });
  assertWorldBounds(world);
}

// Same controlled transport as streaming.test.js: the real scheduler owns
// queueing, cancellation, physical slots, packet validation and admission.
function workerWorld(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers = [];
  class ControlledWorker {
    constructor() {
      this.pending = new Map();
      this.sent = [];
      this.maxPending = 0;
      workers.push(this);
    }
    postMessage(request) {
      this.sent.push(request);
      this.pending.set(request.id, request);
      this.maxPending = Math.max(this.maxPending, this.pending.size);
    }
    reply(request) {
      this.pending.delete(request.id);
      const blocks = new Uint16Array((request.maxY - request.minY) * 256);
      blocks[(1 - request.minY) * 256 + 8 * 16 + 8] = BLOCK.STONE;
      this.onmessage({ data: {
        ...request, type: "chunk", encoding: "u16", blocks, biomes: new Uint8Array(256),
      } });
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true, writable: true, value: ControlledWorker,
  });
  const world = new World("nearby-scheduler", { generatorVersion: 3 });
  t.mock.method(world.generator, "generateChunk", () =>
    assert.fail("controlled transport must not silently fall back to terrain generation"));
  t.after(() => {
    world.dispose();
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor);
    else delete globalThis.Worker;
  });
  return { world, workers };
}

function settleStreaming(t, world, workers = [], held = new Set()) {
  const pending = () => world._requests.size ||
    [...world._inFlight.keys()].some((id) => !held.has(id));
  let tasks = 0;
  while (pending() && tasks++ < 2 * MAX_RESIDENT_CHUNKS) {
    t.mock.timers.tick(1);
    assertWorldBounds(world);
    for (const worker of workers)
      for (const request of [...worker.pending.values()]) {
        if (held.has(request.id)) continue;
        worker.reply(request);
        assertWorldBounds(world);
      }
  }
  assert.equal(world._requests.size, 0, "finite scheduler fixture must settle");
  assert.ok([...world._inFlight.keys()].every((id) => held.has(id)));
  assert.deepEqual(world.admissionObserverErrors, []);
}

for (const [quality, radius, residents] of [["low", 2, 81], ["medium", 3, 121]]) {
  test(`R12 -> Nearby R${radius} -> R12 retains exactly ${residents}/841 columns and rejects two obsolete replies`, (t) => {
    const { world, workers } = workerWorld(t);
    const nearby = resolveRenderMode({ version: 1, mode: "nearby", nearbyRadius: null }, 12, quality);
    const extended = resolveRenderMode({ version: 1, mode: "extended", nearbyRadius: null }, 12, quality);
    assert.equal(nearby.radius, radius);
    assert.equal(extended.radius, 12);
    world.updateStreaming(position(), extended.radius);
    settleStreaming(t, world, workers);
    assertResidentSquare(world, 0, 0, 12);
    assert.equal(world.set(8, 10, 8, BLOCK.GLASS), true);
    assert.equal(world.set(8 * 16 + 8, 10, 8, BLOCK.BRICK), true);
    const original = {
      generator: world.generator, epoch: world.epoch, version: world.generatorVersion,
      coordinator: world.coordinator, chunks: world.chunks, edits: world.edits,
      save: world.serialize(), near: world.chunks.get("0,0"), far: world.chunks.get("8,0"),
    };
    world.updateStreaming(position(1), extended.radius);
    t.mock.timers.tick(1);
    const worker = workers[0], obsolete = [...worker.pending.values()];
    assert.equal(obsolete.length, 2);
    assert.ok(obsolete.every((request) => request.cx === 15));
    world.updateStreaming(position(), nearby.radius);
    assertResidentSquare(world, 0, 0, radius);
    assert.equal(world.chunks.size, residents);
    assert.equal(world._inFlight.size, 2, "logical cancellation retains both physical reservations");
    worker.reply(obsolete[0]);
    assert.equal(world.chunks.has(`${obsolete[0].cx},${obsolete[0].cz}`), false);

    const held = new Set([obsolete[1].id]);
    let sent = worker.sent.length;
    world.updateStreaming(position(1), nearby.radius);
    settleStreaming(t, world, workers, held);
    assertResidentSquare(world, 1, 0, radius);
    assert.equal(worker.sent.length - sent, 2 * (radius + 2) + 1, "one new frontier row");
    sent = worker.sent.length;
    world.updateStreaming(position(), nearby.radius);
    settleStreaming(t, world, workers, held);
    assertResidentSquare(world, 0, 0, radius);
    assert.equal(worker.sent.length - sent, 2 * (radius + 2) + 1, "reversal restores the evicted row");

    // The second cancelled response arrives after its coordinates are wanted
    // again. It must not satisfy a new logical request with the old job ID.
    world.updateStreaming(position(1), extended.radius);
    const stale = obsolete[1], key = `${stale.cx},${stale.cz}`;
    const fresh = world._requests.get(key);
    assert.ok(fresh && fresh.id !== stale.id);
    worker.reply(stale);
    assert.equal(world.chunks.has(key), false, "obsolete ABA reply cannot resurrect a column");
    assert.equal(world._requests.get(key), fresh, "the new frontier ticket remains outstanding");
    settleStreaming(t, world, workers);
    assertResidentSquare(world, 1, 0, 12);
    assert.notEqual(world.chunks.get("8,0").incarnation, original.far.incarnation);
    assert.equal(world.chunks.get("0,0"), original.near);
    assert.equal(world.get(8, 10, 8), BLOCK.GLASS);
    assert.equal(world.get(8 * 16 + 8, 10, 8), BLOCK.BRICK);
    for (const [name, value] of Object.entries({
      generator: original.generator, epoch: original.epoch, generatorVersion: original.version,
      coordinator: original.coordinator, chunks: original.chunks, edits: original.edits,
    })) assert.equal(world[name], value, name);
    assert.deepEqual(world.serialize(), original.save);
    assert.equal(workers.length, 1);
    assert.equal(worker.maxPending, 2);
    t.diagnostic(JSON.stringify({ layer: "real World / controlled worker packets", radius,
      residentCounts: [841, residents, residents, residents, 841],
      obsoleteReplies: 2, frontierWidth: 2 * (radius + 2) + 1,
      maxPhysicalJobs: worker.maxPending, pinned: world._pins.size }));
  });
}

function rendererHost(t, world, { regional = true } = {}) {
  // A deterministic CPU unit-work clock, not a wall-time/performance oracle.
  t.mock.method(performance, "now", () => 0);
  const renderer = shapeRenderer(world);
  renderer.scene.fog = new THREE.Fog("#ffffff", 10, 64);
  renderer.renderer = { getContext: () => ({
    MAX_TEXTURE_SIZE: 1, MAX_ARRAY_TEXTURE_LAYERS: 2, MAX_TEXTURE_IMAGE_UNITS: 3,
    isContextLost: () => false,
    getParameter: (key) => ({ 1: 2048, 2: 256, 3: 16 })[key],
  }) };
  renderer.quality = "medium";
  renderer.camera.position.set(8, 8, 12);
  renderer.camera.lookAt(8, 8, 8);
  if (regional) renderer.meshLimits = { regionalPages: true };
  t.after(() => {
    clearSectionJobs(renderer);
    disposeShapeRenderer(renderer);
    renderer.distant?.dispose();
  });
  return renderer;
}

function assertSectionBounds(renderer) {
  const { limits, lastSliceCells, lastSliceSteps, lastSliceCopyBytes } = renderer.meshStats;
  assert.ok(renderer.sectionJobs.size <= limits.maxJobs);
  assert.ok(limits.maxJobs <= 2);
  assert.ok(limits.maxCellsPerSlice <= DETAIL_MESH_LIMITS.maxCellsPerSlice);
  assert.ok(limits.maxStepsPerSlice <= DETAIL_MESH_LIMITS.maxStepsPerSlice);
  assert.ok(limits.maxCopyBytesPerSlice <= DETAIL_MESH_LIMITS.maxCopyBytesPerSlice);
  assert.ok(lastSliceCells <= limits.maxCellsPerSlice);
  assert.ok(lastSliceSteps <= DETAIL_MESH_LIMITS.maxStepsPerSlice);
  assert.ok(lastSliceCopyBytes <= DETAIL_MESH_LIMITS.maxCopyBytesPerSlice);
  assert.ok(limits.maxSliceMs <= DETAIL_MESH_LIMITS.maxSliceMs);
  assert.ok(limits.maxGpuBytes <= REGIONAL_MESH_LIMITS.maxGpuBytes);
  assert.notEqual(renderer.meshLimits?.experimentalColdTailSealing, true);
  assert.notEqual(renderer.waterFusionEnabled, true);
}

function until(step, done, label) {
  let updates = 0;
  while (!done() && updates < MAX_UPDATES) { step(); updates++; }
  assert.ok(done(), `${label} did not finish in ${MAX_UPDATES} bounded updates`);
  return updates;
}

function sectionStep(renderer) {
  renderer.rebuildDirty(2);
  assertSectionBounds(renderer);
}

test("Nearby keeps a yielded near section and its certificates, retires far pages, and reuses the hidden reversal row", (t) => {
  const world = authoredColumns([[0, 0], [3, 0], [8, 0]], [
    [8, 8, 8, BLOCK.STONE], [15, 79, 8, BLOCK.STONE],
    [56, 8, 8, BLOCK.STONE], [136, 8, 8, BLOCK.STONE],
  ]);
  const renderer = rendererHost(t, world);
  renderer.configureTerrain({ radius: 12, distantTerrain: true });
  const initialUpdates = until(() => sectionStep(renderer),
    () => world.dirtySectionRevisions.size === 0, "initial three-column sections");
  const near = renderer.chunks.get("0,0"), hidden = renderer.chunks.get("3,0");
  const far = renderer.chunks.get("8,0"), farPage = far.userData.sectionRegion.userData.pages[0];
  const old = near.userData.sections.get(0), certificate = near.userData.nativeBoundarySources.get(4);
  assert.ok(certificate?.some(Number.isFinite), "normal installed boundary certificate is retained");
  let disposedFarPage = 0;
  farPage.geometry.addEventListener("dispose", () => disposedFarPage++);
  world.put(9, 8, 8, BLOCK.BRICK);
  markNativeNeighbors({ world }, 0, 0, 0);
  renderer.sectionMeshLimits = { maxCellsPerSlice: 32 };
  until(() => sectionStep(renderer), () => renderer.sectionJobs.get("0,0,0")?.status === "pending",
    "yielded near edit");
  const job = renderer.sectionJobs.get("0,0,0"), ticket = world.dirtySectionRevisions.get("0,0,0");
  assert.ok(job && !job.done, "real meshing must yield before the toggle");
  assert.equal(near.userData.sections.get(0), old);
  const previous = renderer.distant, chunks = renderer.chunks;
  renderer.detailBatchCoverage();
  renderer.configureTerrain({ radius: 2, distantTerrain: false });
  renderer.rebuildDirty(0);
  assert.equal(renderer.sectionJobs.get("0,0,0"), job);
  assert.equal(renderer.chunks, chunks);
  assert.equal(renderer.chunks.get("0,0"), near);
  assert.equal(previous._disposed, true);
  assert.equal(renderer.distant, null);
  assert.equal(renderer.detailBatchCache, null);
  assert.equal(renderer.chunks.has("8,0"), false);
  assert.equal(far.parent, null);
  assert.equal(disposedFarPage, 1);
  assert.equal(renderer.chunks.get("3,0"), hidden);
  assert.equal(hidden.visible, false);
  const resumedUpdates = until(() => sectionStep(renderer),
    () => !world.dirtySectionRevisions.has("0,0,0"), "retained near edit");
  assert.equal(near.userData.sections.get(0).stamp.ticket, ticket);
  assert.equal(old.group.parent, null);
  assert.equal(near.userData.nativeBoundarySources.get(4), certificate, "no certificate rebuild on mode change");
  renderer.camera.position.x += CHUNK_SIZE;
  renderer.rebuildDirty(0);
  assert.equal(renderer.chunks.get("3,0"), hidden);
  assert.equal(hidden.visible, true);
  renderer.camera.position.x -= CHUNK_SIZE;
  renderer.rebuildDirty(0);
  assert.equal(renderer.chunks.get("3,0"), hidden);
  assert.equal(hidden.visible, false);
  renderer.configureTerrain({ radius: 12, distantTerrain: true });
  assert.notEqual(renderer.distant, previous);
  const expandedUpdates = until(() => sectionStep(renderer),
    () => renderer.detailCoverage().size === 3 && world.dirtySectionRevisions.size === 0,
    "expanded section coverage");
  assert.notEqual(renderer.chunks.get("8,0"), far);
  assert.equal(renderer.chunks.get("0,0"), near);
  assert.equal(near.userData.nativeBoundarySources.get(4), certificate);
  assert.equal(world.get(9, 8, 8), BLOCK.BRICK);
  t.diagnostic(JSON.stringify({ layer: "real section renderer / three authored columns",
    initialUpdates, resumedUpdates, expandedUpdates, disposedFarPage, covered: renderer.detailCoverage().size }));
});

test("Nearby publishes nonempty and intentionally empty edits in a real nine-column native World", (t) => {
  const world = new World("cedar-valley", { generatorVersion: 4, useWorker: false });
  t.after(() => world.dispose());
  // Fixed 3x3 native input for one section's apron, not a completed R2 scene.
  for (let z = -1; z <= 1; z++)
    for (let x = -1; x <= 1; x++) world._generateSync(x, z);
  const renderer = rendererHost(t, world, { regional: false });
  renderer.configureTerrain({ radius: 2, distantTerrain: false });
  const y = world.maxY - 8, sy = Math.floor(y / 16), key = `0,0,${sy}`;
  renderer.camera.position.set(15, y, 12);
  renderer.camera.lookAt(15, y, 8);
  const identity = {
    generator: world.generator, epoch: world.epoch, chunk: world.chunks.get("0,0"),
    save: world.serialize(),
  };
  assert.equal(world.get(15, y, 8), BLOCK.AIR);
  assert.equal(world.set(15, y, 8, BLOCK.BRICK), true);
  const ticket = world.dirtySectionRevisions.get(key);
  const placedUpdates = until(() => sectionStep(renderer),
    () => renderer.chunks.get("0,0")?.userData.sections.get(sy)?.stamp.ticket === ticket &&
      !world.dirtySectionRevisions.has(key), "native edited nonempty section");
  const column = renderer.chunks.get("0,0"), installed = column.userData.sections.get(sy);
  assert.ok(installed.bytes > 0 && installed.draws > 0);
  assert.ok(meshRevisionCurrent(world, { ...installed.stamp, ticket: undefined }));
  assert.ok(installed.group.userData.nativeBoundary?.some(Number.isFinite));
  assert.equal(installed.group.parent, column);
  assert.equal(world.set(15, y, 8, BLOCK.AIR), true);
  const removed = world.dirtySectionRevisions.get(key);
  const emptiedUpdates = until(() => sectionStep(renderer),
    () => column.userData.sections.get(sy)?.stamp.ticket === removed &&
      !world.dirtySectionRevisions.has(key), "native edited empty section");
  const empty = column.userData.sections.get(sy);
  assert.equal(empty.bytes, 0);
  assert.equal(empty.draws, 0);
  assert.equal(empty.group.children.length, 0);
  assert.equal(empty.group.userData.nativeBoundary, null);
  assert.ok(meshRevisionCurrent(world, { ...empty.stamp, ticket: undefined }));
  assert.equal(installed.group.parent, null);
  assert.equal(world.chunks.size, 9);
  assert.equal(world.generator.counters.chunkGenerations, 9);
  assert.equal(world.generator, identity.generator);
  assert.equal(world.epoch, identity.epoch);
  assert.equal(world.chunks.get("0,0"), identity.chunk);
  assert.equal(renderer.distant, null);
  assert.equal(world.get(15, y, 8), BLOCK.AIR);
  assert.deepEqual(world.serialize(), identity.save, "restoring native air elides only the redundant saved delta");
  t.diagnostic(JSON.stringify({ layer: "real native v4 World + real section renderer",
    nativeColumns: 9, placedUpdates, emptiedUpdates, nonemptyDraws: installed.draws,
    emptyDraws: empty.draws, remainingDirty: world.dirtySectionRevisions.size }));
});

function seamHost(t) {
  const world = authoredColumns([[0, 0]], [[8, 8, 8, BLOCK.STONE]]);
  world.generator = {
    terrainHeight: () => 63, getBiome: () => ({ id: "plains", color: "#83ac52" }),
  };
  registerTotalSurface(world.generator, {
    minX: WORLD_MIN, maxX: WORLD_MAX, minZ: WORLD_MIN, maxZ: WORLD_MAX,
  });
  const renderer = rendererHost(t, world);
  renderer.camera.position.set(8, 80, 8);
  renderer.configureTerrain({ radius: 12, distantTerrain: true });
  const step = () => {
    sectionStep(renderer);
    const lod = renderer.distant;
    if (!lod) return;
    const batches = renderer.detailBatchCoverage(), owners = new Set();
    lod.update(renderer.camera.position, {
      radius: renderer.renderRadius, quality: "medium", outdoors: true, budgetMs: 1,
      detailBatches: batches,
      nativeBoundaries: publishedNativeBoundaries(renderer.chunks, batches, undefined, owners),
      nativeBoundaryOwners: owners,
      allocationBudget: {
        cpu: Math.max(0, renderer.meshStats.limits.maxCpuBytes - renderer.meshStats.combinedCpuBytes),
        gpu: Math.max(0, renderer.meshStats.limits.maxGpuBytes - renderer.meshStats.gpuBytes),
      },
    });
    assert.ok(lod.lastWork.units <= 512);
  };
  const initialUpdates = until(step, () => renderer.distant.ready &&
    world.dirtySectionRevisions.size === 0, "one-column native-seam fixture");
  return { world, renderer, step, initialUpdates };
}

for (const kind of ["pending", "refused"]) {
  test(`Nearby releases the real far owner while a native-seam publication is ${kind}`, (t) => {
    const { world, renderer, step, initialUpdates } = seamHost(t);
    const previous = renderer.distant, old = renderer.chunks.get("0,0").userData.sections.get(1);
    if (kind === "pending") renderer.meshLimits.maxCellsPerSlice = 64;
    else renderer.meshLimits.maxGpuBytes = previous.resources().gpuBytes + 512 * 1024;
    const limits = { ...renderer.meshLimits };
    world.put(15, 31, 8, BLOCK.STONE);
    const key = "0,0,1", ticket = world.dirtySectionRevisions.get(key);
    const waiting = () => kind === "pending"
      ? !!renderer.sectionJobs.get(key)?.nativeSeamPlan &&
        !renderer.sectionJobs.get(key).nativeSeamPlan.done
      : renderer.sectionRejectionDetails.get(key)?.reason === "native-seam-capacity";
    const blockedUpdates = until(step, waiting, `${kind} native seam`);
    assert.equal(world.dirtySectionRevisions.get(key), ticket);
    assert.equal(renderer.chunks.get("0,0").userData.sections.get(1), old);
    const job = renderer.sectionJobs.get(key), certificate = job?.result.nativeBoundary;
    if (kind === "pending") assert.ok(certificate?.some(Number.isFinite));
    else {
      const refusal = renderer.sectionRejections.get(key), count = renderer.meshStats.budgetRejections;
      step();
      assert.equal(renderer.sectionRejections.get(key), refusal);
      assert.equal(renderer.meshStats.budgetRejections, count, "unchanged refusal remains cached");
    }
    renderer.configureTerrain({ radius: 3, distantTerrain: false });
    assert.equal(renderer.distant, null);
    assert.equal(previous._disposed, true);
    assert.equal(previous.group.parent, null);
    t.mock.method(previous, "prepareNativePublication", () => assert.fail("disposed far owner cannot gate nearby work"));
    t.mock.method(previous, "commitNativePublication", () => assert.fail("disposed far owner cannot commit nearby work"));
    const resumedUpdates = until(step, () => !world.dirtySectionRevisions.has(key),
      `nearby continuation after ${kind} seam`);
    const section = renderer.chunks.get("0,0").userData.sections.get(1);
    assert.equal(section.stamp.ticket, ticket);
    assert.ok(section.bytes > 0);
    assert.ok(section.group.userData.nativeBoundary?.some(Number.isFinite));
    if (kind === "pending") {
      assert.equal(section.group.userData.nativeBoundary, certificate, "the already-built certificate transfers intact");
      assert.equal(job.nativeSeamPlan, null);
    }
    assert.equal(renderer.sectionRejections.has(key), false);
    assert.equal(renderer.sectionRejectionDetails.has(key), false);
    assert.equal(renderer.sectionJobs.size, 0);
    assert.equal(detailMeshResources(renderer).distant, undefined);
    assert.deepEqual(renderer.meshLimits, limits, "mode switch, not a raised ceiling, permits publication");
    renderer.configureTerrain({ radius: 12, distantTerrain: true });
    assert.notEqual(renderer.distant, previous);
    const borrowsCertificate = () => !!renderer.distant._seams?.columns.get("0,0")?.profiles.some(
      (profile) => profile.data === section.group.userData.nativeBoundary);
    // The refused fixture deliberately still cannot fund a far seam/horizon.
    // One re-entry update checks near retention, not full Extended readiness.
    let expandedUpdates = 1;
    if (kind === "refused") step();
    else expandedUpdates = until(step, () => renderer.distant.ready && borrowsCertificate(),
      "fresh extended owner");
    assert.equal(renderer.chunks.get("0,0").userData.sections.get(1), section);
    t.diagnostic(JSON.stringify({ layer: "real section/LOD publication, authored one-column input",
      kind, initialUpdates, blockedUpdates, resumedUpdates, expandedUpdates, ticket,
      extendedReady: renderer.distant.ready, extendedSeamPublished: borrowsCertificate() }));
  });
}

test("Nearby resource relief retries a cached ordinary section refusal without another edit or budget change", (t) => {
  const { world, renderer, step } = seamHost(t);
  renderer.meshLimits.maxCpuBytes = detailMeshResources(renderer).combinedCpuBytes + 128 * 1024;
  const limits = { ...renderer.meshLimits };
  world.put(8, 80, 8, BLOCK.STONE);
  const key = "0,0,5", ticket = world.dirtySectionRevisions.get(key);
  until(step, () => renderer.sectionRejectionDetails.get(key)?.reason === "job-reservation",
    "ordinary section reservation refusal");
  const refusal = renderer.sectionRejections.get(key);
  step();
  assert.equal(renderer.sectionRejections.get(key), refusal);
  const before = detailMeshResources(renderer).combinedCpuBytes;
  const revision = renderer.meshResourceRevision;
  renderer.configureTerrain({ radius: 3, distantTerrain: false });
  const after = detailMeshResources(renderer).combinedCpuBytes;
  assert.ok(after < before);
  let updates;
  try {
    updates = until(step, () => !world.dirtySectionRevisions.has(key),
      "ordinary cached refusal after far-owner resource relief");
  } finally {
    t.diagnostic(JSON.stringify({ layer: "real section admission / authored LOD",
      cpuBefore: before, cpuAfterRelief: after, maxCpuBytes: limits.maxCpuBytes,
      oldResourceRevision: revision, resourceRevision: renderer.meshResourceRevision,
      sameCachedRefusal: renderer.sectionRejections.get(key) === refusal,
      pendingTicket: world.dirtySectionRevisions.get(key), updates }));
  }
  const section = renderer.chunks.get("0,0").userData.sections.get(5);
  assert.equal(section.stamp.ticket, ticket);
  assert.ok(section.bytes > 0);
  assert.equal(renderer.sectionRejections.has(key), false);
  assert.deepEqual(renderer.meshLimits, limits);
  t.diagnostic(JSON.stringify({ layer: "real section admission / authored LOD", updates, ticket }));
});

test("real streaming shrink pauses a retained horse and re-expansion wakes the same identity, health and pose", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = horseFixture(t), horse = f.spawn();
  assert.equal(f.horses.track(horse.id).ok, true);
  assert.equal(f.horses.hurt(horse, 3).ok, true);
  const pose = horse.position.clone(), health = horse.health, sidecar = f.horses.serialize();
  // R6 keeps this resource continuation fixture smaller than the separately
  // covered R12 transport case. R2's halo excludes the horse at column zero.
  const focus = position(6);
  f.world.updateStreaming(focus, 6);
  settleStreaming(t, f.world);
  assertResidentSquare(f.world, 6, 0, 6);
  const chunk = f.world.chunks.get("0,0"), generator = f.world.generator;
  f.world.updateStreaming(focus, 2);
  settleStreaming(t, f.world);
  assertResidentSquare(f.world, 6, 0, 2);
  const generated = f.generated();
  f.tick(4);
  assert.equal(f.wildlife.entities.includes(horse), false);
  assert.equal(f.wildlife.byId.get(horse.id), horse);
  assert.equal(f.wildlife.dormantHorses.get(horse.id), horse);
  assert.deepEqual(horse.position, pose);
  assert.equal(horse.health, health);
  assert.deepEqual(f.horses.serialize(), sidecar);
  assert.equal(f.generated(), generated, "dormant simulation never fills missing columns");
  f.world.updateStreaming(focus, 6);
  settleStreaming(t, f.world);
  assertResidentSquare(f.world, 6, 0, 6);
  f.wildlife._wakeHorses();
  assert.notEqual(f.world.chunks.get("0,0").incarnation, chunk.incarnation);
  assert.equal(f.world.generator, generator);
  assert.equal(f.wildlife.byId.get(horse.id), horse);
  assert.equal(f.wildlife.entities.includes(horse), true);
  assert.deepEqual(horse.position, pose, "waking precedes any resumed AI motion");
  assert.equal(horse.health, health);
  assert.deepEqual(f.horses.serialize(), sidecar);
  t.diagnostic(JSON.stringify({ layer: "real World + retained horse owners / authored habitat",
    residentCounts: [289, 81, 289], health, sameBase: true, pauseTicks: 4 }));
});

test("deferred fluid work survives real streaming shrink and resumes on re-admission without implicit loads", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, fluids, put } = fluidFixture(t, {
    generatorVersion: 3, radius: 0, base: BLOCK.STONE,
    initial: Array.from({ length: 8 }, (_, i) => [13 + i, 1, 8, BLOCK.AIR]),
  });
  world.onChunkAdmitted = ({ chunk }) => { fluids.onChunkLoaded(chunk); };
  const focus = position(6);
  world.updateStreaming(focus, 6);
  settleStreaming(t, world);
  assertResidentSquare(world, 6, 0, 6);
  put(15, 1, 8, BLOCK.WATER);
  const generator = world.generator, source = world.chunks.get("0,0"), saved = world.serialize();
  world.updateStreaming(focus, 2);
  settleStreaming(t, world);
  assertResidentSquare(world, 6, 0, 2);
  const generate = t.mock.method(generator, "generateChunk", () =>
    assert.fail("fluid continuation must not generate unloaded source columns"));
  fluidSteps(fluids, 16);
  assert.equal(world.getCell(15, 1, 8), null);
  assert.equal(world.getCell(16, 1, 8), null);
  assert.ok(fluids.diagnostics().deferredSections > 0);
  assert.deepEqual(world.serialize(), saved, "unloaded water does not advance");
  assert.equal(fluids.load(fluids.serialize()), true, "the deferred queue survives its normal archive format");
  generate.mock.restore();
  world.updateStreaming(focus, 6);
  settleStreaming(t, world);
  assertResidentSquare(world, 6, 0, 6);
  assert.notEqual(world.chunks.get("0,0").incarnation, source.incarnation);
  assert.equal(world.generator, generator);
  assert.equal(world.getFluid(15, 1, 8), FLUID.WATER_SOURCE);
  t.mock.method(generator, "generateChunk", () =>
    assert.fail("admitted fluid work must only read resident columns"));
  fluidSteps(fluids, 128);
  assert.equal(world.getFluid(16, 1, 8), FLUID.WATER_1);
  assert.equal(world.getFluid(17, 1, 8), FLUID.WATER_2);
  assertResidentSquare(world, 6, 0, 6);
  t.diagnostic(JSON.stringify({ layer: "real World + FluidSystem / authored corridor",
    residentCounts: [289, 81, 289], deferredTicks: 16, resumedTicks: 128,
    water: [world.getFluid(15, 1, 8), world.getFluid(16, 1, 8), world.getFluid(17, 1, 8)] }));
});
