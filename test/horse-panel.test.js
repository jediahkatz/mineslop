import assert from "node:assert/strict";
import test from "node:test";
import { getItem, ITEM } from "../src/items.js";
import { TransactionInvariantError } from "../src/transactions.js";
import { HorseUI } from "../src/ui/horse-panel.js";
import { horsePanelFixture } from "./horse-panel-fixture.js";

const stack = (id, count = 1) => ({ id, count });
const saddle = () => {
  // Parent owns the canonical item/art. No temporary item registry or fake ID.
  assert.equal(getItem(ITEM.SADDLE)?.stackSize, 1, "canonical Saddle must be integrated before this suite");
  return stack(ITEM.SADDLE);
};

test("the saddle screen renders one horse slot and actual owned Gameplay slots/cursor in Creative", (t) => {
  const f = horsePanelFixture(t, {
    mode: "creative", entries: [[0, saddle()], [9, stack(ITEM.APPLE, 6)], [35, stack(ITEM.STICK, 3)]],
    cursor: stack(ITEM.APPLE, 2),
  });
  const before = f.gameplay.serialize();
  assert.equal(f.documentListeners.size, 0);
  assert.equal(f.ui.element.querySelectorAll(".carried-stack").length, 0);
  assert.equal(f.open(), true);
  assert.equal(f.ui.kind, "horse");
  assert.equal(f.ui.element.querySelector(".horse-brand").textContent, "Mineslop");
  assert.equal(f.ui.element.querySelectorAll('[data-area="container"]').length, 1);
  assert.equal(f.ui.element.querySelectorAll('[data-area="inventory"]').length, 36);
  assert.equal(f.ui.element.querySelectorAll('[data-area="equipment"]').length, 0);
  assert.equal(f.ui.element.querySelectorAll('[data-area="crafting"]').length, 0);
  assert.equal(f.ui.element.querySelectorAll('[data-area="catalog"]').length, 0);
  assert.equal(f.slot("container").dataset.item, "0", "holding a saddle does not equip it");
  assert.equal(f.slot("inventory", 0).dataset.item, String(ITEM.SADDLE));
  assert.equal(f.slot("inventory", 0).dataset.unlimited, "false");
  assert.notEqual(f.gameplay.getState().creativeHotbar[0], ITEM.SADDLE);
  assert.equal(f.slot("inventory", 9).dataset.count, "6");
  assert.equal(f.slot("inventory", 35).dataset.count, "3");
  const carried = f.ui.element.querySelectorAll(".carried-stack");
  assert.equal(carried.length, 1);
  assert.equal(carried[0].dataset.item, String(ITEM.APPLE));
  assert.equal(carried[0].dataset.count, "2");
  assert.equal(f.parent.controlsEnabled, false);
  assert.equal(f.parent.paused, false);
  assert.deepEqual(f.gameplay.serialize(), before, "rendering does not grant or move resources");
});

test("each saddle slot gesture carries the exact session token; a refused backend never looks committed", async (t) => {
  const value = saddle();
  const f = horsePanelFixture(t, { saddle: value, ridden: true });
  f.open();
  const token = f.token(), before = f.gameplay.serialize(), slot = f.slot("container");
  assert.match(f.ui.note.textContent, /leaves you mounted without steering or jumping/);
  await f.click(slot);
  await f.click(slot, { button: 2 });
  await f.click(slot, { shiftKey: true });
  await f.key(slot, "Digit4");
  await f.key(slot, "KeyF");
  await f.key(slot, "KeyQ");
  await f.key(slot, "KeyQ", { ctrlKey: true });
  assert.deepEqual(f.actions, [
    { type: "click", area: "container", index: 0, button: 0, sessionToken: token },
    { type: "click", area: "container", index: 0, button: 2, sessionToken: token },
    { type: "quickMove", area: "container", index: 0, sessionToken: token },
    { type: "swapHotbar", area: "container", index: 0, hotbarIndex: 3, sessionToken: token },
    { type: "swapOffhand", area: "container", index: 0, sessionToken: token },
    { type: "drop", area: "container", index: 0, wholeStack: false, sessionToken: token },
    { type: "drop", area: "container", index: 0, wholeStack: true, sessionToken: token },
  ]);
  assert.ok(f.results.every((result) => result.ok === false));
  assert.equal(f.ui.status.dataset.state, "error");
  assert.match(f.ui.status.textContent, /refused/);
  assert.equal(slot.dataset.item, String(value.id), "no optimistic saddle disappearance");
  assert.equal(f.ui.isOpen, true, "captured slot clicks do not dismiss the overlay");
  assert.deepEqual(f.gameplay.serialize(), before);
});

test("supported player slot gestures use the real shared cursor, hotbar, offhand and prepared drop backend", async (t) => {
  const f = horsePanelFixture(t, { entries: [[9, stack(ITEM.APPLE, 7)]] });
  f.open();
  await f.click(f.slot("inventory", 9), { button: 2 });
  assert.equal(f.gameplay.cursor.count, 4);
  assert.equal(f.slot("inventory", 9).dataset.count, "3");
  await f.activate(f.slot("inventory", 10));
  assert.equal(f.gameplay.cursor, null);
  assert.equal(f.gameplay.slots[10].count, 4);
  await f.click(f.slot("inventory", 10), { shiftKey: true });
  assert.equal(f.gameplay.slots[0].count, 4);
  await f.key(f.slot("inventory", 0), "Digit3");
  assert.equal(f.gameplay.slots[2].count, 4);
  await f.key(f.slot("inventory", 2), "KeyF");
  assert.equal(f.gameplay.offhand.count, 4);
  assert.equal(f.slot("offhand").dataset.count, "4");
  await f.key(f.slot("offhand"), "KeyQ", { ctrlKey: true });
  assert.equal(f.gameplay.offhand, null);
  assert.equal(f.slot("offhand").dataset.item, "0");
  assert.equal(f.sink.overflow.serialize().entries[0].count, 4);
  assert.ok(f.actions.every((action) => action.sessionToken === f.token()));
});

test("supported drag emits one distribution command and renders only committed Gameplay cursor changes", async (t) => {
  const f = horsePanelFixture(t, { cursor: stack(ITEM.APPLE, 8) });
  f.open();
  f.fire("pointerdown", f.slot("inventory", 9));
  f.fire("pointermove", f.slot("inventory", 10));
  f.fire("pointermove", f.slot("inventory", 9));
  f.fire("pointerup", f.slot("inventory", 10));
  await f.settle();
  assert.deepEqual(f.actions, [{
    type: "distribute", button: 0,
    targets: [{ area: "inventory", index: 9 }, { area: "inventory", index: 10 }],
    sessionToken: f.token(),
  }]);
  assert.equal(f.gameplay.slots[9].count, 4);
  assert.equal(f.gameplay.slots[10].count, 4);
  assert.equal(f.gameplay.cursor, null);
  assert.equal(f.ui.element.querySelector(".carried-stack").hidden, true);
  await f.click(f.slot("inventory", 9));
  await f.activate(f.ui.dropCursor, f.ui.dropCursor);
  assert.equal(f.gameplay.cursor, null);
  assert.equal(f.sink.overflow.serialize().entries[0].count, 4);
});

test("unsupported shortcuts and hidden areas never reach the backend or advertise fabricated capabilities", async (t) => {
  const f = horsePanelFixture(t, { entries: [[9, stack(ITEM.APPLE, 3)]], supportedActions: ["click"] });
  f.open();
  const before = f.gameplay.serialize();
  assert.equal(f.ui.offhandGroup.hidden, true);
  assert.doesNotMatch(f.ui.help.textContent, /Shift|1–9|F:|Q \/|Drag|collect/);
  await f.click(f.slot("inventory", 9), { shiftKey: true });
  for (const code of ["Digit2", "KeyF", "KeyQ"]) await f.key(f.slot("inventory", 9), code);
  for (const action of [
    { type: "creativePick", id: ITEM.APPLE, wholeStack: true },
    { type: "click", area: "equipment", index: 0, button: 0 },
    { type: "click", area: "crafting", index: 0, button: 0 },
    { type: "click", area: "container", index: 1, button: 0 },
    { type: "collect", area: "inventory", index: 9 },
    { type: "distribute", targets: [{ area: "inventory", index: 9 }], button: 0 },
  ]) assert.equal(await f.ui.dispatch(action), false);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.gameplay.serialize(), before);
  assert.equal(f.ui.status.dataset.state, "error");
  await f.activate(f.slot("inventory", 9));
  assert.equal(f.gameplay.cursor.count, 3, "native keyboard button activation is still a real click");
});

test("E/Escape close carry the original session token and retain the real cursor; hiding removes listeners", async (t) => {
  const f = horsePanelFixture(t, { cursor: saddle() });
  f.open();
  const token = f.token(), before = f.gameplay.serialize();
  assert.equal(f.documentListeners.size, 1);
  await f.documentKey("Escape", { repeat: true });
  assert.equal(f.closes.length, 0);
  await f.documentKey("KeyE");
  assert.deepEqual(f.closes, [{ type: "close", reason: "closed", sessionToken: token }]);
  assert.equal(f.ui.isOpen, false);
  assert.equal(f.documentListeners.size, 0);
  assert.equal(f.ui.element.querySelectorAll(".carried-stack").length, 0);
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.parent.controlsEnabled, true);
  assert.deepEqual(f.gameplay.serialize(), before);
  const event = await f.documentKey("Escape");
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.closes.length, 1);
  f.open();
  await f.documentKey("Escape");
  assert.equal(f.closes[1].sessionToken, f.token());
  assert.notEqual(f.closes[1].sessionToken, token);
  assert.deepEqual(f.gameplay.serialize(), before);
});

test("close refusal keeps the active session and cursor; presentation disposal never closes domain ownership", (t) => {
  const f = horsePanelFixture(t, {
    cursor: stack(ITEM.APPLE, 2), onClose: () => ({ ok: false, message: "Session guard refused." }),
  });
  f.open();
  const before = f.gameplay.serialize();
  assert.equal(f.ui.close(), false);
  assert.equal(f.ui.isOpen, true);
  assert.equal(f.parent.controlsEnabled, false);
  assert.match(f.ui.status.textContent, /guard refused/);
  f.ui.hide();
  f.ui.dispose();
  f.ui.dispose();
  assert.equal(f.closes.length, 1);
  assert.equal(f.documentListeners.size, 0);
  assert.deepEqual(f.gameplay.serialize(), before);
});

test("late action results cannot refresh or close a replacement session or create a second cursor", async (t) => {
  let release, delay = true;
  const f = horsePanelFixture(t, {
    entries: [[9, stack(ITEM.APPLE, 2)]],
    afterAction(result) {
      if (!delay) return result;
      delay = false;
      return new Promise((resolve) => { release = () => resolve(result); });
    },
  });
  f.open();
  const token = f.token();
  const pending = f.ui.dispatch({ type: "click", area: "inventory", index: 9, button: 0 });
  assert.equal(f.gameplay.cursor.count, 2, "the real callback committed once before delaying its response");
  assert.equal(f.ui.element.getAttribute("aria-busy"), "true");
  assert.equal(f.ui.close(), false);
  f.invalidate();
  f.open({ horseId: "horse-ui-2" });
  assert.notEqual(f.token(), token);
  assert.equal(f.ui.element.getAttribute("aria-busy"), "false");
  assert.equal(f.ui.element.querySelectorAll(".carried-stack").length, 1);
  assert.equal(f.documentListeners.size, 1);
  assert.equal(await f.ui.dispatch({ type: "click", area: "inventory", index: 10, button: 0 }), true);
  release();
  assert.equal(await pending, false);
  assert.equal(f.gameplay.cursor, null);
  assert.equal(f.gameplay.slots[10].count, 2);
  assert.equal(f.ui.isOpen, true);
  assert.equal(f.ui.status.hidden, true);
  assert.equal(f.ui.element.getAttribute("aria-busy"), "false");
  assert.deepEqual(f.actions.map((action) => action.sessionToken), [token, f.token()]);
});

test("a synchronous parent close observer can replace the session without losing its input ownership", async (t) => {
  let reopen = true;
  const f = horsePanelFixture(t, {
    entries: [[9, stack(ITEM.APPLE)]],
    afterClose(fixture) {
      if (!reopen) return;
      reopen = false;
      fixture.open({ horseId: "horse-ui-replacement" });
    },
  });
  f.open();
  const token = f.token();
  assert.equal(f.ui.close(), true);
  assert.equal(f.ui.isOpen, true);
  assert.equal(f.parent.controlsEnabled, false);
  assert.notEqual(f.token(), token);
  assert.equal(f.closes[0].sessionToken, token);
  assert.equal(f.documentListeners.size, 1);
  await f.activate(f.slot("inventory", 9));
  assert.equal(f.actions.at(-1).sessionToken, f.token());
  assert.equal(f.gameplay.cursor.count, 1);
});

test("frame refresh follows horse and actual Gameplay revisions but does no projection work when idle or hidden", (t) => {
  const f = horsePanelFixture(t, { saddle: saddle() });
  const hiddenReads = f.reads();
  assert.equal(f.ui.frame(1), false);
  assert.equal(f.reads(), hiddenReads);
  f.open();
  const openReads = f.reads();
  for (let i = 0; i < 10; i++) assert.equal(f.ui.frame(0.1), false);
  assert.equal(f.reads(), openReads);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots[20] = stack(ITEM.APPLE, 6);
    return true;
  }), true);
  assert.equal(f.ui.frame(0.1), true);
  assert.equal(f.slot("inventory", 20).dataset.count, "6");
  // A replacement committed projection is presentation evidence only; this
  // fixture does not claim to implement the horse domain's atomic removal.
  f.projection({ slots: [null], ridden: true });
  assert.equal(f.ui.frame(0.1), true);
  assert.equal(f.slot("container").dataset.item, "0");
  assert.equal(f.ui.riding.textContent, "Riding bareback");
  assert.match(f.ui.note.textContent, /no steering or charged jump/);
  const before = f.gameplay.serialize();
  f.ui.hide();
  const reads = f.reads();
  assert.equal(f.ui.frame(0.1), false);
  assert.equal(f.reads(), reads);
  assert.deepEqual(f.gameplay.serialize(), before);
});

test("a stale rendered session never retargets commands or closes the newly projected horse", async (t) => {
  const f = horsePanelFixture(t, { entries: [[9, stack(ITEM.APPLE, 2)]] });
  f.open();
  const token = f.token(), before = f.gameplay.serialize();
  f.projection({ sessionToken: "replacement-session", horseId: "replacement-horse" });
  assert.equal(await f.ui.dispatch({ type: "click", area: "inventory", index: 9, button: 0 }), false);
  assert.equal(f.actions[0].sessionToken, token);
  assert.equal(f.ui.isOpen, false, "refresh hides the stale presentation");
  assert.deepEqual(f.closes, [], "it cannot close the replacement domain session");
  assert.deepEqual(f.gameplay.serialize(), before);
});

test("focus trapping, typing and repeat guards stay within the open panel lifecycle", async (t) => {
  const f = horsePanelFixture(t, { entries: [[9, stack(ITEM.APPLE, 2)]] });
  f.open();
  assert.equal(f.document.activeElement, f.ui.closeButton);
  await f.documentKey("Tab", { key: "Tab", shiftKey: true });
  assert.equal(f.document.activeElement, f.slot("offhand"));
  await f.documentKey("Tab", { key: "Tab" });
  assert.equal(f.document.activeElement, f.ui.closeButton);
  const input = new f.Node("input");
  f.ui.panel.append(input);
  input.focus();
  await f.documentKey("KeyE", { key: "e" });
  await f.key(input, "KeyQ");
  await f.key(f.slot("inventory", 9), "KeyQ", { repeat: true });
  await f.key(f.slot("inventory", 9), "KeyF", { metaKey: true });
  assert.deepEqual(f.actions, []);
  assert.equal(f.ui.isOpen, true);
  f.ui.hide();
  assert.equal((await f.documentKey("Tab", { key: "Tab" })).defaultPrevented, false);
});

test("required callbacks and actual slot projections fail closed; fatal transaction invariants propagate", async (t) => {
  const f = horsePanelFixture(t);
  assert.throws(() => new HorseUI(f.root), /callbacks/);
  f.projection({ slots: [] });
  assert.equal(f.open(), false);
  assert.equal(f.documentListeners.size, 0);
  f.projection({ slots: [null] });
  f.open();
  const invariant = new TransactionInvariantError("horse UI test invariant");
  f.ui.onAction = () => { throw invariant; };
  await assert.rejects(
    f.ui.dispatch({ type: "click", area: "container", index: 0, button: 0 }),
    (error) => error === invariant,
  );
  assert.equal(f.ui.element.getAttribute("aria-busy"), "false");
  f.ui.onClose = () => { throw invariant; };
  assert.throws(() => f.ui.close(), (error) => error === invariant);
});
