import assert from "node:assert/strict";
import test from "node:test";
import { defaultFluidFor, FLUID, isValidCell } from "../src/block-state.js";
import { BLOCK as B, BLOCKS } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import { V4_CORAL_FAMILIES } from "../src/terrain-v4-content.js";
import { readV4RegionCell } from "../src/terrain-v4-writer.js";
import {
  findMarineFeature,
  findNaturalColumn,
  forEachRegionCell,
  naturalColumns,
} from "./terrain-v4-helpers.js";

const nativeTerrain = (seed) => createGenerator(seed, "overworld", 4);

function assertNativeFluidPlanes(region) {
  // Canonical structures may allocate a waterlogged-shape plane in a marine
  // region. Every pre-existing water/plant source must survive that allocation.
  for (const section of region.sections ?? []) {
    if (!section.fluids) continue;
    for (let local = 0; local < 4096; local++) {
      const x = section.cx * 16 + (local % 16);
      const z = section.cz * 16 + (Math.floor(local / 16) % 16);
      const y = section.sy * 16 + Math.floor(local / 256);
      const cell = readV4RegionCell(region, x, y, z);
      if (!cell) continue;
      assert.ok(isValidCell(cell), `native fluid cell at ${x},${y},${z}`);
      if (cell.fluid !== defaultFluidFor(cell.id)) {
        assert.equal(cell.fluid, FLUID.WATER_SOURCE);
        assert.equal(BLOCKS[cell.id].waterloggable, true);
      }
      if ([B.WATER, B.KELP, B.SEAGRASS].includes(cell.id))
        assert.equal(cell.fluid, FLUID.WATER_SOURCE);
    }
  }
}

test("real continental fields contain shores, shelves, deep basins, limited trenches and taller land", {
  timeout: 30000, // Distribution over three real seeded regional fields, not a unit fixture.
}, () => {
  const count = {
    ocean: 0,
    shelf: 0,
    basin: 0,
    abyss: 0,
    trench: 0,
    beach: 0,
    cliff: 0,
    highland: 0,
  };
  const beds = new Set();
  const landBiomes = new Set();
  let minusOne = null;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const seed of ["v4-continents", "v4-ocean-basins", "cedar-valley"]) {
    const generator = nativeTerrain(seed);
    for (const col of naturalColumns(generator)) {
      minimum = Math.min(minimum, col.top);
      maximum = Math.max(maximum, col.top);
      if (col.depth > 0 && col.continental < 0.44) {
        count.ocean++;
        beds.add(col.surface);
        if (col.depth >= 3 && col.depth <= 24) count.shelf++;
        if (col.depth >= 48) count.basin++;
        if (col.depth >= 80) count.abyss++;
        if (col.trench > 0.05) count.trench++;
      } else if (col.depth === 0) landBiomes.add(col.id);
      if (["beach", "snowy_beach"].includes(col.id)) count.beach++;
      if (col.id === "stony_shore") count.cliff++;
      if (col.top >= 128) count.highland++;
      if (!minusOne && col.top === -1) minusOne = { seed, x: col.x, z: col.z };
    }
    assert.equal(generator.counters.chunkGenerations, 0);
    assert.equal(generator.counters.regionGenerations, 0);
    assert.equal(generator.counters.caveColumns, 0);
  }
  const diagnostic = JSON.stringify({
    ...count,
    minimum,
    maximum,
    landBiomes: landBiomes.size,
  });
  assert.ok(count.ocean > 300 && count.shelf > 100, diagnostic);
  assert.ok(count.basin > 100 && count.abyss > 5, diagnostic);
  assert.ok(count.trench > 0 && count.trench < count.ocean * 0.04, diagnostic);
  assert.ok(
    count.beach > 15 && count.cliff > 5 && count.highland > 25,
    diagnostic
  );
  assert.ok(minimum < 0 && maximum > 150 && landBiomes.size >= 25, diagnostic);
  for (const id of [B.SAND, B.GRAVEL, B.CLAY, B.DEEPSLATE])
    assert.ok(
      beds.has(id),
      `missing real seabed material ${id}: ${diagnostic}`
    );
  assert.ok(
    minusOne,
    "the negative-Y field must include actual terrain at Y=-1"
  );
  const generator = nativeTerrain(minusOne.seed);
  assert.equal(generator.surfaceYAt(minusOne.x, minusOne.z), -1);
  assert.equal(generator.terrainHeight(minusOne.x, minusOne.z), -1);
  const region = generator.generateRegion(minusOne.x, minusOne.z, 1, 1);
  assert.notEqual(
    readV4RegionCell(region, minusOne.x, -1, minusOne.z).id,
    B.AIR
  );
});

test("a real deep basin contains source water through a genuinely negative-Y seabed", {
  timeout: 30000, // Locate and generate an actual deep-ocean column.
}, () => {
  const generator = nativeTerrain("v4-ocean-basins");
  const col = findNaturalColumn(
    generator,
    (entry) =>
      entry.depth >= 82 && entry.temperature > 0.3 && entry.temperature < 0.78,
    "deep unfrozen basin"
  );
  const region = generator.generateRegion(col.x, col.z, 1, 1);
  assert.ok(col.top < -16);
  assert.equal(region.minY, -64);
  assert.equal(readV4RegionCell(region, col.x, -64, col.z).id, B.BEDROCK);
  for (let y = col.top + 1; y <= 63; y++) {
    const cell = readV4RegionCell(region, col.x, y, col.z);
    assert.equal(cell.id, B.WATER);
    assert.equal(cell.fluid, FLUID.WATER_SOURCE);
  }
  assert.equal(readV4RegionCell(region, col.x, 64, col.z).id, B.AIR);
  assertNativeFluidPlanes(region);
});

test("real warm reefs form connected colonies with all five families and source-water fans", {
  timeout: 30000, // Real reef ownership scan plus native full-height region generation.
}, () => {
  const generator = nativeTerrain("v4-coral-gardens");
  const feature = findMarineFeature(generator, "reef");
  const region = generator.generateRegion(
    feature.x - 12,
    feature.z - 12,
    25,
    25
  );
  const coralBlocks = new Set(
    V4_CORAL_FAMILIES.map((family) => B[`${family}_CORAL_BLOCK`])
  );
  const accents = new Set(
    V4_CORAL_FAMILIES.flatMap((family) => [
      B[`${family}_CORAL`],
      B[`${family}_CORAL_FAN`],
    ])
  );
  const seen = new Set();
  let colonyCells = 0;
  let connected = 0;
  let fanCells = 0;
  forEachRegionCell(region, (id, x, y, z) => {
    if (id === B.KELP)
      assert.ok(
        generator.sampleColumn(x, z).temperature < 0.8,
        "no tropical kelp"
      );
    if (!coralBlocks.has(id) && !accents.has(id)) return;
    seen.add(id);
    const col = generator.sampleColumn(x, z);
    assert.equal(col.id, "warm_ocean");
    assert.ok(col.temperature >= 0.8 && y <= 62 && y > col.top);
    const cell = readV4RegionCell(region, x, y, z);
    assert.equal(
      cell.fluid,
      coralBlocks.has(id) ? FLUID.NONE : FLUID.WATER_SOURCE
    );
    if (coralBlocks.has(id)) {
      colonyCells++;
      if (
        [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ].some(([dx, dy, dz]) =>
          coralBlocks.has(readV4RegionCell(region, x + dx, y + dy, z + dz)?.id)
        )
      )
        connected++;
    } else fanCells++;
  });
  assert.ok(colonyCells > 40 && connected > colonyCells * 0.9);
  assert.ok(fanCells > 10);
  for (const family of V4_CORAL_FAMILIES) {
    assert.ok(seen.has(B[`${family}_CORAL_BLOCK`]), family);
    assert.ok(seen.has(B[`${family}_CORAL_FAN`]), `${family} floor fans`);
    assert.ok(seen.has(B[`${family}_CORAL`]), `${family} coral plants`);
  }
  assertNativeFluidPlanes(region);
});

test("real cool/lukewarm shelves support varied kelp heights and seagrass without tropical coral", {
  timeout: 30000, // Probe bounded natural sites until a generated kelp forest is found.
}, () => {
  const generator = nativeTerrain("v4-kelp-forests");
  let inspected = 0;
  let result = null;
  const coralIds = new Set(
    V4_CORAL_FAMILIES.flatMap((family) => [
      B[`${family}_CORAL_BLOCK`],
      B[`${family}_CORAL`],
      B[`${family}_CORAL_FAN`],
    ])
  );
  for (const col of naturalColumns(generator)) {
    if (
      col.depth < 16 ||
      col.depth > 46 ||
      col.temperature < 0.28 ||
      col.temperature >= 0.76 ||
      !col.id.includes("ocean")
    )
      continue;
    const region = generator.generateRegion(col.x - 8, col.z - 8, 16, 16);
    const lengths = new Map();
    let grass = 0;
    forEachRegionCell(region, (id, x, y, z) => {
      assert.equal(coralIds.has(id), false);
      if (id === B.SEAGRASS) grass++;
      if (id === B.KELP || id === B.SEAGRASS) {
        const sample = generator.sampleColumn(x, z);
        assert.ok(sample.temperature >= 0.23 && y < 63);
        assert.equal(defaultFluidFor(id), FLUID.WATER_SOURCE);
        assert.equal(
          readV4RegionCell(region, x, y, z).fluid,
          FLUID.WATER_SOURCE
        );
      }
      if (id === B.KELP) {
        const key = `${x},${z}`;
        lengths.set(key, (lengths.get(key) ?? 0) + 1);
      }
    });
    if (lengths.size >= 8 && new Set(lengths.values()).size >= 3 && grass > 0) {
      result = region;
      break;
    }
    if (++inspected >= 16) break;
  }
  assert.ok(
    result,
    "a real seeded shelf should contain both kelp and seagrass"
  );
  assertNativeFluidPlanes(result);
});

test("real frozen seas have deep iceberg keels, protruding ice and no warm aquatic plants", {
  timeout: 30000, // Locate and generate a native iceberg.
}, () => {
  const generator = nativeTerrain("v4-frozen-seas");
  const feature = findMarineFeature(generator, "iceberg");
  const region = generator.generateRegion(
    feature.x - 10,
    feature.z - 9,
    21,
    19
  );
  const coralIds = new Set(
    V4_CORAL_FAMILIES.flatMap((family) => [
      B[`${family}_CORAL_BLOCK`],
      B[`${family}_CORAL`],
      B[`${family}_CORAL_FAN`],
    ])
  );
  let keel = 0;
  let peak = 0;
  let surfaceIce = 0;
  forEachRegionCell(region, (id, x, y, z) => {
    assert.equal(coralIds.has(id), false);
    if (id === B.KELP || id === B.SEAGRASS)
      assert.ok(
        generator.sampleColumn(x, z).temperature >= 0.23,
        "no plants in frozen water"
      );
    if (id === B.BLUE_ICE && y < 58) keel++;
    if ([B.PACKED_ICE, B.SNOW_BLOCK].includes(id) && y > 67) peak++;
    if (id === B.ICE && y === 63) surfaceIce++;
    if ([B.BLUE_ICE, B.PACKED_ICE].includes(id))
      assert.ok(generator.sampleColumn(x, z).temperature < 0.23);
  });
  assert.ok(keel > 0 && peak > 0 && surfaceIce > 0);
});
