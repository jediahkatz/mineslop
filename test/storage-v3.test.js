import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S, FLUID as F } from "../src/block-state.js";
import { MAX_ARCHIVE_BYTES, MAX_EDITS } from "../src/save-budget.js";
import {
  exportWorldFile,
  normalizeSave,
  parseWorldFile,
  WorldStorage,
} from "../src/storage.js";
import { World } from "../src/world.js";
import { emptyFixtureGenerator } from "./world-foundation-fixtures.js";

const snapshot = (edits = [], generatorVersion = 4) => ({
  version: 3,
  world: {
    version: 3,
    seed: "archive-cell-fixture",
    dimension: "overworld",
    generatorVersion,
    edits,
  },
  time: 0.4,
});
const done = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });

test("high IDs, negative Y, orientation and fluid survive files and edited-chunk storage", async (t) => {
  const saved = snapshot([
    ["overworld", -1, -64, -17, BLOCK.COPPER_BLOCK, 0, F.NONE],
    ["overworld", 15, -1, 15, BLOCK.OAK_STAIRS, S.TOP | 2, F.WATER_SOURCE],
    ["overworld", 15, 319, 15, BLOCK.SEA_LANTERN, 0, F.NONE],
    ["nether", 0, 255, 0, BLOCK.MAGMA_BLOCK, 0, F.NONE],
    ["end", 0, 0, 0, BLOCK.WATER, 0, F.BUBBLE_DOWN],
  ]);
  assert.deepEqual(parseWorldFile(exportWorldFile(saved)), saved);
  const storage = new WorldStorage({ indexedDB: new IDBFactory() });
  t.after(() => storage.close());
  await storage.save(saved);
  const loaded = await storage.load();
  assert.equal(loaded.version, saved.version);
  assert.equal(loaded.time, saved.time);
  assert.deepEqual(
    { ...loaded.world, edits: [] },
    { ...saved.world, edits: [] }
  );
  assert.deepEqual(
    new Set(loaded.world.edits.map(JSON.stringify)),
    new Set(saved.world.edits.map(JSON.stringify))
  );
  const world = new World(saved.world.seed, {
    useWorker: false,
    generatorVersion: 4,
    generatorFactory: emptyFixtureGenerator,
  });
  t.after(() => world.dispose());
  assert.equal(world.loadEdits(loaded.world), true);
  for (const [dimension, x, y, z, id, state, fluid] of saved.world.edits) {
    world.setDimension(dimension);
    world._generateSync(Math.floor(x / 16), Math.floor(z / 16));
    assert.deepEqual(world.getCell(x, y, z), { id, state, fluid });
  }
  for (const signature of storage.signatures.values())
    assert.equal(
      JSON.parse(signature)[0].length,
      6,
      "chunk records omit only dimension"
    );
});

test("old envelopes and tuples migrate source defaults without touching recovery input", () => {
  for (const version of [1, 2]) {
    const tuples = [
      [1, 5, 1, BLOCK.WATER],
      [2, 5, 1, BLOCK.LAVA],
      [3, 5, 1, BLOCK.SEAGRASS],
    ];
    const old = {
      version,
      world: {
        version,
        seed: "untouched-legacy",
        ...(version === 2
          ? { generatorVersion: 2, dimension: "overworld" }
          : {}),
        edits:
          version === 1
            ? tuples
            : tuples.map((tuple) => ["overworld", ...tuple]),
      },
    };
    const recoveryText = JSON.stringify(old);
    const migrated = normalizeSave(old);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.world.version, 3);
    assert.equal(migrated.world.generatorVersion, version);
    assert.deepEqual(
      migrated.world.edits.map((edit) => edit.slice(-2)),
      [
        [0, F.WATER_SOURCE],
        [0, F.LAVA_SOURCE],
        [0, F.WATER_SOURCE],
      ]
    );
    assert.equal(JSON.stringify(old), recoveryText);
  }
});

test("all dimensions use generator-specific build bounds while player flight stays unbounded", () => {
  const data = snapshot([
    ["overworld", 0, -1, 0, BLOCK.COPPER_BLOCK, 0, F.NONE],
    ["nether", 0, 255, 0, BLOCK.COPPER_BLOCK, 0, F.NONE],
    ["end", 0, 0, 0, BLOCK.COPPER_BLOCK, 0, F.NONE],
  ]);
  data.player = { x: 0.5, y: 1_000_000, z: 0.5, yaw: 0, pitch: 0 };
  assert.deepEqual(normalizeSave(data), data);
  for (const [dimension, y] of [
    ["overworld", -65],
    ["overworld", 320],
    ["nether", -1],
    ["nether", 256],
    ["end", -1],
    ["end", 256],
  ])
    assert.throws(
      () =>
        normalizeSave(snapshot([[dimension, 0, y, 0, BLOCK.STONE, 0, F.NONE]])),
      /Invalid block/
    );
  for (const y of [-1, 0, 96])
    assert.throws(
      () =>
        normalizeSave(snapshot([["overworld", 0, y, 0, BLOCK.STONE, 0, 0]], 3)),
      /Invalid block/
    );
  data.player.y = -20;
  assert.deepEqual(
    normalizeSave(data),
    data,
    "expanded below-sea poses are legitimate"
  );
  data.player.y = Number.MAX_SAFE_INTEGER;
  assert.throws(() => normalizeSave(data), /player position/);
});

test("file import/export use the same actual UTF-8 ceiling, never JavaScript string length", () => {
  const data = snapshot();
  data.world.seed = "海の谷🌲";
  const text = exportWorldFile(data);
  const bytes = new TextEncoder().encode(text).byteLength;
  assert.ok(bytes > text.length);
  assert.equal(exportWorldFile(data, { maxBytes: bytes }), text);
  assert.deepEqual(parseWorldFile(text, { maxBytes: bytes }), data);
  assert.throws(
    () => exportWorldFile(data, { maxBytes: bytes - 1 }),
    /too large/
  );
  assert.throws(
    () => parseWorldFile(text, { maxBytes: bytes - 1 }),
    /too large/
  );
  assert.throws(
    () => parseWorldFile(text, { maxBytes: text.length }),
    /too large/
  );
  assert.throws(
    () => exportWorldFile(data, { maxBytes: MAX_ARCHIVE_BYTES + 1 }),
    /Invalid archive byte limit/
  );
  assert.throws(
    () => parseWorldFile(text, { maxBytes: MAX_ARCHIVE_BYTES + 1 }),
    /Invalid archive byte limit/
  );
  assert.throws(
    () => normalizeSave(snapshot(new Array(MAX_EDITS + 1))),
    /world format/
  );
});

test("malformed full cells reject before replacing an IndexedDB archive", async (t) => {
  const storage = new WorldStorage({ indexedDB: new IDBFactory() });
  t.after(() => storage.close());
  const good = snapshot([
    ["overworld", 0, -1, 0, BLOCK.COPPER_BLOCK, 0, F.NONE],
  ]);
  await storage.save(good);
  const revision = storage.revision;
  const signatures = new Map(storage.signatures);
  for (const edit of [
    ["overworld", 0, -1, 0, BLOCK.OAK_STAIRS, S.HINGE_RIGHT, F.NONE],
    ["overworld", 0, -1, 0, BLOCK.OAK_SLAB, S.DOUBLE, F.WATER_SOURCE],
    ["overworld", 0, -1, 0, BLOCK.STONE, 0, F.WATER_SOURCE],
    ["overworld", 0, -1, 0, BLOCK.WATER, 0, F.NONE],
    ["overworld", 0, -1, 0, 999, 0, F.NONE],
    ["overworld", 0, -1, 0, BLOCK.COPPER_BLOCK, 0],
    ["nether", 0, -1, 0, BLOCK.COPPER_BLOCK, 0, F.NONE],
  ])
    assert.throws(
      () => storage.save(snapshot([good.world.edits[0], edit])),
      /Invalid block/
    );
  assert.equal(storage.revision, revision);
  assert.deepEqual(storage.signatures, signatures);
  assert.deepEqual(await storage.load(), good);
});

test("corrupt stored chunk identity cannot change the loaded revision baseline", async (t) => {
  const storage = new WorldStorage({ indexedDB: new IDBFactory() });
  t.after(() => storage.close());
  await storage.save(
    snapshot([["overworld", 0, -1, 0, BLOCK.COPPER_BLOCK, 0, 0]])
  );
  const revision = storage.revision;
  const signatures = new Map(storage.signatures);
  const db = await storage.open();
  const transaction = db.transaction("chunks", "readwrite");
  const complete = done(transaction);
  transaction.objectStore("chunks").put({
    key: "active|overworld|0,0",
    worldKey: "active",
    version: 3,
    dimension: "overworld",
    cx: 0,
    cz: 0,
    edits: [[16, -1, 0, BLOCK.COPPER_BLOCK, 0, 0]],
  });
  await complete;
  await assert.rejects(storage.load(), /Invalid stored block edit/);
  assert.equal(storage.revision, revision);
  assert.deepEqual(storage.signatures, signatures);
});
