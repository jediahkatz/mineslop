import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { Settlement } from "../src/settlement.js";
import { ContainerWorld, editOwnership } from "./container-fixture.js";

function farmFixture(mode = "survival") {
  const world = new ContainerWorld();
  const ownership = { coordinator: world.coordinator, context: world.context };
  const settlement = new Settlement(ownership);
  const game = new Gameplay({ mode, ...ownership });
  const hit = {
    dimension: world.dimension,
    x: 2,
    y: 20,
    z: 3,
    id: BLOCK.GRASS,
  };
  world.set(hit.x, hit.y, hit.z, hit.id);
  editOwnership(game, (owned) => {
    owned.slots.fill(null);
    owned.slots[0] = { id: BLOCK.DIRT, count: 4 };
    owned.slots[1] = { id: ITEM.SEEDS, count: 5 };
    owned.slots[5] = { id: ITEM.SEEDS, count: 2 };
    owned.offhand = { id: ITEM.SEEDS, count: 3 };
  });
  game.select(5);
  if (mode === "creative") game.assignSlot(5, ITEM.SEEDS);
  return { world, settlement, game, hit };
}

const snapshot = ({ world, settlement, game, hit }) => [
  settlement.serialize(),
  game.serialize(),
  world.get(hit.x, hit.y, hit.z),
  world.get(hit.x, hit.y + 1, hit.z),
];

test("planting defaults to main and debits only the selected hand's exact seed stack", () => {
  for (const hand of [undefined, "main", "offhand"]) {
    const { world, settlement, game, hit } = farmFixture();
    // Offhand planting must work while a different item occupies the main hand.
    if (hand === "offhand") game.select(0);
    const expected = game.getState();
    if (hand === "offhand") expected.offhand.count--;
    else expected.slots[expected.selected].count--;
    assert.equal(
      settlement.plant(
        world,
        hit,
        game,
        hand === undefined ? undefined : { hand }
      ),
      true
    );
    const actual = game.getState();
    assert.deepEqual(actual.slots, expected.slots);
    assert.deepEqual(actual.offhand, expected.offhand);
    assert.equal(world.get(hit.x, hit.y, hit.z), BLOCK.FARMLAND);
    assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.TALL_GRASS);
    assert.equal(settlement.serialize().crops[0].age, 0);
  }
});

test("the final offhand seed clears that slot before observers see the planted crop", () => {
  const { world, settlement, game, hit } = farmFixture();
  editOwnership(game, (owned) => {
    owned.offhand = { id: ITEM.SEEDS, count: 1 };
  });
  const slots = game.getState().slots;
  let notifications = 0;
  game.onChange = () => {
    notifications++;
    assert.equal(game.getState().offhand, null);
    assert.deepEqual(game.getState().slots, slots);
    assert.equal(world.get(hit.x, hit.y, hit.z), BLOCK.FARMLAND);
    assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.TALL_GRASS);
    assert.equal(settlement.crops.size, 1);
  };
  assert.equal(settlement.plant(world, hit, game, { hand: "offhand" }), true);
  assert.equal(notifications, 1);
});

test("an empty or non-seed requested hand cannot borrow seeds from another hand or slot", () => {
  for (const mode of ["survival", "creative"]) {
    for (const hand of ["main", "offhand"]) {
      for (const held of [null, { id: BLOCK.DIRT, count: 1 }]) {
        const fixture = farmFixture(mode);
        const { world, settlement, game, hit } = fixture;
        editOwnership(game, (owned) => {
          if (hand === "offhand") owned.offhand = held;
          else owned.slots[5] = held;
        });
        if (mode === "creative" && hand === "main")
          game.assignSlot(5, held?.id ?? 0);
        const before = snapshot(fixture);
        const writes = world.writes.length;
        assert.equal(settlement.plant(world, hit, game, { hand }), false);
        assert.deepEqual(snapshot(fixture), before);
        assert.equal(world.writes.length, writes);
      }
    }
  }
});

test("invalid planting hand options reject without world or inventory edits", () => {
  const fixture = farmFixture();
  const { world, settlement, game, hit } = fixture;
  const before = snapshot(fixture);
  const writes = world.writes.length;
  for (const options of [
    null,
    [],
    { hand: null },
    { hand: "off" },
    { hand: "cursor" },
    { hand: 0 },
  ]) {
    assert.equal(settlement.plant(world, hit, game, options), false);
    assert.deepEqual(snapshot(fixture), before);
    assert.equal(world.writes.length, writes);
  }
});

test("Creative planting preserves finite offhand seeds and supports a main-hand seed palette without owned copies", () => {
  for (const hand of ["main", "offhand"]) {
    const { world, settlement, game, hit } = farmFixture("creative");
    editOwnership(game, (owned) => {
      owned.slots.fill(null);
      owned.offhand = hand === "offhand" ? { id: ITEM.SEEDS, count: 1 } : null;
    });
    game.assignSlot(5, hand === "main" ? ITEM.SEEDS : BLOCK.DIRT);
    const before = game.serialize();
    assert.equal(settlement.plant(world, hit, game, { hand }), true);
    assert.deepEqual(game.serialize(), before);
    assert.equal(world.get(hit.x, hit.y, hit.z), BLOCK.FARMLAND);
    assert.equal(world.get(hit.x, hit.y + 1, hit.z), BLOCK.TALL_GRASS);
  }
});

test("refused planting reserves no seed or soil edits and does not notify observers", () => {
  for (const hand of ["main", "offhand"]) {
    const fixture = farmFixture();
    const { world, settlement, game, hit } = fixture;
    world.blocked.add(world.key(hit.x, hit.y + 1, hit.z));
    const before = snapshot(fixture);
    let notifications = 0;
    game.onChange = () => {
      notifications++;
    };
    assert.equal(settlement.plant(world, hit, game, { hand }), false);
    assert.deepEqual(snapshot(fixture), before);
    assert.equal(notifications, 0);
  }
});

test("decorated main/offhand seeds remain owned instead of becoming generic crops", () => {
  for (const hand of ["main", "offhand"]) {
    const fixture = farmFixture();
    const { world, settlement, game, hit } = fixture;
    editOwnership(game, (owned) => {
      const stack = hand === "main" ? owned.slots[5] : owned.offhand;
      stack.data = { version: 1, name: "Keep these seeds" };
    });
    const before = snapshot(fixture);
    const writes = world.writes.length;
    assert.equal(settlement.plant(world, hit, game, { hand }), false);
    assert.deepEqual(snapshot(fixture), before);
    assert.equal(world.writes.length, writes);
  }
});
