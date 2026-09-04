import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/world.js";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { WeatherExposure, WEATHER_READ_BUDGET } from "../src/weather-exposure.js";

const columns = Array.from({ length: 64 }, (_, i) => ({
  x: i % 8, z: Math.floor(i / 8),
}));

test("real committed unrelated block/fluid churn cannot starve roof columns", async () => {
  const world = new World("weather-churn-native-v4", {
    generatorVersion: 4, useWorker: false,
  });
  const summaries = [];
  try {
    await world.ensureArea({ x: 0, z: 0 }, 0);
    const target = { x: 15, y: world.maxY - 2, z: 15 };
    const getCell = world.getCell.bind(world);
    let cellReads = 0;
    world.getCell = (...args) => { cellReads++; return getCell(...args); };
    world.get = () => assert.fail("weather must not use air-returning World.get");
    for (const mode of ["quiet", "block", "fluid"]) {
      world.onMutation = undefined;
      if (mode === "fluid") assert.equal(world.set(target.x, target.y, target.z, BLOCK.WATER), true);
      const exposure = new WeatherExposure();
      let frame = -1, notifications = 0;
      world.onMutation = (event) => {
        notifications++;
        assert.equal(event.epoch, world.epoch);
        assert.equal(event.dimension, world.dimension);
        assert.ok(Object.isFrozen(event));
        for (const change of event.changes)
          assert.deepEqual(getCell(change.x, change.y, change.z), change.after);
        // Forwarding belongs to the test only; no host integration is implied.
        assert.equal(exposure.onMutation(world, event), frame === 0 ? false : true);
      };
      const frames = [];
      for (frame = 0; frame < 24; frame++) {
        if (mode !== "quiet") {
          const before = world.getCell(target.x, target.y, target.z);
          const after = mode === "block"
            ? { id: frame % 2 ? BLOCK.STONE : BLOCK.GLASS, state: 0, fluid: 0 }
            : { id: BLOCK.WATER, state: 0, fluid: frame % 2 ? FLUID.WATER_2 : FLUID.WATER_1 };
          assert.equal(world.applyCells([{ ...target, before, after }]), true);
        }
        const revision = world._editRevision;
        const residents = world.chunks.size;
        const beforeReads = cellReads;
        exposure.beginFrame(world);
        const roofs = columns.map(({ x, z }) => exposure.roof(x, z));
        const measuredReads = cellReads - beforeReads;
        const known = roofs.filter((roof) => roof.known).length;
        // Same geometric visibility gate as rain, with camera at the build ceiling.
        const visible = roofs.filter((roof) => roof.known &&
          world.maxY + 10 - Math.max(world.maxY - 8, roof.y + 1) >= 1).length;
        const result = { mode, frame, known, visible, reads: exposure.reads };
        frames.push(result);
        assert.ok(measuredReads <= WEATHER_READ_BUDGET);
        assert.equal(measuredReads, exposure.reads);
        assert.ok(exposure.cache.size <= 64);
        assert.equal(world._editRevision, revision, "weather must not write terrain");
        assert.equal(world.chunks.size, residents, "weather must not load terrain");
      }
      assert.equal(notifications, mode === "quiet" ? 0 : 24);
      const summary = { mode, firstKnown: frames[0].known, finalKnown: frames.at(-1).known, finalVisible: frames.at(-1).visible, firstCompleteFrame: frames.findIndex((entry) => entry.known === 64), totalReads: frames.reduce((sum, entry) => sum + entry.reads, 0), finalReads: frames.at(-1).reads, notifications };
      summaries.push(summary);
    }
    console.log(JSON.stringify(summaries));
    // Assert only after measuring all scenarios, including the expected baseline failures.
    for (const summary of summaries)
      assert.equal(summary.finalKnown, 64, `${summary.mode}: later columns must converge under continued commits`);
  } finally {
    world.dispose();
  }
});
