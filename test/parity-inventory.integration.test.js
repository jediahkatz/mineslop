import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ITEM } from "../src/items.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

test("Q and Ctrl-Q retain one item and one selected stack, never every stack of that ID", () => {
  const { game, drops } = parityGame();
  setOwnedSlots(game, [
    [0, { id: BLOCK.DIRT, count: 64 }],
    [1, { id: BLOCK.DIRT, count: 64 }],
    [9, { id: BLOCK.DIRT, count: 2 }],
  ]);
  game.gameplay.select(0);
  assert.equal(game.dropSelected(false), true);
  assert.equal(game.gameplay.getState().slots[0].count, 63);
  assert.equal(drops[0].count, 1);
  assert.equal(drops[0].options.pickupDelay, 2);
  assert.equal(drops[0].options.velocity.z, -3.5);
  assert.equal(game.dropSelected(true), true);
  assert.equal(game.gameplay.getState().slots[0], null);
  assert.equal(drops[1].count, 63);
  assert.equal(game.gameplay.count(BLOCK.DIRT), 66);
  assert.equal(
    drops.reduce((sum, drop) => sum + drop.count, 0) +
      game.gameplay.count(BLOCK.DIRT),
    130
  );
});

test("refused drop admission leaves the entire selected stack and wear untouched", () => {
  const { game, drops } = parityGame();
  setOwnedSlots(game, [
    [0, { id: ITEM.WOOD_PICKAXE, count: 1, durability: 7 }],
  ]);
  game.overflow.dispose();
  game.overflow = new DropOverflow({
    maxEntries: 1,
    coordinator: game.coordinator,
    context: game.worldContext,
  });
  assert.equal(
    game.overflow.enqueue(
      [{ id: BLOCK.STONE, count: 1 }],
      { x: 10, y: 10, z: 10 },
      "overworld"
    ),
    true
  );
  const before = game.gameplay.serialize();
  const overflow = game.overflow.serialize();
  assert.equal(game.dropSelected(true), false);
  assert.deepEqual(game.gameplay.serialize(), before);
  assert.deepEqual(game.overflow.serialize(), overflow);
  assert.equal(drops.length, 0);
});

test("dropping at high flight altitude retains the exact position and selected tool copy", () => {
  const { game, drops } = parityGame();
  setOwnedSlots(game, [
    [0, { id: ITEM.WOOD_PICKAXE, count: 1, durability: 7 }],
    [1, { id: ITEM.WOOD_PICKAXE, count: 1, durability: 59 }],
  ]);
  game.gameplay.select(1);
  game.player.position.y = 250;
  game.player.eyePosition.y = 251.62;
  assert.equal(game.dropSelected(true), true);
  assert.equal(drops[0].position.y, 251.32);
  assert.deepEqual(drops[0].options.durability, [59]);
  assert.equal(game.gameplay.getState().slots[0].durability, 7);
  assert.equal(game.gameplay.getState().slots[1], null);
});

test("explicit Creative F/Q works for a legacy palette without deleting finite inventory", () => {
  const { game, drops } = parityGame("creative");
  game.gameplay.assignSlot(0, BLOCK.STONE);
  game.gameplay.select(0);
  const finiteBefore = game.gameplay.getState().slots;
  assert.equal(game.dropSelected(false), true);
  assert.equal(drops[0].id, BLOCK.STONE);
  assert.equal(drops[0].count, 1);
  assert.deepEqual(game.gameplay.getState().slots, finiteBefore);
  assert.equal(game.swapHands(), true);
  assert.equal(game.gameplay.getHandStack("offhand").id, BLOCK.STONE);
  assert.equal(game.gameplay.getHandStack("offhand").count, 64);
  assert.equal(game.gameplay.count(ITEM.APPLE), 4);
  assert.equal(game.swapHands(), true);
  assert.equal(game.gameplay.getHandStack("offhand"), null);
  assert.equal(
    game.gameplay.count(BLOCK.STONE),
    64,
    "the reverse swap creates no second copy"
  );
  assert.equal(game.gameplay.count(ITEM.APPLE), 4);
});

test("bucket transforms target the actual hand and leave ownership unchanged on world refusal", () => {
  const { game } = parityGame();
  setOwnedSlots(game, [], { id: ITEM.WATER_BUCKET, count: 1 });
  const change = {
    x: 2,
    y: 9,
    z: 0,
    before: game.world.getCell(2, 9, 0),
    after: { id: BLOCK.WATER },
  };
  const mutation = game.world.prepareMutation([change]);
  const before = game.gameplay.serialize();
  assert.equal(
    game.swapHandItem("offhand", ITEM.BUCKET, {
      ...mutation,
      validate: () => false,
    }),
    false
  );
  assert.deepEqual(game.gameplay.serialize(), before);
  assert.equal(game.world.get(2, 9, 0), BLOCK.AIR);
  assert.equal(game.swapHandItem("offhand", ITEM.BUCKET, mutation), true);
  assert.equal(game.world.get(2, 9, 0), BLOCK.WATER);
  assert.deepEqual(game.gameplay.getHandStack("offhand"), {
    id: ITEM.BUCKET,
    count: 1,
  });
});

test("stacked empty buckets require space for their filled result before changing water", () => {
  const { game } = parityGame();
  setOwnedSlots(
    game,
    Array.from({ length: 36 }, (_, index) => [
      index,
      index === 0
        ? { id: ITEM.BUCKET, count: 16 }
        : { id: BLOCK.DIRT, count: 64 },
    ])
  );
  game.gameplay.select(0);
  game.world.set(2, 9, 0, BLOCK.WATER);
  const prepareWater = () =>
    game.world.prepareMutation([
      {
        x: 2,
        y: 9,
        z: 0,
        before: game.world.getCell(2, 9, 0),
        after: { id: BLOCK.AIR },
      },
    ]);
  let changes = 0;
  game.world.onMutation = () => changes++;
  const before = game.gameplay.serialize();
  assert.equal(
    game.swapHandItem("main", ITEM.WATER_BUCKET, prepareWater()),
    false
  );
  assert.equal(changes, 0);
  assert.deepEqual(game.gameplay.serialize(), before);
  setOwnedSlots(
    game,
    Array.from({ length: 36 }, (_, index) => [
      index,
      index === 0
        ? { id: ITEM.BUCKET, count: 1 }
        : { id: BLOCK.DIRT, count: 64 },
    ])
  );
  assert.equal(
    game.swapHandItem("main", ITEM.WATER_BUCKET, prepareWater()),
    true
  );
  assert.equal(changes, 1);
  assert.equal(game.gameplay.getHandStack().id, ITEM.WATER_BUCKET);
});

test("personal crafting stays 2x2 near a table and an explicit opened table enables 3x3", () => {
  const { game, opened } = parityGame();
  game.world.set(1, 9, 0, BLOCK.CRAFTING_TABLE);
  assert.deepEqual(game.station(), ["hand"]);
  assert.equal(game.gameplay.getState().craftingSize, 2);
  assert.equal(
    game.openStation({ x: 1, y: 9, z: 0, id: BLOCK.CRAFTING_TABLE }),
    true
  );
  assert.deepEqual(game.station(), ["hand", "table"]);
  assert.equal(game.gameplay.getState().craftingSize, 3);
  assert.deepEqual(opened.at(-1), { screen: "crafting", size: 3 });
  game.world.set(1, 9, 0, BLOCK.AIR);
  assert.deepEqual(game.station(), ["hand"]);
});
