import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createGenerator } from "../src/terrain.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { auditPillarDraws } from "./distant-native-coverage.mjs";
import { assertRenderedNativeTerraces } from "./distant-terraces-native-fixture.js";

// CPU-only measurement of the UNAPPLIED, bounded central-End proposal.
// Same low-density topology; borrowing high's bounds does not widen detail.
class ProposedCentralEndCoverage extends DistantTerrain {
  _request(position, radius, quality, dimension, coverage) {
    const request = super._request(position, radius, quality, dimension, coverage);
    if (dimension === "end" && this.world.generatorVersion === 7 && Math.hypot(position.x, position.z) <= 320) {
      const bounds = super._request(position, radius, "high", dimension, coverage);
      request.horizon = bounds.horizon;
      request.bounds = bounds.bounds;
    }
    return request;
  }
  _needsJob(previous, request) {
    return previous?.horizon !== request.horizon || super._needsJob(previous, request);
  }
}
const distribution = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
};

function run(Type, quality) {
  const generator = createGenerator("cedar-valley", "end", 7);
  generator.generateChunk = generator.generateRegion = () => assert.fail("LOD must not generate missing chunks");
  const world = { generator, generatorVersion: 7, dimension: "end", seed: "cedar-valley",
    spec: generator.spec, chunks: new Map(), edits: new Map(), _editRevision: 0 };
  const scene = new THREE.Scene(), lod = new Type(scene, world);
  const times = [], cpu = [], busy = [], publications = [], landmarkPublications = [];
  try {
    for (let frame = 0; frame < 900; frame++) {
      const position = frame < 450 ? { x: 0, z: 260 } : { x: 32, z: 228 };
      const pillar = generator.getEndPillars()[0];
      if (frame === 600) {
        world.edits.set(`end:${pillar.cap.x},${pillar.cap.y},${pillar.cap.z}`, { id: 0 });
        world._editRevision++;
      }
      const sections = frame % 300 < 150
        ? new Set([`${Math.floor(pillar.x / 16)},${Math.floor(pillar.z / 16)},${Math.floor(pillar.cap.y / 16)}`]) : new Set();
      const priorData = lod._active?.data, priorMesh = lod._landmarks?.group.children[0];
      const wasBusy = lod._job || lod._landmarks?.job;
      const before = process.cpuUsage(), start = performance.now();
      lod.update(position, { quality, outdoors: true, budgetMs: quality === "high" ? 2 : 1, detailSections: sections });
      const elapsed = performance.now() - start;
      times.push(elapsed);
      if (wasBusy || lod.lastWork.units || lod._landmarks?.lastColumns) busy.push(elapsed);
      if (lod._active?.data !== priorData) publications.push(elapsed);
      if (lod._landmarks?.group.children[0] !== priorMesh) landmarkPublications.push(elapsed);
      const used = process.cpuUsage(before); cpu.push((used.user + used.system) / 1000);
      assert.ok(lod.lastWork.samples <= 128 && lod.lastWork.units <= 512);
      assert.ok((lod._landmarks?.lastColumns ?? 0) <= 4);
      if (frame === 449 || frame === 899) {
        assert.ok(lod.ready && !lod._job && !lod._landmarks?.job);
        assert.equal(lod._landmarks.group.userData.renderablePillars, 10);
      }
    }
    let bytes = 0, meshes = 0, vertices = 0;
    const buffers = new Set();
    const retain = (value) => { if (ArrayBuffer.isView(value)) buffers.add(value.buffer); };
    lod.group.traverse((mesh) => {
      if (!mesh.isMesh) return;
      meshes++; vertices += mesh.geometry.attributes.position.count;
      bytes += mesh.geometry.index.array.byteLength;
      retain(mesh.geometry.index.array);
      retain(mesh.userData.landmarkSource?.indices);
      for (const attribute of Object.values(mesh.geometry.attributes)) {
        bytes += attribute.array.byteLength;
        retain(attribute.array);
      }
    });
    for (const value of Object.values(lod._active.data)) retain(value);
    for (const value of Object.values(lod._active.data.terraces)) retain(value);
    assert.equal(meshes, 3);
    assert.ok(bytes < 12 * 1024 * 1024);
    assert.equal(world.chunks.size, 0);
    return { updates: distribution(times), busy: distribution(busy), publications: distribution(publications),
      landmarkPublications: distribution(landmarkPublications), cpu: distribution(cpu), bytes, vertices, meshes,
      retainedTypedBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
      samples: lod._active.data.count, horizon: lod.fogDistance };
  } finally { lod.dispose(); }
}

test("v7 current versus proposed central-End coverage stays bounded under matched updates", (t) => {
  for (const quality of ["low", "high"])
    for (let repeat = 0; repeat < 3; repeat++) {
      const result = {};
      for (const Type of repeat % 2 ? [ProposedCentralEndCoverage, DistantTerrain] : [DistantTerrain, ProposedCentralEndCoverage])
        result[Type === DistantTerrain ? "current" : "proposal"] = run(Type, quality);
      t.diagnostic(JSON.stringify({ quality, repeat, result }));
    }
});

for (const seed of ["cedar-valley", "mineslop-audit-2", ""]) {
test(`proposed fog and native foundation intersections, seed ${JSON.stringify(seed)}`, (t) => {
  const generator = createGenerator(seed, "end", 7);
  const world = { generator, generatorVersion: 7, dimension: "end", seed, spec: generator.spec };
  const scene = new THREE.Scene(), lod = new ProposedCentralEndCoverage(scene, world);
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 768);
  camera.position.set(0, 165, 260); camera.lookAt(0, 85, 0); camera.updateMatrixWorld(true);
  try {
    for (let i = 0; i < 1000 && (!lod.ready || lod._job || lod._landmarks?.job); i++)
      lod.update(camera.position, { quality: "low", outdoors: true, budgetMs: 4 });
    assert.ok(lod.ready && !lod._landmarks.job);
    assert.ok(lod._active.data.count <= 16384);
    assert.ok(lod._active.data.refinement.size <= 1000);
    assertRenderedNativeTerraces(lod, (x, z) => generator.terrainHeight(x, z));
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const horizontal = Math.hypot(forward.x, forward.z);
    // Native column at the overview is void: existing terrainFogRange has
    // zero ground-depth offset. Only the proposed near ratio differs.
    scene.fog = new THREE.Fog("#222233", lod.fogDistance * 0.6 * horizontal, lod.fogDistance * horizontal);
    const audit = auditPillarDraws({ world, scene, camera, chunks: new Map(), distant: lod });
    t.diagnostic(JSON.stringify({ drawWitnesses: audit.pillars.filter((p) => p.missing) }));
    assert.equal(audit.expectedPillars, 10);
    assert.deepEqual(audit.errors, []);
    t.diagnostic(JSON.stringify({ fog: { near: scene.fog.near, far: scene.fog.far },
      minimumTransmission: Math.min(...audit.pillars.map((p) => p.minimumTransmission)),
      nativeColumnsQueried: audit.nativeColumnsQueried }));
  } finally { lod.dispose(); }
});
}
