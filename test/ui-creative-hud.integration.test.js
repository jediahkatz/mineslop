import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { isValidStack } from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import { createEventScope } from "../src/ui/dom.js";
import { createHUD } from "../src/ui/hud.js";
import { createSlotInteractions } from "../src/ui/slot-interactions.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = uiDomFixture(t);
  const gameplay = new Gameplay({ mode: "creative" });
  assert.equal(gameplay.assignSlot(0, BLOCK.GRASS), true);
  const hud = createHUD(dom.root, { listen() {} });
  const refresh = () => hud.updateGameplay(gameplay.getState(), true);
  const actions = new GameInventoryActions({
    active: true,
    gameplay,
    resetActions() {},
    refreshHud: refresh,
    scheduleSave() {},
  });
  t.after(() => {
    hud.dispose();
    gameplay.dispose();
  });
  return { ...dom, gameplay, hud, actions, refresh };
}

function assertEmptySelectedHUD(get, selected) {
  const name = get(".selected-block-name");
  assert.equal(name.textContent, "");
  assert.equal(name.classList.contains("is-visible"), false);
  const slot = get(".hotbar").children[selected];
  assert.equal(slot.dataset.item, "0");
  assert.equal(slot.dataset.count, "0");
  assert.equal(slot.dataset.unlimited, "false");
  assert.equal(slot.classList.contains("is-empty"), true);
  assert.equal(slot.classList.contains("selected"), true);
  assert.equal(slot.querySelector(".slot-picture").children.length, 0);
  assert.match(slot.getAttribute("aria-label"), /Empty slot/);
}

test("F's Creative copy clears the selected HUD slot without fabricating AIR or extra owned items", (t) => {
  const f = fixture(t);
  const before = f.gameplay.getState();
  const copied = f.gameplay.getHandStack();
  f.refresh();
  assert.equal(
    f.get(".selected-block-name").textContent,
    getItem(copied.id).name
  );

  assert.equal(f.actions.swapHands(), true);
  const swapped = f.gameplay.getState();
  assert.equal(swapped.creativeHotbar[swapped.selected], BLOCK.AIR);
  assert.equal(swapped.slots[swapped.selected], null);
  assert.equal(f.gameplay.getHandStack(), null);
  assert.deepEqual(swapped.offhand, copied);
  assert.deepEqual(
    swapped.slots.filter(Boolean),
    before.slots.filter(Boolean),
    "the displaced finite stack is retained, not copied or lost"
  );
  assert.ok(
    [...swapped.slots.filter(Boolean), swapped.offhand].every((stack) =>
      isValidStack(stack)
    )
  );
  assertEmptySelectedHUD(f.get, swapped.selected);
  const offhand = f.get(".hud-offhand");
  assert.equal(offhand.hidden, false);
  assert.equal(offhand.children[0].dataset.item, String(copied.id));
  assert.equal(offhand.children[0].dataset.count, String(copied.count));

  f.refresh();
  f.refresh();
  assertEmptySelectedHUD(f.get, swapped.selected);
  assert.deepEqual(f.gameplay.getState(), swapped, "HUD updates are read-only");

  assert.equal(f.actions.swapHands(), true);
  const returned = f.gameplay.getState();
  assert.equal(returned.offhand, null);
  assert.deepEqual(returned.slots[returned.selected], copied);
  assert.deepEqual(returned.slots.filter(Boolean), [
    copied,
    ...before.slots.filter(Boolean),
  ]);
  assert.equal(
    f.get(".selected-block-name").textContent,
    getItem(copied.id).name
  );
  assert.equal(f.get(".hud-offhand").hidden, true);
});

test("an empty Creative selection still renders real offhand metadata without changing ownership", (t) => {
  const f = fixture(t);
  assert.equal(f.gameplay.assignSlot(0, BLOCK.AIR), true);
  const tool = {
    id: ITEM.WOOD_PICKAXE,
    count: 1,
    durability: 12,
    data: {
      version: 1,
      name: "<pick & ore>",
      enchantments: { efficiency: 2 },
      repairCost: 3,
    },
  };
  assert.equal(
    f.gameplay.inventoryTransaction((draft) => {
      draft.offhand = tool;
      return true;
    }),
    true
  );
  const before = f.gameplay.getState();
  f.refresh();
  assertEmptySelectedHUD(f.get, before.selected);
  const offhand = f.get(".hud-offhand").children[0];
  assert.equal(offhand.dataset.item, String(tool.id));
  assert.equal(offhand.dataset.count, "1");
  assert.equal(offhand.dataset.unlimited, "false");
  assert.ok(offhand.getAttribute("aria-label").includes(tool.data.name));
  assert.match(
    offhand.getAttribute("aria-label"),
    /Stored enchantments: Efficiency II/
  );
  assert.match(offhand.getAttribute("aria-label"), /Prior repair cost: 3/);
  assert.deepEqual(f.gameplay.getState(), before);
});

test("close dispatch succeeds after Creative F empties the selected slot and preserves ownership", async (t) => {
  const f = fixture(t);
  // Set up the real F transaction without refreshing yet: the regression must
  // reach close's GameInventoryActions.changed -> HUD callback, not fail setup.
  assert.equal(f.gameplay.swapHands({ creativeCopy: true }), true);
  const before = f.gameplay.getState();
  assert.equal(before.creativeHotbar[before.selected], BLOCK.AIR);
  const scope = createEventScope();
  const container = new f.Node();
  const closeButton = new f.Node("button");
  closeButton.className = "inventory-close icon-button";
  container.append(closeButton);
  const statuses = [];
  const interactions = createSlotInteractions(container, {
    listen: scope.listen,
    getState: () => f.gameplay.getState(),
    onAction: (action) => f.actions.action(action),
    onStatus: (message, error) => statuses.push({ message, error }),
  });
  t.after(() => {
    interactions.dispose();
    scope.dispose();
  });
  closeButton.focus();

  assert.equal(await interactions.dispatch({ type: "close" }), true);
  assert.equal(interactions.busy, false);
  assert.equal(container.getAttribute("aria-busy"), "false");
  assert.equal(
    statuses.some((status) => status.error),
    false
  );
  assert.deepEqual(f.gameplay.getState(), before);
  assert.equal(f.document.activeElement, closeButton);
  assertEmptySelectedHUD(f.get, before.selected);
  assert.equal(
    f.get(".hud-offhand").children[0].dataset.count,
    String(before.offhand.count)
  );
});
