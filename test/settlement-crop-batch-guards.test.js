import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { CROP_GROW_SECONDS, Settlement } from "../src/settlement.js";
import { stationKey } from "../src/settlement-state.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  cropBatchFixture,
  prepareCropRemoval,
} from "./settlement-crop-batch-fixture.js";

test("invalid, duplicate, out-of-bounds and mismatched expected cells reject without source or destination effects", (t) => {
  const f = cropBatchFixture(t);
  const plants = f.plants();
  const before = f.snapshot();
  for (const invalid of [
    null,
    {},
    [],
    [null],
    [plants[0], plants[0]],
    [{ ...plants[0], x: 7.5 }],
    [{ ...plants[0], x: 30_000_000 }],
    [{ ...plants[0], z: -30_000_001 }],
    [{ ...plants[0], y: f.world.spec.minY }],
    [{ ...plants[0], y: f.world.spec.maxY }],
    [{ ...plants[0], world: {} }],
    [{ ...plants[0], dimension: "nether" }],
    [{ ...plants[0], epoch: f.world.epoch + 1 }],
    [{ ...plants[0], before: null }],
    [{ ...plants[0], before: { id: BLOCK.TALL_GRASS, state: 0, fluid: 0 } }],
    [{ ...plants[0], before: { ...plants[0].before, state: 1 } }],
    [
      {
        ...plants[0],
        before: { ...plants[0].before, fluid: FLUID.WATER_SOURCE },
      },
    ],
  ]) {
    assert.equal(f.settlement.prepareRemoveCrops(f.world, invalid), null);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.settlement._busy, false);
  }
});

test("bounded array slots never execute a caller-supplied iterator", (t) => {
  const f = cropBatchFixture(t);
  const plants = [...f.plants()];
  let iterated = false;
  Object.defineProperty(plants, Symbol.iterator, {
    value: () => {
      iterated = true;
      throw new Error("unbounded caller iterator");
    },
  });
  Object.freeze(plants);
  const before = f.snapshot();
  const source = f.settlement.prepareRemoveCrops(f.world, plants);
  assert.ok(source);
  assert.equal(source.drops.length, 3);
  assert.equal(iterated, false);
  assert.deepEqual(f.snapshot(), before);
});

test("unloaded crops never generate cells or invent missing crop records", (t) => {
  const f = cropBatchFixture(t);
  const plants = f.plants();
  const chunk = f.world.chunks.get("0,0");
  f.world._removeChunk("0,0", chunk);
  const unloaded = f.snapshot();
  const generate = t.mock.method(f.world, "_generateSync", () =>
    assert.fail("crop preparation cannot generate")
  );
  assert.equal(f.settlement.prepareRemoveCrops(f.world, plants), null);
  assert.deepEqual(f.snapshot(), unloaded);
  generate.mock.restore();
  f.world._generateSync(0, 0);
  f.settlement.crops.delete("overworld:9,1,8");
  const missing = f.snapshot();
  assert.equal(f.settlement.prepareRemoveCrops(f.world, plants), null);
  assert.deepEqual(f.snapshot(), missing);
  assert.equal(f.settlement.crops.has("overworld:9,1,8"), false);
});

test("crop maturity, coordinates and immutable owned data are validated against the real seedling or wheat cell", (t) => {
  const f = cropBatchFixture(t);
  const plants = f.plants();
  const key = "overworld:7,1,8";
  const owned = f.settlement.crops.get(key);
  const invalidRecords = [
    null,
    {},
    { ...owned },
    Object.freeze({ ...owned, dimension: "nether" }),
    Object.freeze({ ...owned, x: 8 }),
    Object.freeze({ ...owned, y: owned.y + 1 }),
    Object.freeze({ ...owned, z: 0 }),
    Object.freeze({ ...owned, age: NaN }),
    Object.freeze({ ...owned, age: Infinity }),
    Object.freeze({ ...owned, age: -1 }),
    Object.freeze({ ...owned, age: CROP_GROW_SECONDS + 1 }),
    Object.freeze({ ...owned, age: 0 }),
    Object.freeze({
      ...owned,
      get age() {
        return CROP_GROW_SECONDS;
      },
    }),
  ];
  for (const invalid of invalidRecords) {
    f.settlement.crops.set(key, invalid);
    const before = f.snapshot();
    assert.equal(f.settlement.prepareRemoveCrops(f.world, plants), null);
    assert.deepEqual(f.snapshot(), before);
  }
  f.settlement.crops.set(key, owned);
  assert.ok(f.settlement.prepareRemoveCrops(f.world, plants));
});

test("an actual cell inconsistent with crop age, a cleared cell, or missing farmland cannot produce planned loot", (t) => {
  for (const [x, y, block] of [
    [7, 1, BLOCK.TALL_GRASS],
    [9, 1, BLOCK.WHEAT_CROP],
    [7, 1, BLOCK.AIR],
    [7, 0, BLOCK.DIRT],
  ]) {
    const f = cropBatchFixture(t);
    f.put(x, y, 8, block);
    const before = f.snapshot();
    assert.equal(f.settlement.prepareRemoveCrops(f.world, f.plants()), null);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("crop batch bounds use the active dimension and historical editable-soil restrictions", (t) => {
  for (const options of [
    {
      crops: [
        { x: -1, y: -63 },
        { x: 16, y: 319 },
      ],
    },
    { generatorVersion: 3, crops: [{ x: 7, y: 2 }] },
    {
      dimension: "nether",
      crops: [
        { x: 7, y: 1 },
        { x: 9, y: 255 },
      ],
    },
    { dimension: "end", crops: [{ x: 7, y: 1 }] },
  ]) {
    const f = cropBatchFixture(t, options);
    const plants = f.plants();
    const source = f.settlement.prepareRemoveCrops(f.world, plants);
    assert.ok(source);
    assert.equal(source.participant.validate(), true);
    assert.deepEqual(
      source.drops.map(({ x, y, z }) => [x, y, z]),
      plants.map(({ x, y, z }) => [x, y, z])
    );
  }
});

test("same-seed foreign Worlds and foreign coordinators cannot debit bound crop ownership", (t) => {
  const f = cropBatchFixture(t);
  const sameCoordinator = cropBatchFixture(t, { coordinator: f.coordinator });
  const foreignCoordinator = cropBatchFixture(t);
  const before = f.snapshot();
  for (const other of [sameCoordinator, foreignCoordinator]) {
    assert.equal(other.world.seed, f.world.seed);
    assert.equal(
      f.settlement.prepareRemoveCrops(other.world, other.plants()),
      null
    );
    assert.deepEqual(f.snapshot(), before);
  }
});

test("detached ownership must bind the real World explicitly, without a lazy migration or binding on crop preparation", (t) => {
  for (const withContext of [false, true]) {
    const f = cropBatchFixture(t, { crops: [{ x: 7, y: 5 }] });
    const saved = f.settlement.serialize();
    f.settlement.dispose();
    const settlement = new Settlement({
      coordinator: f.coordinator,
      context: withContext ? f.context : undefined,
    });
    t.after(() => settlement.dispose());
    assert.equal(settlement.load(saved), true);
    assert.equal(settlement.context !== undefined, withContext);
    assert.equal(settlement._world, null);
    const bytes = f.coordinator.budget.totalBytes;
    const serialized = t.mock.method(settlement, "serialize", () =>
      assert.fail(
        "bounded source preparation cannot migrate an unbound archive"
      )
    );
    assert.equal(settlement.prepareRemoveCrops(f.world, f.plants()), null);
    assert.equal(settlement._world, null);
    assert.equal(serialized.mock.callCount(), 0);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
    serialized.mock.restore();
    assert.equal(settlement.bindWorld(f.world), true);
    assert.ok(settlement.prepareRemoveCrops(f.world, f.plants()));
  }
});

test("unregistered or disposed owners reject before crop preparation without acquiring new reservations", (t) => {
  for (const target of ["world", "settlement"]) {
    const f = cropBatchFixture(t);
    const plants = f.plants();
    const owner = f[target];
    const bytes = f.coordinator.usage(owner);
    assert.equal(f.coordinator.release(owner), true);
    const before = f.snapshot();
    assert.equal(f.settlement.prepareRemoveCrops(f.world, plants), null);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.coordinator.usage(owner), undefined);
    assert.equal(f.coordinator.register(owner, bytes), true);
    owner.dispose();
    assert.equal(f.settlement.prepareRemoveCrops(f.world, plants), null);
  }
});

test("preparation rejects reentry and releases its guard after malformed input", (t) => {
  const f = cropBatchFixture(t);
  const plants = f.plants();
  const before = f.snapshot();
  const getCell = f.world.getCell.bind(f.world);
  let nested;
  let visited = false;
  t.mock.method(f.world, "getCell", (...args) => {
    if (!visited) {
      visited = true;
      nested = f.settlement.prepareRemoveCrops(f.world, plants);
    }
    return getCell(...args);
  });
  assert.ok(f.settlement.prepareRemoveCrops(f.world, plants));
  assert.equal(nested, null);
  assert.equal(f.settlement._busy, false);
  assert.equal(
    f.settlement.prepareRemoveCrops(f.world, [
      {
        ...plants[0],
        get before() {
          throw new Error("invalid caller data");
        },
      },
    ]),
    null
  );
  assert.equal(f.settlement._busy, false);
  assert.deepEqual(f.snapshot(), before);
});

test("cell ABA, support changes, chunk re-admission, dimension changes and reload invalidate the source participant as well as World", (t) => {
  for (const stale of ["cell", "support", "chunk", "dimension", "epoch"]) {
    const f = cropBatchFixture(t);
    const plan = prepareCropRemoval(f);
    assert.ok(plan);
    if (stale === "cell") {
      f.put(7, 1, 8, BLOCK.AIR);
      f.put(7, 1, 8, BLOCK.WHEAT_CROP);
    } else if (stale === "support") {
      f.put(7, 0, 8, BLOCK.DIRT);
    } else if (stale === "chunk") {
      const chunk = f.world.chunks.get("0,0");
      f.world._removeChunk("0,0", chunk);
      f.world._generateSync(0, 0);
    } else if (stale === "dimension") {
      f.world.setDimension("nether");
    } else {
      const epoch = f.world.epoch;
      assert.equal(f.world.loadEdits(f.world.serialize()), true);
      assert.ok(f.world.epoch > epoch);
    }
    const before = f.snapshot();
    assert.equal(plan.source.participant.validate(), false, stale);
    assert.equal(f.coordinator.commit(plan.participants).ok, false, stale);
    assert.deepEqual(f.snapshot(), before, stale);
  }
});

test("same-size record/store replacements, revisions, context, bindings and read-method changes veto every owner", (t) => {
  const mutations = [
    [
      "reload",
      (f) => {
        assert.equal(
          f.settlement.load(f.settlement.serialize(), { world: f.world }),
          true
        );
      },
    ],
    [
      "record",
      (f) => {
        f.settlement.crops.set(
          "overworld:7,1,8",
          Object.freeze({
            ...f.settlement.crops.get("overworld:7,1,8"),
          })
        );
      },
    ],
    [
      "revision",
      (f) => {
        f.settlement._revision++;
      },
    ],
    [
      "context",
      (f) => {
        f.settlement.context = createWorldContext(f.world);
      },
    ],
    [
      "binding",
      (f) => {
        f.settlement._world = null;
      },
    ],
    [
      "crops",
      (f) => {
        f.settlement.crops = new Map(f.settlement.crops);
      },
    ],
    [
      "chests",
      (f) => {
        f.settlement.chests = new Map(f.settlement.chests);
      },
    ],
    [
      "furnaces",
      (f) => {
        f.settlement.furnaces = new Map(f.settlement.furnaces);
      },
    ],
    [
      "record-bytes",
      (f) => {
        f.settlement._recordBytes = new Map(f.settlement._recordBytes);
      },
    ],
    [
      "water",
      (f) => {
        f.settlement._water = new Map(f.settlement._water);
      },
    ],
    [
      "chest-views",
      (f) => {
        f.settlement._chestViews = new Map(f.settlement._chestViews);
      },
    ],
    [
      "chunks",
      (f) => {
        f.world.chunks = new Map(f.world.chunks);
      },
    ],
    [
      "chunk-revision",
      (f) => {
        f.world.chunks.get("0,0").revision++;
      },
    ],
    [
      "edit-revision",
      (f) => {
        f.world._editRevision++;
      },
    ],
    [
      "getCell",
      (f) => {
        f.world.getCell = f.world.getCell.bind(f.world);
      },
    ],
    [
      "isLoaded",
      (f) => {
        f.world.isLoaded = f.world.isLoaded.bind(f.world);
      },
    ],
    [
      "world-coordinator",
      (f) => {
        f.world.coordinator = new TransactionCoordinator();
      },
    ],
    [
      "settlement-coordinator",
      (f) => {
        f.settlement.coordinator = new TransactionCoordinator();
      },
    ],
    [
      "busy",
      (f) => {
        f.settlement._busy = true;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const f = cropBatchFixture(t);
    const plan = prepareCropRemoval(f);
    assert.ok(plan);
    mutate(f);
    const before = f.snapshot();
    assert.equal(plan.source.participant.validate(), false, name);
    assert.equal(f.coordinator.commit(plan.participants).ok, false, name);
    assert.deepEqual(f.snapshot(), before, name);
    f.world.coordinator = f.coordinator;
    f.settlement.coordinator = f.coordinator;
    f.settlement._busy = false;
  }
});

test("a same-sized conflicting container store and changed record-byte reservation cannot hide behind equal Settlement bytes", (t) => {
  for (const stale of ["container", "record-bytes"]) {
    const f = cropBatchFixture(t);
    f.put(14, 1, 8, BLOCK.CHEST);
    assert.ok(f.settlement.getChest(f.world, { x: 14, y: 1, z: 8 }));
    const plan = prepareCropRemoval(f);
    assert.ok(plan);
    const key = stationKey(f.world.dimension, 7, 1, 8);
    if (stale === "container") {
      const containerKey = stationKey(f.world.dimension, 14, 1, 8);
      const chest = f.settlement.chests.get(containerKey);
      f.settlement.chests.delete(containerKey);
      f.settlement.chests.set(key, chest);
    } else {
      f.settlement._recordBytes.set(
        key,
        f.settlement._recordBytes.get(key) + 1
      );
    }
    const before = f.snapshot();
    assert.equal(plan.source.participant.validate(), false);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.settlement.prepareRemoveCrops(f.world, f.plants()), null);
  }
});
