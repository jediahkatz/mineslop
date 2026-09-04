import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { World } from "../src/world.js";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { BIOMES } from "../src/biomes.js";
import { precipitationPolicy } from "../src/weather-state.js";
import { WeatherRender, RAIN_PARTICLES } from "../src/weather-render.js";
import { WEATHER_READ_BUDGET } from "../src/weather-exposure.js";

test("native expanded-world rain converges during live benign block and fluid churn", async () => {
  const world = new World("weather-rain-2", { generatorVersion: 4, useWorker: false });
  const summaries = [];
  try {
    await world.ensureArea({ x: 8, z: 8 }, 0);
    assert.equal(world.maxY - world.minY, 384);
    const chunk = world.chunks.get("0,0");
    for (const biome of chunk.biomes)
      assert.equal(precipitationPolicy(BIOMES[biome], world.dimension), "rain");
    const camera = { x: 8, y: world.maxY + 10, z: 8 };
    const target = { x: 15, y: world.maxY - 2, z: 15 };
    const getCell = world.getCell.bind(world);
    let reads = 0;
    world.getCell = (...args) => { reads++; return getCell(...args); };
    world.getBiome = () => assert.fail("weather must not generate biomes");
    world.get = () => assert.fail("weather must not treat unavailable cells as air");
    for (const mode of ["quiet", "block", "fluid"]) {
      world.onMutation = undefined;
      if (mode === "fluid") assert.equal(world.set(target.x, target.y, target.z, BLOCK.WATER), true);
      const render = new WeatherRender(new THREE.Scene());
      const buffer = render.positions;
      world.onMutation = (event) => render.exposure.onMutation?.(world, event);
      const frames = [];
      try {
        for (let frame = 0; frame < 16; frame++) {
          if (mode !== "quiet") {
            const before = getCell(target.x, target.y, target.z);
            const after = mode === "block"
              ? { id: frame % 2 ? BLOCK.STONE : BLOCK.GLASS, state: 0, fluid: 0 }
              : { id: BLOCK.WATER, state: 0, fluid: frame % 2 ? FLUID.WATER_2 : FLUID.WATER_1 };
            assert.equal(world.applyCells([{ ...target, before, after }]), true);
          }
          const beforeReads = reads, revision = world._editRevision;
          const residents = world.chunks.size;
          const audio = render.update(world, camera, { elapsed: frame, intensity: 1 });
          const frameReads = reads - beforeReads;
          const droplets = render.object.geometry.drawRange.count / 2;
          frames.push({ frame, droplets, reads: frameReads,
            pending: [...render.exposure.cache.values()].filter((entry) => !entry.result.known).map((entry) => entry.nextY) });
          assert.equal(render.positions, buffer);
          assert.equal(render.exposure.cache.size, 25);
          assert.equal(frameReads, render.exposure.reads);
          assert.ok(frameReads <= WEATHER_READ_BUDGET);
          assert.ok(droplets <= RAIN_PARTICLES);
          assert.ok(audio.level > 0 && audio.level <= 0.35);
          assert.equal(world._editRevision, revision);
          assert.equal(world.chunks.size, residents);
        }
        summaries.push({ mode, first: frames[0], last: frames.at(-1),
          completeFrame: frames.findIndex((frame) => frame.droplets === RAIN_PARTICLES),
          totalReads: frames.reduce((sum, frame) => sum + frame.reads, 0) });
      } finally { render.dispose(); }
    }
    console.log("native rain live-churn measurements", JSON.stringify(summaries));
    for (const summary of summaries) {
      assert.equal(summary.last.droplets, RAIN_PARTICLES, `${summary.mode} must converge to all 200 droplets`);
      assert.equal(summary.last.reads, 0, `${summary.mode} must reuse verified columns`);
    }
  } finally { world.dispose(); }
});
