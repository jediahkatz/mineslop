import assert from "node:assert/strict";
import test from "node:test";
import { BIOME_INDEX, getBiomeById } from "../src/biomes.js";
import { BLOCK as B, BLOCKS, isSolid } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import { sulfurPocket } from "../src/terrain-profiles.js";

const sulfurBlocks = new Set([
  B.SULFUR,
  B.CINNABAR,
  B.POTENT_SULFUR,
  B.SULFUR_SPIKE,
]);

for (const seed of ["cedar-valley", "birch-river", "123", ""]) {
  test(`sulfur caves have real bands, pools, potent sulfur and spikes: ${JSON.stringify(seed)}`, () => {
    const generator = createGenerator(seed);
    const point = generator.locateBiome("sulfur_caves");
    assert.ok(point);
    assert.equal(
      generator.getBiome(point.x, point.z, point.y).id,
      "sulfur_caves"
    );
    assert.ok(generator.terrainHeight(point.x, point.z) <= 42);
    const minX = Math.floor(point.x) - 24;
    const minZ = Math.floor(point.z) - 24;
    const { blocks } = generator.generateRegion(minX, minZ, 48, 48);
    const layer = 48 * 48;
    const counts = new Uint32Array(BLOCKS.length);
    const bands = new Uint8Array(layer);
    let poolFoundations = 0;
    let floorSpikes = 0;
    let ceilingSpikes = 0;
    for (let y = 1; y < 95; y++)
      for (let z = 0; z < 48; z++)
        for (let x = 0; x < 48; x++) {
          const index = z * 48 + x;
          const at = y * layer + index;
          const id = blocks[at];
          counts[id]++;
          if (id === B.SULFUR) bands[index] |= 1;
          if (id === B.CINNABAR) bands[index] |= 2;
          if (sulfurBlocks.has(id)) {
            assert.ok(y < generator.terrainHeight(minX + x, minZ + z) - 3);
            assert.equal(
              generator.getBiome(minX + x, minZ + z, y).id,
              "sulfur_caves"
            );
          }
          if (id === B.POTENT_SULFUR) {
            assert.equal(blocks[at + layer], B.WATER);
            assert.equal(blocks[at + layer * 2], B.WATER);
            assert.equal(
              generator.getBiome(minX + x, minZ + z, y + 2).waterColor,
              "#98b94a"
            );
            poolFoundations++;
          }
          if (id === B.SULFUR_SPIKE) {
            if (blocks[at - layer] === B.SULFUR) floorSpikes++;
            if (blocks[at + layer] === B.SULFUR) ceilingSpikes++;
          }
        }
    for (const id of [B.SULFUR, B.CINNABAR, B.POTENT_SULFUR, B.SULFUR_SPIKE])
      assert.ok(counts[id] > 0, BLOCKS[id].name);
    assert.ok(
      bands.some((mask) => mask === 3),
      "Mineral bands share actual vertical columns"
    );
    assert.ok(poolFoundations > 3);
    assert.ok(floorSpikes > 0 && ceilingSpikes > 0);
    assert.ok(counts[B.SULFUR_SPIKE] > 4);
    const feet = Math.floor(point.y);
    const at = feet * layer + 24 * 48 + 24;
    assert.ok(isSolid(blocks[at - layer]));
    assert.equal(blocks[at], B.AIR);
    assert.equal(blocks[at + layer], B.AIR);
  });
}

test("sulfur cave deposits and pools match across negative chunk seams", () => {
  const generator = createGenerator("");
  const point = generator.locateBiome("sulfur_caves");
  const cx = Math.floor(point.x / 16);
  const cz = Math.floor(point.z / 16);
  const whole = generator.generateRegion((cx - 1) * 16, (cz - 1) * 16, 32, 32);
  assert.ok(whole.blocks.includes(B.POTENT_SULFUR));
  for (const [dx, dz] of [
    [1, 1],
    [0, 0],
    [1, 0],
    [0, 1],
  ]) {
    const chunk = createGenerator("").generateChunk(cx - 1 + dx, cz - 1 + dz);
    for (let y = 0; y < 96; y++)
      for (let z = 0; z < 16; z++) {
        const start = y * 256 + z * 16;
        const target = y * 1024 + (z + dz * 16) * 32 + dx * 16;
        assert.deepEqual(
          chunk.blocks.subarray(start, start + 16),
          whole.blocks.subarray(target, target + 16)
        );
      }
  }
});

test("sulfur pockets reject deep oceans, mountains, cold climates and dry regions", () => {
  const col = {
    x: 1002,
    z: -786,
    top: 32,
    temperature: 0.8,
    profile: { relief: 4 },
  };
  const field = { nearest: { moisture: 0.7 }, ocean: 0, relief: 4 };
  for (const patch of [
    { top: 18 },
    { top: 60 },
    { temperature: 0.1 },
    { profile: { relief: 16 } },
  ])
    assert.equal(sulfurPocket({ ...col, ...patch }, field, 123), null);
  for (const patch of [
    { nearest: { moisture: 0.2 } },
    { ocean: 0.9 },
    { relief: 18 },
  ])
    assert.equal(sulfurPocket(col, { ...field, ...patch }, 123), null);

  const generator = createGenerator("cedar-valley");
  for (const id of [
    "deep_ocean",
    "deep_frozen_ocean",
    "frozen_peaks",
    "stony_peaks",
  ]) {
    const point = generator.locateBiome(id);
    const x = Math.floor(point.x);
    const z = Math.floor(point.z);
    const chunk = generator.generateChunk(
      Math.floor(x / 16),
      Math.floor(z / 16)
    );
    const index = (z - chunk.cz * 16) * 16 + x - chunk.cx * 16;
    for (let y = 0; y < 96; y++)
      assert.ok(!sulfurBlocks.has(chunk.blocks[y * 256 + index]), id);
  }
});

test("the new cave appends its index and remains naturally reachable beyond legacy terrain", () => {
  assert.equal(BIOME_INDEX.sulfur_caves, 65);
  assert.equal(getBiomeById("sulfur_caves").dimension, "overworld");
  assert.equal(getBiomeById("sulfur_caves").category, "cave");
  const generator = createGenerator("cedar-valley", "overworld", 1);
  const point = generator.locateBiome("sulfur_caves");
  assert.ok(point);
  assert.ok(Math.abs(point.x) >= 80 || Math.abs(point.z) >= 80);
  assert.equal(
    generator.getBiome(point.x, point.z, point.y).id,
    "sulfur_caves"
  );
  assert.ok(
    generator
      .generateRegion(-32, -32, 64, 64)
      .blocks.every((id) => !sulfurBlocks.has(id))
  );
});
