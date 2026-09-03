import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCK,
  BLOCKS,
  HOTBAR,
  isSolid,
  isTransparent,
} from "../src/blocks.js";
import { collidesWithWorld, EYE_HEIGHT, PLAYER_HEIGHT } from "../src/player.js";
import {
  CHUNK_SIZE,
  raycast,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
  World,
} from "../src/world.js";

function emptyWorld(spawn = { x: 0, y: 1.01, z: 0 }) {
  const world = new World("test", { useWorker: false });
  world.generator = {
    ...world.generator,
    getSpawn: () => spawn,
    generateChunk: (cx, cz) => ({
      cx,
      cz,
      blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT),
      biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE),
    }),
  };
  return world.generate();
}

function overlookWorld() {
  const world = emptyWorld({ x: 21, y: 27.01, z: 30 });
  world.set(21, 26, 30, BLOCK.GRASS);
  return world;
}

function legacyRayHit({ x, y, z, id, normal, distance }) {
  return { x, y, z, id, normal, distance };
}

test("expanded catalog keeps the original hotbar and solid/translucent semantics", () => {
  BLOCKS.forEach((block, id) => {
    assert.equal(block.id, id);
    assert.match(block.color, /^#[0-9a-f]{6}$/i);
  });
  assert.deepEqual(HOTBAR, [1, 2, 3, 7, 8, 9, 10, 5, 17]);
  assert.equal(isSolid(BLOCK.WATER), false);
  assert.equal(isSolid(BLOCK.LAVA), false);
  assert.equal(isSolid(BLOCK.GLASS), true);
  assert.equal(isTransparent(BLOCK.GLASS), true);
  assert.equal(isTransparent(BLOCK.STONE), false);
});

test("reads and unloaded edits never generate terrain", () => {
  const world = new World();
  world.generator.generateChunk = () => {
    assert.fail("A read or unloaded edit must not generate a chunk");
  };
  assert.equal(world.get(1, 1, 1), BLOCK.AIR);
  assert.equal(world.isSolid(1, 1, 1), false);
  assert.equal(world.isLoaded(1, 1), false);
  assert.equal(world.heightAt(1, 1), -1);
  assert.equal(world.set(1, 1, 1, BLOCK.STONE), true);
  assert.equal(world.get(1, 1, 1), BLOCK.AIR);
  assert.equal(world.isLoaded(1, 1), false);
  assert.equal(world.chunks.size, 0);
  assert.deepEqual(world.serialize().edits, [
    ["overworld", 1, 1, 1, BLOCK.STONE, 0, 0],
  ]);
});

test("initial generation is synchronous, bounded, and repeatable without erasing edits", () => {
  const world = emptyWorld();
  assert.equal(world.chunks.size, 25);
  assert.equal(world.dirtyChunks.size, 25);
  assert.equal(world.isLoaded(0, 0), true);
  assert.equal(world.isLoaded(-0.1, -16.01), true);
  assert.equal(world.isLoaded(NaN, 0), false);
  assert.equal(world.isLoaded(WORLD_MAX, 0), false);
  world.set(0, 10, 0, BLOCK.GLASS);
  assert.equal(world.generate(), world);
  assert.equal(world.get(0, 10, 0), BLOCK.GLASS);
  assert.equal(world.edits.size, 1);
  for (const chunk of world.chunks.values()) {
    assert.equal(chunk.blocks.length, CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    assert.equal(chunk.biomes.length, CHUNK_SIZE * CHUNK_SIZE);
  }
});

test("spawn loads its area and centers the body on unobstructed support", () => {
  const world = overlookWorld();
  world.chunks.clear();
  world.dirtyChunks.clear();
  const spawn = world.getSpawn();
  assert.deepEqual(spawn, { x: 21.5, y: 27.01, z: 30.5 });
  assert.equal(world.isLoaded(21, 30), true);
  assert.equal(world.chunks.size, 9);
  assert.equal(collidesWithWorld(world, spawn), false);
});

test("spawn clears solid logs and head-level leaves ignored by terrain height", () => {
  const world = overlookWorld();
  for (const [id, y] of [
    [BLOCK.OAK_LOG, 27],
    [BLOCK.BIRCH_LOG, 27],
    [BLOCK.LEAVES, 28],
    [BLOCK.BIRCH_LEAVES, 28],
    [BLOCK.SPRUCE_LOG, 27],
    [BLOCK.CHERRY_LEAVES, 28],
  ]) {
    world.set(21, y, 30, id);
    assert.equal(world.heightAt(21, 30), 26);
    assert.equal(
      collidesWithWorld(world, { x: 21.5, y: 27.01, z: 30.5 }),
      true
    );
    const spawn = world.getSpawn();
    assert.deepEqual(spawn, { x: 21.5, y: y + 1.01, z: 30.5 });
    assert.equal(collidesWithWorld(world, spawn), false);
    assert.equal(
      world.isSolid(21, Math.floor(spawn.y + EYE_HEIGHT), 30),
      false
    );
    world.set(21, y, 30, BLOCK.AIR);
  }
});

test("spawn clears the full body and camera above a ceiling-height building", () => {
  const world = overlookWorld();
  for (let y = 27; y < WORLD_HEIGHT; y++) world.set(21, y, 30, BLOCK.PLANKS);
  world.set(21, WORLD_HEIGHT - 1, 30, BLOCK.LEAVES);
  const spawn = world.getSpawn();
  assert.deepEqual(spawn, { x: 21.5, y: WORLD_HEIGHT + 0.01, z: 30.5 });
  assert.equal(collidesWithWorld(world, spawn), false);
  assert.equal(world.isSolid(21, Math.floor(spawn.y - 0.02), 30), true);
  assert.equal(world.isSolid(21, Math.floor(spawn.y + EYE_HEIGHT), 30), false);
  assert.equal(
    world.isSolid(21, Math.floor(spawn.y + PLAYER_HEIGHT), 30),
    false
  );
});

test("spawn scans neighboring dry support instead of spawning in water or lava", () => {
  for (const fluid of [BLOCK.WATER, BLOCK.LAVA]) {
    const world = emptyWorld();
    world.set(0, 10, 0, BLOCK.STONE);
    world.set(0, 11, 0, fluid);
    world.set(1, 10, 0, BLOCK.STONE);
    const spawn = world.getSpawn();
    assert.deepEqual(spawn, { x: 1.5, y: 11.01, z: 0.5 });
    assert.equal(collidesWithWorld(world, spawn), false);
  }
});

test("Nether spawn finds interior headroom instead of the top of its bedrock roof", () => {
  const world = emptyWorld({ x: 0, y: 6, z: 0 });
  world.dimension = "nether";
  world.set(0, 5, 0, BLOCK.STONE);
  world.set(0, WORLD_HEIGHT - 1, 0, BLOCK.BEDROCK);
  assert.deepEqual(world.getSpawn(), { x: 0.5, y: 6.01, z: 0.5 });
});

test("world bounds use safe integers and allow coordinates beyond the former ±80 edge", async () => {
  const world = emptyWorld();
  for (const position of [
    [WORLD_MIN - 1, 1, 0],
    [WORLD_MAX, 1, 0],
    [0, -1, 0],
    [0, WORLD_HEIGHT, 0],
    [0, 1, WORLD_MIN - 1],
    [0, 1, WORLD_MAX],
    [0.5, 1, 0],
    [NaN, 1, 0],
    [Number.MAX_SAFE_INTEGER + 1, 1, 0],
    [0, Infinity, 0],
    ["1", 1, 0],
  ]) {
    assert.equal(world.get(...position), BLOCK.AIR);
    assert.equal(world.set(...position, BLOCK.STONE), false);
  }
  assert.equal(world.set(0, 0, 0, BLOCK.AIR), false);
  for (const id of [-1, BLOCKS.length, 1.5, NaN, "3"])
    assert.equal(world.set(0, 1, 0, id), false);
  for (const [x, z] of [
    [-81, -80],
    [80, 81],
    [WORLD_MIN, WORLD_MIN],
    [WORLD_MAX - 1, WORLD_MAX - 1],
  ]) {
    await world.ensureArea({ x, z }, 0);
    assert.equal(world.set(x, WORLD_HEIGHT - 1, z, BLOCK.GLASS), true);
    assert.equal(world.get(x, WORLD_HEIGHT - 1, z), BLOCK.GLASS);
    assert.equal(world.set(x, WORLD_HEIGHT - 1, z, BLOCK.GLASS), false);
    assert.equal(world.isSolid(x, WORLD_HEIGHT - 1, z), true);
  }
});

test("bedrock cannot be changed even above the bottom layer", () => {
  const world = emptyWorld();
  assert.equal(world.set(0, 4, 0, BLOCK.BEDROCK), true);
  assert.equal(world.set(0, 4, 0, BLOCK.AIR), false);
  assert.equal(world.get(0, 4, 0), BLOCK.BEDROCK);
});

test("chunk dirtiness includes negative-coordinate diagonal neighbors without phantoms", () => {
  const world = emptyWorld();
  world.clearDirty();
  world.set(-1, 30, -1, BLOCK.STONE);
  assert.deepEqual([...world.dirtyChunks].sort(), [
    "-1,-1",
    "-1,0",
    "0,-1",
    "0,0",
  ]);
  world.clearDirty();
  world.set(-16, 30, 16, BLOCK.STONE);
  assert.deepEqual([...world.dirtyChunks].sort(), [
    "-1,0",
    "-1,1",
    "-2,0",
    "-2,1",
  ]);
  world.clearDirty();
  world.set(-32, 30, -32, BLOCK.STONE);
  assert.deepEqual([...world.dirtyChunks], ["-2,-2"]);
  world.clearDirty();
  world.set(47, 30, 47, BLOCK.STONE);
  assert.deepEqual([...world.dirtyChunks], ["2,2"]);
  world.clearDirty();
  world.set(100000, 30, 100000, BLOCK.STONE);
  assert.equal(world.dirtyChunks.size, 0);
});

test("heightAt ignores all foliage, flowers, fluids and trunks but reflects buildings", () => {
  const world = emptyWorld();
  world.set(0, 10, 0, BLOCK.STONE);
  world.set(0, 11, 0, BLOCK.OAK_LOG);
  world.set(0, 12, 0, BLOCK.LEAVES);
  world.set(0, 13, 0, BLOCK.WATER);
  world.set(0, 14, 0, BLOCK.RED_FLOWER);
  world.set(0, 15, 0, BLOCK.SPRUCE_LOG);
  world.set(0, 16, 0, BLOCK.CHERRY_LEAVES);
  assert.equal(world.heightAt(0, 0), 10);
  world.set(0, 20, 0, BLOCK.PLANKS);
  assert.equal(world.heightAt(0, 0), 20);
  // Basalt reuses the log texture but is ground, not a tree trunk.
  world.set(0, 21, 0, BLOCK.BASALT);
  assert.equal(world.heightAt(0, 0), 21);
  assert.equal(world.heightAt(WORLD_MAX, 0), -1);
  assert.equal(world.heightAt(1, 1), -1);
  assert.equal(world.heightAt(0.5, 0), -1);
});

test("restoring original blocks removes deltas instead of retaining whole terrain", () => {
  const world = emptyWorld();
  world.set(-1, 10, -1, BLOCK.STONE);
  assert.equal(world.edits.size, 1);
  world.set(-1, 10, -1, BLOCK.AIR);
  assert.equal(world.edits.size, 0);
  assert.deepEqual(world.serialize().edits, []);
});

test("loading a same-generator save replaces previous edits on loaded chunks", () => {
  const world = emptyWorld();
  world.set(0, 20, 0, BLOCK.STONE);
  const save = world.serialize();
  world.set(0, 20, 0, BLOCK.GLASS);
  world.set(0, 21, 0, BLOCK.PLANKS);
  assert.equal(world.loadEdits(save), true);
  assert.equal(world.get(0, 20, 0), BLOCK.STONE);
  assert.equal(world.get(0, 21, 0), BLOCK.AIR);
  assert.deepEqual(world.serialize(), save);
});

test("malformed saves and legacy migrations are rejected before any mutation", () => {
  const world = emptyWorld();
  world.set(1, 2, 3, BLOCK.GLASS);
  const before = world.serialize();
  const good = {
    version: 2,
    seed: world.seed,
    generatorVersion: world.generatorVersion,
    dimension: "overworld",
    edits: [["overworld", 1, 2, 3, BLOCK.STONE]],
  };
  for (const data of [
    null,
    {},
    { ...good, seed: "other" },
    { ...good, version: 3 },
    { ...good, dimension: "moon" },
    { ...good, generatorVersion: 99 },
    { ...good, edits: "bad" },
    { ...good, edits: [good.edits[0], ["overworld", 0, 0, 0, 3]] },
    { ...good, edits: [["overworld", 0, 2, 0, BLOCKS.length]] },
    { ...good, edits: [["overworld", WORLD_MAX, 2, 0, 3]] },
    { ...good, edits: [["overworld", 0, WORLD_HEIGHT, 0, 3]] },
    { ...good, edits: [["overworld", 0, 2, 0]] },
    { ...good, edits: [["moon", 0, 2, 0, 3]] },
    { ...good, edits: [["overworld", NaN, 2, 0, 3]] },
    {
      version: 1,
      seed: world.seed,
      edits: [
        [1, 2, 3, 3],
        [0, 0, 0, 3],
      ],
    },
    { version: 1, seed: world.seed, edits: [[0, 2, WORLD_MIN - 1, 3]] },
  ]) {
    assert.equal(world.loadEdits(data), false);
    assert.equal(world.get(1, 2, 3), BLOCK.GLASS);
    assert.deepEqual(world.serialize(), before);
    assert.equal(world.generatorVersion, before.generatorVersion);
  }
  assert.equal(world.loadEdits(good), true);
});

test("positive ray skips water and lava, normalizes direction and reports entered face", () => {
  const world = emptyWorld();
  world.set(1, 20, 0, BLOCK.WATER);
  world.set(2, 20, 0, BLOCK.LAVA);
  world.set(3, 20, 0, BLOCK.STONE);
  const hit = raycast(world, { x: 0.5, y: 20.5, z: 0.5 }, { x: 9, y: 0, z: 0 });
  assert.deepEqual(legacyRayHit(hit), {
    x: 3,
    y: 20,
    z: 0,
    id: BLOCK.STONE,
    normal: { x: -1, y: 0, z: 0 },
    distance: 2.5,
  });
  assert.equal(
    raycast(world, { x: 0.5, y: 20.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 2.49),
    null
  );
});

test("negative ray floors coordinates and returns positive face normal", () => {
  const world = emptyWorld();
  world.set(-3, 20, -1, BLOCK.BRICK);
  const hit = raycast(
    world,
    { x: -0.2, y: 20.5, z: -0.5 },
    { x: -1, y: 0, z: 0 }
  );
  assert.deepEqual(legacyRayHit(hit), {
    x: -3,
    y: 20,
    z: -1,
    id: BLOCK.BRICK,
    normal: { x: 1, y: 0, z: 0 },
    distance: 1.8,
  });
});

test("inside-block rays return zero distance and zero normal", () => {
  const world = emptyWorld();
  world.set(0, 20, 0, BLOCK.GLASS);
  assert.deepEqual(
    legacyRayHit(
      raycast(world, { x: 0.5, y: 20.5, z: 0.5 }, { x: 0, y: 1, z: 0 })
    ),
    {
      x: 0,
      y: 20,
      z: 0,
      id: BLOCK.GLASS,
      normal: { x: 0, y: 0, z: 0 },
      distance: 0,
    }
  );
});

test("vertical, Z-axis and boundary rays traverse without zero-axis NaNs", () => {
  const world = emptyWorld();
  world.set(0, 18, 0, BLOCK.STONE);
  const down = raycast(world, { x: 0, y: 20, z: 0 }, { x: 0, y: -1, z: 0 });
  assert.equal(down.distance, 1);
  assert.deepEqual(down.normal, { x: 0, y: 1, z: 0 });
  world.set(0, 20, -3, BLOCK.STONE);
  const north = raycast(world, { x: 0, y: 20, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(north.distance, 2);
  assert.deepEqual(north.normal, { x: 0, y: 0, z: 1 });
  for (const [origin, direction, reach] of [
    [{ x: 0, y: 20, z: 0 }, { x: 0, y: 0, z: 0 }, 7],
    [{ x: NaN, y: 20, z: 0 }, { x: 1, y: 0, z: 0 }, 7],
    [{ x: 0, y: 20, z: 0 }, { x: 1, y: 0, z: 0 }, Infinity],
    [{ x: 0, y: 20, z: 0 }, { x: 1, y: 0, z: 0 }, -1],
  ]) {
    assert.equal(raycast(world, origin, direction, reach), null);
  }
});
