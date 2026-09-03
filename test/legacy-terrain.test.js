import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { createLegacyTerrain } from "../src/legacy-terrain.js";
import { createGenerator, WORLD_HEIGHT } from "../src/terrain.js";

test("legacy terrain exactly matches the original shipped 160×160×64 world", () => {
  // Captured from `git show HEAD:apps/voxelcraft/src/world.js` before streaming changes.
  // These hashes include every old cave, ore, tree, flower and above-ground air voxel.
  const fixtures = [
    [
      "cedar-valley",
      "150f9e7f2f3e959dc8d33649bcdba4397cd548c68d45df71716920ba696c6027",
    ],
    [
      "birch-river",
      "fed827a8e3be75c83d7e00ceeac99d9c5611d1550c193656dfaf4a8393139d34",
    ],
    ["123", "33772dabba5ea01c38bf99af85d9cdb535431293965a9274450e158d78038a4d"],
    ["", "a113fbdb533faf30324f091f39c9fec61812434796ef1e6ea516f52bda3e1960"],
  ];
  for (const [seed, expected] of fixtures) {
    const legacy = createLegacyTerrain(seed);
    assert.equal(legacy.blocks.length, 160 * 160 * 64);
    assert.equal(
      createHash("sha256").update(legacy.blocks).digest("hex"),
      expected,
      seed
    );
    assert.deepEqual(legacy.getSpawn(), { x: 21.5, y: 27.01, z: 30.5 });
  }
});

test("generator version 1 preserves old coordinates and fills only the new world outside", () => {
  const snapshot = createLegacyTerrain("cedar-valley");
  const legacy = createGenerator("cedar-valley", "overworld", 1);
  const modern = createGenerator("cedar-valley", "overworld", 2);
  for (const [cx, cz] of [
    [-5, -5],
    [4, 4],
    [-1, 0],
    [1, 1],
  ]) {
    const chunk = legacy.generateChunk(cx, cz);
    for (let y = 0; y < WORLD_HEIGHT; y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const wx = cx * 16 + x,
            wz = cz * 16 + z;
          const expected =
            y < 64
              ? snapshot.blocks[y * 25600 + (wz + 80) * 160 + wx + 80]
              : BLOCK.AIR;
          assert.equal(chunk.blocks[y * 256 + z * 16 + x], expected);
        }
  }
  assert.deepEqual(legacy.generateChunk(5, 2), modern.generateChunk(5, 2));
  assert.deepEqual(legacy.generateChunk(-6, -2), modern.generateChunk(-6, -2));
  assert.notDeepEqual(
    legacy.generateChunk(1, 1).blocks,
    modern.generateChunk(1, 1).blocks
  );
  assert.equal(legacy.terrainHeight(21, 30), 26);
  assert.equal(modern.terrainHeight(21, 30), 31);
});

test("legacy overlays remain identical when a wide region crosses the original boundary", () => {
  const generator = createGenerator("cedar-valley", "overworld", 1);
  const whole = generator.generateRegion(64, 64, 32, 32);
  for (const [ox, oz] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const chunk = generator.generateChunk(4 + ox, 4 + oz);
    for (let y = 0; y < 96; y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++)
          assert.equal(
            chunk.blocks[y * 256 + z * 16 + x],
            whole.blocks[y * 1024 + (z + oz * 16) * 32 + x + ox * 16]
          );
  }
});

test("legacy generators can locate the expanded world without changing the old map", () => {
  const generator = createGenerator("cedar-valley", "overworld", 1);
  const original = generator.generateChunk(1, 1);
  for (const id of ["desert", "cherry_grove", "lush_caves", "pale_garden"]) {
    const point = generator.locateBiome(id);
    assert.ok(point, id);
    assert.equal(generator.getBiome(point.x, point.z, point.y).id, id);
    assert.ok(Math.abs(point.x) >= 80 || Math.abs(point.z) >= 80);
  }
  assert.deepEqual(generator.generateChunk(1, 1), original);
});
