import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantTerrain } from "../src/distant-terrain.js";
import { distantGridCells, DISTANT_NATIVE_GRID_LIMITS } from "../src/distant-grid.js";
import { createGenerator } from "../src/terrain.js";
import { assertRenderedNativeTerraces } from "./distant-terraces-native-fixture.js";
import { installDistantSurface } from "../src/distant-surface-material.js";

function finish(lod, position, quality = "low") {
  for (let i = 0; i < 2000; i++) {
    lod.update(position, { quality, outdoors: true, budgetMs: 4 });
    assert.ok(lod.lastWork.samples <= 128 && lod.lastWork.units <= 512);
    if (lod._active && !lod._job) return lod._active;
  }
  assert.fail("bounded native terrain did not finish");
}

test("native refinement keeps exact shared 2/4/8/16 block edges and bounded topology", () => {
  const refinement = new Map();
  for (let z = -8; z <= 8; z++)
    for (let x = -8; x <= 8; x++)
      refinement.set(`${x},${z}`, Math.max(Math.abs(x), Math.abs(z)) <= 4 ? 2 : 4);
  const bounds = { minX: -480, maxX: 496, minZ: -480, maxZ: 496 };
  const cells = [...distantGridCells(0, 0, bounds, "high", refinement)];
  const edges = new Map(), points = new Set();
  for (const cell of cells) {
    for (let i = 0; i < cell.boundary.length; i++) {
      const a = cell.boundary[i], b = cell.boundary[(i + 1) % cell.boundary.length];
      points.add(a.join(","));
      const key = [a.join(","), b.join(",")].sort().join("|");
      const edge = edges.get(key) ?? { a, b, count: 0 };
      edge.count++; edges.set(key, edge);
    }
    if (cell.center) points.add(cell.center.join(","));
  }
  for (const { a, b, count } of edges.values())
    assert.ok(count === 2 || (count === 1 &&
      ((a[0] === b[0] && [bounds.minX, bounds.maxX].includes(a[0])) ||
       (a[1] === b[1] && [bounds.minZ, bounds.maxZ].includes(a[1])))));
  assert.ok(points.size <= DISTANT_NATIVE_GRID_LIMITS.vertices);
  assert.ok(cells.length <= DISTANT_NATIVE_GRID_LIMITS.cells);
});

test("a two-block badlands spire stays narrow; isolated far corner maxima do not inflate whole cells", () => {
  const biome = { id: "eroded_badlands", category: "badlands", color: "#b56c40" };
  const height = (x, z) => (x >= 0 && x < 2 && z >= 0 && z < 2) || (x === 176 && z === 0) ? 80 : 30;
  const world = {
    seed: "spire", generatorVersion: 3, dimension: "overworld", chunks: new Map(),
    generator: { terrainHeight: height, getBiome: () => biome, getEndPillars: () => [] },
  };
  const lod = new DistantTerrain(new THREE.Scene(), world);
  try {
    const { data, terrain } = finish(lod, { x: 8, z: 8 });
    assert.ok(data.refinement.size > 0);
    let end = 0;
    for (const range of data.terraces.ranges) {
      assert.equal(range.start, end, "chunk ranges partition the actual rendered index buffer");
      const count = data.cells.filter((cell) => cell.key === range.key)
        .reduce((sum, cell) => sum + cell.terraceCount, 0);
      assert.equal(range.count, count);
      end += range.count;
    }
    assert.equal(end, data.terraces.indices.length);
    assert.ok(data.terraces.ranges.length < data.cells.length / 4,
      "coverage work scales with chunks rather than refined cells");
    let peakArea = 0;
    const p = terrain.geometry.attributes.position, index = terrain.geometry.index.array;
    for (let i = 0; i < terrain.geometry.drawRange.count; i += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(p, index[i + j]));
      const area = b.clone().sub(a).cross(c.clone().sub(a)).y / 2;
      if (a.y === 81 && area > 0) peakArea += area;
    }
    assert.equal(peakArea, 4, "a narrow native peak occupies 2x2, not a 16x16 pillar");
    assertRenderedNativeTerraces(lod, height);
    assert.equal(world.chunks.size, 0);
  } finally { lod.dispose(); }
});

test("real badlands use refined native anchors, band metadata and finite referenced geometry", (t) => {
  const generator = createGenerator("cedar-valley", "overworld", 3);
  const position = generator.locateBiome("eroded_badlands", { x: 0, z: 0 });
  assert.ok(position);
  const world = { seed: "cedar-valley", generatorVersion: 3, dimension: "overworld", generator, chunks: new Map() };
  const lod = new DistantTerrain(new THREE.Scene(), world);
  try {
    const start = performance.now();
    const { data, terrain } = finish(lod, position);
    assert.ok(data.refinement.size > 0);
    const native = assertRenderedNativeTerraces(lod, (x, z) => generator.terrainHeight(x, z));
    assert.equal(native.referenced, terrain.geometry.attributes.position.count);
    assert.ok([...terrain.geometry.attributes.lodSurface.array].some((v, i) => i % 3 === 2 && v === 1));
    t.diagnostic(JSON.stringify({ seed: world.seed, position, samples: data.count, cells: data.cells.length, vertices: native.referenced, buildMs: performance.now() - start }));
    assert.equal(world.chunks.size, 0);
  } finally { lod.dispose(); }
});

test("surface shader keeps version-specific band width and filterable voxel grain", () => {
  const material = new THREE.MeshLambertMaterial();
  const version = installDistantSurface(material);
  const shader = { uniforms: {}, vertexShader: "#include <begin_vertex>", fragmentShader: "#include <color_fragment>" };
  material.onBeforeCompile(shader);
  version.value = 6;
  assert.equal(shader.uniforms.uLodVersion.value, 6);
  assert.equal(shader.uniforms.uLodBands.value.length, 12);
  assert.match(shader.fragmentShader, /modern \? 2.0 : 1.0/);
  assert.match(shader.fragmentShader, /fwidth/);
  assert.match(shader.vertexShader, /attribute vec3 lodSurface/);
  material.dispose();
});

test("replacing the native column source invalidates rendered strata and cached samples", () => {
  const generator = {
    terrainHeight: () => 50,
    getBiome: () => ({ id: "badlands", category: "badlands", color: "#b56c40" }),
    sampleColumn: () => ({ landTop: 50, strataOffset: 1 }),
  };
  const world = { seed: "strata", generatorVersion: 4, dimension: "overworld", generator };
  const lod = new DistantTerrain(new THREE.Scene(), world);
  try {
    const position = { x: 0, z: 0 };
    const before = finish(lod, position);
    assert.equal(before.terrain.geometry.attributes.lodSurface.getX(0), 1);
    generator.sampleColumn = () => ({ landTop: 50, strataOffset: 5 });
    lod.update(position, { quality: "low", outdoors: true, budgetMs: 0 });
    assert.equal(lod._active, null);
    assert.equal(lod._samples.size, 0);
    const after = finish(lod, position);
    assert.equal(after.terrain.geometry.attributes.lodSurface.getX(0), 5);
  } finally { lod.dispose(); }
});
