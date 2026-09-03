import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import {
  createDistantVegetationCache,
  createDistantVegetationJob,
  DISTANT_VEGETATION_LIMITS,
  treePrimitives,
} from "../src/distant-vegetation.js";
import { getBiomeTint } from "../src/mesh-palette.js";
import { hash, seedHash } from "../src/noise.js";
import { WATER_LEVEL, WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { TREE_SPECIES } from "../src/terrain-profiles.js";
import { createTreeGenerator, describeTree } from "../src/terrain-trees.js";

const bounds = { minX: -64, maxX: 32, minZ: -64, maxZ: 32 };
function fixture(type = "oak") {
  const calls = [];
  const native = createTreeGenerator({
    salt: seedHash("distant-canopy-test"),
    dimension: "overworld",
    version: 2,
    column: (x, z) => ({
      x,
      z,
      top: 33,
      id: "forest",
      profile: { tree: type, density: 1 },
    }),
    getSpawn: () => {
      throw new Error("v2 tree sampling must not search spawn");
    },
    waterLevel: WATER_LEVEL,
    validXZ: (x, z) =>
      x >= WORLD_MIN && x < WORLD_MAX && z >= WORLD_MIN && z < WORLD_MAX,
  });
  const generator = {
    getTrees(gx, gz) {
      calls.push([gx, gz]);
      return native.getTrees(gx, gz);
    },
    generateChunk() {
      throw new Error("far vegetation cannot generate chunks");
    },
    generateRegion() {
      throw new Error("far vegetation cannot generate regions");
    },
  };
  return { generator, calls };
}

function complete(generator, area = bounds, material, options) {
  const job = createDistantVegetationJob(generator, area, options);
  for (let i = 0; !job.done && i < 1000; i++) job.step({ budgetMs: 4 });
  assert.equal(job.done, true);
  return { job, layer: job.build(material) };
}

function triangles(layer) {
  const geometry = layer.mesh.geometry;
  const position = geometry.getAttribute("position");
  const triangles = [];
  for (let i = 0; i < geometry.drawRange.count; i += 3)
    triangles.push(
      [0, 1, 2].map((offset) => {
        const vertex = geometry.index.getX(i + offset);
        return [
          position.getX(vertex) + layer.group.position.x,
          position.getY(vertex),
          position.getZ(vertex) + layer.group.position.z,
        ];
      })
    );
  return triangles;
}

function assertNoOverlap(layer, holes) {
  for (const triangle of triangles(layer)) {
    const minX = Math.min(...triangle.map((v) => v[0]));
    const maxX = Math.max(...triangle.map((v) => v[0]));
    const minZ = Math.min(...triangle.map((v) => v[2]));
    const maxZ = Math.max(...triangle.map((v) => v[2]));
    for (const hole of holes)
      assert.equal(
        minX < hole.maxX &&
          maxX > hole.minX &&
          minZ < hole.maxZ &&
          maxZ > hole.minZ,
        false
      );
  }
}

test("every native species reduces to a few hulls while retaining real crown offsets and height", () => {
  for (const type of [
    ...Object.keys(TREE_SPECIES),
    "spruce",
    "pine",
    "giant_spruce",
    "acacia",
    "mushroom",
  ]) {
    const tree = describeTree(
      -20,
      -10,
      { top: 30, profile: { tree: type } },
      0.1,
      123,
      WATER_LEVEL
    );
    const primitives = treePrimitives(tree);
    assert.ok(primitives.length >= 2 && primitives.length <= 4, type);
    assert.equal(primitives[0].block, tree.wood);
    assert.ok(
      primitives.slice(1).every((primitive) => primitive.block === tree.leaves)
    );
    const crownTop = Math.max(
      ...tree.parts
        .filter((part) => part.kind === "crown")
        .map((part) => part.y + 2)
    );
    assert.equal(
      Math.max(...primitives.map((primitive) => primitive.maxY)),
      crownTop
    );
    if (type === "cherry" || type === "acacia")
      assert.ok(
        new Set(primitives.slice(1).map((primitive) => primitive.x)).size > 1
      );
    if (type === "spruce" || type === "giant_spruce")
      assert.ok(primitives[1].topRadius < primitives[1].radius);
  }
});

test("asymmetric conifer crowns keep their three-dimensional offsets instead of one root-centered box", () => {
  const native = describeTree(
    -2,
    -2,
    { top: 30, profile: { tree: "spruce" } },
    0.1,
    123,
    WATER_LEVEL
  );
  function shifted(direction) {
    return {
      ...native,
      parts: native.parts.map((part, index) =>
        part.kind === "crown"
          ? {
              ...part,
              x: part.x + ((index % 3) - 1) * direction * 2,
              z: part.z + (index % 2 ? -1 : 1) * direction,
            }
          : { ...part }
      ),
    };
  }
  const left = shifted(-1),
    right = shifted(1);
  const snapshot = structuredClone(left);
  const first = treePrimitives(left),
    second = treePrimitives(right);
  assert.notDeepEqual(
    first,
    second,
    "mirroring actual crown lobes changes the distant silhouette"
  );
  assert.ok(first.length > 2 && first.length <= 7);
  assert.ok(
    new Set(first.slice(1).map((part) => `${part.x},${part.z},${part.minY}`))
      .size > 1
  );
  assert.deepEqual(
    left,
    snapshot,
    "LOD does not mutate immutable native descriptors"
  );
});

test("many varied crown layers have bounded hulls without inflating their X/Z reach", () => {
  const native = describeTree(
    -2,
    -2,
    { top: 30, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  const crowns = Array.from({ length: 20 }, (_, index) => ({
    kind: "crown",
    x: native.x + (index % 5) - 2,
    z: native.z,
    y: 35 + index,
    radius: 1 + (index % 3),
    block: native.leaves,
    flat: index % 2 === 0,
  }));
  const tree = { ...native, parts: [native.parts[0], ...crowns] };
  const primitives = treePrimitives(tree);
  const expected = {
    minX: Math.min(...crowns.map((crown) => crown.x - crown.radius)),
    maxX: Math.max(...crowns.map((crown) => crown.x + crown.radius + 1)),
    minZ: Math.min(...crowns.map((crown) => crown.z - crown.radius)),
    maxZ: Math.max(...crowns.map((crown) => crown.z + crown.radius + 1)),
  };
  assert.ok(primitives.length <= 7);
  assert.ok(primitives.some((part) => part.radiusX !== part.radiusZ));
  assert.equal(Math.max(...primitives.map((part) => part.maxY)), 56);
  for (const part of primitives.slice(1)) {
    assert.ok(part.x - part.radiusX >= expected.minX);
    assert.ok(part.x + part.radiusX <= expected.maxX);
    assert.ok(part.z - part.radiusZ >= expected.minZ);
    assert.ok(part.z + part.radiusZ <= expected.maxZ);
  }
  const { layer } = complete(
    {
      getTrees: (gx, gz) => (gx === -1 && gz === -1 ? [tree] : []),
    },
    { minX: -16, maxX: 16, minZ: -16, maxZ: 16 }
  );
  const hole = { minX: 0, maxX: 16, minZ: 0, maxZ: 16 };
  layer.cutout([hole]);
  assert.ok(layer.mesh.geometry.drawRange.count > 0);
  assertNoOverlap(layer, [hole]);
  for (const triangle of triangles(layer))
    for (const [x, y, z] of triangle) {
      assert.ok(x >= expected.minX && x <= expected.maxX);
      assert.ok(z >= expected.minZ && z <= expected.maxZ);
      assert.ok(y >= 31 && y <= 56);
    }
  layer.dispose();
});

test("real v3 native shape variation survives merged LOD inside each tree's write bounds", () => {
  const native = createTreeGenerator({
    salt: seedHash("native-v3-hulls"),
    dimension: "overworld",
    version: 3,
    column: (x, z) => ({
      x,
      z,
      top: 33,
      temperature: 0.6,
      id: "forest",
      profile: { tree: "giant_spruce", density: 1 },
    }),
    getSpawn: () => ({ x: 10000.5, z: 10000.5 }),
    waterLevel: WATER_LEVEL,
    validXZ: () => true,
  });
  const silhouettes = new Set();
  const { layer } = complete(
    {
      getTrees(gx, gz) {
        const trees = native.getTrees(gx, gz);
        for (const tree of trees) {
          const primitives = treePrimitives(tree);
          assert.ok(primitives.length <= 7);
          silhouettes.add(
            JSON.stringify(
              primitives.map((part) => [
                part.x - tree.x,
                part.z - tree.z,
                part.minY - tree.ground,
                part.maxY - tree.ground,
                part.radiusX ?? part.radius,
                part.radiusZ ?? part.radius,
                (part.topX ?? part.x) - tree.x,
                (part.topZ ?? part.z) - tree.z,
              ])
            )
          );
          for (const part of primitives) {
            for (const [x, z, rx, rz] of [
              [
                part.x,
                part.z,
                part.radiusX ?? part.radius,
                part.radiusZ ?? part.radius,
              ],
              [
                part.topX ?? part.x,
                part.topZ ?? part.z,
                part.topRadiusX ?? part.topRadius,
                part.topRadiusZ ?? part.topRadius,
              ],
            ]) {
              assert.ok(
                x - rx >= tree.bounds.minX && x + rx <= tree.bounds.maxX
              );
              assert.ok(
                z - rz >= tree.bounds.minZ && z + rz <= tree.bounds.maxZ
              );
            }
            assert.ok(
              part.minY >= tree.bounds.minY && part.maxY <= tree.bounds.maxY
            );
          }
        }
        return trees;
      },
    },
    { minX: -96, maxX: 96, minZ: -96, maxZ: 96 }
  );
  assert.ok(layer.treeCount > 20);
  assert.ok(
    silhouettes.size > 10,
    "normalized proxies reflect individual tree shapes, not only different positions"
  );
  const hole = { minX: -32, maxX: 32, minZ: -32, maxZ: 32 };
  layer.cutout([hole]);
  assertNoOverlap(layer, [hole]);
  layer.dispose();
});

test("a forest produces one merged mesh, bounded local vertices and no full-detail work", () => {
  const { generator, calls } = fixture("cherry");
  const { job, layer } = complete(generator);
  assert.equal(layer.group.children.length, 1);
  assert.equal(layer.mesh.castShadow, false);
  assert.equal(layer.mesh.receiveShadow, false);
  assert.equal(calls.length, job.totalSamples);
  assert.ok(layer.treeCount > 50);
  const geometry = layer.mesh.geometry;
  assert.ok(geometry.getAttribute("position").count < layer.treeCount * 300);
  assert.ok(geometry.drawRange.count > 0);
  assert.ok(geometry.getAttribute("position").count < geometry.index.count);
  assert.ok(
    layer.resourceBytes <=
      DISTANT_VEGETATION_LIMITS.vertices * 36 +
        DISTANT_VEGETATION_LIMITS.indices * 4
  );
  assert.ok(
    layer._buckets.every(
      (bucket) =>
        bucket.count > 0 &&
        bucket.count % 3 === 0 &&
        bucket.start + bucket.count <= layer._sourceIndices.length
    ),
    "each owning chunk has one compact index span"
  );
  const point = new THREE.Vector3();
  for (const attribute of Object.values(geometry.attributes))
    assert.ok([...attribute.array].every(Number.isFinite));
  for (let i = 0; i < geometry.getAttribute("position").count; i++) {
    point.fromBufferAttribute(geometry.getAttribute("position"), i);
    assert.ok(geometry.boundingBox.containsPoint(point));
    assert.ok(
      point.distanceTo(geometry.boundingSphere.center) <=
        geometry.boundingSphere.radius + 0.00001
    );
  }
  layer.dispose();
});

test("cutouts follow actual covered chunks, retain partial canopies, and restore without resampling", () => {
  const tree = describeTree(
    -2,
    -2,
    { top: 30, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  let samples = 0;
  const { layer } = complete(
    {
      getTrees(gx, gz) {
        samples++;
        return gx === -1 && gz === -1 ? [tree] : [];
      },
    },
    { minX: -16, maxX: 16, minZ: -16, maxZ: 16 }
  );
  const before = triangles(layer);
  const sampleCount = samples;
  layer.cutout((cx, cz) => cx === -1 && cz === -1);
  assertNoOverlap(layer, [{ minX: -16, maxX: 0, minZ: -16, maxZ: 0 }]);
  assert.ok(
    triangles(layer).length > 0,
    "the rest of a border-spanning canopy survives"
  );
  assert.ok(triangles(layer).length < before.length);
  layer.cutout({ minX: 0, maxX: 16, minZ: 0, maxZ: 16 });
  assertNoOverlap(layer, [{ minX: 0, maxX: 16, minZ: 0, maxZ: 16 }]);
  layer.cutout();
  assert.deepEqual(triangles(layer), before);
  assert.equal(samples, sampleCount, "moving coverage only changes indices");
  layer.cutout(() => true);
  assert.equal(layer.mesh.visible, false);
  assert.equal(layer.mesh.geometry.drawRange.count, 0);
  layer.dispose();
});

test("negative and disconnected full-detail holes exclude every crossing triangle", () => {
  const { generator } = fixture("giant_spruce");
  const { layer } = complete(generator);
  const holes = [
    { minX: -32, maxX: 0, minZ: -16, maxZ: 16 },
    { minX: 16, maxX: 32, minZ: -48, maxZ: -32 },
  ];
  layer.cutout(holes);
  assert.ok(layer.mesh.geometry.drawRange.count > 0);
  assertNoOverlap(layer, holes);
  layer.dispose();
});

test("adjacent jobs share true root sampling and join without duplicate or missing canopy faces", () => {
  const { generator } = fixture();
  const area = { minX: -32, maxX: 32, minZ: -32, maxZ: 32 };
  const whole = complete(generator, area).layer;
  const left = complete(generator, { ...area, maxX: 0 }).layer;
  const right = complete(generator, { ...area, minX: 0 }).layer;
  const signature = (entries) =>
    entries
      .map((triangle) =>
        triangle
          .map((point) =>
            point
              .map((coordinate) => Math.round(coordinate * 10000) / 10000)
              .join(",")
          )
          .join(";")
      )
      .sort();
  assert.deepEqual(
    signature([...triangles(left), ...triangles(right)]),
    signature(triangles(whole))
  );
  for (const layer of [whole, left, right]) layer.dispose();
});

test("far-world vertices retain one-block crown shape and stay inside world bounds", () => {
  const { generator, calls } = fixture("acacia");
  const area = {
    minX: WORLD_MAX - 64,
    maxX: WORLD_MAX + 32,
    minZ: WORLD_MIN - 32,
    maxZ: WORLD_MIN + 64,
  };
  const { layer } = complete(generator, area);
  const points = layer.mesh.geometry.getAttribute("position");
  let oddCoordinates = 0;
  for (let i = 0; i < points.count; i++) {
    assert.ok(Math.abs(points.getX(i)) <= 64);
    assert.ok(Math.abs(points.getZ(i)) <= 64);
    const x = points.getX(i) + layer.group.position.x;
    const z = points.getZ(i) + layer.group.position.z;
    if (Math.abs(x % 2) === 1 || Math.abs(z % 2) === 1) oddCoordinates++;
    assert.ok(x >= WORLD_MIN && x <= WORLD_MAX);
    assert.ok(z >= WORLD_MIN && z <= WORLD_MAX);
  }
  assert.ok(
    oddCoordinates > 0,
    "world-space Float32 would round these odd block edges to even coordinates"
  );
  assert.ok(
    calls.every(
      ([gx, gz]) =>
        gx * 8 >= WORLD_MIN &&
        gx * 8 < WORLD_MAX &&
        gz * 8 >= WORLD_MIN &&
        gz * 8 < WORLD_MAX
    )
  );
  layer.dispose();
});

test("zero budgets do no work, a stalled clock is capped, and real elapsed time stops sampling", (t) => {
  const { generator, calls } = fixture();
  const job = createDistantVegetationJob(generator, bounds);
  assert.equal(job.step({ budgetMs: 0 }), false);
  assert.equal(calls.length, 0);
  t.mock.method(performance, "now", () => 0);
  job.step({ budgetMs: 10000, maxSamples: 10000 });
  assert.ok(calls.length > 0 && calls.length <= 64);
  assert.equal(job.done, false);
  let clock = 0;
  t.mock.method(performance, "now", () => (clock += 0.5));
  const before = calls.length;
  const beforePrimitives = job.primitiveCount;
  job.step({ budgetMs: 2 });
  assert.ok(calls.length <= before + 3);
  assert.ok(job.primitiveCount <= beforePrimitives + 3);
  assert.ok(calls.length > before || job.primitiveCount > beforePrimitives);
  job.dispose();
});

test("cancelling incomplete jobs prevents later samples and publishes no stale geometry", () => {
  const { generator, calls } = fixture();
  const job = createDistantVegetationJob(generator, bounds);
  job.step({ budgetMs: 4, maxSamples: 2 });
  assert.throws(() => job.build());
  const before = calls.length;
  job.dispose();
  job.dispose();
  job.step({ budgetMs: 4 });
  assert.equal(calls.length, before);
  assert.throws(() => job.build());
  assert.equal(job._positions.length, 0);
  assert.equal(job._buckets.size, 0);
});

test("v1 overwritten native trees are clipped out of the frozen legacy columns", () => {
  const tree = describeTree(
    -80,
    -80,
    { top: 30, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  tree.exclude = { minX: -80, maxX: 80, minZ: -80, maxZ: 80 };
  const { layer } = complete(
    {
      getTrees: (gx, gz) => (gx === -10 && gz === -10 ? [tree] : []),
    },
    { minX: -96, maxX: -64, minZ: -96, maxZ: -64 }
  );
  assert.ok(layer.mesh.geometry.drawRange.count > 0);
  assertNoOverlap(layer, [tree.exclude]);
  layer.dispose();
});

test("disposal releases geometry and owned materials once, but not caller-owned materials", () => {
  const { generator } = fixture();
  for (const external of [false, true]) {
    const shared = external ? new THREE.MeshLambertMaterial() : undefined;
    const { job, layer } = complete(
      generator,
      { minX: -32, maxX: -16, minZ: -32, maxZ: -16 },
      shared
    );
    const scene = new THREE.Scene();
    scene.add(layer.group);
    let geometries = 0,
      materials = 0;
    layer.mesh.geometry.addEventListener("dispose", () => geometries++);
    layer.mesh.material.addEventListener("dispose", () => materials++);
    layer.dispose();
    layer.dispose();
    assert.equal(layer.cutout(), false);
    assert.equal(scene.children.length, 0);
    assert.equal(geometries, 1);
    assert.equal(materials, external ? 0 : 1);
    assert.throws(() => job.build());
    if (shared) shared.dispose();
  }
});

test("empty canopies stay invisible and oversized or invalid requests fail before sampling", () => {
  const generator = { getTrees: () => [] };
  const { layer } = complete(generator);
  assert.equal(layer.mesh.geometry.drawRange.count, 0);
  assert.equal(layer.mesh.visible, false);
  layer.dispose();
  assert.throws(() => createDistantVegetationJob({}, bounds), TypeError);
  assert.throws(
    () => createDistantVegetationJob(generator, { ...bounds, minX: NaN }),
    RangeError
  );
  assert.throws(
    () =>
      createDistantVegetationJob(generator, {
        minX: WORLD_MAX + 1,
        maxX: WORLD_MAX + 32,
        minZ: 0,
        maxZ: 32,
      }),
    RangeError
  );
  assert.throws(
    () =>
      createDistantVegetationJob(generator, {
        minX: -WORLD_MAX,
        maxX: WORLD_MAX,
        minZ: -WORLD_MAX,
        maxZ: WORLD_MAX,
      }),
    RangeError
  );
});

test("distant foliage matches native biome tint and has crown depth without changing descriptors", () => {
  const tree = describeTree(
    8,
    8,
    { top: 30, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  const original = structuredClone(tree);
  const area = { minX: 0, maxX: 32, minZ: 0, maxZ: 32 };
  const biomes = [{ foliageColor: "#388538" }, { foliageColor: "#989540" }];
  let biomeReads = 0;
  const layers = biomes.map(
    (biome) =>
      complete(
        {
          getTrees: (gx, gz) => (gx === 1 && gz === 1 ? [tree] : []),
          getBiome() {
            biomeReads++;
            return biome;
          },
        },
        area
      ).layer
  );
  try {
    assert.equal(biomeReads, layers.length, "one biome read per native tree");
    assert.deepEqual(tree, original);
    const [first, second] = layers.map((layer) => layer.mesh.geometry);
    for (const name of ["position", "normal"])
      assert.deepEqual(
        first.getAttribute(name).array,
        second.getAttribute(name).array
      );
    assert.deepEqual(first.index.array, second.index.array);
    assert.notDeepEqual(
      first.getAttribute("color").array,
      second.getAttribute("color").array
    );
    const crown = treePrimitives(tree).at(-1);
    const positions = first.getAttribute("position");
    const normals = first.getAttribute("normal");
    const colors = first.getAttribute("color");
    let top = -1,
      bottom = -1;
    for (let i = 0; i < positions.count; i++) {
      if (positions.getY(i) === crown.maxY && normals.getY(i) > 0.5) top = i;
      if (positions.getY(i) === crown.minY && normals.getY(i) < -0.5) bottom = i;
      if (positions.getY(i) < crown.minY)
        for (const channel of ["getX", "getY", "getZ"])
          assert.equal(
            colors[channel](i),
            second.getAttribute("color")[channel](i)
          );
    }
    assert.ok(top >= 0 && bottom >= 0);
    const tint = getBiomeTint(BLOCK.LEAVES, "side", biomes[0]);
    const expected = new THREE.Color(BLOCKS[BLOCK.LEAVES].color).toArray();
    const variation = 0.94 + hash(tree.x, tree.z, 0x5729) * 0.12;
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(
        Math.abs(
          colors.array[top * 3 + channel] -
            expected[channel] * tint[channel] * variation
        ) < 1e-6
      );
      assert.ok(
        colors.array[bottom * 3 + channel] < colors.array[top * 3 + channel]
      );
    }
    assert.equal(layers[0].mesh.castShadow, false);
  } finally {
    for (const layer of layers) layer.dispose();
  }
});

test("cherry crowns stay pink and near/far canopy bands retain block-sharp faces", () => {
  const tree = describeTree(
    8,
    8,
    { top: 30, profile: { tree: "cherry" } },
    0.1,
    123,
    WATER_LEVEL
  );
  const area = { minX: 0, maxX: 32, minZ: 0, maxZ: 32 };
  const layers = ["#388538", "#989540"].map(
    (foliageColor) =>
      complete(
        {
          getTrees: (gx, gz) => (gx === 1 && gz === 1 ? [tree] : []),
          getBiome: () => ({ foliageColor }),
        },
        area
      ).layer
  );
  const coarse = complete(
    { getTrees: (gx, gz) => (gx === 1 && gz === 1 ? [tree] : []) },
    area,
    undefined,
    { center: { x: 1000, z: 1000 } }
  ).layer;
  try {
    assert.deepEqual(
      layers[0].mesh.geometry.getAttribute("color").array,
      layers[1].mesh.geometry.getAttribute("color").array
    );
    assert.ok(coarse.primitiveCount <= coarse.treeCount * 3);
    assert.ok(
      coarse.mesh.geometry.getAttribute("position").count <
        layers[0].mesh.geometry.getAttribute("position").count
    );
    for (const layer of [...layers, coarse]) {
      assert.equal(layer.group.children.length, 1);
      const normals = layer.mesh.geometry.getAttribute("normal");
      for (let i = 0; i < normals.count; i++)
        assert.equal(
          Math.abs(normals.getX(i)) +
            Math.abs(normals.getY(i)) +
            Math.abs(normals.getZ(i)),
          1,
          "canopy tiers are voxel boxes, not smooth pyramids"
        );
    }
  } finally {
    for (const layer of [...layers, coarse]) layer.dispose();
  }
});

test("shared hull caches replay identical geometry with no native reads and reset for a new generator", () => {
  const { generator, calls } = fixture("cherry");
  const cache = createDistantVegetationCache();
  const first = complete(generator, bounds, undefined, { cache }).layer;
  const before = calls.length;
  const second = complete(generator, bounds, undefined, { cache }).layer;
  try {
    assert.equal(calls.length, before);
    assert.equal(second.nativeSamples, 0);
    for (const name of ["position", "normal", "color"])
      assert.deepEqual(
        first.mesh.geometry.getAttribute(name).array,
        second.mesh.geometry.getAttribute(name).array
      );
    assert.deepEqual(
      first.mesh.geometry.index.array,
      second.mesh.geometry.index.array
    );
    assert.ok(cache.size <= DISTANT_VEGETATION_LIMITS.cachedSamples);
    assert.ok(cache.primitiveCount <= DISTANT_VEGETATION_LIMITS.cachedPrimitives);
    const empty = { getTrees: () => [] };
    assert.equal(cache.read(empty, 0, 0).fresh, true);
    assert.equal(cache.size, 1);
    assert.equal(cache.primitiveCount, 0);
    cache.clear();
    assert.equal(cache.size, 0);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("cache capacity bounds both empty samples and dense native hulls", () => {
  const tree = describeTree(
    8,
    8,
    { top: 30, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  const count =
    treePrimitives(tree).length +
    treePrimitives(tree, { maxCrowns: 2 }).length;
  const generator = { getTrees: (gx) => (gx % 3 === 0 ? [tree] : []) };
  const cache = createDistantVegetationCache({
    maxSamples: 4,
    maxPrimitives: count,
  });
  for (let gx = 0; gx <= 3; gx++) cache.read(generator, gx, 0);
  assert.equal(cache.primitiveCount, count);
  assert.equal(cache.read(generator, 1, 0).fresh, false);
  assert.equal(
    cache.read(generator, 0, 0).fresh,
    true,
    "old populated entry was evicted"
  );
  for (let gx = 4; gx < 100; gx++) {
    cache.read(generator, gx, 0);
    assert.ok(cache.size <= 4);
    assert.ok(cache.primitiveCount <= count);
  }
  cache.clear();
  assert.equal(cache.primitiveCount, 0);
});

test("cached empty cells and populated primitives obey separate stalled-clock limits", (t) => {
  t.mock.method(performance, "now", () => 0);
  const cache = createDistantVegetationCache();
  const generator = { getTrees: () => [] };
  const area = { minX: -128, maxX: 128, minZ: -128, maxZ: 128 };
  complete(generator, area, undefined, { cache }).layer.dispose();
  const cached = createDistantVegetationJob(generator, area, { cache });
  const populated = createDistantVegetationJob(
    fixture("cherry").generator,
    bounds
  );
  try {
    cached.step({ budgetMs: 10000, maxSamples: 1 });
    assert.equal(cached.lastStep.samples, 0);
    assert.equal(cached.lastStep.cells, DISTANT_VEGETATION_LIMITS.cellsPerStep);
    assert.equal(cached.done, false);
    populated.step({ budgetMs: 10000, maxSamples: 10000 });
    assert.equal(
      populated.lastStep.primitives,
      DISTANT_VEGETATION_LIMITS.primitivesPerStep
    );
    assert.ok(
      populated.lastStep.samples <= DISTANT_VEGETATION_LIMITS.samplesPerStep
    );
    assert.ok(
      populated.lastStep.cells <= DISTANT_VEGETATION_LIMITS.cellsPerStep
    );
  } finally {
    cached.dispose();
    populated.dispose();
  }
});

test("vertex and index admission limits reject a job without publishing partial canopies", () => {
  for (const limits of [
    { vertices: 16, indices: 10000 },
    { vertices: 10000, indices: 12 },
  ]) {
    const job = createDistantVegetationJob(fixture().generator, bounds, {
      limits,
    });
    for (let i = 0; !job.done && i < 1000; i++) job.step({ budgetMs: 4 });
    assert.equal(job.status, "budget");
    assert.ok(job._positions.length / 3 <= limits.vertices);
    assert.ok(job._indices.length <= limits.indices);
    assert.ok(job._indices.every((index) => index < job._positions.length / 3));
    assert.throws(() => job.build(), /admitted/);
    job.dispose();
    assert.equal(job._positions.length, 0);
  }
});

test("oversized native descriptors are rejected before unbounded primitive or clipping work", () => {
  const tree = describeTree(
    8,
    8,
    { top: 30, profile: { tree: "oak" } },
    0.1,
    123,
    WATER_LEVEL
  );
  const nativeCases = [
    Array.from({ length: DISTANT_VEGETATION_LIMITS.treesPerCell + 1 }, () => tree),
    [
      {
        ...tree,
        parts: Array.from(
          { length: DISTANT_VEGETATION_LIMITS.partsPerTree + 1 },
          () => tree.parts[0]
        ),
      },
    ],
    [
      {
        ...tree,
        parts: [{ ...tree.parts[0], x: -1024, z: -1024, width: 2048 }],
      },
    ],
  ];
  for (const trees of nativeCases) {
    const job = createDistantVegetationJob({ getTrees: () => trees }, bounds);
    for (let i = 0; !job.done && i < 100; i++) job.step({ budgetMs: 4 });
    assert.equal(job.status, "budget");
    assert.equal(job._positions.length, 0);
    assert.throws(() => job.build(), /admitted/);
    job.dispose();
  }
});
