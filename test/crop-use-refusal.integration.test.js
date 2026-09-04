import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

const hold = (game, seconds = 2) => {
  for (let i = 0; i < seconds * 20; i++) {
    game.elapsed += 0.05;
    game.useActions.update(0.05);
  }
};

function plantingGame(main = ITEM.CARROT, soil = BLOCK.FARMLAND) {
  const { game } = parityGame("survival", { generatorVersion: 4 });
  setOwnedSlots(game, [[0, { id: main, count: 2 }]],
    { id: ITEM.BREAD, count: 2 });
  game.gameplay.hunger = 10;
  game.world.set(2, 9, 0, soil);
  game.target = { x: 2, y: 9, z: 0, id: soil };
  return game;
}

test("full begin/update refuses planting without falling through to offhand bread", () => {
  const game = plantingGame();
  game.world.blocked.add(game.world.key(2, 10, 0));
  const before = game.gameplay.serialize();
  const began = game.beginUse();
  hold(game);
  assert.equal(game.gameplay.hunger, 10);
  assert.deepEqual(game.gameplay.serialize(), before);
  assert.equal(began, false);
  assert.equal(game.useActions.use.active, false);
  assert.equal(game.world.get(2, 10, 0), BLOCK.AIR);
  assert.equal(game.settlement.crops.size, 0);
  assert.equal(game.effects.swing, 0);
  assert.equal(game.effects.offhand.swing, 0);
});

test("stale selected slot cancels the refused gesture instead of eating on a later update", () => {
  const game = plantingGame();
  const prepare = game.world.prepareMutation.bind(game.world);
  game.world.prepareMutation = (...args) => {
    const plan = prepare(...args);
    game.gameplay.select(1);
    return plan;
  };
  const slots = game.gameplay.getState().slots;
  const began = game.beginUse();
  hold(game);
  assert.equal(game.gameplay.hunger, 10);
  assert.equal(game.gameplay.getHandStack("offhand").count, 2);
  assert.deepEqual(game.gameplay.getState().slots, slots);
  assert.equal(began, false);
  assert.equal(game.useActions.use.active, false);
  assert.equal(game.world.get(2, 10, 0), BLOCK.AIR);
  assert.equal(game.settlement.crops.size, 0);
  assert.equal(game.effects.swing, 0);
  assert.equal(game.effects.offhand.swing, 0);
});

test("replaced Game owners stop the full held-use gesture without food, payment or animation", () => {
  for (const owner of ["world", "gameplay", "player", "settlement"]) {
    const game = plantingGame();
    const { gameplay, world, settlement } = game;
    const before = gameplay.serialize();
    const prepare = gameplay.prepareInventory.bind(gameplay);
    gameplay.prepareInventory = (...args) => {
      const plan = prepare(...args);
      game[owner] = Object.create(game[owner]);
      return plan;
    };
    const began = game.beginUse();
    hold(game);
    assert.equal(began, false, owner);
    assert.equal(game.gameplay.hunger, 10, owner);
    assert.deepEqual(gameplay.serialize(), before, owner);
    assert.equal(game.gameplay.getHandStack("offhand").count, 2, owner);
    assert.equal(game.useActions.use.active, false, owner);
    assert.equal(world.get(2, 10, 0), BLOCK.AIR, owner);
    assert.equal(settlement.crops.size, 0, owner);
    assert.equal(game.effects.swing, 0, owner);
    assert.equal(game.effects.offhand.swing, 0, owner);
  }
});

test("an invalid planting target still permits ordinary main/offhand eating", () => {
  for (const item of [ITEM.CARROT, ITEM.SEEDS, ITEM.NETHER_WART]) {
    const game = plantingGame(item, BLOCK.STONE);
    assert.equal(game.beginUse(), true);
    assert.equal(game.useActions.use.hand, item === ITEM.CARROT ? "main" : "offhand");
    hold(game, 1.6);
    assert.equal(game.gameplay.getHandStack(item === ITEM.CARROT ? "main" : "offhand").count, 1);
    assert.ok(game.gameplay.hunger > 10);
    assert.equal(game.settlement.crops.size, 0);
  }
});

test("release and a new gesture can deliberately eat after a refused plant", () => {
  const game = plantingGame();
  game.world.blocked.add(game.world.key(2, 10, 0));
  assert.equal(game.beginUse(), false);
  hold(game);
  game.endUse();
  game.target = null;
  assert.equal(game.beginUse(), true);
  hold(game, 1.6);
  assert.equal(game.gameplay.getHandStack("main").count, 1);
  assert.equal(game.gameplay.getHandStack("offhand").count, 2);
});
