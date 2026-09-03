import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { BLOCK as B } from "../src/blocks.js";
import { parseStructureIdentity } from "../src/canonical-structure-identity.js";
import { normalizeFuseSnapshot } from "../src/fuses.js";
import { normalizeMapTarget } from "../src/item-stack-data.js";
import { normalizePlayerProjectilesSnapshot } from "../src/pearl-save.js";
import { normalizeProgressContext } from "../src/progression-common.js";
import { normalizeProgressionContext } from "../src/progression-context.js";
import { exportWorldFile, normalizeSave, parseWorldFile, WorldStorage } from "../src/storage.js";
import { World } from "../src/world.js";
import { createWorldContext, getWorldSpec, isEditablePosition } from "../src/world-spec.js";
import { drainNativeFallback } from "./native-v4-fixtures.js";

const seed = "  v5 / raw:🌲 seed  ";
const snapshot = () => ({
  version: 3,
  world: {
    version: 3, generatorVersion: 5, seed, dimension: "overworld",
    edits: [
      ["overworld", -1, -40, -1, B.WATER, 0, FLUID.WATER_3],
      ["overworld", -2, 120, -1, B.OAK_LOG, S.AXIS_X, FLUID.NONE],
      ["nether", 3, 180, 4, B.OAK_SLAB, S.TOP, FLUID.WATER_SOURCE],
      ["end", 5, 0, -2, B.GLASS, 0, FLUID.NONE],
    ],
  },
  player: { x: -0.5, y: -39, z: -0.5, yaw: 0, pitch: 0 },
});

test("v5 real World fallback admits edits, states and fluids while historical loads retain their version", {
  timeout: 60000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const world = new World(seed, { useWorker: false });
  t.after(() => world.dispose());
  assert.equal(world.generatorVersion, 3);
  assert.equal(world.loadEdits(snapshot().world), true);
  assert.equal(world.generatorVersion, 5);
  const pending = world.ensureArea({ x: -1, z: -1 }, 0);
  drainNativeFallback(t, world);
  await pending;
  assert.deepEqual(world.getCell(-1, -40, -1), { id: B.WATER, state: 0, fluid: FLUID.WATER_3 });
  assert.deepEqual(world.getCell(-2, 120, -1), { id: B.OAK_LOG, state: S.AXIS_X, fluid: FLUID.NONE });
  assert.deepEqual(world.serialize(), snapshot().world);
  for (const generatorVersion of [1, 2, 3, 4]) {
    const old = { version: 3, generatorVersion, seed, dimension: "overworld", edits: [] };
    assert.equal(world.loadEdits(old), true);
    assert.equal(world.generatorVersion, generatorVersion);
    assert.equal(world.serialize().generatorVersion, generatorVersion);
  }
});

test("v5 export/import and IndexedDB preserve world identity and all-dimension sparse cells", async () => {
  const original = snapshot();
  assert.deepEqual(parseWorldFile(exportWorldFile(original)), original);
  const indexedDB = new IDBFactory(), first = new WorldStorage({ indexedDB });
  await first.save(original);
  await first.close();
  const second = new WorldStorage({ indexedDB });
  const restored = await second.load();
  assert.equal(restored.world.generatorVersion, 5);
  assert.equal(restored.world.seed, seed);
  assert.deepEqual(new Set(restored.world.edits.map(JSON.stringify)),
    new Set(original.world.edits.map(JSON.stringify)));
  await second.close();
  for (const generatorVersion of [1, 2, 3, 4]) {
    const old = { version: 3, world: { version: 3, generatorVersion, seed, dimension: "end", edits: [] } };
    assert.equal(normalizeSave(old).world.generatorVersion, generatorVersion);
    assert.equal(parseWorldFile(exportWorldFile(old)).world.generatorVersion, generatorVersion);
  }
  const future = snapshot();
  future.world.generatorVersion = 6;
  assert.throws(() => parseWorldFile(JSON.stringify(future)), /version/);
});

test("v5 canonical structure/map identity and detached contexts widen without weakening old validation", () => {
  const context = createWorldContext({ seed, generatorVersion: 5 });
  assert.equal(normalizeProgressContext(context).generatorVersion, 5);
  assert.equal(normalizeProgressionContext(context).generatorVersion, 5);
  const id = `structure:v1:${encodeURIComponent(JSON.stringify(seed))}:overworld:dungeon:0:0`;
  const target = { seed, generatorVersion: 5, dimension: "overworld", structureId: id, x: 10, y: -40, z: 10 };
  assert.deepEqual(normalizeMapTarget(target, context), target);
  assert.equal(parseStructureIdentity(id, seed, 5, "overworld").generatorVersion, 5);
  assert.equal(parseStructureIdentity(id, seed, 4, "overworld").generatorVersion, 4);
  for (const version of [1, 2, 3, 6, "5"])
    assert.throws(() => parseStructureIdentity(id, seed, version, "overworld"), RangeError);
  assert.throws(() => normalizeMapTarget(target, createWorldContext({ seed, generatorVersion: 4 })), RangeError);
  assert.throws(() => normalizeMapTarget({ ...target, x: 192 }, context), RangeError);
  for (const version of [1, 2, 3]) assert.equal(isEditablePosition(0, 0, 0, version, "end"), false);
  for (const version of [4, 5]) {
    assert.equal(isEditablePosition(0, 0, 0, version, "end"), true);
    assert.equal(getWorldSpec(version, "overworld").minY, -64);
  }
  const fuses = { version: 1, entries: [{ dimension: "end", x: 0, y: 0, z: 0, remaining: 2 }] };
  assert.deepEqual(normalizeFuseSnapshot(fuses, context), fuses);
  assert.equal(normalizeFuseSnapshot(fuses, createWorldContext({ seed, generatorVersion: 3 })), null);
});

test("v5 pearl sidecar identity accepts signed/high poses and rejects cross-version reuse", () => {
  const context = createWorldContext({ seed, generatorVersion: 5 });
  const data = {
    version: 1, seed, generatorVersion: 5, ownerId: "local-player", life: 0,
    cooldown: 0, randomState: 42, nextId: 2, accumulator: 0,
    projectiles: [{
      id: 1, kind: "ender_pearl", ownerId: "local-player", life: 0,
      dimension: "overworld", position: { x: 1.5, y: -48, z: 2.5 },
      velocity: { x: 1, y: 0, z: 0 }, age: 0, wait: 0, spin: 1729,
    }],
  };
  assert.deepEqual(normalizePlayerProjectilesSnapshot(data, context), data);
  assert.equal(normalizePlayerProjectilesSnapshot(data, createWorldContext({ seed, generatorVersion: 4 })), null);
  assert.equal(normalizePlayerProjectilesSnapshot({ ...data, generatorVersion: 6 },
    { ...context, generatorVersion: 6 }), null);
});
