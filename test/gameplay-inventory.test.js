import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { cloneSlots, cloneStack } from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import { preparedDropFixture } from "./prepared-drop-fixture.js";

const stack = (id, count = 1, durability = getItem(id).durability) => ({
  id,
  count,
  ...(durability === undefined ? {} : { durability }),
});
const click = (game, area, index, button = 0) =>
  game.inventoryAction({ type: "click", area, index, button });

function conservation(game) {
  const state = game.getState();
  const counts = new Map();
  const wear = [];
  for (const value of [
    ...state.slots,
    state.cursor,
    state.offhand,
    ...Object.values(state.equipment),
    ...state.craftingGrid,
  ]) {
    if (!value) continue;
    counts.set(value.id, (counts.get(value.id) ?? 0) + value.count);
    if (value.durability !== undefined)
      wear.push(`${value.id}:${value.durability}`);
  }
  return { counts: [...counts].sort(([a], [b]) => a - b), wear: wear.sort() };
}

test("36 stable slots, split/merge/quick-move and close conserve every owned item", () => {
  const game = new Gameplay();
  game.add(BLOCK.DIRT, 70);
  const before = conservation(game);
  assert.equal(game.slots.length, 36);
  assert.equal(game.slots[1].count, 64);
  assert.equal(game.slots[2].count, 6);
  assert.equal(click(game, "inventory", 1, 2).ok, true);
  assert.equal(game.cursor.count, 32);
  assert.equal(game.slots[1].count, 32);
  assert.equal(click(game, "inventory", 2, 2).ok, true);
  assert.equal(game.slots[2].count, 7);
  assert.equal(click(game, "inventory", 9).ok, true);
  assert.equal(game.slots[9].count, 31);
  assert.equal(
    game.inventoryAction({ type: "quickMove", area: "inventory", index: 2 }).ok,
    true
  );
  assert.equal(game.slots[2], null);
  assert.equal(game.slots[9].count, 38);
  assert.equal(click(game, "inventory", 0).ok, true);
  assert.equal(game.inventoryAction({ type: "close" }).ok, true);
  assert.deepEqual(conservation(game), before);
  assert.equal(game.cursor, null);
});

test("selected wear and consumption target a duplicate in slot 7, not the first ID copy", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.slots[0] = stack(ITEM.WOOD_PICKAXE, 1, 3);
    draft.slots[7] = stack(ITEM.WOOD_PICKAXE, 1, 10);
    return true;
  });
  game.select(7);
  assert.deepEqual(game.harvest(BLOCK.STONE), [
    { id: BLOCK.COBBLESTONE, count: 1 },
  ]);
  assert.equal(game.slots[7].durability, 9);
  assert.equal(game.slots[0].durability, 3);
  assert.equal(game.wearHand("main", 2), true);
  assert.equal(game.slots[7].durability, 7);
  assert.equal(game.consumeHand("main"), true);
  assert.equal(game.slots[7], null);
  assert.equal(game.slots[0].durability, 3);
  assert.equal(
    game.selectedItem,
    null,
    "another duplicate is not automatically equipped"
  );
});

test("legacy selected-ID consumption also prefers that exact selected stack", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.slots[0] = stack(BLOCK.DIRT, 20);
    draft.slots[8] = stack(BLOCK.DIRT, 2);
    return true;
  });
  game.select(8);
  assert.equal(game.placed(BLOCK.DIRT), true);
  assert.equal(game.slots[8].count, 1);
  assert.equal(game.slots[0].count, 20);
  assert.equal(game.consume(BLOCK.DIRT), true);
  assert.equal(game.slots[8], null);
  assert.equal(game.slots[0].count, 20);
});

test("offhand placement checks and consumes the chosen hand, not another owned stack", () => {
  const game = new Gameplay();
  game.add(BLOCK.DIRT, 20);
  game.inventoryTransaction((draft) => {
    draft.offhand = stack(BLOCK.DIRT, 2);
    return true;
  });
  assert.equal(game.canPlace(BLOCK.DIRT, "offhand"), true);
  assert.equal(game.canPlace(BLOCK.DIRT, "main"), false);
  assert.equal(game.placed(BLOCK.DIRT, "main"), false);
  assert.equal(game.placed(BLOCK.DIRT, "offhand"), true);
  assert.equal(game.offhand.count, 1);
  assert.equal(game.count(BLOCK.DIRT), 20);
});

test("main/offhand swapping and hovered hotbar/offhand exchanges preserve instance wear", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.offhand = stack(ITEM.WOOD_SWORD, 1, 7);
    draft.slots[5] = stack(ITEM.WOOD_SWORD, 1, 23);
    return true;
  });
  const before = conservation(game);
  assert.equal(game.swapHands(), true);
  assert.equal(game.getHandStack().durability, 7);
  assert.deepEqual(game.offhand, stack(ITEM.APPLE, 4));
  assert.equal(
    game.inventoryAction({
      type: "swapHotbar",
      area: "offhand",
      index: 0,
      hotbarIndex: 5,
    }).ok,
    true
  );
  assert.equal(game.offhand.durability, 23);
  assert.equal(
    game.inventoryAction({
      type: "swapOffhand",
      area: "inventory",
      index: 0,
    }).ok,
    true
  );
  assert.equal(game.getHandStack().durability, 23);
  assert.equal(game.offhand.durability, 7);
  assert.deepEqual(conservation(game), before);
});

test("offhand food, consumption and shield wear debit only the offhand copy", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.offhand = stack(ITEM.APPLE, 2);
    return true;
  });
  game.hunger = 10;
  assert.equal(game.eatFromHand("offhand"), true);
  assert.equal(game.hunger, 14);
  assert.equal(game.offhand.count, 1);
  assert.equal(game.count(ITEM.APPLE), 4);
  assert.equal(game.consumeHand("offhand"), true);
  assert.equal(game.offhand, null);
  game.inventoryTransaction((draft) => {
    draft.offhand = stack(ITEM.SHIELD, 1, 4);
    draft.slots[1] = stack(ITEM.SHIELD, 1, 27);
    return true;
  });
  assert.equal(game.wearHand("offhand", 3), true);
  assert.equal(game.offhand.durability, 1);
  assert.equal(game.slots[1].durability, 27);
  assert.equal(game.wearHand("offhand"), true);
  assert.equal(game.offhand, null);
  assert.equal(game.slots[1].durability, 27);
});

test("a bow spends offhand ammunition first, and carrying a shield is not passive invulnerability", () => {
  const game = new Gameplay();
  game.add(ITEM.BOW);
  game.assignSlot(0, ITEM.BOW);
  game.inventoryTransaction((draft) => {
    draft.offhand = stack(ITEM.ARROW, 2);
    return true;
  });
  assert.equal(game.count(ITEM.ARROW), 0);
  assert.equal(game.attack(), getItem(ITEM.BOW).damage);
  assert.equal(game.offhand.count, 1);
  assert.equal(game.attack(), getItem(ITEM.BOW).damage);
  assert.equal(game.offhand, null);
  assert.equal(game.attack(), 0);
  game.inventoryTransaction((draft) => {
    draft.offhand = stack(ITEM.SHIELD);
    return true;
  });
  assert.equal(game.getState().armorPoints, 0);
  assert.equal(game.damage(4, "zombie"), 4);
  assert.equal(
    game.offhand.durability,
    getItem(ITEM.SHIELD).durability,
    "only the parent's directional blocked-hit path wears a shield"
  );
});

test("only valid equipped armor protects; removing it removes protection without losing wear", () => {
  const game = new Gameplay();
  game.add(ITEM.IRON_HELMET, 1, { durability: [19] });
  game.add(ITEM.IRON_ARMOR, 1, { durability: [31] });
  assert.equal(game.getState().armorPoints, 0);
  for (const id of [ITEM.IRON_HELMET, ITEM.IRON_ARMOR]) {
    const index = game.slots.findIndex((value) => value?.id === id);
    assert.equal(
      game.inventoryAction({ type: "quickMove", area: "inventory", index }).ok,
      true
    );
  }
  assert.equal(game.getState().armorPoints, 8);
  const taken = game.damage(4, "zombie");
  assert.ok(Math.abs(taken - 3.04) < 1e-10);
  assert.equal(game.equipment.head.durability, 18);
  assert.equal(game.equipment.chest.durability, 30);
  const before = conservation(game);
  assert.equal(click(game, "inventory", 0).ok, true);
  const rejected = game.serialize();
  assert.equal(
    click(game, "equipment", 0).ok,
    false,
    "apples cannot replace a helmet"
  );
  assert.deepEqual(game.serialize(), rejected);
  assert.equal(game.inventoryAction({ type: "close" }).ok, true);
  for (const index of [0, 1]) {
    assert.equal(
      game.inventoryAction({ type: "quickMove", area: "equipment", index }).ok,
      true
    );
  }
  assert.equal(game.getState().armorPoints, 0);
  assert.deepEqual(conservation(game), before);
});

test("prepared-drop refusal or exception leaves exact ownership and observers unchanged", () => {
  let changes = 0;
  const game = new Gameplay({ onChange: () => changes++ });
  const before = game.serialize();
  for (const prepareDrops of [
    undefined,
    () => null,
    () => {
      throw new Error("full");
    },
  ]) {
    const count = changes;
    assert.equal(game.dropSelected({ wholeStack: true, prepareDrops }), false);
    assert.deepEqual(game.serialize(), before);
    assert.equal(changes, count);
  }
  let calls = 0;
  const sink = preparedDropFixture(game);
  assert.equal(
    game.dropSelected({
      wholeStack: false,
      prepareDrops: (drops) => {
        calls++;
        assert.deepEqual(drops, [stack(ITEM.APPLE)]);
        assert.deepEqual(
          game.serialize(),
          before,
          "ownership is retained throughout preparation"
        );
        assert.equal(
          game.add(BLOCK.DIRT),
          false,
          "reentrant mutations are locked"
        );
        assert.equal(game.select(3), false);
        assert.equal(game.load(before), false);
        assert.equal(game.respawn(), false);
        return sink.prepareDrops(drops);
      },
    }),
    true
  );
  assert.equal(calls, 1);
  assert.equal(game.count(ITEM.APPLE), 3);
  assert.equal(sink.overflow.serialize().entries[0].count, 1);
});

test("closing a full inventory retains cursor/grid on refusal, or drops all remainders once", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
    draft.slots[0] = stack(ITEM.APPLE, 62);
    draft.cursor = stack(ITEM.APPLE, 4);
    draft.craftingGrid[1] = stack(ITEM.WOOD_AXE, 1, 11);
    return true;
  });
  const before = game.serialize();
  assert.equal(game.inventoryAction({ type: "close" }).ok, false);
  assert.deepEqual(game.serialize(), before);
  assert.equal(
    game.inventoryAction({ type: "close" }, { prepareDrops: () => null }).ok,
    false
  );
  assert.deepEqual(game.serialize(), before);
  const accepted = [];
  const sink = preparedDropFixture(game, {
    onCommit: (drops) => accepted.push(cloneSlots(drops)),
  });
  assert.equal(
    game.inventoryAction(
      { type: "close" },
      {
        prepareDrops: sink.prepareDrops,
      }
    ).ok,
    true
  );
  assert.deepEqual(accepted, [
    [stack(ITEM.APPLE, 2), stack(ITEM.WOOD_AXE, 1, 11)],
  ]);
  assert.equal(game.slots[0].count, 64);
  assert.equal(game.cursor, null);
  assert.ok(game.getState().craftingGrid.every((value) => value === null));
  assert.equal(
    game.inventoryAction(
      { type: "close" },
      {
        prepareDrops: () => {
          assert.fail("already-retained items must not drop again");
        },
      }
    ).ok,
    true
  );
});

test("deprecated isolated commit adapter validates first and notifies after installation", () => {
  let container = [stack(ITEM.WOOD_PICKAXE, 1, 8)];
  let observed = 0;
  const game = new Gameplay({
    onChange: (state) => {
      observed++;
      assert.deepEqual(state.slots[0], stack(ITEM.WOOD_PICKAXE, 1, 8));
      assert.deepEqual(container[0], stack(ITEM.APPLE, 4));
    },
  });
  let stale;
  const nextContainer = cloneSlots(container);
  assert.equal(
    game.inventoryTransaction(
      (draft) => {
        stale = draft;
        const previous = draft.slots[0];
        draft.slots[0] = cloneStack(nextContainer[0]);
        nextContainer[0] = previous;
        return true;
      },
      {
        commit: () => {
          container = cloneSlots(nextContainer);
        },
        notify: false,
      }
    ),
    true
  );
  assert.equal(observed, 0);
  game.notifyInventoryChange();
  assert.equal(observed, 1);
  stale.slots[0].durability = 1;
  nextContainer[0].count = 1;
  assert.equal(game.slots[0].durability, 8);
  assert.equal(container[0].count, 4);
  const before = game.serialize();
  let commits = 0;
  assert.equal(
    game.inventoryTransaction(
      (draft) => {
        draft.slots[0].count = 2;
        return true;
      },
      {
        commit: () => {
          commits++;
        },
      }
    ),
    false
  );
  assert.equal(commits, 0);
  assert.deepEqual(game.serialize(), before);
  assert.equal(
    game.inventoryTransaction(
      (draft) => {
        draft.slots[0] = null;
        return true;
      },
      { commit: () => false }
    ),
    false
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(observed, 1);
});

test("closing cursor escrow keeps reserved paid-smelting capacity and atomically drops only overflow", () => {
  const game = new Gameplay();
  game.consume(ITEM.APPLE, 4);
  game.add(BLOCK.DIRT, 64 * 34);
  game.add(ITEM.RAW_IRON, 2);
  game.add(ITEM.COAL);
  assert.equal(game.craft("iron_ingot", { station: "furnace" }).ok, true);
  assert.equal(
    game.inventoryTransaction((draft) => {
      draft.cursor = stack(ITEM.APPLE, 3);
      return true;
    }),
    true
  );
  const before = game.serialize();
  assert.equal(game.inventoryAction({ type: "close" }).ok, false);
  assert.deepEqual(game.serialize(), before);
  const drops = [];
  const sink = preparedDropFixture(game, {
    onCommit: (stacks) => drops.push(...cloneSlots(stacks)),
  });
  assert.equal(
    game.inventoryAction(
      { type: "close" },
      {
        prepareDrops: sink.prepareDrops,
      }
    ).ok,
    true
  );
  assert.deepEqual(drops, [stack(ITEM.APPLE, 3)]);
  assert.equal(game.slots[35], null);
  game.update(10);
  assert.equal(game.slots[35].id, ITEM.IRON_INGOT);
  assert.equal(game.count(ITEM.RAW_IRON), 1);
  assert.equal(game.count(ITEM.COAL), 0);
});

test("switching crafting sizes retains inputs on refusal and leaves cursor ownership untouched", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
    draft.craftingSize = 3;
    draft.craftingGrid[8] = stack(ITEM.WOOD_PICKAXE, 1, 5);
    draft.cursor = stack(ITEM.APPLE);
    return true;
  });
  const before = game.serialize();
  assert.equal(game.setCraftingSize(2), false);
  assert.deepEqual(game.serialize(), before);
  const sink = preparedDropFixture(game);
  assert.equal(
    game.setCraftingSize(2, {
      prepareDrops: (drops) => {
        assert.deepEqual(drops, [stack(ITEM.WOOD_PICKAXE, 1, 5)]);
        return sink.prepareDrops(drops);
      },
    }),
    true
  );
  assert.equal(game.getState().craftingSize, 2);
  assert.ok(game.getState().craftingGrid.every((value) => value === null));
  assert.deepEqual(game.cursor, stack(ITEM.APPLE));
});

test("double-click collects finite matching stacks across inventory, offhand and crafting escrow", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.slots[0] = stack(ITEM.APPLE, 5);
    draft.slots[9] = stack(ITEM.APPLE, 17);
    draft.offhand = stack(ITEM.APPLE, 10);
    draft.cursor = stack(ITEM.APPLE);
    draft.craftingGrid[0] = stack(ITEM.APPLE, 9);
    return true;
  });
  const before = conservation(game);
  assert.equal(
    game.inventoryAction({ type: "collect", area: "inventory", index: 0 }).ok,
    true
  );
  assert.equal(game.cursor.count, 42);
  assert.equal(game.offhand, null);
  assert.equal(game.getState().craftingGrid[0], null);
  assert.deepEqual(conservation(game), before);
});

test("drag distribution splits evenly or places one, deduplicates targets, and rolls back invalid paths", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.cursor = stack(ITEM.APPLE, 10);
    return true;
  });
  const before = conservation(game);
  const targets = [1, 2, 9, 1].map((index) => ({ area: "inventory", index }));
  assert.equal(
    game.inventoryAction({ type: "distribute", targets, button: 0 }).ok,
    true
  );
  for (const index of [1, 2, 9]) assert.equal(game.slots[index].count, 3);
  assert.equal(game.cursor.count, 1);
  assert.equal(
    game.inventoryAction({ type: "distribute", targets, button: 2 }).ok,
    true
  );
  assert.equal(game.slots[1].count, 4);
  assert.equal(game.cursor, null);
  assert.deepEqual(conservation(game), before);
  click(game, "inventory", 1);
  const invalidBefore = game.serialize();
  assert.equal(
    game.inventoryAction({
      type: "distribute",
      targets: [
        { area: "inventory", index: 2 },
        { area: "inventory", index: 99 },
      ],
      button: 2,
    }).ok,
    false
  );
  assert.deepEqual(game.serialize(), invalidBefore);
});

test("quick-move into a nearly-full region retains the untransferred remainder", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
    draft.slots[0] = stack(ITEM.APPLE, 10);
    draft.slots[9] = stack(ITEM.APPLE, 60);
    return true;
  });
  const before = conservation(game);
  assert.equal(
    game.inventoryAction({ type: "quickMove", area: "inventory", index: 0 }).ok,
    true
  );
  assert.equal(game.slots[0].count, 6);
  assert.equal(game.slots[9].count, 64);
  assert.deepEqual(conservation(game), before);
  const full = game.serialize();
  assert.equal(
    game.assignSlot(0, 0),
    false,
    "clearing a full slot cannot delete its contents"
  );
  assert.deepEqual(game.serialize(), full);
});

test("invalid action vocabulary and stale mutable facades cannot change canonical ownership", () => {
  let changes = 0;
  const game = new Gameplay({ onChange: () => changes++ });
  const before = game.serialize();
  for (const action of [
    null,
    [],
    {},
    { type: "invent" },
    { type: "click", area: "inventory", index: "0", button: 0 },
    { type: "click", area: "inventory", index: 0, button: 1 },
    { type: "click", area: "equipment", index: 4, button: 0 },
    { type: "click", area: "crafting", index: 4, button: 0 },
    { type: "swapHotbar", area: "inventory", index: 0, hotbarIndex: 10 },
    { type: "drop", area: "inventory", index: 0, wholeStack: "yes" },
    { type: "takeCraftResult", shift: "yes" },
    { type: "creativePick", id: ITEM.DIAMOND, wholeStack: true },
  ]) {
    assert.equal(
      game.inventoryAction(action).ok,
      false,
      JSON.stringify(action)
    );
    assert.deepEqual(game.serialize(), before);
    assert.equal(changes, 0);
  }
  game.inventory.clear();
  game.hotbar[0] = ITEM.DIAMOND;
  game.slots[0].count = 64;
  assert.deepEqual(game.serialize(), before);
});
