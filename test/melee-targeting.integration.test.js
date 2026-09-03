import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { CombatFeedback } from "../src/combat-feedback.js";
import { VoxelGame } from "../src/game.js";
import { getItem, ITEM } from "../src/items.js";
import { ecosystem } from "./mob-fixtures.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

// Run after the parent wires the integration hunks. These tests deliberately
// exercise the real Game methods, not a test-only replacement melee dispatch.
// All world/inventory mutations are confined to the existing in-memory fixture.
function fixture(t, mode = "survival", itemId = 0) {
  const base = parityGame(mode);
  const { game } = base;
  const item = itemId === BLOCK.AIR ? null : getItem(itemId);
  setOwnedSlots(
    game,
    item
      ? [
          [
            0,
            {
              id: itemId,
              count: 1,
              ...(item.durability ? { durability: item.durability } : {}),
            },
          ],
        ]
      : []
  );
  if (mode === "creative")
    assert.equal(game.gameplay.assignSlot(0, itemId), true);
  const wildlife = ecosystem(game.world, { context: game.worldContext });
  t.after(() => wildlife.dispose());
  game.wildlife = wildlife;
  game.combatFeedback = new CombatFeedback();
  game.meleeTarget = null;
  game.player.forward.set(0, 0, 1);
  const mob = wildlife.spawn("enderman", { x: 0.5, y: 9, z: 3 });
  assert.ok(mob);
  mob.root.rotation.y = mob.targetYaw = Math.PI;
  assert.equal(game.world.set(0, 10, 4, BLOCK.DIRT), true);
  game.updateTarget = VoxelGame.prototype.updateTarget;
  const sounds = [];
  let swing = 0;
  let swingWrites = 0;
  let saves = 0;
  Object.defineProperty(game.effects, "swing", {
    get: () => swing,
    set: (value) => {
      swing = value;
      swingWrites++;
    },
  });
  game.effects.sound = (...args) => sounds.push(args);
  game.scheduleSave = () => {
    saves++;
  };
  const counters = () => ({ sounds: sounds.length, swingWrites, saves });
  game.updateTarget();
  return { ...base, mob, wildlife, counters };
}

const feedbackView = (game) =>
  game.combatFeedback.view({
    now: game.elapsed,
    lastAction: game.lastAction,
    active: game.active,
    hasTarget: !!game.meleeTarget,
    usingItem: game.useActions.use.active,
  });

for (const mode of ["survival", "creative"]) {
  for (const [itemId, damage] of [
    [0, 1],
    [ITEM.IRON_SWORD, 6],
  ]) {
    test(`${mode} gap primary hits with ${itemId ? "iron sword" : "fist"} and never mines behind`, (t) => {
      const { game, mob } = fixture(t, mode, itemId);
      assert.equal(game.mobTarget, null, "right-click target remains precise");
      assert.equal(game.meleeTarget?.entity, mob);
      assert.equal(game.target?.id, BLOCK.DIRT);
      const health = mob.health;
      const writes = game.world.writes.length;
      game.primary(mode === "creative" ? 1 : 0, true);
      assert.equal(mob.health, health - damage);
      assert.equal(game.lastAction, 10);
      for (let frame = 1; frame <= 24; frame++) {
        game.elapsed = 10 + frame * 0.05;
        game.updateTarget();
        game.primary(0.05, false);
      }
      assert.equal(
        mob.health,
        health - damage,
        "holding is not auto-attacking"
      );
      assert.equal(game.world.get(0, 10, 4), BLOCK.DIRT);
      assert.equal(game.world.writes.length, writes);
      assert.equal(game.miningProgress, 0);
    });
  }
}

test("0.49 refusal produces feedback but no wear/swing/sound/save; 0.51 retains six damage", (t) => {
  const { game, mob, counters } = fixture(t, "survival", ITEM.IRON_SWORD);
  const health = mob.health;
  const durability = game.gameplay.getHandStack().durability;
  game.primary(0, true);
  const accepted = counters();
  assert.equal(mob.health, health - 6);
  assert.equal(game.gameplay.getHandStack().durability, durability - 1);
  game.elapsed = 10.49;
  game.primary(0, true);
  assert.deepEqual(counters(), accepted);
  assert.equal(game.lastAction, 10);
  assert.equal(mob.health, health - 6);
  assert.equal(game.gameplay.getHandStack().durability, durability - 1);
  assert.equal(feedbackView(game).blockedReason, "cooldown");
  game.elapsed = 10.51;
  game.primary(0, true);
  assert.equal(game.lastAction, 10.51);
  assert.equal(mob.health, health - 12);
  assert.equal(game.gameplay.getHandStack().durability, durability - 2);
  assert.equal(counters().swingWrites, accepted.swingWrites + 1);
  assert.equal(counters().sounds, accepted.sounds + 1);
  assert.equal(feedbackView(game).blockedReason, null);
});

test("acquiring the continuous volume while held still requires a fresh press", (t) => {
  const { game, mob, counters } = fixture(t, "survival", ITEM.IRON_SWORD);
  const health = mob.health;
  game.player.forward.set(1, 0, 0);
  game.updateTarget();
  assert.equal(game.meleeTarget, null);
  game.heldAction = "mine";
  game.primary(0, true);
  game.player.forward.set(0, 0, 1);
  for (const elapsed of [10.6, 11.2]) {
    game.elapsed = elapsed;
    game.updateTarget();
    assert.equal(game.meleeTarget?.entity, mob);
    game.primary(0.1, false);
    assert.equal(feedbackView(game).blockedReason, null);
  }
  assert.equal(mob.health, health);
  assert.deepEqual(counters(), { sounds: 0, swingWrites: 0, saves: 0 });
  game.elapsed = 11.21;
  game.primary(0, true);
  assert.equal(mob.health, health - 6);
});

test("real offhand shield use blocks primary without wear; canceling does not auto-attack", (t) => {
  const { game, mob, counters } = fixture(t, "survival", ITEM.IRON_SWORD);
  setOwnedSlots(
    game,
    [
      [
        0,
        {
          id: ITEM.IRON_SWORD,
          count: 1,
          durability: getItem(ITEM.IRON_SWORD).durability,
        },
      ],
    ],
    { id: ITEM.SHIELD, count: 1, durability: getItem(ITEM.SHIELD).durability }
  );
  const health = mob.health;
  const hand = game.gameplay.getHandStack();
  const offhand = game.gameplay.getHandStack("offhand");
  assert.equal(game.beginUse("test"), true);
  assert.equal(game.useActions.use.active, true);
  const before = counters();
  game.primary(0, true);
  assert.equal(mob.health, health);
  assert.deepEqual(game.gameplay.getHandStack(), hand);
  assert.deepEqual(game.gameplay.getHandStack("offhand"), offhand);
  assert.deepEqual(counters(), before);
  assert.equal(feedbackView(game).phase, "using-item");
  assert.equal(feedbackView(game).blockedReason, "using-item");
  game.endUse("test", true);
  game.elapsed = 11;
  game.primary(0.1, false);
  assert.equal(mob.health, health);
  game.primary(0, true);
  assert.equal(mob.health, health - 6);
});

test("F5 render-camera positions do not move either acquisition ray", (t) => {
  const { game, mob } = fixture(t);
  for (const [x, y, z] of [
    [0.5, 10.62, -3.5],
    [0.5, 10.62, 4.5],
    [10, 20, 10],
  ]) {
    game.graphics.camera.position.set(x, y, z);
    game.updateTarget();
    assert.equal(game.mobTarget, null);
    assert.equal(game.meleeTarget?.entity, mob);
    assert.ok(
      Math.abs(game.meleeTarget.distance - (2.5 - mob.spec.radius)) < 1e-9
    );
    assert.equal(game.target.distance, 3.5);
  }
});

test("Game supplies actual Survival/Creative reach, not the longer block range", (t) => {
  for (const mode of ["survival", "creative"]) {
    const { game, mob } = fixture(t, mode);
    assert.equal(game.world.set(0, 10, 4, BLOCK.AIR), true);
    const reach = mode === "creative" ? 5 : 3;
    for (const offset of [-0.00001, 0.00001]) {
      mob.position.z =
        game.player.eyePosition.z + reach + mob.spec.radius + offset;
      game.updateTarget();
      assert.equal(game.meleeTarget?.entity ?? null, offset < 0 ? mob : null);
    }
  }
});

test("bow melee remains one damage without ammo/wear; actual bow release still misses the precise gap", (t) => {
  const { game, mob } = fixture(t, "survival", ITEM.BOW);
  setOwnedSlots(game, [
    [0, { id: ITEM.BOW, count: 1, durability: getItem(ITEM.BOW).durability }],
    [1, { id: ITEM.ARROW, count: 2 }],
  ]);
  const health = mob.health;
  const durability = game.gameplay.getHandStack().durability;
  game.primary(0, true);
  assert.equal(mob.health, health - 1);
  assert.equal(game.gameplay.count(ITEM.ARROW), 2);
  assert.equal(game.gameplay.getHandStack().durability, durability);
  assert.equal(game.beginUse("test"), true);
  for (let frame = 0; frame < 4; frame++) {
    game.elapsed += 0.25;
    game.useActions.update(0.25);
  }
  let endpoint = null;
  game.effects.shoot = (_from, to) => {
    endpoint = to.clone();
  };
  assert.equal(game.endUse("test"), true);
  assert.equal(mob.health, health - 1, "the melee box never intercepts arrows");
  assert.equal(game.gameplay.count(ITEM.ARROW), 1);
  assert.equal(game.gameplay.getHandStack().durability, durability - 1);
  assert.equal(endpoint?.z, 4, "bow still hits the precise background block");
});

test("right-click interaction continues through the precise gap independently of melee selection", (t) => {
  const { game, mob, opened } = fixture(t);
  assert.equal(game.world.set(0, 10, 4, BLOCK.CHEST), true);
  game.updateTarget();
  assert.equal(game.meleeTarget?.entity, mob);
  assert.equal(game.mobTarget, null);
  assert.equal(game.secondary(), true);
  assert.equal(opened[0]?.container, BLOCK.CHEST);
});

test("inactive attempts stay quiet and input reset drops only ephemeral combat state", (t) => {
  const { game, mob, counters } = fixture(t);
  const health = mob.health;
  game.active = false;
  game.primary(0, true);
  assert.equal(mob.health, health);
  assert.deepEqual(counters(), { sounds: 0, swingWrites: 0, saves: 0 });
  assert.equal(feedbackView(game).visible, false);
  game.active = true;
  game.lastAction = 10;
  game.elapsed = 10.25;
  game.primary(0, true);
  assert.equal(feedbackView(game).blockedReason, "cooldown");
  game.resetActions();
  assert.equal(game.meleeTarget, null);
  assert.equal(feedbackView(game).blockedReason, null);
  assert.equal(game.lastAction, 10, "reset is not a cooldown bypass");
});
