import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay, INVENTORY_SLOTS } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";
import {
  CHEST_SLOTS,
  CROP_GROW_SECONDS,
  Settlement,
} from "../src/settlement.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { WORLD_HEIGHT, WORLD_MAX, World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  ContainerWorld as FarmWorld,
  dropCollector,
} from "./container-fixture.js";

function player(mode = "survival", options = {}) {
  const game = new Gameplay(options);
  game.consume(ITEM.APPLE, 4);
  if (mode === "creative") game.setMode(mode);
  return game;
}
function chestFixture(mode) {
  const world = new FarmWorld();
  const ownership = { coordinator: world.coordinator, context: world.context };
  const settlement = new Settlement(ownership),
    game = player(mode, ownership);
  const hit = { x: -2, y: 20, z: 3, id: BLOCK.CHEST };
  world.set(hit.x, hit.y, hit.z, hit.id);
  return { world, settlement, game, hit };
}
function farmFixture(soil = BLOCK.GRASS, mode) {
  const world = new FarmWorld();
  const ownership = { coordinator: world.coordinator, context: world.context };
  const settlement = new Settlement(ownership),
    game = player(mode, ownership);
  const hit = { x: 2, y: 20, z: 3, id: soil };
  world.set(hit.x, hit.y, hit.z, soil);
  game.add(ITEM.SEEDS, 8);
  game.assignSlot(0, ITEM.SEEDS);
  game.select(0);
  return { world, settlement, game, hit };
}
const snapshot = ({ settlement, game }) => [
  settlement.serialize(),
  game.serialize(),
];
const cropHit = (hit, id = BLOCK.TALL_GRASS) => ({ ...hit, y: hit.y + 1, id });
const age = (settlement, world, hit) =>
  settlement.crops.get(settlement.chestKey(world, hit.x, hit.y + 1, hit.z))
    ?.age;

test("chests use dimension-scoped keys and require real loaded chest blocks", () => {
  const { world, settlement, hit } = chestFixture();
  const chest = settlement.getChest(world, hit);
  assert.ok(chest instanceof Map);
  assert.equal(chest.size, 0);
  assert.equal(settlement.getChest(world, hit), chest);
  const overworld = settlement.chestKey(world, hit.x, hit.y, hit.z);
  world.dimension = "nether";
  assert.notEqual(settlement.chestKey(world, hit.x, hit.y, hit.z), overworld);
  assert.equal(settlement.getChest(world, hit), null);
  for (const bad of [
    null,
    {},
    { ...hit, x: 0.5 },
    { ...hit, y: 0 },
    { ...hit, x: WORLD_MAX },
  ]) {
    assert.equal(settlement.getChest(world, bad), null);
  }
  assert.equal(settlement.chestKey({ dimension: "unknown" }, 0, 5, 0), null);
});

test("single and whole-item transfers conserve inventory and update the live chest map", () => {
  const { world, settlement, game, hit } = chestFixture();
  game.add(BLOCK.OAK_LOG, 7);
  const chest = settlement.getChest(world, hit);
  assert.equal(
    settlement.transferToChest(world, hit, game, BLOCK.OAK_LOG),
    true
  );
  assert.equal(game.count(BLOCK.OAK_LOG), 6);
  assert.equal(chest.get(BLOCK.OAK_LOG), 1);
  assert.equal(
    settlement.transferToChest(world, hit, game, BLOCK.OAK_LOG, 6),
    true
  );
  assert.equal(game.count(BLOCK.OAK_LOG), 0);
  assert.equal(chest.get(BLOCK.OAK_LOG), 7);
  assert.equal(
    settlement.transferFromChest(world, hit, game, BLOCK.OAK_LOG, 7),
    true
  );
  assert.equal(game.count(BLOCK.OAK_LOG), 7);
  assert.equal(chest.has(BLOCK.OAK_LOG), false);
  assert.equal(
    settlement.transferFromChest(world, hit, game, BLOCK.OAK_LOG),
    false
  );
});

test("invalid IDs, negative/fractional/overflow amounts and overdrafts are atomic", () => {
  const fixture = chestFixture();
  const { world, settlement, game, hit } = fixture;
  game.add(BLOCK.DIRT, 5);
  const beforeEmpty = snapshot(fixture);
  assert.equal(
    settlement.transferToChest(world, hit, game, BLOCK.DIRT, 6),
    false
  );
  assert.deepEqual(snapshot(fixture), beforeEmpty);
  settlement.transferToChest(world, hit, game, BLOCK.DIRT, 3);
  const before = snapshot(fixture);
  for (const count of [
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
  ]) {
    assert.equal(
      settlement.transferToChest(world, hit, game, BLOCK.DIRT, count),
      false
    );
    assert.equal(
      settlement.transferFromChest(world, hit, game, BLOCK.DIRT, count),
      false
    );
    assert.deepEqual(snapshot(fixture), before);
  }
  for (const id of [0, -1, 999999, "2", null, NaN, undefined]) {
    assert.equal(settlement.transferToChest(world, hit, game, id), false);
    assert.equal(settlement.transferFromChest(world, hit, game, id), false);
    assert.deepEqual(snapshot(fixture), before);
  }
  assert.equal(
    settlement.transferFromChest(world, hit, game, BLOCK.DIRT, 4),
    false
  );
  assert.deepEqual(snapshot(fixture), before);
});

test("unloaded, removed and stale-dimension chests cannot move inventory", () => {
  const fixture = chestFixture();
  const { world, settlement, game, hit } = fixture;
  game.add(ITEM.WHEAT, 4);
  settlement.transferToChest(world, hit, game, ITEM.WHEAT, 2);
  const before = snapshot(fixture);
  world.unloaded.add(world.column(hit.x, hit.z));
  assert.equal(
    settlement.transferFromChest(world, hit, game, ITEM.WHEAT),
    false
  );
  assert.equal(settlement.transferToChest(world, hit, game, ITEM.WHEAT), false);
  world.unloaded.clear();
  assert.equal(
    settlement.transferToChest(
      world,
      { ...hit, dimension: "nether" },
      game,
      ITEM.WHEAT
    ),
    false
  );
  world.set(hit.x, hit.y, hit.z, BLOCK.AIR);
  assert.equal(
    settlement.transferFromChest(world, hit, game, ITEM.WHEAT),
    false
  );
  assert.deepEqual(snapshot(fixture), before);
});

test("a full chest rejects the complete deposit before consuming anything", () => {
  const fixture = chestFixture();
  const { world, settlement, game, hit } = fixture;
  const maximum = CHEST_SLOTS * getItem(BLOCK.DIRT).stackSize;
  game.add(BLOCK.DIRT, maximum + 1);
  assert.equal(
    settlement.transferToChest(world, hit, game, BLOCK.DIRT, maximum),
    true
  );
  const before = snapshot(fixture);
  assert.equal(settlement.transferToChest(world, hit, game, BLOCK.DIRT), false);
  assert.deepEqual(snapshot(fixture), before);
});

test("full backpacks and furnace-reserved slots reject withdrawals without losing chest items", () => {
  for (const queued of [false, true]) {
    const fixture = chestFixture();
    const { world, settlement, game, hit } = fixture;
    game.add(ITEM.WHEAT, 2);
    settlement.transferToChest(world, hit, game, ITEM.WHEAT, 2);
    if (queued) {
      game.add(BLOCK.DIRT, 64 * (INVENTORY_SLOTS - 2));
      game.add(ITEM.RAW_IRON, 2);
      game.add(ITEM.COAL, 1);
      assert.equal(game.craft("iron_ingot", { station: "furnace" }).ok, true);
    } else game.add(BLOCK.DIRT, 64 * INVENTORY_SLOTS);
    const before = snapshot(fixture);
    assert.equal(
      settlement.transferFromChest(world, hit, game, ITEM.WHEAT, 2),
      false
    );
    assert.deepEqual(snapshot(fixture), before);
    game.consume(BLOCK.DIRT, 64);
    assert.equal(
      settlement.transferFromChest(world, hit, game, ITEM.WHEAT, 2),
      true
    );
  }
});

test("creative chests move finite owned inventory without creative-consume duplication", () => {
  const { world, settlement, game, hit } = chestFixture("creative");
  game.add(BLOCK.PLANKS, 4);
  const hotbar = [...game.hotbar];
  assert.equal(
    settlement.transferToChest(world, hit, game, BLOCK.PLANKS, 4),
    true
  );
  assert.equal(game.count(BLOCK.PLANKS), 0);
  assert.equal(settlement.getChest(world, hit).get(BLOCK.PLANKS), 4);
  assert.equal(
    settlement.transferToChest(world, hit, game, BLOCK.PLANKS),
    false
  );
  assert.equal(
    settlement.transferToChest(world, hit, game, BLOCK.STONE),
    false
  );
  assert.deepEqual(game.hotbar, hotbar);
  assert.equal(game.mode, "creative");
  assert.equal(
    settlement.transferFromChest(world, hit, game, BLOCK.PLANKS, 2),
    true
  );
  assert.equal(game.count(BLOCK.PLANKS), 2);
  assert.equal(settlement.getChest(world, hit).get(BLOCK.PLANKS), 2);
  game.setMode("survival");
  assert.equal(game.count(BLOCK.PLANKS), 2);
});

test("inventory notifications see committed transfers, including a reentrant callback", () => {
  const { world, settlement, game, hit } = chestFixture();
  game.add(ITEM.COAL, 7);
  const chest = settlement.getChest(world, hit);
  const totals = [];
  let nested = false;
  game.onChange = () => {
    totals.push(game.count(ITEM.COAL) + (chest.get(ITEM.COAL) ?? 0));
    if (!nested) {
      nested = true;
      assert.equal(
        settlement.transferFromChest(world, hit, game, ITEM.COAL),
        true
      );
    }
  };
  assert.equal(
    settlement.transferToChest(world, hit, game, ITEM.COAL, 4),
    true
  );
  assert.deepEqual(totals, [7, 7]);
  assert.equal(game.count(ITEM.COAL), 4);
  assert.equal(chest.get(ITEM.COAL), 3);
});

test("storing and reloading worn tools never repairs their durability", () => {
  for (const mode of ["survival", "creative"]) {
    const { world, settlement, game, hit } = chestFixture();
    game.add(ITEM.WOOD_PICKAXE, 2);
    game.assignSlot(0, ITEM.WOOD_PICKAXE);
    game.harvest(BLOCK.STONE);
    const [worn, fresh] = game.serialize().durability[ITEM.WOOD_PICKAXE];
    assert.ok(worn < fresh);
    if (mode === "creative") game.setMode(mode);
    assert.equal(
      settlement.transferToChest(world, hit, game, ITEM.WOOD_PICKAXE),
      true
    );
    const restored = new Settlement({
      coordinator: world.coordinator,
      context: world.context,
    });
    assert.equal(
      restored.load(JSON.parse(JSON.stringify(settlement.serialize()))),
      true
    );
    settlement.dispose();
    assert.equal(
      restored.transferFromChest(world, hit, game, ITEM.WOOD_PICKAXE),
      true
    );
    assert.deepEqual(
      game
        .getState()
        .slots.filter((stack) => stack?.id === ITEM.WOOD_PICKAXE)
        .map((stack) => stack.durability)
        .sort((a, b) => a - b),
      [worn, fresh]
    );
  }
});

test("breaking a chest after its block is air releases contents once and clears live maps", () => {
  const { world, settlement, game, hit } = chestFixture();
  game.add(ITEM.SEEDS, 3);
  settlement.transferToChest(world, hit, game, ITEM.SEEDS, 3);
  const chest = settlement.getChest(world, hit);
  world.set(hit.x, hit.y, hit.z, BLOCK.AIR);
  const retained = dropCollector(world.coordinator);
  assert.deepEqual(
    settlement.removeChest(world, hit, { prepareDrops: retained.prepareDrops }),
    [{ id: ITEM.SEEDS, count: 3 }]
  );
  assert.equal(chest.size, 0);
  assert.deepEqual(settlement.removeChest(world, hit), []);
  assert.deepEqual(settlement.serialize().chests, []);
});

test("breaking a chest preserves individual tools in independent finite drops", () => {
  const { world, settlement, game, hit } = chestFixture();
  game.add(ITEM.WOOD_PICKAXE, 2);
  game.assignSlot(0, ITEM.WOOD_PICKAXE);
  game.harvest(BLOCK.STONE);
  const expectedWear = game.serialize().durability[ITEM.WOOD_PICKAXE];
  assert.ok(expectedWear[0] < expectedWear[1]);
  game.add(ITEM.SEEDS, 3);
  assert.equal(
    settlement.transferToChest(world, hit, game, ITEM.WOOD_PICKAXE, 2),
    true
  );
  assert.equal(
    settlement.transferToChest(world, hit, game, ITEM.SEEDS, 3),
    true
  );
  const key = settlement.chestKey(world, hit.x, hit.y, hit.z);
  const storedSlots = settlement.serialize().chests[0].slots;
  world.set(hit.x, hit.y, hit.z, BLOCK.AIR);
  const retained = dropCollector(world.coordinator);
  const drops = settlement.removeChest(world, hit, {
    prepareDrops: retained.prepareDrops,
  });
  assert.deepEqual(drops, [
    { id: ITEM.WOOD_PICKAXE, count: 1, durability: expectedWear[0] },
    { id: ITEM.WOOD_PICKAXE, count: 1, durability: expectedWear[1] },
    { id: ITEM.SEEDS, count: 3 },
  ]);
  assert.equal(settlement.chests.has(key), false);
  assert.deepEqual(settlement.removeChest(world, hit), []);
  const recovered = player();
  for (const drop of drops) {
    assert.equal(
      recovered.add(drop.id, drop.count, {
        ...(drop.durability === undefined
          ? {}
          : { durability: [drop.durability] }),
      }),
      true
    );
  }
  assert.deepEqual(
    recovered.serialize().durability[ITEM.WOOD_PICKAXE],
    expectedWear
  );
  assert.notEqual(drops[0], storedSlots[0]);
  storedSlots[0].durability = getItem(ITEM.WOOD_PICKAXE).durability;
  assert.equal(drops[0].durability, expectedWear[0]);
  drops[1].durability = 1;
  assert.equal(storedSlots[1].durability, expectedWear[1]);
  assert.deepEqual(
    recovered.serialize().durability[ITEM.WOOD_PICKAXE],
    expectedWear
  );
  assert.deepEqual(settlement.serialize().chests, []);
});

test("identical chest coordinates across dimensions survive JSON reload independently", () => {
  const { world, settlement, game, hit } = chestFixture();
  for (const [dimension, id] of [
    ["overworld", ITEM.WHEAT],
    ["nether", ITEM.COAL],
    ["end", ITEM.DIAMOND],
  ]) {
    world.dimension = dimension;
    world.set(hit.x, hit.y, hit.z, BLOCK.CHEST);
    game.add(id, 2);
    assert.equal(settlement.transferToChest(world, hit, game, id, 2), true);
  }
  const restored = new Settlement({
    coordinator: world.coordinator,
    context: world.context,
  });
  assert.equal(
    restored.load(JSON.parse(JSON.stringify(settlement.serialize()))),
    true
  );
  settlement.dispose();
  for (const [dimension, id] of [
    ["overworld", ITEM.WHEAT],
    ["nether", ITEM.COAL],
    ["end", ITEM.DIAMOND],
  ]) {
    world.dimension = dimension;
    assert.deepEqual([...restored.getChest(world, hit)], [[id, 2]]);
  }
});

test("planting each supported soil consumes one selected seed and edits both soil and crop", () => {
  for (const soil of [BLOCK.GRASS, BLOCK.DIRT, BLOCK.FARMLAND]) {
    const { world, settlement, game, hit } = farmFixture(soil);
    assert.equal(settlement.plant(world, hit, game), true);
    assert.equal(game.count(ITEM.SEEDS), 7);
    assert.equal(world.get(hit.x, hit.y, hit.z), BLOCK.FARMLAND);
    assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.TALL_GRASS);
    assert.equal(age(settlement, world, hit), 0);
    assert.equal(settlement.plant(world, hit, game), false);
    assert.equal(game.count(ITEM.SEEDS), 7);
  }
});

test("planting rejects wrong items, covered/invalid soil, unloaded ground and world limits", () => {
  const cases = [
    ({ game }) => {
      game.add(BLOCK.DIRT, 1);
      game.assignSlot(0, BLOCK.DIRT);
    },
    ({ world, hit }) => world.set(hit.x, hit.y, hit.z, BLOCK.STONE),
    ({ world, hit }) => world.set(hit.x, hit.y + 1, hit.z, BLOCK.TALL_GRASS),
    ({ world, hit }) => world.unloaded.add(world.column(hit.x, hit.z)),
    ({ world, hit }) => {
      hit.y = WORLD_HEIGHT - 1;
      world.set(hit.x, hit.y, hit.z, BLOCK.GRASS);
    },
    ({ hit }) => {
      hit.y = 0;
    },
    ({ hit }) => {
      hit.x = WORLD_MAX;
    },
    ({ game }) => game.damage(20),
  ];
  for (const prepare of cases) {
    const fixture = farmFixture();
    prepare(fixture);
    const before = snapshot(fixture);
    assert.equal(
      fixture.settlement.plant(fixture.world, fixture.hit, fixture.game),
      false
    );
    assert.deepEqual(snapshot(fixture), before);
  }
});

test("refused crop placement leaves seeds and the original soil block untouched", () => {
  const fixture = farmFixture();
  const { world, settlement, game, hit } = fixture;
  world.blocked.add(world.key(hit.x, hit.y + 1, hit.z));
  const before = snapshot(fixture);
  assert.equal(settlement.plant(world, hit, game), false);
  assert.deepEqual(snapshot(fixture), before);
  assert.equal(world.get(hit.x, hit.y, hit.z), BLOCK.GRASS);
  assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.AIR);
});

test("creative farming requires selected seeds but does not consume them", () => {
  const { world, settlement, game, hit } = farmFixture(BLOCK.DIRT, "creative");
  assert.equal(settlement.plant(world, hit, game), true);
  assert.equal(game.count(ITEM.SEEDS), 8);
});

test("dry crops mature after active time only and mark their block dirty", () => {
  const { world, settlement, game, hit } = farmFixture();
  settlement.plant(world, hit, game);
  world.dirtyChunks.clear();
  for (const dt of [0, -1, NaN, Infinity, "45"])
    assert.equal(settlement.update(dt, world), false);
  assert.equal(age(settlement, world, hit), 0);
  settlement.update(CROP_GROW_SECONDS - 1, world);
  assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.TALL_GRASS);
  assert.equal(world.dirtyChunks.size, 0);
  settlement.update(1, world);
  assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.WHEAT_CROP);
  assert.ok(world.dirtyChunks.has(world.column(hit.x, hit.z)));
});

test("nearby water accelerates crops while distant water does not", () => {
  const { world, settlement, game, hit } = farmFixture();
  const dry = { ...hit, x: 20 };
  world.set(dry.x, dry.y, dry.z, BLOCK.DIRT);
  world.set(hit.x + 4, hit.y, hit.z, BLOCK.WATER);
  settlement.plant(world, hit, game);
  settlement.plant(world, dry, game);
  settlement.update(CROP_GROW_SECONDS / 1.5, world);
  assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.WHEAT_CROP);
  assert.equal(world.get(dry.x, dry.y + 1, dry.z), BLOCK.TALL_GRASS);
  assert.equal(age(settlement, world, dry), CROP_GROW_SECONDS / 1.5);
});

test("only loaded crops in the current dimension accumulate growth", () => {
  const { world, settlement, game, hit } = farmFixture();
  for (const dimension of ["overworld", "nether", "end"]) {
    world.dimension = dimension;
    world.set(hit.x, hit.y, hit.z, BLOCK.DIRT);
    settlement.plant(world, hit, game);
  }
  world.dimension = "overworld";
  world.unloaded.add(world.column(hit.x, hit.z));
  settlement.update(30, world);
  assert.ok(settlement.serialize().crops.every((crop) => crop.age === 0));
  world.unloaded.clear();
  settlement.update(20, world);
  world.dimension = "nether";
  settlement.update(CROP_GROW_SECONDS, world);
  world.dimension = "end";
  settlement.update(15, world);
  assert.deepEqual(
    settlement.serialize().crops.map(({ dimension, age }) => [dimension, age]),
    [
      ["overworld", 20],
      ["nether", CROP_GROW_SECONDS],
      ["end", 15],
    ]
  );
});

test("removed crops and unsupported farmland do not regrow or overwrite replacement blocks", () => {
  const { world, settlement, game, hit } = farmFixture();
  settlement.plant(world, hit, game);
  world.set(hit.x, hit.y + 1, hit.z, BLOCK.STONE);
  settlement.update(CROP_GROW_SECONDS, world);
  assert.equal(settlement.crops.size, 0);
  assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.STONE);
  world.set(hit.x, hit.y + 1, hit.z, BLOCK.AIR);
  settlement.plant(world, hit, game);
  world.set(hit.x, hit.y, hit.z, BLOCK.DIRT);
  settlement.update(1, world);
  assert.equal(settlement.crops.size, 0);
  assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.AIR);
});

test("immature and mature harvests pay out exactly once without editing the already-cleared block", () => {
  const { world, settlement, game, hit } = farmFixture();
  for (const mature of [false, true]) {
    settlement.plant(world, hit, game);
    if (mature) settlement.update(CROP_GROW_SECONDS, world);
    const target = cropHit(hit, mature ? BLOCK.WHEAT_CROP : BLOCK.TALL_GRASS);
    world.set(target.x, target.y, target.z, BLOCK.AIR);
    const writes = world.writes.length;
    assert.equal(settlement.harvestCrop(world, target, game), true);
    assert.equal(world.writes.length, writes);
    assert.equal(game.count(ITEM.SEEDS), 8);
    assert.equal(game.count(ITEM.WHEAT), mature ? 2 : 0);
    assert.equal(settlement.harvestCrop(world, target, game), false);
  }
  assert.equal(
    settlement.harvestCrop(
      world,
      { x: 30, y: 20, z: 3, id: BLOCK.TALL_GRASS },
      game
    ),
    false
  );
  assert.equal(
    settlement.harvestCrop(
      world,
      { x: 31, y: 20, z: 3, id: BLOCK.WHEAT_CROP },
      game
    ),
    false
  );
});

test("harvest overflow forwards only unadded crop drops once, including partial fits", () => {
  for (const mature of [false, true]) {
    for (const held of [null, ITEM.SEEDS, ITEM.WHEAT]) {
      const { world, settlement, game, hit } = farmFixture();
      settlement.plant(world, hit, game);
      if (mature) settlement.update(CROP_GROW_SECONDS, world);
      game.consume(ITEM.SEEDS, game.count(ITEM.SEEDS));
      if (held !== null) game.add(held, 1);
      assert.equal(
        game.add(BLOCK.DIRT, 64 * (INVENTORY_SLOTS - (held === null ? 0 : 1))),
        true
      );
      const expectedInventory = new Map(game.inventory);
      const drops = mature
        ? [
            { id: ITEM.WHEAT, count: 2 },
            { id: ITEM.SEEDS, count: 1 },
          ]
        : [{ id: ITEM.SEEDS, count: 1 }];
      for (const { id, count } of drops) {
        if (id === held) expectedInventory.set(id, 1 + count);
      }
      const target = cropHit(hit, mature ? BLOCK.WHEAT_CROP : BLOCK.TALL_GRASS);
      world.set(target.x, target.y, target.z, BLOCK.AIR);
      const writes = world.writes.length;
      const overflow = dropCollector(world.coordinator);
      const options = { prepareDrops: overflow.prepareDrops };
      assert.equal(settlement.harvestCrop(world, target, game, options), true);
      assert.deepEqual(
        overflow.drops,
        drops.filter(({ id }) => id !== held)
      );
      assert.deepEqual(game.inventory, expectedInventory);
      assert.equal(settlement.crops.size, 0);
      assert.equal(world.writes.length, writes);
      assert.equal(settlement.harvestCrop(world, target, game, options), false);
      assert.deepEqual(
        overflow.drops,
        drops.filter(({ id }) => id !== held)
      );
    }
  }
});

test("missing overflow preparation refuses a harvest without discarding owned crops", () => {
  const { world, settlement, game, hit } = farmFixture();
  settlement.plant(world, hit, game);
  settlement.update(CROP_GROW_SECONDS, world);
  assert.equal(game.add(BLOCK.DIRT, 64 * (INVENTORY_SLOTS - 1)), true);
  const target = cropHit(hit, BLOCK.WHEAT_CROP);
  world.set(target.x, target.y, target.z, BLOCK.AIR);
  const toasts = [];
  game.onToast = (message) => toasts.push(message);
  const before = snapshot({ settlement, game });
  assert.equal(settlement.harvestCrop(world, target, game), false);
  assert.deepEqual(snapshot({ settlement, game }), before);
  assert.equal(game.count(ITEM.SEEDS), 7);
  assert.equal(game.count(ITEM.WHEAT), 0);
  assert.equal(toasts.length, 0);
  assert.equal(settlement.crops.size, 1);
});

test("Creative harvest cleans crop state without granting resources or emitting overflow", () => {
  for (const mature of [false, true]) {
    const { world, settlement, game, hit } = farmFixture(
      BLOCK.DIRT,
      "creative"
    );
    settlement.plant(world, hit, game);
    if (mature) settlement.update(CROP_GROW_SECONDS, world);
    const target = cropHit(hit, mature ? BLOCK.WHEAT_CROP : BLOCK.TALL_GRASS);
    world.set(target.x, target.y, target.z, BLOCK.AIR);
    const before = game.serialize();
    const writes = world.writes.length;
    const overflow = dropCollector(world.coordinator);
    assert.equal(
      settlement.harvestCrop(world, target, game, {
        prepareDrops: overflow.prepareDrops,
      }),
      true
    );
    assert.deepEqual(game.serialize(), before);
    assert.deepEqual(overflow.drops, []);
    assert.deepEqual(overflow.proposals, []);
    assert.equal(settlement.crops.size, 0);
    assert.equal(settlement._water.size, 0);
    assert.equal(world.writes.length, writes);
    assert.equal(settlement.harvestCrop(world, target, game), false);
  }
});

test("loading validates the entire snapshot atomically and owns its copied state", () => {
  const { world, settlement, game, hit } = chestFixture();
  game.add(ITEM.SEEDS, 8);
  settlement.transferToChest(world, hit, game, ITEM.SEEDS, 3);
  game.assignSlot(0, ITEM.SEEDS);
  const ground = { x: 5, y: 20, z: 5 };
  world.set(ground.x, ground.y, ground.z, BLOCK.DIRT);
  settlement.plant(world, ground, game);
  settlement.update(12, world);
  const saved = settlement.serialize();
  const restored = new Settlement();
  assert.equal(restored.load(saved), true);
  const before = restored.serialize();
  saved.chests[0].slots[0].count = 2000;
  saved.crops[0].age = 0;
  assert.deepEqual(restored.serialize(), before);
  const corruptions = [
    (data) => {
      data.version = 999;
    },
    (data) => {
      data.chests = {};
    },
    (data) => {
      data.chests.push(structuredClone(data.chests[0]));
    },
    (data) => {
      data.chests[0].slots.push({ ...data.chests[0].slots[0] });
    },
    (data) => {
      data.chests[0].slots[0].count = -1;
    },
    (data) => {
      data.chests[0].slots[0].count = Number.MAX_SAFE_INTEGER;
    },
    (data) => {
      data.chests[0].slots[0].id = "288";
    },
    (data) => {
      data.chests[0].slots[0].id = 999999;
    },
    (data) => {
      data.chests[0].dimension = "moon";
    },
    (data) => {
      data.chests[0].x = 0.5;
    },
    (data) => {
      data.chests[0].z = WORLD_MAX;
    },
    (data) => {
      data.crops.push({ ...data.crops[0] });
    },
    (data) => {
      data.crops[0].age = -1;
    },
    (data) => {
      data.crops[0].age = Infinity;
    },
    (data) => {
      data.crops[0].age = CROP_GROW_SECONDS + 1;
    },
    (data) => {
      data.crops[0].y = 1;
    },
  ];
  for (const corrupt of corruptions) {
    const invalid = structuredClone(before);
    corrupt(invalid);
    assert.equal(restored.load(invalid), false);
    assert.deepEqual(restored.serialize(), before);
  }
  for (const invalid of [
    null,
    undefined,
    [],
    {},
    { version: 1, chests: [], crops: null },
  ]) {
    assert.equal(restored.load(invalid), false);
    assert.deepEqual(restored.serialize(), before);
  }
});

test("invalid saved tool wear rejects the whole load without repairing tools", () => {
  const { world, settlement, game, hit } = chestFixture();
  game.add(ITEM.WOOD_PICKAXE, 1);
  settlement.transferToChest(world, hit, game, ITEM.WOOD_PICKAXE);
  const before = settlement.serialize();
  for (const durability of [
    undefined,
    null,
    [],
    0,
    -1,
    9999,
    "10",
    NaN,
    [1, 2],
  ]) {
    const invalid = structuredClone(before);
    invalid.chests[0].slots[0].durability = durability;
    assert.equal(settlement.load(invalid), false);
    assert.deepEqual(settlement.serialize(), before);
  }
});

test("an inventory exception rolls back counts and restores its change callback", () => {
  const fixture = chestFixture();
  const { world, settlement, game, hit } = fixture;
  game.add(ITEM.COAL, 3);
  const before = snapshot(fixture),
    notify = game.onChange,
    transaction = game.prepareInventory;
  game.prepareInventory = function (change, options) {
    return transaction.call(
      this,
      (owned) => {
        change(owned);
        throw new Error("Inventory transaction interrupted");
      },
      options
    );
  };
  try {
    assert.equal(
      settlement.transferToChest(world, hit, game, ITEM.COAL),
      false
    );
  } catch (error) {
    assert.match(error.message, /Inventory transaction interrupted/);
  }
  assert.deepEqual(snapshot(fixture), before);
  assert.equal(game.onChange, notify);
  game.prepareInventory = transaction;
});

test("real streamed world edits and partially-grown crops survive reload and finish growing", async () => {
  const coordinator = new TransactionCoordinator();
  const world = new World("settlement-roundtrip", {
    useWorker: false,
    coordinator,
  });
  const restoredWorld = new World(world.seed, {
    useWorker: false,
    coordinator,
  });
  try {
    const ground = { x: -1, y: WORLD_HEIGHT - 3, z: 0 };
    await world.ensureArea(ground, 0);
    world.set(ground.x, ground.y, ground.z, BLOCK.DIRT);
    world.set(ground.x, ground.y + 1, ground.z, BLOCK.AIR);
    const ownership = { coordinator, context: createWorldContext(world) };
    const settlement = new Settlement(ownership),
      game = player(undefined, ownership);
    game.add(ITEM.SEEDS, 1);
    assert.equal(settlement.plant(world, ground, game), true);
    settlement.update(20, world);
    const saved = JSON.parse(
      JSON.stringify({
        world: world.serialize(),
        settlement: settlement.serialize(),
      })
    );
    assert.equal(restoredWorld.loadEdits(saved.world), true);
    await restoredWorld.ensureArea(ground, 0);
    const restored = new Settlement(ownership);
    assert.equal(restored.load(saved.settlement), true);
    settlement.dispose();
    restoredWorld.clearDirty();
    restored.update(CROP_GROW_SECONDS - 20, restoredWorld);
    assert.equal(
      restoredWorld.get(ground.x, ground.y + 1, ground.z),
      BLOCK.WHEAT_CROP
    );
    assert.ok(restoredWorld.dirtyChunks.has("-1,0"));
    const target = cropHit(ground, BLOCK.WHEAT_CROP);
    restoredWorld.set(target.x, target.y, target.z, BLOCK.AIR);
    assert.equal(restored.harvestCrop(restoredWorld, target, game), true);
    assert.equal(game.count(ITEM.WHEAT), 2);
    assert.equal(game.count(ITEM.SEEDS), 1);
  } finally {
    world.dispose();
    restoredWorld.dispose();
  }
});
