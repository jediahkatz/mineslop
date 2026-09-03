import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

function hold(game, seconds) {
  for (let remaining = seconds; remaining > 1e-9; remaining -= 0.05) {
    const dt = Math.min(remaining, 0.05);
    game.elapsed += dt;
    game.useActions.update(dt);
  }
}

test("food consumes only after held use; release cancels the next meal", () => {
  const { game } = parityGame();
  game.gameplay.hunger = 10;
  const before = game.gameplay.count(ITEM.APPLE);
  assert.equal(game.beginUse(), true);
  assert.equal(game.gameplay.count(ITEM.APPLE), before);
  hold(game, 1.55);
  assert.equal(game.gameplay.count(ITEM.APPLE), before);
  hold(game, 0.05);
  assert.equal(game.gameplay.count(ITEM.APPLE), before - 1);
  assert.ok(game.gameplay.hunger > 10);
  game.endUse();
  hold(game, 2);
  assert.equal(game.gameplay.count(ITEM.APPLE), before - 1);
});

test("Remote taps never turn look gestures into held use; the explicit use key can eat", () => {
  const { game, messages } = parityGame();
  game.player.inputMode = "remote";
  game.gameplay.hunger = 10;
  const before = game.gameplay.count(ITEM.APPLE);
  game.secondary();
  hold(game, 2);
  assert.equal(game.gameplay.count(ITEM.APPLE), before);
  assert.ok(messages.some((message) => /hold V/i.test(message)));
  game.beginUse("remote-key");
  hold(game, 1.6);
  game.endUse("remote-key");
  assert.equal(game.gameplay.count(ITEM.APPLE), before - 1);
});

test("right-drawn bows spend ammo on release and raycast from the physical eye in third person", () => {
  const { game } = parityGame();
  setOwnedSlots(game, [
    [0, { id: ITEM.BOW, count: 1, durability: getItem(ITEM.BOW).durability }],
    [1, { id: ITEM.ARROW, count: 2 }],
  ]);
  game.gameplay.select(0);
  const entity = {
    kind: "zombie",
    spec: { temperament: "hostile" },
    position: new THREE.Vector3(0.5, 9, -11.5),
  };
  let damage = 0;
  let origin;
  let destination;
  game.wildlife.raycast = (eye) => {
    assert.equal(eye, game.player.eyePosition);
    return { entity, distance: 12 };
  };
  game.wildlife.damage = (_entity, amount) => {
    damage += amount;
    return { hit: true, killed: false };
  };
  game.effects.shoot = (from, to) => {
    origin = from.clone();
    destination = to.clone();
  };
  game.beginUse();
  hold(game, 1);
  assert.equal(game.gameplay.count(ITEM.ARROW), 2);
  assert.equal(damage, 0);
  assert.equal(game.endUse(), true);
  assert.equal(game.gameplay.count(ITEM.ARROW), 1);
  assert.ok(damage > 0);
  assert.ok(origin.equals(game.player.eyePosition));
  assert.equal(destination.z, -11.5);
  assert.equal(
    game.gameplay.getHandStack().durability,
    getItem(ITEM.BOW).durability - 1
  );
  assert.equal(game.endUse(), false);
});

test("left-clicking with a bow is melee, never arrow fire or held auto-attacking", () => {
  const { game } = parityGame();
  setOwnedSlots(game, [
    [0, { id: ITEM.BOW, count: 1, durability: getItem(ITEM.BOW).durability }],
    [1, { id: ITEM.ARROW, count: 2 }],
  ]);
  const entity = {
    spec: { temperament: "hostile" },
    position: game.player.position,
  };
  game.meleeTarget = { entity, distance: 2 };
  let attacks = 0;
  game.wildlife.damage = (_entity, amount) => {
    assert.equal(amount, 1);
    attacks++;
    return { hit: true, killed: false };
  };
  game.primary(0, true);
  game.elapsed++;
  game.primary(0.1, false);
  assert.equal(attacks, 1);
  assert.equal(game.gameplay.count(ITEM.ARROW), 2);
});

test("a raised offhand shield blocks only frontal attacks and spends its own durability", () => {
  const { game } = parityGame();
  const maximum = getItem(ITEM.SHIELD).durability;
  setOwnedSlots(
    game,
    [[0, { id: ITEM.WOOD_PICKAXE, count: 1, durability: 59 }]],
    { id: ITEM.SHIELD, count: 1, durability: maximum }
  );
  game.beginUse();
  hold(game, 0.25);
  const blocked = game.useActions.damage(6, "Zombie", { x: 0.5, y: 9, z: -2 });
  assert.equal(blocked.blocked, true);
  assert.equal(game.gameplay.health, 20);
  assert.equal(game.gameplay.getHandStack("offhand").durability, maximum - 7);
  assert.equal(game.gameplay.getHandStack("main").durability, 59);
  const rear = game.useActions.damage(6, "Zombie", { x: 0.5, y: 9, z: 3 });
  assert.equal(rear.blocked, false);
  assert.equal(game.gameplay.health, 14);
  game.resetActions();
  assert.equal(game.useActions.use.blocking, false);
});

test("interactive blocks precede eating, while sneaking with blocks bypasses their screens", () => {
  const { game, opened } = parityGame();
  game.gameplay.hunger = 10;
  game.world.set(1, 9, 0, BLOCK.CHEST);
  game.target = {
    x: 1,
    y: 9,
    z: 0,
    id: BLOCK.CHEST,
    normal: { x: 0, y: 1, z: 0 },
  };
  const before = game.gameplay.count(ITEM.APPLE);
  assert.equal(game.beginUse(), true);
  assert.equal(opened[0].container, BLOCK.CHEST);
  assert.equal(game.gameplay.count(ITEM.APPLE), before);
  game.resetActions();
  game.elapsed++;
  setOwnedSlots(game, [[0, { id: BLOCK.PLANKS, count: 2 }]]);
  game.player.sneaking = true;
  opened.length = 0;
  assert.equal(game.secondary(), true);
  assert.equal(opened.length, 0);
  assert.equal(game.world.get(1, 10, 0), BLOCK.PLANKS);
  assert.equal(game.gameplay.count(BLOCK.PLANKS), 1);
});

test("a main-hand tool can place an offhand torch without consuming or wearing the tool", () => {
  const { game } = parityGame();
  setOwnedSlots(
    game,
    [[0, { id: ITEM.WOOD_PICKAXE, count: 1, durability: 59 }]],
    { id: BLOCK.TORCH, count: 8 }
  );
  game.world.set(1, 9, 0, BLOCK.STONE);
  game.target = {
    x: 1,
    y: 9,
    z: 0,
    id: BLOCK.STONE,
    normal: { x: 0, y: 1, z: 0 },
  };
  assert.equal(game.secondary(), true);
  assert.equal(game.world.get(1, 10, 0), BLOCK.TORCH);
  assert.equal(game.gameplay.getHandStack("offhand").count, 7);
  assert.equal(game.gameplay.getHandStack("main").durability, 59);
});

test("right-clicking owned armor equips its actual slot instead of granting passive backpack armor", () => {
  const { game } = parityGame();
  setOwnedSlots(game, [
    [
      0,
      {
        id: ITEM.IRON_ARMOR,
        count: 1,
        durability: getItem(ITEM.IRON_ARMOR).durability,
      },
    ],
  ]);
  assert.equal(game.gameplay.getState().armorPoints, 0);
  assert.equal(game.secondary(), true);
  const state = game.gameplay.getState();
  assert.equal(state.equipment.chest.id, ITEM.IRON_ARMOR);
  assert.equal(state.slots[0], null);
  assert.ok(state.armorPoints > 0);
});
