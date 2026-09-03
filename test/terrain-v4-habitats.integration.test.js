import assert from "node:assert/strict";
import test from "node:test";
import { FLUID } from "../src/block-state.js";
import { BLOCK as B, isSolid } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import { readV4RegionCell } from "../src/terrain-v4-writer.js";
import {
  findNaturalColumn,
  forEachRegionCell,
  naturalColumns,
  v4Digest,
} from "./terrain-v4-helpers.js";

const passable = (id) => !isSolid(id) && id !== B.WATER && id !== B.LAVA;
const nativeTerrain = (seed, dimension = "overworld") =>
  createGenerator(seed, dimension, 4);

function accessibleLogs(generator, region, spawn) {
  const logs = new Set([
    B.OAK_LOG,
    B.BIRCH_LOG,
    B.SPRUCE_LOG,
    B.ACACIA_LOG,
    B.JUNGLE_LOG,
    B.CHERRY_LOG,
    B.DARK_OAK_LOG,
    B.PALE_LOG,
    B.MANGROVE_LOG,
  ]);
  const block = (x, y, z) => readV4RegionCell(region, x, y, z)?.id;
  const queue = [[Math.floor(spawn.x), Math.floor(spawn.z)]];
  const seen = new Set([queue[0].join(",")]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [x, z] = queue[cursor];
    const top = generator.surfaceYAt(x, z);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const nz = z + dz;
      for (let dy = 0; dy <= 3; dy++)
        if (logs.has(block(nx, top + dy, nz))) return true;
      const key = `${nx},${nz}`;
      if (
        seen.has(key) ||
        nx < region.minX ||
        nx >= region.minX + region.width ||
        nz < region.minZ ||
        nz >= region.minZ + region.depth
      )
        continue;
      const next = generator.surfaceYAt(nx, nz);
      if (
        next === null ||
        Math.abs(next - top) > 1 ||
        !isSolid(block(nx, next, nz)) ||
        !passable(block(nx, next + 1, nz)) ||
        !passable(block(nx, next + 2, nz))
      )
        continue;
      seen.add(key);
      queue.push([nx, nz]);
    }
  }
  return false;
}

test("real seeds choose deterministic dry spawns with native headroom and reachable harvestable wood", {
  timeout: 30000, // Natural search, generated collision checks and a bounded voxel path search.
}, () => {
  const spawns = new Set();
  for (const seed of ["cedar-valley", "v4-live-world"]) {
    const generator = nativeTerrain(seed);
    const before = v4Digest(generator.generateChunk(0, 0));
    const spawn = generator.getSpawn();
    assert.deepEqual(nativeTerrain(seed).getSpawn(), spawn);
    assert.equal(
      v4Digest(generator.generateChunk(0, 0)),
      before,
      "spawn lookup never sculpts the world"
    );
    spawns.add(JSON.stringify(spawn));
    const x = Math.floor(spawn.x);
    const z = Math.floor(spawn.z);
    const y = Math.floor(spawn.y);
    const region = generator.generateRegion(x - 27, z - 27, 55, 55);
    assert.equal(y, generator.surfaceYAt(x, z) + 1);
    assert.ok(y > 64);
    assert.ok(isSolid(readV4RegionCell(region, x, y - 1, z).id));
    assert.ok(passable(readV4RegionCell(region, x, y, z).id));
    assert.ok(passable(readV4RegionCell(region, x, y + 1, z).id));
    assert.equal(readV4RegionCell(region, x, y, z).fluid, FLUID.NONE);
    assert.ok(
      accessibleLogs(generator, region, spawn),
      `${seed}: wood reachable by cardinal movement/jumps`
    );
    spawn.x += 100;
    assert.notEqual(generator.getSpawn().x, spawn.x, "detached spawn value");
  }
  assert.equal(spawns.size, 2, "no identical stamped starter valley");
});

test("real caves have negative-Y passages, varied floors/roofs and a naturally open entrance", {
  timeout: 30000, // Full-height natural cave region plus a surface-opening scan.
}, () => {
  const generator = nativeTerrain("v4-live-caves");
  const spawn = generator.getSpawn();
  const minX = Math.floor(spawn.x) - 16;
  const minZ = Math.floor(spawn.z) - 16;
  const region = generator.generateRegion(minX, minZ, 32, 32);
  const floors = new Set();
  const roofs = new Set();
  let negativeAir = 0;
  let walkableFloors = 0;
  for (let z = minZ; z < minZ + 32; z++)
    for (let x = minX; x < minX + 32; x++) {
      const col = generator.sampleColumn(x, z);
      let previous = -Infinity;
      for (const [low, high] of generator.getCaveIntervals(x, z)) {
        assert.ok(low >= -59 && high < 320 && high - low >= 2);
        assert.ok(
          low > previous + 1,
          "interval union removes fake internal roofs"
        );
        previous = high;
        floors.add(low);
        roofs.add(high);
      }
      for (let y = -59; y < Math.min(-1, col.top - 5); y++) {
        const here = readV4RegionCell(region, x, y, z).id;
        if (here === B.AIR) negativeAir++;
        if (
          isSolid(readV4RegionCell(region, x, y - 1, z).id) &&
          here === B.AIR &&
          readV4RegionCell(region, x, y + 1, z).id === B.AIR
        )
          walkableFloors++;
      }
    }
  assert.ok(negativeAir > 128 && walkableFloors > 10);
  assert.ok(
    floors.size >= 8 && roofs.size >= 8,
    "no two constant-height hollow sheets"
  );
  const entrance = findNaturalColumn(
    generator,
    (col) => col.surfaceOpen && col.landTop - col.top >= 4,
    "surface cave opening",
    { radius: 6144, step: 64 }
  );
  const mouth = generator.generateRegion(entrance.x - 2, entrance.z - 2, 5, 5);
  let openings = 0;
  for (let z = mouth.minZ; z < mouth.minZ + mouth.depth; z++)
    for (let x = mouth.minX; x < mouth.minX + mouth.width; x++) {
      const col = generator.sampleColumn(x, z);
      if (
        col.surfaceOpen &&
        isSolid(readV4RegionCell(mouth, x, col.top, z).id) &&
        passable(readV4RegionCell(mouth, x, col.top + 1, z).id) &&
        passable(readV4RegionCell(mouth, x, col.top + 2, z).id)
      )
        openings++;
    }
  assert.ok(
    openings > 0,
    "a real hillside/rift exposes a supported, open passage"
  );
});

test("real strata expose Survival ores below zero and mineral-bearing mountains above the old ceiling", {
  timeout: 30000, // Generate real underground and high-altitude sample regions.
}, () => {
  const generator = nativeTerrain("v4-ore-ranges");
  const spawn = generator.getSpawn();
  const region = generator.generateRegion(
    Math.floor(spawn.x) - 24,
    Math.floor(spawn.z) - 24,
    48,
    48
  );
  const ores = new Set();
  let deepRock = 0;
  forEachRegionCell(region, (id, x, y) => {
    if (id === B.DEEPSLATE && y < 0) deepRock++;
    if (
      y < 0 &&
      [
        B.DEEPSLATE_IRON_ORE,
        B.DEEPSLATE_GOLD_ORE,
        B.DEEPSLATE_DIAMOND_ORE,
        B.DEEPSLATE_REDSTONE_ORE,
        B.DEEPSLATE_LAPIS_ORE,
      ].includes(id)
    )
      ores.add(id);
    if (y >= 0 && [B.COAL_ORE, B.IRON_ORE, B.COPPER_ORE].includes(id))
      ores.add(id);
  });
  assert.ok(deepRock > 500);
  for (const id of [
    B.COAL_ORE,
    B.IRON_ORE,
    B.COPPER_ORE,
    B.DEEPSLATE_IRON_ORE,
    B.DEEPSLATE_GOLD_ORE,
    B.DEEPSLATE_DIAMOND_ORE,
    B.DEEPSLATE_REDSTONE_ORE,
    B.DEEPSLATE_LAPIS_ORE,
  ])
    assert.ok(ores.has(id), `natural deposit ${id}`);
  const mountain = findNaturalColumn(
    generator,
    (col) => col.top >= 145 && col.mountain > 0.55,
    "mineral-bearing high mountain"
  );
  const highland = generator.generateRegion(
    mountain.x - 16,
    mountain.z - 16,
    32,
    32
  );
  let highOres = 0;
  let emeralds = 0;
  let upperCaves = 0;
  forEachRegionCell(highland, (id, x, y, z) => {
    if (y > 96 && [B.COAL_ORE, B.IRON_ORE, B.EMERALD_ORE].includes(id))
      highOres++;
    if (id === B.EMERALD_ORE) emeralds++;
    if (id === B.AIR && y > 96 && y < generator.surfaceYAt(x, z) - 5)
      upperCaves++;
  });
  assert.ok(highOres > 0 && emeralds > 0 && upperCaves > 0);
});

test("real Nether separates its natural roof and lava sea from the 256-block build volume", {
  timeout: 30000, // Real dimension generation and bounded habitat probes.
}, () => {
  const generator = nativeTerrain("v4-nether-habitats", "nether");
  const chunk = generator.generateChunk(0, 0);
  assert.equal(generator.seaLevel, null);
  assert.equal(chunk.maxY, 256);
  assert.ok(
    chunk.blocks.subarray(127 * 256, 128 * 256).every((id) => id === B.BEDROCK)
  );
  assert.ok(chunk.blocks.subarray(128 * 256).every((id) => id === B.AIR));
  const sea = findNaturalColumn(
    generator,
    (col) => col.top < 28,
    "Nether lava channel",
    { radius: 512, step: 32 }
  );
  const channel = generator.generateRegion(sea.x, sea.z, 1, 1);
  assert.equal(readV4RegionCell(channel, sea.x, 31, sea.z).id, B.LAVA);
  assert.equal(
    readV4RegionCell(channel, sea.x, 31, sea.z).fluid,
    FLUID.LAVA_SOURCE
  );
  assert.equal(readV4RegionCell(channel, sea.x, 32, sea.z).id, B.AIR);
  const habitats = new Set();
  for (const col of naturalColumns(generator, { radius: 1536, step: 96 }))
    habitats.add(col.id);
  for (const id of [
    "nether_wastes",
    "soul_sand_valley",
    "crimson_forest",
    "warped_forest",
    "basalt_deltas",
  ])
    assert.ok(habitats.has(id), id);
  const region = generator.generateRegion(-32, -32, 64, 64);
  const materials = new Set(region.blocks);
  for (const id of [B.NETHER_QUARTZ_ORE, B.NETHER_GOLD_ORE, B.ANCIENT_DEBRIS])
    assert.ok(materials.has(id), `natural Nether material ${id}`);
  assert.ok(generator.getSpawn().y > 32);
});

test("real End has a dry central island, an actual void gap and useful high outer islands", {
  timeout: 30000, // Real central/outer island samples and generated cells.
}, () => {
  const generator = nativeTerrain("v4-end-habitats", "end");
  assert.equal(generator.seaLevel, null);
  assert.equal(generator.surfaceYAt(300, 0), null);
  assert.equal(generator.sampleColumn(300, 0).top, null);
  const gap = generator.generateRegion(296, -4, 8, 8);
  assert.ok(gap.blocks.every((id) => id === B.AIR));
  const spawn = generator.getSpawn();
  const center = generator.generateRegion(
    Math.floor(spawn.x),
    Math.floor(spawn.z),
    1,
    1
  );
  assert.equal(
    readV4RegionCell(
      center,
      Math.floor(spawn.x),
      Math.floor(spawn.y) - 1,
      Math.floor(spawn.z)
    ).id,
    B.END_STONE
  );
  const outer = findNaturalColumn(
    generator,
    (col) => col.id === "end_highlands" && col.top > 100,
    "high End island"
  );
  const region = generator.generateRegion(outer.x - 16, outer.z - 16, 32, 32);
  assert.ok(region.blocks.includes(B.CHORUS));
  assert.ok(
    !region.blocks.includes(B.WATER) && !region.blocks.includes(B.LAVA)
  );
  assert.ok(
    !region.blocks.includes(B.BEDROCK),
    "islands float over void, not a universal bottom layer"
  );
  for (let z = region.minZ; z < region.minZ + region.depth; z++)
    for (let x = region.minX; x < region.minX + region.width; x++) {
      const col = generator.sampleColumn(x, z);
      if (col.top === null) continue;
      assert.equal(readV4RegionCell(region, x, col.bottom - 1, z).id, B.AIR);
      assert.equal(readV4RegionCell(region, x, col.top, z).id, B.END_STONE);
    }
});
