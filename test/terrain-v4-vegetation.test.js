import assert from "node:assert/strict";
import test from "node:test";
import { BIOME_PROFILES } from "../src/biomes.js";
import { BLOCK_STATE as S } from "../src/block-state.js";
import { seedHash } from "../src/noise.js";
import {
  newV4Counters,
  V4_SPECS,
  V4_TREE_REACH,
} from "../src/terrain-v4-config.js";
import {
  createV4Vegetation,
  emitV4Tree,
} from "../src/terrain-v4-vegetation.js";

test("authored high-altitude tree fixture varies native shapes without the old Y=96 cap", () => {
  // A deliberately authored support/climate fixture isolates descriptor logic.
  // Natural terrain and spawn tests live in the v4 integration suites.
  const salt = seedHash("v4-tree-shape-unit");
  const heights = new Set();
  const species = new Set();
  const axes = new Set();
  let trees = 0;
  for (const id of [
    "birch_forest",
    "cherry_grove",
    "savanna",
    "old_growth_spruce_taiga",
  ]) {
    const counters = newV4Counters();
    const sampleColumn = (x, z) => ({
      x,
      z,
      id,
      top: 154,
      landTop: 154,
      depth: 0,
      temperature: 0.65,
      waterLevel: null,
      treeSafe: true,
      profile: BIOME_PROFILES[id],
    });
    const vegetation = createV4Vegetation({
      salt,
      dimension: "overworld",
      spec: V4_SPECS.overworld,
      sampleColumn,
      counters,
    });
    for (let gz = -4; gz < 4; gz++)
      for (let gx = -4; gx < 4; gx++)
        for (const tree of vegetation.getTrees(gx, gz)) {
          trees++;
          species.add(tree.type);
          heights.add(`${tree.type}:${tree.height}`);
          assert.ok(tree.bounds.minX >= tree.x - V4_TREE_REACH);
          assert.ok(tree.bounds.maxX <= tree.x + V4_TREE_REACH);
          assert.ok(tree.bounds.minZ >= tree.z - V4_TREE_REACH);
          assert.ok(tree.bounds.maxZ <= tree.z + V4_TREE_REACH);
          assert.ok(tree.bounds.maxY > 160 && tree.bounds.maxY < 320);
          const logs = new Map();
          let writes = 0;
          emitV4Tree(tree, (x, y, z, block, options) => {
            writes++;
            assert.ok(x >= tree.bounds.minX && x < tree.bounds.maxX);
            assert.ok(y >= tree.bounds.minY && y < tree.bounds.maxY);
            assert.ok(z >= tree.bounds.minZ && z < tree.bounds.maxZ);
            if (block === tree.wood) {
              logs.set(`${x},${y},${z}`, [x, y, z]);
              axes.add(options.state);
            }
          });
          assert.ok(
            writes < 4096,
            "bounded native emission per tree descriptor"
          );
          const first = `${tree.x},${tree.ground + 1},${tree.z}`;
          const queue = [logs.get(first)];
          const seen = new Set([first]);
          assert.ok(queue[0], "root log exists");
          for (let cursor = 0; cursor < queue.length; cursor++) {
            const [x, y, z] = queue[cursor];
            for (const [dx, dy, dz] of [
              [1, 0, 0],
              [-1, 0, 0],
              [0, 1, 0],
              [0, -1, 0],
              [0, 0, 1],
              [0, 0, -1],
            ]) {
              const key = `${x + dx},${y + dy},${z + dz}`;
              if (!seen.has(key) && logs.has(key)) {
                seen.add(key);
                queue.push(logs.get(key));
              }
            }
          }
          assert.equal(
            seen.size,
            logs.size,
            "branches remain face-connected to the trunk"
          );
        }
    assert.equal(counters.caveColumns, 0);
    assert.equal(counters.chunkGenerations, 0);
  }
  assert.ok(trees >= 12 && species.size === 4 && heights.size >= 12);
  assert.ok(axes.has(S.AXIS_X) && axes.has(S.AXIS_Z) && axes.has(0));
});
