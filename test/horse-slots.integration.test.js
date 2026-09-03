import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { horseFixture, horseVeto } from "./horse-fixture.js";

function saddleNames(f) {
  return [
    ...f.gameplay.slots, f.gameplay.cursor, f.gameplay.offhand,
    ...f.horses.serialize().entries.filter((entry) => entry.alive).map((entry) => entry.saddle),
    ...f.overflow.serialize().entries,
  ].filter((stack) => stack?.id === ITEM.SADDLE)
    .flatMap((stack) => Array(stack.count).fill(stack.data?.name ?? "plain")).sort();
}

test("named saddles swap through offhand and hotbar without an overflow destination", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn());
  const a = f.saddle(horse, "First saddle");
  const b = f.hold("SADDLE", { hand: "offhand", data: { version: 1, name: "Second saddle" } });
  t.mock.method(f.overflow, "prepareEnqueue", () => assert.fail("swaps never require world drops"));
  assert.deepEqual(saddleNames(f), ["First saddle", "Second saddle"]);
  assert.equal(f.horses.slotAction(horse.id, {
    type: "swapOffhand", area: "container", index: 0,
  }).ok, true);
  assert.deepEqual(f.gameplay.offhand, a);
  assert.deepEqual(f.horses.state(horse.id).saddle, b);
  assert.equal(f.horses.slotAction(horse.id, {
    type: "swapHotbar", area: "container", index: 0, hotbarIndex: 4,
  }).ok, true);
  assert.deepEqual(f.gameplay.slots[4], b);
  assert.equal(f.horses.getHorse(horse.id).controlled, false);
  assert.equal(f.horses.slotAction(horse.id, {
    type: "swapHotbar", area: "container", index: 0, hotbarIndex: 4,
  }).ok, true);
  assert.deepEqual(f.horses.state(horse.id).saddle, b);
  assert.deepEqual(saddleNames(f), ["First saddle", "Second saddle"]);
});

test("collect and deduplicated drag place the one cursor saddle, then an explicit drop is atomic", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn()), saddle = f.saddle(horse);
  assert.equal(f.horses.slotAction(horse.id, {
    type: "collect", area: "container", index: 0,
  }).ok, true);
  assert.deepEqual(f.gameplay.cursor, saddle);
  assert.equal(f.horses.state(horse.id).saddle, null);
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots[9] = { id: BLOCK.STONE, count: 64 };
    return true;
  }), true);
  assert.equal(f.horses.slotAction(horse.id, {
    type: "distribute", button: 2, targets: [
      { area: "inventory", index: 9 },
      { area: "container", index: 0 },
      { area: "container", index: 0 },
    ],
  }).ok, true);
  assert.equal(f.gameplay.cursor, null);
  assert.deepEqual(f.horses.state(horse.id).saddle, saddle);
  const plan = f.horses.prepareSlotAction(horse.id, {
    type: "drop", area: "container", index: 0, wholeStack: true,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.participants.filter((part) => part.owner === f.overflow).length, 1);
  const before = f.ownership(), veto = horseVeto(t, f.coordinator);
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horses.commit(plan).ok, true);
  assert.equal(f.horses.state(horse.id).saddle, null);
  assert.deepEqual(saddleNames(f), [saddle.data.name]);
  assert.equal(f.horses.mountFor().id, horse.id);
  assert.equal(f.horses.getHorse(horse.id).controlled, false);
});

test("a rejected explicit saddle drop leaves the exact carried stack where it was", (t) => {
  const f = horseFixture(t, { hooks: { prepareDrops: () => null } });
  const horse = f.tame(f.spawn()), saddle = f.saddle(horse);
  for (const area of ["container", "cursor"]) {
    if (area === "cursor") assert.equal(f.horses.slotAction(horse.id, {
      type: "click", area: "container", index: 0, button: 0,
    }).ok, true);
    const before = f.ownership();
    assert.equal(f.horses.slotAction(horse.id, {
      type: "drop", area, index: 0,
    }).ok, false);
    assert.deepEqual(f.ownership(), before);
    assert.deepEqual(saddleNames(f), [saddle.data.name]);
  }
});

test("Creative saddle slots still transfer finite owned copies, never the virtual palette", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn());
  assert.equal(f.gameplay.setMode("creative"), true);
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots.fill(null);
    return true;
  }), true);
  assert.equal(f.gameplay.assignSlot(f.gameplay.selected, ITEM.SADDLE), true);
  assert.equal(f.gameplay.getHandStack().id, ITEM.SADDLE);
  const before = f.ownership();
  assert.equal(f.horses.slotAction(horse.id, {
    type: "quickMove", area: "inventory", index: f.gameplay.selected,
  }).ok, false);
  assert.deepEqual(f.ownership(), before);
  const saddle = f.hold("SADDLE", { hand: "offhand", data: { version: 1, name: "Finite in Creative" } });
  assert.equal(f.horses.slotAction(horse.id, {
    type: "quickMove", area: "offhand", index: 0,
  }).ok, true);
  assert.equal(f.gameplay.offhand, null);
  assert.deepEqual(f.horses.state(horse.id).saddle, saddle);
  assert.deepEqual(saddleNames(f), ["Finite in Creative"]);
});

test("UI session validation runs again at commit, including commands directed only at player slots", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn()), saddle = f.saddle(horse);
  let session = 1;
  const plan = f.horses.prepareSlotAction(horse.id, {
    type: "click", area: "container", index: 0, button: 0,
  }, { validate: () => session === 1 });
  assert.equal(plan.ok, true);
  session = 2;
  const before = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.deepEqual(saddleNames(f), [saddle.data.name]);
  assert.equal(f.horses.prepareSlotAction(horse.id, {
    type: "click", area: "inventory", index: 9, button: 0,
  }, { validate: () => session === 1 }).ok, false);
});
