import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID as F } from "../src/block-state.js";
import { FLUID_LIMITS, MAX_FLUID_PLAN_READS } from "../src/fluid-constants.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { World } from "../src/world.js";
import { kelpTimer } from "./fluid-kelp-fixture.js";
import { aimAt, kelpGame, serviceTo } from "./kelp-game-fixture.js";
import { findNaturalColumn } from "./terrain-v4-helpers.js";

// Predeclared native acceptance, NOT an authored habitat or performance/GUI test.
// One seed/version; <=9,409 coarse sampleColumn probes. Admit exactly ONE 3x3
// production ensureArea footprint at the first cool/temperate shelf. Within its
// center column inspect <=16*16*62 cells, choosing the FIRST 2–24-high native
// kelp with source water above. No retry of another area after any failure.
const SEED = "cedar-valley";
const RADIUS = 1;

function firstPlant(world, column) {
  const cx = Math.floor(column.x / 16), cz = Math.floor(column.z / 16);
  let reads = 0;
  const get = (x, y, z) => {
    assert.ok(++reads <= 16 * 16 * 62 + 16 * 16 * 26);
    return world.getCell(x, y, z);
  };
  for (let z = cz * 16; z < cz * 16 + 16; z++)
    for (let x = cx * 16; x < cx * 16 + 16; x++) {
      let height = 0, root = null;
      for (let y = world.spec.seaLevel - 62; y < world.spec.seaLevel; y++) {
        const cell = get(x, y, z);
        if (cell.id !== BLOCK.KELP) {
          height = 0;
          root = null;
          continue;
        }
        root ??= { x, y, z };
        height++;
        if (height < 2 || height > 24) continue;
        const above = get(x, y + 1, z);
        if (above.id === BLOCK.WATER && above.fluid === F.WATER_SOURCE)
          return { root, tip: { x, y, z }, height, reads };
      }
    }
  assert.fail("The first declared native shelf must contain a qualifying kelp; no fallback area is allowed");
}

for (const generatorVersion of [4, 5, 6, 7]) {
  test(`native v${generatorVersion}: harvest/collect, natural surplus, finite replant and cold renewal on production admissions`, async (t) => {
    const world = new World(SEED, { generatorVersion, useWorker: false });
    t.after(() => world.dispose());
    const column = findNaturalColumn(world.generator, (col) =>
      /(^|_)ocean$/.test(col.id) && !col.frozen &&
      col.temperature >= 0.23 && col.temperature < 0.8 &&
      col.waterLevel === world.spec.seaLevel && col.depth >= 8 && col.depth <= 35,
    "declared kelp shelf", { radius: 6144, step: 128 });
    const beforeAdmission = world.generator.counters;
    await world.ensureArea({ x: column.x + 8, z: column.z + 8 }, RADIUS);
    assert.equal(world.chunks.size, 9);
    assert.equal(world.generator.counters.chunkGenerations - beforeAdmission.chunkGenerations, 9);
    assert.equal(world._pins.size, 0);
    const plant = firstPlant(world, column);
    const { tip, root } = plant;
    const stem = { ...tip, y: tip.y - 1 };
    const feet = { x: tip.x + 0.5, y: tip.y - 0.5, z: tip.z + 0.5 };
    assert.equal(world.serialize().edits.length, 0, "acquisition starts in real native cells");
    assert.ok(root.y >= world.spec.minY && tip.y < world.spec.seaLevel);
    const f = kelpGame(t, world);
    const generations = world.generator.counters;
    t.mock.method(world.generator, "generateChunk", () => assert.fail("active kelp cannot generate chunks"));
    const peak = { proposals: 0, scanCells: 0, queued: 0 };
    const update = f.fluid.fluids.update.bind(f.fluid.fluids);
    t.mock.method(f.fluid.fluids, "update", (dt) => {
      const result = update(dt), d = f.fluid.fluids.diagnostics(), s = d.last;
      assert.ok(s.ticks <= 4);
      assert.ok(s.evaluated <= s.ticks * 96);
      assert.ok(s.scanCells <= 256);
      assert.ok(s.reads <= s.evaluated * MAX_FLUID_PLAN_READS + s.scanCells * 7);
      assert.ok(d.queued <= 4096);
      assert.deepEqual(d.limits, FLUID_LIMITS);
      peak.proposals = Math.max(peak.proposals, s.evaluated);
      peak.scanCells = Math.max(peak.scanCells, s.scanCells);
      peak.queued = Math.max(peak.queued, d.queued);
      return result;
    });
    f.harvest(tip);
    f.collect(feet);
    assert.equal(f.gameplay.count(BLOCK.KELP), 1);
    assert.equal(world.getFluid(tip.x, tip.y, tip.z), F.WATER_SOURCE);
    assert.equal(f.fluid.frame(0.25, { simulating: true }).ok, true);
    const timer = kelpTimer(f.fluid.fluids, stem.x, stem.y, stem.z);
    assert.ok(timer);
    serviceTo(f.fluid, timer[4] - 1);
    assert.equal(world.get(tip.x, tip.y, tip.z), BLOCK.WATER);
    serviceTo(f.fluid, timer[4]);
    assert.equal(world.get(tip.x, tip.y, tip.z), BLOCK.KELP);
    f.harvest(tip);
    f.collect(feet);
    assert.equal(f.gameplay.count(BLOCK.KELP), 2, "an actual collected surplus, not catalogue availability");

    // Swim directly above the retained stem and use its real physical top face.
    const clicked = aimAt(f,
      { x: tip.x + 0.5, y: tip.y, z: tip.z + 0.5 },
      { x: tip.x + 0.5, y: tip.y + 0.1, z: tip.z + 0.5 });
    assert.deepEqual([clicked.x, clicked.y, clicked.z, clicked.normal.y],
      [stem.x, stem.y, stem.z, 1]);
    assert.equal(f.game.useActions.place("main", BLOCK.KELP), true);
    assert.equal(f.gameplay.count(BLOCK.KELP), 1, "exactly one finite item pays for placement");
    f.harvest(tip);
    f.collect(feet);
    assert.equal(f.gameplay.count(BLOCK.KELP), 2);
    f.fluid.frame(0.25, { simulating: true });
    const next = kelpTimer(f.fluid.fluids, stem.x, stem.y, stem.z);
    assert.ok(next);
    serviceTo(f.fluid, next[4] - 300);
    const archive = exportWorldFile(f.snapshot());
    const saved = normalizeWorldComponents(parseWorldFile(archive));
    if (process.env.KELP_NATIVE_FIXTURE_DIR) {
      const directory = process.env.KELP_NATIVE_FIXTURE_DIR;
      assert.ok(directory.startsWith("/tmp/"), "optional GUI stages go only to a disposable fixture directory");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `native-kelp-v${generatorVersion}-75s.voxelcraft.json`),
        archive, { flag: "wx" });
    }

    const cold = new World(SEED, { generatorVersion, useWorker: false });
    t.after(() => cold.dispose());
    assert.equal(cold.loadEdits(saved.world), true);
    await cold.ensureArea({ x: column.x + 8, z: column.z + 8 }, RADIUS);
    assert.equal(cold.chunks.size, 9);
    const b = kelpGame(t, cold, { saved });
    assert.deepEqual(cold.serialize(), world.serialize());
    assert.deepEqual(b.gameplay.serialize(), f.gameplay.serialize());
    assert.deepEqual(b.pickups.serialize(), f.pickups.serialize());
    assert.deepEqual(kelpTimer(b.fluid.fluids, stem.x, stem.y, stem.z), next);
    const coldGenerations = cold.generator.counters;
    t.mock.method(cold.generator, "generateChunk", () => assert.fail("cold renewal cannot generate on read"));
    serviceTo(b.fluid, next[4] - 1);
    assert.equal(cold.get(tip.x, tip.y, tip.z), BLOCK.WATER);
    serviceTo(b.fluid, next[4]);
    assert.equal(cold.get(tip.x, tip.y, tip.z), BLOCK.KELP);
    b.harvest(tip);
    b.collect(feet);
    assert.equal(b.gameplay.count(BLOCK.KELP), 3);
    assert.equal(cold.get(root.x, root.y, root.z), BLOCK.KELP);
    assert.equal(world.generator.counters.chunkGenerations, generations.chunkGenerations);
    assert.equal(world.generator.counters.regionGenerations, generations.regionGenerations);
    assert.equal(cold.generator.counters.chunkGenerations, coldGenerations.chunkGenerations);
    assert.equal(cold.generator.counters.regionGenerations, coldGenerations.regionGenerations);
    t.diagnostic(JSON.stringify({
      nativeKelp: { seed: SEED, generatorVersion, root, tip, height: plant.height },
      admitted: 9, coldAdmitted: 9, nativeDiscoveryReads: plant.reads,
      collected: 3, naturalRenewals: 2, finitePlacementCost: 1,
      clocks: [timer[4], next[4]], peak,
      acceptance: "CPU ownership/renewal only; GUI and performance remain parent gates",
    }));
  });
}
