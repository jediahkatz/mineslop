import assert from "node:assert/strict";
import test from "node:test";
import { BIOMES } from "../src/biomes.js";
import { createGenerator } from "../src/terrain.js";
import { V5_MUSHROOMS } from "../src/terrain-v5-biomes.js";
import { AUDIT_SEEDS } from "./terrain-v5-audit-helpers.js";
import { auditBiomeField } from "./terrain-v5-biome-audit.js";

test("real v5 fields prefer common biomes, constrain rare variants, and decouple identity from climate scale", {
  timeout: 180000,
}, () => {
  const before = auditBiomeField(4), after = auditBiomeField(5);
  const n = (id) => after.named[id] ?? 0;
  assert.ok(n("plains") > 0 && n("forest") > 0 && n("taiga") > 0);
  for (const [rare, common] of [
    ["sunflower_plains", "plains"], ["flower_forest", "forest"],
    ["pale_garden", "dark_forest"], ["ice_spikes", "snowy_plains"],
    ["bamboo_jungle", "jungle"], ["old_growth_birch_forest", "birch_forest"],
  ]) {
    assert.ok(n(rare) > 0, `real spatial coverage: ${rare}`);
    assert.ok(n(rare) < n(common) * 0.25, `${rare} must not be an equal-weight peer of ${common}`);
  }
  for (const id of ["pale_garden", "cherry_grove", "ice_spikes", "mushroom_fields"]) {
    assert.ok(n(id) > 0, id);
    assert.ok(n(id) / after.samples < 0.015, `${id} is constrained in actual surface samples`);
  }
  assert.ok(Object.keys(after.named).length >= 44, "retain substantial real surface variety");
  assert.ok(after.ordinaryRunBlocks.p50 > before.ordinaryRunBlocks.p50 * 1.1);
  assert.ok(after.ordinaryRunBlocks.p50 >= 96);
  assert.ok(after.ordinaryRunBlocks.p50 < after.climateRunBlocks.p50);
  assert.ok(after.categories.ocean / after.samples > 0.1);
  assert.ok(after.categories.ocean / after.samples < 0.65);
});

test("rare mushroom destinations have a real broad core independent of their occurrence roll", {
  timeout: 60000,
}, () => {
  let destinations = 0;
  for (const seed of AUDIT_SEEDS.slice(0, 3)) {
    const generator = createGenerator(seed, "overworld", 5);
    let checked = 0;
    for (let gz = -8; gz <= 8 && checked < 3; gz++)
      for (let gx = -8; gx <= 8 && checked < 3; gx++) {
        const island = generator.getMushroomIsland(gx, gz);
        if (!island) continue;
        const cx = Math.floor(island.x), cz = Math.floor(island.z);
        if (generator.getBiome(cx, cz).id !== "mushroom_fields") continue;
        assert.ok(island.radiusX >= V5_MUSHROOMS.minRadius);
        assert.ok(island.radiusX <= V5_MUSHROOMS.maxRadius);
        let core = 0;
        for (let z = -64; z <= 64; z += 16)
          for (let x = -64; x <= 64; x += 16)
            core += Number(generator.getBiome(cx + x, cz + z).id === "mushroom_fields");
        assert.ok(core >= 65, "most of a 128x128 core is real dry mushroom land");
        const chunk = generator.generateChunk(Math.floor(cx / 16), Math.floor(cz / 16));
        assert.ok([...chunk.biomes].filter((index) => BIOMES[index].id === "mushroom_fields").length >= 200);
        checked++; destinations++;
      }
  }
  assert.ok(destinations >= 3, "bounded real searches find several destinations");
});

test("v5 three-dimensional biome IDs still include Nether, End and cave families in real samples", {
  timeout: 60000,
}, () => {
  const seen = new Set();
  for (const dimension of ["overworld", "nether", "end"])
    for (const seed of AUDIT_SEEDS.slice(0, 3)) {
      const generator = createGenerator(seed, dimension, 5);
      for (let z = -4096; z <= 4096; z += 128)
        for (let x = -4096; x <= 4096; x += 128) {
          seen.add(generator.getBiome(x, z).id);
          if (dimension === "overworld")
            for (const y of [-48, 20, 48]) seen.add(generator.getBiome(x, z, y).id);
        }
    }
  for (const id of [
    "nether_wastes", "soul_sand_valley", "crimson_forest", "warped_forest",
    "basalt_deltas", "the_end", "the_void", "end_highlands", "end_midlands",
    "end_barrens", "small_end_islands", "deep_dark", "lush_caves",
    "dripstone_caves", "sulfur_caves",
  ]) assert.ok(seen.has(id), id);
});
