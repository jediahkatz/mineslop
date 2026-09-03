import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { collidesWithWorld, PLAYER_HEIGHT } from "../src/player.js";
import { createGenerator } from "../src/terrain.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import { CHUNK_SIZE, WORLD_HEIGHT, World } from "../src/world.js";

test("real streamed terrain is deterministic without allocating a finite world array", async () => {
  const first = new World("cedar-valley");
  const second = new World("cedar-valley");
  const other = new World("birch-river");
  await Promise.all(
    [first, second, other].map((world) => world.ensureArea({ x: 21, z: 30 }, 0))
  );
  assert.equal(first.chunks.size, 1);
  assert.equal(first.blocks, undefined);
  assert.deepEqual(
    first.chunks.get("1,1").blocks,
    second.chunks.get("1,1").blocks
  );
  assert.deepEqual(
    first.chunks.get("1,1").biomes,
    second.chunks.get("1,1").biomes
  );
  assert.notDeepEqual(
    first.chunks.get("1,1").blocks,
    other.chunks.get("1,1").blocks
  );
  for (const world of [first, second, other]) world.dispose();
});

// This integration exercises real generation of nine spawn chunks per seed/dimension.
test("real spawns have support and dry full-body headroom across seeds and dimensions", {
  timeout: 10000,
}, () => {
  for (const [seed, dimension] of [
    ["cedar-valley", "overworld"],
    ["birch-river", "overworld"],
    ["123", "overworld"],
    ["", "overworld"],
    ["cedar-valley", "nether"],
    ["cedar-valley", "end"],
  ]) {
    const world = new World(seed, { dimension });
    const spawn = world.getSpawn();
    const x = Math.floor(spawn.x);
    const y = Math.floor(spawn.y);
    const z = Math.floor(spawn.z);
    assert.equal(
      world.isLoaded(x, z),
      true,
      `${seed}/${dimension} spawn is loaded`
    );
    assert.equal(world.isSolid(x, Math.floor(spawn.y - 0.02), z), true);
    assert.equal(collidesWithWorld(world, spawn), false);
    assert.equal(
      world.isSolid(x, Math.floor(spawn.y + PLAYER_HEIGHT), z),
      false
    );
    assert.notEqual(world.get(x, y, z), BLOCK.WATER);
    assert.notEqual(world.get(x, y, z), BLOCK.LAVA);
    assert.ok(world.chunks.size <= 9);
    world.dispose();
  }
});

test("JSON version-three roundtrip preserves real terrain, removals, and far negative edits", async () => {
  const original = new World("save-seed", { useWorker: false });
  const changes = [
    [-17, WORLD_HEIGHT - 2, -1, BLOCK.GLOWSTONE],
    [-1, 1, -1, BLOCK.AIR],
    [80, WORLD_HEIGHT - 1, 81, BLOCK.GLASS],
  ];
  for (const [x, y, z, id] of changes) {
    await original.ensureArea({ x, z }, 0);
    assert.equal(original.set(x, y, z, id), true);
  }
  const save = JSON.parse(JSON.stringify(original.serialize()));
  assert.equal(save.version, 3);
  assert.equal(save.generatorVersion, 3);
  assert.equal(save.dimension, "overworld");
  assert.equal(save.edits.length, changes.length);
  const restored = new World(save.seed, { useWorker: false });
  assert.equal(restored.loadEdits(save), true);
  assert.equal(
    restored.chunks.size,
    0,
    "importing unloaded edits must not generate terrain"
  );
  for (const [x, y, z, id] of changes) {
    await Promise.all([
      original.ensureArea({ x, z }, 0),
      restored.ensureArea({ x, z }, 0),
    ]);
    const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    assert.deepEqual(
      restored.chunks.get(key).blocks,
      original.chunks.get(key).blocks
    );
    assert.equal(restored.get(x, y, z), id);
  }
  assert.deepEqual(restored.serialize(), save);
  original.dispose();
  restored.dispose();
});

test("evicted real chunks replay both mining and placement edits after travel", async () => {
  const world = new World("streaming-retention", { useWorker: false });
  const home = { x: -1000, z: -1000 };
  const away = { x: 10000, z: -10000 };
  await world.ensureArea(home, 0);
  world.set(home.x, 1, home.z, BLOCK.AIR);
  world.set(home.x, WORLD_HEIGHT - 1, home.z, BLOCK.BRICK);
  const key = `${Math.floor(home.x / CHUNK_SIZE)},${Math.floor(home.z / CHUNK_SIZE)}`;
  const before = world.chunks.get(key).blocks.slice();
  world.updateStreaming(away, 0);
  await world.ensureArea(away, 1);
  assert.equal(world.isLoaded(home.x, home.z), false);
  assert.ok(world.removedChunks.has(key));
  assert.equal(world.edits.size, 2);
  await world.ensureArea(home, 0);
  assert.deepEqual(world.chunks.get(key).blocks, before);
  world.dispose();
});

test("all-dimension edits remain isolated through switch, serialization, and reload", async () => {
  const world = new World("dimensions", { useWorker: false });
  const materials = [
    ["overworld", BLOCK.PLANKS],
    ["nether", BLOCK.GLOWSTONE],
    ["end", BLOCK.GLASS],
  ];
  for (const [dimension, id] of materials) {
    world.setDimension(dimension);
    await world.ensureArea({ x: -17, z: 33 }, 0);
    assert.equal(world.set(-17, 60, 33, id), true);
  }
  const save = JSON.parse(JSON.stringify(world.serialize()));
  assert.equal(save.dimension, "end");
  assert.equal(save.edits.length, 3);
  const restored = new World(save.seed, { useWorker: false });
  assert.equal(restored.loadEdits(save), true);
  for (const [dimension, id] of materials) {
    restored.setDimension(dimension);
    assert.equal(restored.chunks.size, 0);
    await restored.ensureArea({ x: -17, z: 33 }, 0);
    assert.equal(restored.get(-17, 60, 33), id);
  }
  world.dispose();
  restored.dispose();
});

test("version-one migration restores the legacy generator and survives version-three re-export", async () => {
  const legacy = {
    version: 1,
    seed: "cedar-valley",
    edits: [
      [21, 27, 30, BLOCK.GLOWSTONE],
      [80, 60, -81, BLOCK.GLASS],
    ],
  };
  const world = new World(legacy.seed, {
    useWorker: false,
    generatorVersion: 2,
  }).generate(0);
  assert.equal(world.loadEdits(legacy), true);
  assert.equal(world.generatorVersion, 1);
  assert.equal(world.dimension, "overworld");
  assert.equal(world.get(21, 26, 30), BLOCK.GRASS);
  assert.equal(world.get(21, 27, 30), BLOCK.GLOWSTONE);
  await world.ensureArea({ x: 80, z: -81 }, 0);
  assert.equal(world.get(80, 60, -81), BLOCK.GLASS);
  const migrated = world.serialize();
  assert.equal(migrated.version, 3);
  assert.equal(migrated.generatorVersion, 1);
  assert.deepEqual(
    migrated.edits,
    legacy.edits.map((edit) => ["overworld", ...edit, 0, 0])
  );
  const restored = new World(migrated.seed, { useWorker: false });
  assert.equal(restored.loadEdits(migrated), true);
  restored.generate(0);
  assert.equal(restored.get(21, 26, 30), BLOCK.GRASS);
  assert.equal(restored.get(21, 27, 30), BLOCK.GLOWSTONE);
  assert.equal(new World(legacy.seed).generatorVersion, 3);
  world.dispose();
  restored.dispose();
});

test("legacy migration keeps an already-loaded far-away view resident", async () => {
  const world = new World("far-migration", { useWorker: false });
  const x = 20000;
  const z = -20000;
  await world.ensureArea({ x, z }, 0);
  assert.equal(
    world.loadEdits({
      version: 1,
      seed: world.seed,
      edits: [[x, WORLD_HEIGHT - 1, z, BLOCK.GLASS]],
    }),
    true
  );
  assert.equal(world.generatorVersion, 1);
  assert.equal(world.isLoaded(x, z), true);
  assert.equal(world.get(x, WORLD_HEIGHT - 1, z), BLOCK.GLASS);
  world.dispose();
});

test("terrain worker protocol transfers real typed buffers and switches generator identity", () => {
  for (const [seed, dimension, generatorVersion] of [
    ["worker-a", "overworld", 3],
    ["worker-a", "nether", 3],
    ["worker-b", "end", 3],
    ["worker-a", "overworld", 2],
    ["worker-a", "nether", 2],
    ["worker-b", "end", 2],
    ["cedar-valley", "overworld", 1],
  ]) {
    const request = {
      type: "generate",
      id: 7,
      epoch: 3,
      seed,
      dimension,
      generatorVersion,
      cx: -1,
      cz: 1,
    };
    let response;
    handleTerrainRequest(request, (message, transfer) => {
      assert.equal(transfer.length, 2);
      response = structuredClone(message, { transfer });
      assert.equal(
        message.blocks.byteLength,
        0,
        "terrain buffer ownership transfers"
      );
      assert.equal(
        message.biomes.byteLength,
        0,
        "biome buffer ownership transfers"
      );
    });
    assert.equal(response.type, "chunk");
    assert.equal(response.schemaVersion, 2);
    assert.equal(response.id, request.id);
    assert.equal(response.epoch, request.epoch);
    assert.equal(response.dimension, dimension);
    assert.equal(response.seed, seed);
    assert.equal(response.generatorVersion, generatorVersion);
    assert.equal(response.minY, 0);
    assert.equal(response.maxY, WORLD_HEIGHT);
    assert.equal(response.encoding, "u8");
    const expected = createGenerator(
      seed,
      dimension,
      generatorVersion
    ).generateChunk(-1, 1);
    assert.deepEqual(response.blocks, expected.blocks);
    assert.deepEqual(response.biomes, expected.biomes);
  }
});

test("terrain worker reports transfer/generation failures with the request identity", () => {
  let response;
  handleTerrainRequest(
    {
      type: "generate",
      id: 42,
      epoch: 8,
      seed: "worker",
      dimension: "overworld",
      generatorVersion: 2,
      cx: 0,
      cz: 0,
    },
    (message) => {
      if (message.type === "chunk") throw new Error("Transfer failed");
      response = message;
    }
  );
  assert.deepEqual(response, {
    type: "error",
    schemaVersion: 2,
    id: 42,
    epoch: 8,
    seed: "worker",
    dimension: "overworld",
    generatorVersion: 2,
    cx: 0,
    cz: 0,
    message: "Transfer failed",
  });
});
