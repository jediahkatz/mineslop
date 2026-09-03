import assert from "node:assert/strict";
import test from "node:test";
import { BIOMES } from "../src/biomes.js";
import { BLOCK as B, isSolid } from "../src/blocks.js";
import { createGenerator, WATER_LEVEL } from "../src/terrain.js";

function assertRealDestination(generator, biome, destination) {
  assert.ok(destination, `${biome.id} must have a natural sample`);
  assert.equal(destination.dimension, biome.dimension);
  const { x, y, z } = destination;
  assert.ok([x, y, z].every(Number.isFinite));
  assert.equal(
    generator.getBiome(x, z, y).id,
    biome.id,
    `${biome.id}: exact destination biome`
  );
  const cx = Math.floor(x / 16),
    cz = Math.floor(z / 16);
  const chunk = generator.generateChunk(cx, cz);
  const column = (Math.floor(z) - cz * 16) * 16 + Math.floor(x) - cx * 16;
  const at = (height) => chunk.blocks[height * 256 + column];
  const feet = Math.floor(y);
  assert.equal(isSolid(at(feet)), false, `${biome.id}: feet clearance`);
  assert.equal(isSolid(at(feet + 1)), false, `${biome.id}: head clearance`);
  if (biome.category === "cave") {
    assert.equal(at(feet), B.AIR);
    assert.equal(at(feet + 1), B.AIR);
    assert.ok(isSolid(at(feet - 1)), `${biome.id}: real cave floor`);
    assert.ok(feet < generator.terrainHeight(x, z) - 4);
  } else if (biome.category !== "void") {
    assert.ok(
      isSolid(at(feet - 1)) ||
        (feet === WATER_LEVEL + 1 && at(feet - 1) === B.WATER),
      `${biome.id}: destination must stand or swim, not float`
    );
  }
}

for (const seed of ["cedar-valley", "birch-river", "123", ""]) {
  test(`every registry biome is naturally locatable for seed ${JSON.stringify(seed)}`, () => {
    const generators = new Map(
      ["overworld", "nether", "end"].map((dimension) => [
        dimension,
        createGenerator(seed, dimension),
      ])
    );
    for (const biome of BIOMES) {
      const generator = generators.get(biome.dimension);
      assertRealDestination(generator, biome, generator.locateBiome(biome.id));
      assert.ok(
        generator.locatorSamples <= 73 * 73 * 9,
        "Search must stay within its fixed sample budget"
      );
    }
  });
}

test("locator results are independent of previous atlas requests or generated chunks", () => {
  const forward = createGenerator("cedar-valley");
  const backward = createGenerator("cedar-valley");
  const expected = new Map();
  const catalog = BIOMES.filter((biome) => biome.dimension === "overworld");
  for (const biome of catalog)
    expected.set(biome.id, forward.locateBiome(biome.id));
  for (const biome of [...catalog].reverse()) {
    backward.generateChunk(-200, 30);
    assert.deepEqual(
      backward.locateBiome(biome.id),
      expected.get(biome.id),
      biome.id
    );
  }
});

test("locating biomes neither forces a biome nor modifies future terrain", () => {
  const generator = createGenerator("cedar-valley");
  const before = generator.generateChunk(-34, 63);
  const point = generator.locateBiome("mangrove_swamp");
  const untouched = createGenerator("cedar-valley");
  assert.equal(
    untouched.getBiome(point.x, point.z, point.y).id,
    "mangrove_swamp"
  );
  assert.deepEqual(generator.generateChunk(-34, 63), before);
  const cx = Math.floor(point.x / 16),
    cz = Math.floor(point.z / 16);
  assert.deepEqual(
    generator.generateChunk(cx, cz),
    untouched.generateChunk(cx, cz)
  );
});

test("locator handles distant origins, dimensions and malformed inputs", () => {
  const generator = createGenerator("far-traveler");
  const point = generator.locateBiome("desert", { x: 123456, z: -654321 });
  assert.ok(point);
  assert.equal(generator.getBiome(point.x, point.z, point.y).id, "desert");
  assert.ok(
    Math.abs(point.x - 123456) < 9000 && Math.abs(point.z + 654321) < 9000
  );
  const netherPoint = generator.locateBiome("warped_forest");
  assert.equal(netherPoint.dimension, "nether");
  assert.equal(
    createGenerator("far-traveler", "nether").getBiome(
      netherPoint.x,
      netherPoint.z,
      netherPoint.y
    ).id,
    "warped_forest"
  );
  for (const from of [
    null,
    {},
    { x: NaN, z: 0 },
    { x: Infinity, z: 0 },
    { x: 30000000, z: 0 },
  ])
    assert.equal(generator.locateBiome("forest", from), null);
  assert.equal(generator.locateBiome("missing_biome"), null);
  const cached = generator.locateBiome("desert", { x: 123456, z: -654321 });
  cached.x = 0;
  assert.deepEqual(
    generator.locateBiome("desert", { x: 123456, z: -654321 }),
    point
  );
});
