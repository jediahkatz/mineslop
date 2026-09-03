import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { isValidStack } from "../src/inventory-slots.js";
import { stackIdentity } from "../src/item-stack-data.js";
import { getItem, ITEM } from "../src/items.js";
import {
  displayStack,
  hotbarSlotView,
  ownedSlotStacks,
  slotAddress,
  slotKeyAction,
  stackAt,
  stackDescription,
  stackDisplayName,
  stackMetadataDetails,
  uniqueSlotTargets,
} from "../src/ui/slot-model.js";

const emptySlots = () => Array(36).fill(null);

test("canonical slots win over stale totals and duplicate tools keep their own wear", () => {
  const slots = emptySlots();
  slots[0] = { id: ITEM.WOOD_PICKAXE, count: 1, durability: 12 };
  slots[1] = { id: ITEM.WOOD_PICKAXE, count: 1, durability: 51 };
  slots[9] = { id: BLOCK.DIRT, count: 7 };
  const state = {
    mode: "survival",
    hotbar: Array(9).fill(ITEM.WOOD_PICKAXE),
    counts: { [ITEM.WOOD_PICKAXE]: 500 },
    durability: { [ITEM.WOOD_PICKAXE]: 1 },
    slots,
  };
  assert.equal(hotbarSlotView(state, 0).stack.durability, 12);
  assert.equal(hotbarSlotView(state, 1).stack.durability, 51);
  assert.equal(hotbarSlotView(state, 2).stack, null);
  assert.deepEqual(ownedSlotStacks(state), slots);
  const view = ownedSlotStacks(state);
  view[0].durability = 0;
  assert.equal(
    state.slots[0].durability,
    12,
    "rendering cannot mutate ownership"
  );
});

test("hotbar stack counts are per-slot, never the aggregate total", () => {
  const slots = emptySlots();
  slots[0] = { id: ITEM.APPLE, count: 3 };
  slots[1] = { id: ITEM.APPLE, count: 6 };
  const state = { mode: "survival", slots, counts: { [ITEM.APPLE]: 9 } };
  assert.equal(hotbarSlotView(state, 0).stack.count, 3);
  assert.equal(hotbarSlotView(state, 1).stack.count, 6);
});

test("Creative's original unlimited palette is not presented as finite owned copies", () => {
  const state = {
    mode: "creative",
    slots: emptySlots(),
    creativeHotbar: [BLOCK.GLASS, ITEM.DIAMOND_PICKAXE],
    hotbar: [BLOCK.DIRT],
    counts: {},
  };
  const view = hotbarSlotView(state, 0);
  assert.equal(view.stack.id, BLOCK.GLASS);
  assert.equal(view.unlimited, true);
  assert.match(stackDescription(view.stack, view), /Unlimited palette item/);
  assert.ok(ownedSlotStacks(state).every((slot) => slot === null));
  assert.deepEqual(state.counts, {});
  assert.equal(hotbarSlotView({ ...state, mode: "survival" }, 0).stack, null);
});

test("Creative empty palette slots stay empty instead of exposing registered world AIR", () => {
  for (const palette of [
    [],
    [BLOCK.AIR],
    [null],
    [undefined],
    [-1],
    [Number.MAX_SAFE_INTEGER],
  ]) {
    const state = {
      mode: "creative",
      creativeHotbar: palette,
      hotbar: [BLOCK.GRASS],
      slots: [{ id: ITEM.APPLE, count: 4 }, ...Array(35).fill(null)],
    };
    const before = structuredClone(state);
    assert.deepEqual(hotbarSlotView(state, 0), {
      stack: null,
      unlimited: true,
    });
    assert.equal(hotbarSlotView(state, 8).stack, null);
    assert.deepEqual(
      hotbarSlotView(
        { ...state, creativeHotbar: undefined, hotbar: palette },
        0
      ),
      { stack: null, unlimited: true }
    );
    assert.deepEqual(state, before, "display does not change finite ownership");
  }
  assert.equal(hotbarSlotView({ mode: "creative" }, 0).stack, null);
});

test("AIR and invalid metadata still fail owned-stack validation and strict identity", () => {
  assert.ok(getItem(BLOCK.AIR), "AIR remains registered world content");
  for (const stack of [
    { id: BLOCK.AIR, count: 1 },
    { id: ITEM.APPLE, count: 1, data: { version: 99 } },
    {
      id: ITEM.APPLE,
      count: 1,
      data: { version: 1, enchantments: { efficiency: 1 } },
    },
  ]) {
    assert.equal(isValidStack(stack), false);
    assert.throws(() => stackIdentity(stack), RangeError);
    assert.equal(displayStack(stack), null);
    assert.equal(stackDisplayName(stack), "Empty slot");
    assert.equal(stackDescription(stack), "Empty slot");
  }
});

test("legacy aggregate projections render owned stacks without cloning duplicate shortcuts", () => {
  const state = {
    hotbar: [BLOCK.DIRT, BLOCK.DIRT, ITEM.WOOD_PICKAXE],
    inventory: [{ id: BLOCK.DIRT, count: 500 }],
    counts: { [BLOCK.DIRT]: 70, [ITEM.WOOD_PICKAXE]: 1 },
    durability: { [ITEM.WOOD_PICKAXE]: 20 },
  };
  const projected = ownedSlotStacks(state);
  assert.equal(projected.length, 36);
  assert.deepEqual(projected.slice(0, 3), [
    { id: BLOCK.DIRT, count: 64 },
    { id: BLOCK.DIRT, count: 6 },
    { id: ITEM.WOOD_PICKAXE, count: 1, durability: 20 },
  ]);
  assert.equal(projected.filter(Boolean).length, 3);
  assert.deepEqual(
    ownedSlotStacks({ counts: {}, inventory: state.inventory }),
    emptySlots()
  );
});

test("every displayed item address reads its genuine snapshot field", () => {
  const stack = { id: ITEM.APPLE, count: 2 };
  const tool = { id: ITEM.WOOD_PICKAXE, count: 1, durability: 9 };
  const state = {
    slots: [stack],
    offhand: tool,
    equipment: { chest: { id: ITEM.IRON_ARMOR, count: 1, durability: 30 } },
    craftingGrid: [stack],
    craftingResult: { id: BLOCK.PLANKS, count: 4 },
    containerSlots: [tool],
  };
  assert.deepEqual(stackAt(state, { area: "inventory", index: 0 }), stack);
  assert.deepEqual(stackAt(state, { area: "offhand", index: 0 }), tool);
  assert.equal(
    stackAt(state, { area: "equipment", index: 1 }).id,
    ITEM.IRON_ARMOR
  );
  assert.deepEqual(stackAt(state, { area: "crafting", index: 0 }), stack);
  assert.equal(stackAt(state, { area: "result", index: 0 }).count, 4);
  assert.deepEqual(stackAt(state, { area: "container", index: 0 }), tool);
  assert.equal(stackAt(state, { area: "inventory", index: 35 }), null);
});

test("invalid display stacks never become invented item counts", () => {
  for (const value of [
    null,
    {},
    { id: ITEM.APPLE, count: 0 },
    { id: ITEM.APPLE, count: NaN },
    { id: -1, count: 1 },
  ])
    assert.equal(displayStack(value), null);
  assert.equal(stackDescription(null), "Empty slot");
});

test("hovered shortcuts emit the shared action vocabulary", () => {
  const address = { area: "inventory", index: 19 };
  assert.deepEqual(slotKeyAction({ code: "Digit9" }, address), {
    type: "swapHotbar",
    ...address,
    hotbarIndex: 8,
  });
  assert.deepEqual(slotKeyAction({ code: "KeyF" }, address), {
    type: "swapOffhand",
    ...address,
  });
  assert.deepEqual(slotKeyAction({ code: "KeyQ", ctrlKey: true }, address), {
    type: "drop",
    ...address,
    wholeStack: true,
  });
  assert.equal(slotKeyAction({ code: "KeyF", repeat: true }, address), null);
  assert.equal(slotKeyAction({ code: "KeyF", metaKey: true }, address), null);
  assert.equal(slotKeyAction({ code: "KeyF", altKey: true }, address), null);
  assert.equal(slotKeyAction({ code: "Digit0" }, address), null);
  assert.equal(slotKeyAction({ code: "KeyF" }, null), null);
});

test("drag targets are unique stable addresses, excluding outputs and catalog copies", () => {
  const first = { area: "inventory", index: 3 };
  const second = { area: "container", index: 3 };
  assert.deepEqual(
    uniqueSlotTargets([
      first,
      second,
      { ...first },
      null,
      { area: "result", index: 0 },
      { area: "catalog", index: ITEM.APPLE },
    ]),
    [first, second]
  );
  assert.deepEqual(
    slotAddress({ dataset: { area: "container", index: "3" } }),
    second
  );
  assert.equal(
    slotAddress({ dataset: { area: "inventory", index: "-1" } }),
    null
  );
});

test("every canonical slot projection preserves detached metadata and literal custom names", () => {
  const stack = {
    id: ITEM.WOOD_PICKAXE,
    count: 1,
    durability: 12,
    data: {
      version: 1,
      name: "<b>A & B</b>",
      enchantments: { unbreaking: 2, efficiency: 3 },
      repairCost: 2,
    },
  };
  const state = {
    mode: "survival",
    slots: [stack],
    cursor: stack,
    offhand: stack,
    craftingGrid: [stack],
    craftingResult: stack,
    containerSlots: [stack],
  };
  for (const area of [
    "inventory",
    "cursor",
    "offhand",
    "crafting",
    "result",
    "container",
  ]) {
    const projected = stackAt(state, { area, index: 0 });
    assert.deepEqual(projected.data, stack.data);
    projected.data.name = "Changed projection";
    projected.data.enchantments.efficiency = 1;
    assert.equal(stack.data.name, "<b>A & B</b>");
    assert.equal(stack.data.enchantments.efficiency, 3);
  }
  assert.deepEqual(hotbarSlotView(state, 0).stack.data, stack.data);
  assert.equal(stackDisplayName(stack), "<b>A & B</b>");
  assert.match(stackDescription(stack), /<b>A & B<\/b>/);
  assert.match(
    stackDescription(stack),
    /Stored enchantments: Efficiency III, Unbreaking II/
  );
  assert.match(stackDescription(stack), /Prior repair cost: 2/);
  assert.equal(displayStack({ ...stack, data: { version: 999 } }), null);
});

test("schema-only potion/map descriptions expose stored data without inventing catalog items", () => {
  assert.deepEqual(
    stackMetadataDetails({
      version: 1,
      potion: { id: "healing", form: "splash", strong: true },
    }),
    ["Potion: Healing · Splash · Strong"]
  );
  assert.deepEqual(
    stackMetadataDetails({
      version: 1,
      mapTarget: {
        seed: "schema-only world",
        generatorVersion: 4,
        dimension: "overworld",
        structureId: "village:-2,3",
        x: -20,
        y: -32,
        z: 48,
      },
    }),
    [
      "Map target: village:-2,3 (Overworld)",
      "Coordinates: -20, -32, 48",
      "World: schema-only world (generator 4)",
    ]
  );
  assert.deepEqual(stackMetadataDetails(undefined), []);
  assert.throws(() => stackMetadataDetails({ version: 2 }), RangeError);
});
