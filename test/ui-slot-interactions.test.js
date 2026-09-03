import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { TransactionInvariantError } from "../src/transactions.js";
import { createEventScope } from "../src/ui/dom.js";
import { createSlotInteractions } from "../src/ui/slot-interactions.js";
import { stackAt } from "../src/ui/slot-model.js";
import { createStackSlot } from "../src/ui/slots.js";
import { preparedDropFixture } from "./prepared-drop-fixture.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

function fixture(
  t,
  { entries = [], cursor = null, mode = "survival", onAction } = {}
) {
  const { document, Node } = uiDomFixture(t);
  const container = new Node();
  const gameplay = new Gameplay({ mode });
  assert.equal(
    gameplay.inventoryTransaction((draft) => {
      draft.slots = Array(36).fill(null);
      for (const [index, stack] of entries) draft.slots[index] = stack;
      draft.cursor = cursor;
      return true;
    }),
    true
  );
  const nodes = new Map();
  const add = (area, index = 0) => {
    const slot = createStackSlot({ area, index });
    nodes.set(`${area}:${index}`, slot);
    container.append(slot.node);
    return slot.node;
  };
  for (let index = 0; index < 36; index++) add("inventory", index);
  add("offhand");
  add("equipment");
  add("result");
  const catalog = add("catalog", ITEM.APPLE);
  catalog.dataset.item = String(ITEM.APPLE);
  const scope = createEventScope();
  const actions = [];
  const statuses = [];
  const drops = [];
  const sink = preparedDropFixture(gameplay, {
    onCommit: (stacks) => drops.push(stacks),
  });
  let interactions;
  const refresh = () => {
    const state = gameplay.getState();
    for (const [key, slot] of nodes) {
      const [area, index] = key.split(":");
      slot.update(
        area === "catalog"
          ? { id: Number(index), count: 1 }
          : stackAt(state, { area, index: Number(index) }),
        { unlimited: area === "catalog" }
      );
    }
    interactions?.update();
  };
  interactions = createSlotInteractions(container, {
    listen: scope.listen,
    getState: () => gameplay.getState(),
    onAction: (action) => {
      actions.push(action);
      return onAction
        ? onAction(action, gameplay)
        : gameplay.inventoryAction(action, {
            prepareDrops: sink.prepareDrops,
          });
    },
    onStatus: (message, error) => statuses.push({ message, error }),
    onRefresh: refresh,
  });
  t.after(() => {
    interactions.dispose();
    scope.dispose();
  });
  refresh();
  let timestamp = 0;
  const fire = (type, target = container, properties = {}) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries({
      target,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      button: 0,
      detail: 1,
      timeStamp: ++timestamp * 1000,
      ...properties,
    }))
      Object.defineProperty(event, key, { value });
    document.elementFromPoint = () => target;
    container.dispatchEvent(event);
    return event;
  };
  const click = async (target, properties = {}) => {
    fire("pointerdown", target, properties);
    fire("pointerup", target, properties);
    fire("click", container, { detail: 1 });
    await Promise.resolve();
  };
  const key = async (target, code, properties = {}) => {
    const event = fire("keydown", target, { code, ...properties });
    await Promise.resolve();
    return event;
  };
  return {
    gameplay,
    container,
    document,
    Node,
    actions,
    statuses,
    drops,
    interactions,
    fire,
    click,
    key,
    refresh,
    catalog,
    slot: (index) => nodes.get(`inventory:${index}`).node,
    node: (area, index = 0) => nodes.get(`${area}:${index}`).node,
    state: () => gameplay.getState(),
  };
}

test("pointer take/half/place uses domain stacks and consumes the captured follow-up click", async (t) => {
  const f = fixture(t, { entries: [[0, { id: ITEM.APPLE, count: 5 }]] });
  let backdropClicks = 0;
  f.container.addEventListener("click", (event) => {
    if (event.target === f.container) backdropClicks++;
  });
  await f.click(f.slot(0), { button: 2 });
  assert.equal(f.state().slots[0].count, 2);
  assert.equal(f.state().cursor.count, 3);
  await f.click(f.slot(9), { button: 2 });
  await f.click(f.slot(10));
  assert.equal(f.state().slots[9].count, 1);
  assert.equal(f.state().slots[10].count, 2);
  assert.equal(f.state().cursor, null);
  assert.deepEqual(
    f.actions.map((action) => action.button),
    [2, 2, 0]
  );
  assert.equal(
    backdropClicks,
    0,
    "a pointer-captured slot click must never close its overlay"
  );
  assert.equal(f.container.getAttribute("aria-busy"), "false");
});

test("left and right drag emit one unique distribution transaction", async (t) => {
  const f = fixture(t, { cursor: { id: ITEM.APPLE, count: 12 } });
  f.fire("pointerdown", f.slot(9));
  f.fire("pointermove", f.slot(10));
  f.fire("pointermove", f.slot(11));
  f.fire("pointermove", f.slot(10));
  assert.equal(f.slot(9).classList.contains("is-drag-target"), true);
  f.fire("pointerup", f.slot(11));
  await Promise.resolve();
  assert.deepEqual(f.actions, [
    {
      type: "distribute",
      button: 0,
      targets: [9, 10, 11].map((index) => ({ area: "inventory", index })),
    },
  ]);
  assert.deepEqual(
    f
      .state()
      .slots.slice(9, 12)
      .map((stack) => stack.count),
    [4, 4, 4]
  );
  assert.equal(f.state().cursor, null);
  assert.equal(f.slot(9).classList.contains("is-drag-target"), false);
  await f.click(f.slot(9));
  f.fire("pointerdown", f.slot(18), { button: 2 });
  f.fire("pointermove", f.slot(19), { button: 2 });
  f.fire("pointerup", f.slot(19), { button: 2 });
  await Promise.resolve();
  assert.equal(f.actions.at(-1).button, 2);
  assert.equal(f.state().slots[18].count, 1);
  assert.equal(f.state().slots[19].count, 1);
  assert.equal(f.state().cursor.count, 2);
});

test("double-click collects matching stacks and leaves different tool instances alone", async (t) => {
  const f = fixture(t, {
    entries: [
      [0, { id: ITEM.APPLE, count: 3 }],
      [9, { id: ITEM.APPLE, count: 4 }],
      [10, { id: ITEM.WOOD_PICKAXE, count: 1, durability: 12 }],
    ],
  });
  await f.click(f.slot(0), { timeStamp: 1000 });
  await f.click(f.slot(0), { timeStamp: 1120 });
  assert.deepEqual(
    f.actions.map((action) => action.type),
    ["click", "collect"]
  );
  assert.equal(f.state().cursor.count, 7);
  assert.equal(f.state().slots[9], null);
  assert.equal(f.state().slots[10].durability, 12);
});

test("double-click also collects after the first click places a carried stack", async (t) => {
  const f = fixture(t, {
    entries: [[9, { id: ITEM.APPLE, count: 4 }]],
    cursor: { id: ITEM.APPLE, count: 2 },
  });
  await f.click(f.slot(0), { timeStamp: 1000 });
  assert.equal(f.state().cursor, null);
  await f.click(f.slot(0), { timeStamp: 1120 });
  assert.deepEqual(
    f.actions.map((action) => action.type),
    ["click", "collect"]
  );
  assert.equal(f.state().cursor.count, 6);
  assert.equal(f.state().slots[0], null);
  assert.equal(f.state().slots[9], null);
});

test("Shift-click and hovered number/F/Q shortcuts keep stable owned slot addresses", async (t) => {
  const f = fixture(t, { entries: [[9, { id: ITEM.APPLE, count: 7 }]] });
  await f.click(f.slot(9), { shiftKey: true });
  assert.equal(f.actions[0].type, "quickMove");
  assert.equal(f.state().slots[0].count, 7);
  f.fire("pointermove", f.slot(0));
  await f.key(f.slot(0), "Digit3");
  assert.equal(f.state().slots[2].count, 7);
  f.fire("pointermove", f.slot(2));
  await f.key(f.slot(2), "KeyF");
  assert.equal(f.state().offhand.count, 7);
  f.fire("pointermove", f.node("offhand"));
  await f.key(f.node("offhand"), "KeyQ", { ctrlKey: true });
  assert.equal(f.state().offhand, null);
  assert.deepEqual(f.drops, [[{ id: ITEM.APPLE, count: 7 }]]);
});

test("keyboard activation, recipe results and Creative catalog copies stay explicit", async (t) => {
  const f = fixture(t, { mode: "creative" });
  await f.click(f.catalog, { button: 2 });
  assert.equal(f.state().cursor.count, 1);
  f.fire("click", f.slot(9), { detail: 0 });
  await Promise.resolve();
  assert.equal(f.state().slots[9].count, 1);
  await f.click(f.catalog, { shiftKey: true });
  assert.equal(f.state().slots[0].count, 64);
  assert.deepEqual(f.actions.at(-1), {
    type: "creativePick",
    id: ITEM.APPLE,
    wholeStack: true,
    hotbarIndex: 0,
  });
  f.fire("pointermove", f.catalog);
  await f.key(f.catalog, "Digit2");
  assert.equal(f.state().slots[1].count, 64);
  assert.equal(f.state().creativeHotbar[1], ITEM.APPLE);
  assert.equal(
    f.gameplay.inventoryTransaction((draft) => {
      draft.craftingGrid[0] = { id: BLOCK.OAK_LOG, count: 1 };
      return true;
    }),
    true
  );
  f.refresh();
  await f.click(f.node("result"), { shiftKey: true });
  assert.deepEqual(f.actions.at(-1), { type: "takeCraftResult", shift: true });
  assert.ok(
    f
      .state()
      .slots.some((stack) => stack?.id === BLOCK.PLANKS && stack.count === 4)
  );
  assert.equal(f.state().craftingGrid[0], null);
});

test("cancelled, hidden, disabled and text-input gestures do not trigger game actions", async (t) => {
  const f = fixture(t, { cursor: { id: ITEM.APPLE, count: 8 } });
  f.fire("pointerdown", f.slot(9));
  f.fire("pointermove", f.slot(10));
  f.fire("pointercancel", f.slot(10));
  f.fire("pointerup", f.slot(10));
  f.slot(9).disabled = true;
  await f.click(f.slot(9));
  f.slot(9).disabled = false;
  f.slot(9).hidden = true;
  await f.click(f.slot(9));
  f.slot(9).hidden = false;
  f.fire("pointermove", f.slot(9));
  const input = new f.Node("input");
  input.matches = () => true;
  await f.key(input, "KeyQ");
  await f.key(f.slot(9), "KeyQ", { repeat: true });
  await f.key(f.slot(9), "KeyF", { metaKey: true });
  f.fire("pointerdown", f.slot(9));
  f.document.defaultView.dispatchEvent(new Event("blur"));
  f.fire("pointerup", f.slot(9));
  assert.deepEqual(f.actions, []);
  assert.equal(f.state().cursor.count, 8);
  assert.equal(f.slot(10).classList.contains("is-drag-target"), false);
});

test("pending and failed callbacks do not allow reentrant mutations or lose the carried stack", async (t) => {
  let rejectAction;
  const f = fixture(t, {
    cursor: { id: ITEM.APPLE, count: 2 },
    onAction: () =>
      new Promise((_, reject) => {
        rejectAction = reject;
      }),
  });
  const pending = f.interactions.dispatch({
    type: "click",
    area: "inventory",
    index: 9,
    button: 0,
  });
  assert.equal(f.interactions.busy, true);
  assert.equal(f.container.getAttribute("aria-busy"), "true");
  assert.equal(await f.interactions.dispatch({ type: "close" }), false);
  await f.click(f.slot(10));
  assert.equal(f.actions.length, 1);
  rejectAction(new Error("Transfer unavailable"));
  assert.equal(await pending, false);
  assert.equal(f.interactions.busy, false);
  assert.deepEqual(f.statuses.at(-1), {
    message: "Transfer unavailable",
    error: true,
  });
  assert.equal(f.state().cursor.count, 2);
  f.interactions.reset();
  assert.equal(f.container.querySelector(".carried-stack").hidden, true);
});

test("metadata survives pointer carry, double-click collection and prepared keyboard drops", async (t) => {
  const named = (name, count) => ({
    id: ITEM.APPLE,
    count,
    data: { version: 1, name },
  });
  const f = fixture(t, {
    entries: [
      [0, named("<b>Lunch</b>", 2)],
      [9, named("<b>Lunch</b>", 3)],
      [10, named("Other", 4)],
    ],
  });
  await f.click(f.slot(0), { timeStamp: 1000 });
  assert.match(
    f.container.querySelector(".carried-stack").getAttribute("aria-label"),
    /<b>Lunch<\/b>/
  );
  await f.click(f.slot(0), { timeStamp: 1100 });
  assert.deepEqual(f.state().cursor, named("<b>Lunch</b>", 5));
  assert.deepEqual(f.state().slots[10], named("Other", 4));
  await f.click(f.slot(18));
  f.fire("pointermove", f.slot(18));
  await f.key(f.slot(18), "KeyQ", { ctrlKey: true });
  assert.deepEqual(f.drops, [[named("<b>Lunch</b>", 5)]]);
  assert.equal(f.state().slots[18], null);
});

test("fatal publication invariants propagate instead of becoming refused-click statuses", async (t) => {
  const failure = new TransactionInvariantError("fixture publication failure");
  const f = fixture(t, {
    onAction: () => {
      throw failure;
    },
  });
  await assert.rejects(
    f.interactions.dispatch({ type: "close" }),
    (error) => error === failure
  );
  assert.equal(f.interactions.busy, false);
  assert.equal(
    f.statuses.some((status) => status.error),
    false
  );
});
