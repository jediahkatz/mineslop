import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantTerrain, DISTANT_TERRAIN_LIMITS } from "../src/distant-terrain.js";
import { DistantTerraces, DISTANT_TERRACE_LIMITS } from "../src/distant-terraces.js";
import { createGenerator, WATER_LEVEL, WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { assertRenderedNativeTerraces } from "./distant-terraces-native-fixture.js";

const biome = { id: "plains", grassColor: "#83ac52", waterColor: "#489fbb" };
const slope = (x, z) => 32 + Math.floor(x / 7) % 18 + Math.floor(z / 11) % 13;
const position = { x: -8, z: -24 };
const settings = { outdoors: true, quality: "low", budgetMs: 4 };

function fixture(height = slope, dimension = "overworld") {
  const calls = [];
  const world = {
    seed: "terraced-test",
    dimension,
    generatorVersion: 2,
    chunks: new Map(),
    generator: {
      terrainHeight(x, z) {
        calls.push([x, z]);
        return height(x, z);
      },
      getBiome: () => biome,
    },
    get() { assert.fail("LOD must not read/load voxels"); },
    set() { assert.fail("LOD must not write voxels"); },
  };
  const lod = new DistantTerrain(new THREE.Scene(), world);
  return { world, lod, calls };
}

function finish(lod, at = position, options = settings) {
  for (let i = 0; i < 500; i++) {
    lod.update(at, options);
    assert.ok(lod.lastWork.samples <= DISTANT_TERRAIN_LIMITS.samplesPerUpdate);
    assert.ok(lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
    if (lod.ready && !lod._job) return lod._active;
  }
  assert.fail("bounded terrace build did not finish");
}

function triangles(geometry, start = 0, count = geometry.drawRange.count) {
  const points = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const result = [];
  for (let i = start; i < start + count; i += 3) {
    const ids = [0, 1, 2].map((j) => geometry.index.array[i + j]);
    result.push({
      points: ids.map((id) => new THREE.Vector3().fromBufferAttribute(points, id)),
      normals: ids.map((id) => new THREE.Vector3().fromBufferAttribute(normals, id)),
    });
  }
  return result;
}

for (const quality of ["low", "medium", "high"]) {
  test(`${quality}: only integer horizontal tops and axis-aligned vertical risers`, () => {
    const { lod, world } = fixture();
    try {
      const { terrain } = finish(lod, position, { ...settings, quality });
      let tops = 0, walls = 0;
      for (const { points: [a, b, c], normals } of triangles(terrain.geometry)) {
        const cross = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
        assert.ok(cross.length() > 0);
        const components = cross.toArray().map(Math.abs);
        assert.equal(components.filter((value) => value > 0).length, 1);
        assert.equal(Math.max(...components), 1);
        for (const normal of normals) assert.ok(normal.equals(cross), "hard face normals match winding");
        for (const point of [a, b, c]) {
          assert.ok(point.toArray().every(Number.isInteger));
          assert.ok(terrain.geometry.boundingBox.containsPoint(point));
        }
        if (cross.y === 1) {
          tops++;
          assert.equal(a.y, b.y);
          assert.equal(b.y, c.y);
        } else {
          walls++;
          assert.ok(cross.y === 0);
        }
      }
      assert.ok(tops > 0 && walls > 0);
      assert.ok(terrain.geometry.attributes.position.count <= DISTANT_TERRACE_LIMITS.vertices);
      assert.ok(terrain.geometry.index.count <= DISTANT_TERRACE_LIMITS.indices);
      assert.equal(world.chunks.size, 0);
    } finally { lod.dispose(); }
  });
}

test("every coarse/fine shared edge is either level or sealed by exactly one full riser", () => {
  const { lod } = fixture();
  try {
    const { data, terrain } = finish(lod, position, { ...settings, quality: "high" });
    const edges = new Map();
    const topAt = (cell) => data.positions[cell.ring[0] * 3 + 1];
    for (const cell of data.cells) {
      for (let i = 0; i < cell.ring.length; i++) {
        const a = cell.ring[i], b = cell.ring[(i + 1) % cell.ring.length];
        const key = [a, b].sort((x, y) => x - y).join(":");
        const edge = edges.get(key) ?? { a, b, cells: [] };
        edge.cells.push(cell);
        edges.set(key, edge);
      }
    }
    let transitions = 0, risers = 0;
    for (const { a, b, cells } of edges.values()) {
      if (cells.length === 1) {
        const [ax, , az] = data.positions.slice(a * 3, a * 3 + 3);
        const [bx, , bz] = data.positions.slice(b * 3, b * 3 + 3);
        assert.ok(
          (ax === bx && [data.bounds.minX, data.bounds.maxX].includes(ax + data.originX)) ||
          (az === bz && [data.bounds.minZ, data.bounds.maxZ].includes(az + data.originZ)),
          "no unpaired interior edges, including the 4/8/16 step transitions"
        );
        continue;
      }
      assert.equal(cells.length, 2);
      if (cells.some((cell) => cell.ring.length > 4)) transitions++;
      const [lo, hi] = cells.toSorted((a, b) => topAt(a) - topAt(b));
      if (topAt(lo) === topAt(hi)) continue;
      const wallTriangles = triangles(terrain.geometry, hi.terraceStart + hi.count, hi.terraceCount - hi.count);
      const ax = data.positions[a * 3], az = data.positions[a * 3 + 2];
      const bx = data.positions[b * 3], bz = data.positions[b * 3 + 2];
      const matching = wallTriangles.filter(({ points }) =>
        points.every((p) =>
          (p.x === ax && p.z === az) || (p.x === bx && p.z === bz)
        )
      );
      assert.equal(matching.length, 2, "one two-triangle riser spans the shared edge");
      const heights = matching.flatMap(({ points }) => points.map((p) => p.y));
      assert.equal(Math.min(...heights), topAt(lo));
      assert.equal(Math.max(...heights), topAt(hi));
      risers++;
    }
    assert.ok(transitions > 0 && risers > 0);
  } finally { lod.dispose(); }
});

test("shorelines use the terrace height, never interpolate water uphill", () => {
  const height = (x) => x < 0 ? WATER_LEVEL - 3 : WATER_LEVEL + 2;
  const { lod } = fixture(height);
  try {
    const { water, terrain, data } = finish(lod);
    for (const { points } of triangles(water.geometry)) {
      for (const point of points) {
        assert.ok(Math.abs(point.y - (WATER_LEVEL + 0.88)) < 0.00001);
        assert.ok(point.x + data.originX <= 0, "water ends at the dry terrace boundary");
      }
    }
    assert.ok(water.geometry.drawRange.count > 0);
    assert.ok(terrain.geometry.drawRange.count > water.geometry.drawRange.count);
    for (const cell of data.cells) {
      const top = data.positions[cell.ring[0] * 3 + 1];
      assert.equal(cell.wet, top < WATER_LEVEL + 0.88);
    }
  } finally { lod.dispose(); }
});

test("coverage changes remove whole terraces and risers without resampling or horizontal holes", () => {
  const { lod, calls } = fixture();
  try {
    const { terrain, data } = finish(lod);
    const before = calls.length;
    const vertices = terrain.geometry.attributes.position.array;
    const covered = new Set(["-1,-2", "0,0", "-2,1"]);
    for (const coverage of [covered, new Set()]) {
      lod.update(position, { ...settings, coverage, budgetMs: 0 });
      let area = 0;
      for (const { points: [a, b, c] } of triangles(terrain.geometry)) {
        const cross = b.clone().sub(a).cross(c.clone().sub(a));
        if (cross.y === 0) continue;
        const cx = Math.floor((a.x + b.x + c.x) / 3 / 16 + data.originX / 16);
        const cz = Math.floor((a.z + b.z + c.z) / 3 / 16 + data.originZ / 16);
        assert.equal(coverage.has(`${cx},${cz}`), false);
        area += cross.y / 2;
      }
      assert.equal(area, (data.bounds.maxX - data.bounds.minX) * (data.bounds.maxZ - data.bounds.minZ) - coverage.size * 256);
      assert.equal(terrain.geometry.attributes.position.array, vertices);
      assert.equal(calls.length, before);
    }
  } finally { lod.dispose(); }
});

test("native generator tops drive terraces without changing native samples or saves", () => {
  const generator = createGenerator("terrace-native");
  const { lod, world } = fixture();
  world.generator = generator;
  try {
    const { data, terrain } = finish(lod);
    for (const cell of data.cells) {
      const anchor = cell.ring[0] * 3;
      const x = data.positions[anchor] + data.originX;
      const z = data.positions[anchor + 2] + data.originZ;
      const expected = generator.terrainHeight(x, z) + 1;
      for (const { points } of triangles(terrain.geometry, cell.terraceStart, cell.count))
        for (const point of points) assert.equal(point.y, expected);
    }
    assert.equal(world.chunks.size, 0);
    assert.equal(data.count, 1933, "the original low-quality sample lattice is unchanged");
  } finally { lod.dispose(); }
});

test("source revision changes dispose published terrain and cancel partially built terraces", (t) => {
  t.mock.method(performance, "now", () => 0);
  for (const change of [
    (world) => { world._epoch = 1; },
    (world) => { world.generatorVersion++; },
    (world) => { world.seed = "new"; },
    (world) => { world.generator = { ...world.generator }; },
    (world) => { world.generator.terrainHeight = () => 77; },
    (world) => { world.generator.getBiome = () => ({ ...biome }); },
  ]) {
    const { lod, world } = fixture();
    try {
      const { terrain } = finish(lod);
      let disposed = 0;
      terrain.geometry.addEventListener("dispose", () => disposed++);
      const next = { ...position, x: position.x + 64 };
      for (let i = 0; i < 100 && lod._job?.phase !== "terrace"; i++)
        lod.update(next, { ...settings, budgetMs: 0.25 });
      assert.equal(lod._job?.phase, "terrace", "a replacement is partially emitted");
      change(world);
      lod.update(next, { ...settings, budgetMs: 0 });
      assert.equal(lod._job, null);
      assert.equal(lod._active, null);
      assert.equal(lod.ready, false);
      assert.equal(disposed, 1);
      assert.equal(lod._samples.size, 0);
      finish(lod, next);
    } finally { lod.dispose(); }
  }
});

test("world-edge and End-void terraces remain finite and inside the geometry bounds", () => {
  for (const dimension of ["overworld", "end"]) {
    const { lod, calls } = fixture((x) => dimension === "end" && x % 32 < 16 ? -1 : 25, dimension);
    try {
      const { terrain } = finish(lod, { x: WORLD_MAX - 8, z: WORLD_MIN + 8 });
      for (const attribute of Object.values(terrain.geometry.attributes))
        assert.ok([...attribute.array].every(Number.isFinite));
      for (const { points } of triangles(terrain.geometry))
        for (const point of points)
          assert.ok(terrain.geometry.boundingBox.containsPoint(point));
      for (const [x, z] of calls) {
        assert.ok(x >= WORLD_MIN && x < WORLD_MAX);
        assert.ok(z >= WORLD_MIN && z < WORLD_MAX);
      }
    } finally { lod.dispose(); }
  }
});

test("rough high-quality horizons safely promote indices without exceeding fixed topology limits", () => {
  const height = (x, z) => ((Math.imul(x, 198491317) ^ Math.imul(z, 6542989)) >>> 0) % 120;
  const { lod } = fixture(height);
  try {
    const { terrain, data } = finish(lod, position, { ...settings, quality: "high" });
    const count = terrain.geometry.attributes.position.count;
    assert.ok(count > 65536, "exercise the wide-index path with rough valid terrain");
    assert.ok(terrain.geometry.index.array instanceof Uint32Array);
    assert.ok(count <= DISTANT_TERRACE_LIMITS.vertices);
    assert.ok(terrain.geometry.index.count <= DISTANT_TERRACE_LIMITS.indices);
    for (const index of terrain.geometry.index.array) assert.ok(index < count);
    assert.equal(data.count, 7453, "roughness adds faces, never native queries");
    lod.update(position, { ...settings, quality: "high", coverage: new Set(["0,0"]), budgetMs: 0 });
    for (const index of terrain.geometry.index.array) assert.ok(index < count);
  } finally { lod.dispose(); }
});

test("all emitted terrain vertices are referenced and identical hard-normal vertices are shared", () => {
  for (const height of [() => 32, slope]) {
    const { lod, calls } = fixture(height);
    try {
      const { terrain, data } = finish(lod);
      const count = terrain.geometry.attributes.position.count;
      const inspected = assertRenderedNativeTerraces(lod, height);
      assert.equal(inspected.referenced, count, "no unused native-prefix vertices in terrain buffers");
      const unique = new Set();
      for (let i = 0; i < count; i++) {
        const values = ["position", "normal", "color"].flatMap((name) =>
          [...terrain.geometry.attributes[name].array.subarray(i * 3, i * 3 + 3)]
        );
        unique.add(values.join(","));
      }
      assert.equal(unique.size, count, "coplanar risers share equal endpoint/height/normal/color vertices");
      assert.equal(calls.length, data.count);
      assert.equal(calls.length, 1933);
      lod.update(position, { ...settings, budgetMs: 0 });
      assert.equal(calls.length, 1933, "zero-budget publication/cutouts never query the generator");
    } finally { lod.dispose(); }
  }
});

test("finalization returns zero-copy views of only emitted geometry before atomic publication", (t) => {
  const original = DistantTerraces.prototype.finish;
  let finalized = 0;
  const { lod } = fixture();
  t.mock.method(DistantTerraces.prototype, "finish", function () {
    const result = original.call(this);
    assert.equal(lod._active, null, "unpublished buffers remain invisible");
    assert.equal(result.positions.buffer, this.positions.buffer);
    assert.equal(result.normals.buffer, this.normals.buffer);
    assert.equal(result.colors.buffer, this.colors.buffer);
    assert.equal(result.indices.buffer, this.indices.buffer, "no large final index conversion");
    assert.equal(result.positions.length, this.vertexCount * 3);
    assert.equal(result.indices.length, this.indexCount);
    assert.equal(lod._job.cursor, lod._job.cells.length, "all cells are emitted before finalization");
    finalized++;
    return result;
  });
  try {
    finish(lod);
    assert.equal(finalized, 1);
    assert.ok(lod.ready);
  } finally { lod.dispose(); }
});
