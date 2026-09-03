import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK } from "../src/blocks.js";
import { WorldStorage } from "../src/storage.js";
import { World } from "../src/world.js";

test("far-away edits survive eviction, IndexedDB save, reopening and regeneration", async () => {
  const database = new IDBFactory();
  const world = new World("long-walk", { useWorker: false });
  const far = { x: 2400.5, y: 70, z: -1900.5 };
  await world.ensureArea(far, 0);
  world.set(2400, 70, -1901, BLOCK.BRICK);
  await world.ensureArea({ x: -5000, z: 5000 }, 0);
  world.updateStreaming({ x: -5000, z: 5000 }, 0);
  assert.equal(world.isLoaded(2400, -1901), false);
  const storage = new WorldStorage({ indexedDB: database });
  await storage.save({ version: 3, world: world.serialize(), time: 0.5 });
  await storage.close();
  world.dispose();
  const reopened = new WorldStorage({ indexedDB: database });
  const saved = await reopened.load();
  const restored = new World(saved.world.seed, { useWorker: false });
  assert.equal(restored.loadEdits(saved.world), true);
  await restored.ensureArea(far, 0);
  assert.equal(restored.get(2400, 70, -1901), BLOCK.BRICK);
  assert.ok(restored.chunks.size < 30);
  restored.dispose();
  await reopened.close();
});

test("original valley saves keep their terrain and edits through archive migration", async () => {
  const legacy = new World("cedar-valley", {
    generatorVersion: 1,
    useWorker: false,
  }).generate(0);
  const at = legacy.getSpawn();
  const x = Math.floor(at.x),
    z = Math.floor(at.z),
    y = Math.floor(at.y);
  const originalFloor = legacy.get(x, y - 1, z);
  legacy.set(x + 1, y, z, BLOCK.GLASS);
  const storage = new WorldStorage({ indexedDB: new IDBFactory() });
  await storage.save({ version: 3, world: legacy.serialize(), time: 0.3 });
  const saved = await storage.load();
  const restored = new World(saved.world.seed, { useWorker: false });
  assert.equal(restored.loadEdits(saved.world), true);
  await restored.ensureArea(at, 0);
  assert.equal(restored.generatorVersion, 1);
  assert.equal(restored.get(x, y - 1, z), originalFloor);
  assert.equal(restored.get(x + 1, y, z), BLOCK.GLASS);
  legacy.dispose();
  restored.dispose();
  await storage.close();
});
