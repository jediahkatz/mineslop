import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import {
  cellIndex,
  cloneChunkData,
  normalizeGeneratedChunk,
} from "../src/chunk-data.js";
import { createGenerator } from "../src/terrain.js";
import { V4_GENERATION_MANIFEST } from "../src/terrain-v4-manifest.js";
import { World } from "../src/world.js";
import { getWorldSpec } from "../src/world-spec.js";
import {
  drainNativeFallback,
  firstNativeStructure,
  nativeJob,
} from "./native-v4-fixtures.js";
import { findNaturalColumn } from "./terrain-v4-helpers.js";

for (const dimension of ["overworld", "nether", "end"]) {
  test(`default-factory v4 World admits ${dimension} through the queued worker-disabled path`, {
    timeout: 30000, // Native full-height generation and independent packet comparison.
  }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const admissions = [];
    const world = new World("native-v4-world", {
      generatorVersion: 4,
      dimension,
      useWorker: false,
      onChunkAdmitted: (event) => admissions.push(event),
    });
    t.after(() => world.dispose());
    assert.equal(
      world._generatorFactory,
      createGenerator,
      "no injected factory"
    );
    assert.equal(world.generator.generationManifest, V4_GENERATION_MANIFEST);
    assert.equal(world._workerDisabled, true);
    assert.equal(world.getCell(-1, world.minY, 0), null);
    assert.equal(world.getBlockState(-1, world.minY, 0), 0);
    assert.equal(world.getFluid(-1, world.minY, 0), FLUID.NONE);
    assert.equal(
      world.generator.counters.chunkGenerations,
      0,
      "unavailable scalar reads never generate"
    );
    const loaded = world.ensureArea({ x: -1, z: 0 }, 0);
    assert.equal(admissions.length, 0, "queuing does not publish");
    drainNativeFallback(t, world);
    assert.equal(await loaded, world);
    const chunk = world.chunks.get("-1,0");
    const generator = createGenerator(world.seed, dimension, 4);
    const expected = normalizeGeneratedChunk(
      generator.generateChunk(-1, 0),
      nativeJob(generator, -1, 0)
    );
    assert.deepEqual(cloneChunkData(chunk), expected);
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].chunk, chunk);
    assert.equal(admissions[0].epoch, world.epoch);
    assert.equal(admissions[0].incarnation, chunk.incarnation);
    assert.ok(Object.isFrozen(admissions[0]));
    assert.equal(chunk.sectionRevisions.size, (world.maxY - world.minY) / 16);
    for (const y of [world.minY, -1, 0, 95, 96, world.maxY - 1]) {
      const inside = y >= world.minY && y < world.maxY;
      assert.equal(
        world.getCell(-1, y, 0) !== null,
        inside,
        `${dimension}/${y}`
      );
    }
    for (const y of [world.minY - 1, world.maxY]) {
      assert.equal(world.getCell(-1, y, 0), null);
      assert.equal(world.get(-1, y, 0), BLOCK.AIR);
      assert.equal(world.getBlockState(-1, y, 0), 0);
      assert.equal(world.getFluid(-1, y, 0), FLUID.NONE);
      assert.equal(world.set(-1, y, 0, BLOCK.GLASS), false);
    }
    if (dimension === "overworld")
      assert.equal(world.get(-1, -64, 0), BLOCK.BEDROCK);
    if (dimension === "nether") {
      assert.equal(world.get(-1, 0, 0), BLOCK.BEDROCK);
      assert.equal(world.get(-1, 127, 0), BLOCK.BEDROCK);
      for (const y of [128, 200, 255])
        assert.equal(world.get(-1, y, 0), BLOCK.AIR);
    }
    await world.ensureArea({ x: -1, z: 0 }, 0);
    assert.equal(admissions.length, 1);
    assert.deepEqual(world.admissionObserverErrors, []);
  });
}

test("native sync spawn, high terrain, negative cells and the last build cell survive saved-edit reload", {
  timeout: 30000, // Real spawn validation and one bounded highland search.
}, (t) => {
  const world = new World("v4-ore-ranges", {
    generatorVersion: 4,
    useWorker: false,
  });
  t.after(() => world.dispose());
  world.generate(0);
  const spawn = world.getSpawn();
  assert.ok(spawn.y > 64);
  assert.equal(
    world.getCell(Math.floor(spawn.x), Math.floor(spawn.y), Math.floor(spawn.z))
      .fluid,
    FLUID.NONE
  );
  const highland = findNaturalColumn(
    world.generator,
    (col) => col.top >= 145 && col.mountain > 0.55,
    "native high terrain"
  );
  const cx = Math.floor(highland.x / 16);
  const cz = Math.floor(highland.z / 16);
  // Generate an actual resident, not a fixture column lifted to a new minY.
  world._focus = { cx, cz, radius: 2 };
  const chunk = world._generateSync(cx, cz);
  assert.ok(
    chunk.blocks
      .subarray((96 - world.minY) * 256, (highland.top - world.minY + 1) * 256)
      .some((id) => id !== BLOCK.AIR),
    "native terrain extends above the historical ceiling"
  );
  assert.ok(
    chunk.blocks.subarray(0, -world.minY * 256).includes(BLOCK.DEEPSLATE)
  );
  const x = highland.x;
  const z = highland.z;
  assert.equal(
    world.set(x, -64, z, BLOCK.GLASS),
    false,
    "native bottom bedrock remains immutable"
  );
  const changes = [-1, 0, 95, 96, 319].map((y) => ({
    x,
    y,
    z,
    before: world.getCell(x, y, z),
    after: {
      id: BLOCK.OAK_STAIRS,
      state: S.TOP | 3,
      fluid: FLUID.WATER_SOURCE,
    },
  }));
  assert.equal(world.applyCells(changes), true);
  const saved = world.serialize();
  assert.equal(saved.generatorVersion, 4);
  assert.equal(
    saved.version,
    3,
    "archive/world format is independent of generation"
  );
  const beforeReload = cloneChunkData(world.chunks.get(`${cx},${cz}`));
  const epoch = world.epoch;
  const generated = world.generator.counters.chunkGenerations;
  assert.equal(world.loadEdits(saved), true);
  assert.equal(world.epoch, epoch + 1);
  assert.equal(
    world.generator.counters.chunkGenerations,
    generated,
    "same-generator reload restores original cells without regeneration"
  );
  assert.deepEqual(
    cloneChunkData(world.chunks.get(`${cx},${cz}`)),
    beforeReload
  );
  for (const change of changes) {
    assert.deepEqual(world.getCell(x, change.y, z), change.after);
    assert.equal(world.get(x, change.y, z), change.after.id);
    assert.equal(world.getBlockState(x, change.y, z), change.after.state);
    assert.equal(world.getFluid(x, change.y, z), change.after.fluid);
  }
  assert.equal(
    world.generator.counters.chunkGenerations,
    generated,
    "resident scalar reads never generate"
  );
  assert.equal(world.getCell(x, 320, z), null);
});

test("native constructor and explicit loadEdits version changes use the same factory without upgrading historical saves", {
  timeout: 30000, // One real column per explicit version transition.
}, (t) => {
  const world = new World("native-v4-save-selection", { useWorker: false });
  t.after(() => world.dispose());
  assert.equal(
    world.generatorVersion,
    3,
    "new-world default is still gated by the parent"
  );
  world._generateSync(0, 0);
  const version4 = {
    version: 3,
    seed: world.seed,
    generatorVersion: 4,
    dimension: "overworld",
    edits: [],
  };
  assert.equal(world.loadEdits(version4), true);
  assert.equal(world._generatorFactory, createGenerator);
  assert.equal(world.generator.generationManifest, V4_GENERATION_MANIFEST);
  assert.deepEqual(world.spec, getWorldSpec(4, "overworld"));
  assert.equal(world.chunks.get("0,0").blocks.length, 384 * 256);
  for (const version of [1, 2, 3]) {
    const saved =
      version === 1
        ? { version: 1, seed: world.seed, edits: [] }
        : {
            version: 2,
            seed: world.seed,
            generatorVersion: version,
            dimension: "overworld",
            edits: [],
          };
    assert.equal(world.loadEdits(saved), true);
    assert.equal(world.generatorVersion, version);
    assert.equal(world.serialize().generatorVersion, version);
    const raw = createGenerator(world.seed, "overworld", version).generateChunk(
      0,
      0
    );
    const expected = normalizeGeneratedChunk(raw, {
      id: 0,
      epoch: world.epoch,
      seed: world.seed,
      dimension: "overworld",
      generatorVersion: version,
      cx: 0,
      cz: 0,
    });
    assert.deepEqual(cloneChunkData(world.chunks.get("0,0")), expected);
    assert.equal(world.chunks.get("0,0").structures, undefined);
    assert.equal(world.maxY, 96);
  }
  const snapshot = world.serialize();
  const epoch = world.epoch;
  const resident = world.chunks.get("0,0");
  for (const generatorVersion of [undefined, 0, 6]) {
    assert.equal(world.loadEdits({ ...snapshot, generatorVersion }), false);
    assert.deepEqual(world.serialize(), snapshot);
    assert.equal(world.epoch, epoch);
    assert.equal(world.chunks.get("0,0"), resident);
  }
});

test("native dimension changes cancel old work and retain each dimension's full build volume", {
  timeout: 30000, // Real native Nether/End/Overworld generation; no transport fixture.
}, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const world = new World("native-v4-dimension-travel", {
    generatorVersion: 4,
    useWorker: false,
  });
  t.after(() => world.dispose());
  const loading = world.ensureArea({ x: -1, z: -1 }, 0);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  const epoch = world.epoch;
  world.setDimension("nether");
  await cancelled;
  assert.equal(world.epoch, epoch + 1);
  assert.equal(world.chunks.size, 0);
  for (const dimension of ["nether", "end", "overworld"]) {
    world.setDimension(dimension);
    assert.equal(world.generator.generationManifest, V4_GENERATION_MANIFEST);
    const loaded = world.ensureArea({ x: -1, z: -1 }, 0);
    drainNativeFallback(t, world);
    await loaded;
    assert.equal(
      world.chunks.get("-1,-1").blocks.length,
      (world.maxY - world.minY) * 256
    );
    assert.equal(world.set(-1, world.maxY - 1, -1, BLOCK.GLASS), true);
    assert.equal(world.get(-1, world.maxY - 1, -1), BLOCK.GLASS);
  }
  const saved = world.serialize();
  assert.deepEqual(
    new Set(saved.edits.map(([dimension]) => dimension)),
    new Set(["overworld", "nether", "end"])
  );
  assert.equal(world.loadEdits(saved), true);
  assert.deepEqual(world.serialize(), saved);
});

test("authentic native declarations survive post-edit admission, reload and stale incarnation checks", {
  timeout: 30000, // First bounded natural shipwreck, one real resident and a same-version reload.
}, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { generator, descriptor, attempts } = firstNativeStructure("shipwreck");
  t.diagnostic(
    JSON.stringify({ firstNativeStructure: descriptor.id, attempts })
  );
  const marker = descriptor.markers.find((entry) => entry.type === "container");
  assert.ok(marker);
  const { x, y, z } = marker.position;
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const observations = [];
  const world = new World(generator.seed, {
    generatorVersion: 4,
    useWorker: false,
    onChunkAdmitted(event) {
      observations.push({ event, cell: event.world.getCell(x, y, z) });
    },
  });
  t.after(() => world.dispose());
  const saved = {
    version: 3,
    seed: generator.seed,
    generatorVersion: 4,
    dimension: "overworld",
    edits: [["overworld", x, y, z, BLOCK.AIR, 0, FLUID.NONE]],
  };
  assert.equal(world.loadEdits(saved), true);
  const loading = world.ensureArea({ x, z }, 0);
  drainNativeFallback(t, world);
  await loading;
  const first = observations[0];
  assert.deepEqual(first.cell, { id: BLOCK.AIR, state: 0, fluid: FLUID.NONE });
  const declared = first.event.chunk.structures.find(
    (entry) => entry.id === descriptor.id
  );
  assert.ok(declared);
  assert.deepEqual(
    declared.markers,
    descriptor.markers,
    "saved edits do not rewrite canonical declarations"
  );
  assert.equal(
    first.event.chunk.originals.get(cellIndex(x, y, z, world.spec)).id,
    BLOCK.CHEST
  );
  assert.equal(world._isCurrentAdmission(first.event), true);
  assert.equal(world.loadEdits(saved), true);
  assert.equal(world._isCurrentAdmission(first.event), false);
  const second = observations.at(-1);
  assert.ok(second.event.incarnation > first.event.incarnation);
  assert.deepEqual(second.cell, first.cell);
  assert.deepEqual(
    world.chunks.get(`${cx},${cz}`).structures,
    first.event.chunk.structures
  );
  assert.deepEqual(world.admissionObserverErrors, []);
});
