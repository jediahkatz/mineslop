import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DISTANT_GRID_LIMITS, DISTANT_QUALITY } from "../src/distant-grid.js";
import {
  DistantTerrain,
  DISTANT_TERRAIN_LIMITS,
} from "../src/distant-terrain.js";
import {
  CHUNK_SIZE,
  createGenerator,
  WATER_LEVEL,
  WORLD_MAX,
  WORLD_MIN,
} from "../src/terrain.js";
import { describeTree } from "../src/terrain-trees.js";
import { assertRenderedNativeTerraces } from "./distant-terraces-native-fixture.js";

const plains = {
  id: "plains",
  category: "grassland",
  dimension: "overworld",
  color: "#83ac52",
  grassColor: "#83ac52",
  waterColor: "#4e9cac",
};
const position = { x: 8, y: 90, z: 8 };
const settings = { radius: 2, quality: "low", budgetMs: 4 };

function coverageAt(at, radius) {
  const covered = new Set();
  const cx = Math.floor(at.x / CHUNK_SIZE),
    cz = Math.floor(at.z / CHUNK_SIZE);
  for (let z = cz - radius; z <= cz + radius; z++)
    for (let x = cx - radius; x <= cx + radius; x++)
      if (
        x * CHUNK_SIZE >= WORLD_MIN &&
        x * CHUNK_SIZE < WORLD_MAX &&
        z * CHUNK_SIZE >= WORLD_MIN &&
        z * CHUNK_SIZE < WORLD_MAX
      )
        covered.add(`${x},${z}`);
  return covered;
}

function viewOptions(at, options = settings) {
  return { coverage: coverageAt(at, options.radius ?? 2), ...options };
}

function fixture(height = () => 32, getBiome = () => plains) {
  const scene = new THREE.Scene();
  const calls = { heights: 0, biomes: 0 };
  const world = {
    seed: "distant-test",
    dimension: "overworld",
    generatorVersion: 2,
    chunks: new Map(),
    generator: {
      terrainHeight(x, z) {
        calls.heights++;
        return height(x, z);
      },
      getBiome(x, z, y) {
        calls.biomes++;
        return getBiome(x, z, y);
      },
    },
    get() {
      throw new Error("LOD must not read full-detail voxel data");
    },
    ensureArea() {
      throw new Error("LOD must not generate full-detail chunks");
    },
    set() {
      throw new Error("LOD must not edit the world");
    },
  };
  return { scene, world, calls, lod: new DistantTerrain(scene, world) };
}

function finish(
  lod,
  at = position,
  options = settings,
  accept = () => lod.ready
) {
  for (let frame = 0; frame < 300; frame++) {
    lod.update(at, viewOptions(at, options));
    if (accept()) return;
  }
  assert.fail("bounded LOD work did not finish");
}

function surface(lod) {
  return lod.group.getObjectByName("Distant terrain surface");
}

function assertCutout(lod, at, radius) {
  const mesh = surface(lod);
  const origin = mesh.parent.position;
  const geometry = mesh.geometry;
  const points = geometry.getAttribute("position");
  const cx = Math.floor(at.x / CHUNK_SIZE),
    cz = Math.floor(at.z / CHUNK_SIZE);
  const hole = {
    minX: (cx - radius) * CHUNK_SIZE,
    maxX: (cx + radius + 1) * CHUNK_SIZE,
    minZ: (cz - radius) * CHUNK_SIZE,
    maxZ: (cz + radius + 1) * CHUNK_SIZE,
  };
  let area = 0;
  for (let i = 0; i < geometry.drawRange.count; i += 3) {
    const vertices = [0, 1, 2].map((offset) => {
      const index = geometry.index.getX(i + offset);
      return [points.getX(index) + origin.x, points.getZ(index) + origin.z];
    });
    const minX = Math.min(...vertices.map(([x]) => x));
    const maxX = Math.max(...vertices.map(([x]) => x));
    const minZ = Math.min(...vertices.map(([, z]) => z));
    const maxZ = Math.max(...vertices.map(([, z]) => z));
    assert.equal(
      minX < hole.maxX &&
        maxX > hole.minX &&
        minZ < hole.maxZ &&
        maxZ > hole.minZ,
      false,
      "no triangle crosses the exact full-detail square"
    );
    const [a, b, c] = vertices;
    const twiceArea =
      (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
    assert.ok(twiceArea > 0, "surface triangles face upward");
    area += twiceArea / 2;
  }
  const xs = Array.from({ length: points.count }, (_, i) => points.getX(i));
  const zs = Array.from({ length: points.count }, (_, i) => points.getZ(i));
  const outerArea =
    (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
  assert.equal(
    area,
    outerArea - (hole.maxX - hole.minX) * (hole.maxZ - hole.minZ),
    "the entire outer ring is covered exactly once, with no unfilled strip"
  );
}

test("distant geometry leaves the exact chunk-aligned square empty, including negative coordinates", () => {
  for (const at of [position, { x: -17.1, y: 90, z: -0.1 }]) {
    const { lod, world } = fixture();
    finish(lod, at);
    assertCutout(lod, at, 2);
    assert.equal(world.chunks.size, 0);
    lod.dispose();
  }
});

test("the old LOD remains visible with a newly cut exact hole while its replacement builds", () => {
  const { lod } = fixture();
  finish(lod);
  const old = lod.group.children[0];
  let disposed = 0;
  surface(lod).geometry.addEventListener("dispose", () => disposed++);
  const next = { x: 40.1, y: 90, z: -0.1 };
  lod.update(next, viewOptions(next, { ...settings, budgetMs: 0 }));
  assert.equal(lod.ready, true);
  assert.equal(lod.group.children[0], old);
  assert.equal(disposed, 0);
  assertCutout(lod, next, 2);
  finish(lod, next, settings, () => lod.ready && lod.group.children[0] !== old);
  assert.equal(disposed, 1);
  assertCutout(lod, next, 2);
  lod.dispose();
});

test("quality increases horizon coverage with two meshes and bounded indexed buffers", (t) => {
  let previousDistance = 0;
  for (const [quality, radius] of [
    ["low", 2],
    ["medium", 3],
    ["high", 4],
  ]) {
    const { lod } = fixture(() => 18);
    finish(lod, position, { ...settings, quality, radius });
    assert.ok(lod.fogDistance > previousDistance);
    assert.equal(lod.fogDistance, DISTANT_QUALITY[quality].horizon);
    previousDistance = lod.fogDistance;
    let vertices = 0,
      triangles = 0,
      meshes = 0,
      bytes = 0;
    lod.group.traverse((object) => {
      if (!object.isMesh) return;
      meshes++;
      vertices += object.geometry.getAttribute("position").count;
      triangles += object.geometry.drawRange.count / 3;
      bytes += object.geometry.index.array.byteLength;
      assert.ok(object.geometry.index.array instanceof Uint16Array);
      assert.ok(object.geometry.index.count <= DISTANT_GRID_LIMITS.indices);
      for (const attribute of Object.values(object.geometry.attributes))
        bytes += attribute.array.byteLength;
      assert.equal(object.castShadow, false);
      assert.equal(object.receiveShadow, false);
      const points = object.geometry.getAttribute("position");
      assert.ok(points.count <= DISTANT_GRID_LIMITS.vertices);
      assert.ok(
        [...object.geometry.index.array].every((index) => index < points.count)
      );
      const point = new THREE.Vector3();
      for (let i = 0; i < points.count; i++) {
        point.fromBufferAttribute(points, i);
        assert.ok(object.geometry.boundingBox.containsPoint(point));
        assert.ok(
          point.distanceTo(object.geometry.boundingSphere.center) <=
            object.geometry.boundingSphere.radius + 0.00001
        );
      }
    });
    assert.equal(meshes, 2);
    assert.ok(vertices <= DISTANT_GRID_LIMITS.vertices * 2);
    assert.ok(triangles <= (DISTANT_GRID_LIMITS.indices * 2) / 3);
    assert.ok(
      bytes <= 851968,
      "both terrain/water GPU buffers fit within 832 KiB"
    );
    t.diagnostic(
      JSON.stringify({
        quality,
        horizon: lod.fogDistance,
        vertices,
        triangles,
        bytes,
      })
    );
    assertCutout(lod, position, radius);
    lod.dispose();
  }
});

test("water covers only submerged terrain cells at the full-detail water surface level", () => {
  const wet = fixture(() => 18);
  finish(wet.lod);
  const water = wet.lod.group.getObjectByName("Distant water");
  assert.equal(water.visible, true);
  const land = surface(wet.lod).geometry;
  assert.equal(water.geometry.drawRange.count, land.drawRange.count);
  assert.deepEqual(
    water.geometry.index.array.slice(0, water.geometry.drawRange.count),
    land.index.array.slice(0, land.drawRange.count),
    "water uses the same exact inner cutout"
  );
  const positions = water.geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    assert.ok(Math.abs(positions.getY(i) - (WATER_LEVEL + 0.88)) < 0.00001);
  }
  wet.lod.dispose();
  const dry = fixture(() => WATER_LEVEL + 10);
  finish(dry.lod);
  assert.equal(dry.lod.group.getObjectByName("Distant water").visible, false);
  dry.lod.dispose();
});

test("far world positions retain small local vertices and do not sample beyond world bounds", () => {
  const samples = [];
  const { lod } = fixture((x, z) => {
    samples.push([x, z]);
    return 31;
  });
  const far = { x: WORLD_MAX - 80.25, y: 90, z: WORLD_MIN + 90.25 };
  finish(lod, far, { ...settings, quality: "high", radius: 4 });
  const mesh = surface(lod);
  assert.equal(
    mesh.parent.position.x,
    Math.floor(far.x / CHUNK_SIZE) * CHUNK_SIZE
  );
  assert.equal(
    mesh.parent.position.z,
    Math.floor(far.z / CHUNK_SIZE) * CHUNK_SIZE
  );
  const points = mesh.geometry.getAttribute("position");
  for (let i = 0; i < points.count; i++) {
    assert.ok(Math.abs(points.getX(i)) <= 512);
    assert.ok(Math.abs(points.getZ(i)) <= 512);
    assert.ok(Number.isInteger(points.getX(i)));
    assert.equal(points.getY(i), 32);
  }
  assert.ok(
    samples.every(
      ([x, z]) =>
        x >= WORLD_MIN && x < WORLD_MAX && z >= WORLD_MIN && z < WORLD_MAX
    )
  );
  assert.ok(
    lod.fogDistance > 100 &&
      lod.fogDistance <= lod._active.data.request.horizon,
    "a real world edge does not collapse the inland horizon"
  );
  lod.dispose();
});

test("an explicit zero budget defers terrain sampling and a stalled clock cannot remove the work cap", (t) => {
  const { lod, calls } = fixture();
  lod.update(position, { ...settings, budgetMs: 0 });
  assert.equal(calls.heights, 0);
  assert.equal(lod.ready, false);
  t.mock.method(performance, "now", () => 0);
  lod.update(position, { ...settings, quality: "high", budgetMs: 1000 });
  assert.ok(calls.heights > 0 && calls.heights <= 128);
  assert.ok(lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
  assert.equal(lod.lastWork.samples, calls.heights);
  assert.equal(lod.ready, false);
  lod.dispose();
});

test("sampling stops at the elapsed time budget without timers or background work", (t) => {
  const { lod, calls } = fixture();
  let clock = 0;
  t.mock.method(performance, "now", () => (clock += 0.5));
  lod.update(position, { ...settings, budgetMs: 2 });
  assert.ok(calls.heights > 0 && calls.heights <= 3);
  assert.equal(lod.ready, false);
  lod.dispose();
});

test("seed and generator changes cancel unfinished samples rather than mixing worlds", () => {
  const { lod, world, calls } = fixture(() => 10);
  lod.update(position, settings);
  assert.equal(lod.ready, false);
  const oldCalls = calls.heights;
  world.seed = "replacement-seed";
  world.generator = { terrainHeight: () => 44, getBiome: () => plains };
  finish(lod);
  assert.equal(calls.heights, oldCalls);
  const points = surface(lod).geometry.getAttribute("position");
  for (let i = 0; i < points.count; i++) assert.equal(points.getY(i), 45);
  assert.equal(lod.group.children[0].userData.seed, "replacement-seed");
  lod.dispose();
});

test("crossing a biome boundary retains coordinate-owned samples and partial jobs", () => {
  let current = plains;
  const { lod, calls } = fixture(
    () => 10,
    () => current
  );
  lod.update(position, settings);
  const pending = lod._job;
  const samples = lod._samples;
  const before = calls.heights;
  current = { ...plains, id: "desert", category: "desert" };
  const next = { ...position, x: 24 };
  lod.update(next, viewOptions(next, { ...settings, budgetMs: 0 }));
  assert.equal(lod._job, pending);
  assert.equal(lod._samples, samples);
  assert.equal(calls.heights, before);
  finish(lod, next);
  assert.equal(calls.heights, lod._active.data.count);
  assertCutout(lod, next, 2);
  lod.dispose();
});

test("dimension transitions dispose LOD, while cave labels only hide it", () => {
  let currentBiome = plains;
  const { lod, world, calls } = fixture(
    () => 32,
    () => currentBiome
  );
  finish(lod);
  let disposed = 0;
  surface(lod).geometry.addEventListener("dispose", () => disposed++);
  const oldCalls = calls.heights;
  world.dimension = "nether";
  lod.update(position, settings);
  assert.equal(lod.ready, false);
  assert.equal(lod.fogDistance, 0);
  assert.equal(lod.group.children.length, 0);
  assert.equal(calls.heights, oldCalls);
  assert.equal(disposed, 1);
  world.dimension = "overworld";
  finish(lod);
  const restored = lod._active;
  const beforeCave = calls.heights;
  currentBiome = { ...plains, id: "lush_caves", category: "cave" };
  lod.update(position, settings);
  assert.equal(lod.ready, false);
  assert.equal(lod.group.visible, false);
  assert.equal(lod.fogDistance, 0);
  assert.equal(lod._active, restored);
  assert.equal(lod.group.children.length, 1);
  assert.equal(calls.heights, beforeCave);
  lod.dispose();
});

test("large teleports hide the old ring until a correctly centered replacement is complete", () => {
  const { lod } = fixture();
  finish(lod);
  const old = lod.group.children[0];
  const destination = { x: 12001.5, y: 90, z: -17005.5 };
  lod.update(destination, { ...settings, budgetMs: 0 });
  assert.equal(lod.ready, false);
  assert.equal(lod.fogDistance, 0);
  assert.equal(
    lod.group.children[0],
    old,
    "old resources stay alive until the atomic swap"
  );
  finish(lod, destination);
  assert.notEqual(lod.group.children[0], old);
  assertCutout(lod, destination, 2);
  lod.dispose();
});

test("invalid heights and colors cannot create NaN geometry, and End void remains empty", () => {
  const { lod } = fixture(
    (x, z) => (x < 0 ? NaN : z < 0 ? Infinity : 25),
    () => ({ id: "unknown", color: "invalid", waterColor: null })
  );
  finish(lod);
  lod.group.traverse((object) => {
    if (!object.isMesh) return;
    for (const attribute of Object.values(object.geometry.attributes)) {
      assert.ok([...attribute.array].every(Number.isFinite));
    }
  });
  lod.update({ x: NaN, z: 0 }, settings);
  assert.equal(lod.ready, false);
  lod.dispose();
  const empty = fixture(
    () => -1,
    () => ({ id: "the_void", category: "void" })
  );
  empty.world.dimension = "end";
  finish(empty.lod);
  assert.equal(surface(empty.lod).geometry.drawRange.count, 0);
  assert.equal(empty.lod.group.getObjectByName("Distant water"), undefined);
  empty.lod.dispose();
});

test("real seeded generator samples agree with LOD heights without loading any chunks", () => {
  const generator = createGenerator("distant-height-agreement");
  const scene = new THREE.Scene();
  const world = {
    seed: "distant-height-agreement",
    dimension: "overworld",
    generator,
    chunks: new Map(),
  };
  const lod = new DistantTerrain(scene, world);
  const at = { x: -40.5, y: 95, z: 61.5 };
  finish(lod, at);
  const inspected = assertRenderedNativeTerraces(lod, (x, z) => generator.terrainHeight(x, z));
  assert.ok(inspected.renderedRisers > 0);
  assert.equal(world.chunks.size, 0);
  lod.dispose();
});

test("disposal releases both meshes and shared materials exactly once and prevents later work", () => {
  const { lod, scene, calls } = fixture(() => 18);
  finish(lod);
  let geometries = 0,
    materials = 0;
  lod.group.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.addEventListener("dispose", () => geometries++);
    object.material.addEventListener("dispose", () => materials++);
  });
  lod.update({ ...position, x: 40 }, settings);
  const before = calls.heights;
  lod.dispose();
  lod.dispose();
  assert.equal(lod.update(position, settings), false);
  assert.equal(calls.heights, before);
  assert.equal(geometries, 2);
  assert.equal(materials, 2);
  assert.equal(scene.children.length, 0);
  assert.equal(lod.fogDistance, 0);
});

function assertCoverage(lod, covered) {
  const mesh = surface(lod),
    data = lod._active.data;
  const geometry = mesh.geometry,
    points = geometry.getAttribute("position");
  let area = 0;
  for (let i = 0; i < geometry.drawRange.count; i += 3) {
    const vertices = [0, 1, 2].map((offset) => {
      const at = geometry.index.getX(i + offset);
      return [points.getX(at) + data.originX, points.getZ(at) + data.originZ];
    });
    const minX = Math.min(...vertices.map(([x]) => x));
    const maxX = Math.max(...vertices.map(([x]) => x));
    const minZ = Math.min(...vertices.map(([, z]) => z));
    const maxZ = Math.max(...vertices.map(([, z]) => z));
    const cx = Math.floor(minX / CHUNK_SIZE),
      cz = Math.floor(minZ / CHUNK_SIZE);
    assert.ok(maxX <= (cx + 1) * CHUNK_SIZE && maxZ <= (cz + 1) * CHUNK_SIZE);
    assert.equal(
      covered.has(`${cx},${cz}`),
      false,
      "no proxy crosses a covered chunk"
    );
    const [a, b, c] = vertices;
    area += ((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1])) / 2;
  }
  const bounds = data.bounds;
  let expected = (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ);
  for (const key of covered) {
    const [cx, cz] = key.split(",").map(Number);
    expected -=
      Math.max(
        0,
        Math.min(bounds.maxX, (cx + 1) * CHUNK_SIZE) -
          Math.max(bounds.minX, cx * CHUNK_SIZE)
      ) *
      Math.max(
        0,
        Math.min(bounds.maxZ, (cz + 1) * CHUNK_SIZE) -
          Math.max(bounds.minZ, cz * CHUNK_SIZE)
      );
  }
  assert.equal(
    area,
    expected,
    "every uncovered cell is indexed, including interior rows"
  );
}

function groundAt(lod, x, z) {
  if (!lod.group.visible) return null;
  lod.group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(
    new THREE.Vector3(x, 512, z),
    new THREE.Vector3(0, -1, 0)
  );
  return ray.intersectObject(surface(lod), false)[0]?.point.y ?? null;
}

for (const [quality, radius] of [
  ["low", 2],
  ["medium", 3],
  ["high", 4],
]) {
  test(`${quality}: disconnected coverage, absent rows and their return only rewrite indices`, () => {
    const { lod, calls, world } = fixture();
    const at = { x: -0.1, y: 152, z: -16.1 };
    const full = coverageAt(at, radius);
    const options = { ...settings, quality, radius, coverage: full };
    finish(lod, at, options);
    const vertices = surface(lod).geometry.getAttribute("position").array;
    const before = calls.heights;
    const rowMissing = new Set(
      [...full].filter((key) => !key.startsWith("-1,"))
    );
    const disconnected = new Set([...full].filter((_, i) => i % 3 === 0));
    for (const coverage of [rowMissing, disconnected, new Set(), full]) {
      lod.update(at, { ...options, coverage, budgetMs: 0 });
      assert.equal(lod.ready, true);
      assert.equal(
        surface(lod).geometry.getAttribute("position").array,
        vertices
      );
      assert.equal(calls.heights, before);
      assertCoverage(lod, coverage);
      assert.equal(
        groundAt(lod, at.x, at.z),
        coverage.has("-1,-2") ? null : 33
      );
    }
    assert.equal(
      world.chunks.size,
      0,
      "LOD never loads detail to satisfy a coverage hole"
    );
    lod.dispose();
  });
}

test("no coverage argument means no fictitious hole, even directly below a high flyer", () => {
  const { lod } = fixture();
  for (let i = 0; i < 100 && !lod.ready; i++)
    lod.update({ ...position, y: 152 }, settings);
  assert.equal(lod.ready, true);
  assertCoverage(lod, new Set());
  assert.equal(groundAt(lod, position.x, position.z), 33);
  lod.dispose();
});

test("quality changes retain usable coverage, cancel obsolete jobs and never require a full detail square", () => {
  const { lod } = fixture();
  const coverage = new Set(["0,0", "-1,1"]);
  finish(lod, position, { ...settings, coverage });
  const old = lod._active;
  lod.update(position, {
    ...settings,
    quality: "high",
    radius: 4,
    coverage,
    budgetMs: 0,
  });
  assert.equal(lod._active, old);
  assert.equal(lod.ready, true);
  assertCoverage(lod, coverage);
  lod.update(position, { ...settings, quality: "high", radius: 4, coverage });
  assert.ok(lod._job);
  lod.update(position, { ...settings, coverage, budgetMs: 0 });
  assert.equal(lod._job, null);
  assert.equal(lod._active, old);
  finish(
    lod,
    position,
    { ...settings, quality: "high", radius: 4, coverage },
    () => lod._active !== old
  );
  assert.equal(lod.ready, true);
  assertCoverage(lod, coverage);
  lod.dispose();
});

test("ground and water retain their full high-quality bounds while low canopies finish", (t) => {
  t.mock.method(performance, "now", () => 0);
  const { lod, world, calls } = fixture(() => 18);
  world.generator.getTrees = () => [];
  const coverage = new Set(["0,0"]);
  const options = { ...settings, quality: "high", radius: 4, coverage };
  try {
    finish(lod, position, { ...settings, coverage });
    const lowCanopy = lod._vegetation;
    finish(
      lod,
      position,
      options,
      () => lod._active.data.request.quality === "high"
    );
    const ground = lod._active;
    const terrain = ground.terrain.geometry;
    const water = ground.water.geometry;
    const vertices = terrain.getAttribute("position").array;
    assert.equal(lod._vegetation, lowCanopy);
    assert.equal(lod._vegetationJob.request.quality, "high");
    assert.equal(lod._vegetationJob.job.done, false);
    const horizonZ = position.z - 208;
    assert.ok(horizonZ < lowCanopy.bounds.minZ);
    assert.equal(groundAt(lod, position.x, horizonZ), 19);

    const before = calls.heights;
    for (const covered of [new Set(), coverageAt(position, 4), coverage]) {
      lod.update(position, { ...options, coverage: covered, budgetMs: 0 });
      assert.equal(lod.ready, true);
      assert.equal(lod._vegetation, lowCanopy);
      assert.equal(terrain.getAttribute("position").array, vertices);
      assert.equal(calls.heights, before);
      assertCoverage(lod, covered);
      assert.equal(water.drawRange.count, terrain.drawRange.count);
      assert.deepEqual(
        water.index.array.slice(0, water.drawRange.count),
        terrain.index.array.slice(0, terrain.drawRange.count),
        "water fills every submerged ground cell, not just the old canopy"
      );
      assert.equal(
        groundAt(lod, position.x, position.z),
        covered.has("0,0") ? null : 19
      );
      assert.equal(groundAt(lod, position.x, horizonZ), 19);
    }

    const terrainVersion = terrain.index.version;
    const waterVersion = water.index.version;
    finish(lod, position, options, () => lod._vegetation !== lowCanopy);
    assert.equal(lod._active, ground);
    assert.equal(terrain.index.version, terrainVersion);
    assert.equal(water.index.version, waterVersion);
    assertCoverage(lod, coverage);
    assert.equal(world.chunks.size, 0, "no full-detail generation");
  } finally {
    lod.dispose();
  }
});

test("world resets invalidate identical coordinates, and long travel bounds the sample cache", () => {
  const { lod, world } = fixture();
  finish(lod);
  const old = lod._active;
  world._epoch = 1;
  lod.update(position, { ...settings, budgetMs: 0 });
  assert.equal(lod.ready, false);
  assert.equal(lod._active, null);
  assert.equal(old.group.parent, null);
  for (let step = 0; step < 5; step++) {
    const at = { x: 4096 * step + 8, y: 152, z: -4096 * step + 8 };
    finish(
      lod,
      at,
      { ...settings, quality: "high", radius: 4 },
      () =>
        lod.ready &&
        lod._active.data.originX === Math.floor(at.x / CHUNK_SIZE) * CHUNK_SIZE
    );
    assert.ok(lod._samples.size <= 8192);
    assert.equal(
      lod.group.children.length,
      1,
      "only one ground layer remains resident"
    );
  }
  lod.dispose();
});

test("an exposed cave label keeps outdoor LOD, but actual shelter hides it", () => {
  const { lod } = fixture(
    () => 32,
    () => ({ ...plains, category: "cave" })
  );
  finish(lod, position, { ...settings, outdoors: true, coverage: new Set() });
  const ground = lod._active;
  assert.equal(groundAt(lod, position.x, position.z), 33);
  lod.update(position, { ...settings, outdoors: false, budgetMs: 0 });
  assert.equal(lod.ready, false);
  assert.equal(groundAt(lod, position.x, position.z), null);
  assert.equal(lod.group.children.length, 1);
  lod.update(position, { ...settings, outdoors: true, budgetMs: 0 });
  assert.equal(lod.ready, true);
  assert.equal(lod._active, ground);
  lod.dispose();
});

test("a cave look-back reuses ground and canopy immediately with current cutouts", (t) => {
  t.mock.method(performance, "now", () => 0);
  const { lod, world, calls } = fixture();
  const mouth = { x: 60.5, y: 38.62, z: 986.5 };
  const occluded = { x: 60.5, y: 21.63, z: 937.5 };
  const lookBack = { x: 60.5, y: 31.62, z: 964.25 };
  const tree = describeTree(
    60,
    1000,
    { top: 32, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  let treeReads = 0;
  world.generator.getTrees = (gx, gz) => {
    treeReads++;
    return gx === 7 && gz === 125 ? [tree] : [];
  };
  const options = {
    ...settings,
    outdoors: true,
    coverage: new Set(["3,61"]),
  };
  let disposed = 0;
  try {
    finish(lod, mouth, options);
    const ground = lod._active;
    const canopy = lod._vegetation;
    const canopyCount = canopy.layer.mesh.geometry.drawRange.count;
    assert.ok(canopyCount > 0);
    const heights = calls.heights;
    const trees = treeReads;
    const samples = lod._samples.size;
    const hulls = lod._treeSamples.primitiveCount;
    for (const mesh of [ground.terrain, ground.water, canopy.layer.mesh])
      mesh.geometry.addEventListener("dispose", () => disposed++);
    const coverage = new Set(["3,62"]);
    for (let visit = 0; visit < 3; visit++) {
      for (let frame = 0; frame < 12; frame++) {
        assert.equal(
          lod.update(occluded, { ...options, outdoors: false }),
          false
        );
        assert.equal(lod.ready, false);
        assert.equal(lod.fogDistance, 0);
        assert.equal(lod.group.visible, false);
        assert.equal(lod._active, ground);
        assert.equal(lod._vegetation, canopy);
        assert.equal(lod._job, null);
        assert.equal(lod._vegetationJob, null);
        assert.deepEqual(lod.lastWork, { units: 0, samples: 0 });
      }
      assert.equal(
        lod.update(lookBack, { ...options, coverage, budgetMs: 0 }),
        true,
        "the first visible update must not need another build"
      );
      assert.equal(lod._active, ground);
      assert.equal(lod._vegetation, canopy);
      assert.equal(lod.fogDistance, DISTANT_QUALITY.low.horizon);
      assert.equal(lod.group.children.length, 2);
      assertCoverage(lod, coverage);
      assert.ok(canopy.layer.mesh.geometry.drawRange.count < canopyCount);
      assert.equal(calls.heights, heights);
      assert.equal(treeReads, trees);
      assert.equal(lod._samples.size, samples);
      assert.equal(lod._treeSamples.primitiveCount, hulls);
      assert.equal(disposed, 0);
    }
    assert.equal(world.chunks.size, 0, "no detail generation or residency");
    lod.update(occluded, { ...options, outdoors: false });
  } finally {
    lod.dispose();
  }
  assert.equal(disposed, 3, "hidden/reused geometry still has one owner");
  lod.dispose();
  assert.equal(disposed, 3);
});

test("occlusion suspends partial terrain and canopy jobs without restarting them", (t) => {
  t.mock.method(performance, "now", () => 0);
  const { lod, world, calls } = fixture();
  let trees = 0;
  world.generator.getTrees = () => {
    trees++;
    return [];
  };
  const options = { ...settings, outdoors: true };
  try {
    lod.update(position, options);
    const ground = lod._job;
    const canopy = lod._vegetationJob;
    assert.ok(ground && canopy);
    const cursor = ground.cursor;
    const heights = calls.heights;
    const treeReads = trees;
    const canopySamples = canopy.job.sampleCount;
    for (let frame = 0; frame < 12; frame++) {
      lod.update(position, { ...options, outdoors: false });
      assert.equal(lod._job, ground);
      assert.equal(lod._vegetationJob, canopy);
      assert.equal(ground.cursor, cursor);
      assert.equal(canopy.job.sampleCount, canopySamples);
      assert.equal(canopy.job._disposed, false);
      assert.deepEqual(lod.lastWork, { units: 0, samples: 0 });
    }
    assert.equal(calls.heights, heights);
    assert.equal(trees, treeReads);
    lod.update(position, options);
    assert.equal(lod._job, ground);
    assert.equal(lod._vegetationJob, canopy);
    assert.ok(ground.cursor > cursor);
    assert.ok(canopy.job.sampleCount > canopySamples);
    finish(lod, position, options);
    assert.equal(lod._active.data, ground);
    assert.equal(lod.ready, true);
  } finally {
    lod.dispose();
  }
});

test("hidden resources still invalidate on world identity changes and dispose once", (t) => {
  t.mock.method(performance, "now", () => 0);
  const changes = [
    (world) => {
      world.seed = "replacement";
    },
    (world) => {
      world.generatorVersion++;
    },
    (world) => {
      world._epoch = 1;
    },
    (world) => {
      world.generator = { ...world.generator };
    },
    (world) => {
      world.dimension = "end";
    },
    (world) => {
      world.dimension = "nether";
    },
  ];
  for (const change of changes) {
    const { lod, world } = fixture();
    world.generator.getTrees = () => [];
    const options = { ...settings, outdoors: true };
    let disposed = 0;
    try {
      finish(lod, position, options);
      for (const mesh of [
        lod._active.terrain,
        lod._active.water,
        lod._vegetation.layer.mesh,
      ])
        mesh.geometry.addEventListener("dispose", () => disposed++);
      const next = { ...position, x: 40 };
      lod.update(next, options);
      const pending = lod._vegetationJob?.job;
      assert.ok(lod._job && pending);
      lod.update(next, { ...options, outdoors: false });
      assert.equal(disposed, 0);
      change(world);
      lod.update(next, { ...options, outdoors: false, budgetMs: 0 });
      assert.equal(lod.ready, false);
      assert.equal(lod.fogDistance, 0);
      assert.equal(lod._active, null);
      assert.equal(lod._vegetation, null);
      assert.equal(lod._job, null);
      assert.equal(lod._vegetationJob, null);
      assert.equal(pending._disposed, true);
      assert.equal(lod._samples.size, 0);
      assert.equal(lod._treeSamples.size, 0);
      assert.equal(lod.group.children.length, 0);
      assert.equal(disposed, 3);
    } finally {
      lod.dispose();
    }
    assert.equal(disposed, 3);
  }
});

test("an incompatible reveal cancels suspended jobs before resuming work", (t) => {
  t.mock.method(performance, "now", () => 0);
  for (const [at, replacement] of [
    [position, { quality: "high" }],
    [position, { radius: 4 }],
    [{ ...position, x: 12008 }, {}],
  ]) {
    const { lod, world } = fixture();
    world.generator.getTrees = () => [];
    const options = { ...settings, outdoors: true };
    try {
      lod.update(position, options);
      const pending = lod._vegetationJob.job;
      lod.update(position, { ...options, outdoors: false });
      lod.update(at, { ...options, ...replacement, budgetMs: 0 });
      assert.equal(lod.ready, false);
      assert.equal(lod._job, null);
      assert.equal(lod._vegetationJob, null);
      assert.equal(pending._disposed, true);
      finish(lod, at, { ...options, ...replacement });
      assert.equal(lod.ready, true);
    } finally {
      lod.dispose();
    }
  }
});

test("native canopies share live cutouts and survive independent ground and forest replacements", () => {
  const { lod, world } = fixture();
  const tree = describeTree(
    -2,
    -2,
    { top: 32, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  let calls = 0;
  world.generator.getTrees = (gx, gz) => {
    calls++;
    return gx === -1 && gz === -1 ? [tree] : [];
  };
  const options = { ...settings, coverage: new Set() };
  finish(lod, position, options);
  const original = lod._vegetation;
  const geometry = original.layer.mesh.geometry;
  const indices = geometry.index.array.slice(0, geometry.drawRange.count);
  const before = calls;
  lod.update(position, {
    ...options,
    coverage: new Set(["-1,-1"]),
    budgetMs: 0,
  });
  assert.ok(
    geometry.drawRange.count > 0 && geometry.drawRange.count < indices.length
  );
  lod.update(position, { ...options, budgetMs: 0 });
  assert.deepEqual(
    geometry.index.array.slice(0, geometry.drawRange.count),
    indices
  );
  assert.equal(calls, before, "cutout changes never resample native trees");
  let disposed = 0;
  geometry.addEventListener("dispose", () => disposed++);
  const ground = lod._active;
  const next = { ...position, x: 40 };
  // Warm hull caches can now finish before ground; cold forests can finish
  // after it. Neither publication order may clear the other active layer.
  finish(lod, next, options, () => {
    assert.equal(lod.ready, true);
    assert.equal(lod._vegetation.layer.group.parent, lod.group);
    assert.equal(disposed, lod._vegetation === original ? 0 : 1);
    return lod._active !== ground && lod._vegetation !== original;
  });
  assert.equal(disposed, 1);
  assert.equal(
    lod.group.children.length,
    2,
    "one ground layer and one merged canopy"
  );
  // Ground generation can exhaust this frame's real-time budget before the
  // replacement canopy job is admitted. Observe the state under test explicitly.
  finish(lod, { ...next, x: 80 }, options, () => Boolean(lod._vegetationJob));
  const pending = lod._vegetationJob.job;
  world.dimension = "nether";
  lod.update(next, options);
  assert.equal(pending._disposed, true);
  assert.equal(lod.group.children.length, 0);
  lod.dispose();
});

test("terrain and native canopy sampling share a bounded update, including a stalled clock", (t) => {
  const { lod, world, calls } = fixture();
  let trees = 0;
  world.generator.getTrees = () => {
    trees++;
    return [];
  };
  t.mock.method(performance, "now", () => 0);
  lod.update(position, { ...settings, quality: "high", budgetMs: 0 });
  assert.equal(trees, 0);
  assert.equal(calls.heights, 0);
  lod.update(position, { ...settings, quality: "high", budgetMs: 10000 });
  assert.ok(calls.heights > 0 && calls.heights <= 128);
  assert.ok(trees > 0 && trees <= 64);
  assert.ok(lod._vegetationJob.job.totalSamples < 16384);
  assert.equal(lod.ready, false);
  const pending = lod._vegetationJob.job;
  lod.dispose();
  assert.equal(pending._disposed, true);
});

test("unknown Overworld samples cap fog until authoritative detail owns them", () => {
  const { lod } = fixture((x) => (x < -80 ? NaN : 32));
  try {
    const options = { ...settings, quality: "high", coverage: new Set() };
    finish(lod, position, options);
    assert.ok(lod.fogDistance > 0 && lod.fogDistance <= 80);
    assert.ok(lod._active.data.unknownChunks.size > 0);
    assert.equal(groundAt(lod, -100, 8), null);
    assert.equal(groundAt(lod, 8, 8), 33);
    const samples = lod._samples.size;
    lod.update(position, {
      ...options,
      coverage: new Set(lod._active.data.unknownChunks),
      budgetMs: 0,
    });
    assert.equal(lod.fogDistance, DISTANT_QUALITY.high.horizon);
    assert.equal(
      lod._samples.size,
      samples,
      "authoritative coverage only changes indices/fog"
    );
  } finally {
    lod.dispose();
  }
});

test("over-budget canopy replacements never publish partial geometry or retire the old view", (t) => {
  t.mock.method(performance, "now", () => 0);
  const { lod, world } = fixture();
  lod._vegetationLimits = { vertices: 0, indices: 0 };
  let reads = 0;
  const tree = describeTree(
    240,
    8,
    { top: 32, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  world.generator.getTrees = (gx, gz) => {
    reads++;
    return gx === 30 && gz === 1 ? [tree] : [];
  };
  const options = { ...settings, coverage: new Set() };
  try {
    finish(lod, position, options);
    const previous = lod._vegetation;
    const expanded = { ...options, quality: "high", radius: 4 };
    finish(
      lod,
      position,
      expanded,
      () => lod.vegetationRejections > 0 && lod._job === null
    );
    assert.equal(lod._vegetation, previous);
    assert.equal(lod._vegetationJob, null);
    assert.equal(previous.layer.group.parent, lod.group);
    assert.equal(lod.ready, true);
    assert.equal(lod.fogDistance, DISTANT_QUALITY.low.horizon);
    const before = reads;
    for (let frame = 0; frame < 10; frame++) lod.update(position, expanded);
    assert.equal(
      reads,
      before,
      "a rejected view is not retried every idle frame"
    );
    assert.equal(lod.vegetationRejections, 1);
    world._epoch = 1;
    lod.update(position, { ...expanded, budgetMs: 0 });
    assert.equal(lod.ready, false);
    assert.equal(lod._vegetationRejected, null);
    assert.equal(lod._treeSamples.size, 0);
    assert.equal(lod._treeSamples.primitiveCount, 0);
  } finally {
    lod.dispose();
  }
});

test("terrain slope and color depth are deterministic and leave native heights untouched", () => {
  const flat = fixture(() => 32);
  const height = (x) => 32 + Math.floor((Math.abs(x) % 48) / 2);
  const slope = fixture(height);
  try {
    finish(flat.lod);
    finish(slope.lod);
    const flatGeometry = surface(flat.lod).geometry;
    const slopeGeometry = surface(slope.lod).geometry;
    const flatNormals = flatGeometry.getAttribute("normal");
    const slopeNormals = slopeGeometry.getAttribute("normal");
    assert.ok([...flatNormals.array].every(Number.isFinite));
    assert.notDeepEqual(flatNormals.array, slopeNormals.array);
    const before = slope.calls.heights;
    const inspected = assertRenderedNativeTerraces(slope.lod, height);
    assert.ok(inspected.renderedRisers > 0);
    slope.lod.update(position, viewOptions(position, { ...settings, budgetMs: 0 }));
    assert.equal(slope.calls.heights, before, "checking/rendering caps never resamples native terrain");
    assert.ok(slope.lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
    const colors = flatGeometry.getAttribute("color").array.slice();
    assert.ok(
      new Set(colors).size > 3,
      "coordinate shading enriches flat distant fields"
    );
    flat.world._epoch = 1;
    finish(flat.lod);
    assert.deepEqual(
      surface(flat.lod).geometry.getAttribute("color").array,
      colors
    );
    assert.equal(flat.world.chunks.size, 0);
    assert.equal(slope.world.chunks.size, 0);
  } finally {
    flat.lod.dispose();
    slope.lod.dispose();
  }
});
