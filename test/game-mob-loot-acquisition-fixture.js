import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { ingredientMobLoot } from "../src/ingredient-mob-loot.js";
import { MAX_PICKUPS } from "../src/pickups.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { World } from "../src/world.js";
import { gameMobFixture, gameMobGenerator } from "./game-mob-integration-fixture.js";

/** Authored victims/equipment for transaction tests, NOT natural acquisition. */
export async function lootAcquisitionFixture(t, kind = "spider", {
  ingredient = false, generatorVersion = 3,
} = {}) {
  const world = new World("loot-retention-repro", {
    dimension: kind === "ghast" ? "nether" : "overworld",
    generatorVersion, generatorFactory: gameMobGenerator, useWorker: false,
  });
  const f = await gameMobFixture(t, { world });
  let id = `loot-repro:${kind}`;
  if (ingredient) {
    id = Array.from({ length: 128 }, (_, index) => `loot-repro:${kind}:${index}`)
      .find((id) => ingredientMobLoot(world, { kind, id }, true)?.drops.length === 2);
    assert.ok(id, "bounded authored victim selection must include an ingredient roll");
  }
  const mob = f.wildlife.spawn(kind, { x: 8.5, y: 65, z: 8.5 }, { id });
  assert.ok(mob, "authored victim must be admitted by real Wildlife.spawn");
  mob.health = 1;
  f.aim(mob);
  return { f, mob };
}

/** Reusable with an existing gameMobFixture; does not grant loot or move time. */
export function attackLootMob(f, mob, weapon = "melee") {
  f.aim(mob);
  f.game.updateTarget();
  if (weapon === "bow") {
    assert.equal(f.game.useActions.begin("mouse"), true);
    f.game.useActions.update(1);
    return f.game.useActions.end("mouse");
  }
  assert.equal(f.game.meleeTarget?.entity, mob, "real physical melee ray must hit");
  return f.game.primary(0.05, true);
}

export function equipLootWeapon(f, weapon) {
  f.hold(weapon === "bow" ? "BOW" : "DIAMOND_SWORD");
  if (weapon === "bow") f.hold("ARROW", { hand: "offhand", count: 8 });
}

export function lootOwnership(f, mob) {
  return {
    present: f.wildlife.byId.get(mob.id) === mob,
    health: mob.health, dead: mob.dead,
    killed: f.wildlife.killed.has(mob.id),
    rng: f.wildlife.randomState,
    hand: f.gameplay.getHandStack("main"),
    offhand: f.gameplay.getHandStack("offhand"),
    handRevision: f.gameplay.getHandRevision("main"),
    offhandRevision: f.gameplay.getHandRevision("offhand"),
    residentRevision: f.wildlife._ecologyRevision,
    overflowRevision: f.overflow.revision,
    exhaustion: f.gameplay.exhaustion,
    overflow: f.overflow.serialize(),
    pickups: f.game.pickups.serialize(),
    xp: f.game.experienceOrbs.serialize(),
    experience: f.gameplay.experience,
    lastAction: f.game.lastAction,
    bytes: f.coordinator.budget.totalBytes,
  };
}

/** Use actual pool capacity and actual shared reservation, never sink mocks. */
export function constrainLootRetention(t, f, mob, denial) {
  assert.equal(f.game.pickups.spawn(BLOCK.COBBLESTONE, 64 * MAX_PICKUPS,
    { x: 4.5, y: 65, z: 4.5 }), true);
  assert.equal(f.game.pickups.serialize().items.length, MAX_PICKUPS);
  if (denial === "records") {
    f.overflow.maxEntries = 1;
    assert.equal(f.overflow.enqueue([{ id: BLOCK.COBBLESTONE, count: 1 }],
      { x: 4.5, y: 65, z: 4.5 }, f.world.dimension), true);
  } else if (denial === "partial-records") {
    f.overflow.maxEntries = 1;
  } else {
    assert.ok(["budget", "partial-budget"].includes(denial));
    let allowance = 0;
    if (denial === "partial-budget") {
      const first = mob.spec.drops[0];
      const plan = f.game.inventoryActions.prepareDropItems(
        [{ id: first.id, count: first.min }], mob.position);
      assert.ok(plan);
      allowance = plan.afterBytes - plan.beforeBytes;
    }
    const blocker = {};
    assert.equal(f.coordinator.register(blocker,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes - allowance), true);
    t.after(() => f.coordinator.release(blocker));
  }
}

/**
 * Permanent atomicity observers. Record whole-batch preparation and detect
 * eager drop callbacks while delegating unchanged to the real resource owners.
 */
export function observeLootAttempt(t, f, mob, weapon) {
  const calls = [];
  const batches = [];
  const originalPrepare = f.game.inventoryActions.prepareDropItems;
  f.game.inventoryActions.prepareDropItems = function (...args) {
    const result = originalPrepare.apply(this, args);
    batches.push({ drops: structuredClone(args[0]), prepared: !!result });
    return result;
  };
  const originalDrop = f.game.dropItems;
  f.game.dropItems = function (...args) {
    const before = lootOwnership(f, mob);
    const accepted = originalDrop.apply(this, args);
    calls.push({ drops: structuredClone(args[0]), accepted, present: before.present,
      health: before.health, killed: before.killed });
    return accepted;
  };
  t.after(() => {
    f.game.dropItems = originalDrop;
    f.game.inventoryActions.prepareDropItems = originalPrepare;
  });
  return {
    calls,
    run() {
      const before = lootOwnership(f, mob);
      const result = attackLootMob(f, mob, weapon);
      const after = lootOwnership(f, mob);
      return { before, after, calls, batches, result };
    },
  };
}

export const acquisitionIngredients = [ITEM.SPIDER_EYE, ITEM.GHAST_TEAR];
