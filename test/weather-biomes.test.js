import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BIOME_INDEX } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { World } from "../src/world.js";
import { WeatherRender } from "../src/weather-render.js";

test("admitted biome lookup adds zero generator work even after column-cache eviction", async () => {
  const world = new World("weather-biome-budget", { generatorVersion: 4, useWorker: false });
  const render = new WeatherRender(new THREE.Scene());
  try {
    await world.ensureArea({ x: 8, z: 8 }, 0);
    const camera = { x: 8, y: 330, z: 8 };
    for (let i = 0; i < 6; i++) render.update(world, camera, { elapsed: i, intensity: 1 });
    // Other systems can evict surface cache entries without evicting residents.
    for (let i = 0; i < 8300; i++) world.generator.sampleColumn(10000 + i * 2, 10000);
    const before = world.generator.counters;
    render.update(world, camera, { elapsed: 10, intensity: 1 });
    const after = world.generator.counters;
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    console.log("weather admitted-biome generator delta", JSON.stringify(delta));
    assert.equal(delta.surfaceQueries, 0);
    assert.equal(delta.surfaceSamples, 0);
    assert.equal(delta.voxelVisits, 0);
    assert.equal(delta.chunkGenerations, 0);
    assert.equal(delta.regionGenerations, 0);
  } finally { render.dispose(); world.dispose(); }
});

function mixedGenerator() {
  return {
    getSpawn: () => ({ x: 8, y: 1, z: 8 }),
    getBiome() { throw new Error("Weather must not query generated biomes"); },
    generateChunk(cx, cz) {
      const blocks = new Uint16Array(16 * 16 * 384);
      const biomes = new Uint8Array(256);
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        blocks[64 * 256 + z * 16 + x] = BLOCK.STONE;
        const wx = cx * 16 + x;
        biomes[z * 16 + x] = BIOME_INDEX[wx < 6 ? "plains" : wx < 10 ? "desert" : "snowy_plains"];
      }
      return { cx, cz, minY: -64, maxY: 320, blocks, biomes };
    },
  };
}

test("adjacent admitted rainy/dry/cold columns stay distinct without generated biome fallback", async () => {
  const world = new World("mixed-weather", {
    generatorVersion: 4, useWorker: false, generatorFactory: mixedGenerator,
  });
  const render = new WeatherRender(new THREE.Scene());
  try {
    await world.ensureArea({ x: 8, z: 8 }, 0);
    const camera = { x: 8, y: 10, z: 8 };
    for (let i = 0; i < 5; i++) {
      const audio = render.update(world, camera, { elapsed: i, intensity: 1 });
      assert.equal(audio.level, 0, "camera stands in dry biome");
      assert.ok(render.exposure.reads <= 2048);
    }
    assert.equal(render.object.geometry.drawRange.count / 16, 10, "two rainy x-columns, five z-columns");
    const positions = render.positions;
    for (let i = 0; i < render.object.geometry.drawRange.count / 2; i++)
      assert.ok(positions[i * 6] + render.object.position.x < 6);
    const chunk = world.chunks.get("0,0");
    const biomes = chunk.biomes;
    chunk.biomes = undefined;
    render.update(world, camera, { elapsed: 6, intensity: 1 });
    assert.equal(render.object.visible, false, "missing admitted biome plane is unknown");
    assert.equal(render.exposure.reads, 0);
    chunk.biomes = biomes;
    world.chunks.delete("0,0");
    render.update(world, camera, { elapsed: 7, intensity: 1 });
    assert.equal(render.object.visible, false, "evicted columns never query a generator");
  } finally { render.dispose(); world.dispose(); }
});
