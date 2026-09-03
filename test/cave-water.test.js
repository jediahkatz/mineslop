import assert from "node:assert/strict";
import test from "node:test";
import { getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { buildChunkGeometry, getBiomeTint } from "../src/chunk-mesh.js";

test("underground sulfur pools use their cave biome rather than the forest overhead", () => {
  const surface = getBiomeById("forest");
  const sulfur = getBiomeById("sulfur_caves");
  let depthQueries = 0;
  const world = {
    get: (x, y, z) =>
      x === 4 && y === 14 && z === 5 ? BLOCK.WATER : BLOCK.AIR,
    getBiome: (_x, _z, y) => {
      if (y !== undefined) depthQueries++;
      return y === 14 ? sulfur : surface;
    },
  };
  const batches = buildChunkGeometry(world, 0, 0, {
    uvFor: () => [0, 0, 1, 1],
  });
  const normals = batches.water.getAttribute("normal");
  const colors = batches.water.getAttribute("color");
  const expected = getBiomeTint(BLOCK.WATER, "top", sulfur);
  for (let vertex = 0; vertex < normals.count; vertex++) {
    if (normals.getY(vertex) !== 1) continue;
    const actual = [
      colors.getX(vertex),
      colors.getY(vertex),
      colors.getZ(vertex),
    ];
    actual.forEach((value, channel) =>
      assert.ok(Math.abs(value - expected[channel]) < 1e-6)
    );
  }
  assert.equal(
    depthQueries,
    1,
    "only one height-aware lookup per visible water block"
  );
  for (const geometry of Object.values(batches)) geometry?.dispose();
});
