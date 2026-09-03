import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { defaultFluidFor } from "../src/block-state.js";
import {
  exportWorldFile,
  normalizeSave,
  parseWorldFile,
  WorldStorage,
} from "../src/storage.js";

const snapshot = (edits = []) => ({
  version: 3,
  world: {
    version: 3,
    generatorVersion: 2,
    seed: "archive-test",
    dimension: "overworld",
    edits: edits.map((edit) =>
      edit.length === 5 ? [...edit, 0, defaultFluidFor(edit[4])] : edit
    ),
  },
  player: { x: 150.5, y: 50, z: -430.5, yaw: 0.4, pitch: -0.2, flying: false },
  time: 0.36,
  gameplay: { mode: "survival", health: 17, hunger: 12 },
});

test("IndexedDB stores edits per chunk and restores all dimensions after reopening", async () => {
  const indexedDB = new IDBFactory();
  const first = new WorldStorage({ indexedDB });
  const data = snapshot([
    ["overworld", 150, 30, -431, 7],
    ["overworld", -1, 29, -1, 0],
    ["nether", 150, 30, -431, 17],
  ]);
  assert.equal((await first.save(data)).chunks, 3);
  await first.close();
  const second = new WorldStorage({ indexedDB });
  const loaded = await second.load();
  assert.deepEqual(
    new Set(loaded.world.edits.map(JSON.stringify)),
    new Set(data.world.edits.map(JSON.stringify))
  );
  assert.deepEqual(
    { ...loaded, world: undefined },
    { ...data, world: undefined }
  );
  assert.deepEqual(
    { ...loaded.world, edits: undefined },
    { ...data.world, edits: undefined }
  );
  assert.equal(second.signatures.size, 3);
  await second.close();
});

test("queued saves snapshot their arguments and cannot finish out of order", async () => {
  const store = new WorldStorage({ indexedDB: new IDBFactory() });
  const first = snapshot([["overworld", 5, 20, 6, 7]]);
  const saveFirst = store.save(first);
  first.world.edits[0][4] = 10;
  const last = snapshot([["overworld", 5, 20, 6, 9]]);
  last.time = 0.8;
  await Promise.all([saveFirst, store.save(last)]);
  assert.deepEqual(await store.load(), last);
  await store.close();
});

test("new worlds and importing fewer chunks remove stale records atomically", async () => {
  const store = new WorldStorage({ indexedDB: new IDBFactory() });
  await store.save(
    snapshot([
      ["overworld", 0, 20, 0, 7],
      ["overworld", 80, 20, 80, 9],
    ])
  );
  await store.save(snapshot([["overworld", 0, 20, 0, 10]]));
  assert.equal((await store.load()).world.edits.length, 1);
  const other = snapshot([["end", 0, 40, 0, 3]]);
  other.world.seed = "another-world";
  other.world.dimension = "end";
  await store.save(other);
  assert.deepEqual(await store.load(), other);
  assert.equal(store.signatures.size, 1);
  await store.close();
});

test("metadata-only saves do not duplicate edited chunks", async () => {
  const store = new WorldStorage({ indexedDB: new IDBFactory() });
  const data = snapshot([
    ["overworld", 0, 20, 0, 3],
    ["overworld", 0, 20, 0, 7],
  ]);
  await store.save(data);
  data.player.x = 200;
  await store.save(data);
  const loaded = await store.load();
  assert.deepEqual(loaded.world.edits, [["overworld", 0, 20, 0, 7, 0, 0]]);
  assert.equal(loaded.player.x, 200);
  await store.close();
});

test("world export/import preserves large coordinates, metadata, and edits", () => {
  const data = snapshot([["overworld", -180000, 90, 225678, 5]]);
  assert.deepEqual(parseWorldFile(exportWorldFile(data)), data);
  assert.throws(() => parseWorldFile("{invalid"), /valid JSON/);
  assert.throws(() => parseWorldFile('{"version":20}'), /world file/);
});

test("legacy localStorage saves retain generator version and original block coordinates", () => {
  const old = {
    version: 1,
    world: { version: 1, seed: "old-valley", edits: [[21, 27, 30, 5]] },
    time: 0.3,
  };
  const migrated = normalizeSave(old);
  assert.equal(migrated.world.generatorVersion, 1);
  assert.equal(migrated.legacy, true);
  assert.deepEqual(migrated.world.edits, [["overworld", 21, 27, 30, 5, 0, 0]]);
  assert.equal(old.version, 1);
  assert.deepEqual(old.world.edits, [[21, 27, 30, 5]]);
});

test("invalid imports cannot overwrite a good IndexedDB save", async () => {
  const store = new WorldStorage({ indexedDB: new IDBFactory() });
  const good = snapshot([["overworld", 0, 20, 0, 7]]);
  await store.save(good);
  for (const edit of [
    ["moon", 0, 20, 0, 7],
    ["overworld", 0, 0, 0, 7],
    ["overworld", 30_000_000, 20, 0, 7],
    ["overworld", 0, 96, 0, 7],
    ["overworld", 0, 20, 0, 999],
    ["overworld", 0.5, 20, 0, 7],
  ])
    assert.throws(() => store.save(snapshot([edit])), /Invalid block/);
  assert.deepEqual(await store.load(), good);
  await store.close();
});

test("unavailable storage fails clearly without blocking world export", async () => {
  const store = new WorldStorage({ indexedDB: null });
  await assert.rejects(store.load(), /storage is unavailable/);
  assert.ok(exportWorldFile(snapshot()).includes("archive-test"));
});
