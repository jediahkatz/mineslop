import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BIOME_PROFILES } from "../src/biomes.js";
import { isSolid } from "../src/blocks.js";
import { seedHash } from "../src/noise.js";
import { createGenerator } from "../src/terrain.js";
import { readV4RegionCell } from "../src/terrain-v4-writer.js";
import { v6CoastalHeight, v6TerraceHeight } from "../src/terrain-v6-policy.js";
import { v6ForestDensity, v6VegetationColumn } from "../src/terrain-v6-vegetation.js";

const fixture = JSON.parse(readFileSync(new URL("./terrain-v5-golden.json", import.meta.url), "utf8"));
for (const row of fixture.profiles) {
  test(`v6 bounded local ${row.label} transition, not a universal slope clamp`, () => {
    const generator = createGenerator(row.seed, "overworld", 6);
    const columns = row.columns.map(({ offset }) =>
      generator.sampleColumn(row.x + row.dx * offset, row.z + row.dz * offset));
    const a = columns[16], b = columns[17];
    const cells = generator.generateRegion(row.x, row.z, row.dx + 1, row.dz + 1);
    for (const col of [a, b]) {
      assert.ok(isSolid(readV4RegionCell(cells, col.x, col.top, col.z).id),
        "the corrected field must agree with real generated ground cells");
      assert.equal(readV4RegionCell(cells, col.x, col.top, col.z).id, col.surface,
        "these measured seam cells retain their biome material policy");
    }
    if (row.label === "density") {
      assert.equal(a.top, 104);
      assert.equal(b.top, 104);
      assert.equal(a.id, row.columns[16].id);
      assert.equal(b.id, row.columns[17].id);
      const densities = columns.map((col) => v6ForestDensity(col, seedHash(row.seed)));
      assert.ok(Math.abs(densities[17] - densities[16]) < 0.04);
      assert.ok(densities[16] > 0.1 && densities[17] < 0.95);
      for (let i = 1; i < densities.length; i++)
        assert.ok(Math.abs(densities[i] - densities[i - 1]) < 0.04);
      assert.equal(a.profile, BIOME_PROFILES[a.id], "do not rewrite materials/profiles");
      assert.equal(b.profile, BIOME_PROFILES[b.id]);
      assert.equal(v6VegetationColumn(a, seedHash(row.seed)).profile.tree, "spruce");
      assert.equal(v6VegetationColumn(b, seedHash(row.seed)).profile.tree, "spruce");
      console.log(JSON.stringify({ label: row.label, ids: [a.id, b.id], height: [a.top, b.top],
        oldDensity: [row.columns[16].forestDensity, row.columns[17].forestDensity],
        density: [densities[16], densities[17]] }));
    } else if (row.label === "river-control") {
      assert.ok(Math.abs(a.top - b.top) >= 3, "retain the measured legitimate river descent");
      for (let i = 0; i < columns.length; i++)
        assert.ok(Math.abs(columns[i].top - row.columns[i].top) <= 1,
          "the river's local relief must survive the regional operator correction");
    } else {
      const oldJump = Math.abs(row.columns[17].top - row.columns[16].top);
      assert.ok(oldJump >= 6);
      const jump = Math.abs(b.top - a.top);
      assert.ok(jump <= 2, `${row.label}: boundary jump ${jump}, old ${oldJump}`);
      const interior = columns.slice(1).map((col, i) => Math.abs(col.top - columns[i].top));
      assert.ok(jump <= Math.max(1, ...interior.filter((_, i) => i !== 16)));
      for (let i = 1; i < columns.length; i++)
        assert.ok(Math.abs(columns[i].top - columns[i - 1].top) <= 3,
          `${row.label}: correction must not move the seam a few cells away`);
    }
    if (row.label !== "density")
      console.log(JSON.stringify({ label: row.label, ids: [a.id, b.id],
        oldHeight: [row.columns[16].top, row.columns[17].top], height: [a.top, b.top] }));
  });
}

test("coastal and terrace operators have matching limits, with real terrace relief", () => {
  for (const continental of [0.425, 0.44, 0.455]) {
    const left = v6CoastalHeight(continental - 1e-8, 61, 67);
    const right = v6CoastalHeight(continental + 1e-8, 61, 67);
    assert.ok(Math.abs(left - right) < 1e-4);
  }
  assert.equal(v6CoastalHeight(0.3, -42, 67), -42);
  assert.equal(v6CoastalHeight(0.6, 61, 150), 150);
  for (let height = 50; height < 180; height += 0.25) {
    assert.ok(Math.abs(v6TerraceHeight(height + 1e-7) - v6TerraceHeight(height - 1e-7)) < 1e-4);
    assert.ok(Math.abs(v6TerraceHeight(height) - height) <= 3.5);
  }
  assert.ok(Math.abs(v6TerraceHeight(105.5) - 105.5) > 0.1);
});

test("bounded v6 population transition emits real spruce trees beyond the old snowy owner seam", () => {
  const generator = createGenerator("cedar-valley", "overworld", 6);
  let forest = 0, plains = 0, representative;
  for (let gz = -8; gz <= 8; gz++) for (let gx = 58; gx <= 70; gx++)
    for (const tree of generator.getTrees(gx, gz)) {
      const col = generator.sampleColumn(tree.x, tree.z);
      if (col.id === "snowy_taiga") forest++;
      if (col.id === "snowy_plains" && col.woodland.some((entry) => entry.id === "snowy_taiga")) {
        assert.equal(tree.type, "spruce");
        plains++;
        representative ??= tree;
      }
    }
  assert.ok(forest > 0 && plains > 0, `real tree populations: ${forest}/${plains}`);
  const region = generator.generateRegion(representative.x, representative.z, 1, 1);
  assert.equal(readV4RegionCell(region, representative.x, representative.ground + 1, representative.z).id,
    representative.wood);
  console.log(JSON.stringify({ snowyForestTrees: forest, transitionPlainsTrees: plains,
    representative: { x: representative.x, z: representative.z, type: representative.type } }));
});
