import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantTerrain, DISTANT_TERRAIN_LIMITS } from "../src/distant-terrain.js";
import { DistantTerraces, DISTANT_TERRACE_LIMITS } from "../src/distant-terraces.js";
import { createGenerator } from "../src/terrain.js";
import { assertRenderedNativeTerraces } from "./distant-terraces-native-fixture.js";

const settings = { quality: "low", outdoors: true, budgetMs: 4 };
function finish(lod, position) {
  for (let frame = 0; frame < 2000; frame++) {
    lod.update(position, settings);
    assert.ok(lod.lastWork.samples <= DISTANT_TERRAIN_LIMITS.samplesPerUpdate);
    assert.ok(lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
    if (lod._active && !lod._job) return lod._active;
  }
  assert.fail("bounded wall build did not finish");
}

function assertOwners(lod) {
  const { data, terrain } = lod._active;
  const emitted = data.terraces;
  const used = new Map(), signatures = new Set();
  let walls = 0, tall = 0, seams = 0, surfaceSkins = 0;
  for (const cell of data.cells) {
    if (!cell.valid) continue;
    const anchor = cell.anchor ?? cell.ring[0];
    const owner = [...data.surfaceData.subarray(anchor * 3, anchor * 3 + 3)];
    for (let at = cell.terraceStart + cell.count; at < cell.terraceStart + cell.terraceCount; at += 6) {
      const ids = [...emitted.indices.subarray(at, at + 6)];
      const ys = ids.map((id) => emitted.positions[id * 3 + 1]);
      const high = Math.max(...ys), low = Math.min(...ys);
      assert.equal(high, data.positions[anchor * 3 + 1], "higher native anchor owns the full riser");
      for (const id of ids) {
        const actual = [...emitted.surfaceData.subarray(id * 3, id * 3 + 3)];
        assert.deepEqual(actual, owner, "every wall vertex uses the owning cell, not the boundary sample");
        if (used.has(id)) assert.deepEqual(used.get(id), owner, "cached vertices cannot alias incompatible owners");
        used.set(id, owner);
      }
      // The native surface voxel remains unbanded; all lower wall voxel
      // centers satisfy the shader's y < top gate with uniform metadata.
      if (owner[2] > 0.5) {
        assert.equal(high, owner[1] + 1);
        for (let y = low; y < high; y++)
          assert.equal(Math.floor(y + 0.5) < owner[1], y < high - 1);
        surfaceSkins++;
      }
      signatures.add(owner[2]);
      tall += Number(high - low >= 3);
      seams += Number(cell.ring.length > 4);
      walls++;
    }
  }
  assert.ok(walls > 0 && tall > 0 && seams > 0, "exercise tall risers and stitched LOD transitions");
  const count = terrain.geometry.attributes.position.count;
  assert.ok(count <= DISTANT_TERRACE_LIMITS.vertices);
  assert.ok(terrain.geometry.drawRange.count <= DISTANT_TERRACE_LIMITS.indices);
  assert.equal(new Set(emitted.indices).size, count, "no unused emitted vertices");
  return { walls, tall, seams, surfaceSkins, signatures };
}

test("wall cache identity includes each owning surface component, preserving equal-input reuse", () => {
  const source = {
    count: 5, indexCount: 0, allValid: false,
    positions: new Float32Array(15), colors: new Float32Array(15),
    rockColors: new Float32Array(15),
    surfaceData: new Float32Array([0, 48, 1, 1, 48, 1, 0, 49, 1, 0, 48, 0, 0, 48, 1]),
  };
  const terraces = new DistantTerraces(source);
  terraces.extraVertices = 32;
  terraces.begin();
  for (const normal of [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]) {
    const ids = [0, 1, 2, 3].map((owner) => terraces.wall(0, 43, normal, owner));
    assert.equal(new Set(ids).size, 4, "phase, native top and biome flag independently prevent aliasing");
    assert.equal(terraces.wall(0, 43, normal, 4), ids[0], "identical metadata can still share");
  }
  assert.equal(terraces.vertexCount, 16, "fixed four-slot direction caches remain sufficient");
});

test("negative-coordinate multi-biome walls retain owning metadata through seams and cutouts", () => {
  const biomes = [
    { id: "badlands", category: "badlands", grassColor: "#83ac52", waterColor: "#489fbb" },
    { id: "plains", category: "plains", grassColor: "#83ac52", waterColor: "#489fbb" },
  ];
  let reads = 0;
  const height = (x, z) => 60 + Math.floor(20 * Math.sin(x / 27) * Math.cos(z / 31));
  const world = {
    seed: "wall-owner-seams", dimension: "overworld", generatorVersion: 3, chunks: new Map(),
    generator: {
      terrainHeight(x, z) { reads++; return height(x, z); },
      getBiome: (x) => biomes[Math.abs(Math.floor(x / 16)) % 2],
    },
    get() { assert.fail("render-only LOD must not read voxels"); },
    set() { assert.fail("render-only LOD must not edit voxels"); },
  };
  const lod = new DistantTerrain(new THREE.Scene(), world);
  const position = { x: -136.5, z: -248.5 };
  try {
    const { data, terrain } = finish(lod, position);
    const observed = assertOwners(lod);
    assert.deepEqual([...observed.signatures].sort(), [0, 1]);
    assert.ok(observed.surfaceSkins > 0);
    const native = assertRenderedNativeTerraces(lod, height);
    assert.equal(native.renderedRisers, observed.walls * 2);
    assert.equal(reads, data.count, "metadata repair adds no generator samples");
    const metadata = terrain.geometry.attributes.lodSurface.array;
    for (const coverage of [new Set(["-9,-16", "-8,-16"]), new Set()]) {
      lod.update(position, { ...settings, coverage, budgetMs: 0 });
      assert.equal(terrain.geometry.attributes.lodSurface.array, metadata);
      assert.equal(reads, data.count);
      assertRenderedNativeTerraces(lod, height);
      assert.equal(terrain.geometry.drawRange.count,
        data.terraces.ranges.filter((range) => !coverage.has(range.key)).reduce((sum, range) => sum + range.count, 0),
        "cutouts preserve whole-cell cap and wall ownership");
    }
    assert.equal(world.chunks.size, 0);
  } finally { lod.dispose(); }
});

test("cedar-valley native badlands repairs wall metadata without changing topology or sampling", () => {
  const generator = createGenerator("cedar-valley", "overworld", 3);
  const world = { seed: "cedar-valley", dimension: "overworld", generatorVersion: 3, chunks: new Map(), generator };
  const lod = new DistantTerrain(new THREE.Scene(), world);
  try {
    const { data, terrain } = finish(lod, { x: 728.5, y: 63.01, z: 1366.5 });
    const observed = assertOwners(lod);
    assert.equal(observed.walls * 2, 12780, "same native riser triangle topology as reproduction");
    assert.equal(data.count, 6150, "same native sample lattice as reproduction");
    assert.equal(terrain.geometry.drawRange.count, 74934, "same indexed triangles as reproduction");
    assert.ok(observed.surfaceSkins > 0);
    assertRenderedNativeTerraces(lod, (x, z) => generator.terrainHeight(x, z));
    assert.equal(world.chunks.size, 0);
  } finally { lod.dispose(); }
});
