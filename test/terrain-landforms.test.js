import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BIOME_PROFILES } from "../src/biomes.js";
import { BLOCK, BLOCKS, isSolid } from "../src/blocks.js";
import { findNaturalSpawn, shapeOverworld } from "../src/landforms.js";
import { seedHash } from "../src/noise.js";
import {
  exportWorldFile,
  parseWorldFile,
  WorldStorage,
} from "../src/storage.js";
import { createGenerator, WATER_LEVEL } from "../src/terrain.js";
import { World } from "../src/world.js";

const seeds = ["cedar-valley", "birch-river", "123", ""];
const digest = (chunk) =>
  createHash("sha256").update(chunk.blocks).update(chunk.biomes).digest("hex");

test("height and biome sampling never synchronously plan underground cave cells", () => {
  const generator = createGenerator("cheap-landscape-samples");
  for (let z = -1024; z <= 1024; z += 32)
    for (let x = -1024; x <= 1024; x += 32) {
      const top = generator.terrainHeight(x, z);
      assert.ok(generator.getBiome(x, z));
      assert.ok(generator.getBiome(x, z, top + 2));
      assert.ok(generator.getBiome(x, z, 10));
    }
  assert.equal(
    generator.cavePlanCacheSize,
    0,
    "LOD and HUD queries must stay cheap"
  );
  generator.generateChunk(0, 0);
  assert.ok(
    generator.cavePlanCacheSize > 0,
    "actual voxel generation still plans cave cells"
  );
});

test("spawn selection rejects removed ground without planning caves for every scenery probe", () => {
  let samples = 0;
  const column = (x, z) => {
    samples++;
    return {
      x,
      z,
      top: 33,
      id: "forest",
      temperature: 0.6,
      profile: BIOME_PROFILES.forest,
    };
  };
  const salt = seedHash("cave-safe-spawn");
  const first = findNaturalSpawn(column, WATER_LEVEL, salt);
  samples = 0;
  let validations = 0;
  const next = findNaturalSpawn(column, WATER_LEVEL, salt, (point) => {
    validations++;
    return point.x !== first.x || point.z !== first.z;
  });
  assert.notDeepEqual(
    next,
    first,
    "a removed surface cannot remain the selected spawn"
  );
  assert.ok(validations > 0);
  assert.ok(
    samples > validations * 20,
    "cavity checks are deferred until competitive candidates"
  );
});

test("new seeds choose distinct natural spawns with solid ground and headroom", () => {
  const points = new Set();
  for (const seed of seeds) {
    const generator = createGenerator(seed);
    const spawn = generator.getSpawn();
    points.add(JSON.stringify(spawn));
    assert.deepEqual(createGenerator(seed).getSpawn(), spawn);
    const x = Math.floor(spawn.x);
    const z = Math.floor(spawn.z);
    const y = Math.floor(spawn.y);
    const chunk = generator.generateChunk(
      Math.floor(x / 16),
      Math.floor(z / 16)
    );
    const index = (z - chunk.cz * 16) * 16 + x - chunk.cx * 16;
    const block = (height) => chunk.blocks[height * 256 + index];
    assert.equal(y, generator.terrainHeight(x, z) + 1, seed);
    assert.ok(y > WATER_LEVEL + 2, seed);
    assert.ok(isSolid(block(y - 1)), seed);
    assert.ok(!isSolid(block(y)) && !isSolid(block(y + 1)), seed);
    assert.notEqual(block(y), BLOCK.WATER, seed);
    assert.notEqual(block(y), BLOCK.LAVA, seed);
    const nearby = generator.generateRegion(
      (Math.floor(x / 16) - 1) * 16,
      (Math.floor(z / 16) - 1) * 16,
      48,
      48
    );
    const logs = nearby.blocks.filter(
      (id) => BLOCKS[id].texture === "log"
    ).length;
    assert.ok(
      logs >= 9,
      `${seed}: natural woodland must be reachable from Survival spawn`
    );
    spawn.x += 1000;
    assert.notEqual(
      generator.getSpawn().x,
      spawn.x,
      "callers cannot move the cached spawn"
    );
  }
  assert.equal(
    points.size,
    seeds.length,
    "seeds must not share a sculpted starter valley"
  );
});

test("finding a natural spawn never changes the terrain or the generation order", () => {
  for (const seed of seeds) {
    const first = createGenerator(seed);
    const second = createGenerator(seed);
    const chunks = [
      [0, 0],
      [-1, -1],
      [1, 1],
      [6, -4],
      [-17, 9],
    ];
    const expected = chunks.map(([x, z]) => digest(first.generateChunk(x, z)));
    first.getSpawn();
    second.getSpawn();
    for (let i = chunks.length - 1; i >= 0; i--) {
      const [x, z] = chunks[i];
      assert.equal(digest(first.generateChunk(x, z)), expected[i]);
      assert.equal(digest(second.generateChunk(x, z)), expected[i]);
    }
    let changed = 0;
    const previous = createGenerator(seed, "overworld", 2);
    for (let z = -96; z <= 96; z += 16)
      for (let x = -96; x <= 96; x += 16)
        if (
          Math.abs(first.terrainHeight(x, z) - previous.terrainHeight(x, z)) >=
          4
        )
          changed++;
    assert.ok(
      changed >= 45,
      `${seed}: the repeated starter topology must actually change`
    );
  }
});

test("one forest profile produces flat basins, hills and incised river valleys", () => {
  const profile = BIOME_PROFILES.forest;
  const field = {
    nearest: { id: "forest", temperature: 0.6, profile },
    height: profile.height,
    relief: profile.relief,
    ocean: 0,
  };
  for (const seed of seeds) {
    const salt = seedHash(seed);
    let low = Infinity;
    let high = -Infinity;
    let flats = 0;
    let slopes = 0;
    let rivers = 0;
    let dryLow = Infinity;
    let dryHigh = -Infinity;
    let drySlopes = 0;
    for (let z = -640; z <= 640; z += 16)
      for (let x = -640; x <= 640; x += 16) {
        const here = shapeOverworld(x, z, field, salt, WATER_LEVEL);
        const next = shapeOverworld(x + 8, z, field, salt, WATER_LEVEL);
        const rise = Math.abs(here.height - next.height);
        low = Math.min(low, here.height);
        high = Math.max(high, here.height);
        if (rise < 0.3) flats++;
        if (rise > 4) slopes++;
        if (here.id === "river") rivers++;
        if (
          here.id === "forest" &&
          next.id === "forest" &&
          Math.min(here.height, next.height) > WATER_LEVEL + 5
        ) {
          dryLow = Math.min(dryLow, here.height);
          dryHigh = Math.max(dryHigh, here.height);
          if (rise > 0.8) drySlopes++;
        }
      }
    assert.ok(
      high - low > 22,
      `${seed}: multiple elevation bands inside the same biome`
    );
    assert.ok(
      flats > 100 && slopes > 20,
      `${seed}: both gentle and steep landforms`
    );
    assert.ok(
      rivers > 40,
      `${seed}: actual river cuts, not just a palette change`
    );
    assert.ok(
      dryHigh - dryLow > 10 && drySlopes > 80,
      `${seed}: dry woodland must vary too, independently of river banks`
    );
  }
});

test("v3 terrain has broad lowlands and high ridges without clipping peaks into a ceiling", () => {
  for (const seed of seeds) {
    const generator = createGenerator(seed);
    let lowlands = 0;
    let uplands = 0;
    let peaks = 0;
    const summitHeights = new Set();
    const categories = new Set();
    for (let z = -1536; z <= 1536; z += 32)
      for (let x = -1536; x <= 1536; x += 32) {
        const height = generator.terrainHeight(x, z);
        assert.ok(height >= 5 && height <= 86);
        if (height >= 25 && height < 36) lowlands++;
        if (height >= 45 && height < 65) uplands++;
        if (height >= 72) {
          peaks++;
          summitHeights.add(height);
        }
        categories.add(generator.getBiome(x, z).category);
      }
    assert.ok(lowlands > 100 && uplands > 100 && peaks > 10, seed);
    assert.ok(
      summitHeights.size >= 4,
      `${seed}: summits must span several elevations (${[...summitHeights]})`
    );
    assert.ok(
      categories.size >= 8,
      `${seed}: the wider map retains varied habitats`
    );
  }
});

test("quantized mountain summits do not become long flat ceiling shelves", () => {
  const mountains = new Set(["jagged_peaks", "frozen_peaks", "stony_peaks"]);
  let samples = 0;
  for (const seed of seeds) {
    const generator = createGenerator(seed);
    let longest = 0;
    for (const z of [-1024, -512, 0, 512, 1024]) {
      let previous = null;
      let run = 0;
      for (let x = -1536; x <= 1536; x += 2) {
        const height = generator.terrainHeight(x, z);
        if (height >= 72 && mountains.has(generator.getBiome(x, z).id)) {
          samples++;
          run = height === previous ? run + 2 : 2;
          longest = Math.max(longest, run);
          previous = height;
        } else {
          previous = null;
          run = 0;
        }
      }
    }
    assert.ok(longest < 64, `${seed}: ${longest}-block flat summit shelf`);
  }
  assert.ok(
    samples > 40,
    "the summit check must include real high mountain terrain"
  );
});

for (const version of [1, 2, 3]) {
  test(`archive roundtrip preserves generator v${version}, edited voxels and regenerated terrain`, async () => {
    const seed = "versioned-landforms";
    const world = new World(seed, {
      generatorVersion: version,
      useWorker: false,
    });
    const position = { x: -117, z: 203 };
    await world.ensureArea(position, 0);
    world.set(position.x, 94, position.z, BLOCK.GLASS);
    world.set(position.x, 2, position.z, BLOCK.AIR);
    const key = `${Math.floor(position.x / 16)},${Math.floor(position.z / 16)}`;
    const expected = digest(world.chunks.get(key));
    const data = { version: 2, world: world.serialize() };
    const store = new WorldStorage({ indexedDB: new IDBFactory() });
    const restored = new World(seed, { useWorker: false });
    try {
      await store.save(data);
      const saved = parseWorldFile(exportWorldFile(await store.load()));
      assert.equal(saved.world.generatorVersion, version);
      assert.ok(restored.loadEdits(saved.world));
      await restored.ensureArea(position, 0);
      assert.equal(restored.generatorVersion, version);
      assert.equal(digest(restored.chunks.get(key)), expected);
      assert.equal(restored.get(position.x, 94, position.z), BLOCK.GLASS);
      assert.equal(restored.get(position.x, 2, position.z), BLOCK.AIR);
    } finally {
      world.dispose();
      restored.dispose();
      await store.close();
    }
  });
}
