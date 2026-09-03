import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCK_CATALOG } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";

function hold(game, id) {
  assert.equal(game.assignSlot(0, id), true);
  game.select(0);
}

function gather(game, id, count = 1) {
  const drops = [];
  for (let i = 0; i < count; i++) {
    for (const drop of game.harvest(id)) {
      drops.push(drop);
      assert.equal(game.add(drop.id, drop.count), true);
    }
  }
  return drops;
}

test("survival begins with four apples, no tools, and an owned-only hotbar", () => {
  const game = new Gameplay();
  assert.deepEqual(game.getState().inventory, [{ id: ITEM.APPLE, count: 4 }]);
  assert.equal(game.hotbar.length, 9);
  assert.equal(game.selectedItem.id, ITEM.APPLE);
  assert.equal(game.assignSlot(1, ITEM.IRON_PICKAXE), false);
  assert.equal(game.assignSlot(1, 0), true);
  assert.equal(game.select(1), true);
  assert.equal(game.selectedItem, null);
  assert.equal(game.select(9), false);
  assert.equal(game.select(0.5), false);
});

test("real log-to-diamond progression works without seeded materials or tools", () => {
  const game = new Gameplay({ random: () => 0.99 });
  assert.deepEqual(game.harvest(BLOCK.STONE), []);
  assert.deepEqual(game.harvest(BLOCK.IRON_ORE), []);
  gather(game, BLOCK.OAK_LOG, 8);
  for (let i = 0; i < 8; i++) assert.equal(game.craft("planks").ok, true);
  assert.equal(game.count(BLOCK.OAK_LOG), 0);
  assert.equal(game.craft("crafting_table").ok, true);
  assert.equal(game.placed(BLOCK.CRAFTING_TABLE), true);
  for (let i = 0; i < 3; i++) assert.equal(game.craft("sticks").ok, true);
  assert.equal(game.craft("wood_pickaxe", { station: "table" }).ok, true);
  hold(game, ITEM.WOOD_PICKAXE);
  gather(game, BLOCK.STONE, 11);
  assert.equal(game.count(BLOCK.COBBLESTONE), 11);
  assert.deepEqual(game.harvest(BLOCK.IRON_ORE), []);
  assert.equal(game.craft("stone_pickaxe", { station: "table" }).ok, true);
  assert.equal(game.craft("furnace", { station: "table" }).ok, true);
  assert.equal(game.placed(BLOCK.FURNACE), true);
  assert.equal(game.count(BLOCK.COBBLESTONE), 0);
  hold(game, ITEM.STONE_PICKAXE);
  gather(game, BLOCK.IRON_ORE, 3);
  gather(game, BLOCK.COAL_ORE);
  assert.equal(game.count(ITEM.RAW_IRON), 3);
  assert.deepEqual(game.harvest(BLOCK.DIAMOND_ORE), []);
  for (let i = 0; i < 3; i++)
    assert.equal(game.craft("iron_ingot", { station: "furnace" }).ok, true);
  assert.equal(game.count(ITEM.IRON_INGOT), 0);
  assert.equal(game.count(ITEM.COAL), 0);
  game.update(30);
  assert.equal(game.count(ITEM.IRON_INGOT), 3);
  assert.equal(game.craft("iron_pickaxe", { station: "table" }).ok, true);
  hold(game, ITEM.IRON_PICKAXE);
  gather(game, BLOCK.DIAMOND_ORE, 3);
  assert.equal(game.count(ITEM.DIAMOND), 3);
  assert.deepEqual(game.harvest(BLOCK.OBSIDIAN), []);
  assert.equal(game.craft("diamond_pickaxe", { station: "table" }).ok, true);
  hold(game, ITEM.DIAMOND_PICKAXE);
  assert.deepEqual(gather(game, BLOCK.OBSIDIAN), [
    { id: BLOCK.OBSIDIAN, count: 1 },
  ]);
  assert.equal(game.count(ITEM.DIAMOND), 0);
  assert.equal(game.count(ITEM.IRON_INGOT), 0);
  assert.ok(
    game.getState().durability[ITEM.WOOD_PICKAXE] <
      getItem(ITEM.WOOD_PICKAXE).durability
  );
});

test("harvest returns drops once and never also inserts them in the backpack", () => {
  const game = new Gameplay();
  const drops = game.harvest(BLOCK.OAK_LOG);
  assert.deepEqual(drops, [{ id: BLOCK.OAK_LOG, count: 1 }]);
  assert.equal(game.count(BLOCK.OAK_LOG), 0);
  assert.equal(game.add(drops[0].id, drops[0].count), true);
  assert.equal(game.count(BLOCK.OAK_LOG), 1);
  assert.ok(game.hotbar.includes(BLOCK.OAK_LOG));
});

test("ore and stone drops require the right tool family and mining tier", () => {
  const ores = [
    [BLOCK.STONE, 1, BLOCK.COBBLESTONE],
    [BLOCK.COAL_ORE, 1, ITEM.COAL],
    [BLOCK.IRON_ORE, 2, ITEM.RAW_IRON],
    [BLOCK.COPPER_ORE, 2, ITEM.RAW_COPPER],
    [BLOCK.LAPIS_ORE, 2, ITEM.LAPIS],
    [BLOCK.GOLD_ORE, 3, ITEM.RAW_GOLD],
    [BLOCK.DIAMOND_ORE, 3, ITEM.DIAMOND],
    [BLOCK.REDSTONE_ORE, 3, ITEM.REDSTONE],
    [BLOCK.EMERALD_ORE, 3, ITEM.EMERALD],
    [BLOCK.OBSIDIAN, 4, BLOCK.OBSIDIAN],
  ];
  for (const tool of [
    ITEM.WOOD_PICKAXE,
    ITEM.STONE_PICKAXE,
    ITEM.IRON_PICKAXE,
    ITEM.DIAMOND_PICKAXE,
  ]) {
    const game = new Gameplay();
    game.add(tool);
    hold(game, tool);
    for (const [block, tier, dropId] of ores) {
      const drops = game.harvest(block);
      assert.ok(
        Number.isFinite(game.miningDuration(block)),
        "wrong tier can still break a block"
      );
      if (getItem(tool).tier >= tier) assert.equal(drops[0].id, dropId);
      else assert.deepEqual(drops, []);
    }
  }
  const axe = new Gameplay();
  axe.add(ITEM.DIAMOND_AXE);
  hold(axe, ITEM.DIAMOND_AXE);
  assert.deepEqual(axe.harvest(BLOCK.DIAMOND_ORE), []);
});

test("holding a rock is not a pickaxe just because the block is mined by one", () => {
  const game = new Gameplay();
  game.assignSlot(0, 0);
  const bareHand = game.miningDuration(BLOCK.STONE);
  for (const block of [BLOCK.COBBLESTONE, BLOCK.IRON_ORE, BLOCK.DIAMOND_ORE]) {
    game.add(block);
    hold(game, block);
    assert.deepEqual(game.harvest(BLOCK.COAL_ORE), []);
    assert.deepEqual(game.harvest(BLOCK.DIAMOND_ORE), []);
    assert.equal(game.miningDuration(BLOCK.STONE), bareHand);
    assert.equal(getItem(block).tool, undefined);
  }
});

test("pickaxes, axes, and shovels accelerate their own material, not everything", () => {
  const game = new Gameplay();
  game.assignSlot(0, 0);
  const stoneByHand = game.miningDuration(BLOCK.STONE);
  const woodByHand = game.miningDuration(BLOCK.OAK_LOG);
  const dirtByHand = game.miningDuration(BLOCK.DIRT);
  for (const id of [
    ITEM.WOOD_PICKAXE,
    ITEM.IRON_PICKAXE,
    ITEM.WOOD_AXE,
    ITEM.WOOD_SHOVEL,
  ])
    game.add(id);
  hold(game, ITEM.WOOD_PICKAXE);
  const woodPickSpeed = game.miningDuration(BLOCK.STONE);
  assert.ok(woodPickSpeed < stoneByHand);
  hold(game, ITEM.IRON_PICKAXE);
  assert.ok(game.miningDuration(BLOCK.STONE) < woodPickSpeed);
  assert.equal(game.miningDuration(BLOCK.OAK_LOG), woodByHand);
  hold(game, ITEM.WOOD_AXE);
  assert.ok(game.miningDuration(BLOCK.OAK_LOG) < woodByHand);
  assert.equal(game.miningDuration(BLOCK.DIRT), dirtByHand);
  hold(game, ITEM.WOOD_SHOVEL);
  assert.ok(game.miningDuration(BLOCK.DIRT) < dirtByHand);
});

test("unbreakable blocks and invalid IDs neither drop items nor wear tools", () => {
  const game = new Gameplay();
  game.add(ITEM.DIAMOND_PICKAXE);
  hold(game, ITEM.DIAMOND_PICKAXE);
  const before = game.serialize();
  for (const id of [
    BLOCK.AIR,
    BLOCK.BEDROCK,
    BLOCK.WATER,
    BLOCK.LAVA,
    BLOCK.NETHER_PORTAL,
    BLOCK.END_PORTAL,
    -1,
    9999,
    NaN,
    "3",
  ]) {
    assert.equal(game.miningDuration(id), Infinity);
    assert.deepEqual(game.harvest(id), []);
  }
  assert.deepEqual(game.serialize(), before);
});

test("all biome blocks have finite break times or intentional unbreakability, including empty-hand foliage", () => {
  const game = new Gameplay({ random: () => 0.99 });
  game.assignSlot(0, 0);
  for (const block of BLOCK_CATALOG) {
    const duration = game.miningDuration(block.id);
    assert.ok(
      duration === Infinity || (Number.isFinite(duration) && duration > 0),
      block.name
    );
    for (const drop of game.harvest(block.id)) {
      assert.ok(getItem(drop.id), block.name);
      assert.ok(Number.isInteger(drop.count) && drop.count > 0);
    }
  }
  assert.deepEqual(game.harvest(BLOCK.GLASS), []);
});

test("foliage, grass, crops, and gravel produce usable survival resources", () => {
  const game = new Gameplay({ random: () => 0 });
  assert.deepEqual(game.harvest(BLOCK.LEAVES), [
    { id: ITEM.STICK, count: 1 },
    { id: ITEM.APPLE, count: 1 },
  ]);
  assert.deepEqual(game.harvest(BLOCK.TALL_GRASS), [
    { id: ITEM.SEEDS, count: 1 },
  ]);
  assert.deepEqual(game.harvest(BLOCK.WHEAT_CROP), [
    { id: ITEM.WHEAT, count: 1 },
    { id: ITEM.SEEDS, count: 1 },
  ]);
  assert.deepEqual(game.harvest(BLOCK.GRAVEL), [{ id: ITEM.FLINT, count: 1 }]);
  assert.deepEqual(game.harvest(BLOCK.GRASS), [{ id: BLOCK.DIRT, count: 1 }]);
});

test("each copy of a tool has separate durability and the final use still earns its drop", () => {
  const broken = [];
  const game = new Gameplay({ onToast: (text) => broken.push(text) });
  game.add(ITEM.WOOD_PICKAXE, 2);
  hold(game, ITEM.WOOD_PICKAXE);
  const durability = getItem(ITEM.WOOD_PICKAXE).durability;
  for (let i = 0; i < durability; i++) {
    assert.deepEqual(game.harvest(BLOCK.STONE), [
      { id: BLOCK.COBBLESTONE, count: 1 },
    ]);
  }
  assert.equal(game.count(ITEM.WOOD_PICKAXE), 1);
  assert.equal(game.getState().durability[ITEM.WOOD_PICKAXE], durability);
  assert.equal(broken.filter((text) => text.includes("broke")).length, 1);
  assert.equal(
    game.selectedItem,
    null,
    "breaking a copy leaves that physical slot empty"
  );
  hold(game, ITEM.WOOD_PICKAXE);
  for (let i = 0; i < durability; i++) game.harvest(BLOCK.STONE);
  assert.equal(game.count(ITEM.WOOD_PICKAXE), 0);
  assert.equal(game.selectedItem, null);
  assert.equal(game.hotbar.includes(ITEM.WOOD_PICKAXE), false);
  assert.deepEqual(game.harvest(BLOCK.STONE), []);
  assert.equal(game.getState().durability[ITEM.WOOD_PICKAXE], undefined);
});

test("new tools occupy stable slots; explicit assignment swaps an upgrade without deleting the old tool", () => {
  const game = new Gameplay();
  game.add(ITEM.WOOD_PICKAXE);
  const slot = game.hotbar.indexOf(ITEM.WOOD_PICKAXE);
  game.add(ITEM.STONE_PICKAXE);
  assert.equal(game.hotbar[slot], ITEM.WOOD_PICKAXE);
  assert.equal(game.assignSlot(slot, ITEM.STONE_PICKAXE), true);
  assert.equal(game.hotbar[slot], ITEM.STONE_PICKAXE);
  assert.equal(game.count(ITEM.WOOD_PICKAXE), 1);
  game.consume(ITEM.STONE_PICKAXE);
  assert.equal(game.hotbar[slot], 0);
  assert.equal(game.assignSlot(slot, ITEM.WOOD_PICKAXE), true);
});

test("combat returns damage and wears swords less than improvised mining weapons", () => {
  const game = new Gameplay();
  assert.equal(game.attackDamage(), 1);
  for (const tool of [ITEM.WOOD_SWORD, ITEM.IRON_SWORD, ITEM.WOOD_PICKAXE])
    game.add(tool);
  hold(game, ITEM.IRON_SWORD);
  const swordDamage = game.attackDamage();
  assert.equal(game.attack(), swordDamage);
  assert.equal(
    game.getState().durability[ITEM.IRON_SWORD],
    getItem(ITEM.IRON_SWORD).durability - 1
  );
  hold(game, ITEM.WOOD_SWORD);
  assert.ok(game.attackDamage() < swordDamage);
  game.harvest(BLOCK.OAK_LOG);
  assert.equal(
    game.getState().durability[ITEM.WOOD_SWORD],
    getItem(ITEM.WOOD_SWORD).durability - 2
  );
  hold(game, ITEM.WOOD_PICKAXE);
  game.attack();
  assert.equal(
    game.getState().durability[ITEM.WOOD_PICKAXE],
    getItem(ITEM.WOOD_PICKAXE).durability - 2
  );
});

test("a bow cannot fire free arrows or wear itself on an empty shot", () => {
  const game = new Gameplay();
  game.add(ITEM.BOW);
  hold(game, ITEM.BOW);
  const before = game.serialize();
  assert.equal(game.attack(), 0);
  assert.deepEqual(game.serialize(), before);
  game.add(ITEM.ARROW, 1);
  assert.equal(game.attack(), getItem(ITEM.BOW).damage);
  assert.equal(game.count(ITEM.ARROW), 0);
  assert.equal(
    game.getState().durability[ITEM.BOW],
    getItem(ITEM.BOW).durability - 1
  );
  assert.equal(game.attack(), 0);
});

test("inventory rejects invalid counts atomically and respects stack capacity", () => {
  const game = new Gameplay();
  const before = game.serialize();
  for (const count of [
    0,
    -1,
    0.5,
    Infinity,
    NaN,
    "2",
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.equal(game.add(BLOCK.DIRT, count), false);
    assert.equal(game.consume(ITEM.APPLE, count), false);
    assert.deepEqual(game.serialize(), before);
  }
  for (const id of [0, -1, 99999, "285", undefined]) {
    assert.equal(game.add(id), false);
    assert.equal(game.consume(id), false);
    assert.equal(game.assignSlot(0, id), id === 0);
  }
  assert.equal(game.add(BLOCK.DIRT, 64 * 35), true);
  assert.equal(game.getState().inventorySlotsUsed, 36);
  assert.equal(game.add(BLOCK.DIRT, 1), false);
  assert.equal(game.add(ITEM.WOOD_AXE, 1), false);
  assert.equal(
    game.add(ITEM.APPLE, 60),
    true,
    "an existing stack can still fill"
  );
  assert.equal(game.add(ITEM.APPLE, 1), false);
});

test("placing is an atomic boolean debit, rejects non-blocks, and clears depleted slots", () => {
  const game = new Gameplay();
  assert.equal(game.canPlace(BLOCK.DIRT), false);
  assert.equal(game.placed(BLOCK.DIRT), false);
  game.add(BLOCK.DIRT, 2);
  hold(game, BLOCK.DIRT);
  assert.equal(game.placed(BLOCK.DIRT), true);
  assert.equal(game.count(BLOCK.DIRT), 1);
  assert.equal(game.placed(BLOCK.DIRT), true);
  assert.equal(game.count(BLOCK.DIRT), 0);
  assert.equal(game.selectedItem, null);
  assert.equal(game.placed(BLOCK.DIRT), false);
  assert.equal(game.placed(ITEM.APPLE), false);
  assert.equal(game.count(ITEM.APPLE), 4);
});

test("eating consumes one selected food, caps hunger, and refuses full hunger or non-food", () => {
  const game = new Gameplay();
  assert.equal(game.eat(), false);
  assert.equal(game.count(ITEM.APPLE), 4);
  game.hunger = 14;
  game.saturation = 0;
  assert.equal(game.eat(), true);
  assert.equal(game.hunger, 18);
  assert.equal(game.count(ITEM.APPLE), 3);
  assert.ok(game.saturation > 0);
  assert.equal(game.eat(), true);
  assert.equal(game.hunger, 20);
  assert.equal(game.count(ITEM.APPLE), 2);
  assert.equal(game.eat(), false);
  game.add(BLOCK.DIRT, 1);
  hold(game, BLOCK.DIRT);
  game.hunger = 10;
  assert.equal(game.eat(), false);
  assert.equal(game.count(BLOCK.DIRT), 1);
});

test("sprinting spends hunger faster and hunger gates regeneration", () => {
  const walking = new Gameplay();
  const sprinting = new Gameplay();
  walking.saturation = sprinting.saturation = 0;
  walking.update(60, { moving: true });
  sprinting.update(60, { moving: true, sprinting: true });
  assert.ok(sprinting.hunger < walking.hunger);
  const fed = new Gameplay();
  fed.damage(10);
  fed.update(4);
  assert.equal(fed.health, 11);
  fed.hunger = 10;
  fed.update(12);
  assert.equal(fed.health, 11);
  fed.hunger = fed.saturation = 0;
  fed.update(4);
  assert.equal(fed.health, 10);
});

test("air depletes before drowning, and surfacing replenishes it", () => {
  const game = new Gameplay();
  game.update(14, { underwater: true });
  assert.equal(game.health, 20);
  assert.ok(game.air > 0 && game.air < 2);
  game.update(2, { underwater: true });
  assert.equal(game.air, 0);
  assert.equal(game.health, 18);
  game.update(5);
  assert.equal(game.air, 20);
  assert.ok(game.health >= 18);
});

test("lava and falls deal damage, water cushions falls, and armor wears while protecting", () => {
  const lava = new Gameplay();
  lava.update(0.5, { inLava: true });
  assert.equal(lava.health, 16);
  const fall = new Gameplay();
  fall.update(0.01, { fallDistance: 6 });
  assert.equal(fall.health, 17);
  const swimming = new Gameplay();
  swimming.update(0.01, { fallDistance: 20, inWater: true });
  assert.equal(swimming.health, 20);
  const carried = new Gameplay();
  carried.add(ITEM.IRON_ARMOR);
  assert.equal(
    carried.damage(10, "zombie"),
    10,
    "armor must actually be equipped"
  );
  const armored = new Gameplay();
  armored.add(ITEM.IRON_ARMOR);
  assert.equal(
    armored.inventoryAction({
      type: "quickMove",
      area: "inventory",
      index: armored.slots.findIndex((stack) => stack?.id === ITEM.IRON_ARMOR),
    }).ok,
    true
  );
  assert.equal(armored.getState().armorPoints, 6);
  assert.ok(Math.abs(armored.damage(10, "zombie") - 9.52) < 1e-10);
  assert.equal(
    armored.getState().equipment.chest.durability,
    getItem(ITEM.IRON_ARMOR).durability - 2
  );
  assert.equal(armored.damage(2, "drowning"), 2);
});

test("death fires once, stops actions, and respawn keeps paid inventory and wear", () => {
  const deaths = [];
  const game = new Gameplay({ onDeath: (cause) => deaths.push(cause) });
  game.add(ITEM.WOOD_SWORD);
  hold(game, ITEM.WOOD_SWORD);
  game.attack();
  const inventory = game.getState().inventory;
  const durability = game.getState().durability;
  game.damage(100, "zombie");
  assert.equal(game.dead, true);
  assert.equal(game.health, 0);
  assert.deepEqual(deaths, ["zombie"]);
  assert.equal(game.damage(1), 0);
  assert.equal(game.attack(), 0);
  assert.equal(game.eat(), false);
  assert.equal(game.add(BLOCK.DIRT), false);
  assert.equal(game.consume(ITEM.APPLE), false);
  assert.equal(game.placed(BLOCK.DIRT), false);
  assert.equal(game.craft("planks").reason, "dead");
  assert.deepEqual(game.harvest(BLOCK.OAK_LOG), []);
  game.update(60, { inLava: true, underwater: true });
  assert.deepEqual(deaths, ["zombie"]);
  game.respawn();
  assert.equal(game.dead, false);
  assert.equal(game.health, 20);
  assert.equal(game.hunger, 20);
  assert.equal(game.air, 20);
  assert.deepEqual(game.getState().inventory, inventory);
  assert.deepEqual(game.getState().durability, durability);
});

test("creative is unlimited without infinite counts, damage, wear, or survival item minting", () => {
  const game = new Gameplay();
  game.add(ITEM.WOOD_PICKAXE);
  hold(game, ITEM.WOOD_PICKAXE);
  game.harvest(BLOCK.STONE);
  const inventory = game.getState().inventory;
  const durability = game.getState().durability;
  game.setMode("creative");
  assert.equal(game.canPlace(BLOCK.DIAMOND_ORE), true);
  for (let i = 0; i < 10; i++)
    assert.equal(game.placed(BLOCK.DIAMOND_ORE), true);
  assert.equal(game.count(BLOCK.DIAMOND_ORE), 0);
  assert.deepEqual(game.harvest(BLOCK.DIAMOND_ORE), []);
  assert.equal(game.craft("diamond_pickaxe").ok, true);
  assert.equal(game.selectedItem.id, ITEM.DIAMOND_PICKAXE);
  game.attack();
  game.damage(500, "zombie");
  game.update(60, {
    moving: true,
    sprinting: true,
    underwater: true,
    inLava: true,
    fallDistance: 100,
  });
  assert.equal(game.health, 20);
  assert.equal(game.hunger, 20);
  assert.equal(game.air, 20);
  assert.deepEqual(game.getState().inventory, inventory);
  assert.deepEqual(game.getState().durability, durability);
  assert.ok(Object.values(game.getState().counts).every(Number.isFinite));
  game.setMode("survival");
  assert.equal(game.count(ITEM.DIAMOND_PICKAXE), 0);
  assert.equal(game.hotbar.includes(ITEM.DIAMOND_PICKAXE), false);
  assert.equal(game.selectedItem.id, ITEM.WOOD_PICKAXE);
});

test("invalid time, damage, modes, and selections cannot poison survival numbers", () => {
  const game = new Gameplay();
  const before = game.serialize();
  for (const value of [Infinity, NaN, -1, "4", undefined]) {
    game.update(value, { underwater: true, inLava: true });
    game.damage(value);
  }
  game.setMode("hardcore");
  game.select(Infinity);
  assert.deepEqual(game.serialize(), before);
});

test("hazards produce the same outcome at small and large frame intervals", () => {
  const large = new Gameplay();
  const small = new Gameplay();
  large.update(17, { underwater: true });
  for (let i = 0; i < 170; i++) small.update(0.1, { underwater: true });
  assert.equal(large.health, small.health);
  assert.equal(large.air, small.air);
  assert.equal(large.hunger, small.hunger);
  assert.ok(Math.abs(large.exhaustion - small.exhaustion) < 1e-8);
});
