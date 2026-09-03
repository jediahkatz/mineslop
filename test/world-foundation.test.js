import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  BLOCK_STATE as S,
  FLUID as F,
  normalizeCell,
} from "../src/block-state.js";
import {
  cellIndex,
  cloneChunkData,
  normalizeGeneratedChunk,
} from "../src/chunk-data.js";
import { raycast as shapeRaycast } from "../src/raycast.js";
import {
  encodedBytes,
  MAX_EDITS,
  MAX_RESERVED_BYTES,
  SaveBudget,
} from "../src/save-budget.js";
import { createGenerator, GENERATOR_VERSION } from "../src/terrain.js";
import { V4_GENERATION_MANIFEST } from "../src/terrain-v4-manifest.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { raycast, World } from "../src/world.js";
import { getWorldSpec } from "../src/world-spec.js";
import {
  changeCell,
  emptyFixtureGenerator,
  fixtureWorld,
} from "./world-foundation-fixtures.js";

test("historical generator buffers promote only at ingestion and never alias edits", (t) => {
  const source = new Uint8Array(96 * 256);
  source[5 * 256] = BLOCK.WATER;
  const original = source.slice();
  const world = fixtureWorld(t, {
    generatorVersion: 1,
    generatorFactory: () => ({
      getSpawn: () => ({ x: 0.5, y: 6, z: 0.5 }),
      generateChunk: (cx, cz) => ({
        cx,
        cz,
        blocks: source,
        biomes: new Uint8Array(256),
      }),
    }),
  });
  const chunk = world.chunks.get("0,0");
  assert.ok(chunk.blocks instanceof Uint16Array);
  assert.deepEqual([...chunk.blocks], [...source]);
  assert.equal(chunk.sections.size, 0);
  assert.equal(world.getFluid(0, 5, 0), F.WATER_SOURCE);
  assert.equal(world.set(1, 5, 0, BLOCK.COPPER_BLOCK), true);
  assert.equal(world.get(1, 5, 0), BLOCK.COPPER_BLOCK);
  assert.deepEqual(source, original);
  assert.deepEqual(world.serialize().edits, [
    ["overworld", 1, 5, 0, BLOCK.COPPER_BLOCK, 0, F.NONE],
  ]);
});

test("first fluid-plane allocation initializes all existing implicit sources", (t) => {
  const sources = [BLOCK.WATER, BLOCK.WATER, BLOCK.LAVA, BLOCK.SEAGRASS];
  const world = fixtureWorld(t, {
    generatorFactory: (seed, dimension, version) => {
      const generator = emptyFixtureGenerator(seed, dimension, version);
      return {
        ...generator,
        generateChunk(cx, cz) {
          const chunk = generator.generateChunk(cx, cz);
          sources.forEach((id, x) => {
            chunk.blocks[5 * 256 + x] = id;
          });
          return chunk;
        },
      };
    },
  });
  const chunk = world.chunks.get("0,0");
  assert.equal(chunk.sections.size, 0);
  assert.equal(
    world.applyCells([
      changeCell(world, 0, 5, 0, { id: BLOCK.WATER, fluid: F.WATER_FALLING }),
    ]),
    true
  );
  assert.ok(chunk.sections.get(0).fluids instanceof Uint8Array);
  assert.equal(chunk.sections.get(0).states, undefined);
  assert.equal(world.getFluid(1, 5, 0), F.WATER_SOURCE);
  assert.equal(world.getFluid(2, 5, 0), F.LAVA_SOURCE);
  assert.equal(world.getFluid(3, 5, 0), F.WATER_SOURCE);
  assert.equal(world.getFluid(4, 5, 0), F.NONE);
  assert.equal(
    world.applyCells([changeCell(world, 0, 5, 0, { id: BLOCK.WATER })]),
    true
  );
  assert.equal(chunk.sections.size, 0, "all-default planes become lazy again");
  assert.equal(world.edits.size, 0);
  assert.equal(world.coordinator.usage(world), 0);
});

test("injected v4 fixtures prove negative-Y bounds and a nullable minus-one surface", (t) => {
  const world = fixtureWorld(t, { generatorVersion: 4 });
  assert.ok(Object.isFrozen(world.spec));
  assert.equal(
    world.chunks.get("0,0").blocks.length,
    (world.maxY - world.minY) * 256
  );
  assert.equal(world.set(1, world.minY, 1, BLOCK.DEEPSLATE), true);
  assert.equal(world.set(1, world.maxY - 1, 1, BLOCK.COPPER_BLOCK), true);
  assert.equal(world.get(1, world.minY, 1), BLOCK.DEEPSLATE);
  assert.equal(world.get(1, world.maxY - 1, 1), BLOCK.COPPER_BLOCK);
  for (const y of [world.minY - 1, world.maxY, -1.5]) {
    assert.equal(world.getCell(1, y, 1), null);
    assert.equal(world.get(1, y, 1), BLOCK.AIR);
    assert.equal(world.set(1, y, 1, BLOCK.STONE), false);
  }
  assert.equal(world.surfaceYAt(0, 0), null);
  world.set(0, -1, 0, BLOCK.STONE);
  assert.equal(world.surfaceYAt(0, 0), -1, "-1 is a real surface, not missing");
  const detached = world.getCell(0, -1, 0);
  detached.id = BLOCK.GLASS;
  assert.equal(world.get(0, -1, 0), BLOCK.STONE);
  assert.equal(world.surfaceYAt(1000, 1000), null);
  world.setDimension("nether");
  assert.equal(world.spec, getWorldSpec(4, "nether"));
  assert.equal(world.set(0, -1, 0, BLOCK.STONE), false);
  assert.equal(world.set(0, 0, 0, BLOCK.COPPER_BLOCK), true);
});

test("default-factory v4 Worlds admit native full-height terrain without changing the default version", {
  timeout: 30000, // Actual native columns and independent factory comparisons in all dimensions.
}, (t) => {
  assert.equal(GENERATOR_VERSION, 3);
  const historical = new World("native-foundation-default", {
    useWorker: false,
  });
  t.after(() => historical.dispose());
  assert.equal(historical.generatorVersion, 3);
  assert.equal(historical.maxY, 96);
  for (const dimension of ["overworld", "nether", "end"]) {
    const world = new World("native-v4-foundation", {
      generatorVersion: 4,
      dimension,
      useWorker: false,
    });
    t.after(() => world.dispose());
    assert.equal(
      world._generatorFactory,
      createGenerator,
      "no injected generator"
    );
    assert.equal(world.seed, "native-v4-foundation");
    assert.equal(world.dimension, dimension);
    assert.equal(world.generatorVersion, 4);
    assert.equal(world.generator.generationManifest, V4_GENERATION_MANIFEST);
    assert.equal(world.spec, getWorldSpec(4, dimension));
    const chunk = world._generateSync(0, 0);
    const expected = normalizeGeneratedChunk(
      createGenerator(world.seed, dimension, 4).generateChunk(0, 0),
      {
        id: 0,
        epoch: world.epoch,
        seed: world.seed,
        dimension,
        generatorVersion: 4,
        cx: 0,
        cz: 0,
      }
    );
    assert.equal(world.chunks.get("0,0"), chunk);
    assert.deepEqual(cloneChunkData(chunk), expected);
    assert.ok(chunk.blocks instanceof Uint16Array);
    assert.equal(chunk.blocks.length, (world.maxY - world.minY) * 256);
    assert.equal(chunk.sectionRevisions.size, (world.maxY - world.minY) / 16);
    assert.equal(world.generator.counters.chunkGenerations, 1);
    assert.notEqual(world.getCell(0, world.minY, 0), null);
    assert.notEqual(world.getCell(0, world.maxY - 1, 0), null);
    for (const y of [world.minY - 1, world.maxY]) {
      assert.equal(world.getCell(0, y, 0), null);
      assert.equal(world.set(0, y, 0, BLOCK.STONE), false);
    }
    assert.deepEqual(world.admissionObserverErrors, []);
  }
});

test("World raycast reexports exact shape hits with full cell and contact metadata", (t) => {
  assert.equal(raycast, shapeRaycast);
  const world = fixtureWorld(t, { generatorVersion: 4 });
  assert.equal(
    world.applyCells([
      changeCell(world, 2, -5, 2, {
        id: BLOCK.OAK_SLAB,
        state: S.TOP,
        fluid: F.WATER_SOURCE,
      }),
    ]),
    true
  );
  const origin = { x: 1.5, y: -4.25, z: 2.5 };
  const direction = { x: 8, y: 0, z: 0 };
  assert.deepEqual(raycast(world, origin, direction), {
    x: 2,
    y: -5,
    z: 2,
    id: BLOCK.OAK_SLAB,
    state: S.TOP,
    fluid: F.WATER_SOURCE,
    normal: { x: -1, y: 0, z: 0 },
    distance: 0.5,
    point: { x: 2, y: -4.25, z: 2.5 },
    localPoint: { x: 0, y: 0.75, z: 0.5 },
    part: "top",
    boxIndex: 0,
    box: [0, 0.5, 0, 1, 1, 1],
  });
  assert.equal(raycast(world, origin, direction, 0.49), null);
  assert.equal(raycast(world, { ...origin, y: -4.75 }, direction), null);
});

test("World spawn delegates fractional support and waterlogged clearance without generation", (t) => {
  const world = fixtureWorld(t, { generatorVersion: 4 });
  t.mock.method(world.generator, "generateChunk", () =>
    assert.fail("spawn height queries must not generate terrain")
  );
  assert.equal(world.set(0, -1, 0, BLOCK.OAK_SLAB), true);
  assert.equal(world._spawnHeight(0, 0, 0), -0.49);
  assert.equal(
    world.applyCells([
      changeCell(world, 0, -1, 0, {
        id: BLOCK.OAK_SLAB,
        fluid: F.WATER_SOURCE,
      }),
    ]),
    true
  );
  assert.equal(world._spawnHeight(0, 0, 0), null);
  assert.equal(
    world.applyCells([
      changeCell(world, 0, -1, 0, {
        id: BLOCK.OAK_SLAB,
        state: S.TOP,
        fluid: F.WATER_SOURCE,
      }),
    ]),
    true
  );
  assert.equal(world._spawnHeight(0, 0, 0), 0.01);
  assert.equal(world._spawnHeight(16, 0, 0), null);
  assert.equal(world.chunks.size, 1);
});

test("full-cell originals prune both orientation and waterlogging reversions", (t) => {
  const original = normalizeCell({
    id: BLOCK.OAK_SLAB,
    state: S.TOP,
    fluid: F.WATER_SOURCE,
  });
  const world = fixtureWorld(t, {
    generatorFactory: (seed, dimension, version) => {
      const generator = emptyFixtureGenerator(seed, dimension, version);
      return {
        ...generator,
        generateChunk(cx, cz) {
          const chunk = generator.generateChunk(cx, cz);
          const at = 5 * 256;
          chunk.blocks[at] = original.id;
          const states = new Uint16Array(4096);
          const fluids = new Uint8Array(4096);
          states[at] = original.state;
          fluids[at] = original.fluid;
          chunk.sections = [{ sy: 0, states, fluids }];
          return chunk;
        },
      };
    },
  });
  const chunk = world.chunks.get("0,0");
  assert.equal(world.set(0, 5, 0, original.id), false);
  assert.deepEqual(world.getCell(0, 5, 0), original);
  for (const after of [
    { ...original, state: 0 },
    { ...original, fluid: F.NONE },
  ]) {
    assert.equal(world.applyCells([changeCell(world, 0, 5, 0, after)]), true);
    assert.equal(world.edits.size, 1);
    assert.deepEqual(chunk.originals.get(5 * 256), original);
    assert.equal(
      world.applyCells([changeCell(world, 0, 5, 0, original)]),
      true
    );
    assert.equal(world.edits.size, 0);
    assert.equal(chunk.originals.size, 0);
    assert.equal(world.coordinator.usage(world), 0);
  }
  world.set(0, 5, 0, BLOCK.STONE);
  assert.deepEqual(world.getCell(0, 5, 0), normalizeCell({ id: BLOCK.STONE }));
  world.applyCells([changeCell(world, 0, 5, 0, original)]);
  assert.equal(world.breakCell(0, 5, 0), true);
  assert.deepEqual(world.getCell(0, 5, 0), normalizeCell({ id: BLOCK.WATER }));
  assert.equal(world.loadEdits({ ...world.serialize(), edits: [] }), true);
  assert.deepEqual(world.getCell(0, 5, 0), original);
});

test("incremental reservations include exact tuple separators without serializing the world", (t) => {
  const world = fixtureWorld(t);
  const serialize = t.mock.method(world, "serialize", () =>
    assert.fail("edits must not serialize the entire world")
  );
  world.set(1, 8, 1, BLOCK.COPPER_BLOCK);
  world.set(2, 8, 1, BLOCK.WATER);
  world.set(3, 8, 1, BLOCK.COPPER_BLOCK);
  world.set(2, 8, 1, BLOCK.AIR);
  serialize.mock.restore();
  assert.equal(
    world.coordinator.usage(world),
    encodedBytes(world.serialize().edits) - 2
  );
  world.set(1, 8, 1, BLOCK.AIR);
  assert.equal(
    world.coordinator.usage(world),
    encodedBytes(world.serialize().edits) - 2
  );
  world.set(3, 8, 1, BLOCK.AIR);
  assert.equal(world.coordinator.usage(world), 0);
});

test("world participants reject atomically and another owner can fund the same commit", (t) => {
  const coordinator = new TransactionCoordinator({ budget: new SaveBudget() });
  const world = fixtureWorld(t, { coordinator });
  const other = {};
  assert.equal(coordinator.register(other, MAX_RESERVED_BYTES), true);
  world.clearDirty();
  const before = world.serialize();
  const chunk = world.chunks.get("0,0");
  const plan = world.prepareMutation([
    changeCell(world, 1, 10, 1, {
      id: BLOCK.OAK_STAIRS,
      state: S.TOP | 1,
      fluid: F.WATER_SOURCE,
    }),
  ]);
  assert.ok(plan);
  assert.equal(world.commitMutation(plan), false);
  assert.deepEqual(world.serialize(), before);
  assert.equal(chunk.revision, 0);
  assert.equal(chunk.originals.size, 0);
  assert.equal(chunk.sections.size, 0);
  assert.equal(world.dirtySectionRevisions.size, 0);
  assert.equal(
    coordinator.commit([
      plan,
      {
        owner: other,
        beforeBytes: MAX_RESERVED_BYTES,
        afterBytes: 0,
        validate: () => false,
        publish: () => assert.fail("rejected participants cannot publish"),
      },
    ]).ok,
    false
  );
  let transferred = false;
  let observed = false;
  const result = coordinator.commit([
    plan,
    {
      owner: other,
      beforeBytes: MAX_RESERVED_BYTES,
      afterBytes: 0,
      validate: () => true,
      publish() {
        transferred = true;
      },
      notify() {
        observed = true;
        assert.equal(transferred, true);
        assert.equal(world.get(1, 10, 1), BLOCK.OAK_STAIRS);
        assert.equal(coordinator.usage(world), plan.afterBytes);
      },
    },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(observed, true);
  assert.equal(
    world.commitMutation(plan),
    false,
    "published plans are single use"
  );
});

test("expected reads, malformed batches and loaded-cell requirements reject before writes", (t) => {
  const world = fixtureWorld(t);
  const valid = changeCell(world, 0, 8, 0, { id: BLOCK.COPPER_BLOCK });
  for (const changes of [
    [{ ...valid, before: normalizeCell({ id: BLOCK.STONE }) }],
    [valid, { ...valid }],
    [valid, changeCell(world, 1, 8, 0, { id: 999 })],
    [changeCell(world, 16, 8, 0, { id: BLOCK.STONE })],
    [{ x: 0, y: 8, z: 0, after: { id: BLOCK.STONE } }],
  ]) {
    assert.equal(world.prepareMutation(changes), null);
    assert.equal(world.edits.size, 0);
    assert.equal(world.get(0, 8, 0), BLOCK.AIR);
  }
  const beforeAdmission = world.prepareMutation([valid], {
    reads: [{ x: 16, y: 8, z: 0, before: null }],
  });
  assert.ok(beforeAdmission);
  world._generateSync(1, 0);
  assert.equal(world.commitMutation(beforeAdmission), false);
  assert.equal(
    world.edits.size,
    0,
    "a formerly unavailable prerequisite changed"
  );
  const mutable = changeCell(world, 0, 8, 0, { id: BLOCK.COPPER_BLOCK });
  const detached = world.prepareMutation([mutable]);
  mutable.after.id = BLOCK.GLASS;
  mutable.before.id = BLOCK.STONE;
  assert.equal(world.commitMutation(detached), true);
  assert.equal(world.get(0, 8, 0), BLOCK.COPPER_BLOCK);
});

test("incarnations and epochs invalidate plans even when all cell bytes match", (t) => {
  const world = fixtureWorld(t);
  const original = world.chunks.get("0,0");
  const plan = world.prepareMutation([
    changeCell(world, 0, 8, 0, { id: BLOCK.STONE }),
  ]);
  world._removeChunk("0,0", original);
  const replacement = world._generateSync(0, 0);
  assert.ok(replacement.incarnation > original.incarnation);
  assert.equal(replacement.revision, original.revision);
  assert.equal(world.commitMutation(plan), false);
  const beforeSwitch = world.prepareMutation([
    changeCell(world, 0, 8, 0, { id: BLOCK.STONE }),
  ]);
  const epoch = world.epoch;
  world.setDimension("nether");
  assert.ok(world.epoch > epoch);
  assert.equal(world.commitMutation(beforeSwitch), false);
});

test("mesh tickets include AO neighbors without advancing their cell revisions", (t) => {
  const world = fixtureWorld(t).generate(1);
  world.clearDirty();
  const center = world.chunks.get("0,0");
  const neighbor = world.chunks.get("1,1");
  assert.equal(
    world.applyCells([
      changeCell(world, 15, 15, 15, { id: BLOCK.COPPER_BLOCK }),
      changeCell(world, 14, 15, 15, { id: BLOCK.STONE }),
    ]),
    true
  );
  assert.equal(center.revision, 1);
  assert.equal(
    center.sectionRevisions.get(0),
    1,
    "one revision per touched section"
  );
  assert.equal(center.sectionRevisions.get(1), 0);
  assert.equal(neighbor.revision, 0);
  assert.equal(neighbor.sectionRevisions.get(0), 0);
  assert.equal(world.dirtySectionRevisions.size, 8);
  const ticket = world.dirtySectionRevisions.get("1,1,1");
  assert.ok(ticket > 0);
  world.set(15, 15, 15, BLOCK.GLASS);
  const nextTicket = world.dirtySectionRevisions.get("1,1,1");
  assert.ok(nextTicket > ticket);
  assert.equal(world.acknowledgeSectionMesh(1, 1, 1, ticket), false);
  assert.equal(world.acknowledgeSectionMesh(1, 1, 1, nextTicket), true);
  assert.equal(
    world.dirtyChunks.has("1,1"),
    true,
    "another section is still dirty"
  );
  assert.equal(
    world.acknowledgeSectionMesh(
      1,
      1,
      0,
      world.dirtySectionRevisions.get("1,1,0")
    ),
    true
  );
  assert.equal(world.dirtyChunks.has("1,1"), false);
  world.markDirty(17, 17);
  assert.equal(neighbor.revision, 0);
  assert.equal(
    [...neighbor.sectionRevisions.keys()].every((sy) =>
      world.dirtySectionRevisions.has(`1,1,${sy}`)
    ),
    true
  );
  world._removeChunk("1,1", neighbor);
  assert.equal(
    [...world.dirtySectionRevisions.keys()].some((key) =>
      key.startsWith("1,1,")
    ),
    false
  );
});

for (const [coordinate, affected] of [
  [-2, [-1, 0]],
  [1, [-1, 0]],
  [2, [0]],
  [13, [0]],
  [14, [0, 1]],
  [17, [0, 1]],
]) {
  test(`two-cell mesh apron at ${coordinate} dirties neighbors without changing their revisions`, (t) => {
    const world = fixtureWorld(t, { generatorVersion: 4 }).generate(1);
    world.clearDirty();
    assert.equal(
      world.set(coordinate, coordinate, coordinate, BLOCK.STONE),
      true
    );
    const expected = new Set();
    for (const cx of affected)
      for (const cz of affected)
        for (const sy of affected) expected.add(`${cx},${cz},${sy}`);
    assert.deepEqual(new Set(world.dirtySectionRevisions.keys()), expected);
    const owner = Math.floor(coordinate / 16);
    for (const chunk of world.chunks.values()) {
      const changed = chunk.cx === owner && chunk.cz === owner;
      assert.equal(chunk.revision, Number(changed));
      for (const [sy, revision] of chunk.sectionRevisions)
        assert.equal(revision, Number(changed && sy === owner));
    }
  });
}

test("legacy unloaded sets retain complete deltas and do not generate or wake fluid work", (t) => {
  let notifications = 0;
  const world = new World("unloaded-cells", {
    useWorker: false,
    generatorFactory: emptyFixtureGenerator,
    onMutation: () => notifications++,
  });
  t.after(() => world.dispose());
  assert.equal(world.getCell(1, 5, 1), null);
  assert.equal(world.getBlockState(1, 5, 1), 0);
  assert.equal(world.getFluid(1, 5, 1), F.NONE);
  assert.equal(world.set(1, 5, 1, BLOCK.WATER), true);
  const usage = world.coordinator.usage(world);
  assert.equal(world.set(1, 5, 1, BLOCK.WATER), false);
  assert.equal(world.coordinator.usage(world), usage);
  assert.equal(world.chunks.size, 0);
  assert.equal(world.get(1, 5, 1), BLOCK.AIR);
  const saved = world.serialize();
  assert.equal(world.loadEdits(saved), true);
  world.generate(0);
  assert.equal(
    notifications,
    1,
    "load/admission must not wake historical fluids"
  );
  assert.equal(world.getFluid(1, 5, 1), F.WATER_SOURCE);
  assert.equal(world.chunks.get("0,0").sections.size, 0);
  assert.equal(world.set(1, 5, 1, BLOCK.AIR), true);
  assert.equal(
    world.edits.size,
    0,
    "the admitted generated original is now known"
  );
});

test("staged edit replacement preserves generated auxiliary originals and rejects bad loads", (t) => {
  const world = fixtureWorld(t, { generatorVersion: 4 });
  world.applyCells([
    changeCell(world, 2, -17, 2, {
      id: BLOCK.OAK_STAIRS,
      state: 3 | S.TOP,
      fluid: F.WATER_SOURCE,
    }),
  ]);
  const saved = world.serialize();
  const chunk = world.chunks.get("0,0");
  const epoch = world.epoch;
  const usage = world.coordinator.usage(world);
  for (const invalid of [
    {
      ...saved,
      edits: [...saved.edits, ["nether", 0, -1, 0, BLOCK.STONE, 0, 0]],
    },
    { ...saved, edits: [["overworld", 0, 320, 0, BLOCK.STONE, 0, 0]] },
    {
      ...saved,
      edits: [["overworld", 0, -5, 0, BLOCK.STONE, 0, F.WATER_SOURCE]],
    },
    { ...saved, edits: new Array(MAX_EDITS + 1) },
  ]) {
    assert.equal(world.loadEdits(invalid), false);
    assert.equal(world.epoch, epoch);
    assert.equal(world.chunks.get("0,0"), chunk);
    assert.equal(world.coordinator.usage(world), usage);
    assert.deepEqual(world.serialize(), saved);
  }
  world.set(2, -17, 2, BLOCK.COPPER_BLOCK);
  world.set(3, -17, 2, BLOCK.COPPER_BLOCK);
  assert.equal(world.loadEdits(saved), true);
  assert.deepEqual(world.serialize(), saved);
  assert.deepEqual(world.getCell(2, -17, 2), {
    id: BLOCK.OAK_STAIRS,
    state: 3 | S.TOP,
    fluid: F.WATER_SOURCE,
  });
  assert.equal(world.get(3, -17, 2), BLOCK.AIR);
  const restored = world.chunks.get("0,0");
  assert.equal(
    restored.originals.get(cellIndex(2, -17, 2, world.spec)).id,
    BLOCK.AIR
  );
});

test("invalid candidate generation rejects before resetting chunks, epochs or reservations", (t) => {
  const world = fixtureWorld(t, {
    generatorFactory: (seed, dimension, version) => {
      const generator = emptyFixtureGenerator(seed, dimension, version);
      return {
        ...generator,
        generateChunk(cx, cz) {
          const chunk = generator.generateChunk(cx, cz);
          if (version === 4) chunk.blocks[0] = 999;
          return chunk;
        },
      };
    },
  });
  world.set(1, 8, 1, BLOCK.COPPER_BLOCK);
  const before = world.serialize();
  const chunk = world.chunks.get("0,0");
  const epoch = world.epoch;
  const bytes = world.coordinator.usage(world);
  assert.equal(world.loadEdits({ ...before, generatorVersion: 4 }), false);
  assert.equal(world.epoch, epoch);
  assert.equal(world.chunks.get("0,0"), chunk);
  assert.equal(world.coordinator.usage(world), bytes);
  assert.deepEqual(world.serialize(), before);
});

test("over-budget adopted progress allows reversions but refuses capacity growth", (t) => {
  const world = fixtureWorld(t);
  const saved = {
    ...world.serialize(),
    edits: [["overworld", 1, 5, 1, BLOCK.COPPER_BLOCK, 0, 0]],
  };
  const other = {};
  assert.equal(world.coordinator.register(other, MAX_RESERVED_BYTES), true);
  assert.equal(world.loadEdits(saved), true);
  assert.ok(world.coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
  assert.equal(world.set(2, 5, 1, BLOCK.GLASS), false);
  assert.deepEqual(world.serialize(), saved);
  assert.equal(world.set(1, 5, 1, BLOCK.AIR), true);
  assert.equal(world.coordinator.usage(world), 0);
  assert.equal(world.coordinator.budget.totalBytes, MAX_RESERVED_BYTES);
});
