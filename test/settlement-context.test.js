import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { createFurnace } from "../src/furnace.js";
import { ITEM } from "../src/items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  CHEST_SLOTS,
  normalizeSettlementSnapshot,
  Settlement,
} from "../src/settlement.js";
import { stationKey, stationRecordBytes } from "../src/settlement-state.js";
import { TransactionCoordinator } from "../src/transactions.js";
import {
  createWorldContext,
  DIMENSIONS,
  getWorldSpec,
} from "../src/world-spec.js";
import {
  containerFixture,
  dropCollector,
  moveIntoContainer,
} from "./container-fixture.js";

const contextFor = (generatorVersion) =>
  createWorldContext({ seed: "station-context-fixture", generatorVersion });
const tool = () => ({
  id: ITEM.IRON_PICKAXE,
  count: 1,
  durability: 7,
  data: {
    version: 1,
    name: "Mine 雨",
    enchantments: { efficiency: 3, unbreaking: 2 },
    repairCost: 5,
  },
});

function savedStations(context, version = 3) {
  const chests = [];
  const furnaces = [];
  const crops = [];
  for (const dimension of DIMENSIONS) {
    const spec = context.specForDimension(dimension);
    const bottom = spec.minY + (context.generatorVersion === 4 ? 0 : 1);
    const slots = Array(CHEST_SLOTS).fill(null);
    slots[0] = tool();
    slots[1] = {
      id: ITEM.BOOK,
      count: 2,
      data: { version: 1, name: "Library" },
    };
    slots[2] = { id: BLOCK.DEEPSLATE, count: 3 };
    chests.push({ dimension, x: -30_000_000, y: bottom, z: 29_999_999, slots });
    furnaces.push({
      dimension,
      x: 2,
      y: spec.maxY - 1,
      z: 2,
      ...createFurnace(),
      slots: [
        null,
        null,
        {
          id: ITEM.IRON_INGOT,
          count: 2,
          data: { version: 1, name: "Retained result" },
        },
      ],
      burnTime: 17.25,
      burnDuration: 80,
      experience: 2,
    });
    crops.push({ dimension, x: 3, y: bottom + 1, z: 3, age: 12.75 });
  }
  return { version, chests, furnaces, crops };
}

test("contextual v3 stations use each dimension's signed build bounds and preserve real sparse IDs", () => {
  const context = contextFor(4);
  const saved = savedStations(context);
  const settlement = new Settlement({ context });
  assert.equal(settlement.load(saved, { context }), true);
  assert.deepEqual(settlement.serialize(), saved);
  assert.deepEqual(
    saved.chests.map(({ dimension, y }) => [dimension, y]),
    [
      ["overworld", -64],
      ["nether", 0],
      ["end", 0],
    ]
  );
  assert.deepEqual(
    saved.furnaces.map(({ dimension, y }) => [dimension, y]),
    [
      ["overworld", 319],
      ["nether", 255],
      ["end", 255],
    ]
  );
  const restored = new Settlement({ context });
  assert.equal(
    restored.load(JSON.parse(JSON.stringify(settlement.serialize()))),
    true
  );
  assert.deepEqual(restored.serialize(), saved);
  const detached = restored.serialize();
  detached.chests[0].slots[0].data.enchantments.efficiency = 1;
  detached.furnaces[0].slots[2].data.name = "Not the stored output";
  assert.deepEqual(restored.serialize(), saved);
  saved.chests[0].slots[0].durability = 1;
  saved.chests[0].slots[0].data.name = "Changed input";
  assert.deepEqual(restored.serialize().chests[0].slots[0], tool());
});

test("all historical generators retain their bottom-layer and height restrictions", () => {
  for (const generatorVersion of [1, 2, 3]) {
    const context = contextFor(generatorVersion);
    const settlement = new Settlement({ context });
    const valid = savedStations(context, 2);
    assert.equal(settlement.load(valid), true);
    const before = settlement.serialize();
    assert.equal(before.version, 3);
    for (const dimension of DIMENSIONS) {
      for (const y of [-64, -1, 0, 96, 255]) {
        const invalid = structuredClone(valid);
        invalid.chests.find((entry) => entry.dimension === dimension).y = y;
        assert.equal(settlement.load(invalid), false);
        assert.deepEqual(settlement.serialize(), before);
      }
    }
  }
});

test("negative-Y crops require an editable soil cell and inactive dimensions cannot borrow Overworld bounds", () => {
  const context = contextFor(4);
  const settlement = new Settlement({ context });
  const valid = savedStations(context);
  assert.equal(settlement.load(valid), true);
  const before = settlement.serialize();
  const bytes = settlement.reservedBytes;
  for (const [field, dimension, y] of [
    ["chests", "overworld", -65],
    ["furnaces", "overworld", 320],
    ["crops", "overworld", -64],
    ["chests", "nether", -1],
    ["furnaces", "nether", 256],
    ["crops", "nether", 0],
    ["chests", "end", -64],
    ["furnaces", "end", 319],
    ["crops", "end", 0],
  ]) {
    const invalid = structuredClone(valid);
    invalid[field].find((entry) => entry.dimension === dimension).y = y;
    assert.equal(settlement.load(invalid), false);
    assert.deepEqual(settlement.serialize(), before);
    assert.equal(settlement.reservedBytes, bytes);
  }
});

test("malformed contexts fail before replacing state or registering an owner", () => {
  const context = contextFor(4);
  const settlement = new Settlement({ context });
  const saved = savedStations(context);
  assert.equal(settlement.load(saved), true);
  const before = settlement.serialize();
  const bytes = settlement.reservedBytes;
  const malformed = [
    null,
    false,
    [],
    {},
    "overworld",
    { ...context, seed: 42 },
    { ...context, generatorVersion: 8 },
    { ...context, specForDimension: null },
    { ...context, specForDimension: async () => getWorldSpec(4, "overworld") },
    { ...context, specForDimension: () => getWorldSpec(4, "overworld") },
    { ...context, specForDimension: () => ({ minY: 10, maxY: 2 }) },
    {
      ...context,
      specForDimension: () => {
        throw new Error("Missing dimension");
      },
    },
  ];
  for (const invalid of malformed) {
    const coordinator = new TransactionCoordinator();
    assert.throws(() => new Settlement({ coordinator, context: invalid }));
    assert.equal(coordinator.budget.totalBytes, 0);
    assert.equal(settlement.load(saved, { context: invalid }), false);
    assert.deepEqual(settlement.serialize(), before);
    assert.equal(settlement.reservedBytes, bytes);
  }
});

test("the pure v3 normalizer detaches records and rejects invalid metadata without partial migration", () => {
  const context = contextFor(3);
  const saved = savedStations(context, 2);
  const normalized = normalizeSettlementSnapshot(saved, context);
  assert.equal(normalized.version, 3);
  assert.deepEqual(normalized.chests[0].slots[0], tool());
  normalized.chests[0].slots[0].data.enchantments.efficiency = 1;
  assert.equal(saved.chests[0].slots[0].data.enchantments.efficiency, 3);
  for (const corrupt of [
    (data) => {
      data.chests[1].slots[0].data.version = 2;
    },
    (data) => {
      data.furnaces[2].slots[2].data = { version: 1, unknown: true };
    },
    (data) => {
      data.chests[0].slots[0].durability = 0;
    },
    (data) => {
      data.furnaces[0].slots[1] = {
        id: ITEM.COAL,
        count: 1,
        data: { version: 1, name: "Do not burn" },
      };
    },
    (data) => {
      data.chests[2].x = 30_000_000;
    },
    (data) => {
      data.crops[0].y = 2.5;
    },
  ]) {
    const invalid = structuredClone(saved);
    corrupt(invalid);
    assert.equal(normalizeSettlementSnapshot(invalid, context), null);
  }
});

test("load adopts one reservation, invalidates prepared plans, and disposal releases replaced owners", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, tool());
  const saved = f.settlement.serialize();
  const retained = dropCollector(f.coordinator);
  const plan = f.settlement.prepareRemoveContainer(f.world, f.hit, {
    prepareDrops: retained.prepareDrops,
  });
  assert.ok(plan);
  const total = f.coordinator.budget.totalBytes;
  const cost = f.settlement.reservedBytes;
  assert.equal(f.settlement.load(saved, { world: f.world }), true);
  assert.equal(f.coordinator.budget.totalBytes, total);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(retained.drops, []);
  assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.CHEST);
  f.settlement.dispose();
  assert.equal(f.coordinator.usage(f.settlement), undefined);
  assert.equal(f.coordinator.budget.totalBytes, total - cost);
  assert.equal(f.settlement.load(saved), false);
  const replacement = new Settlement({
    coordinator: f.coordinator,
    context: f.context,
  });
  assert.equal(replacement.load(saved, { world: f.world }), true);
  assert.equal(f.coordinator.budget.totalBytes, total);
  assert.deepEqual(replacement.serialize(), saved);
});

test("progress uses bounded overhead and does not serialize the whole settlement each tick", () => {
  const f = containerFixture("furnace");
  moveIntoContainer(f, 0, { id: ITEM.RAW_IRON, count: 2 });
  moveIntoContainer(f, 1, { id: ITEM.COAL, count: 2 });
  f.settlement.update(0.25, f.world); // Ignite once: variable fuel count changes.
  const before = f.settlement.reservedBytes;
  const key = f.settlement.chestKey(f.world, f.hit.x, f.hit.y, f.hit.z);
  const recordCost = f.settlement._recordBytes.get(key);
  const serialize = f.settlement.serialize;
  f.settlement.serialize = () => {
    throw new Error("Whole-save serialization during progress");
  };
  for (let index = 0; index < 20; index++) {
    assert.equal(f.settlement.update(0.03125, f.world), true);
    assert.equal(f.settlement.reservedBytes, before);
    assert.equal(f.settlement._recordBytes.get(key), recordCost);
  }
  assert.equal(f.settlement.update(10, f.world), true);
  f.settlement.serialize = serialize;
  const saved = f.settlement.serialize();
  const record = saved.furnaces[0];
  assert.equal(
    f.settlement.reservedBytes,
    stationRecordBytes(
      "furnace",
      stationKey(record.dimension, record.x, record.y, record.z),
      record
    ) - 1
  );
  const envelope = encodedBytes({
    version: 3,
    chests: [],
    furnaces: [],
    crops: [],
  });
  assert.ok(f.settlement.reservedBytes + envelope >= encodedBytes(saved));
});

test("capacity refuses new station records before consuming source items", () => {
  const f = containerFixture();
  f.game.add(BLOCK.DIRT, 1);
  const blocker = {};
  assert.equal(
    f.coordinator.register(
      blocker,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const before = f.snapshot();
  const total = f.coordinator.budget.totalBytes;
  assert.equal(
    f.settlement.transferToChest(f.world, f.hit, f.game, BLOCK.DIRT),
    false
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.coordinator.budget.totalBytes, total);
  f.coordinator.release(blocker);
  assert.equal(
    f.settlement.transferToChest(f.world, f.hit, f.game, BLOCK.DIRT),
    true
  );
});

test("validated over-budget loads retain everything, allow bounded progress, and still permit freeing ownership", () => {
  const f = containerFixture("furnace");
  const { dimension, x, y, z } = f.hit;
  const saved = {
    version: 3,
    chests: [],
    crops: [],
    furnaces: [
      {
        dimension,
        x,
        y,
        z,
        ...createFurnace(),
        slots: [
          { id: ITEM.RAW_IRON, count: 3 },
          { id: ITEM.COAL, count: 1 },
          null,
        ],
        recipeId: "iron_ingot",
        burnTime: 10,
        burnDuration: 80,
        cookTime: 1,
      },
    ],
  };
  const blocker = {};
  assert.equal(
    f.coordinator.register(
      blocker,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const before = f.settlement.serialize();
  assert.equal(f.settlement.load(saved), false);
  assert.deepEqual(f.settlement.serialize(), before);
  assert.equal(f.settlement.load(saved, { allowOverBudget: true }), true);
  assert.deepEqual(f.settlement.serialize(), saved);
  assert.ok(f.coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
  const bytes = f.settlement.reservedBytes;
  assert.equal(f.settlement.update(0.25, f.world), true);
  assert.equal(f.settlement.reservedBytes, bytes);
  assert.equal(f.game.addStack({ id: ITEM.BOOK, count: 1 }), false);
  const retained = dropCollector(f.coordinator);
  const total = f.coordinator.budget.totalBytes;
  const result = f.settlement.removeFurnace(f.world, f.hit, {
    prepareDrops: retained.prepareDrops,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(retained.drops, [
    { id: ITEM.RAW_IRON, count: 3 },
    { id: ITEM.COAL, count: 1 },
  ]);
  assert.equal(f.settlement.reservedBytes, 0);
  assert.ok(f.coordinator.budget.totalBytes < total);
  f.coordinator.release(blocker);
});
