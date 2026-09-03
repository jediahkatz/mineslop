import assert from "node:assert/strict";
import test from "node:test";
import { ITEM } from "../src/items.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

async function saddleScreen(t) {
  const { document, Node } = uiDomFixture(t);
  document.body = new Node("body");
  const root = new Node("div");
  document.body.append(root);
  const f = await gameMobFixture(t, { root, document });
  const mob = f.spawn();
  f.tame(mob);
  return { ...f, mob, inventory: f.vehicles.horseInventory, ui: f.vehicles.horseInventory.ui };
}

test("the real saddle panel moves one exact saddle through Gameplay and removes control without ejecting", async (t) => {
  const f = await saddleScreen(t);
  const saddle = f.hold("SADDLE", { data: { version: 1, name: "One trail saddle" } });
  f.key("KeyE");
  assert.equal(f.inventory.isOpen, true);
  assert.equal(f.ui.isOpen, true);
  assert.equal(f.game.active, false);
  assert.equal(f.player.enabled, false);
  assert.equal(f.ui._view.gameplay.cursor, f.gameplay.cursor);
  assert.equal(await f.ui.dispatch({
    type: "quickMove", area: "inventory", index: f.gameplay.selected,
  }), true);
  assert.deepEqual(f.horses.state(f.mob.id).saddle, saddle);
  assert.equal(f.gameplay.getHandStack(), null);
  assert.equal(f.ui._saddle.node.dataset.item, String(ITEM.SADDLE));
  assert.equal(await f.ui.dispatch({
    type: "click", area: "container", index: 0, button: 0,
  }), true);
  assert.deepEqual(f.gameplay.cursor, saddle);
  assert.equal(f.horses.state(f.mob.id).saddle, null);
  assert.equal(f.horses.mountFor().id, f.mob.id);
  assert.equal(f.mob.horseView.ridden, true);
  assert.equal(f.mob.horseView.saddled, false);
  assert.match(f.ui.riding.textContent, /bareback/);
  assert.equal(f.ui.close(), true);
  if (f.game.screenClose) await f.game.screenClose;
  await Promise.resolve();
  assert.deepEqual(f.gameplay.cursor, saddle, "closing keeps the real cursor, not a UI copy or a drop");
  assert.equal(f.inventory.session, null);
  assert.equal(f.game.active, true);
  const before = point(f.mob.position);
  f.key("KeyW");
  f.key("Space");
  f.frame(6);
  assert.deepEqual(point(f.mob.position), before);
  assert.equal(f.horses.getHorse(f.mob.id).jumpCharge, 0);
  assert.equal(f.player.flying, false);
});

test("a full backpack can remove a saddle to the cursor and close without any overflow capacity", async (t) => {
  const f = await saddleScreen(t);
  const saddle = f.hold("SADDLE", { data: { version: 1, name: "Full pack" } });
  assert.equal(f.vehicles.openHorseInventory().ok, true);
  assert.equal(await f.ui.dispatch({
    type: "quickMove", area: "inventory", index: f.gameplay.selected,
  }), true);
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots = Array.from({ length: 36 }, () => ({ id: ITEM.WHEAT, count: 64 }));
    return true;
  }), true);
  t.mock.method(f.overflow, "prepareEnqueue", () => assert.fail("No sink is needed for an owned slot transfer"));
  assert.equal(await f.ui.dispatch({
    type: "click", area: "container", index: 0, button: 0,
  }), true);
  assert.equal(f.gameplay.slots.every((stack) => stack.id === ITEM.WHEAT && stack.count === 64), true);
  assert.deepEqual(f.gameplay.cursor, saddle);
  assert.equal(f.ui.close(), true);
  if (f.game.screenClose) await f.game.screenClose;
  assert.deepEqual(f.gameplay.cursor, saddle);
  assert.equal(f.overflow.serialize().entries.length, 0);
});

test("saddle sessions pin exact tokens at preparation and commit without opening ordinary actions", async (t) => {
  const f = await saddleScreen(t);
  f.hold("SADDLE");
  assert.equal(f.vehicles.openHorseInventory().ok, true);
  const first = f.inventory.session.token;
  const command = {
    type: "quickMove", area: "inventory", index: f.gameplay.selected, sessionToken: first,
  };
  const pending = f.inventory.prepareAction(command);
  assert.equal(pending.ok, true);
  const before = f.ownership();
  assert.equal(f.vehicles.dismount().ok, false);
  assert.equal(f.horses.prepareFeed(f.mob.id).ok, false);
  assert.equal(f.game.useActions.tap(), false);
  assert.equal(f.inventory.close({ sessionToken: first + 1 }).ok, false);
  assert.equal(f.inventory.session.token, first);
  assert.deepEqual(f.ownership(), before);
  await f.closeHorse();
  assert.equal(f.vehicles.openHorseInventory().ok, true);
  const second = f.inventory.session.token;
  assert.notEqual(second, first);
  const reopened = f.ownership();
  assert.equal(f.inventory.commit(pending).ok, false);
  assert.equal(f.coordinator.commit(pending.participants).ok, false);
  assert.equal(f.inventory.action(command).ok, false);
  assert.equal(f.inventory.close({ sessionToken: first }).ok, false);
  assert.equal(f.inventory.session.token, second);
  assert.deepEqual(f.ownership(), reopened);
});

test("a saddle drop veto conserves cursor, horse, backpack and reservations, and pause invalidates a prepared transfer", async (t) => {
  const f = await saddleScreen(t);
  f.hold("SADDLE");
  assert.equal(f.vehicles.openHorseInventory().ok, true);
  const token = f.inventory.session.token;
  assert.equal(f.inventory.action({
    type: "quickMove", area: "inventory", index: f.gameplay.selected, sessionToken: token,
  }).ok, true);
  const enqueue = f.overflow.prepareEnqueue;
  t.mock.method(f.overflow, "prepareEnqueue", function (...args) {
    const part = Reflect.apply(enqueue, this, args);
    assert.ok(part);
    return { ...part, validate: () => false };
  });
  const before = f.ownership();
  assert.equal(await f.ui.dispatch({
    type: "drop", area: "container", index: 0, wholeStack: true,
  }), false);
  assert.deepEqual(f.ownership(), before);
  const pending = f.inventory.prepareAction({
    type: "click", area: "container", index: 0, button: 0, sessionToken: token,
  });
  assert.equal(pending.ok, true);
  f.game.paused = true;
  assert.equal(f.inventory.commit(pending).ok, false);
  f.inventory.frame(0.05);
  assert.equal(f.inventory.isOpen, false);
  assert.equal(f.ui.isOpen, false);
  assert.equal(f.game.overlayOpen, false);
  assert.deepEqual(f.ownership(), before);
});

test("saddle publication and token-checked close remain successful when presentation observers throw", async (t) => {
  const f = await saddleScreen(t);
  const saddle = f.hold("SADDLE");
  assert.equal(f.vehicles.openHorseInventory().ok, true);
  const sessionToken = f.inventory.session.token;
  const paintError = new Error("saddle paint observer");
  const painting = t.mock.method(f.ui, "refresh", () => { throw paintError; });
  const equipped = f.inventory.action({
    type: "quickMove", area: "inventory", index: f.gameplay.selected, sessionToken,
  });
  assert.equal(equipped.ok, true);
  assert.deepEqual(equipped.observerErrors, [paintError]);
  assert.equal(f.gameplay.getHandStack(), null);
  assert.deepEqual(f.horses.state(f.mob.id).saddle, saddle);
  assert.equal(f.mob.horseView.saddled, true);
  painting.mock.restore();
  assert.equal(f.inventory.action({
    type: "click", area: "container", index: 0, button: 0, sessionToken,
  }).ok, true);
  assert.deepEqual(f.gameplay.cursor, saddle);

  const before = f.ownership(), hide = f.ui.hide;
  const hideError = new Error("saddle hide observer");
  t.mock.method(f.ui, "hide", function () {
    Reflect.apply(hide, this, []);
    throw hideError;
  });
  f.game.paused = true;
  const closed = f.inventory.close({ sessionToken });
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.observerErrors, [hideError]);
  assert.equal(f.inventory.isOpen, false);
  assert.equal(f.ui.isOpen, false);
  assert.equal(f.game.overlayOpen, false);
  assert.equal(f.inventory.close({ sessionToken }).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.deepEqual(f.gameplay.cursor, saddle);
});

test("reentrant teardown during a saddle action gate cannot dispose either live borrower", async (t) => {
  const f = await saddleScreen(t);
  f.hold("SADDLE");
  assert.equal(f.vehicles.openHorseInventory().ok, true);
  const session = f.inventory.session, before = f.ownership();
  const departure = f.vehicles.prepareDeparture("travel");
  assert.equal(departure.ok, true);
  assert.equal(f.inventory.withGate(session, () => f.vehicles.dispose()), false);
  assert.equal(f.inventory.withGate(session, () => f.vehicles.prepareDeparture("travel")).ok, false);
  assert.equal(f.inventory.withGate(session, () => f.vehicles.commit(departure)).ok, false);
  assert.equal(f.inventory.session, session);
  assert.equal(f.vehicles.active, true);
  assert.equal(f.horses.active, true);
  assert.equal(f.ecology.active, true);
  assert.equal(f.horses.mountFor().id, f.mob.id);
  assert.equal(f.coordinator.usage(f.wildlife), 0);
  assert.deepEqual(f.ownership(), before);
});
