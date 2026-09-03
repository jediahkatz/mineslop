import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  clickStackSlot,
  cloneSlots,
  cloneStack,
  insertStack,
  isMergeable,
  isValidSlots,
  isValidStack,
  splitStacks,
  takeStack,
} from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";

function ownership(stacks) {
  const counts = new Map();
  const tools = [];
  for (const stack of stacks) {
    if (!stack) continue;
    counts.set(stack.id, (counts.get(stack.id) ?? 0) + stack.count);
    if (stack.durability !== undefined)
      tools.push(`${stack.id}:${stack.durability}`);
  }
  return { counts: [...counts].sort(([a], [b]) => a - b), tools: tools.sort() };
}

test("canonical stacks reject malformed counts, IDs and ambiguous tool wear", () => {
  assert.equal(isValidStack({ id: ITEM.APPLE, count: 64 }), true);
  assert.equal(
    isValidStack({ id: ITEM.WOOD_PICKAXE, count: 1, durability: 7 }),
    true
  );
  for (const stack of [
    null,
    undefined,
    [],
    {},
    { id: BLOCK.AIR, count: 1 },
    { id: "285", count: 1 },
    { id: 99999, count: 1 },
    { id: ITEM.APPLE, count: 0 },
    { id: ITEM.APPLE, count: 65 },
    { id: ITEM.APPLE, count: 1.5 },
    { id: ITEM.APPLE, count: Infinity },
    { id: ITEM.APPLE, count: 1, durability: 1 },
    { id: ITEM.WOOD_PICKAXE, count: 1 },
    { id: ITEM.WOOD_PICKAXE, count: 2, durability: 7 },
    { id: ITEM.WOOD_PICKAXE, count: 1, durability: 0 },
    { id: ITEM.WOOD_PICKAXE, count: 1, durability: 7.5 },
  ])
    assert.equal(isValidStack(stack), false, JSON.stringify(stack));
});

test("left/right clicking picks up, rounds halves up, places one, merges, and swaps", () => {
  const slots = [
    { id: ITEM.APPLE, count: 5 },
    null,
    { id: BLOCK.DIRT, count: 64 },
  ];
  let result = clickStackSlot(slots, 0, null, 2);
  assert.deepEqual(result, {
    cursor: { id: ITEM.APPLE, count: 3 },
    changed: true,
  });
  assert.deepEqual(slots[0], { id: ITEM.APPLE, count: 2 });
  result = clickStackSlot(slots, 1, result.cursor, 2);
  assert.deepEqual(slots[1], { id: ITEM.APPLE, count: 1 });
  assert.equal(result.cursor.count, 2);
  result = clickStackSlot(slots, 0, result.cursor, 0);
  assert.equal(result.cursor, null);
  assert.equal(slots[0].count, 4);
  result = clickStackSlot(slots, 0, null, 0);
  result = clickStackSlot(slots, 2, result.cursor, 2);
  assert.deepEqual(result.cursor, { id: BLOCK.DIRT, count: 64 });
  assert.deepEqual(slots[2], { id: ITEM.APPLE, count: 4 });
  result = clickStackSlot(slots, 0, result.cursor, 0);
  assert.equal(result.cursor, null);
  assert.equal(slots[0].count, 64);
});

test("insertion merges before empty slots, honors indices, and returns an unaliased remainder", () => {
  const slots = [null, { id: BLOCK.DIRT, count: 63 }, null];
  const incoming = { id: BLOCK.DIRT, count: 10 };
  assert.equal(insertStack(slots, incoming, [2, 1]), null);
  assert.equal(slots[1].count, 64);
  assert.equal(slots[2].count, 9);
  assert.equal(slots[0], null);
  slots[2].count = 64;
  const before = cloneSlots(slots);
  const rest = insertStack(slots, incoming, [1, 2]);
  assert.deepEqual(rest, incoming);
  assert.notEqual(rest, incoming);
  assert.deepEqual(slots, before);
  assert.equal(insertStack(slots, incoming), null);
  incoming.count = 1;
  assert.equal(slots[0].count, 10);
});

test("each durable instance keeps its own wear through take, swap and reinsertion", () => {
  const slots = [
    { id: ITEM.IRON_PICKAXE, count: 1, durability: 7 },
    { id: ITEM.IRON_PICKAXE, count: 1, durability: 91 },
    null,
  ];
  assert.equal(isMergeable(slots[0], slots[1]), false);
  const first = takeStack(slots, 0);
  assert.equal(first.durability, 7);
  const swap = clickStackSlot(slots, 1, first, 0);
  assert.equal(swap.cursor.durability, 91);
  assert.equal(slots[1].durability, 7);
  assert.equal(insertStack(slots, swap.cursor, [2]), null);
  assert.equal(slots[2].durability, 91);
  assert.equal(slots[0], null);
});

test("helpers validate all arguments before mutating a working array", () => {
  const slots = [{ id: ITEM.APPLE, count: 63 }, null];
  const before = cloneSlots(slots);
  for (const change of [
    () => insertStack(slots, { id: ITEM.APPLE, count: 2 }, [0, 99]),
    () => insertStack(slots, { id: ITEM.APPLE, count: 2 }, [0, 0]),
    () => insertStack(slots, { id: ITEM.APPLE, count: 65 }),
    () => takeStack(slots, -1),
    () => takeStack(slots, 0, 0),
    () => clickStackSlot(slots, 0, null, 1),
    () => clickStackSlot(slots, 0, { id: ITEM.WOOD_AXE, count: 1 }, 0),
  ]) {
    assert.throws(change, RangeError);
    assert.deepEqual(slots, before);
  }
  assert.equal(isValidSlots(Array(3)), false);
});

test("aggregate splitting consumes each legacy durability entry exactly once", () => {
  assert.deepEqual(splitStacks(ITEM.APPLE, 130), [
    { id: ITEM.APPLE, count: 64 },
    { id: ITEM.APPLE, count: 64 },
    { id: ITEM.APPLE, count: 2 },
  ]);
  const wear = [2, 9, getItem(ITEM.WOOD_AXE).durability];
  const stacks = splitStacks(ITEM.WOOD_AXE, 3, wear);
  assert.deepEqual(
    stacks.map((stack) => stack.durability),
    wear
  );
  wear[0] = 1;
  assert.equal(stacks[0].durability, 2);
  assert.equal(splitStacks(ITEM.WOOD_AXE, 3, [2, 9]), null);
  assert.equal(splitStacks(ITEM.WOOD_AXE, 37), null);
  assert.equal(splitStacks(ITEM.APPLE, Number.MAX_SAFE_INTEGER), null);
  assert.equal(splitStacks(ITEM.APPLE, 1, [1]), null);
});

test("repeated stack clicks conserve exact counts and the durable-instance multiset", () => {
  const slots = [
    { id: ITEM.APPLE, count: 5 },
    { id: ITEM.APPLE, count: 63 },
    { id: BLOCK.DIRT, count: 37 },
    null,
    null,
    { id: ITEM.WOOD_AXE, count: 1, durability: 7 },
    { id: ITEM.WOOD_AXE, count: 1, durability: 17 },
    null,
    null,
  ];
  const expected = ownership(slots);
  let cursor = null;
  let seed = 119;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 300; i++) {
    cursor = clickStackSlot(
      slots,
      Math.floor(random() * slots.length),
      cursor,
      random() < 0.5 ? 0 : 2
    ).cursor;
    assert.deepEqual(ownership([...slots, cursor]), expected);
    assert.equal(isValidSlots(slots), true);
    assert.ok(cursor === null || isValidStack(cursor));
  }
  const copy = cloneSlots(slots);
  if (cursor) {
    const copiedCursor = cloneStack(cursor);
    copiedCursor.count = 0;
    assert.ok(cursor.count > 0);
  }
  for (const stack of copy) if (stack) stack.count = 0;
  assert.deepEqual(ownership([...slots, cursor]), expected);
});
