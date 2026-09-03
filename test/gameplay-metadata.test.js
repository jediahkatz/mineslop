import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { parseGameplaySave } from "../src/gameplay-save.js";
import { cloneStack } from "../src/inventory-slots.js";
import { ItemUse } from "../src/item-use.js";
import { ITEM } from "../src/items.js";
import { createWorldContext } from "../src/world-spec.js";

const context = createWorldContext({
  seed: "metadata-save",
  generatorVersion: 3,
});
const stack = (id, count, name, durability, enchantments) => ({
  id,
  count,
  ...(durability === undefined ? {} : { durability }),
  data: { version: 1, name, ...(enchantments ? { enchantments } : {}) },
});

test("Gameplay v3 retains every owned metadata area, paid queue, XP, vitals and independent palettes", () => {
  const game = new Gameplay({ context });
  assert.equal(
    game.inventoryTransaction((draft) => {
      draft.slots[0] = stack(ITEM.APPLE, 2, "<b>Lunch</b>");
      draft.slots[5] = stack(ITEM.WOOD_PICKAXE, 1, "Miner", 11, {
        efficiency: 2,
      });
      draft.cursor = stack(ITEM.PAPER, 7, "Notes");
      draft.offhand = stack(ITEM.SHIELD, 1, "Guard", 17, { unbreaking: 2 });
      draft.equipment.head = stack(ITEM.IRON_HELMET, 1, "Helmet", 19, {
        protection: 2,
      });
      draft.craftingSize = 3;
      draft.craftingGrid[8] = stack(BLOCK.OAK_LOG, 2, "Retained escrow");
      draft.experienceTotal = 47;
      return true;
    }),
    true
  );
  game.setMode("creative");
  game.assignSlot(6, ITEM.BOOK);
  game.select(6);
  game.setMode("survival");
  game.select(5);
  game.add(ITEM.RAW_IRON, 1);
  game.add(ITEM.COAL, 1);
  assert.equal(game.craft("iron_ingot", { station: "furnace" }).ok, true);
  game.damage(4, "fall");
  game.update(3, { moving: true, underwater: true });
  const saved = JSON.parse(JSON.stringify(game.serialize()));
  assert.equal(saved.version, 3);
  assert.equal(saved.crafting[0].remaining, 7);
  assert.equal(saved.fuelTime, 70);
  assert.equal(saved.creativeSelected, 6);
  assert.equal(saved.survivalSelected, 5);
  assert.equal(saved.creativeHotbar[6], ITEM.BOOK);
  assert.equal(saved.experience.total, 47);
  const restored = new Gameplay({ context });
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  assert.deepEqual(restored.getState(), game.getState());
  assert.deepEqual(parseGameplaySave(saved, context).owned, {
    slots: saved.slots,
    cursor: saved.cursor,
    offhand: saved.offhand,
    equipment: saved.equipment,
    craftingGrid: saved.craftingGrid,
    craftingSize: saved.craftingSize,
    experienceTotal: saved.experience.total,
    fuelTime: saved.fuelTime,
  });

  const state = restored.getState();
  state.slots[5].data.enchantments.efficiency = 1;
  state.equipment.head.data.name = "Edited view";
  state.cursor.data.name = "Edited view";
  restored.getHandStack().data.name = "Edited hand";
  restored.offhand.data.enchantments.unbreaking = 1;
  saved.craftingGrid[8].data.name = "Edited import";
  saved.offhand.data.name = "Edited import";
  assert.deepEqual(restored.serialize(), game.serialize());
  game.update(7);
  restored.update(7);
  assert.deepEqual(restored.serialize(), game.serialize());
  assert.equal(restored.count(ITEM.IRON_INGOT), 1);
});

test("plain v2 saves migrate to v3 without invented data or losing prepaid fuel/output and XP", () => {
  const game = new Gameplay({ context });
  game.add(ITEM.RAW_IRON, 1);
  game.add(ITEM.COAL, 1);
  game.addExperience(35);
  game.craft("iron_ingot", { station: "furnace" });
  game.update(2);
  const canonical = game.serialize();
  const v2 = { ...structuredClone(canonical), version: 2 };
  const restored = new Gameplay({ context });
  assert.equal(restored.load(v2), true);
  assert.deepEqual(restored.serialize(), canonical);
  for (const entry of restored.slots.filter(Boolean))
    assert.equal(Object.hasOwn(entry, "data"), false);
  restored.update(8);
  restored.update(30);
  assert.equal(restored.count(ITEM.IRON_INGOT), 1);
  assert.equal(restored.getState().experience.total, 35);
  assert.equal(restored.getState().fuelTime, 70);
});

test("invalid v3 metadata and metadata smuggled into legacy aggregate records reject atomically", () => {
  let changes = 0;
  const game = new Gameplay({ context, onChange: () => changes++ });
  const before = game.serialize();
  for (const data of [
    { version: 2, name: "Unknown metadata version" },
    { version: 1, enchantments: { sharpness: 1 } },
    { version: 1, name: "control\u0000character" },
    { version: 1, potion: { id: "healing", form: "drinkable" } },
    { version: 1, extra: { nested: "unbounded" } },
  ]) {
    const invalid = structuredClone(before);
    invalid.slots[0].data = data;
    assert.equal(parseGameplaySave(invalid, context), null);
    assert.equal(game.load(invalid, { context }), false);
    assert.deepEqual(game.serialize(), before);
  }
  const legacy = { ...structuredClone(before), version: 1 };
  legacy.inventory[0].data = { version: 1, name: "Not an aggregate kind" };
  assert.equal(game.load(legacy), false);
  assert.equal(changes, 0);
});

test("ongoing hand use survives self wear/count consumption but not replacement, metadata or selection", () => {
  const game = new Gameplay({ context });
  game.inventoryTransaction((draft) => {
    draft.slots[0] = stack(ITEM.APPLE, 4, "Lunch");
    draft.offhand = stack(ITEM.SHIELD, 1, "Guard", 19);
    return true;
  });
  const shield = new ItemUse();
  const food = new ItemUse();
  shield.start(
    "shield",
    "offhand",
    game.getHandStack("offhand"),
    game.getHandRevision("offhand")
  );
  food.start("food", "main", game.getHandStack(), game.getHandRevision());
  const mainRevision = game.getHandRevision();
  const offRevision = game.getHandRevision("offhand");
  assert.equal(game.wearHand("offhand", 3), true);
  assert.equal(game.getHandRevision("offhand"), offRevision);
  assert.equal(
    shield.matches(
      game.getHandStack("offhand"),
      game.getHandRevision("offhand")
    ),
    true
  );
  assert.equal(game.consumeHand("main", 1), true);
  game.hunger = 10;
  assert.equal(game.eatFromHand(), true);
  assert.equal(game.getHandRevision(), mainRevision);
  assert.equal(food.matches(game.getHandStack(), game.getHandRevision()), true);
  assert.equal(game.addStack(stack(ITEM.PAPER, 1, "Other slot")), true);
  assert.equal(game.getHandRevision(), mainRevision);
  assert.equal(game.getHandRevision("off"), offRevision);

  game.inventoryTransaction((draft) => {
    draft.offhand = cloneStack(draft.offhand);
    return true;
  });
  assert.ok(game.getHandRevision("offhand") > offRevision);
  assert.equal(
    shield.matches(
      game.getHandStack("offhand"),
      game.getHandRevision("offhand")
    ),
    false
  );
  game.inventoryTransaction((draft) => {
    draft.slots[0].data.name = "A new identity";
    return true;
  });
  assert.equal(
    food.matches(game.getHandStack(), game.getHandRevision()),
    false
  );
  food.start("food", "main", game.getHandStack(), game.getHandRevision());
  game.select(1);
  game.select(0);
  assert.equal(
    food.matches(game.getHandStack(), game.getHandRevision()),
    false
  );
  assert.equal(game.getHandRevision("not-a-hand"), null);
});

test("swapping identical worn hands, breaking and reloading invalidate held identities", () => {
  const game = new Gameplay({ context });
  game.inventoryTransaction((draft) => {
    draft.slots[0] = stack(ITEM.SHIELD, 1, "Same", 3);
    draft.offhand = cloneStack(draft.slots[0]);
    return true;
  });
  const before = [game.getHandRevision(), game.getHandRevision("offhand")];
  assert.equal(game.swapHands(), true);
  assert.ok(game.getHandRevision() > before[0]);
  assert.ok(game.getHandRevision("offhand") > before[1]);
  const revision = game.getHandRevision();
  assert.equal(game.wearHand("main", 3), true);
  assert.ok(game.getHandRevision() > revision);
  assert.equal(game.getHandStack(), null);
  const offRevision = game.getHandRevision("offhand");
  assert.equal(game.load(game.serialize()), true);
  assert.ok(game.getHandRevision("offhand") > offRevision);
});
