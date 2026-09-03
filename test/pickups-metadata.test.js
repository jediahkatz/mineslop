import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { cloneSlots } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import {
  MAX_PICKUPS,
  normalizePickupSnapshot,
  PICKUP_RECORD_RESERVED_BYTES,
  validatePickups,
} from "../src/pickups.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  DROP_POSITION as at,
  pickupFixture,
  PreparedInventoryFixture,
  STILL_MOTION as velocity,
} from "./metadata-fixture.js";

const named = (name, count = 1) => ({
  id: ITEM.APPLE,
  count,
  data: { version: 1, name },
});
const tool = (wear = 17, level = 3) => ({
  id: ITEM.IRON_PICKAXE,
  count: 1,
  durability: wear,
  data: {
    version: 1,
    enchantments: { efficiency: level, unbreaking: 2 },
    name: "Mine:west",
  },
});
const items = (pickups) => pickups.serialize().items;

test("spawnStack merges exact metadata kinds only and detaches names/enchantments", (t) => {
  const { pickups } = pickupFixture(t);
  const input = named('fruit:"|",', 63);
  assert.equal(pickups.spawnStack(input, at), true);
  assert.equal(pickups.spawnStack(named("other", 2), at), true);
  assert.equal(pickups.spawn(ITEM.APPLE, 1, at), true);
  assert.equal(pickups.spawnStack(named('fruit:"|",', 4), at), true);
  assert.deepEqual(
    items(pickups).map((entry) => entry.count),
    [64, 2, 1, 3]
  );
  input.data.name = "changed";
  assert.equal(items(pickups)[0].data.name, 'fruit:"|",');
  const a = tool(3);
  assert.equal(pickups.spawnStack(a, at), true);
  assert.equal(pickups.spawnStack(tool(3, 2), at), true);
  assert.equal(pickups.spawnStack(tool(19), at), true);
  a.data.enchantments.efficiency = 1;
  assert.deepEqual(
    items(pickups)
      .slice(-3)
      .map((entry) => entry.durability),
    [[3], [3], [19]]
  );
  assert.deepEqual(
    items(pickups)
      .slice(-3)
      .map((entry) => entry.data.enchantments.efficiency),
    [3, 2, 3]
  );
});

test("canonical and legacy pickup saves round-trip data without inventing it on plain records", (t) => {
  const { pickups, world } = pickupFixture(t);
  pickups.spawn(ITEM.IRON_PICKAXE, 1, at);
  pickups.spawn(ITEM.COAL, 4, at);
  pickups.spawnStack(named("saved", 3), at, { pickupDelay: 2, velocity });
  world.dimension = "nether";
  pickups.spawnStack(tool(7), at, { pickupDelay: 1, velocity });
  const saved = JSON.parse(JSON.stringify(pickups.serialize()));
  assert.equal(Object.hasOwn(saved.items[0], "data"), false);
  assert.equal(Object.hasOwn(saved.items[0], "durability"), false);
  assert.equal(Object.hasOwn(saved.items[1], "data"), false);
  const restored = pickupFixture(t).pickups;
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  const normalized = normalizePickupSnapshot(saved, world);
  assert.deepEqual(normalized, saved);
  saved.items[3].data.enchantments.efficiency = 1;
  normalized.items[2].data.name = "changed";
  assert.equal(items(restored)[3].data.enchantments.efficiency, 3);
  assert.equal(items(restored)[2].data.name, "saved");
  const copy = restored.getStack(3);
  assert.equal(copy.durability, 7);
  copy.data.name = "detached stack";
  assert.equal(restored.getStack(3).data.name, "Mine:west");
});

test("malformed metadata, ineligible payloads and legacy data options reject without partial spawns", (t) => {
  const { pickups } = pickupFixture(t);
  pickups.spawnStack(named("existing", 63), at);
  const before = pickups.serialize();
  const invalid = [
    { ...named("bad"), data: { version: 2, name: "bad" } },
    { ...named("bad"), data: { version: 1, enchantments: { unbreaking: 1 } } },
    {
      ...named("bad"),
      data: { version: 1, potion: { id: "healing", form: "drinkable" } },
    },
    { ...tool(7), durability: [7] },
  ];
  for (const stack of invalid) {
    assert.equal(pickups.spawnStack(stack, at), false);
    assert.equal(
      pickups.prepareSpawnBatch([
        { ...named("existing", 1), ...at },
        { ...stack, ...at },
      ]),
      null
    );
    assert.deepEqual(pickups.serialize(), before);
  }
  assert.equal(
    pickups.spawn(ITEM.APPLE, 1, at, { data: named("x").data }),
    false
  );
  assert.deepEqual(pickups.serialize(), before);
  const bad = { ...before.items[0], data: { version: 2 } };
  const snapshot = { version: 1, items: [before.items[0], bad] };
  assert.equal(validatePickups(snapshot), false);
  assert.equal(normalizePickupSnapshot(snapshot), null);
  assert.equal(pickups.load(snapshot), false);
  assert.deepEqual(pickups.serialize(), before);
});

test("count and reservation refusal leave pending metadata merges and every existing drop untouched", (t) => {
  const { pickups, coordinator } = pickupFixture(t);
  pickups.spawnStack(named("existing", 63), at);
  pickups.spawn(ITEM.WOOD_PICKAXE, MAX_PICKUPS - 1, at);
  const before = pickups.serialize();
  const bytes = coordinator.usage(pickups);
  assert.equal(pickups.spawnStack(named("existing", 2), at), false);
  assert.deepEqual(pickups.serialize(), before);
  assert.equal(coordinator.usage(pickups), bytes);
  assert.equal(pickups.spawnStack(named("existing", 1), at), true);

  const second = pickupFixture(t);
  const padding = {};
  assert.equal(second.coordinator.register(padding, MAX_RESERVED_BYTES), true);
  assert.equal(second.pickups.spawnStack(tool(7), at), false);
  assert.equal(second.pickups.size, 0);
  assert.equal(second.pickups.reservedBytes, 0);
  assert.equal(second.coordinator.usage(second.pickups), 0);
});

test("prepared publication is silent until all owners publish, and a rejected peer creates no orphan pickup", (t) => {
  const notices = [];
  const { pickups, coordinator } = pickupFixture(t, {
    onChange: () => notices.push(pickups.size),
  });
  const inventory = new PreparedInventoryFixture(coordinator);
  const spawn = pickups.prepareSpawnStack(tool(7), at);
  const refusal = inventory.prepare(() => true, { valid: () => false });
  assert.equal(pickups.size, 0);
  assert.deepEqual(notices, []);
  const usage = coordinator.budget.totalBytes;
  assert.equal(coordinator.commit([spawn, refusal]).ok, false);
  assert.equal(pickups.size, 0);
  assert.deepEqual(notices, []);
  assert.equal(coordinator.budget.totalBytes, usage);
  const source = inventory.prepare((slots) => {
    slots[0] = { id: ITEM.COAL, count: 1 };
    return true;
  });
  pickups.onChange = () => {
    assert.equal(inventory.slots[0].id, ITEM.COAL);
    assert.equal(coordinator.usage(pickups), PICKUP_RECORD_RESERVED_BYTES);
    notices.push(pickups.size);
  };
  assert.equal(coordinator.commit([spawn, source]).ok, true);
  assert.deepEqual(notices, [1]);
  assert.equal(
    coordinator.commit([spawn]).ok,
    false,
    "published participants are single-use"
  );
  assert.equal(pickups.size, 1);
});

test("prepared pickup work rejects same-byte reloads, motion changes, and world epochs", (t) => {
  const { pickups, world, coordinator } = pickupFixture(t);
  pickups.spawnStack(named("retained", 2), at, { velocity });
  const afterReload = pickups.prepareSpawnStack(named("planned"), at);
  assert.equal(pickups.load(pickups.serialize()), true);
  const reloaded = pickups.serialize();
  assert.equal(coordinator.commit([afterReload]).ok, false);
  assert.deepEqual(pickups.serialize(), reloaded);
  const beforeMotion = pickups.prepareTake(0, 1);
  pickups.update(0.05, 0.05, at);
  const moved = pickups.serialize();
  assert.equal(coordinator.commit([beforeMotion.participant]).ok, false);
  assert.deepEqual(pickups.serialize(), moved);
  const beforeEpoch = pickups.prepareSpawnStack(named("planned"), at);
  world.epoch++;
  assert.equal(coordinator.commit([beforeEpoch]).ok, false);
  assert.deepEqual(pickups.serialize(), moved);
});

test("partial prepared collection preserves remainder metadata and atomic full-inventory rejection", (t) => {
  const { pickups, coordinator } = pickupFixture(t);
  const slots = Array.from({ length: 36 }, () => ({
    id: BLOCK.DIRT,
    count: 64,
  }));
  slots[0] = named("fruit", 63);
  const inventory = new PreparedInventoryFixture(coordinator, slots);
  pickups.spawnStack(named("fruit", 4), at, { velocity });
  const before = pickups.serialize();
  const inventoryBefore = cloneSlots(inventory.slots);
  assert.equal(inventory.prepareAddStack(pickups.getStack(0)), null);
  assert.deepEqual(inventory.slots, inventoryBefore);
  assert.deepEqual(pickups.serialize(), before);
  const partial = pickups.prepareTake(0, 1);
  const receive = inventory.prepareAddStack(partial.stack);
  assert.equal(coordinator.commit([partial.participant, receive]).ok, true);
  assert.equal(inventory.slots[0].count, 64);
  assert.deepEqual(pickups.getStack(0), named("fruit", 3));
  partial.stack.data.name = "changed caller copy";
  assert.equal(pickups.getStack(0).data.name, "fruit");
  assert.equal(inventory.slots[0].data.name, "fruit");
  const rejected = pickups.prepareTake(0, 1);
  const noRoom = inventory.prepare(() => true, { valid: () => false });
  const retained = pickups.serialize();
  assert.equal(coordinator.commit([rejected.participant, noRoom]).ok, false);
  assert.deepEqual(pickups.serialize(), retained);
  assert.equal(inventory.slots[0].count, 64);
});

test("live pickup update hands metadata to a prepared receiver once and defers collection observers", (t) => {
  const received = [];
  const { pickups, coordinator } = pickupFixture(t);
  const inventory = new PreparedInventoryFixture(coordinator);
  pickups.onCollectStack = (stack) => {
    assert.equal(pickups.size, 0);
    assert.equal(pickups.mesh.count, 0);
    assert.deepEqual(inventory.slots[0], tool(7));
    received.push(stack);
  };
  pickups.spawnStack(tool(7), at, { velocity });
  pickups.update(0.01, 0.01, at, inventory);
  pickups.update(1, 1, at, inventory);
  assert.deepEqual(received, [tool(7)]);
  assert.equal(inventory.notifications, 1);
  assert.equal(pickups.reservedBytes, 0);
  received[0].data.enchantments.efficiency = 1;
  assert.equal(inventory.slots[0].data.enchantments.efficiency, 3);
});

test("decorated drops refuse the old ID-only collector instead of stripping metadata", (t) => {
  const { pickups } = pickupFixture(t);
  pickups.spawnStack(tool(7), at, { velocity });
  pickups.update(0.01, 0.01, at, {
    add: () =>
      assert.fail("decorated pickup must not use the plain ID adapter"),
  });
  assert.deepEqual(pickups.getStack(0), tool(7));
});

test("real Gameplay collects metadata with the shared coordinator and preserves worn instances", (t) => {
  const { pickups, coordinator, world } = pickupFixture(t);
  const gameplay = new Gameplay({ coordinator, context: world });
  t.after(() => gameplay.dispose());
  const received = [];
  pickups.onCollectStack = (stack) => {
    assert.equal(gameplay.count(stack.id), 1);
    assert.equal(pickups.size, 0);
    received.push(stack);
  };
  assert.equal(pickups.spawnStack(tool(7), at, { velocity }), true);
  pickups.update(0.01, 0.01, at, gameplay);
  pickups.update(1, 1, at, gameplay);
  assert.deepEqual(received, [tool(7)]);
  assert.deepEqual(
    gameplay.slots.find((stack) => stack?.id === ITEM.IRON_PICKAXE),
    tool(7)
  );
  const saved = gameplay.serialize();
  assert.equal(saved.version, 3);
  const restored = new Gameplay({ context: world });
  t.after(() => restored.dispose());
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
});
