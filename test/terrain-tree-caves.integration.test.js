import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK as B, BLOCKS, isSolid } from "../src/blocks.js";
import { squareSpiral } from "../src/noise.js";
import { createGenerator, WORLD_HEIGHT } from "../src/terrain.js";
import { CAVE_CELL_SIZE } from "../src/terrain-caves.js";
import { TREE_SPECIES } from "../src/terrain-profiles.js";
import { TREE_REACH, TREE_SPACING, writeTree } from "../src/terrain-trees.js";

const leaves = new Set([
  ...Object.values(TREE_SPECIES).map((species) => species[1]),
  B.SPRUCE_LEAVES,
  B.ACACIA_LEAVES,
  B.RED_MUSHROOM,
  B.BROWN_MUSHROOM,
]);
const treeMaterials = new Set([
  ...leaves,
  ...Object.values(TREE_SPECIES).map((species) => species[0]),
  B.SPRUCE_LOG,
  B.ACACIA_LOG,
  B.MUSHROOM_STEM,
]);
const size = 64;
const area = size * size;

function regionTrees(generator, minX, minZ) {
  const trees = [];
  for (
    let gz = Math.floor((minZ - TREE_REACH) / TREE_SPACING);
    gz <= Math.floor((minZ + size - 1 + TREE_REACH) / TREE_SPACING);
    gz++
  ) {
    for (
      let gx = Math.floor((minX - TREE_REACH) / TREE_SPACING);
      gx <= Math.floor((minX + size - 1 + TREE_REACH) / TREE_SPACING);
      gx++
    )
      trees.push(...generator.getTrees(gx, gz));
  }
  return trees;
}

function woodedCave() {
  for (const seed of ["cedar-valley", "123"]) {
    const generator = createGenerator(seed, "overworld", 3);
    const spawn = generator.getSpawn();
    const gx = Math.floor(spawn.x / CAVE_CELL_SIZE);
    const gz = Math.floor(spawn.z / CAVE_CELL_SIZE);
    for (const [dx, dz] of squareSpiral(3)) {
      for (const feature of generator.getCaveEntrances(gx + dx, gz + dz)) {
        if (feature.kind !== "cave") continue;
        const seam = feature.path.find(
          (point, index) =>
            index > 0 &&
            index < 24 &&
            (feature.direction.x ? point.x % 16 === 0 : point.z % 16 === 0)
        );
        if (!seam) continue;
        const cx = Math.floor(seam.x / 16),
          cz = Math.floor(seam.z / 16);
        const minX = (cx - 2) * 16,
          minZ = (cz - 2) * 16;
        const trees = regionTrees(generator, minX, minZ);
        const nearby = trees.filter(
          (tree) =>
            Math.hypot(tree.x - feature.mouth.x, tree.z - feature.mouth.z) < 24
        );
        if (!nearby.length) continue;
        const whole = generator.generateRegion(minX, minZ, size, size);
        let seamLeaves = 0;
        for (let y = 1; y < WORLD_HEIGHT; y++) {
          for (let z = 16; z < 48; z++) {
            for (let x = 16; x < 48; x++) {
              if (
                (x === 32 || z === 32) &&
                leaves.has(whole.blocks[y * area + z * size + x])
              )
                seamLeaves++;
            }
          }
        }
        if (seamLeaves)
          return {
            seed,
            generator,
            feature,
            seam,
            cx,
            cz,
            minX,
            minZ,
            trees,
            whole,
            seamLeaves,
          };
      }
    }
  }
  return null;
}

test("real native caves and tree descriptors agree across a wooded chunk seam", (t) => {
  const fixture = woodedCave();
  assert.ok(
    fixture,
    "fixture must contain a real cave passage and nearby native canopy crossing the same chunk seams"
  );
  const { seed, feature, seam, cx, cz, minX, minZ, trees, whole, seamLeaves } =
    fixture;
  const at = (x, y, z) => y * area + (z - minZ) * size + x - minX;
  assert.equal(whole.blocks[at(seam.x, seam.low, seam.z)], B.AIR);
  assert.ok(isSolid(whole.blocks[at(seam.x, seam.low - 1, seam.z)]));
  assert.ok(seamLeaves > 0);

  // Replay descriptor writes over the REAL generated rock, topsoil, water and
  // cave air, not an empty raster. There is intentionally no native put() cave
  // clipping here: an intersecting branch must have rejected its entire tree
  // through shared eligibility before either the voxel writer or LOD sees it.
  const expected = whole.blocks.slice();
  for (let i = 0; i < expected.length; i++)
    if (treeMaterials.has(expected[i])) expected[i] = B.AIR;
  for (const tree of trees) {
    writeTree(tree, (x, y, z, id, replaceWater = false) => {
      if (
        x < minX ||
        x >= minX + size ||
        z < minZ ||
        z >= minZ + size ||
        y < 1 ||
        y >= WORLD_HEIGHT
      )
        return;
      const i = at(x, y, z),
        previous = expected[i];
      if (
        previous === B.AIR ||
        BLOCKS[previous].shape === "cross" ||
        BLOCKS[previous].texture === "leaves" ||
        (replaceWater && (previous === B.WATER || previous === B.ICE))
      )
        expected[i] = id;
    });
  }
  for (let i = 0; i < expected.length; i++) {
    const actual = whole.blocks[i];
    // Flowers/ferns are applied after trees by generateRegion and may replace
    // a leaf. Replaying trees last must not mistake that for a clipped branch.
    if (BLOCKS[actual].shape === "cross" || expected[i] === actual) continue;
    const x = minX + (i % size),
      y = Math.floor(i / area);
    const z = minZ + Math.floor((i % area) / size);
    assert.equal(
      expected[i],
      actual,
      `native/tree descriptor mismatch beside a real cave at ${x},${y},${z}`
    );
  }

  const other = createGenerator(seed, "overworld", 3);
  for (const [dx, dz] of [
    [1, 1],
    [0, 0],
    [1, 0],
    [0, 1],
  ]) {
    const chunk = other.generateChunk(cx - 1 + dx, cz - 1 + dz);
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < 16; z++) {
        const source = y * 256 + z * 16;
        const target = y * area + (z + 16 + dz * 16) * size + 16 + dx * 16;
        assert.deepEqual(
          chunk.blocks.subarray(source, source + 16),
          whole.blocks.subarray(target, target + 16)
        );
      }
    }
  }
  t.diagnostic(
    JSON.stringify({
      seed,
      mouth: feature.mouth,
      seam,
      nativeTrees: trees.length,
      seamLeaves,
    })
  );
});
