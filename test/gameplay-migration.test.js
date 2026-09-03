import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";

function legacy(overrides = {}) {
  return {
    version: 1,
    mode: "survival",
    health: 20,
    hunger: 20,
    air: 20,
    saturation: 5,
    exhaustion: 0,
    dead: false,
    deathCause: null,
    inventory: [{ id: ITEM.APPLE, count: 4 }],
    hotbar: [ITEM.APPLE, ...Array(8).fill(0)],
    survivalHotbar: [ITEM.APPLE, ...Array(8).fill(0)],
    selected: 0,
    durability: {},
    crafting: [],
    fuelTime: 0,
    timers: { drowning: 0, lava: 0, starvation: 0, regen: 0 },
    ...overrides,
  };
}

test("v1 migration prioritizes the selected shortcut and spends each duplicate tool/wear entry once", () => {
  const data = legacy({
    inventory: [
      { id: ITEM.WOOD_PICKAXE, count: 2 },
      { id: BLOCK.DIRT, count: 130 },
      { id: ITEM.IRON_ARMOR, count: 1 },
      { id: ITEM.APPLE, count: 4 },
    ],
    hotbar: [
      ITEM.WOOD_PICKAXE,
      0,
      BLOCK.DIRT,
      ITEM.WOOD_PICKAXE,
      0,
      BLOCK.DIRT,
      ITEM.WOOD_PICKAXE,
      ITEM.IRON_ARMOR,
      ITEM.APPLE,
    ],
    selected: 6,
    durability: { [ITEM.WOOD_PICKAXE]: [7, 31], [ITEM.IRON_ARMOR]: [19] },
  });
  const game = new Gameplay();
  assert.equal(game.load(data), true);
  assert.equal(game.selected, 6);
  assert.equal(game.getHandStack().durability, 7);
  assert.equal(game.slots[0].durability, 31);
  assert.equal(game.slots[3], null);
  assert.equal(game.count(ITEM.WOOD_PICKAXE), 2);
  assert.equal(game.count(BLOCK.DIRT), 130);
  assert.equal(game.slots[2].count, 64);
  assert.equal(game.slots[5].count, 64);
  assert.deepEqual(game.slots[9], { id: BLOCK.DIRT, count: 2 });
  assert.equal(game.slots[7].durability, 19);
  assert.equal(game.getState().armorPoints, 0);
  assert.equal(
    game.inventoryAction({ type: "quickMove", area: "inventory", index: 7 }).ok,
    true
  );
  assert.equal(
    game.equipment.chest.durability,
    19,
    "legacy chest wear is not reset on equip"
  );
  const before = game.serialize();
  data.durability[ITEM.WOOD_PICKAXE].fill(1);
  data.hotbar.fill(0);
  data.inventory[0].count = 1;
  assert.deepEqual(game.serialize(), before);
});

test("nine duplicate shortcut IDs still describe one finite stack", () => {
  const game = new Gameplay();
  assert.equal(
    game.load(
      legacy({
        hotbar: Array(9).fill(ITEM.APPLE),
        survivalHotbar: Array(9).fill(ITEM.APPLE),
        selected: 8,
      })
    ),
    true
  );
  assert.equal(game.slots.filter(Boolean).length, 1);
  assert.deepEqual(game.slots[8], { id: ITEM.APPLE, count: 4 });
  assert.equal(game.selectedItem.id, ITEM.APPLE);
  assert.equal(game.count(ITEM.APPLE), 4);
});

test("an existing Creative custom palette/selection and four finite apples survive migration and mode changes", () => {
  const palette = [
    BLOCK.STONE,
    BLOCK.DIRT,
    BLOCK.OAK_LOG,
    BLOCK.PLANKS,
    BLOCK.COBBLESTONE,
    BLOCK.GLASS,
    BLOCK.CRAFTING_TABLE,
    BLOCK.CHEST,
    BLOCK.FURNACE,
  ];
  const game = new Gameplay();
  assert.equal(
    game.load(legacy({ mode: "creative", hotbar: palette, selected: 7 })),
    true
  );
  assert.deepEqual(game.hotbar, palette);
  assert.equal(game.selected, 7);
  assert.deepEqual(game.getState().inventory, [{ id: ITEM.APPLE, count: 4 }]);
  const canonical = game.serialize();
  assert.equal(canonical.version, 3);
  const restored = new Gameplay();
  assert.equal(restored.load(JSON.parse(JSON.stringify(canonical))), true);
  assert.deepEqual(restored.serialize(), canonical);
  assert.equal(restored.setMode("survival"), true);
  restored.select(3);
  assert.equal(restored.setMode("creative"), true);
  assert.equal(restored.selected, 7);
  assert.deepEqual(restored.hotbar, palette);
  assert.deepEqual(restored.slots, canonical.slots);
  for (let i = 0; i < 4; i++)
    assert.equal(restored.placed(BLOCK.DIAMOND_ORE), true);
  assert.equal(restored.craft("diamond_pickaxe").ok, true);
  assert.deepEqual(
    restored.slots,
    canonical.slots,
    "free placement and legacy craft do not mint finite inventory"
  );
});

test("only an explicit Creative catalog copy creates finite inventory; F/Q cannot mint a palette item", () => {
  const game = new Gameplay({ mode: "creative" });
  game.assignSlot(0, ITEM.SHIELD);
  const before = game.serialize();
  assert.equal(game.swapHands(), false);
  assert.equal(
    game.dropSelected({
      prepareDrops: () => assert.fail("virtual items are not drops"),
    }),
    false
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(
    game.inventoryAction({
      type: "creativePick",
      id: ITEM.SHIELD,
      hotbarIndex: 0,
    }).ok,
    false,
    "copying must not erase the four finite apples"
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(
    game.inventoryAction({
      type: "creativePick",
      id: ITEM.SHIELD,
      hotbarIndex: 5,
    }).ok,
    true
  );
  assert.equal(game.count(ITEM.SHIELD), 1);
  game.select(5);
  assert.equal(game.swapHands(), true);
  assert.equal(game.offhand.id, ITEM.SHIELD);
  assert.equal(game.count(ITEM.SHIELD), 0);
  assert.equal(game.count(ITEM.APPLE), 4);
  assert.equal(
    game.inventoryAction({
      type: "creativePick",
      id: BLOCK.DIRT,
      wholeStack: true,
    }).ok,
    true
  );
  assert.deepEqual(game.cursor, { id: BLOCK.DIRT, count: 64 });
  const occupied = game.serialize();
  assert.equal(
    game.inventoryAction({ type: "creativePick", id: ITEM.DIAMOND }).ok,
    false
  );
  assert.deepEqual(
    game.serialize(),
    occupied,
    "a finite cursor is never silently replaced"
  );
  game.setMode("survival");
  assert.equal(game.offhand.id, ITEM.SHIELD);
  assert.deepEqual(game.cursor, { id: BLOCK.DIRT, count: 64 });
});

test("an explicit Creative hotbar click makes a copied item usable without minting or losing its displaced stack", () => {
  const game = new Gameplay({ mode: "creative" });
  game.assignSlot(0, BLOCK.DIRT);
  assert.equal(
    game.inventoryAction({ type: "creativePick", id: ITEM.SHIELD }).ok,
    true
  );
  assert.equal(
    game.inventoryAction({
      type: "click",
      area: "inventory",
      index: 0,
      button: 0,
    }).ok,
    true
  );
  assert.equal(game.selectedItem.id, ITEM.SHIELD);
  assert.equal(game.slots[0].id, ITEM.SHIELD);
  assert.deepEqual(game.cursor, { id: ITEM.APPLE, count: 4 });
  assert.equal(game.swapHands(), true);
  assert.equal(game.offhand.id, ITEM.SHIELD);
  const palette = game.hotbar;
  assert.equal(game.inventoryAction({ type: "close" }).ok, true);
  assert.deepEqual(
    game.hotbar,
    palette,
    "returning escrow cannot rewrite custom palette slots"
  );
  assert.equal(game.count(ITEM.APPLE), 4);
  assert.equal(game.count(ITEM.SHIELD), 0);
});

test("paid v1 jobs drain once and unused fuel transfers as credit without a second fuel debit", () => {
  const data = legacy({
    inventory: [
      { id: ITEM.APPLE, count: 4 },
      { id: ITEM.RAW_IRON, count: 1 },
    ],
    crafting: [
      { recipeId: "iron_ingot", remaining: 7 },
      { recipeId: "steak", remaining: 10 },
    ],
    fuelTime: 70,
  });
  const game = new Gameplay();
  assert.equal(game.load(data), true);
  game.update(17);
  assert.equal(game.count(ITEM.IRON_INGOT), 1);
  assert.equal(game.count(ITEM.STEAK), 1);
  assert.equal(game.count(ITEM.RAW_IRON), 1);
  assert.equal(game.count(ITEM.COAL), 0);
  assert.equal(game.getState().fuelTime, 70);
  let furnaceCredit = 0;
  const before = game.serialize();
  assert.equal(
    game.inventoryTransaction(
      (draft) => {
        draft.fuelTime -= 40;
        return true;
      },
      { commit: () => false }
    ),
    false
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(
    game.inventoryTransaction(
      (draft) => {
        draft.fuelTime -= 40;
        return true;
      },
      {
        commit: () => {
          furnaceCredit += 40;
        },
      }
    ),
    true
  );
  assert.equal(furnaceCredit, 40);
  assert.equal(game.getState().fuelTime, 30);
  const restored = new Gameplay();
  assert.equal(
    restored.load(JSON.parse(JSON.stringify(game.serialize()))),
    true
  );
  restored.update(60);
  assert.equal(restored.count(ITEM.IRON_INGOT), 1);
  assert.equal(restored.count(ITEM.STEAK), 1);
  assert.equal(restored.craft("iron_ingot", { station: "furnace" }).ok, true);
  assert.equal(restored.getState().fuelTime, 20);
  restored.update(10);
  assert.equal(restored.count(ITEM.IRON_INGOT), 2);
  assert.equal(restored.count(ITEM.COAL), 0);
});

test("cursor, 3x3 inputs, actual equipment, offhand and XP roundtrip while a screen is open", () => {
  const game = new Gameplay();
  game.inventoryTransaction((draft) => {
    draft.cursor = { id: ITEM.WOOD_PICKAXE, count: 1, durability: 3 };
    draft.offhand = { id: ITEM.SHIELD, count: 1, durability: 73 };
    draft.equipment.head = { id: ITEM.IRON_HELMET, count: 1, durability: 19 };
    draft.craftingSize = 3;
    draft.craftingGrid[0] = { id: BLOCK.BIRCH_LOG, count: 3 };
    draft.craftingGrid[8] = { id: ITEM.APPLE, count: 1 };
    draft.experienceTotal = 47;
    return true;
  });
  const saved = JSON.parse(JSON.stringify(game.serialize()));
  const restored = new Gameplay();
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  assert.deepEqual(restored.getState(), game.getState());
  saved.cursor.durability = 1;
  saved.craftingGrid[0].count = 1;
  saved.equipment.head.durability = 1;
  saved.offhand.durability = 1;
  assert.deepEqual(restored.serialize(), game.serialize());
});

test("invalid v1 migrations and v2 canonical escrow fail before any active state or callback changes", () => {
  let changes = 0;
  const game = new Gameplay({ onChange: () => changes++ });
  game.addExperience(15);
  const before = game.serialize();
  const priorChanges = changes;
  for (const bad of [
    legacy({
      inventory: [
        { id: ITEM.APPLE, count: 4 },
        { id: ITEM.APPLE, count: 1 },
      ],
    }),
    legacy({ inventory: [{ id: ITEM.APPLE, count: 64 * 37 }] }),
    legacy({ hotbar: [ITEM.DIAMOND_PICKAXE, ...Array(8).fill(0)] }),
    legacy({
      inventory: [{ id: ITEM.WOOD_PICKAXE, count: 2 }],
      durability: { [ITEM.WOOD_PICKAXE]: [7] },
    }),
    legacy({ durability: { [ITEM.APPLE]: [1, 1, 1, 1] } }),
    legacy({ crafting: [{ recipeId: "iron_ingot", remaining: 0 }] }),
  ]) {
    assert.equal(game.load(bad), false);
    assert.deepEqual(game.serialize(), before);
    assert.equal(changes, priorChanges);
  }
  for (const mutate of [
    (data) => {
      data.slots = Array(36);
    },
    (data) => {
      data.cursor = { id: ITEM.WOOD_PICKAXE, count: 1 };
    },
    (data) => {
      data.cursor = { id: ITEM.WOOD_PICKAXE, count: 2, durability: 3 };
    },
    (data) => {
      data.offhand = { id: ITEM.APPLE, count: 65 };
    },
    (data) => {
      data.equipment.head = { id: ITEM.APPLE, count: 1 };
    },
    (data) => {
      data.craftingGrid[8] = { id: ITEM.APPLE, count: 1 };
    },
    (data) => {
      data.experience.total = -1;
    },
    (data) => {
      data.experience.level = 99;
    },
    (data) => {
      data.creativeHotbar[0] = 9999;
    },
  ]) {
    const bad = structuredClone(before);
    mutate(bad);
    assert.equal(game.load(bad), false, mutate.toString());
    assert.deepEqual(game.serialize(), before);
    assert.equal(changes, priorChanges);
  }
});
