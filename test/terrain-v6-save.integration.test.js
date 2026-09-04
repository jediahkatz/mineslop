import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { BLOCK as B } from "../src/blocks.js";
import { parseStructureIdentity } from "../src/canonical-structure-identity.js";
import { normalizeExplorationSnapshot } from "../src/exploration-state.js";
import { normalizeMapTarget } from "../src/item-stack-data.js";
import { normalizePlayerProjectilesSnapshot } from "../src/pearl-save.js";
import { normalizeProgressContext } from "../src/progression-common.js";
import { normalizeProgressionContext } from "../src/progression-context.js";
import { exportWorldFile, normalizeSave, parseWorldFile, WorldStorage } from "../src/storage.js";
import { World } from "../src/world.js";
import { createWorldContext, getWorldSpec, isEditablePosition } from "../src/world-spec.js";
import { drainNativeFallback } from "./native-v4-fixtures.js";

const seed = "  v6 / raw:🌲 seed  ";
const snapshot = () => ({
  version: 3,
  world: {
    version: 3, generatorVersion: 6, seed, dimension: "overworld",
    edits: [
      ["overworld", -1, -40, -1, B.WATER, 0, FLUID.WATER_3],
      ["overworld", -2, 120, -1, B.OAK_LOG, S.AXIS_X, FLUID.NONE],
      ["nether", 3, 180, 4, B.OAK_SLAB, S.TOP, FLUID.WATER_SOURCE],
      ["end", 5, 0, -2, B.GLASS, 0, FLUID.NONE],
    ],
  },
  player: { x: -0.5, y: -39, z: -0.5, yaw: 0, pitch: 0 },
});

test("explicit v6 load preserves signed/high stateful cells; historical saves never migrate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const world = new World(seed, { useWorker: false });
  t.after(() => world.dispose());
  assert.equal(world.generatorVersion, 3);
  assert.equal(world.loadEdits(snapshot().world), true);
  const pending = world.ensureArea({ x: -1, z: -1 }, 0);
  drainNativeFallback(t, world);
  await pending;
  assert.equal(world.generatorVersion, 6);
  assert.deepEqual(world.getCell(-1, -40, -1), { id: B.WATER, state: 0, fluid: FLUID.WATER_3 });
  assert.deepEqual(world.getCell(-2, 120, -1), { id: B.OAK_LOG, state: S.AXIS_X, fluid: FLUID.NONE });
  assert.deepEqual(world.serialize(), snapshot().world);
  for (const generatorVersion of [1, 2, 3, 4, 5, 6, 4, 6]) {
    const saved = { version: 3, generatorVersion, seed, dimension: "end", edits: [] };
    assert.equal(world.loadEdits(saved), true);
    assert.equal(world.generatorVersion, generatorVersion);
    assert.deepEqual(world.serialize(), saved);
    assert.deepEqual(world.spec, getWorldSpec(generatorVersion, "end"));
  }
  assert.equal(world.loadEdits({ ...snapshot().world, generatorVersion: 7 }), false);
});

test("v6 file and IndexedDB roundtrips require no archive/schema bump", async () => {
  const original = snapshot();
  assert.deepEqual(parseWorldFile(exportWorldFile(original)), original);
  const indexedDB = new IDBFactory(), first = new WorldStorage({ indexedDB });
  await first.save(original);
  await first.close();
  const second = new WorldStorage({ indexedDB });
  const restored = await second.load();
  assert.equal(restored.world.generatorVersion, 6);
  assert.equal(restored.world.seed, seed);
  assert.deepEqual(new Set(restored.world.edits.map(JSON.stringify)),
    new Set(original.world.edits.map(JSON.stringify)));
  await second.close();
  for (const generatorVersion of [1, 2, 3, 4, 5, 6]) {
    const saved = { version: 3, world: { version: 3, generatorVersion, seed, dimension: "end", edits: [] } };
    assert.equal(normalizeSave(saved).world.generatorVersion, generatorVersion);
    assert.equal(parseWorldFile(exportWorldFile(saved)).world.generatorVersion, generatorVersion);
  }
  const future = snapshot();
  future.world.generatorVersion = 7;
  assert.throws(() => parseWorldFile(JSON.stringify(future)), /version/);
});

test("layout-v1 IDs require 4/5/6 world contexts; maps and sidecars reject cross-version reuse", () => {
  const id = `structure:v1:${encodeURIComponent(JSON.stringify(seed))}:overworld:dungeon:0:0`;
  for (const version of [4, 5, 6, 5, 4, 6]) {
    const context = createWorldContext({ seed, generatorVersion: version });
    assert.equal(normalizeProgressContext(context).generatorVersion, version);
    assert.equal(normalizeProgressionContext(context).generatorVersion, version);
    assert.equal(parseStructureIdentity(id, seed, version, "overworld").generatorVersion, version);
    const target = {
      seed, generatorVersion: version, dimension: "overworld", structureId: id, x: 10, y: -40, z: 10,
    };
    assert.deepEqual(normalizeMapTarget(target, context), target);
    const exploration = { version: 1, seed, generatorVersion: version, containers: [], encounters: [] };
    assert.deepEqual(normalizeExplorationSnapshot(exploration, context), exploration);
    const pearls = {
      version: 1, seed, generatorVersion: version, ownerId: "local-player", life: 0,
      cooldown: 0, randomState: 42, nextId: 2, accumulator: 0, projectiles: [{
        id: 1, kind: "ender_pearl", ownerId: "local-player", life: 0, dimension: "overworld",
        position: { x: 1.5, y: -48, z: 2.5 }, velocity: { x: 1, y: 0, z: 0 },
        age: 0, wait: 0, spin: 1729,
      }],
    };
    assert.deepEqual(normalizePlayerProjectilesSnapshot(pearls, context), pearls);
    for (const other of [4, 5, 6].filter((entry) => entry !== version)) {
      const foreign = createWorldContext({ seed, generatorVersion: other });
      assert.throws(() => normalizeMapTarget(target, foreign), RangeError);
      assert.equal(normalizeExplorationSnapshot(exploration, foreign), null);
      assert.equal(normalizePlayerProjectilesSnapshot(pearls, foreign), null);
    }
  }
  for (const version of [1, 2, 3, 7, "6"])
    assert.throws(() => parseStructureIdentity(id, seed, version, "overworld"), RangeError);
  assert.throws(() => getWorldSpec(7, "overworld"), RangeError);
  for (const version of [1, 2, 3])
    assert.equal(isEditablePosition(0, 0, 0, version, "end"), false);
  for (const version of [4, 5, 6])
    assert.equal(isEditablePosition(0, 0, 0, version, "end"), true);
});
