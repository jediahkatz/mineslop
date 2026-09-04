import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import { geometryWorldSpec } from "../src/geometry-world.js";
import { DistantTerrain, DISTANT_TERRAIN_LIMITS } from "../src/distant-terrain.js";
import { DISTANT_NATIVE_GRID_LIMITS } from "../src/distant-grid.js";
import { DISTANT_LANDMARK_LIMITS } from "../src/distant-landmarks.js";
import { auditPillarDraws } from "./distant-native-coverage.mjs";

function setup(version, seed) {
  const generator = createGenerator(seed, "end", version);
  const world = {
    generator, generatorVersion: version, seed, dimension: "end",
    spec: generator.spec, edits: new Map(), chunks: new Map(), _editRevision: 0,
    get() { assert.fail("LOD must not read/load world voxels"); },
    ensureArea() { assert.fail("LOD must not load detail"); },
  };
  const scene = new THREE.Scene(), lod = new DistantTerrain(scene, world);
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 768);
  camera.position.set(0, version === 7 ? 165 : 105, 260);
  camera.lookAt(0, version === 7 ? 85 : 40, 0);
  camera.updateMatrixWorld(true);
  return { generator, world, scene, lod, camera };
}

// Expectations are generated voxels, not the renderer's footprint helper or
// descriptor reconstruction. Include all 25 columns, even empty mask corners.
function nativeVoxels(world) {
  const { minY, maxY } = geometryWorldSpec(world), expected = new Map();
  for (const pillar of world.generator.getEndPillars?.() ?? []) {
    const region = world.generator.generateRegion(pillar.x - 2, pillar.z - 2, 5, 5);
    for (let y = minY; y < maxY; y++)
      for (let dz = 0; dz < 5; dz++)
        for (let dx = 0; dx < 5; dx++) {
          const id = region.blocks[(y - minY) * 25 + dz * 5 + dx];
          if (id === BLOCK.OBSIDIAN || id === BLOCK.GLOWSTONE)
            expected.set(`${pillar.x - 2 + dx},${y},${pillar.z - 2 + dz}`, id);
        }
  }
  return expected;
}

function drawnVoxels(lod) {
  const actual = new Map();
  for (const mesh of lod._landmarks.group.children) {
    const positions = mesh.geometry.attributes.position;
    for (const part of mesh.userData.landmarkSource.parts) {
      const indices = mesh.geometry.index.array.subarray(part.start, part.start + part.count);
      const bounds = new THREE.Box3();
      for (const index of indices)
        bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(positions, index));
      assert.equal(bounds.max.x - bounds.min.x, 1);
      assert.equal(bounds.max.z - bounds.min.z, 1);
      for (let y = bounds.min.y; y < bounds.max.y; y++) {
        const key = `${bounds.min.x},${y},${bounds.min.z}`;
        assert.ok(!actual.has(key), `overlapping proxy volume ${key}`);
        actual.set(key, part.nativeId);
      }
    }
  }
  return actual;
}

function finish(fixture, quality) {
  const { generator, lod, camera } = fixture;
  generator.generateRegion = generator.generateChunk = () => assert.fail("LOD generated native chunks");
  const height = generator.terrainHeight.bind(generator);
  let queries = 0;
  generator.terrainHeight = (...args) => { queries++; return height(...args); };
  for (let frame = 0; frame < 2000; frame++) {
    const before = queries;
    lod.update(camera.position, { quality, outdoors: true, budgetMs: 4 });
    assert.ok(lod.lastWork.samples <= DISTANT_TERRAIN_LIMITS.samplesPerUpdate);
    assert.ok(lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
    assert.ok((lod._landmarks?.lastColumns ?? 0) <= DISTANT_LANDMARK_LIMITS.columnsPerUpdate);
    assert.ok(queries - before <= DISTANT_TERRAIN_LIMITS.samplesPerUpdate +
      DISTANT_LANDMARK_LIMITS.columnsPerUpdate);
    if (lod.ready && !lod._job && !lod._landmarks?.job) {
      assert.ok(queries <= DISTANT_NATIVE_GRID_LIMITS.vertices + 250);
      return queries;
    }
  }
  assert.fail("bounded End geometry did not finish");
}

function resources(lod) {
  const data = lod._active.data, buffers = new Set();
  const retain = (value) => { if (ArrayBuffer.isView(value)) buffers.add(value.buffer); };
  let meshes = 0, drawBytes = 0;
  lod.group.traverse((mesh) => {
    if (!mesh.isMesh) return;
    meshes++;
    for (const attribute of [...Object.values(mesh.geometry.attributes), mesh.geometry.index]) {
      drawBytes += attribute.array.byteLength;
      retain(attribute.array);
    }
    retain(mesh.userData.landmarkSource?.indices);
  });
  for (const value of [...Object.values(data), ...Object.values(data.terraces)]) retain(value);
  const retainedBytes = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  assert.equal(meshes, 3);
  assert.ok(drawBytes < 12 * 1024 * 1024);
  assert.ok(retainedBytes < 16 * 1024 * 1024);
  assert.ok(data.count <= DISTANT_NATIVE_GRID_LIMITS.vertices);
  assert.ok(data.cells.length <= DISTANT_NATIVE_GRID_LIMITS.cells);
  assert.ok(data.indexCount <= DISTANT_NATIVE_GRID_LIMITS.indices);
  assert.ok(lod._samples.size <= DISTANT_TERRAIN_LIMITS.nativeCachedSamples);
  assert.ok(data.refinement.size > 0 && data.refinement.size <= 1000);
  return { samples: data.count, cells: data.cells.length, drawBytes, retainedBytes };
}

for (const version of [1, 2, 3, 7])
  for (const seed of ["cedar-valley", "mineslop-audit-2", ""])
    for (const quality of ["low", "medium", "high"])
      test(`v${version} ${JSON.stringify(seed)} ${quality}: native masks and all ten unobstructed pillars`, (t) => {
        const fixture = setup(version, seed);
        const { world, lod, scene, camera } = fixture;
        try {
          const expected = nativeVoxels(world);
          const queries = finish(fixture, quality);
          assert.deepEqual(drawnVoxels(lod), expected);
          if (version === 7 && seed === "")
            assert.ok([...expected].some(([key, id]) =>
              key.split(",")[1] === "132" && id === BLOCK.GLOWSTONE));
          const audit = auditPillarDraws({ scene, camera, world, distant: lod, chunks: world.chunks });
          assert.equal(audit.expectedPillars, 10);
          assert.ok(audit.pillars.every((p) => p.body > 0 && p.cap > 0 && p.minimumTransmission === 1));
          assert.deepEqual(audit.errors, []);
          assert.ok(audit.nativeColumnsQueried <= 100000);
          assert.equal(world.chunks.size, 0);
          assert.equal(world.edits.size, 0);
          t.diagnostic(JSON.stringify({ version, seed, quality, queries,
            nativeColumnsQueried: audit.nativeColumnsQueried, ...resources(lod) }));
        } finally { lod.dispose(); }
      });

for (const version of [4, 5, 6])
  for (const quality of ["low", "medium", "high"])
    test(`v${version} ${quality}: terrain does not invent legacy refinement or pillars`, () => {
      const fixture = setup(version, "cedar-valley");
      try {
        assert.equal(fixture.generator.getEndPillars, undefined);
        finish(fixture, quality);
        assert.equal(fixture.lod._landmarks, null);
        assert.equal(fixture.lod._active.data.refinement.size, 0);
        assert.equal(fixture.lod._active.data.landmarkReachSquared, 0);
        assert.equal(fixture.world.chunks.size, 0);
      } finally { fixture.lod.dispose(); }
    });
