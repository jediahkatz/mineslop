import assert from "node:assert/strict";
import test from "node:test";
import {
  DropOverflow,
  normalizeOverflowSnapshot,
} from "../src/drop-overflow.js";
import { cloneSlots } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  DROP_POSITION as at,
  pickupFixture,
  PreparedInventoryFixture,
} from "./metadata-fixture.js";

const named = (name, count = 1) => ({
  id: ITEM.APPLE,
  count,
  data: { version: 1, name },
});
const tool = (wear = 7, efficiency = 3) => ({
  id: ITEM.IRON_PICKAXE,
  count: 1,
  durability: wear,
  data: {
    version: 1,
    enchantments: { efficiency, unbreaking: 2 },
    name: "矿:洞|west",
  },
});
const entry = (stack, extra = {}) => ({
  ...stack,
  ...at,
  dimension: "overworld",
  ...extra,
});
const key = (overflow) => overflow.entries.keys().next().value;
const exactBytes = (overflow) => {
  assert.equal(
    overflow.reservedBytes,
    encodedBytes(overflow.serialize().entries) - 2
  );
  assert.equal(overflow.coordinator.usage(overflow), overflow.reservedBytes);
};
const fixture = (t, options = {}) => {
  const result = pickupFixture(t, options);
  const overflow = new DropOverflow({
    coordinator: result.coordinator,
    context: result.world,
    maxEntries: options.maxEntries,
  });
  t.after(() => overflow.dispose());
  return { ...result, overflow };
};

test("overflow kind keys are unambiguous for separator names and canonical enchantment order", (t) => {
  const { overflow } = fixture(t);
  const names = ["a:b", "a|b", 'a",null]', 'a",["b', "矿:洞|west"];
  assert.equal(
    overflow.addBatch(names.map((name) => entry(named(name)))),
    true
  );
  assert.equal(overflow.size, names.length);
  assert.equal(overflow.addBatch([entry(named(names[0], 2))]), true);
  assert.deepEqual(
    overflow.serialize().entries.map((record) => record.count),
    [3, 1, 1, 1, 1]
  );
  assert.equal(
    overflow.addBatch([
      entry({ ...tool(7), count: 3, durability: [7, 17, 7] }),
      entry({
        ...tool(7),
        data: {
          name: "矿:洞|west",
          version: 1,
          enchantments: { unbreaking: 2, efficiency: 3 },
        },
      }),
      entry(tool(7, 2)),
    ]),
    true
  );
  const tools = overflow
    .serialize()
    .entries.filter((record) => record.id === ITEM.IRON_PICKAXE);
  assert.deepEqual(
    tools.map((record) => [record.wear, record.count]),
    [
      [7, 3],
      [17, 1],
      [7, 1],
    ]
  );
  exactBytes(overflow);
});

test("overflow enqueue and save normalization preserve legacy wear arrays plus detached metadata", (t) => {
  const { overflow } = fixture(t);
  const loot = { ...tool(7), count: 3, durability: [7, 17, 7] };
  assert.equal(
    overflow.enqueue([loot, named("fruit", 3)], at, "overworld"),
    true
  );
  loot.data.enchantments.efficiency = 1;
  loot.durability[0] = 1;
  const saved = JSON.parse(JSON.stringify(overflow.serialize()));
  const restored = fixture(t).overflow;
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  const normalized = normalizeOverflowSnapshot(saved);
  assert.deepEqual(normalized, saved);
  saved.entries[0].data.name = "changed import";
  normalized.entries[1].data.enchantments.efficiency = 1;
  assert.equal(restored.serialize().entries[0].data.name, "矿:洞|west");
  assert.equal(restored.serialize().entries[1].data.enchantments.efficiency, 3);
  assert.equal(restored.serialize().entries[0].wear, 7);
  exactBytes(restored);
});

test("count, record-capacity, metadata and budget failures leave all existing records unchanged", (t) => {
  const { overflow, coordinator } = fixture(t, { maxEntries: 2 });
  overflow.addBatch([entry(named("retained", 9))]);
  const before = overflow.serialize();
  for (const batch of [
    [entry(named("retained")), entry(named("second")), entry(named("third"))],
    [
      entry(named("retained")),
      entry({ ...named("bad"), data: { version: 2 } }),
    ],
    [entry(named("retained")), entry({ ...tool(7), count: 2, durability: 7 })],
    [
      entry(named("retained")),
      entry({
        ...named("bad"),
        data: { version: 1, enchantments: { efficiency: 1 } },
      }),
    ],
  ]) {
    assert.equal(overflow.addBatch(batch), false);
    assert.deepEqual(overflow.serialize(), before);
    exactBytes(overflow);
  }
  const padding = {};
  assert.equal(
    coordinator.register(
      padding,
      MAX_RESERVED_BYTES - coordinator.budget.totalBytes
    ),
    true
  );
  const budgetBefore = coordinator.budget.totalBytes;
  assert.equal(
    overflow.addBatch([entry(named("retained"))]),
    false,
    "9 -> 10 grows the changed record"
  );
  assert.deepEqual(overflow.serialize(), before);
  assert.equal(coordinator.budget.totalBytes, budgetBefore);
  exactBytes(overflow);
  const invalidSave = {
    version: 1,
    entries: [
      before.entries[0],
      { ...before.entries[0], data: { version: 3 } },
    ],
  };
  assert.equal(overflow.load(invalidSave), false);
  assert.deepEqual(overflow.serialize(), before);
});

test("safe-integer aggregate rejection cannot publish earlier decorated merges", (t) => {
  const { overflow } = fixture(t);
  overflow.addBatch([entry(named("max", Number.MAX_SAFE_INTEGER))]);
  const before = overflow.serialize();
  assert.equal(
    overflow.addBatch([entry(named("new")), entry(named("max"))]),
    false
  );
  assert.deepEqual(overflow.serialize(), before);
  exactBytes(overflow);
});

test("prepared retention is atomic with source debit and notifications cannot turn success into rejection", (t) => {
  const { overflow, pickups, coordinator } = fixture(t);
  const slots = Array(36).fill(null);
  slots[0] = tool(7);
  const inventory = new PreparedInventoryFixture(coordinator, slots);
  const retained = overflow.prepareEnqueue([tool(7)], at, "overworld");
  const refusedDebit = inventory.prepare(
    (next) => {
      next[0] = null;
      return true;
    },
    { valid: () => false }
  );
  const before = {
    inventory: cloneSlots(inventory.slots),
    overflow: overflow.serialize(),
    pickups: pickups.serialize(),
  };
  assert.equal(coordinator.commit([retained, refusedDebit]).ok, false);
  assert.deepEqual(inventory.slots, before.inventory);
  assert.deepEqual(overflow.serialize(), before.overflow);
  assert.deepEqual(pickups.serialize(), before.pickups);
  let notices = 0;
  const observerFailure = new Error("fixture observer failure");
  overflow.onChange = () => {
    notices++;
    assert.equal(inventory.slots[0], null);
    assert.equal(pickups.size, 0, "publishing retention never eagerly flushes");
    exactBytes(overflow);
    throw observerFailure;
  };
  const debit = inventory.prepare((next) => {
    next[0] = null;
    return true;
  });
  const result = coordinator.commit([retained, debit]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, [observerFailure]);
  assert.equal(notices, 1);
  assert.equal(inventory.slots[0], null);
  assert.equal(overflow.serialize().entries[0].wear, 7);
  assert.deepEqual(overflow.serialize().entries[0].data, tool(7).data);
  assert.equal(coordinator.commit([retained]).ok, false);
});

test("same-byte mutations and reloads invalidate prepared overflow participants", (t) => {
  const { overflow, coordinator } = fixture(t);
  overflow.addBatch([entry(named("retained", 1))]);
  const planned = overflow.prepareAddBatch([entry(named("planned"))]);
  const bytes = overflow.reservedBytes;
  overflow.addBatch([entry(named("retained", 1))]);
  assert.equal(overflow.reservedBytes, bytes);
  const changed = overflow.serialize();
  assert.equal(coordinator.commit([planned]).ok, false);
  assert.deepEqual(overflow.serialize(), changed);
  const beforeReload = overflow.prepareAddBatch([entry(named("planned"))]);
  assert.equal(overflow.load(changed), true);
  assert.equal(coordinator.commit([beforeReload]).ok, false);
  assert.deepEqual(overflow.serialize(), changed);
});

test("shared flush transfers every metadata kind and worn duplicate without flattening arrays", (t) => {
  const { overflow, pickups, world } = fixture(t);
  const velocity = { x: 3, y: 2, z: -1 };
  overflow.enqueue(
    [
      named("one", 3),
      named("two", 2),
      { ...tool(7), count: 3, durability: [7, 17, 7] },
    ],
    at,
    "overworld",
    { pickupDelay: 2, velocity }
  );
  for (let iteration = 0; iteration < 4 && overflow.size; iteration++)
    overflow.flush(world, pickups);
  assert.equal(overflow.size, 0);
  const records = pickups.serialize().items;
  assert.deepEqual(
    records
      .filter((record) => record.id === ITEM.APPLE)
      .map((record) => [record.data.name, record.count]),
    [
      ["one", 3],
      ["two", 2],
    ]
  );
  const tools = records.filter((record) => record.id === ITEM.IRON_PICKAXE);
  assert.deepEqual(
    tools.flatMap((record) => record.durability).sort((a, b) => a - b),
    [7, 7, 17]
  );
  for (const record of records) {
    assert.equal(record.pickupDelay, 2);
    assert.deepEqual(record.velocity, velocity);
    if (record.id === ITEM.IRON_PICKAXE)
      assert.deepEqual(record.data, tool(7).data);
  }
  exactBytes(overflow);
});

test("prepared flush rejects stale pickup/overflow/world prerequisites with no orphan on either side", (t) => {
  const { overflow, pickups, world, coordinator } = fixture(t);
  overflow.enqueue([named("retained", 5)], at, "overworld");
  const stalePickup = overflow.prepareFlushRecord(
    key(overflow),
    world,
    pickups
  );
  assert.ok(stalePickup);
  pickups.spawn(ITEM.COAL, 1, at);
  const afterPickup = {
    overflow: overflow.serialize(),
    pickups: pickups.serialize(),
  };
  assert.equal(coordinator.commit(stalePickup.participants).ok, false);
  assert.deepEqual(overflow.serialize(), afterPickup.overflow);
  assert.deepEqual(pickups.serialize(), afterPickup.pickups);

  const staleOverflow = overflow.prepareFlushRecord(
    key(overflow),
    world,
    pickups
  );
  overflow.enqueue([named("retained", 1)], at, "overworld");
  const afterOverflow = overflow.serialize();
  assert.equal(coordinator.commit(staleOverflow.participants).ok, false);
  assert.deepEqual(overflow.serialize(), afterOverflow);
  assert.deepEqual(pickups.serialize(), afterPickup.pickups);

  const staleWorld = overflow.prepareFlushRecord(key(overflow), world, pickups);
  world.loaded = false;
  assert.equal(coordinator.commit(staleWorld.participants).ok, false);
  assert.deepEqual(overflow.serialize(), afterOverflow);
  assert.deepEqual(pickups.serialize(), afterPickup.pickups);
  world.loaded = true;
  const ready = overflow.prepareFlushRecord(key(overflow), world, pickups);
  assert.equal(coordinator.commit(ready.participants).ok, true);
  assert.equal(overflow.size, 0);
  assert.deepEqual(pickups.getStack(1), named("retained", 6));
  exactBytes(overflow);
});

test("flush budget admission aggregates released capacity before either participant publishes", (t) => {
  const { overflow, pickups, world, coordinator } = fixture(t);
  overflow.enqueue([tool(7)], at, "overworld");
  const padding = {};
  coordinator.register(
    padding,
    MAX_RESERVED_BYTES - coordinator.budget.totalBytes
  );
  const planned = overflow.prepareFlushRecord(key(overflow), world, pickups);
  const before = {
    overflow: overflow.serialize(),
    pickups: pickups.serialize(),
    total: coordinator.budget.totalBytes,
  };
  assert.equal(coordinator.commit(planned.participants).ok, false);
  assert.deepEqual(overflow.serialize(), before.overflow);
  assert.deepEqual(pickups.serialize(), before.pickups);
  assert.equal(coordinator.budget.totalBytes, before.total);
  const usage = coordinator.usage(padding);
  const release = {
    owner: padding,
    beforeBytes: usage,
    afterBytes: usage - 4096,
    validate: () => true,
    publish: () => {},
  };
  assert.equal(coordinator.commit([...planned.participants, release]).ok, true);
  assert.equal(overflow.size, 0);
  assert.deepEqual(pickups.getStack(0), tool(7));
});

test("staged over-budget imports retain complete metadata and can free space through an existing pickup merge", (t) => {
  const { overflow, pickups, world, coordinator } = fixture(t);
  pickups.spawnStack(named("retained", 63), at);
  const padding = {};
  coordinator.register(
    padding,
    MAX_RESERVED_BYTES - coordinator.budget.totalBytes
  );
  const snapshot = { version: 1, entries: [entry(named("retained", 1))] };
  assert.equal(overflow.load(snapshot), false);
  assert.equal(overflow.size, 0);
  assert.equal(overflow.load(snapshot, { allowOverBudget: true }), true);
  const saved = overflow.serialize();
  assert.ok(coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
  assert.equal(overflow.enqueue([named("extra")], at, "overworld"), false);
  assert.deepEqual(overflow.serialize(), saved);
  assert.equal(overflow.flush(world, pickups), 1);
  assert.equal(overflow.size, 0);
  assert.deepEqual(pickups.getStack(0), named("retained", 64));
  assert.equal(coordinator.budget.totalBytes, MAX_RESERVED_BYTES);
});

test("legacy raw sinks remain plain adapters and cannot erase decorated overflow", (t) => {
  const { overflow, world } = fixture(t);
  overflow.enqueue(
    [named("keep"), { id: ITEM.COAL, count: 2 }],
    at,
    "overworld"
  );
  const received = [];
  assert.equal(
    overflow.flush(world, {
      spawn: (...args) => {
        received.push(args);
        return true;
      },
    }),
    1
  );
  assert.equal(received[0][0], ITEM.COAL);
  assert.equal(received.length, 1);
  assert.equal(overflow.size, 1);
  assert.deepEqual(overflow.serialize().entries[0].data, named("keep").data);
  exactBytes(overflow);
});
