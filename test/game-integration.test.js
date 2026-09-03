import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { VoxelGame } from "../src/game.js";
import { getItem, ITEM } from "../src/items.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

function hold(game, seconds) {
  for (let remaining = seconds; remaining > 1e-9; remaining -= 0.05) {
    const dt = Math.min(remaining, 0.05);
    game.elapsed += dt;
    game.useActions.update(dt);
  }
}

test("holding mine creates the correct log pickup for the survival backpack", () => {
  const { game, drops } = parityGame();
  game.world.set(1, 10, 0, BLOCK.OAK_LOG);
  game.target = { x: 1, y: 10, z: 0, id: BLOCK.OAK_LOG };
  for (let i = 0; i < 100 && game.world.get(1, 10, 0); i++) {
    game.elapsed += 0.1;
    game.primary(0.1);
  }
  assert.equal(game.world.get(1, 10, 0), 0);
  assert.deepEqual(
    drops.map(({ id, count }) => ({ id, count })),
    [{ id: BLOCK.OAK_LOG, count: 1 }]
  );
  assert.deepEqual(drops[0].position, { x: 1.5, y: 10.5, z: 0.5 });
  assert.equal(game.overflow.size, 0);
  assert.equal(game.gameplay.add(drops[0].id, drops[0].count), true);
  assert.equal(game.gameplay.count(BLOCK.OAK_LOG), 1);
  assert.ok(game.gameplay.hotbar.includes(BLOCK.OAK_LOG));
});

test("held right-click consumes one food after 1.6 seconds without a block target", () => {
  const { game } = parityGame();
  game.gameplay.hunger = 10;
  const before = game.gameplay.count(ITEM.APPLE);
  assert.equal(game.beginUse(), true);
  hold(game, 1.55);
  assert.equal(game.gameplay.count(ITEM.APPLE), before);
  assert.equal(game.gameplay.hunger, 10);
  hold(game, 0.05);
  assert.equal(game.gameplay.count(ITEM.APPLE), before - 1);
  assert.equal(game.gameplay.hunger, 14);
  game.endUse();
  hold(game, 2);
  assert.equal(game.gameplay.count(ITEM.APPLE), before - 1);
  assert.equal(game.gameplay.hunger, 14);
});

test("placing a gathered block consumes exactly one item", () => {
  const { game } = parityGame();
  game.gameplay.add(BLOCK.PLANKS, 2);
  game.gameplay.assignSlot(0, BLOCK.PLANKS);
  assert.equal(game.world.set(2, 9, 0, BLOCK.GRASS), true);
  game.target = {
    x: 2,
    y: 9,
    z: 0,
    id: BLOCK.GRASS,
    normal: { x: 0, y: 1, z: 0 },
  };
  assert.equal(game.secondary(), true);
  assert.equal(game.world.get(2, 10, 0), BLOCK.PLANKS);
  assert.equal(game.gameplay.count(BLOCK.PLANKS), 1);
});

test("adjacent table and furnace open explicitly without granting proximity crafting", () => {
  const { game, opened } = parityGame();
  const table = { x: 0, y: 10, z: 1, id: BLOCK.CRAFTING_TABLE };
  const furnace = { x: 1, y: 10, z: 1, id: BLOCK.FURNACE };
  game.world.set(table.x, table.y, table.z, table.id);
  game.world.set(furnace.x, furnace.y, furnace.z, furnace.id);
  const inventory = game.gameplay.getState().slots;
  assert.deepEqual(game.station(), ["hand"]);
  assert.equal(game.gameplay.getState().craftingSize, 2);

  game.target = furnace;
  assert.equal(game.secondary(), true);
  assert.deepEqual(opened.at(-1), { container: BLOCK.FURNACE });
  const state = game.settlement.getContainerState(
    game.world,
    furnace,
    game.gameplay
  );
  assert.equal(state.kind, "furnace");
  assert.deepEqual(state.slots, [null, null, null]);
  assert.deepEqual(game.station(), ["hand"]);
  assert.equal(game.gameplay.getState().craftingSize, 2);

  game.elapsed += 0.25;
  game.target = table;
  assert.equal(game.secondary(), true);
  assert.deepEqual(opened.at(-1), { screen: "crafting", size: 3 });
  assert.deepEqual(game.station(), ["hand", "table"]);
  assert.equal(game.gameplay.getState().craftingSize, 3);
  assert.deepEqual(game.gameplay.getState().slots, inventory);
  game.world.set(table.x, table.y, table.z, BLOCK.AIR);
  assert.deepEqual(game.station(), ["hand"]);
});

test("survival inventory stops movement without pausing the furnace simulation", () => {
  const state = {
    paused: false,
    overlayOpen: true,
    building: false,
    gameplay: { dead: false },
  };
  assert.equal(
    Object.getOwnPropertyDescriptor(VoxelGame.prototype, "active").get.call(
      state
    ),
    false
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(VoxelGame.prototype, "simulating").get.call(
      state
    ),
    true
  );
  state.paused = true;
  assert.equal(
    Object.getOwnPropertyDescriptor(VoxelGame.prototype, "simulating").get.call(
      state
    ),
    false
  );
});

test("releasing a drawn bow spends one arrow and one wear without mining terrain", () => {
  const { game, drops } = parityGame();
  setOwnedSlots(game, [
    [0, { id: ITEM.BOW, count: 1, durability: 7 }],
    [1, { id: ITEM.ARROW, count: 2 }],
  ]);
  game.world.set(0, 10, -20, BLOCK.STONE);
  game.target = { x: 0, y: 10, z: -20, id: BLOCK.STONE, distance: 20 };
  const entity = {
    kind: "zombie",
    spec: { temperament: "hostile" },
    position: new THREE.Vector3(0.5, 9, -11.5),
  };
  let damage = 0;
  game.wildlife.raycast = (eye, forward, range) => {
    assert.equal(eye, game.player.eyePosition);
    assert.equal(forward, game.player.forward);
    assert.ok(Math.abs(range - 32) < 1e-9);
    return { entity, distance: 12 };
  };
  game.wildlife.damage = (target, amount) => {
    assert.equal(target, entity);
    damage += amount;
    return { hit: true, killed: false };
  };
  let origin;
  let destination;
  let shots = 0;
  game.effects.shoot = (start, end) => {
    shots++;
    origin = start.clone();
    destination = end.clone();
  };
  assert.equal(game.beginUse(), true);
  hold(game, 1);
  game.primary(0.1);
  assert.equal(damage, 0);
  assert.equal(shots, 0);
  assert.equal(game.gameplay.count(ITEM.ARROW), 2);
  assert.equal(game.gameplay.getHandStack().durability, 7);
  assert.equal(game.endUse(), true);
  assert.equal(game.gameplay.count(ITEM.ARROW), 1);
  assert.equal(game.gameplay.getHandStack().durability, 6);
  assert.equal(damage, getItem(ITEM.BOW).damage);
  assert.ok(origin.equals(game.player.eyePosition));
  assert.ok(
    destination.equals(
      game.player.eyePosition.clone().addScaledVector(game.player.forward, 12)
    )
  );
  assert.equal(game.endUse(), false);
  assert.equal(shots, 1);
  assert.equal(game.gameplay.count(ITEM.ARROW), 1);
  assert.equal(game.gameplay.getHandStack().durability, 6);
  assert.equal(game.gameplay.count(ITEM.BOW), 1);
  assert.equal(game.world.get(0, 10, -20), BLOCK.STONE);
  assert.equal(game.miningProgress, 0);
  assert.equal(drops.length, 0);
});

test("feeding a wolf takes priority over eating and requires an owned food item", () => {
  const { game } = parityGame();
  game.gameplay.add(ITEM.RAW_BEEF, 1);
  game.gameplay.assignSlot(0, ITEM.RAW_BEEF);
  game.gameplay.hunger = 10;
  game.mobTarget = { entity: {} };
  let fed = 0;
  game.wildlife = {
    interact(_entity, id) {
      assert.equal(id, ITEM.RAW_BEEF);
      fed++;
      return true;
    },
  };
  assert.equal(game.secondary(), true);
  assert.equal(fed, 1);
  assert.equal(game.gameplay.count(ITEM.RAW_BEEF), 0);
  assert.equal(game.gameplay.hunger, 10);
  game.elapsed++;
  assert.equal(game.gameplay.assignSlot(0, ITEM.RAW_BEEF), false);
  assert.equal(game.secondary(), false);
  assert.equal(fed, 1);
  assert.equal(game.gameplay.count(ITEM.RAW_BEEF), 0);
  assert.equal(game.gameplay.hunger, 10);
});

test("mob explosions modify terrain without dealing their already-applied damage twice", () => {
  const { game } = parityGame();
  game.player.position = new THREE.Vector3(0.5, 10, 0.5);
  game.world.set(1, 10, 0, BLOCK.DIRT);
  game.gameplay.damage(4, "creeper");
  game.explode(game.player.position, 2, false);
  assert.equal(game.world.get(1, 10, 0), 0);
  assert.equal(game.gameplay.health, 16);
  game.explode(game.player.position, 2);
  assert.ok(game.gameplay.health < 16, "player-primed TNT still deals damage");
});

test("an unopened title-screen tab cannot enqueue writes over a played world", () => {
  let saves = 0;
  const game = {
    started: false,
    archive: {
      scheduleSave() {
        saves++;
      },
    },
  };
  VoxelGame.prototype.scheduleSave.call(game);
  assert.equal(saves, 0);
  game.started = true;
  VoxelGame.prototype.scheduleSave.call(game);
  assert.equal(saves, 1);
});
