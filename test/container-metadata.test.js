import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  applyContainerAction,
  CHEST_SLOTS,
  migrateChestItems,
  transferItem,
  transferStackKind,
} from "../src/container-slots.js";
import { createFurnace } from "../src/furnace.js";
import {
  cloneOwnedInventory,
  emptyOwnedInventory,
} from "../src/inventory-domain.js";
import { cloneSlots } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";

const data = (name) => ({ version: 1, name });
const named = (id, count, name) => ({ id, count, data: data(name) });
const tool = (wear) => ({
  id: ITEM.IRON_PICKAXE,
  count: 1,
  durability: wear,
  data: {
    version: 1,
    name: "Mine|east",
    enchantments: { efficiency: 3, unbreaking: 2 },
  },
});
const chest = () => ({ kind: "chest", slots: Array(CHEST_SLOTS).fill(null) });

test("legacy chest payloads preserve metadata on wear arrays and split aggregate materials", () => {
  const legacy = [
    named(ITEM.COAL, 65, "special"),
    { ...tool(7), count: 2, durability: [7, 19] },
    { id: BLOCK.DIRT, count: 3 },
  ];
  const slots = migrateChestItems(legacy);
  assert.deepEqual(slots.filter(Boolean), [
    named(ITEM.COAL, 64, "special"),
    named(ITEM.COAL, 1, "special"),
    tool(7),
    tool(19),
    { id: BLOCK.DIRT, count: 3 },
  ]);
  slots[0].data.name = "changed";
  slots[2].data.enchantments.efficiency = 1;
  assert.equal(slots[1].data.name, "special");
  assert.equal(slots[3].data.enchantments.efficiency, 3);
  assert.equal(legacy[0].data.name, "special");
  assert.equal(legacy[1].data.enchantments.efficiency, 3);
  for (const entry of [
    { id: ITEM.COAL, count: 1, data: { version: 2 } },
    {
      ...tool(7),
      durability: [7],
      data: { version: 1, enchantments: { protection: 1 } },
    },
  ])
    assert.equal(migrateChestItems([legacy[2], entry]), null);
});

test("partial quick transfers preserve named remainder and never merge into different names", () => {
  const container = chest();
  container.slots = Array.from({ length: CHEST_SLOTS }, () =>
    named(ITEM.COAL, 64, "other")
  );
  container.slots[0] = named(ITEM.COAL, 63, "mine");
  const owned = emptyOwnedInventory();
  owned.slots[9] = named(ITEM.COAL, 8, "mine");
  assert.equal(
    applyContainerAction(container, owned, {
      type: "quickMove",
      area: "inventory",
      index: 9,
    }).ok,
    true
  );
  assert.deepEqual(container.slots[0], named(ITEM.COAL, 64, "mine"));
  assert.deepEqual(owned.slots[9], named(ITEM.COAL, 7, "mine"));
  assert.deepEqual(container.slots[1], named(ITEM.COAL, 64, "other"));
  const before = {
    slots: cloneSlots(container.slots),
    owned: cloneOwnedInventory(owned),
  };
  assert.equal(
    applyContainerAction(container, owned, {
      type: "quickMove",
      area: "inventory",
      index: 9,
    }).ok,
    false
  );
  assert.deepEqual(container.slots, before.slots);
  assert.deepEqual(owned, before.owned);
  owned.slots[9].data.name = "detached remainder";
  assert.equal(container.slots[0].data.name, "mine");
});

test("chest click/swap/drop paths preserve each enchanted tool's wear", () => {
  const container = chest();
  container.slots[0] = tool(7);
  container.slots[1] = tool(41);
  const owned = emptyOwnedInventory();
  owned.slots[0] = tool(19);
  owned.offhand = tool(3);
  assert.equal(
    applyContainerAction(container, owned, {
      type: "swapHotbar",
      area: "container",
      index: 0,
      hotbarIndex: 0,
    }).ok,
    true
  );
  assert.deepEqual(owned.slots[0], tool(7));
  assert.deepEqual(container.slots[0], tool(19));
  assert.equal(
    applyContainerAction(container, owned, {
      type: "swapOffhand",
      area: "container",
      index: 1,
    }).ok,
    true
  );
  assert.deepEqual(owned.offhand, tool(41));
  assert.deepEqual(container.slots[1], tool(3));
  assert.equal(
    applyContainerAction(container, owned, {
      type: "click",
      area: "container",
      index: 0,
      button: 2,
    }).ok,
    true
  );
  assert.deepEqual(owned.cursor, tool(19));
  const drop = applyContainerAction(container, owned, {
    type: "drop",
    area: "container",
    index: 1,
    wholeStack: true,
  });
  assert.deepEqual(drop.drops, [tool(3)]);
  assert.equal(container.slots[1], null);
  drop.drops[0].data.enchantments.efficiency = 1;
  assert.equal(owned.offhand.data.enchantments.efficiency, 3);
});

test("cross-container distribution/collect gathers one exact kind from all escrows", () => {
  const container = chest();
  const owned = emptyOwnedInventory();
  owned.cursor = named(ITEM.APPLE, 9, "orchard");
  container.slots[4] = named(ITEM.APPLE, 5, "other");
  assert.equal(
    applyContainerAction(container, owned, {
      type: "distribute",
      button: 2,
      targets: [
        { area: "container", index: 0 },
        { area: "inventory", index: 9 },
        { area: "offhand", index: 0 },
        { area: "crafting", index: 0 },
      ],
    }).ok,
    true
  );
  assert.equal(owned.cursor.count, 5);
  for (const slot of [
    container.slots[0],
    owned.slots[9],
    owned.offhand,
    owned.craftingGrid[0],
  ])
    assert.deepEqual(slot, named(ITEM.APPLE, 1, "orchard"));
  assert.equal(
    applyContainerAction(container, owned, {
      type: "collect",
      area: "container",
      index: 0,
    }).ok,
    true
  );
  assert.deepEqual(owned.cursor, named(ITEM.APPLE, 9, "orchard"));
  assert.deepEqual(container.slots[4], named(ITEM.APPLE, 5, "other"));
  assert.equal(owned.craftingGrid[0], null);
  assert.equal(owned.offhand, null);
});

test("all-or-nothing compatibility and exact-kind transfers leave both arrays untouched on failure", () => {
  const source = [named(ITEM.APPLE, 2, "fruit"), { id: ITEM.APPLE, count: 1 }];
  const destination = [null];
  const before = {
    source: cloneSlots(source),
    destination: cloneSlots(destination),
  };
  assert.equal(transferItem(source, destination, ITEM.APPLE, 2), false);
  assert.deepEqual(source, before.source);
  assert.deepEqual(destination, before.destination);
  assert.equal(
    transferStackKind(
      source,
      destination,
      { id: ITEM.APPLE, data: data("fruit") },
      3
    ),
    false
  );
  assert.deepEqual(source, before.source);
  assert.deepEqual(destination, before.destination);
  destination[0] = named(ITEM.APPLE, 63, "fruit");
  const full = cloneSlots(destination);
  assert.equal(
    transferStackKind(
      source,
      destination,
      { id: ITEM.APPLE, data: data("fruit") },
      2
    ),
    false
  );
  assert.deepEqual(source, before.source);
  assert.deepEqual(destination, full);
  destination[0] = null;
  assert.equal(
    transferStackKind(
      source,
      destination,
      { id: ITEM.APPLE, data: data("fruit") },
      2
    ),
    true
  );
  assert.equal(source[0], null);
  assert.deepEqual(destination[0], named(ITEM.APPLE, 2, "fruit"));
  assert.deepEqual(source[1], before.source[1]);
});

test("exact-kind aggregate transfer preserves distinct worn instances without stacking them", () => {
  const source = [tool(7), tool(19)];
  const destination = [null, null];
  const before = cloneSlots(source);
  assert.equal(transferStackKind(source, destination, tool(7), 2), true);
  assert.deepEqual(destination, before);
  assert.deepEqual(source, [null, null]);
  destination[0].data.enchantments.efficiency = 1;
  assert.equal(destination[1].data.enchantments.efficiency, 3);
  assert.equal(before[0].data.enchantments.efficiency, 3);
});

test("generic furnace insertion refuses decorated ingredients/fuel; output extraction stays lossless", () => {
  const container = { ...createFurnace(), kind: "furnace" };
  const owned = emptyOwnedInventory();
  owned.cursor = named(ITEM.RAW_BEEF, 2, "keep");
  owned.slots[9] = named(ITEM.COAL, 2, "keep fuel");
  const before = {
    container: structuredClone(container),
    owned: cloneOwnedInventory(owned),
  };
  assert.equal(
    applyContainerAction(container, owned, {
      type: "click",
      area: "container",
      index: 0,
      button: 0,
    }).ok,
    false
  );
  assert.equal(
    applyContainerAction(container, owned, {
      type: "quickMove",
      area: "inventory",
      index: 9,
    }).ok,
    false
  );
  assert.deepEqual(container, before.container);
  assert.deepEqual(owned, before.owned);
  owned.cursor = null;
  container.slots[2] = named(ITEM.STEAK, 4, "owned result");
  container.experience = 4;
  const result = applyContainerAction(container, owned, {
    type: "click",
    area: "container",
    index: 2,
    button: 2,
  });
  assert.equal(result.experience, 2);
  assert.deepEqual(owned.cursor, named(ITEM.STEAK, 2, "owned result"));
  assert.deepEqual(container.slots[2], named(ITEM.STEAK, 2, "owned result"));
  owned.cursor.data.name = "cursor copy";
  assert.equal(container.slots[2].data.name, "owned result");
});
