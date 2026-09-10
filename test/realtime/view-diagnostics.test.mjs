import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { intersectRayBox } from "../../src/aabb.js";
import { BLOCK_STATE, defaultFluidFor, FLUID } from "../../src/block-state.js";
import { BLOCK } from "../../src/blocks.js";
import { sectionGeometryCovered } from "../../src/section-pages.js";
import { sectionColumnCovered } from "../../src/section-renderer.js";
import { readConfig } from "./config.mjs";
import { BotMetrics } from "./metrics.js";
import {
  captureViewMiss, categorizeViewRay, createViewDiagnosticReader, fogBand, legacyVoxelSampling, pointDepths,
  ViewDiagnostics, VIEW_DIAGNOSTIC_LIMITS,
} from "./view-diagnostics.js";

const LABEL = "generated-terrain-traversal";
const air = Object.freeze({ id: BLOCK.AIR, state: 0, fluid: FLUID.NONE });
const key = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
const miss = (fogFar = 14) => Object.freeze({
  terrainRaysHit: 0, sampledRays: 3, fogFar, pitch: 0, visibleChunkGroups: 1,
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const forbidden = () => { throw new Error("Diagnostic attempted a write, generation, or matrix update"); };

function fixture({ loaded = () => true } = {}) {
  const cells = new Map(), reads = [], chunks = new Map();
  for (let cz = -5; cz <= 5; cz++)
    for (let cx = -5; cx <= 5; cx++)
      if (loaded(cx * 16, cz * 16)) chunks.set(`${cx},${cz}`, Object.freeze({ incarnation: 1 }));
  const world = {
    spec: Object.freeze({ minY: 0, maxY: 128 }),
    chunks, _requests: new Map(), _inFlight: new Map(), dirtyChunks: new Set(), _nextRequestId: 0,
    isLoaded: (x, z) => chunks.has(key(x, z)) && loaded(x, z),
    getCell(x, y, z) {
      reads.push([x, y, z]);
      const address = `${x},${y},${z}`;
      return cells.has(address) ? cells.get(address) : air;
    },
    get generator() { return forbidden(); },
    ensure: forbidden, set: forbidden, surfaceYAt: forbidden,
  };
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 4, 14);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 512);
  camera.position.set(8.5, 12.75, 8.5);
  camera.updateMatrixWorld(true);
  const player = {
    position: { x: 8.5, y: 11.13, z: 8.5 }, velocity: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, flying: true, grounded: false,
  };
  const graphics = {
    scene, camera, renderRadius: 3, chunks: new Map(), distant: null,
    detailCoverage: () => new Set(["0,0"]),
    renderer: { info: { render: { calls: 1, triangles: 1 }, memory: { geometries: 1, textures: 1 } } },
  };
  const game = { world, graphics, player, active: true, paused: false, miningProgress: 0 };
  return { game, cells, reads };
}

function put(f, x, y, z, id, state = 0, fluid = defaultFluidFor(id)) {
  f.cells.set(`${x},${y},${z}`, Object.freeze({ id, state, fluid }));
}

function column(f) {
  const group = new THREE.Group();
  group.userData.meshed = true;
  f.game.graphics.scene.add(group);
  f.game.graphics.chunks.set("0,0", group);
  return group;
}

function mesh(parent, { source = false, count = 3 } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  const object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  if (source) {
    object.userData.sectionSource = true;
    object.layers.mask = 0;
  }
  parent.add(object);
  return object;
}

test("depth mapping separates radial distance from forward fog depth, including camera translation/rotation", () => {
  const origin = { x: 10, y: 20, z: 30 }, point = { x: 13, y: 20, z: 26 };
  assert.deepEqual(pointDepths(origin, point, { x: 0, y: 0, z: -2 }), { radial: 5, cameraForward: 4 });
  assert.equal(pointDepths(origin, point, null).cameraForward, null);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(3, 5, 7);
  camera.rotation.set(-0.42, 0.8, 0.1, "YXZ");
  camera.updateMatrixWorld(true);
  const local = new THREE.Vector3(4, -2, -9);
  const world = local.clone().applyMatrix4(camera.matrixWorld);
  const depth = pointDepths(camera.position, world, null, camera.matrixWorldInverse.elements);
  near(depth.cameraForward, 9);
  near(depth.radial, Math.sqrt(101));
  // The actual view matrix also remains authoritative if the legacy ray origin differs.
  near(pointDepths(origin, world, null, camera.matrixWorldInverse.elements).cameraForward, 9);
});

test("fog bands retain exact near/far boundaries and do not invent unknown depth", () => {
  const fog = { near: 4, far: 14 };
  assert.deepEqual([-1, 0, 4, 7, 14, 15, null].map((depth) => fogBand(depth, fog)),
    ["behind-camera", "before-near", "before-near", "inside-ramp", "at-or-beyond-far", "at-or-beyond-far", "unknown"]);
  assert.equal(fogBand(5, { near: 14, far: 14 }), "unknown");
});

test("an oblique CPU hit beyond the old radial limit can remain inside actual forward-depth fog", (t) => {
  const f = fixture();
  const yaw = -0.25, pitch = -0.3, distance = 20;
  const p = f.game.graphics.camera.position;
  put(f, Math.floor(p.x - Math.sin(yaw) * Math.cos(pitch) * distance),
    Math.floor(p.y + Math.sin(pitch) * distance),
    Math.floor(p.z - Math.cos(yaw) * Math.cos(pitch) * distance), BLOCK.STONE);
  const first = captureViewMiss(f.game, miss()).rays[1].firstShapeHit;
  assert.ok(first);
  const far = (first.depth.radial + first.depth.cameraForward) / 2;
  f.game.graphics.scene.fog.far = far;
  const observation = captureViewMiss(f.game, miss(far));
  const ray = observation.rays[1];
  assert.ok(ray.categories.includes("voxel-beyond-legacy-limit"));
  assert.ok(ray.categories.includes("radial-limit-excludes-forward-fog-candidate"));
  assert.equal(observation.legacy.radialLimit, far);
  assert.equal(observation.fog.far, far);
  assert.equal(observation.fog.near, 4);
  t.diagnostic(`CPU fixture only: radial=${first.depth.radial.toFixed(4)}, forward=${first.depth.cameraForward.toFixed(4)}, fogFar=${far.toFixed(4)}; no pixel claim`);
});

test("partial block state changes the shape hit without changing full-voxel occupancy", () => {
  const f = fixture();
  put(f, 8, 12, 5, BLOCK.OAK_SLAB);
  put(f, 8, 12, 3, BLOCK.STONE);
  let ray = captureViewMiss(f.game, miss()).rays[0];
  assert.equal(ray.firstVoxelHit.id, BLOCK.OAK_SLAB);
  assert.equal(ray.firstShapeHit.id, BLOCK.STONE);
  near(ray.firstVoxelHit.depth.radial, 2.5);
  near(ray.firstShapeHit.depth.radial, 4.5);
  assert.ok(ray.categories.includes("shape-hit-after-voxel-entry"));
  put(f, 8, 12, 5, BLOCK.OAK_SLAB, BLOCK_STATE.TOP);
  ray = captureViewMiss(f.game, miss()).rays[0];
  assert.equal(ray.firstShapeHit.id, BLOCK.OAK_SLAB);
  assert.equal(ray.firstShapeHit.state, BLOCK_STATE.TOP);
  near(ray.firstShapeHit.depth.radial, 2.5);
});

test("water and waterlogged shapes use fluid/render volumes, not the water-blind selection channel", () => {
  const f = fixture();
  put(f, 8, 12, 5, BLOCK.OAK_SLAB, 0, FLUID.WATER_SOURCE);
  let ray = captureViewMiss(f.game, miss()).rays[0];
  near(ray.firstShapeHit.depth.radial, 2.5);
  assert.equal(ray.firstShapeHit.fluid, FLUID.WATER_SOURCE);
  put(f, 8, 12, 5, BLOCK.WATER);
  ray = captureViewMiss(f.game, miss()).rays[0];
  assert.equal(ray.firstShapeHit.id, BLOCK.WATER);
  assert.equal(ray.firstShapeHit.transparent, true);
  f.game.graphics.camera.position.y = 12.95;
  f.game.graphics.camera.updateMatrixWorld(true);
  ray = captureViewMiss(f.game, miss()).rays[0];
  assert.ok(ray.firstVoxelHit);
  assert.equal(ray.firstShapeHit, null);
  assert.ok(ray.categories.includes("voxel-without-shape-hit"));
});

test("bounded downward surface probe reports eye/feet clearance from loaded shape geometry", () => {
  const f = fixture();
  put(f, 8, 10, 8, BLOCK.OAK_SLAB);
  const observation = captureViewMiss(f.game, miss());
  near(observation.surface.eyeClearance, 2.25);
  near(observation.surface.feetClearance, 0.63);
  near(observation.surface.ray.firstVoxelHit.depth.radial, 1.75);
  assert.equal(observation.player.flying, true);
  assert.equal(observation.player.grounded, false);
  assert.equal(observation.surface.ray.firstShapeHit.state, 0);
});

test("unloaded rays remain unknown and never request/generate or read absent source cells", () => {
  const f = fixture({ loaded: (_x, z) => z >= 0 });
  const ray = captureViewMiss(f.game, miss()).rays[0];
  assert.equal(ray.firstVoxelHit, null);
  assert.equal(ray.firstShapeHit, null);
  assert.equal(ray.firstUnknown.status, "unloaded");
  near(ray.firstUnknown.depth.radial, 8.5);
  assert.equal(ray.firstUnknown.availability.sourceResident, false);
  assert.ok(ray.categories.includes("unknown-source-before-shape-candidate"));
  assert.ok(!ray.categories.includes("no-voxel-hit-within-cap"));
  assert.ok(f.reads.every(([, , z]) => z >= 0));
});

test("a loaded-column missing cell before a known hit is not silently treated as empty sky", () => {
  const f = fixture();
  f.cells.set("8,12,5", null);
  put(f, 8, 12, 3, BLOCK.STONE);
  const ray = captureViewMiss(f.game, miss()).rays[0];
  assert.equal(ray.firstUnknown.status, "missing-cell-in-loaded-column");
  near(ray.firstUnknown.depth.radial, 2.5);
  near(ray.firstShapeHit.depth.radial, 4.5);
  assert.ok(ray.categories.includes("unknown-source-before-shape-candidate"));
});

test("unknown off-ray neighbors are distinct from an unknown cell actually intersecting the ray", () => {
  const f = fixture({ loaded: (x) => x >= 16 });
  f.game.graphics.camera.position.x = 16.25;
  f.game.graphics.camera.updateMatrixWorld(true);
  put(f, 16, 12, 5, BLOCK.STONE);
  const ray = captureViewMiss(f.game, miss()).rays[0];
  assert.ok(ray.unknownCellsRead > 0);
  assert.equal(ray.firstUnknown, null);
  assert.ok(ray.categories.includes("unknown-neighborhood-sampled"));
  assert.ok(!ray.categories.includes("unknown-source-before-shape-candidate"));
});

for (const mode of ["missing", "hidden", "detached", "empty", "material-hidden", "layer-hidden", "drawable"]) {
  test(`source and renderer mask remain separate from ${mode} detail-group metadata`, () => {
    const f = fixture();
    put(f, 8, 12, 5, BLOCK.STONE);
    const group = mode === "missing" ? null : column(f);
    if (group && mode !== "empty") {
      const object = mesh(group);
      if (mode === "material-hidden") object.material.visible = false;
      if (mode === "layer-hidden") object.layers.mask = 0;
    }
    if (mode === "hidden") group.visible = false;
    if (mode === "detached") group.removeFromParent();
    const coverage = new Set(mode === "drawable" ? ["0,0"] : []);
    const observation = captureViewMiss(f.game, miss(), coverage);
    const availability = observation.rays[0].firstShapeHit.availability;
    assert.equal(availability.sourceResident, true);
    assert.equal(availability.groupPresent, mode !== "missing");
    assert.equal(availability.covered, mode === "drawable");
    assert.equal(availability.mesh.drawableCandidates > 0, mode === "drawable");
    assert.equal(observation.coverage.available, true);
    assert.equal(observation.coverage.coveredColumns, coverage.size);
    assert.equal("pixels" in availability, false);
  });
}

test("CPU-only section source meshes count only a mapped drawable physical range", () => {
  const f = fixture();
  put(f, 8, 12, 5, BLOCK.STONE);
  const group = column(f), source = mesh(group, { source: true });
  const region = new THREE.Group();
  f.game.graphics.scene.add(region);
  const physical = mesh(region);
  group.userData.sectionRanges = new Map([[source, { mesh: physical, start: 0, count: 3 }]]);
  let state = captureViewMiss(f.game, miss()).rays[0].firstShapeHit.availability.mesh;
  assert.equal(state.sourceMeshes, 1);
  assert.equal(state.packedRanges, 1);
  assert.equal(state.drawableCandidates, 1);
  physical.geometry.setDrawRange(0, 0);
  state = captureViewMiss(f.game, miss()).rays[0].firstShapeHit.availability.mesh;
  assert.equal(state.drawableCandidates, 0);
});

test("wide mesh trees, ray distance, cell reads and Extended coverage snapshots are bounded", (t) => {
  const f = fixture();
  put(f, 8, 12, 5, BLOCK.STONE);
  const group = column(f);
  for (let i = 0; i < 512; i++) group.add(new THREE.Group());
  mesh(group); // A draw after the cap must not be falsely reported absent.
  f.game.graphics.renderRadius = 12;
  const observation = captureViewMiss(f.game, miss());
  assert.equal(observation.work.meshNodes, VIEW_DIAGNOSTIC_LIMITS.meshNodes);
  assert.equal(observation.rays[0].firstShapeHit.availability.mesh.complete, false);
  assert.ok(!observation.rays[0].categories.includes("no-drawable-detail-candidate"));
  assert.ok(observation.work.cellReads <= VIEW_DIAGNOSTIC_LIMITS.cellReads);
  assert.ok(f.reads.length <= VIEW_DIAGNOSTIC_LIMITS.cellReads);
  assert.ok([...observation.rays, observation.surface.ray].every((ray) => ray.maxDistance === 64));
  assert.equal(observation.coverage.columns.length, 81);
  assert.equal(observation.coverage.localFootprintTruncated, true);
  assert.equal(observation.coverage.requestedRadius, 12);
  t.diagnostic(`CPU caps: ${observation.work.cellReads}/4096 cell reads, ${observation.work.meshNodes}/256 mesh nodes, ${observation.coverage.columns.length}/81 local columns, rays <=64 blocks`);
});

test("truncated/incomplete evidence never becomes a clear-sky or absent-mesh diagnosis", () => {
  const categories = categorizeViewRay({
    truncated: true, firstVoxelHit: null, firstShapeHit: null, firstUnknown: null,
  }, { near: 4, far: 14 }, 14);
  assert.deepEqual(categories, ["cell-read-cap"]);
});

test("the shared read cache stops before query 4097 and cache hits do not re-read world data", (t) => {
  let reads = 0;
  const reader = createViewDiagnosticReader({
    spec: { minY: 0, maxY: 128 },
    isLoaded: () => true,
    getCell: () => { reads++; return air; },
  });
  for (let x = 0; x < VIEW_DIAGNOSTIC_LIMITS.cellReads; x++) reader.read(x, 12, 0);
  assert.equal(reader.reads, 4096);
  assert.equal(reads, 4096);
  assert.throws(() => reader.read(4096, 12, 0), /cell-read cap reached/);
  assert.equal(reader.read(0, 12, 0).cell.id, BLOCK.AIR);
  assert.equal(reads, 4096);
  assert.equal(reader.reads, 4096);
  t.diagnostic("CPU read cap reached: exactly 4096 source reads; rejected query 4097 and cache hit perform no source read");
});

test("capture is read-only and returns detached data without matrix updates or terrain generation", () => {
  const f = fixture();
  put(f, 8, 12, 5, BLOCK.STONE);
  const group = column(f), object = mesh(group);
  const { game } = f, { camera } = game.graphics;
  const coverage = new Set(["0,0"]);
  for (const collection of [f.cells, game.world.chunks, game.world._requests, game.world.dirtyChunks, coverage]) {
    collection.set = collection.add = collection.delete = collection.clear = forbidden;
  }
  camera.updateMatrixWorld = camera.updateWorldMatrix = forbidden;
  Object.freeze(camera.position);
  Object.freeze(camera.matrixWorldInverse.elements);
  Object.freeze(game.graphics.scene.fog);
  Object.freeze(object.geometry.drawRange);
  Object.freeze(game.player.position);
  Object.freeze(game.player.velocity);
  Object.freeze(game.player);
  Object.freeze(game.world);
  const before = {
    camera: camera.position.toArray(), matrix: [...camera.matrixWorldInverse.elements],
    player: structuredClone(game.player), cells: [...f.cells], chunks: [...game.world.chunks],
    children: [...group.children], coverage: [...coverage],
  };
  const result = captureViewMiss(game, miss(), coverage);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.deepEqual(camera.position.toArray(), before.camera);
  assert.deepEqual(camera.matrixWorldInverse.elements, before.matrix);
  assert.deepEqual(game.player, before.player);
  assert.deepEqual([...f.cells], before.cells);
  assert.deepEqual([...game.world.chunks], before.chunks);
  assert.deepEqual(group.children, before.children);
  assert.deepEqual([...coverage], before.coverage);
  result.player.position.x = 999;
  result.camera.viewMatrix[0] = 999;
  assert.equal(game.player.position.x, 8.5);
  assert.notEqual(camera.matrixWorldInverse.elements[0], 999);
});

test("coverage observer preserves receiver, arguments, return identity and original exceptions", () => {
  const f = fixture(), returned = new Set(["0,0"]), sentinel = new Error("original failure");
  const { graphics } = f.game;
  graphics.detailCoverage = function (arg) {
    assert.equal(this, graphics);
    if (arg === "throw") throw sentinel;
    assert.equal(arg, "mask");
    return returned;
  };
  const diagnostics = new ViewDiagnostics(f.game, { sample: (_game, _view, mask) => ({ maskAvailable: mask !== null }) });
  diagnostics.reset(LABEL);
  diagnostics.attachCoverage(graphics);
  const wrapped = graphics.detailCoverage;
  diagnostics.attachCoverage(graphics);
  assert.equal(graphics.detailCoverage, wrapped);
  diagnostics.beginFrame();
  assert.equal(graphics.detailCoverage("mask"), returned);
  diagnostics.record(miss(), { frame: 1 });
  diagnostics.beginFrame();
  diagnostics.record(miss(), { frame: 2 });
  assert.deepEqual(diagnostics.results().observations.map((value) => value.maskAvailable), [true, false]);
  assert.throws(() => graphics.detailCoverage("throw"), (error) => error === sentinel);
  diagnostics.stop();
  assert.equal(graphics.detailCoverage("mask"), returned);
  assert.equal(diagnostics.coverage, null);
  diagnostics.record(miss(), { frame: 3 });
  assert.equal(diagnostics.results().observations.length, 2);
});

test("only zero-of-three traversal misses are captured; the 128 cap stops sampling entirely", (t) => {
  let now = 0, calls = 0;
  const diagnostics = new ViewDiagnostics({}, {
    clock: () => now,
    sample: () => { calls++; now += 2; return { cpuOnly: true }; },
  });
  diagnostics.record(miss(), {});
  diagnostics.reset("generated-terrain-menu-controls");
  diagnostics.record(miss(), {});
  assert.equal(calls, 0);
  diagnostics.reset(LABEL);
  diagnostics.record({ ...miss(), terrainRaysHit: 1 }, {});
  for (let sample = 0; sample < 200; sample++) diagnostics.record(miss(), { sample });
  const result = diagnostics.results();
  assert.equal(calls, 128);
  assert.equal(result.observations.length, 128);
  assert.equal(result.misses, 200);
  assert.equal(result.dropped, 72);
  assert.equal(result.cpuMs, 256);
  assert.match(result.definition, /never GPU pixels or visible-screen area/);
  const retained = result.observations;
  diagnostics.reset("generated-terrain-menu-controls");
  assert.equal(diagnostics.results().observations.length, 0);
  assert.equal(retained.length, 128);
  t.diagnostic("CPU collector: 200 misses -> 128 observations + 72 dropped; no sampling after cap; menus excluded");
});

test("diagnostic failures are reported separately and do not throw into legacy metric collection", () => {
  const diagnostics = new ViewDiagnostics({}, { sample: () => { throw new Error("unit diagnostic fault"); } });
  diagnostics.reset(LABEL);
  const legacy = miss();
  assert.doesNotThrow(() => diagnostics.record(legacy, { sample: 1 }));
  const result = diagnostics.results().observations[0];
  assert.equal(result.error.message, "unit diagnostic fault");
  assert.equal(result.sample, 1);
  assert.deepEqual(result.legacy, legacy);
});

for (const [hits, samples] of [[27, 77], [28, 77], [69, 72]]) {
  test(`legacy ${hits}/${samples} accounting and 0.4 decision survive an enabled side-channel`, (t) => {
    const execute = (enabled) => {
      const f = fixture(), game = f.game;
      let now = 0, legacy = miss();
      game.frame = function () { this.graphics.detailCoverage(); return "frame-result"; };
      const originalCoverage = game.graphics.detailCoverage;
      const diagnostics = enabled ? new ViewDiagnostics(game, {
        clock: () => now,
        sample: () => { now += 2; return { note: "Side-channel cannot rewrite legacy counts" }; },
      }) : undefined;
      const metrics = new BotMetrics(game, {
        clock: () => now, eventTarget: { addEventListener() {} }, probeView: () => legacy,
        viewDiagnostics: diagnostics,
      });
      metrics.reset(LABEL);
      for (let i = 0; i < samples; i++) {
        now = i * 600;
        legacy = Object.freeze({ ...miss(), terrainRaysHit: i < hits ? 3 : 0 });
        assert.equal(game.frame(now), "frame-result");
      }
      const result = metrics.results({ stop: true });
      const count = result.view.samples;
      game.frame(now + 600);
      assert.equal(metrics.results().view.samples, count);
      if (!enabled) assert.equal(game.graphics.detailCoverage, originalCoverage);
      else assert.equal(diagnostics.coverage, null);
      return result;
    };
    const off = execute(false), on = execute(true);
    assert.deepEqual(on.view, off.view);
    assert.equal(on.view.samples, samples);
    assert.equal(on.view.terrainVisible, hits);
    assert.equal(on.view.terrainVisibleFraction, hits / samples);
    assert.equal(on.view.terrainVisibleFraction >= 0.4, hits === 69);
    assert.equal("viewDiagnostics" in off, false);
    assert.equal(on.viewDiagnostics.version, 2);
    assert.equal(on.viewDiagnostics.observations.length, samples - hits);
    assert.equal(on.viewDiagnostics.observations[0].sample, hits + 1);
    assert.equal(on.observerCpuMs, (samples - hits) * 2);
    assert.equal(on.phaseMs["game.frame"].max, 0);
    t.diagnostic(`Legacy accounting fixture retained: ${hits}/${samples} = ${(hits / samples).toFixed(6)}, unchanged >=0.4 gate ${hits === 69 ? "PASS" : "FAIL"}`);
  });
}

test("CLI opt-in changes only diagnostic reporting/query configuration, not render modes or limits", () => {
  const args = ["--render-mode", "nearby", "--render-distance", "3", "--duration", "45", "--output", "/tmp/view-unit.json"];
  const off = readConfig(args, {}), on = readConfig([...args, "--view-diagnostics"], {});
  assert.equal(off.viewDiagnostics, false);
  assert.equal(on.viewDiagnostics, true);
  assert.equal(new URL(off.url).searchParams.has("viewDiagnostics"), false);
  assert.equal(new URL(on.url).searchParams.get("viewDiagnostics"), "1");
  const cleaned = new URL(on.url);
  cleaned.searchParams.delete("viewDiagnostics");
  assert.deepEqual({ ...on, url: cleaned.href, viewDiagnostics: false }, off);
});

// First-voxel witnesses from nearby-visibility-20260910-v1, not pixel evidence.
// Each hit is [ray index, voxel coordinates, radial depth, forward depth, exclusion].
const RECORDED_IN_FOG = [
  {
    sample: 9, origin: [266.0060363355505, 64.34421997581238, 435.6221931409655],
    yaw: 0.17, pitch: -0.386, far: 12.647422881764642,
    hits: [
      [1, [266, 58, 429], 8.43672637679137, 7.87189830559538, "between-grid-samples"],
      [2, [261, 56, 426], 12.696643352565406, 11.846619272701844, "beyond-radial-limit"],
    ],
  },
  {
    sample: 12, origin: [264.14107994082843, 63.916776327097395, 428.2298316594874],
    yaw: 0.20600000000000002, pitch: -0.392, far: 11.788580154755143,
    hits: [
      [1, [264, 55, 418], 12.407215673246567, 11.578607290726325, "beyond-radial-limit"],
      [2, [262, 60, 425], 4.571188001996465, 4.265903980481653, "between-grid-samples"],
    ],
  },
  {
    sample: 15, origin: [265.2620024870388, 66.89036631981193, 418.7147839540642],
    yaw: 0.19000000000000003, pitch: -0.41600000000000004, far: 12.400849793210543,
    hits: [[1, [265, 61, 411], 8.916432419206483, 8.326906077469516, "between-grid-samples"]],
  },
  {
    sample: 30, origin: [268.19450234512476, 67.79660256786232, 385.10284507434847],
    yaw: -0.262, pitch: -0.42200000000000004, far: 10.783791996566034,
    hits: [
      [1, [271, 60, 378], 10.284062088679539, 9.605853754618863, "after-last-grid-sample"],
      [2, [268, 60, 377], 10.284062088679535, 9.605853754618806, "after-last-grid-sample"],
    ],
  },
  {
    sample: 37, origin: [260.67053757407433, 71.69441150497087, 350.0822483809578],
    yaw: 0.032, pitch: -0.388, far: 10.911087012396418,
    hits: [
      [1, [262, 64, 342], 10.542489596999035, 9.837259605857184, "after-last-grid-sample"],
      [2, [258, 64, 342], 10.542489596999038, 9.837259605857184, "after-last-grid-sample"],
    ],
  },
  {
    sample: 40, origin: [259.0136809999448, 73.65732504501713, 329.45903537294225],
    yaw: 0.19, pitch: -0.386, far: 10.882873741479974,
    hits: [[1, [259, 66, 321], 10.509677756599457, 9.806068234251825, "after-last-grid-sample"]],
  },
  {
    sample: 47, origin: [278.6882429103296, 74.35433759430107, 290.83613645484076],
    yaw: 0.31400000000000006, pitch: -0.41800000000000004, far: 10.985371712103367,
    hits: [
      [1, [278, 66, 282], 11.178847920740349, 10.440367603102914, "beyond-radial-limit"],
      [2, [274, 67, 283], 10.740502219182885, 10.030979239118722, "after-last-grid-sample"],
    ],
  },
  {
    sample: 48, origin: [276.7635423586549, 76.18714207082327, 284.6332966712172],
    yaw: 0.28800000000000003, pitch: -0.43000000000000005, far: 11.82985128709526,
    hits: [
      [1, [276, 67, 275], 12.276975350328966, 11.470128733456704, "beyond-radial-limit"],
      [2, [272, 67, 276], 12.276975350328954, 11.470128733456647, "beyond-radial-limit"],
    ],
  },
  {
    sample: 52, origin: [271.92169686608446, 77.88994867435737, 264.77443816011436],
    yaw: 0.14200000000000002, pitch: -0.45000000000000007, far: 11.431855739252047,
    hits: [
      [1, [272, 69, 256], 11.574970698683993, 10.82091376503331, "beyond-radial-limit"],
      [2, [268, 69, 256], 11.574970698683973, 10.820913765033254, "beyond-radial-limit"],
    ],
  },
  {
    sample: 53, origin: [271.50548713696827, 77.70934487062028, 261.60204104067935],
    yaw: 0.11000000000000001, pitch: -0.45200000000000007, far: 11.36717630794441,
    hits: [
      [1, [272, 69, 253], 11.285809019106807, 10.551244175422141, "after-last-grid-sample"],
      [2, [268, 69, 253], 11.285809019106793, 10.551244175422141, "after-last-grid-sample"],
    ],
  },
];

function recordedDirection(observation, rayIndex) {
  const yaw = observation.yaw + [0, -0.25, 0.25][rayIndex];
  const pitch = observation.pitch + (rayIndex ? -0.3 : 0);
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

test("all 18 recorded forward-fog first candidates are excluded by legacy range or point spacing", (t) => {
  const reasons = {};
  for (const observation of RECORDED_IN_FOG) {
    const { origin, far } = observation;
    for (const [rayIndex, voxel, radial, forward, reason] of observation.hits) {
      const direction = recordedDirection(observation, rayIndex);
      const interval = intersectRayBox(origin, direction, [...voxel, ...voxel.map((value) => value + 1)], 64);
      near(interval.distance, radial);
      near(interval.distance * direction.reduce((sum, value, i) =>
        sum + value * recordedDirection(observation, 0)[i], 0), forward);
      assert.ok(forward < far);
      let lastStep = null, sampled = false;
      // Independent replay of the original point loop, without reading/generating a world.
      for (let step = 0.5; step <= Math.min(100, far); step += 0.75) {
        lastStep = step;
        sampled ||= voxel.every((value, i) => Math.floor(origin[i] + direction[i] * step) === value);
      }
      assert.equal(sampled, false, `sample ${observation.sample}, ray ${rayIndex}`);
      if (reason === "beyond-radial-limit") assert.ok(radial > far);
      else if (reason === "after-last-grid-sample") assert.ok(radial > lastStep && radial <= far);
      else {
        const nextStep = 0.5 + Math.ceil((interval.distance - 0.5) / 0.75) * 0.75;
        assert.ok(interval.far < nextStep && radial < far);
      }
      const replay = legacyVoxelSampling({
        origin: { x: origin[0], y: origin[1], z: origin[2] },
        direction: { x: direction[0], y: direction[1], z: direction[2] },
        maxDistance: 64,
        firstVoxelHit: { x: voxel[0], y: voxel[1], z: voxel[2], id: BLOCK.STONE },
      }, { fogFar: far });
      assert.equal(replay.reason, reason);
      assert.equal(replay.lastStep, lastStep);
      assert.equal(replay.sampledStep, null);
      near(replay.entry, radial);
      near(replay.exit, interval.far);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      t.diagnostic(`v1 sample ${observation.sample} ray ${rayIndex}: entry=${radial.toFixed(6)}, exit=${interval.far.toFixed(6)}, lastStep=${lastStep}, fogFar=${far.toFixed(6)}, ${reason}`);
    }
  }
  assert.deepEqual(reasons, { "between-grid-samples": 3, "beyond-radial-limit": 7, "after-last-grid-sample": 8 });
});

function partialColumnFixture() {
  const f = fixture(), group = column(f);
  Object.assign(group.userData, {
    cx: 0, cz: 0, meshed: false, sections: new Map(),
    requiredSections: [0, 1, 2, 3, 4, 5], sectionRanges: new Map(),
  });
  for (const sy of [0, 1, 4, 5]) {
    const sectionGroup = new THREE.Group();
    sectionGroup.userData.sy = sy;
    group.add(sectionGroup);
    group.userData.sections.set(sy, { group: sectionGroup, bytes: 0, draws: 0 });
  }
  const section = group.userData.sections.get(0);
  const source = mesh(section.group, { source: true });
  const physical = mesh(group);
  source.userData.batch = "opaque";
  section.bytes = 36;
  section.draws = 1;
  group.userData.sectionRanges.set(source, { mesh: physical, start: 0, count: 3 });
  put(f, 8, 12, 5, BLOCK.STONE);
  return { ...f, group, section, source, physical };
}

test("production coverage rejects an incomplete column even when the hit-owner section and mapped range are covered", (t) => {
  const f = partialColumnFixture(), camera = f.game.graphics.camera;
  assert.equal(f.group.userData.sections.size, 4);
  assert.equal(f.group.userData.requiredSections.length, 6);
  assert.equal(sectionColumnCovered(f.group, camera), false);
  assert.equal(sectionGeometryCovered(f.group, f.section, camera), true);
  const observation = captureViewMiss(f.game, miss(), new Set());
  const candidate = observation.rays[0].firstShapeHit;
  assert.equal(candidate.availability.covered, false);
  assert.ok(candidate.availability.mesh.drawableCandidates > 0);
  f.group.userData.sectionRanges.get(f.source).count = 2;
  assert.equal(sectionGeometryCovered(f.group, f.section, camera), false);
  t.diagnostic("Production predicates: 4/6 column uncovered; installed hit section covered; mismatched mapped range uncovered. Column draw count alone is insufficient.");
});

test("legacy sampling explanation respects negative-direction face ownership and fluid-only cells", () => {
  const ray = {
    origin: { x: 0.5, y: 0.5, z: 2.5 }, direction: { x: 0, y: 0, z: -1 }, maxDistance: 64,
    firstVoxelHit: { x: 0, y: 0, z: 1, id: BLOCK.STONE },
  };
  const result = legacyVoxelSampling(ray, { fogFar: 2 });
  assert.equal(result.entry, 0.5);
  assert.equal(result.sampledStep, 1.25); // The 0.5 sample still floors to z=2.
  assert.equal(result.reason, "candidate-on-grid");
  ray.firstVoxelHit.id = BLOCK.AIR;
  assert.equal(legacyVoxelSampling(ray, { fogFar: 2 }).reason, "legacy-ignores-fluid-only-cell");
  assert.equal(legacyVoxelSampling({ ...ray, firstVoxelHit: null }, { fogFar: 2 }).reason, "no-known-voxel");
});

test("legacy sampling uses the full known cell interval without extending the diagnostic world ray", () => {
  const ray = {
    origin: { x: 0.5, y: 0.5, z: 0.1 }, direction: { x: 0, y: 0, z: 1 }, maxDistance: 64,
    firstVoxelHit: { x: 0, y: 0, z: 64, id: BLOCK.STONE },
  };
  const result = legacyVoxelSampling(ray, { fogFar: 100 });
  near(result.entry, 63.9);
  near(result.exit, 64.9);
  assert.equal(result.sampledStep, 64.25);
  assert.equal(result.reason, "candidate-on-grid");
  assert.equal(ray.maxDistance, 64);
});

test("hit-section diagnostics expose the specific installed range without promoting dirty source or column coverage", () => {
  const f = partialColumnFixture();
  f.group.userData.incarnation = 1;
  f.game.world.dirtySectionRevisions = new Map([["0,0,0", 17]]);
  f.group.userData.sections.set = f.group.userData.sections.delete = forbidden;
  f.group.userData.sectionRanges.set = f.group.userData.sectionRanges.delete = forbidden;
  Object.freeze(f.source.geometry.drawRange);
  Object.freeze(f.physical.geometry.drawRange);
  const report = captureViewMiss(f.game, miss(), new Set());
  const ray = report.rays[0], section = ray.firstShapeHit.hitSection;
  assert.equal(ray.firstShapeHit.availability.covered, false);
  assert.equal(section.key, "0,0,0");
  assert.equal(section.present, true);
  assert.equal(section.geometryCovered, true);
  assert.equal(section.dirty, true);
  assert.equal(section.sourceIncarnationMatches, true);
  assert.equal(section.sources[0].rangeCount, 3);
  assert.equal(section.sources[0].physicalCandidate, true);
  assert.equal(section.sources[0].physicalDrawCount, "all");
  assert.equal(section.unknownReason, null);
  assert.equal(ray.legacySampling.reason, "candidate-on-grid");
  assert.ok(report.work.meshNodes <= VIEW_DIAGNOSTIC_LIMITS.meshNodes);
  assert.deepEqual(section, ray.firstVoxelHit.hitSection);
  section.sources[0].rangeCount = 999;
  assert.equal(f.group.userData.sectionRanges.get(f.source).count, 3);
});

test("an unrelated drawable page cannot establish a missing hit-owner section", () => {
  const f = partialColumnFixture();
  f.group.userData.sections.delete(0);
  const ray = captureViewMiss(f.game, miss(), new Set()).rays[0];
  assert.ok(ray.firstShapeHit.availability.mesh.drawableCandidates > 0);
  assert.equal(ray.firstShapeHit.hitSection.present, false);
  assert.equal(ray.firstShapeHit.hitSection.geometryCovered, false);
  assert.deepEqual(ray.firstShapeHit.hitSection.sources, []);
});

for (const failure of ["missing-range", "range-count", "draw-range", "source-hidden", "layer-hidden"]) {
  test(`hit-owner section reports ${failure} independently of whole-column draw candidates`, () => {
    const f = partialColumnFixture();
    if (failure === "missing-range") f.group.userData.sectionRanges.delete(f.source);
    if (failure === "range-count") f.group.userData.sectionRanges.get(f.source).count = 2;
    if (failure === "draw-range") f.physical.geometry.setDrawRange(0, 0);
    if (failure === "source-hidden") f.source.visible = false;
    if (failure === "layer-hidden") f.physical.layers.mask = 0;
    const section = captureViewMiss(f.game, miss(), new Set()).rays[0].firstShapeHit.hitSection;
    assert.equal(section.present, true);
    assert.equal(section.geometryCovered, false);
    assert.equal(section.unknownReason, null);
    assert.equal(section.sources.length, 1);
    if (failure === "range-count") {
      assert.equal(section.sources[0].sourceCount, 3);
      assert.equal(section.sources[0].rangeCount, 2);
      assert.equal(section.sources[0].physicalCandidate, true);
    }
  });
}

test("regional hit-section coverage requires the exact section ownership entry, not just a drawable page", () => {
  const f = partialColumnFixture(), region = new THREE.Group();
  region.userData = { sectionRegion: true, sections: new Map([["0,0,0", { group: f.section.group }]]) };
  f.game.graphics.scene.add(region);
  region.add(f.physical);
  let section = captureViewMiss(f.game, miss(), new Set()).rays[0].firstShapeHit.hitSection;
  assert.equal(section.geometryCovered, true);
  assert.equal(section.sources[0].ownerKind, "regional");
  assert.equal(section.sources[0].regionalSectionMatches, true);
  region.userData.sections.clear();
  section = captureViewMiss(f.game, miss(), new Set()).rays[0].firstShapeHit.hitSection;
  assert.equal(section.sources[0].physicalCandidate, true);
  assert.equal(section.sources[0].regionalSectionMatches, false);
  assert.equal(section.geometryCovered, false);
});

test("an authoritative empty hit section is reported empty, not as drawable terrain", () => {
  const f = partialColumnFixture();
  f.source.removeFromParent();
  f.section.bytes = f.section.draws = 0;
  const section = captureViewMiss(f.game, miss(), new Set()).rays[0].firstShapeHit.hitSection;
  assert.equal(section.geometryCovered, true);
  assert.equal(section.empty, true);
  assert.deepEqual(section.sources, []);
});

test("hit-section lookup uses voxel ownership at the y=16 boundary, not the top-face coordinate", () => {
  const f = partialColumnFixture();
  f.game.graphics.camera.position.y = 16.75;
  f.game.player.pitch = -Math.PI / 2;
  f.game.graphics.camera.rotation.x = f.game.player.pitch;
  f.game.graphics.camera.updateMatrixWorld(true);
  put(f, 8, 15, 8, BLOCK.STONE);
  const hit = captureViewMiss(f.game, miss()).rays[0].firstShapeHit;
  assert.equal(hit.point.y, 16);
  assert.equal(hit.y, 15);
  assert.equal(hit.hitSection.index, 0);
});

test("hit-section inspection shares the original mesh budget and leaves capped results unknown", () => {
  const f = partialColumnFixture();
  for (let i = 0; i < 512; i++) f.group.add(new THREE.Group());
  const report = captureViewMiss(f.game, miss(), new Set());
  const section = report.rays[0].firstShapeHit.hitSection;
  assert.equal(report.work.meshNodes, VIEW_DIAGNOSTIC_LIMITS.meshNodes);
  assert.equal(section.present, true);
  assert.equal(section.geometryCovered, null);
  assert.equal(section.unknownReason, "mesh-node-cap");
});

test("specialized hosted water remains unknown without invoking host code", () => {
  for (const visible of [true, false]) {
    const f = partialColumnFixture();
    f.physical.visible = visible;
    f.physical.userData.sectionWater = { host: { covered: forbidden } };
    const section = captureViewMiss(f.game, miss(), new Set()).rays[0].firstShapeHit.hitSection;
    assert.equal(section.geometryCovered, null);
    assert.equal(section.sources[0].physicalCandidate, visible ? null : false);
    assert.equal(section.unknownReason, "specialized-material-or-water");
  }
});

test("hit-section eligibility requires the current renderer scene, not another attached scene", () => {
  const f = partialColumnFixture();
  new THREE.Scene().add(f.group);
  const hit = captureViewMiss(f.game, miss(), new Set()).rays[0].firstShapeHit;
  assert.equal(hit.availability.groupAttached, false);
  assert.equal(hit.hitSection.sources[0].physicalCandidate, false);
  assert.equal(hit.hitSection.geometryCovered, false);
});

test("a cyclic physical parent chain is capped before calling the production coverage predicate", () => {
  const f = partialColumnFixture();
  f.physical.parent = f.physical;
  const section = captureViewMiss(f.game, miss(), new Set()).rays[0].firstShapeHit.hitSection;
  assert.equal(section.geometryCovered, null);
  assert.equal(section.unknownReason, "parent-depth-cap");
});

test("non-sectioned hit metadata stays explicitly unknown through the shared cache", () => {
  const f = fixture();
  column(f);
  put(f, 8, 12, 5, BLOCK.STONE);
  const ray = captureViewMiss(f.game, miss()).rays[0];
  for (const hit of [ray.firstVoxelHit, ray.firstShapeHit]) {
    assert.equal(hit.hitSection.sectioned, false);
    assert.equal(hit.hitSection.geometryCovered, null);
    assert.equal(hit.hitSection.unknownReason, "non-sectioned-or-missing-column");
  }
});
