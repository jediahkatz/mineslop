import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK as B, BLOCKS } from "../src/blocks.js";
import { squareSpiral } from "../src/noise.js";
import { createGenerator } from "../src/terrain.js";
import { CAVE_CELL_SIZE } from "../src/terrain-caves.js";
import { treeClearsCaves } from "../src/terrain-tree-clearance.js";
import { writeTree } from "../src/terrain-trees.js";

const tree = {
  x: 10,
  z: 10,
  ground: 30,
  height: 6,
  wood: B.OAK_LOG,
  leaves: B.LEAVES,
  bounds: { minX: 9, maxX: 16, minZ: 7, maxZ: 14, minY: 31, maxY: 38 },
  parts: [
    {
      kind: "trunk",
      x: 10,
      y: 30,
      z: 10,
      height: 6,
      width: 1,
      block: B.OAK_LOG,
    },
    {
      kind: "crown",
      x: 12,
      y: 36,
      z: 10,
      radius: 3,
      block: B.LEAVES,
      flat: false,
    },
  ],
};
const feature = {
  kind: "cave",
  mouth: { y: 34 },
  chamber: { high: 35 },
  bounds: { minX: 13, maxX: 18, minZ: 8, maxZ: 12 },
};

test("distant cave cells and roofed chambers do not sample a tree's whole voxel volume", () => {
  const never = () =>
    assert.fail("unrelated cave must not sample tree columns");
  assert.equal(
    treeClearsCaves(tree, never, () => []),
    true
  );
  assert.equal(
    treeClearsCaves(tree, never, () => [
      {
        ...feature,
        bounds: { minX: 60, maxX: 80, minZ: 60, maxZ: 80 },
      },
    ]),
    true
  );
  assert.equal(
    treeClearsCaves(tree, never, () => [
      {
        ...feature,
        mouth: { y: 12 },
        chamber: { high: 19 },
      },
    ]),
    true
  );
});

test("a bank-rooted canopy is rejected whole when native mouth clipping would remove its leaves", () => {
  const before = structuredClone(tree);
  const counts = new Map();
  const column = (x, z) => {
    const key = `${x},${z}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { caveMouth: x === 14 && z === 10, entrance: { low: 33, high: 39 } };
  };
  assert.equal(
    treeClearsCaves(tree, column, () => [feature]),
    false
  );
  assert.ok([...counts.values()].every((count) => count === 1));
  assert.deepEqual(tree, before);
  assert.equal(
    treeClearsCaves(
      tree,
      () => ({
        caveMouth: true,
        entrance: { low: 20, high: 25 },
      }),
      () => [feature]
    ),
    true,
    "roots above a cave remain valid"
  );
});

test("real cave-bank trees match independently generated chunks and their shared descriptors", () => {
  const generator = createGenerator("cedar-valley");
  const spawn = generator.getSpawn();
  const gx = Math.floor(spawn.x / CAVE_CELL_SIZE);
  const gz = Math.floor(spawn.z / CAVE_CELL_SIZE);
  let region;
  let minX;
  let minZ;
  for (const [dx, dz] of squareSpiral(3)) {
    for (const cave of generator.getCaveEntrances(gx + dx, gz + dz)) {
      minX = (Math.floor(cave.mouth.x / 16) - 2) * 16;
      minZ = (Math.floor(cave.mouth.z / 16) - 2) * 16;
      const candidate = generator.generateRegion(minX, minZ, 64, 64);
      const logs = candidate.blocks.filter(
        (id) => BLOCKS[id].texture === "log"
      ).length;
      if (logs >= 12) {
        region = candidate;
        break;
      }
    }
    if (region) break;
  }
  assert.ok(
    region,
    "fixture includes an actual mouth and surrounding native woodland"
  );
  const fresh = createGenerator("cedar-valley");
  for (let dz = 3; dz >= 0; dz--)
    for (let dx = 3; dx >= 0; dx--) {
      const chunk = fresh.generateChunk(minX / 16 + dx, minZ / 16 + dz);
      for (let y = 0; y < 96; y++)
        for (let z = 0; z < 16; z++) {
          const target = y * 4096 + (dz * 16 + z) * 64 + dx * 16;
          const source = y * 256 + z * 16;
          assert.deepEqual(
            chunk.blocks.subarray(source, source + 16),
            region.blocks.subarray(target, target + 16)
          );
        }
    }
  let treeCount = 0;
  let checked = 0;
  for (
    let z = Math.floor((minZ - 8) / 8);
    z <= Math.floor((minZ + 71) / 8);
    z++
  )
    for (
      let x = Math.floor((minX - 8) / 8);
      x <= Math.floor((minX + 71) / 8);
      x++
    )
      for (const descriptor of generator.getTrees(x, z)) {
        treeCount++;
        writeTree(descriptor, (wx, y, wz) => {
          if (
            wx < minX ||
            wx >= minX + 64 ||
            wz < minZ ||
            wz >= minZ + 64 ||
            y < 1 ||
            y >= 96
          )
            return;
          checked++;
          const id = region.blocks[y * 4096 + (wz - minZ) * 64 + wx - minX];
          // Other trees/terrain can occlude a write, but only a reserved mouth
          // can leave it AIR. Such a descriptor must have been rejected whole.
          assert.notEqual(
            id,
            B.AIR,
            `phantom canopy voxel at ${wx},${y},${wz}`
          );
        });
      }
  assert.ok(
    treeCount > 2 && checked > 100,
    "check actual cave-bank canopies, not an empty scene"
  );
});
