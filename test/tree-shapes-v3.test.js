import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK as B, BLOCKS } from "../src/blocks.js";
import { hash, seedHash } from "../src/noise.js";
import { TREE_SPECIES } from "../src/terrain-profiles.js";
import {
  createTreeGenerator,
  describeTree,
  TREE_REACH,
  writeTree,
} from "../src/terrain-trees.js";
import { varyTreeShape } from "../src/tree-shapes-v3.js";

const salt = seedHash("individual-tree-silhouettes");
const species = [
  ...Object.keys(TREE_SPECIES).filter(
    (type) => !["crimson", "warped"].includes(type)
  ),
  "spruce",
  "pine",
  "giant_spruce",
  "acacia",
  "mushroom",
];
const neighbors = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const key = (x, y, z) => `${x},${y},${z}`;

function original(type, index = 0, options = {}) {
  return describeTree(
    options.x ?? -513 + index * 13,
    options.z ?? 29 + (index % 11) * 17,
    { top: options.ground ?? 32, profile: { tree: type } },
    options.chance ?? 0.18,
    salt,
    0
  );
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function raster(tree, initial = new Map()) {
  const cells = new Map(initial);
  writeTree(tree, (x, y, z, block, replaceWater = false) => {
    const id = key(x, y, z),
      previous = cells.get(id)?.block;
    // The authoritative terrain put() rule, including wood preservation.
    if (
      previous === undefined ||
      BLOCKS[previous].texture === "leaves" ||
      BLOCKS[previous].shape === "cross" ||
      (replaceWater && (previous === B.WATER || previous === B.ICE))
    )
      cells.set(id, { x, y, z, block });
  });
  return cells;
}

function connected(cells, root) {
  assert.ok(cells.has(root), "the root voxel exists");
  const seen = new Set([root]),
    queue = [cells.get(root)];
  for (let at = 0; at < queue.length; at++) {
    const { x, y, z } = queue[at];
    for (const [dx, dy, dz] of neighbors) {
      const id = key(x + dx, y + dy, z + dz);
      if (!seen.has(id) && cells.has(id)) {
        seen.add(id);
        queue.push(cells.get(id));
      }
    }
  }
  return seen.size;
}

function signature(tree) {
  // Deliberately omit material/color: variation must change actual geometry.
  return tree.parts.map((part) => [
    part.kind,
    part.x - tree.x,
    part.y - tree.ground - tree.height,
    part.z - tree.z,
    part.height,
    part.width,
    part.radius,
    part.flat,
  ]);
}

test("individual shapes are seed-stable, order-independent and do not mutate inputs", () => {
  const profilesBefore = structuredClone(TREE_SPECIES);
  const sources = species.flatMap((type) =>
    Array.from({ length: 8 }, (_, index) => freeze(original(type, index)))
  );
  const before = sources.map((tree) => JSON.stringify(tree));
  const expected = sources.map((tree) => varyTreeShape(tree, salt));
  for (let i = sources.length - 1; i >= 0; i--) {
    varyTreeShape(original("jungle", i), salt ^ 3917);
    assert.deepEqual(varyTreeShape(sources[i], salt), expected[i]);
    assert.equal(JSON.stringify(sources[i]), before[i]);
    assert.notEqual(expected[i], sources[i]);
    assert.notEqual(expected[i].parts, sources[i].parts);
    assert.notEqual(expected[i].bounds, sources[i].bounds);
    assert.equal(expected[i].wood, sources[i].wood);
    assert.equal(expected[i].leaves, sources[i].leaves);
    assert.equal(expected[i].type, sources[i].type);
  }
  expected[0].parts[0].x++;
  expected[0].bounds.minX--;
  assert.equal(JSON.stringify(sources[0]), before[0]);
  assert.deepEqual(TREE_SPECIES, profilesBefore);
  let changed = 0;
  for (const source of sources)
    if (
      JSON.stringify(signature(varyTreeShape(source, salt))) !==
      JSON.stringify(signature(varyTreeShape(source, salt ^ 3917)))
    )
      changed++;
  assert.ok(
    changed > sources.length * 0.9,
    "world seed changes morphology, not just color"
  );
});

test("signed seeds and far-world roots replay without coordinate or cache aliases", () => {
  const sources = [
    original("oak", 0, { x: -29999991, z: 29999991 }),
    original("jungle", 0, { x: 29999991, z: -29999991 }),
    original("acacia", 0, { x: -17, z: -1 }),
  ];
  const seeds = [0, salt, 0xffffffff];
  const expected = seeds.flatMap((seed) =>
    sources.map((source) => varyTreeShape(source, seed))
  );
  for (let s = seeds.length - 1; s >= 0; s--)
    for (let i = sources.length - 1; i >= 0; i--)
      assert.deepEqual(
        varyTreeShape(sources[i], seeds[s]),
        expected[s * sources.length + i]
      );
});

for (const type of species) {
  test(`${type} has many silhouettes, including different shapes at the same height`, () => {
    const shapes = new Set(),
      heights = new Map();
    for (let i = 0; i < 96; i++) {
      const tree = varyTreeShape(original(type, i), salt);
      const shape = JSON.stringify(signature(tree));
      shapes.add(shape);
      if (!heights.has(tree.height)) heights.set(tree.height, new Set());
      heights.get(tree.height).add(shape);
    }
    assert.ok(heights.size > 4, `${type}: replace the old four height buckets`);
    assert.ok(
      shapes.size >= (type === "mushroom" ? 12 : 24),
      `${type}: distinct crowns/limbs`
    );
    assert.ok(
      Math.max(...[...heights.values()].map((values) => values.size)) >=
        (type === "mushroom" ? 3 : 5),
      `${type}: geometry still varies after holding trunk height constant`
    );
  });
}

test("broadleaf variation survives native voxelization, not just descriptor ordering", () => {
  const silhouettes = new Set();
  for (let i = 0; i < 32; i++) {
    const tree = varyTreeShape(original("oak", i), salt);
    const geometry = [...raster(tree).values()]
      .map(({ x, y, z }) => key(x - tree.x, y - tree.ground, z - tree.z))
      .sort();
    silhouettes.add(JSON.stringify(geometry));
  }
  assert.ok(silhouettes.size >= 24);
});

test("branches and every canopy remain face-connected to living structural wood", () => {
  for (const type of species) {
    for (let i = 0; i < 6; i++) {
      const tree = varyTreeShape(original(type, i), salt);
      const cells = raster(tree);
      const wood = new Map(
        [...cells].filter(([, cell]) => cell.block === tree.wood)
      );
      const root = key(tree.x, tree.ground + 1, tree.z);
      const label = `${type} at ${tree.x},${tree.z}`;
      assert.equal(
        connected(wood, root),
        wood.size,
        `${label}: no diagonal-only or floating logs`
      );
      assert.equal(
        connected(cells, root),
        cells.size,
        `${label}: no unsupported leaves or moss`
      );

      let foliageStarted = false;
      for (const part of tree.parts) {
        if (part.kind === "crown") {
          foliageStarted = true;
          let supported = false;
          writeTree({ parts: [part] }, (x, y, z) => {
            if (wood.has(key(x, y, z))) supported = true;
          });
          assert.ok(
            supported,
            `${label}: each lobe contains actual connected wood`
          );
        } else if (part.block === tree.wood) {
          assert.equal(
            foliageStarted,
            false,
            "all structural wood precedes foliage"
          );
          writeTree({ parts: [part] }, (x, y, z) =>
            assert.equal(
              cells.get(key(x, y, z))?.block,
              tree.wood,
              "crowns cannot erase wood"
            )
          );
        }
      }
      assert.ok([...cells.values()].some((cell) => cell.block === tree.leaves));
      assert.ok(
        [...cells.values()].every(
          ({ block }) =>
            block === tree.wood ||
            block === tree.leaves ||
            (type === "pale" && block === B.MOSS)
        ),
        "no palette substitutions"
      );
    }
  }
});

test("connected mangrove stilt roots still replace water and ice", () => {
  for (const liquid of [B.WATER, B.ICE]) {
    const tree = varyTreeShape(original("mangrove"), salt);
    const roots = tree.parts.filter(
      (part) => part.kind === "block" && part.replaceWater
    );
    assert.ok(
      roots.length >= 4,
      "multiple stilt roots survive the new morphology"
    );
    const initial = new Map(
      roots.map(({ x, y, z }) => [key(x, y, z), { x, y, z, block: liquid }])
    );
    const cells = raster(tree, initial);
    for (const { x, y, z } of roots)
      assert.equal(cells.get(key(x, y, z)).block, tree.wood);
  }
});

test("integer parts and exact bounds respect headroom and reach at negative and far roots", () => {
  const roots = [
    [-1, -1],
    [-17, -32],
    [29999991, -29999991],
    [-29999991, 29999991],
  ];
  for (const type of species) {
    for (const [x, z] of roots) {
      for (const ground of [0, 1, 32, 86, 92, 93]) {
        const tree = varyTreeShape(original(type, 0, { x, z, ground }), salt);
        assert.ok(tree);
        assert.ok(
          tree.parts.length <= 30,
          `${type}: bounded descriptor work per tree`
        );
        assert.ok(tree.bounds.minX >= x - TREE_REACH);
        assert.ok(tree.bounds.maxX <= x + TREE_REACH);
        assert.ok(tree.bounds.minZ >= z - TREE_REACH);
        assert.ok(tree.bounds.maxZ <= z + TREE_REACH);
        assert.ok(tree.bounds.minY >= 1 && tree.bounds.maxY <= 96);
        for (const part of tree.parts) {
          assert.ok(["trunk", "crown", "block"].includes(part.kind));
          assert.ok(
            [part.x, part.y, part.z, part.block].every(Number.isSafeInteger)
          );
          if (part.kind === "trunk") {
            assert.ok(Number.isInteger(part.height) && part.height > 0);
            assert.ok(part.width === 1 || part.width === 2);
          } else if (part.kind === "crown") {
            assert.ok(Number.isInteger(part.radius) && part.radius >= 1);
            assert.equal(typeof part.flat, "boolean");
          } else assert.equal(typeof part.replaceWater, "boolean");
        }
        const bounds = {
          minX: Infinity,
          minY: Infinity,
          minZ: Infinity,
          maxX: -Infinity,
          maxY: -Infinity,
          maxZ: -Infinity,
        };
        writeTree(tree, (px, py, pz) => {
          assert.ok([px, py, pz].every(Number.isSafeInteger));
          for (const [axis, value] of [
            ["X", px],
            ["Y", py],
            ["Z", pz],
          ]) {
            bounds[`min${axis}`] = Math.min(bounds[`min${axis}`], value);
            bounds[`max${axis}`] = Math.max(bounds[`max${axis}`], value + 1);
          }
        });
        assert.deepEqual(
          tree.bounds,
          bounds,
          `${type}: half-open bounds match native voxels exactly`
        );
      }
    }
  }
});

test("headroom compression stays connected and never wraps below the root", () => {
  for (const type of species) {
    for (const maxHeight of [8, 16, 32, 96, 120]) {
      const ceiling = Math.min(96, maxHeight),
        ground = ceiling - 5;
      const tree = varyTreeShape(
        original(type, 0, { ground }),
        salt,
        maxHeight
      );
      const cells = raster(tree);
      assert.ok(tree.bounds.maxY <= ceiling);
      assert.ok(tree.bounds.minY > ground);
      assert.equal(
        connected(cells, key(tree.x, ground + 1, tree.z)),
        cells.size
      );
    }
    assert.equal(varyTreeShape(original(type, 0, { ground: 94 }), salt), null);
  }
  assert.equal(varyTreeShape(null, salt), null);
  for (const maxHeight of [NaN, Infinity, 2, 95.5])
    assert.equal(varyTreeShape(original("oak"), salt, maxHeight), null);
  assert.equal(varyTreeShape({ ...original("oak"), ground: -1 }, salt), null);
});

test("species keep slender leaders, tiered conifers, old-growth stature and varied acacia forks", () => {
  const directions = new Set();
  let youngOak = false,
    matureOak = false,
    tallJungle = false,
    wideSpruce = false;
  for (let i = 0; i < 64; i++) {
    const oak = varyTreeShape(original("oak", i), salt);
    youngOak ||= oak.height <= 5;
    matureOak ||=
      oak.height >= 10 &&
      oak.parts.filter((part) => part.kind === "crown").length >= 3;
    const jungle = varyTreeShape(original("jungle", i), salt);
    tallJungle ||= jungle.height >= 23 && jungle.parts[0].width === 2;
    const giant = varyTreeShape(original("giant_spruce", i), salt);
    wideSpruce ||= giant.height >= 23 && giant.parts[0].width === 2;
    for (const type of ["birch", "tall_birch"]) {
      const birch = varyTreeShape(original(type, i), salt);
      assert.equal(birch.parts[0].width, 1);
      assert.ok(
        birch.parts
          .filter((part) => part.kind === "crown")
          .every((part) => part.radius <= 4)
      );
    }
    for (const type of ["spruce", "pine", "giant_spruce"]) {
      const tree = varyTreeShape(original(type, i), salt);
      const tiers = tree.parts.filter((part) => part.kind === "crown");
      assert.ok(tiers.length >= 2);
      assert.ok(tiers.every((part) => part.flat));
      assert.equal(tiers.at(-1).radius, 1);
      assert.equal(tiers.at(-1).y, tree.ground + tree.height);
      for (let t = 1; t < tiers.length; t++)
        assert.ok(tiers[t].radius <= tiers[t - 1].radius);
    }
    const acacia = varyTreeShape(original("acacia", i), salt);
    const crowns = acacia.parts.filter((part) => part.kind === "crown");
    assert.ok(crowns.length >= 2 && crowns.every((part) => part.flat));
    for (const part of crowns)
      directions.add(
        `${Math.sign(part.x - acacia.x)},${Math.sign(part.z - acacia.z)}`
      );
  }
  assert.ok(youngOak && matureOak && tallJungle && wideSpruce);
  assert.equal(directions.size, 8, "acacia forks are not fixed to east/west");
  const brown = varyTreeShape(original("mushroom", 1, { chance: 0.8 }), salt);
  assert.ok(
    brown.parts
      .filter((part) => part.kind === "crown")
      .every((part) => part.flat)
  );
});

test("legacy and Nether descriptors are fresh copies with byte-identical shape data", () => {
  const legacy = {
    ...original("oak"),
    legacy: true,
    exclude: { minX: -80, minZ: -80, maxX: 80, maxZ: 80 },
  };
  for (const source of [
    legacy,
    original("crimson"),
    original("warped"),
    {
      ...original("oak"),
      type: "future_species",
    },
  ]) {
    freeze(source);
    const result = varyTreeShape(source, salt);
    assert.equal(JSON.stringify(result), JSON.stringify(source));
    assert.notEqual(result, source);
    assert.notEqual(result.parts, source.parts);
    assert.notEqual(result.parts[0], source.parts[0]);
    assert.notEqual(result.bounds, source.bounds);
    if (source.exclude) assert.notEqual(result.exclude, source.exclude);
  }
});

function sampler(version, dimension, type) {
  const col = {
    top: 32,
    temperature: 0.6,
    id: "dark_forest",
    profile: { tree: type, density: 1 },
  };
  return {
    col,
    generator: createTreeGenerator({
      salt,
      version,
      dimension,
      column: () => col,
      waterLevel: 24,
      getSpawn: () => ({ x: 10000, z: 10000 }),
      validXZ: () => true,
    }),
  };
}

test("integration leaves v1/v2 and non-Overworld primary trees unchanged", () => {
  for (const [version, dimension, type] of [
    [1, "overworld", "oak"],
    [2, "overworld", "cherry"],
    [1, "nether", "crimson"],
    [2, "nether", "warped"],
    [3, "nether", "crimson"],
    [3, "nether", "warped"],
    [3, "end", "oak"],
  ]) {
    const { col, generator } = sampler(version, dimension, type);
    const expected = describeTree(-413, -287, col, 0.12, salt, 24);
    assert.equal(
      JSON.stringify(generator.primary(-413, -287, col, 0.12)),
      JSON.stringify(expected)
    );
    const mushroom = describeTree(
      -413,
      -287,
      { ...col, profile: { tree: "mushroom" } },
      0.475,
      salt,
      24
    );
    assert.deepEqual(generator.mushroom(-413, -287, col, 0.95), mushroom);
  }
});

test("integration sculpts both v3 Overworld primary trees and secondary mushrooms", () => {
  const { col, generator } = sampler(3, "overworld", "oak");
  let primary = 0,
    mushrooms = 0;
  for (let i = 0; i < 96; i++) {
    const x = -2048 + i * 37,
      z = -1536 + (i % 11) * 79;
    const shapeChance = hash(x, z, salt ^ 4421);
    const tree = generator.primary(x, z, col, 0.001);
    if (tree) {
      assert.deepEqual(
        tree,
        varyTreeShape(describeTree(x, z, col, shapeChance, salt, 24), salt)
      );
      primary++;
    }
    const mushroom = generator.mushroom(x, z, col, 0.9001);
    if (mushroom) {
      const source = describeTree(
        x,
        z,
        { ...col, profile: { tree: "mushroom" } },
        shapeChance,
        salt,
        24
      );
      assert.deepEqual(mushroom, varyTreeShape(source, salt));
      mushrooms++;
    }
  }
  assert.ok(
    primary > 10 && mushrooms > 10,
    "fixture includes actual eligible v3 roots"
  );
});
