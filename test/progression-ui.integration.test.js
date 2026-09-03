import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { experienceForLevel } from "../src/experience.js";
import { ITEM } from "../src/items.js";
import { potionStack } from "./brewing-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";
import { progressionUiFixture } from "./progression-ui-fixture.js";

async function table(t, options) {
  const f = progressionUiFixture(t, options);
  f.place("enchanting");
  f.shelves();
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.DIAMOND_PICKAXE, 1, { name: "Panel pick" }, 1400);
    owned.slots[1] = progressionStack(ITEM.LAPIS, 8);
    return true;
  });
  assert.equal(f.open().opened, true);
  await f.click(f.slot("inventory", 0), { shiftKey: true });
  await f.click(f.slot("inventory", 1), { shiftKey: true });
  return f;
}

test("constructed enchanting panel moves real slots, pays its displayed offer and closes without refunding escrow", async (t) => {
  const f = await table(t);
  assert.equal(f.ui.isOpen, true);
  assert.equal(f.player.enabled, false, "parent callback owns control state");
  assert.equal(f.game.paused, false, "the overlay never rewrites simulation pause");
  assert.equal(f.ui.element.querySelectorAll('[data-area="catalog"]').length, 0);
  assert.equal(f.services.view().bookshelfPower, 15);
  const row = f.ui.element.querySelector('[data-enchant-index="2"]');
  assert.equal(row.disabled, false);
  assert.match(row.getAttribute("aria-label"), /30 required.*3 levels \+ 3 lapis/);
  const seed = f.services.stations.playerState.seed;
  await f.activateButton(row);
  const entry = f.services.stations.get(f.at);
  assert.equal(entry.record.lapis.count, 5);
  assert.equal(entry.record.input.durability, 1400);
  assert.equal(entry.record.input.data.name, "Panel pick");
  assert.ok(Object.keys(entry.record.input.data.enchantments).length);
  assert.notEqual(f.services.stations.playerState.seed, seed);
  assert.equal(f.gameplay.getState().experience.level, 37);
  assert.equal(f.actions.at(-1).offerKey.length > 0, true);
  assert.equal(f.actions.at(-1).sessionToken, f.services.session.token);
  assert.equal(row.disabled, true, "an enchanted input cannot pay again");
  const owned = f.services.stations.serialize(), inventory = f.gameplay.serialize();
  await f.documentKey("Escape");
  assert.equal(f.services.isOpen, false);
  assert.equal(f.ui.isOpen, false);
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.player.enabled, true);
  assert.deepEqual(f.services.stations.serialize(), owned);
  assert.deepEqual(f.gameplay.serialize(), inventory);
  assert.equal(f.open().opened, true);
  assert.deepEqual(f.services.stations.serialize(), owned);
  assert.equal(f.ui.title.textContent, "Enchanting table");
});

test("anvil text and result callbacks repair/rename once; occupied output cannot charge XP or materials", async (t) => {
  const f = progressionUiFixture(t);
  f.place("anvil");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.IRON_PICKAXE, 1, {
      name: "Before", enchantments: { unbreaking: 2 },
    }, 10);
    owned.slots[1] = progressionStack(ITEM.IRON_INGOT, 3);
    return true;
  });
  assert.equal(f.open().opened, true);
  await f.click(f.slot("inventory", 0), { shiftKey: true });
  // Both anvil slots accept materials; explicitly address the right input.
  await f.click(f.slot("inventory", 1));
  await f.click(f.slot("container", 1));
  const input = f.ui.element.querySelector(".progression-name");
  input.value = "<b>Named & repaired</b>";
  f.fire("input", input, {}, input);
  const preview = f.services.view({ rename: input.value }).preview;
  assert.equal(preview.levelCost, 4);
  assert.match(f.ui.element.querySelector(".progression-anvil").querySelector(".progression-cost").textContent,
    /4 levels.*3 materials/);
  const actionCount = f.actions.length;
  await f.key(input, "Digit2");
  await f.key(input, "KeyQ");
  await f.documentKey("KeyE", input, { key: "e" });
  assert.equal(f.actions.length, actionCount, "text typing is not a slot/game shortcut");
  assert.equal(f.ui.isOpen, true);
  f.editInventory((owned) => { owned.cursor = progressionStack(ITEM.APPLE); return true; });
  f.ui.refresh();
  const before = f.snapshot();
  await f.click(f.slot("result"));
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.ui.status.dataset.state, "error");
  assert.equal(f.results.at(-1).reason, "output_capacity");
  f.editInventory((owned) => { owned.cursor = null; return true; });
  f.ui.refresh();
  await f.click(f.slot("result"));
  assert.deepEqual(f.gameplay.cursor, preview.output);
  assert.equal(f.gameplay.cursor.data.name, input.value || "<b>Named & repaired</b>");
  assert.equal(f.gameplay.cursor.durability, 196);
  assert.equal(f.gameplay.getState().experience.total, experienceForLevel(36));
  assert.equal(f.ui.status.hidden, true);
  assert.equal(f.services.stations.get(f.at).record.right, null);
  assert.equal(f.ui.isOpen, true, "captured result click cannot dismiss the overlay");
  assert.equal(f.slot("result").disabled, true);
});

test("brewing panel exposes five owned slots, actual progress, number/F/Q and drag/collect operations", async (t) => {
  const f = progressionUiFixture(t);
  f.place("brewing");
  f.editInventory((owned) => {
    owned.slots[0] = potionStack(f.services.catalog, "water", { name: "Panel water" });
    owned.slots[1] = progressionStack(ITEM.NETHER_WART);
    owned.slots[2] = progressionStack(ITEM.BLAZE_POWDER, 8);
    owned.slots[9] = progressionStack(ITEM.APPLE, 9);
    owned.craftingGrid[0] = progressionStack(ITEM.APPLE, 7);
    return true;
  });
  assert.equal(f.open().opened, true);
  assert.equal(f.ui.element.querySelector(".progression-brewing")
    .querySelectorAll('[data-area="container"]').length, 5);
  await f.key(f.slot("container", 0), "Digit1");
  await f.click(f.slot("inventory", 1), { shiftKey: true });
  await f.click(f.slot("inventory", 2), { shiftKey: true });
  assert.equal(f.services.frame(0.25).ok, true);
  f.ui.refresh();
  assert.equal(f.services.stations.get(f.at).record.fuelOperations, 19);
  const progress = f.ui.element.querySelector(".progression-brew-progress");
  assert.equal(progress.getAttribute("aria-valuenow"), "1");
  await f.key(f.slot("container", 0), "KeyF");
  assert.equal(f.gameplay.offhand.data.name, "Panel water");
  assert.equal(f.services.stations.get(f.at).record.batch, null);
  assert.equal(f.services.stations.get(f.at).record.fuelOperations, 19, "cancellation never refunds fuel");
  await f.key(f.slot("offhand"), "KeyQ", { ctrlKey: true });
  assert.equal(f.gameplay.offhand, null);
  assert.equal(f.overflow.serialize().entries[0].data.name, "Panel water");
  await f.click(f.slot("inventory", 9), { button: 2 });
  assert.equal(f.gameplay.cursor.count, 5);
  f.fire("pointerdown", f.slot("inventory", 18), { button: 2 });
  f.fire("pointermove", f.slot("inventory", 19), { button: 2 });
  f.fire("pointerup", f.slot("inventory", 19), { button: 2 });
  await f.settle();
  assert.equal(f.gameplay.slots[18].count, 1);
  assert.equal(f.gameplay.slots[19].count, 1);
  assert.equal(f.gameplay.cursor.count, 3);
  await f.activateButton(f.ui.dropCursor);
  assert.equal(f.gameplay.cursor, null);
  await f.click(f.slot("inventory", 9), { timeStamp: 5000 });
  await f.click(f.slot("inventory", 9), { timeStamp: 5120 });
  assert.equal(f.actions.at(-1).type, "collect");
  assert.equal(f.gameplay.cursor.count, 6);
  assert.equal(f.gameplay.getState().craftingGrid[0].count, 7, "hidden crafting escrow is not collected");
  await f.documentKey("KeyE");
  assert.equal(f.gameplay.cursor.count, 6, "closing does not delete or secretly drop the carried stack");
});

test("smithing panel requires all three paid inputs and preserves upgraded gear metadata", async (t) => {
  const f = progressionUiFixture(t);
  f.place("smithing");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.NETHERITE_UPGRADE_TEMPLATE);
    owned.slots[1] = progressionStack(ITEM.DIAMOND_PICKAXE, 1, {
      name: "Survival upgrade", enchantments: { efficiency: 4 }, repairCost: 3,
    }, 1000);
    owned.slots[2] = progressionStack(ITEM.NETHERITE_INGOT);
    return true;
  });
  assert.equal(f.open().opened, true);
  for (let i = 0; i < 2; i++) await f.click(f.slot("inventory", i), { shiftKey: true });
  assert.equal(f.slot("result").disabled, true);
  assert.equal(f.services.view().preview.reason, "missing_netherite_ingot");
  await f.click(f.slot("inventory", 2), { shiftKey: true });
  const output = f.services.view().preview.output;
  await f.click(f.slot("result"), { shiftKey: true });
  assert.deepEqual(f.gameplay.slots.find((stack) => stack?.id === ITEM.NETHERITE_PICKAXE), output);
  assert.equal(output.durability, 1470);
  assert.equal(output.data.name, "Survival upgrade");
  assert.equal(f.services.view().slots.every((stack) => stack === null), true);
  assert.equal(f.gameplay.getState().experience.level, 40);
});

test("delegated trade button invokes actual ecology/clock/inventory exchange exactly once after reopen", async (t) => {
  const f = progressionUiFixture(t, { profession: "librarian" });
  assert.equal(f.openTrader().opened, true);
  const value = f.services.view().offers.find((entry) => entry.id === "librarian/first-book");
  f.stock(value);
  for (let i = 0; i < 4; i++) {
    assert.equal(f.openTrader().opened, true);
    assert.equal(f.ui.kind, "trading");
  }
  f.ui.refresh();
  const rows = f.ui.element.querySelector(".progression-trade-offers");
  const button = rows.querySelector('[data-offer-id="librarian/first-book"]');
  const xp = f.gameplay.getState().experience.total;
  await f.activateButton(button, rows);
  assert.deepEqual(f.gameplay.slots.find((stack) => stack?.id === ITEM.ENCHANTED_BOOK), value.output);
  assert.equal(f.gameplay.getState().experience.total, xp + value.playerXp);
  assert.equal(f.services.trading.get(f.npcId).xp, value.xp);
  assert.equal(f.actions.filter((action) => action.type === "trade").length, 1);
  assert.match(button.getAttribute("aria-label"), /7 trades remaining/);
  const paid = f.snapshot();
  await f.activateButton(button, rows);
  assert.equal(f.results.at(-1).ok, false);
  assert.deepEqual(f.snapshot(), paid);
  assert.equal(f.ui.status.dataset.state, "error");
});

test("late real callback results cannot corrupt a reopened station's UI or replay a payment", async (t) => {
  let release, delayed = true;
  const f = await table(t, {
    afterAction(result, action) {
      if (action.type !== "enchant" || !delayed) return result;
      delayed = false;
      return new Promise((resolve) => { release = () => resolve(result); });
    },
  });
  f.editInventory((owned) => { owned.experienceTotal = experienceForLevel(29); return true; });
  const oldToken = f.services.session.token;
  const pending = f.ui.dispatch({ type: "enchant", index: 2 });
  assert.equal(f.results.at(-1).reason, "required_level");
  assert.equal(f.ui.element.getAttribute("aria-busy"), "true");
  assert.equal(f.ui.close(), false, "ordinary close waits for its pending action");
  f.services.close("dimension");
  assert.equal(f.ui.isOpen, false);
  f.editInventory((owned) => { owned.experienceTotal = experienceForLevel(40); return true; });
  assert.equal(f.open().opened, true);
  assert.notEqual(f.services.session.token, oldToken);
  assert.equal(f.ui.element.getAttribute("aria-busy"), "false");
  assert.equal(await f.ui.dispatch({ type: "enchant", index: 2 }), true);
  const paid = f.snapshot();
  release();
  assert.equal(await pending, false, "old controller ignores its already-refused response");
  assert.deepEqual(f.snapshot(), paid);
  assert.equal(f.ui.status.hidden, true);
  assert.equal(f.ui.element.getAttribute("aria-busy"), "false");
});

test("progression slot shortcuts do not alter the Creative palette or hidden crafting ownership", async (t) => {
  const f = progressionUiFixture(t, { profession: "farmer" });
  assert.equal(f.gameplay.setMode("creative"), true);
  f.editInventory((owned) => {
    owned.slots[9] = progressionStack(ITEM.APPLE, 6);
    owned.craftingGrid[0] = progressionStack(ITEM.APPLE, 7);
    return true;
  });
  assert.equal(f.openTrader().opened, true);
  const palette = f.gameplay.getState().creativeHotbar;
  await f.click(f.slot("inventory", 9), { shiftKey: true });
  assert.equal(f.gameplay.slots[0].count, 6);
  await f.click(f.slot("inventory", 0), { timeStamp: 1000 });
  await f.click(f.slot("inventory", 0), { timeStamp: 1120 });
  assert.equal(f.gameplay.cursor.count, 6);
  assert.equal(f.gameplay.getState().craftingGrid[0].count, 7);
  assert.deepEqual(f.gameplay.getState().creativeHotbar, palette);
  const before = f.snapshot();
  assert.equal(await f.ui.dispatch({ type: "creativePick", id: BLOCK.DIAMOND_ORE, wholeStack: true }), false);
  assert.deepEqual(f.snapshot(), before);
});

test("panel frame refresh follows real progress revisions and stays idle for unchanged or hidden ownership", async (t) => {
  const f = progressionUiFixture(t);
  f.place("brewing");
  f.editInventory((owned) => {
    owned.slots[0] = potionStack(f.services.catalog, "water");
    owned.slots[1] = progressionStack(ITEM.NETHER_WART);
    owned.slots[2] = progressionStack(ITEM.BLAZE_POWDER);
    return true;
  });
  assert.equal(f.open().opened, true);
  for (let i = 0; i < 12; i++) assert.equal(f.ui.frame(0.1), false);
  for (let i = 0; i < 3; i++) await f.click(f.slot("inventory", i), { shiftKey: true });
  const previous = f.services.viewRevision;
  assert.equal(f.services.frame(0.25).ok, true);
  assert.notEqual(f.services.viewRevision, previous);
  assert.equal(f.ui.frame(0.1), true);
  assert.equal(f.ui.element.querySelector(".progression-brew-progress").getAttribute("aria-valuenow"), "1");
  for (let i = 0; i < 12; i++) assert.equal(f.ui.frame(0.1), false);
  const saved = f.snapshot();
  await f.documentKey("Escape");
  assert.equal(f.ui.frame(0.25), false);
  assert.deepEqual(f.snapshot(), saved, "render polling and closing never simulate a batch");
});

test("synchronous parent close observers can open a new session without losing its controls or escrow", async (t) => {
  let reopen = false;
  const f = progressionUiFixture(t, {
    afterSessionChange(open, fixture) {
      if (open || !reopen) return;
      reopen = false;
      assert.equal(fixture.open().opened, true);
    },
  });
  f.place("anvil");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.BOOK, 1, { name: "Owned input" });
    return true;
  });
  assert.equal(f.open().opened, true);
  await f.click(f.slot("inventory", 0), { shiftKey: true });
  const before = f.snapshot(), token = f.services.session.token;
  reopen = true;
  assert.equal(f.ui.close(), true);
  assert.notEqual(f.services.session.token, token);
  assert.equal(f.ui.isOpen, true);
  assert.equal(f.ui.kind, "anvil");
  assert.equal(f.player.enabled, false, "the replacement session retains parent control ownership");
  assert.equal(f.ui.element.getAttribute("aria-busy"), "false");
  assert.deepEqual(f.snapshot(), before);
  await f.click(f.slot("container", 0));
  assert.equal(f.gameplay.cursor.data.name, "Owned input");
  assert.equal(f.services.stations.get(f.at).record.left, null);
  assert.equal(f.actions.at(-1).sessionToken, f.services.session.token);
});

test("anvil accepts fifty Unicode characters via a real keyboard result callback and rejects fifty-one", async (t) => {
  const f = progressionUiFixture(t);
  f.place("anvil");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.BOOK);
    return true;
  });
  assert.equal(f.open().opened, true);
  await f.activateButton(f.slot("inventory", 0), f.ui.element);
  await f.activateButton(f.slot("container", 0), f.ui.element);
  const name = "💎".repeat(50), input = f.ui.element.querySelector(".progression-name");
  assert.equal(input.maxLength, 100, "DOM length counts UTF-16 code units");
  input.value = `${name}💎`;
  f.fire("input", input, {}, input);
  assert.equal(f.slot("result").disabled, true);
  const before = f.snapshot();
  assert.equal(await f.ui.dispatch({ type: "takeResult" }), false);
  assert.deepEqual(f.snapshot(), before);
  input.value = name;
  f.fire("input", input, {}, input);
  assert.equal(f.slot("result").disabled, false);
  await f.activateButton(f.slot("result"), f.ui.element);
  assert.equal(f.gameplay.cursor.data.name, name);
  assert.equal(f.gameplay.getState().experience.level, 39);
  assert.equal(f.services.stations.get(f.at).record.left, null);
  assert.equal(f.services.stations.get(f.at).record.right, null);
});
