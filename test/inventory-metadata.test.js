import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  applySlotAction,
  cloneOwnedInventory,
  countPlainSlots,
  countSlots,
  countStackKind,
  emptyOwnedInventory,
  returnInputs,
  takeItem,
  takeStackKind,
  validOwnedInventory,
} from "../src/inventory-domain.js";
import {
  clickStackSlot,
  cloneSlots,
  cloneStack,
  insertStack,
  isValidSlots,
  splitStackPayload,
  splitStacks,
  takeStack,
} from "../src/inventory-slots.js";
import { stackIdentity } from "../src/item-stack-data.js";
import { getItem, ITEM } from "../src/items.js";

const named = (name) => ({ version: 1, name });
const stack = (id, count = 1, data, durability = getItem(id).durability) => ({
  id,
  count,
  ...(durability === undefined ? {} : { durability }),
  ...(data === undefined ? {} : { data: structuredClone(data) }),
});
const enchanted = {
  version: 1,
  enchantments: { efficiency: 3, unbreaking: 2 },
  name: "Mine:west",
};
const fullBag = () => Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
const ownership = (stacks) => {
  const counts = new Map();
  for (const entry of stacks.filter(Boolean)) {
    const key = JSON.stringify([
      stackIdentity(entry),
      entry.durability ?? null,
    ]);
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
};
const ownedStacks = (draft) => [
  ...draft.slots,
  draft.cursor,
  draft.offhand,
  ...Object.values(draft.equipment),
  ...draft.craftingGrid,
];

test("real bootstrap paper/book catalog items round-trip plain and named stacks without ID-range assumptions", () => {
  // Lead supplies these actual definitions at the joint checkpoint; no fake IDs.
  for (const id of [ITEM.PAPER, ITEM.BOOK]) {
    assert.ok(getItem(id), "bootstrap catalog definition must be present");
    const slots = [stack(id, 2), null];
    assert.equal(insertStack(slots, stack(id, 3, named("archive"))), null);
    assert.deepEqual(slots, [stack(id, 2), stack(id, 3, named("archive"))]);
    assert.deepEqual(takeStack(slots, 1, 2), stack(id, 2, named("archive")));
    assert.equal(Object.hasOwn(cloneStack(slots[0]), "data"), false);
    assert.deepEqual(slots[1], stack(id, 1, named("archive")));
  }
});

test("slot insertion merges only exact names and returns a detached partial remainder", () => {
  const slots = [
    stack(ITEM.APPLE, 63, named("A:B")),
    stack(ITEM.APPLE, 63, named("A|B")),
    stack(ITEM.APPLE, 63),
  ];
  const incoming = stack(ITEM.APPLE, 4, named("A:B"));
  const remainder = insertStack(slots, incoming);
  assert.deepEqual(
    slots.map((entry) => entry.count),
    [64, 63, 63]
  );
  assert.equal(remainder.count, 3);
  assert.deepEqual(remainder.data, incoming.data);
  remainder.data.name = "changed remainder";
  incoming.data.name = "changed input";
  assert.equal(slots[0].data.name, "A:B");
  const before = cloneSlots(slots);
  const failed = insertStack(slots, stack(ITEM.APPLE, 3, named("elsewhere")));
  assert.equal(failed.count, 3);
  assert.deepEqual(slots, before);
});

test("split/take/right-click/merge/swap retain metadata with no cross-owner aliases", () => {
  const slots = [
    stack(ITEM.APPLE, 5, named("fruit")),
    null,
    stack(ITEM.APPLE, 2, named("other")),
  ];
  let result = clickStackSlot(slots, 0, null, 2);
  assert.equal(result.cursor.count, 3);
  assert.equal(slots[0].count, 2);
  result.cursor.data.name = "fruit-copy";
  assert.equal(slots[0].data.name, "fruit");
  result = clickStackSlot(slots, 1, result.cursor, 2);
  assert.equal(slots[1].count, 1);
  result.cursor.data.name = "cursor-only";
  assert.equal(slots[1].data.name, "fruit-copy");
  result = clickStackSlot(slots, 2, result.cursor, 0);
  assert.equal(result.cursor.data.name, "other");
  assert.equal(slots[2].data.name, "cursor-only");
  const part = takeStack(slots, 0, 1);
  part.data.name = "detached take";
  assert.equal(slots[0].data.name, "fruit");
});

test("legacy durability arrays with metadata split every tool without repairing or flattening it", () => {
  const payload = {
    id: ITEM.IRON_PICKAXE,
    count: 3,
    durability: [3, 17, 91],
    data: structuredClone(enchanted),
  };
  const copies = splitStackPayload(payload);
  assert.deepEqual(
    copies.map((entry) => entry.durability),
    [3, 17, 91]
  );
  assert.deepEqual(
    copies.map((entry) => entry.data),
    Array(3).fill(enchanted)
  );
  copies[0].data.enchantments.efficiency = 1;
  assert.equal(copies[1].data.enchantments.efficiency, 3);
  assert.equal(payload.data.enchantments.efficiency, 3);
  assert.equal(payload.durability[0], 3);
  assert.deepEqual(
    splitStackPayload(stack(ITEM.IRON_PICKAXE, 1, enchanted, 5)),
    [stack(ITEM.IRON_PICKAXE, 1, enchanted, 5)]
  );
  for (const bad of [
    { ...payload, count: 2 },
    { ...payload, durability: 3 },
    { ...payload, data: { version: 2 } },
    { ...payload, data: { version: 1, enchantments: { protection: 1 } } },
    { id: ITEM.APPLE, count: 2, durability: [1, 2], data: named("fruit") },
  ])
    assert.equal(splitStackPayload(bad), null);
  assert.equal(splitStackPayload(payload, 2), null);
  assert.ok(
    splitStacks(ITEM.IRON_PICKAXE, 2, [3, 17]).every(
      (entry) => !Object.hasOwn(entry, "data")
    )
  );
});

test("owned inventory cloning covers cursor, offhand, every armor slot, grid and finite slots", () => {
  const draft = emptyOwnedInventory();
  draft.slots[0] = stack(ITEM.IRON_PICKAXE, 1, enchanted, 7);
  draft.cursor = stack(ITEM.APPLE, 2, named("cursor"));
  draft.offhand = stack(
    ITEM.SHIELD,
    1,
    { version: 1, enchantments: { unbreaking: 2 } },
    13
  );
  for (const [slot, id] of [
    ["head", ITEM.IRON_HELMET],
    ["chest", ITEM.IRON_ARMOR],
    ["legs", ITEM.IRON_LEGGINGS],
    ["feet", ITEM.IRON_BOOTS],
  ])
    draft.equipment[slot] = stack(
      id,
      1,
      { version: 1, enchantments: { protection: 2 } },
      9
    );
  draft.craftingGrid[0] = stack(ITEM.COAL, 4, named("escrow"));
  assert.equal(validOwnedInventory(draft), true);
  const copy = cloneOwnedInventory(draft);
  assert.deepEqual(copy, draft);
  copy.slots[0].data.enchantments.efficiency = 1;
  copy.offhand.data.enchantments.unbreaking = 1;
  copy.equipment.head.data.enchantments.protection = 1;
  copy.cursor.data.name = "different";
  copy.craftingGrid[0].data.name = "different";
  assert.equal(draft.slots[0].data.enchantments.efficiency, 3);
  assert.equal(draft.offhand.data.enchantments.unbreaking, 2);
  assert.equal(draft.equipment.head.data.enchantments.protection, 2);
  assert.equal(draft.cursor.data.name, "cursor");
  assert.equal(draft.craftingGrid[0].data.name, "escrow");
});

test("slot actions carry named/enchanted ownership through equipment, offhand, grid and drops", () => {
  const draft = emptyOwnedInventory();
  draft.slots[0] = stack(
    ITEM.IRON_HELMET,
    1,
    { version: 1, enchantments: { protection: 2 } },
    5
  );
  draft.slots[1] = stack(
    ITEM.SHIELD,
    1,
    { version: 1, name: "Aegis", enchantments: { unbreaking: 2 } },
    8
  );
  draft.slots[2] = stack(ITEM.IRON_PICKAXE, 1, enchanted, 7);
  draft.slots[3] = stack(ITEM.APPLE, 9, named("orchard"));
  const expected = ownership(ownedStacks(draft));
  assert.equal(
    applySlotAction(draft, { type: "quickMove", area: "inventory", index: 0 })
      .ok,
    true
  );
  assert.equal(draft.equipment.head.durability, 5);
  assert.equal(
    applySlotAction(draft, { type: "quickMove", area: "inventory", index: 1 })
      .ok,
    true
  );
  assert.equal(draft.offhand.data.name, "Aegis");
  assert.equal(
    applySlotAction(draft, { type: "swapOffhand", area: "inventory", index: 2 })
      .ok,
    true
  );
  assert.equal(draft.offhand.durability, 7);
  assert.deepEqual(draft.offhand.data, enchanted);
  assert.equal(
    applySlotAction(draft, {
      type: "click",
      area: "inventory",
      index: 3,
      button: 0,
    }).ok,
    true
  );
  assert.equal(
    applySlotAction(draft, {
      type: "distribute",
      button: 2,
      targets: [
        { area: "crafting", index: 0 },
        { area: "inventory", index: 9 },
      ],
    }).ok,
    true
  );
  assert.equal(draft.craftingGrid[0].data.name, "orchard");
  assert.equal(
    applySlotAction(draft, { type: "collect", area: "inventory", index: 9 }).ok,
    true
  );
  assert.equal(draft.cursor.count, 9);
  const dropped = applySlotAction(draft, {
    type: "drop",
    area: "offhand",
    index: 0,
    wholeStack: true,
  });
  assert.deepEqual(dropped.drops, [stack(ITEM.IRON_PICKAXE, 1, enchanted, 7)]);
  assert.deepEqual(
    ownership([...ownedStacks(draft), ...dropped.drops]),
    expected
  );
  assert.equal(validOwnedInventory(draft), true);
});

test("collect ignores differently decorated stacks, and rejected equipment/capacity actions retain all records", () => {
  const draft = emptyOwnedInventory();
  draft.slots = fullBag();
  draft.slots[0] = stack(ITEM.APPLE, 4, named("other"));
  draft.cursor = stack(ITEM.APPLE, 2, named("fruit"));
  assert.equal(
    applySlotAction(draft, { type: "collect", area: "inventory", index: 0 }).ok,
    true
  );
  assert.equal(draft.cursor.count, 2);
  const before = cloneOwnedInventory(draft);
  for (const action of [
    { type: "click", area: "equipment", index: 0, button: 0 },
    { type: "quickMove", area: "inventory", index: 0 },
    { type: "drop", area: "cursor", index: 0, wholeStack: "yes" },
    {
      type: "distribute",
      button: 2,
      targets: [
        { area: "inventory", index: 0 },
        { area: "unknown", index: 0 },
      ],
    },
  ]) {
    assert.equal(applySlotAction(draft, action).ok, false);
    assert.deepEqual(draft, before);
  }
});

test("escrow close returns fitting portions and retains decorated overflow including worn tools", () => {
  const draft = emptyOwnedInventory();
  draft.slots = fullBag();
  draft.slots[0] = stack(ITEM.APPLE, 63, named("fruit"));
  draft.cursor = stack(ITEM.APPLE, 3, named("fruit"));
  draft.craftingGrid[0] = stack(ITEM.IRON_PICKAXE, 1, enchanted, 5);
  const expected = ownership(ownedStacks(draft));
  const drops = returnInputs(draft);
  assert.equal(draft.slots[0].count, 64);
  assert.deepEqual(drops, [
    stack(ITEM.APPLE, 2, named("fruit")),
    stack(ITEM.IRON_PICKAXE, 1, enchanted, 5),
  ]);
  assert.equal(draft.cursor, null);
  assert.ok(draft.craftingGrid.every((entry) => entry === null));
  assert.deepEqual(ownership([...ownedStacks(draft), ...drops]), expected);
  drops[0].data.name = "different drop";
  assert.equal(draft.slots[0].data.name, "fruit");
});

test("ID adapters count/spend plain items only; explicit kind consumption preserves other decorations", () => {
  const slots = [
    stack(ITEM.APPLE, 4, named("fruit")),
    stack(ITEM.APPLE, 2),
    stack(ITEM.APPLE, 3, named("other")),
  ];
  assert.equal(countSlots(slots).get(ITEM.APPLE), 9);
  assert.equal(countPlainSlots(slots).get(ITEM.APPLE), 2);
  assert.equal(
    countStackKind(slots, { id: ITEM.APPLE, data: named("fruit") }),
    4
  );
  const before = cloneSlots(slots);
  assert.equal(takeItem(slots, ITEM.APPLE, 3, 0), false);
  assert.deepEqual(slots, before);
  assert.equal(takeItem(slots, ITEM.APPLE, 2, 0), true);
  assert.equal(slots[1], null);
  assert.equal(slots[0].count, 4);
  assert.equal(
    takeStackKind(slots, { id: ITEM.APPLE, data: named("fruit") }, 2),
    true
  );
  assert.deepEqual(slots[0], stack(ITEM.APPLE, 2, named("fruit")));
  assert.deepEqual(slots[2], before[2]);
  assert.equal(isValidSlots(slots), true);
});

test("metadata validation failure cannot partially merge, split or edit an owned draft", () => {
  const slots = [stack(ITEM.APPLE, 63, named("fruit")), null];
  const before = cloneSlots(slots);
  const bad = stack(ITEM.APPLE, 2, { version: 99, name: "fruit" });
  assert.throws(() => insertStack(slots, bad), RangeError);
  assert.throws(() => clickStackSlot(slots, 0, bad, 0), RangeError);
  assert.deepEqual(slots, before);
  const draft = emptyOwnedInventory();
  draft.cursor = bad;
  const serialized = JSON.stringify(draft);
  assert.equal(applySlotAction(draft, { type: "close" }).ok, false);
  assert.equal(JSON.stringify(draft), serialized);
  const copy = cloneStack(before[0]);
  copy.data.name = "copy";
  assert.equal(before[0].data.name, "fruit");
});
