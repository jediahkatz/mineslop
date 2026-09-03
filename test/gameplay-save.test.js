import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";

function populatedGame(options) {
  const game = new Gameplay(options);
  game.add(ITEM.WOOD_PICKAXE, 2);
  game.assignSlot(0, ITEM.WOOD_PICKAXE);
  game.select(0);
  for (let i = 0; i < 3; i++) game.harvest(BLOCK.STONE);
  game.add(ITEM.RAW_IRON, 2);
  game.add(ITEM.COAL, 1);
  game.craft("iron_ingot", { station: "furnace" });
  game.craft("iron_ingot", { station: "furnace" });
  game.update(3, { moving: true, underwater: true });
  return game;
}

test("JSON roundtrips preserve tool instances, paid queue progress, vitals, and fuel", () => {
  const game = populatedGame();
  const serialized = JSON.parse(JSON.stringify(game.serialize()));
  const restored = new Gameplay();
  assert.equal(restored.load(serialized), true);
  assert.deepEqual(restored.serialize(), serialized);
  assert.deepEqual(restored.getState(), game.getState());
  assert.deepEqual(restored.serialize().durability[ITEM.WOOD_PICKAXE], [
    getItem(ITEM.WOOD_PICKAXE).durability - 3,
    getItem(ITEM.WOOD_PICKAXE).durability,
  ]);
  game.update(17);
  restored.update(17);
  assert.deepEqual(restored.getState(), game.getState());
  assert.equal(restored.count(ITEM.IRON_INGOT), 2);
  assert.equal(restored.count(ITEM.RAW_IRON), 0);
  assert.equal(restored.count(ITEM.COAL), 0);
  const before = restored.serialize();
  assert.equal(restored.craft("iron_ingot", { station: "furnace" }).ok, false);
  assert.deepEqual(restored.serialize(), before);
  restored.update(40);
  assert.equal(restored.count(ITEM.IRON_INGOT), 2);
});

test("invalid saved fields are rejected atomically without callbacks", () => {
  let changes = 0;
  const game = populatedGame({ onChange: () => changes++ });
  const valid = game.serialize();
  const mutations = [
    (data) => {
      data.version = 999;
    },
    (data) => {
      data.mode = "hardcore";
    },
    (data) => {
      data.health = -1;
    },
    (data) => {
      data.health = Infinity;
    },
    (data) => {
      data.health = 0;
    },
    (data) => {
      data.dead = true;
    },
    (data) => {
      data.hunger = 21;
    },
    (data) => {
      data.air = NaN;
    },
    (data) => {
      data.saturation = -1;
    },
    (data) => {
      data.exhaustion = 4;
    },
    (data) => {
      data.exhaustion = Infinity;
    },
    (data) => {
      data.fuelTime = -1;
    },
    (data) => {
      data.fuelTime = 81;
    },
    (data) => {
      data.fuelTime = NaN;
    },
    (data) => {
      data.selected = 9;
    },
    (data) => {
      data.selected = 0.2;
    },
    (data) => {
      data.hotbar.pop();
    },
    (data) => {
      data.hotbar = Array(9);
    },
    (data) => {
      data.hotbar[1] = ITEM.DIAMOND_PICKAXE;
    },
    (data) => {
      data.survivalHotbar[1] = ITEM.DIAMOND_PICKAXE;
    },
    (data) => {
      data.hotbar[1] = "285";
    },
    (data) => {
      data.inventory[0].count = 0;
    },
    (data) => {
      data.inventory[0].count = -1;
    },
    (data) => {
      data.inventory[0].count = 1.1;
    },
    (data) => {
      data.inventory[0].count = "4";
    },
    (data) => {
      data.inventory[0].count = Infinity;
    },
    (data) => {
      data.inventory[0].count = Number.MAX_SAFE_INTEGER;
    },
    (data) => {
      data.inventory.push({ ...data.inventory[0] });
    },
    (data) => {
      data.inventory.push({ id: 9999, count: 1 });
    },
    (data) => {
      data.inventory.push({ id: BLOCK.AIR, count: 1 });
    },
    (data) => {
      delete data.durability[ITEM.WOOD_PICKAXE];
    },
    (data) => {
      data.durability[ITEM.WOOD_PICKAXE][0] = 0;
    },
    (data) => {
      data.durability[ITEM.WOOD_PICKAXE][0] =
        getItem(ITEM.WOOD_PICKAXE).durability + 1;
    },
    (data) => {
      data.durability[ITEM.WOOD_PICKAXE][0] = 0.5;
    },
    (data) => {
      data.durability[ITEM.WOOD_PICKAXE].push(1);
    },
    (data) => {
      data.durability[ITEM.WOOD_PICKAXE] = Array(2);
    },
    (data) => {
      data.durability[ITEM.APPLE] = [1, 1, 1, 1];
    },
    (data) => {
      data.durability[ITEM.IRON_PICKAXE] = [1];
    },
    (data) => {
      data.crafting[0].recipeId = "not_a_recipe";
    },
    (data) => {
      data.crafting[0].recipeId = "planks";
    },
    (data) => {
      data.crafting[0].remaining = -1;
    },
    (data) => {
      data.crafting[0].remaining = "0";
    },
    (data) => {
      data.crafting[0].remaining = 100;
    },
    (data) => {
      data.crafting[0].remaining = Infinity;
    },
    (data) => {
      data.crafting[1].remaining = 1;
    },
    (data) => {
      data.crafting = Array(17).fill(data.crafting[0]);
    },
    (data) => {
      data.timers.drowning = -1;
    },
    (data) => {
      data.timers.drowning = 1;
    },
    (data) => {
      data.timers.regen = Infinity;
    },
    (data) => {
      data.deathCause = "x".repeat(81);
    },
    (data) => {
      data.deathCause = "zombie";
    },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(valid);
    mutate(bad);
    const beforeChanges = changes;
    assert.equal(game.load(bad), false, mutate.toString());
    assert.deepEqual(game.serialize(), valid, mutate.toString());
    assert.equal(changes, beforeChanges);
  }
  for (const bad of [undefined, null, [], "save", {}, { version: 1 }]) {
    assert.equal(game.load(bad), false);
    assert.deepEqual(game.serialize(), valid);
  }
});

test("loaded queue output is derived from the recipe, never trusted from save data", () => {
  const saved = populatedGame().serialize();
  saved.crafting[0].output = { id: ITEM.DIAMOND, count: 100000 };
  saved.crafting[0].duration = 0;
  saved.timers.untrusted = Infinity;
  const game = new Gameplay();
  assert.equal(game.load(saved), true);
  assert.equal(game.getState().crafting[0].duration, 10);
  assert.equal(game.serialize().timers.untrusted, undefined);
  game.update(17);
  assert.equal(game.count(ITEM.IRON_INGOT), 2);
  assert.equal(game.count(ITEM.DIAMOND), 0);
});

test("a save cannot overbook output slots with a paid furnace queue", () => {
  const game = populatedGame();
  const saved = game.serialize();
  for (let index = 3; index < 36; index++)
    saved.slots[index] = { id: BLOCK.DIRT, count: 64 };
  // V2 permits omitting derived v1 projections. Exercise the real slot/queue
  // capacity rule, not just a disagreement between a projection and its slots.
  delete saved.inventory;
  delete saved.hotbar;
  delete saved.survivalHotbar;
  delete saved.durability;
  // Apples + two tools + 33 dirt stacks fill 36; the queued iron needs one more.
  const before = game.serialize();
  assert.equal(game.load(saved), false);
  assert.deepEqual(game.serialize(), before);
});

test("snapshots, serialization, and loaded data never alias mutable game state", () => {
  const game = populatedGame();
  const before = game.serialize();
  const state = game.getState();
  state.hotbar.fill(0);
  state.counts[ITEM.APPLE] = 9999;
  state.inventory[0].count = 9999;
  state.durability[ITEM.WOOD_PICKAXE] = 9999;
  state.crafting[0].remaining = 0;
  state.crafting[0].output.count = 9999;
  const saved = game.serialize();
  saved.durability[ITEM.WOOD_PICKAXE][0] = 1;
  saved.hotbar.fill(0);
  saved.survivalHotbar.fill(0);
  saved.inventory[0].count = 1;
  saved.crafting[0].remaining = 1;
  saved.timers.regen = 1;
  assert.deepEqual(game.serialize(), before);
  const valid = structuredClone(before);
  const restored = new Gameplay();
  assert.equal(restored.load(valid), true);
  valid.hotbar.fill(0);
  valid.durability[ITEM.WOOD_PICKAXE][0] = 1;
  valid.inventory[0].count = 1;
  valid.crafting[0].remaining = 1;
  valid.timers.regen = 1;
  assert.deepEqual(restored.serialize(), before);
});

test("creative saves preserve a separate survival hotbar and paid survival jobs", () => {
  const game = populatedGame();
  const oldHotbar = [...game.hotbar];
  game.setMode("creative");
  game.assignSlot(0, ITEM.DIAMOND_SWORD);
  const restored = new Gameplay();
  assert.equal(
    restored.load(JSON.parse(JSON.stringify(game.serialize()))),
    true
  );
  assert.equal(restored.selectedItem.id, ITEM.DIAMOND_SWORD);
  restored.update(17);
  assert.equal(restored.count(ITEM.IRON_INGOT), 2);
  restored.setMode("survival");
  assert.equal(restored.selectedItem.id, oldHotbar[0]);
  assert.equal(restored.count(ITEM.DIAMOND_SWORD), 0);
  assert.equal(restored.hotbar.includes(ITEM.DIAMOND_SWORD), false);
  const invalidCreative = game.serialize();
  invalidCreative.health = 10;
  assert.equal(restored.load(invalidCreative), false);
});

test("loading a death does not fire another death event or reset inventory", () => {
  const game = populatedGame();
  game.damage(100, "lava");
  let deaths = 0;
  const restored = new Gameplay({ onDeath: () => deaths++ });
  assert.equal(restored.load(game.serialize()), true);
  assert.equal(restored.dead, true);
  assert.equal(restored.health, 0);
  assert.equal(deaths, 0);
  assert.deepEqual(restored.getState().inventory, game.getState().inventory);
  restored.respawn();
  assert.equal(restored.dead, false);
  assert.equal(restored.health, 20);
  assert.equal(restored.count(ITEM.WOOD_PICKAXE), 2);
});

test("mixed gameplay transitions always produce finite, reloadable, capacity-safe saves", () => {
  let state = 719;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const game = new Gameplay({ random });
  const ids = [
    BLOCK.OAK_LOG,
    BLOCK.DIRT,
    ITEM.RAW_IRON,
    ITEM.COAL,
    ITEM.WOOD_PICKAXE,
    ITEM.APPLE,
  ];
  for (let step = 0; step < 300; step++) {
    const id = ids[Math.floor(random() * ids.length)];
    switch (Math.floor(random() * 12)) {
      case 0:
        game.add(id, 1);
        break;
      case 1:
        game.consume(id, 1);
        break;
      case 2:
        game.assignSlot(0, id);
        break;
      case 3:
        game.harvest(BLOCK.STONE);
        break;
      case 4:
        game.craft("planks");
        break;
      case 5:
        game.craft("iron_ingot", { station: "furnace" });
        break;
      case 6:
        game.update(random() * 2, { underwater: random() < 0.5 });
        break;
      case 7:
        game.attack();
        break;
      case 8:
        game.damage(3, "zombie");
        break;
      case 9:
        game.eat();
        break;
      case 10:
        game.respawn();
        break;
      case 11:
        game.setMode(game.mode === "survival" ? "creative" : "survival");
        break;
    }
    const snapshot = game.getState();
    assert.ok(snapshot.inventorySlotsUsed <= snapshot.inventorySlotsTotal);
    for (const count of Object.values(snapshot.counts))
      assert.ok(Number.isSafeInteger(count) && count > 0);
    for (const [tool, wear] of Object.entries(snapshot.durability)) {
      assert.ok(
        Number.isInteger(wear) &&
          wear > 0 &&
          wear <= getItem(Number(tool)).durability
      );
    }
    const saved = game.serialize();
    const restored = new Gameplay();
    assert.equal(
      restored.load(JSON.parse(JSON.stringify(saved))),
      true,
      `transition ${step}`
    );
    assert.deepEqual(restored.serialize(), saved);
  }
});
