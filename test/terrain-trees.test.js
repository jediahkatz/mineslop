import assert from "node:assert/strict";
import test from "node:test";
import { BIOME_PROFILES } from "../src/biomes.js";
import { BLOCK as B, BLOCKS } from "../src/blocks.js";
import { createLegacyTerrain } from "../src/legacy-terrain.js";
import { hash, seedHash } from "../src/noise.js";
import { createGenerator, WATER_LEVEL, WORLD_HEIGHT } from "../src/terrain.js";
import { TREE_SPECIES } from "../src/terrain-profiles.js";
import {
  createTreeGenerator,
  describeTree,
  forestDensity,
  TREE_SPACING,
  writeTree,
} from "../src/terrain-trees.js";
import { varyTreeShape } from "../src/tree-shapes-v3.js";

const species = [
  ...Object.keys(TREE_SPECIES),
  "spruce",
  "pine",
  "giant_spruce",
  "acacia",
  "mushroom",
];

function flatTrees(
  version,
  top = 33,
  seed = "patchy-forest",
  profile = BIOME_PROFILES.forest
) {
  return createTreeGenerator({
    salt: seedHash(seed),
    dimension: "overworld",
    version,
    column: (x, z) => ({ x, z, top, temperature: 0.6, id: "forest", profile }),
    getSpawn: () => ({ x: 10000.5, y: 34.01, z: 10000.5 }),
    waterLevel: WATER_LEVEL,
    validXZ: () => true,
  });
}

test("native tree descriptors keep species, integer write bounds and placement order", () => {
  for (const type of species) {
    const tree = describeTree(
      -17,
      -1,
      { top: 33, profile: { tree: type } },
      0.18,
      seedHash("native-tree-model"),
      WATER_LEVEL
    );
    const blocks = new Map();
    const writes = [];
    writeTree(tree, (x, y, z, block, water = false) => {
      assert.ok([x, y, z].every(Number.isInteger));
      assert.ok(x >= tree.bounds.minX && x < tree.bounds.maxX, type);
      assert.ok(z >= tree.bounds.minZ && z < tree.bounds.maxZ, type);
      assert.ok(y >= tree.bounds.minY && y < tree.bounds.maxY, type);
      writes.push([x, y, z, block, water]);
      const key = `${x},${y},${z}`,
        previous = blocks.get(key);
      if (!previous || BLOCKS[previous].texture === "leaves")
        blocks.set(key, block);
    });
    assert.equal(blocks.get("-17,34,-1"), tree.wood, type);
    assert.ok([...blocks.values()].includes(tree.leaves), type);
    assert.deepEqual(writes[0], [-17, 34, -1, tree.wood, true], type);
    assert.ok(
      tree.parts.length < 20,
      "descriptors do not allocate a voxel per leaf"
    );
    assert.deepEqual(
      tree,
      describeTree(
        -17,
        -1,
        { top: 33, profile: { tree: type } },
        0.18,
        seedHash("native-tree-model"),
        WATER_LEVEL
      )
    );
  }
  const cherry = describeTree(
    0,
    0,
    { top: 30, profile: { tree: "cherry" } },
    0.1,
    123,
    WATER_LEVEL
  );
  assert.deepEqual(
    cherry.parts.map((part) => part.kind),
    ["trunk", "crown", "crown", "block", "block", "crown"]
  );
  const mangrove = describeTree(
    0,
    0,
    { top: 20, profile: { tree: "mangrove" } },
    0.1,
    123,
    WATER_LEVEL
  );
  assert.equal(mangrove.ground, WATER_LEVEL);
  assert.ok(
    mangrove.parts
      .filter((part) => part.kind === "block")
      .every((part) => part.replaceWater)
  );
});

test("root-owned feature cells are deterministic across order, negative and distant coordinates", () => {
  const cells = [];
  for (const [gx, gz] of [
    [-11, -10],
    [-1, -1],
    [0, 0],
    [375000, -362500],
  ]) {
    for (let z = 0; z < 6; z++)
      for (let x = 0; x < 6; x++) cells.push([gx + x, gz + z]);
  }
  for (const version of [1, 2, 3]) {
    const first = createGenerator("shared-trees", "overworld", version);
    const second = createGenerator("shared-trees", "overworld", version);
    const expected = new Map(
      cells.map(([gx, gz]) => [`${gx},${gz}`, first.getTrees(gx, gz)])
    );
    for (const [gx, gz] of cells.reverse()) {
      const trees = second.getTrees(gx, gz);
      assert.deepEqual(trees, expected.get(`${gx},${gz}`));
      for (const tree of trees) {
        assert.equal(Math.floor(tree.x / TREE_SPACING), gx);
        assert.equal(Math.floor(tree.z / TREE_SPACING), gz);
      }
    }
    for (const bad of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(first.getTrees(bad, 0), []);
      assert.deepEqual(first.getTrees(0, bad), []);
    }
  }
});

test("v1 descriptors exactly enumerate the frozen six-block legacy tree grid", () => {
  const seed = "cedar-valley";
  const native = createLegacyTerrain(seed);
  const generator = createGenerator(seed, "overworld", 1);
  const trees = new Map();
  for (let gz = -10; gz < 10; gz++)
    for (let gx = -10; gx < 10; gx++)
      for (const tree of generator.getTrees(gx, gz)) {
        if (!tree.legacy) {
          assert.ok(tree.exclude);
          assert.ok(
            tree.bounds.minX < -80 ||
              tree.bounds.maxX > 80 ||
              tree.bounds.minZ < -80 ||
              tree.bounds.maxZ > 80,
            "v2 trees wholly overwritten by the legacy area must not leak into LOD"
          );
          continue;
        }
        const key = `${tree.x},${tree.z}`;
        assert.equal(trees.has(key), false);
        trees.set(key, tree);
      }
  const blocks = native.blocks;
  let roots = 0;
  for (let z = -80; z < 80; z++) {
    for (let x = -80; x < 80; x++) {
      const ground = native.terrainHeight(x, z);
      const at = (y) => blocks[y * 160 * 160 + (z + 80) * 160 + x + 80];
      if (![B.OAK_LOG, B.BIRCH_LOG].includes(at(ground + 1))) continue;
      roots++;
      const tree = trees.get(`${x},${z}`);
      assert.ok(tree, `missing legacy tree at ${x},${z}`);
      assert.equal(tree.ground, ground);
      assert.equal(tree.wood, at(ground + 1));
      assert.equal(tree.wood, at(ground + tree.height));
      assert.equal(tree.leaves, at(ground + tree.height + 1));
    }
  }
  assert.ok(roots > 50, "fixture must include a substantial native forest");
  assert.equal(trees.size, roots);
});

test("v3 forest cover produces coherent clearings and woods in one unchanged flat biome", () => {
  const old = flatTrees(2);
  const current = flatTrees(3);
  const counts = [[], []];
  for (let pz = -4; pz < 4; pz++) {
    for (let px = -4; px < 4; px++) {
      const patch = [0, 0];
      for (let dz = 0; dz < 8; dz++) {
        for (let dx = 0; dx < 8; dx++) {
          const gx = px * 8 + dx,
            gz = pz * 8 + dz;
          patch[0] += old.getTrees(gx, gz).length;
          patch[1] += current.getTrees(gx, gz).length;
        }
      }
      patch.forEach((count, i) => counts[i].push(count / 64));
    }
  }
  const variance = (values) => {
    const mean = values.reduce((a, b) => a + b) / values.length;
    return (
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      values.length
    );
  };
  assert.ok(
    Math.min(...counts[1]) < 0.15,
    "v3 has actual 64-block-scale clearings"
  );
  assert.ok(Math.max(...counts[1]) > 0.75, "v3 retains dense woods");
  assert.ok(
    variance(counts[1]) > variance(counts[0]) * 4,
    "clustering is more than independent per-cell randomness"
  );
  const alpine = flatTrees(3, 82);
  for (let gz = -8; gz < 8; gz++)
    for (let gx = -8; gx < 8; gx++)
      assert.deepEqual(
        alpine.getTrees(gx, gz),
        [],
        "treeline removes high-elevation trees"
      );
});

test("sparse v3 patches retain unbiased mixed species and both mushroom cap colors", () => {
  for (const [tree, first, second, fraction] of [
    ["mixed", B.BIRCH_LEAVES, B.LEAVES, 0.25],
    ["mushroom", B.RED_MUSHROOM, B.BROWN_MUSHROOM, 0.5],
  ]) {
    const profile = { tree, density: 0.12 };
    const old = flatTrees(2, 33, "sparse-species", profile);
    const current = flatTrees(3, 33, "sparse-species", profile);
    const counts = new Map([
      [first, 0],
      [second, 0],
    ]);
    const oldLeaves = new Set();
    for (let gz = -48; gz < 48; gz++) {
      for (let gx = -48; gx < 48; gx++) {
        for (const model of current.getTrees(gx, gz))
          counts.set(model.leaves, counts.get(model.leaves) + 1);
        for (const model of old.getTrees(gx, gz)) oldLeaves.add(model.leaves);
      }
    }
    const total = counts.get(first) + counts.get(second);
    assert.ok(total > 100, `${tree}: a meaningful sparse native-tree sample`);
    assert.ok(counts.get(first) > 0 && counts.get(second) > 0, tree);
    assert.ok(
      Math.abs(counts.get(first) / total - fraction) < 0.12,
      `${tree}: density must not truncate the species/color distribution`
    );
    assert.deepEqual(
      oldLeaves,
      new Set([first]),
      "the frozen v2 placement/color coupling stays unchanged"
    );
  }
});

test("accepted placement chance does not change a v3 tree model at one coordinate", () => {
  const salt = seedHash("independent-shape");
  const col = {
    top: 33,
    temperature: 0.6,
    id: "mushroom_fields",
    profile: { tree: "mushroom", density: 1 },
  };
  const sampler = createTreeGenerator({
    salt,
    dimension: "overworld",
    version: 3,
    column: () => col,
    getSpawn: () => ({ x: 10000.5, z: 10000.5 }),
    waterLevel: WATER_LEVEL,
    validXZ: () => true,
  });
  let samples = 0;
  for (let z = -512; z <= 512; z += 64) {
    for (let x = -512; x <= 512; x += 64) {
      const density = forestDensity(x, z, col, salt);
      if (density < 0.7) continue;
      samples++;
      const lowChance = sampler.primary(x, z, col, 0.01);
      const highChance = sampler.primary(x, z, col, density * 0.95);
      assert.ok(lowChance && highChance);
      assert.deepEqual(lowChance, highChance);
    }
  }
  assert.ok(
    samples > 10,
    "fixture exercises placement chances on both sides of the old cap-color threshold"
  );
});

test("secondary dark-forest mushrooms also have independent v3 cap colors", () => {
  const sampler = createTreeGenerator({
    salt: seedHash("dark-cap-variety"),
    dimension: "overworld",
    version: 3,
    column: (x, z) => ({
      x,
      z,
      top: 33,
      temperature: 0.6,
      id: "dark_forest",
      profile: BIOME_PROFILES.dark_forest,
    }),
    getSpawn: () => ({ x: 10000.5, z: 10000.5 }),
    waterLevel: WATER_LEVEL,
    validXZ: () => true,
  });
  const caps = new Set();
  for (let gz = -32; gz < 32; gz++)
    for (let gx = -32; gx < 32; gx++)
      for (const tree of sampler.getTrees(gx, gz))
        if (tree.type === "mushroom") caps.add(tree.leaves);
  assert.deepEqual(caps, new Set([B.RED_MUSHROOM, B.BROWN_MUSHROOM]));
});

test("v1/v2 and non-Overworld model selection retain their original chance", () => {
  const col = {
    top: 33,
    id: "forest",
    temperature: 0.6,
    profile: { tree: "mushroom", density: 1 },
  };
  for (const [version, dimension] of [
    [1, "overworld"],
    [2, "overworld"],
    [3, "nether"],
    [3, "end"],
  ]) {
    const sampler = createTreeGenerator({
      salt: 123,
      dimension,
      version,
      column: () => col,
      surfaceColumn: () => {
        assert.fail("surface-only tree sampling is v3 Overworld only");
      },
      isTreeEligible: () => {
        assert.fail("whole-tree eligibility is v3 Overworld only");
      },
      getSpawn: () => {
        throw new Error(
          "old/non-Overworld models do not consult natural spawn"
        );
      },
      waterLevel: WATER_LEVEL,
      validXZ: () => true,
    });
    for (const chance of [0.1, 0.7])
      assert.deepEqual(
        sampler.primary(-320, -320, col, chance),
        describeTree(-320, -320, col, chance, 123, WATER_LEVEL)
      );
    sampler.getTrees(-40, -40);
  }
});

test("v3 tree clearance follows the natural spawn, and old versions never consult it", () => {
  for (const version of [1, 2, 3]) {
    let calls = 0;
    const col = {
      top: 33,
      id: "forest",
      temperature: 0.6,
      profile: { tree: "oak", density: 1 },
    };
    const sampler = createTreeGenerator({
      salt: 123,
      dimension: "overworld",
      version,
      column: () => col,
      waterLevel: WATER_LEVEL,
      validXZ: () => true,
      getSpawn: () => {
        calls++;
        return { x: -319.5, z: -319.5 };
      },
    });
    assert.equal(sampler.primary(21, 30, col, 0) === null, version < 3);
    if (version === 3) assert.equal(sampler.primary(-320, -320, col, 0), null);
    assert.equal(calls > 0, version === 3);
  }
});

test("v3 cave-mouth and open-surface roots are rejected by every tree entry point", () => {
  const salt = seedHash("cave-tree-roots");
  const base = {
    top: 33,
    id: "dark_forest",
    temperature: 0.6,
    profile: BIOME_PROFILES.dark_forest,
  };
  let site;
  for (let z = -512; z < 512 && !site; z += 64)
    for (let x = -512; x < 512; x += 64)
      if (forestDensity(x, z, base, salt) > 0.7) {
        site = { x, z };
        break;
      }
  assert.ok(site);
  for (const flags of [{ caveMouth: true }, { surfaceOpen: true }]) {
    for (const version of [1, 2, 3]) {
      const col = { ...base, ...site, ...flags };
      const sampler = createTreeGenerator({
        salt,
        dimension: "overworld",
        version,
        column: () => col,
        getSpawn: () => ({ x: 10000.5, z: 10000.5 }),
        waterLevel: WATER_LEVEL,
        validXZ: () => true,
        isTreeEligible: () => {
          assert.fail(
            "blocked roots and old versions do not invoke the v3 predicate"
          );
        },
      });
      assert.equal(
        sampler.primary(site.x, site.z, col, 0.01) === null,
        version === 3
      );
      assert.equal(
        sampler.mushroom(site.x, site.z, col, 0.91) === null,
        version === 3
      );
      if (version === 3)
        assert.deepEqual(
          sampler.getTrees(Math.floor(site.x / 8), Math.floor(site.z / 8)),
          []
        );
    }
  }
});

test("surface-only candidates defer authoritative cave work until placement succeeds", () => {
  const salt = seedHash("deferred-tree-caves");
  const profile = { tree: "oak", density: 0 };
  const calls = { surface: 0, full: 0, eligibility: 0 };
  let blocked = false;
  const surface = (x, z) => ({
    x,
    z,
    top: 33,
    id: "forest",
    temperature: 0.6,
    profile,
  });
  const sampler = createTreeGenerator({
    salt,
    dimension: "overworld",
    version: 3,
    surfaceColumn(x, z) {
      calls.surface++;
      return surface(x, z);
    },
    column(x, z) {
      calls.full++;
      return { ...surface(x, z), caveMouth: blocked, wetBanksChecked: true };
    },
    getSpawn: () => ({ x: 10000.5, z: 10000.5 }),
    waterLevel: WATER_LEVEL,
    validXZ: () => true,
    isTreeEligible(tree, root) {
      calls.eligibility++;
      assert.equal(
        root.wetBanksChecked,
        true,
        "the full cave-aware root is authoritative"
      );
      const source = describeTree(
        tree.x,
        tree.z,
        root,
        hash(tree.x, tree.z, salt ^ 4421),
        salt,
        WATER_LEVEL
      );
      assert.deepEqual(
        tree,
        varyTreeShape(source, salt),
        "eligibility runs after morphing the entire descriptor"
      );
      return true;
    },
  });
  const scan = () => {
    const trees = [];
    for (let gz = -16; gz < 16; gz++)
      for (let gx = -16; gx < 16; gx++) trees.push(...sampler.getTrees(gx, gz));
    return trees;
  };
  assert.deepEqual(scan(), []);
  assert.equal(calls.surface, 1024);
  assert.equal(calls.full, 0, "rejected density never plans a cold cave cell");
  assert.equal(calls.eligibility, 0);
  profile.density = 1;
  const trees = scan();
  assert.ok(trees.length > 0 && trees.length < 1024);
  assert.equal(calls.full, trees.length);
  assert.equal(calls.eligibility, trees.length);
  blocked = true;
  assert.deepEqual(
    scan(),
    [],
    "late cave-root rejection also applies to cheap LOD samples"
  );
  assert.equal(calls.full, trees.length * 2);
  assert.equal(
    calls.eligibility,
    trees.length,
    "blocked full roots do not run whole-tree work"
  );
});

test("whole-tree eligibility rejects a real morphed branch for native and descriptor callers", () => {
  const salt = seedHash("branch-cave-reservation");
  const column = (x, z) => ({
    x,
    z,
    top: 33,
    id: "cherry_grove",
    temperature: 0.6,
    profile: { tree: "cherry", density: 1 },
  });
  const settings = {
    salt,
    dimension: "overworld",
    version: 3,
    column,
    getSpawn: () => ({ x: 10000.5, z: 10000.5 }),
    waterLevel: WATER_LEVEL,
    validXZ: () => true,
  };
  const original = createTreeGenerator(settings);
  let site;
  for (let gz = -16; gz < 16 && !site; gz++)
    for (let gx = -16; gx < 16; gx++) {
      const tree = original.getTrees(gx, gz)[0];
      if (tree) {
        site = { gx, gz, tree };
        break;
      }
    }
  assert.ok(site);
  const { gx, gz, tree } = site;
  let reserved;
  writeTree(tree, (x, y, z, block) => {
    if (!reserved && block === tree.wood && (x !== tree.x || z !== tree.z))
      reserved = { x, y, z };
  });
  assert.ok(
    reserved,
    "reservation intersects an actual connected branch away from the root"
  );
  let checks = 0;
  const filtered = createTreeGenerator({
    ...settings,
    isTreeEligible(candidate, root) {
      checks++;
      assert.deepEqual(candidate, tree);
      assert.equal(root.profile.tree, "cherry");
      let intersects = false;
      writeTree(candidate, (x, y, z) => {
        if (x === reserved.x && y === reserved.y && z === reserved.z)
          intersects = true;
      });
      return !intersects;
    },
  });
  const native = filtered.primary(
    tree.x,
    tree.z,
    column(tree.x, tree.z),
    hash(gx, gz, salt ^ 2713)
  );
  assert.equal(native, null);
  assert.deepEqual(filtered.getTrees(gx, gz), []);
  let writes = 0;
  writeTree(native, () => writes++);
  assert.equal(
    writes,
    0,
    "no partial native tree remains after rejecting its branch"
  );
  assert.equal(checks, 2);
});

test("tree eligibility preserves dry-ground requirements and the native wet-tree exception", () => {
  const salt = seedHash("tree-wet-root");
  let checks = 0;
  const col = {
    top: 33,
    id: "forest",
    temperature: 0.6,
    profile: { tree: "oak", density: 1 },
  };
  let site;
  for (let z = -512; z < 512 && !site; z += 64)
    for (let x = -512; x < 512; x += 64)
      if (forestDensity(x, z, col, salt) > 0.5) {
        site = { x, z };
        break;
      }
  assert.ok(site);
  const sampler = createTreeGenerator({
    salt,
    dimension: "overworld",
    version: 3,
    column: () => col,
    getSpawn: () => ({ x: 10000.5, z: 10000.5 }),
    waterLevel: WATER_LEVEL,
    validXZ: () => true,
    isTreeEligible: () => {
      checks++;
      return true;
    },
  });
  assert.equal(
    sampler.primary(site.x, site.z, { ...col, top: WATER_LEVEL + 1 }, 0.01),
    null
  );
  assert.equal(checks, 0);
  const wet = {
    ...col,
    top: WATER_LEVEL - 2,
    id: "mangrove_swamp",
    profile: { tree: "mangrove", density: 1 },
  };
  assert.equal(sampler.primary(site.x, site.z, wet, 0.01).ground, WATER_LEVEL);
  assert.equal(checks, 1);
  assert.equal(
    sampler.primary(site.x, site.z, { ...wet, surfaceOpen: true }, 0.01),
    null
  );
  assert.equal(checks, 1);
});

test("v3 independently generated negative chunks match a wider wooded region", () => {
  const seed = "cedar-valley";
  const generator = createGenerator(seed, "overworld", 3);
  const point = generator.locateBiome("forest", { x: -1600, z: -1600 });
  assert.ok(point);
  const cx = Math.floor(point.x / 16),
    cz = Math.floor(point.z / 16);
  assert.ok(cx < 0 && cz < 0);
  const minX = cx * 16 - 16,
    minZ = cz * 16 - 16;
  const wide = generator.generateRegion(minX, minZ, 32, 32);
  const replay = createGenerator(seed, "overworld", 3);
  let foliage = 0;
  for (const [ox, oz] of [
    [1, 1],
    [0, 0],
    [1, 0],
    [0, 1],
  ]) {
    const chunk = replay.generateChunk(cx - 1 + ox, cz - 1 + oz);
    for (let y = 0; y < WORLD_HEIGHT; y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const block = chunk.blocks[y * 256 + z * 16 + x];
          assert.equal(
            block,
            wide.blocks[y * 1024 + (z + oz * 16) * 32 + x + ox * 16]
          );
          if (BLOCKS[block].texture === "leaves") foliage++;
        }
  }
  assert.ok(foliage > 0, "the seam fixture includes real v3 canopy");
  const emittedWood = new Set();
  for (
    let gz = Math.floor((minZ - 8) / 8);
    gz <= Math.floor((minZ + 39) / 8);
    gz++
  )
    for (
      let gx = Math.floor((minX - 8) / 8);
      gx <= Math.floor((minX + 39) / 8);
      gx++
    )
      for (const tree of generator.getTrees(gx, gz))
        writeTree(tree, (x, y, z, id) => {
          if (id === tree.wood) emittedWood.add(`${x},${y},${z},${id}`);
        });
  let logs = 0;
  for (let z = 0; z < 32; z++)
    for (let x = 0; x < 32; x++)
      for (
        let y = generator.terrainHeight(minX + x, minZ + z) + 1;
        y < WORLD_HEIGHT;
        y++
      ) {
        const id = wide.blocks[y * 1024 + z * 32 + x];
        if (BLOCKS[id].texture !== "log") continue;
        logs++;
        assert.ok(emittedWood.has(`${minX + x},${y},${minZ + z},${id}`));
      }
  assert.ok(
    logs > 0,
    "all actual tree wood is accounted for by native descriptors"
  );
});
