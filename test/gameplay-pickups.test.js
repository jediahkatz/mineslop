import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";

const tool = ITEM.WOOD_PICKAXE;
const maximum = getItem(tool).durability;

function equippedGame(options) {
  const game = new Gameplay(options);
  game.add(tool);
  game.assignSlot(0, tool);
  game.select(0);
  game.harvest(BLOCK.STONE);
  return game;
}

test("recovered pickups append individual wear without repairing existing tools", () => {
  const game = equippedGame();
  const durability = [1, 7];
  assert.equal(game.add(tool, 2, { durability }), true);
  assert.equal(game.count(tool), 3);
  assert.deepEqual(game.serialize().durability[tool], [maximum - 1, 1, 7]);
  assert.equal(game.getState().durability[tool], maximum - 1);
  durability.fill(0);
  assert.deepEqual(game.serialize().durability[tool], [maximum - 1, 1, 7]);
  game.consume(tool, 1);
  assert.equal(game.selectedItem, null);
  assert.equal(
    game.assignSlot(0, tool),
    true,
    "select the recovered physical copy"
  );
  assert.deepEqual(game.harvest(BLOCK.STONE), [
    { id: BLOCK.COBBLESTONE, count: 1 },
  ]);
  assert.equal(game.count(tool), 1);
  assert.equal(game.getState().durability[tool], 7);
});

test("plain adds and newly crafted tools still append full durability", () => {
  const game = new Gameplay();
  assert.equal(game.add(tool, undefined, { durability: [3] }), true);
  assert.equal(game.add(tool), true);
  assert.equal(game.add(tool, 1, {}), true);
  assert.equal(game.add(tool, 1, { durability: undefined }), true);
  game.add(BLOCK.PLANKS, 3);
  game.add(ITEM.STICK, 2);
  assert.equal(game.craft("wood_pickaxe", { station: "table" }).ok, true);
  assert.equal(game.count(tool), 5);
  assert.deepEqual(game.serialize().durability[tool], [
    3,
    maximum,
    maximum,
    maximum,
    maximum,
  ]);
  assert.equal(game.add(BLOCK.DIRT, 1, { durability: undefined }), true);
});

test("durability pickup metadata supports all durable items, including armor", () => {
  for (const id of [tool, ITEM.BOW, ITEM.IRON_ARMOR, ITEM.FLINT_AND_STEEL]) {
    const game = new Gameplay();
    const durability = Object.freeze([1, getItem(id).durability]);
    assert.equal(game.add(id, 2, { durability }), true);
    assert.deepEqual(game.serialize().durability[id], [...durability]);
    assert.equal(game.count(id), 2);
  }
});

test("malformed recovered wear is rejected atomically in survival and creative", () => {
  const malformed = [
    null,
    7,
    "7,8",
    {},
    new Uint16Array([7, 8]),
    [],
    [7],
    [7, 8, 9],
    Array(2),
    [7, undefined],
    [7, null],
    [7, true],
    [7, "8"],
    [7, 0],
    [7, -1],
    [7, 0.5],
    [7, maximum + 1],
    [7, NaN],
    [7, Infinity],
  ];
  for (const mode of ["survival", "creative"]) {
    let changes = 0;
    const game = equippedGame({ onChange: () => changes++ });
    game.setMode(mode);
    const before = game.serialize();
    const beforeChanges = changes;
    for (const durability of malformed) {
      assert.equal(game.add(tool, 2, { durability }), false);
      assert.deepEqual(game.serialize(), before);
      assert.equal(changes, beforeChanges);
    }
    for (const id of [BLOCK.DIRT, ITEM.APPLE, ITEM.COAL]) {
      assert.equal(game.add(id, 2, { durability: [7, 8] }), false);
      assert.deepEqual(game.serialize(), before);
      assert.equal(changes, beforeChanges);
    }
  }
});

test("full inventory and death reject recovered tools without changing wear or counts", () => {
  let changes = 0;
  const game = equippedGame({ onChange: () => changes++ });
  assert.equal(game.add(BLOCK.DIRT, 64 * 34), true);
  assert.equal(game.getState().inventorySlotsUsed, 36);
  const before = game.serialize();
  const beforeChanges = changes;
  assert.equal(game.add(tool, 1, { durability: [7] }), false);
  assert.deepEqual(game.serialize(), before);
  assert.equal(changes, beforeChanges);
  game.consume(BLOCK.DIRT, 64);
  game.damage(100, "lava");
  const deadState = game.serialize();
  assert.equal(game.add(tool, 1, { durability: [7] }), false);
  assert.deepEqual(game.serialize(), deadState);
});

test("chest-style removal and physical recovery retain wear through save and load", () => {
  const game = equippedGame();
  game.add(tool, 1, { durability: [11] });
  const drop = {
    id: tool,
    count: 2,
    durability: [...game.serialize().durability[tool]],
  };
  assert.equal(game.consume(drop.id, drop.count), true);
  assert.equal(game.count(tool), 0);
  assert.equal(
    game.add(drop.id, drop.count, { durability: drop.durability }),
    true
  );
  const saved = JSON.parse(JSON.stringify(game.serialize()));
  const restored = new Gameplay();
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  assert.deepEqual(restored.serialize().durability[tool], [maximum - 1, 11]);
  assert.equal(restored.count(tool), 2);
  restored.add(tool, 1, { durability: [5] });
  assert.deepEqual(restored.serialize().durability[tool], [maximum - 1, 11, 5]);
  const before = restored.serialize();
  const invalid = structuredClone(before);
  invalid.durability[tool][1] = 0;
  assert.equal(restored.load(invalid), false);
  assert.deepEqual(restored.serialize(), before);
});
