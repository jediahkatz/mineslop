import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK as B, isSolid } from "../src/blocks.js";
import { seedHash } from "../src/noise.js";
import { WATER_LEVEL } from "../src/terrain.js";
import {
  mergeCaveIntervals,
  sampleCaveIntervals,
} from "../src/terrain-cave-field.js";
import { carveCaves } from "../src/terrain-profiles.js";

test("cave interval union removes internal roofs without filling air or erasing a rock tread", () => {
  const original = [
    [14, 25],
    [5, 10],
  ];
  const before = structuredClone(original);
  assert.deepEqual(mergeCaveIntervals([...original, [9, 17]]), [[5, 25]]);
  assert.deepEqual(mergeCaveIntervals([...original, [11, 13]]), [[5, 25]]);
  assert.deepEqual(
    mergeCaveIntervals([...original, [12, 15]]),
    [
      [5, 10],
      [12, 25],
    ],
    "the rock support at y=11 is not part of either cavity"
  );
  assert.deepEqual(
    original,
    before,
    "cached source intervals are immutable inputs"
  );
});

for (const seed of ["cedar-valley", "birch-river", "123", ""]) {
  test(`v3 local cave relief and solid boundaries are seed/coordinate independent: ${JSON.stringify(seed)}`, () => {
    const salt = seedHash(seed);
    const floors = new Set();
    const roofs = new Set();
    let rock = 0;
    let open = 0;
    let narrow = 0;
    let cavern = 0;
    for (const [minX, minZ] of [
      [0, 0],
      [-112, -224],
      [1600000, -1300000],
    ]) {
      for (let z = minZ; z < minZ + 48; z++) {
        for (let x = minX; x < minX + 48; x++) {
          const caves = sampleCaveIntervals(x, z, 44, salt, WATER_LEVEL);
          if (!caves.length) rock++;
          else open++;
          for (const [low, high] of caves) {
            assert.ok(low >= 4 && high <= 39 && high - low >= 2);
            if (low > 12) floors.add(low);
            roofs.add(high);
            if (high - low < 5) narrow++;
            if (high - low >= 8) cavern++;
          }
        }
      }
    }
    assert.ok(
      rock > 300 && open > 1000,
      "both local rock masses and actual cavities"
    );
    assert.ok(
      floors.size >= 6 && roofs.size >= 10,
      "independent floor and roof relief"
    );
    assert.ok(
      narrow > 100 && cavern > 50,
      "passages and rooms, not one constant-height layer"
    );
    assert.deepEqual(sampleCaveIntervals(-17, 31, 26, salt, WATER_LEVEL), []);
  });
}

test("v3 lush decoration is rooted in the final roof, keeps headroom and exposes patchy rock", () => {
  const col = {
    top: 40,
    naturalCaves: true,
    caveHumidity: 0.8,
    caveGrowth: 0.8,
    caves: mergeCaveIntervals([
      [14, 19],
      [18, 26],
    ]),
  };
  let vines = 0;
  let berries = 0;
  for (const chance of [0.001, 0.00225, 0.0075, 0.0222, 0.0666, 0.09]) {
    const blocks = Array.from({ length: 40 }, (_, y) =>
      carveCaves(B.STONE, col, y, chance)
    );
    assert.equal(blocks[27], B.MOSS);
    assert.ok(isSolid(blocks[13]));
    assert.deepEqual(blocks.slice(14, 17), [B.AIR, B.AIR, B.AIR]);
    assert.equal(blocks.includes(B.GLOWSTONE), false);
    for (let y = 14; y <= 26; y++) {
      if (![B.CAVE_VINE, B.GLOW_BERRIES].includes(blocks[y])) continue;
      vines++;
      if (blocks[y] === B.GLOW_BERRIES) berries++;
      let anchor = y + 1;
      while ([B.CAVE_VINE, B.GLOW_BERRIES].includes(blocks[anchor])) anchor++;
      assert.equal(anchor, 27, "no chain hangs from the removed internal roof");
      assert.ok(anchor - y <= 4);
    }
  }
  assert.ok(vines > 0 && berries > 0);
  assert.equal(
    carveCaves(B.STONE, { ...col, caveGrowth: 0.2 }, 13, 0.02),
    B.STONE
  );
  assert.equal(
    carveCaves(B.STONE, { ...col, caveGrowth: 0.2 }, 27, 0.02),
    B.STONE
  );
  const open = { ...col, caves: [[14, 40]] };
  for (let y = 14; y <= 39; y++)
    assert.equal(
      carveCaves(B.STONE, open, y, 0.0075),
      B.AIR,
      "no growth without a roof"
    );

  const legacy = { ...col, naturalCaves: false, caves: [[14, 25]] };
  assert.equal(carveCaves(B.STONE, legacy, 24, 0.01), B.GLOWSTONE);
});

test("berries remain a rare tip accent within dense growth pockets, not every third hanging chain", () => {
  const col = {
    top: 40,
    naturalCaves: true,
    caveHumidity: 0.8,
    caves: [[14, 26]],
  };
  let berryChains = 0;
  const samples = 1000;
  for (let i = 0; i < samples; i++) {
    const chance = (i + 0.5) / 10000;
    const chain = (growth) =>
      Array.from({ length: 13 }, (_, y) =>
        carveCaves(B.STONE, { ...col, caveGrowth: growth }, y + 14, chance)
      );
    const ordinary = chain(0.58);
    const dense = chain(0.8);
    assert.ok(ordinary.includes(B.CAVE_VINE));
    assert.equal(ordinary.includes(B.GLOW_BERRIES), false);
    if (dense.includes(B.GLOW_BERRIES)) berryChains++;
    assert.deepEqual(
      dense.map((id) => (id === B.GLOW_BERRIES ? B.CAVE_VINE : id)),
      ordinary,
      "rare berries do not move or shorten their real supporting chains"
    );
  }
  assert.ok(
    berryChains >= samples * 0.075 && berryChains <= samples * 0.1,
    `dense-pocket berry-bearing chains: ${berryChains}/${samples}`
  );
});
