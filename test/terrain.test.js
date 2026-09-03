import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BIOME_INDEX, BIOMES } from "../src/biomes.js";
import { BLOCK as B, BLOCKS, isSolid } from "../src/blocks.js";
import { squareSpiral } from "../src/noise.js";
import {
  CHUNK_SIZE,
  createGenerator,
  GENERATOR_VERSION,
  WATER_LEVEL,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
} from "../src/terrain.js";

const digest = (chunk) =>
  createHash("sha256").update(chunk.blocks).update(chunk.biomes).digest("hex");
function read(generator, x, y, z) {
  const cx = Math.floor(x / CHUNK_SIZE),
    cz = Math.floor(z / CHUNK_SIZE);
  return generator.generateChunk(cx, cz).blocks[
    y * 256 + (z - cz * 16) * 16 + x - cx * 16
  ];
}

function woodedSample(generator, id) {
  const point = generator.locateBiome(id);
  assert.ok(point, id);
  const gx = Math.floor(point.x / 8);
  const gz = Math.floor(point.z / 8);
  // An atlas landing can now be a clearing. Select a real canopy crossing a
  // chunk edge so the seam/material tests still exercise their intended case.
  for (const [dx, dz] of squareSpiral(48)) {
    for (const tree of generator.getTrees(gx + dx, gz + dz)) {
      if (generator.getBiome(tree.x, tree.z).id !== id) continue;
      if (
        tree.parts.some(
          (part) =>
            part.kind === "crown" &&
            (Math.floor((part.x - part.radius) / 16) !==
              Math.floor((part.x + part.radius) / 16) ||
              Math.floor((part.z - part.radius) / 16) !==
                Math.floor((part.z + part.radius) / 16))
        )
      )
        return { ...point, x: tree.x, z: tree.z };
    }
  }
  assert.fail(`${id}: no real edge-crossing canopy near the atlas destination`);
}

test("v3 is the default and deterministic at negative, distant and border coordinates", () => {
  assert.equal(GENERATOR_VERSION, 3);
  const coords = [
    [0, 0],
    [-1, -1],
    [-3, 2],
    [100000, -90000],
    [WORLD_MIN / 16, WORLD_MAX / 16 - 1],
  ];
  for (const dimension of ["overworld", "nether", "end"]) {
    const first = createGenerator("cedar-valley", dimension);
    const second = createGenerator("cedar-valley", dimension);
    const expected = new Map(
      coords.map(([x, z]) => [`${x},${z}`, digest(first.generateChunk(x, z))])
    );
    for (const [cx, cz] of [...coords].reverse()) {
      const chunk = second.generateChunk(cx, cz);
      assert.equal(digest(chunk), expected.get(`${cx},${cz}`));
      assert.deepEqual([chunk.cx, chunk.cz], [cx, cz]);
      assert.ok(chunk.blocks instanceof Uint8Array);
      assert.ok(chunk.biomes instanceof Uint8Array);
      assert.equal(chunk.blocks.length, 16 * 16 * 96);
      assert.equal(chunk.biomes.length, 256);
      assert.ok(chunk.blocks.every((id) => BLOCKS[id]));
      assert.ok(chunk.biomes.every((index) => BIOMES[index]));
    }
  }
  assert.notEqual(
    digest(createGenerator("cedar-valley").generateChunk(9, 4)),
    digest(createGenerator("birch-river").generateChunk(9, 4))
  );
  assert.equal(
    digest(createGenerator("x".repeat(90)).generateChunk(-1, 0)),
    digest(createGenerator("x".repeat(80)).generateChunk(-1, 0))
  );
});

test("independently generated chunks exactly equal one wide feature region", () => {
  const generator = createGenerator("cedar-valley");
  for (const id of [
    "forest",
    "savanna",
    "old_growth_spruce_taiga",
    "cherry_grove",
    "mangrove_swamp",
  ]) {
    const point = woodedSample(generator, id);
    const cx = Math.floor(point.x / 16),
      cz = Math.floor(point.z / 16);
    const minX = cx * 16 - 16,
      minZ = cz * 16 - 16;
    const whole = generator.generateRegion(minX, minZ, 32, 32);
    let canopyAtSeam = 0;
    for (const [ox, oz] of [
      [1, 1],
      [0, 0],
      [1, 0],
      [0, 1],
    ]) {
      const chunk = createGenerator("cedar-valley").generateChunk(
        cx - 1 + ox,
        cz - 1 + oz
      );
      for (let y = 0; y < WORLD_HEIGHT; y++)
        for (let z = 0; z < 16; z++)
          for (let x = 0; x < 16; x++) {
            const source = y * 256 + z * 16 + x;
            const target = y * 1024 + (z + oz * 16) * 32 + x + ox * 16;
            assert.equal(
              chunk.blocks[source],
              whole.blocks[target],
              `${id}: ${x},${y},${z}`
            );
            if (
              (x === 0 || x === 15 || z === 0 || z === 15) &&
              BLOCKS[chunk.blocks[source]].texture === "leaves"
            )
              canopyAtSeam++;
          }
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++)
          assert.equal(
            chunk.biomes[z * 16 + x],
            whole.biomes[(z + oz * 16) * 32 + x + ox * 16]
          );
    }
    assert.ok(canopyAtSeam > 0, `${id}: seam test must include actual foliage`);
  }
});

test("chunk heightmaps and biome indices describe the generated terrain", () => {
  const generator = createGenerator("cedar-valley");
  for (const [cx, cz] of [
    [-1, -2],
    [3, 1],
    [-34, 17],
  ]) {
    const chunk = generator.generateChunk(cx, cz);
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) {
        const wx = cx * 16 + x,
          wz = cz * 16 + z,
          index = z * 16 + x;
        const top = generator.terrainHeight(wx, wz);
        assert.ok(isSolid(chunk.blocks[top * 256 + index]));
        assert.equal(chunk.blocks[index], B.BEDROCK);
        assert.equal(
          chunk.biomes[index],
          BIOME_INDEX[generator.getBiome(wx, wz).id]
        );
      }
  }
  assert.equal(generator.terrainHeight(WORLD_MIN - 1, 0), -1);
  assert.equal(generator.terrainHeight(WORLD_MAX, 0), -1);
  assert.ok(
    generator
      .generateChunk(WORLD_MAX / 16, 0)
      .blocks.every((id) => id === B.AIR)
  );
  assert.throws(() => generator.generateChunk(0.5, 1), RangeError);
  assert.throws(
    () => generator.generateRegion(0, 0, 100000, 100000),
    RangeError
  );
  assert.throws(() => createGenerator("seed", "moon"), RangeError);
});

test("v2 saves keep their original dry, clear starter valley across seeds", () => {
  for (const seed of ["cedar-valley", "birch-river", "123", ""]) {
    const generator = createGenerator(seed, "overworld", 2);
    const point = generator.getSpawn();
    assert.deepEqual(point, { x: 21.5, y: 32.01, z: 30.5 });
    const { blocks } = generator.generateRegion(-8, -2, 64, 64);
    let water = 0,
      wood = 0;
    for (const id of blocks) {
      if (id === B.WATER) water++;
      if (id === B.OAK_LOG || id === B.BIRCH_LOG) wood++;
    }
    assert.ok(
      water > 100,
      `${seed}: a real lake or river should be visible from spawn`
    );
    assert.ok(wood > 0, `${seed}: nearby natural woodland`);
    const x = Math.floor(point.x),
      y = Math.floor(point.y),
      z = Math.floor(point.z);
    assert.ok(isSolid(read(generator, x, y - 1, z)));
    assert.equal(isSolid(read(generator, x, y, z)), false);
    assert.equal(isSolid(read(generator, x, y + 1, z)), false);
    assert.ok(y > WATER_LEVEL + 2);
  }
});

test("land biomes form broad contiguous regions rather than block-scale mosaics", () => {
  const generator = createGenerator("cedar-valley");
  let runsOver100 = 0,
    longest = 0;
  for (const z of [-1300, -650, 650, 1300]) {
    let previous = "",
      run = 0;
    for (let x = -2000; x <= 2000; x += 8) {
      const biome = generator.getBiome(x, z);
      run = biome.id === previous ? run + 8 : 8;
      previous = biome.id;
      if (!["river", "shore", "ocean"].includes(biome.category)) {
        longest = Math.max(longest, run);
        if (run === 104) runsOver100++;
      }
    }
  }
  assert.ok(runsOver100 >= 15, `Only ${runsOver100} broad land regions`);
  assert.ok(longest >= 200);
});

test("biome profiles produce their distinct terrain, vegetation and cave materials", () => {
  const generators = new Map(
    ["overworld", "nether", "end"].map((dimension) => [
      dimension,
      createGenerator("cedar-valley", dimension),
    ])
  );
  const examples = {
    desert: [B.CACTUS, B.SANDSTONE, B.DEAD_BUSH],
    badlands: [
      B.RED_SAND,
      B.RED_TERRACOTTA,
      B.ORANGE_TERRACOTTA,
      B.YELLOW_TERRACOTTA,
      B.WHITE_TERRACOTTA,
    ],
    savanna: [B.ACACIA_LOG, B.ACACIA_LEAVES],
    old_growth_spruce_taiga: [B.SPRUCE_LOG, B.SPRUCE_LEAVES, B.PODZOL],
    old_growth_pine_taiga: [B.SPRUCE_LOG, B.PODZOL],
    pale_garden: [B.PALE_LOG, B.PALE_LEAVES, B.MOSS],
    cherry_grove: [B.CHERRY_LOG, B.CHERRY_LEAVES, B.PINK_PETALS],
    jungle: [B.JUNGLE_LOG, B.JUNGLE_LEAVES, B.MELON],
    bamboo_jungle: [B.BAMBOO],
    mangrove_swamp: [B.MANGROVE_LOG, B.MANGROVE_LEAVES, B.MUD, B.CLAY],
    mushroom_fields: [
      B.MYCELIUM,
      B.MUSHROOM_STEM,
      B.RED_MUSHROOM,
      B.BROWN_MUSHROOM,
    ],
    ice_spikes: [B.PACKED_ICE],
    frozen_peaks: [B.PACKED_ICE, B.SNOW_BLOCK],
    warm_ocean: [B.CORAL, B.WATER, B.SAND],
    // Rare berry pockets are bounded across seeds in the cave integration
    // tests; they need not light up every individual lush-cave destination.
    lush_caves: [B.MOSS, B.CAVE_VINE],
    dripstone_caves: [B.DRIPSTONE],
    deep_dark: [B.SCULK],
    basalt_deltas: [B.BASALT, B.BLACKSTONE, B.GLOWSTONE],
    soul_sand_valley: [B.SOUL_SAND],
    crimson_forest: [B.CRIMSON_STEM, B.CRIMSON_LEAVES],
    warped_forest: [B.WARPED_STEM, B.WARPED_LEAVES],
    end_highlands: [B.END_STONE, B.CHORUS],
  };
  for (const [id, materials] of Object.entries(examples)) {
    const biome = BIOMES.find((entry) => entry.id === id);
    const generator = generators.get(biome.dimension);
    const point = biome.trees.length
      ? woodedSample(generator, id)
      : generator.locateBiome(id);
    assert.ok(point, id);
    const { blocks } = generator.generateRegion(
      Math.floor(point.x) - 24,
      Math.floor(point.z) - 24,
      48,
      48
    );
    const found = new Set(blocks);
    for (const material of materials)
      assert.ok(found.has(material), `${id}: missing ${BLOCKS[material].name}`);
  }
  const end = generators.get("end");
  assert.ok(end.generateRegion(40, -20, 40, 40).blocks.includes(B.OBSIDIAN));
  const voidRegion = end.generateRegion(192, 0);
  assert.ok(voidRegion.blocks.every((id) => id === B.AIR));
  assert.ok(voidRegion.biomes.every((id) => id === BIOME_INDEX.the_void));
});

test("ore veins span natural mining depths, including negative chunk boundaries", () => {
  const generator = createGenerator("cedar-valley");
  const found = new Set();
  for (const [x, z] of [
    [-32, -32],
    [0, -64],
    [256, 160],
  ]) {
    const region = generator.generateRegion(x, z, 48, 48);
    for (const id of region.blocks) found.add(id);
    for (let y = 16; y < 96; y++) {
      const layer = region.blocks.subarray(y * 48 * 48, (y + 1) * 48 * 48);
      assert.ok(
        !layer.includes(B.DIAMOND_ORE),
        "Diamonds must remain a deep mining reward"
      );
    }
  }
  for (const id of [
    B.COAL_ORE,
    B.IRON_ORE,
    B.COPPER_ORE,
    B.GOLD_ORE,
    B.DIAMOND_ORE,
    B.REDSTONE_ORE,
    B.EMERALD_ORE,
    B.LAPIS_ORE,
  ])
    assert.ok(found.has(id), BLOCKS[id].name);
});
