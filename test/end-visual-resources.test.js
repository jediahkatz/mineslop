import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { endVisualFog } from "../src/end-visual-policy.js";
import { geometryWorldSpec } from "../src/geometry-world.js";
import { GameRenderer, qualityFogDistance, terrainFogRange } from "../src/renderer.js";
import { createGenerator } from "../src/terrain.js";
import { auditPillarDraws } from "./distant-native-coverage.mjs";

// Matched old window sizes, without reverting or touching anyone else's files.
class QualityWindowBaseline extends DistantTerrain {
  _request(position, radius, quality, dimension, coverage) {
    const request = super._request(position, radius, quality, "overworld", coverage);
    request.dimension = dimension;
    return request;
  }
}

function retainedResources(lod) {
  const buffers = new Set();
  const retain = v => { if (ArrayBuffer.isView(v)) buffers.add(v.buffer); };
  let geometryBytes = 0, meshes = 0;
  lod.group.traverse(mesh => {
    if (!mesh.isMesh) return;
    meshes++;
    for (const attribute of [mesh.geometry.index, ...Object.values(mesh.geometry.attributes)]) {
      geometryBytes += attribute.array.byteLength; retain(attribute.array);
    }
    retain(mesh.userData.landmarkSource?.indices);
  });
  for (const data of new Set([lod._active?.data, lod._job])) {
    for (const value of Object.values(data ?? {})) retain(value);
    for (const value of Object.values(data?.terraces ?? {})) retain(value);
  }
  return { meshes, geometryBytes,
    retainedTypedBytes: [...buffers].reduce((n, b) => n + b.byteLength, 0),
    samples: lod._active?.data.count ?? 0 };
}

function run(Type, version, quality, seed, auditDraws) {
  const generator = createGenerator(seed, "end", version);
  generator.generateChunk = generator.generateRegion = () => assert.fail("no missing chunk generation");
  const world = { generator, generatorVersion: version, dimension: "end", seed,
    spec: generator.spec, chunks: new Map(), edits: new Map(), _editRevision: 0 };
  const scene = new THREE.Scene(), lod = new Type(scene, world);
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 768);
  const times = [], publications = [], rows = [];
  let peakRetainedTypedBytes = 0;
  const radius = { low: 2, medium: 3, high: 4 }[quality];
  try {
    for (const z of [260, 319, 321, 340, 321, 319, 260]) {
      camera.position.set(0, version === 7 ? 165 : 105, z);
      camera.lookAt(0, version === 7 ? 85 : 40, 0); camera.updateMatrixWorld(true);
      for (let i = 0; i < 2000; i++) {
        const previous = lod._active?.data;
        const start = performance.now();
        lod.update(camera.position, { radius, quality, outdoors: true, budgetMs: quality === "high" ? 2 : 1 });
        const elapsed = performance.now() - start;
        times.push(elapsed);
        if (previous !== lod._active?.data) publications.push(elapsed);
        peakRetainedTypedBytes = Math.max(peakRetainedTypedBytes, retainedResources(lod).retainedTypedBytes);
        assert.ok(peakRetainedTypedBytes <= 32 * 1024 * 1024, "active plus pending typed buffers remain bounded");
        assert.ok(lod.lastWork.samples <= 128 && lod.lastWork.units <= 512);
        assert.ok((lod._landmarks?.lastColumns ?? 0) <= 4);
        if (lod.ready && !lod._job && !lod._landmarks?.job && !lod._landmarks?.pendingRebuild) break;
      }
      assert.ok(lod.ready && !lod._job && !lod._landmarks?.job, "bounded native job finishes");
      const resources = retainedResources(lod);
      assert.equal(resources.meshes, 3);
      assert.ok(resources.samples <= 16384);
      assert.ok(resources.geometryBytes <= 12 * 1024 * 1024);
      assert.ok(resources.retainedTypedBytes <= 16 * 1024 * 1024);
      assert.equal(world.chunks.size, 0);
      let audit = null;
      if (auditDraws) {
        assert.equal(lod.fogDistance, 448);
        const forward = camera.getWorldDirection(new THREE.Vector3());
        const detailFar = qualityFogDistance(radius);
        const fog = endVisualFog({ dimension: "end", outdoors: true, horizonVisible: true,
          terrainComplete: lod.terrainCoverageComplete,
          availableDistance: lod.fogDistance, horizontalFar: lod.fogDistance,
          detailFar, base: terrainFogRange(camera, undefined, detailFar * 0.9, lod.fogDistance),
          eyeY: camera.position.y, minY: geometryWorldSpec(world).minY, forward });
        scene.fog = new THREE.Fog("#222233", fog.near, fog.far);
        audit = auditPillarDraws({ scene, camera, world, distant: lod, chunks: new Map() });
        assert.equal(audit.expectedPillars, 10);
        assert.deepEqual(audit.errors, [], JSON.stringify({ version, quality, seed, z,
          failures: audit.pillars.filter(p => p.missing || p.duplicate || p.fogHidden) }));
      }
      rows.push({ z, ...resources, horizon: lod.fogDistance,
        minimumTransmission: audit ? Math.min(...audit.pillars.map(p => p.minimumTransmission)) : null });
    }
    const stats = values => {
      const sorted = values.toSorted((a, b) => a - b);
      return { count: sorted.length, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], worst: sorted.at(-1) };
    };
    return { rows, updates: stats(times), publications: stats(publications), peakRetainedTypedBytes };
  } finally { lod.dispose(); }
}

for (const quality of ["low", "medium", "high"])
  test(`${quality}: matched v7 native camera trace and fixed-window resource bounds`, t => {
    const baseline = run(QualityWindowBaseline, 7, quality, "cedar-valley", false);
    const fixed = run(DistantTerrain, 7, quality, "cedar-valley", true);
    t.diagnostic(JSON.stringify({ version: 7, quality, baseline, fixed }));
  });

for (const version of [1, 2, 3])
  test(`v${version}: legacy native draw/readability checks retain all ten landmarks`, t => {
    t.diagnostic(JSON.stringify({ version, result: run(DistantTerrain, version, "low", "cedar-valley", true) }));
  });

test("empty-seed Y132 native draw/readability over approach and return", t => {
  t.diagnostic(JSON.stringify({ version: 7, seed: "", result: run(DistantTerrain, 7, "high", "", true) }));
});

test("real renderer: stalled LOD edge moves continuously; missing geometry and fluid/cave fog still win", t => {
  const generator = createGenerator("cedar-valley", "end", 7);
  generator.generateChunk = generator.generateRegion = () => assert.fail("no chunk generation");
  const world = { generator, generatorVersion: 7, seed: "cedar-valley", dimension: "end",
    spec: generator.spec, chunks: new Map(), edits: new Map(), get: () => BLOCK.AIR };
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#222233", 10, 29);
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 768);
  camera.position.set(0, 165, 260); camera.lookAt(0, 85, 0);
  const lod = new DistantTerrain(scene, world);
  const graphics = Object.assign(Object.create(GameRenderer.prototype), {
    world, scene, camera, distant: lod, quality: "low",
    biome: { category: "end", dimension: "end" }, chunks: new Map(),
    waterTime: { value: 0 }, expandedFog: 448,
    atmosphere: { update() {}, cameraMediumKnown: true },
    syncVisibleChunks() {}, updateDaylight() {}, updateShadows() {}, updateLocalLights() {},
    detailCoverage: () => new Set(), streamingFogDistance: () => 29,
  });
  try {
    for (let i = 0; i < 2000; i++) {
      lod.update(camera.position, { quality: "low", outdoors: true, budgetMs: 4 });
      if (lod.ready && !lod._job && !lod._landmarks?.job) break;
    }
    assert.ok(lod.ready && !lod._job);
    const retainedLayer = lod._active;
    const original = lod.update.bind(lod);
    lod.update = (position, options) => original(position, { ...options, budgetMs: 0 });
    let prior = null, time = 0, maxStep = 0, minimumCoverage = 448;
    for (let z = 260; z <= 340; z += 0.25) {
      camera.position.z = z; camera.lookAt(0, 85, 0);
      graphics.update(1 / 60, time += 1 / 60, camera.position);
      assert.ok(lod.terrainCoverageComplete);
      minimumCoverage = Math.min(minimumCoverage, lod.fogDistance);
      if (prior) {
        const delta = Math.max(Math.abs(scene.fog.near - prior.near), Math.abs(scene.fog.far - prior.far));
        maxStep = Math.max(maxStep, delta);
        assert.ok(delta < 3, `stalled coverage fog jump at ${z}: ${delta}`);
      }
      prior = { near: scene.fog.near, far: scene.fog.far };
    }
    assert.ok(minimumCoverage < 448, "exercise actual stale mesh edge, not only the fixed full window");
    assert.equal(lod._active, retainedLayer, "the original mesh remains resident while work is denied");
    assert.ok(lod._needsJob(retainedLayer.data.request,
      lod._request(camera.position, 2, "low", "end", new Set())), "replacement work is required");
    lod._active.data.unknownChunks.add("0,21");
    graphics.streamingFogDistance = () => 2;
    graphics.update(1 / 60, time += 1 / 60, camera.position);
    assert.equal(lod.terrainCoverageComplete, false);
    assert.equal(lod.ready, false);
    assert.equal(graphics.expandedFog, 2, "unknown geometry retracts fog immediately");

    lod._active.data.unknownChunks.clear();
    graphics.streamingFogDistance = () => 29;
    world.isLoaded = () => true;
    world.get = () => BLOCK.WATER;
    graphics.update(1 / 60, time += 1 / 60, camera.position);
    assert.equal(scene.fog.near, 0.2);
    assert.equal(scene.fog.far, Math.min(20, graphics.expandedFog));
    assert.equal(lod.group.visible, false);
    world.get = () => BLOCK.LAVA;
    graphics.update(1 / 60, time += 1 / 60, camera.position);
    assert.equal(scene.fog.near, 0.2); assert.equal(scene.fog.far, 4);
    assert.equal(lod.group.visible, false);
    world.get = () => BLOCK.AIR;
    graphics.biome.category = "cave";
    graphics.update(1 / 60, time += 1 / 60, camera.position);
    assert.equal(lod.group.visible, false);
    assert.ok(graphics.expandedFog <= 29);
    graphics.biome.category = "end";
    graphics.atmosphere.cameraMediumKnown = false;
    graphics.update(1 / 60, time += 1 / 60, camera.position);
    assert.equal(lod.group.visible, false);
    t.diagnostic(JSON.stringify({ maxFogStepPerQuarterBlock: maxStep, minimumCoverage }));
  } finally { lod.dispose(); }
});
