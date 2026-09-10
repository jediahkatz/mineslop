import assert from "node:assert/strict";
import test from "node:test";
import { cloneStack } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { potionStack } from "./brewing-fixture.js";
import { combatBeach } from "./combat-effects-fixture.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";

const saddleData = { version: 1, name: "Splash-tested trail saddle 🐴" };
const looseItems = (f) => [
  ...f.overflow.serialize().entries,
  ...f.game.pickups.serialize().items,
];
const looseSaddles = (f) => looseItems(f)
  .filter((stack) => stack.id === ITEM.SADDLE)
  .map((stack) => cloneStack(stack, f.context));
const carriedSaddles = (f) => [
  ...f.gameplay.slots, f.gameplay.offhand, f.gameplay.cursor,
].filter((stack) => stack?.id === ITEM.SADDLE);

/**
 * Authored sand floor, 34 finite wheat, one named saddle and finite bottles.
 * Taming, saddle quick-move, throws, collisions and all resource owners are real.
 * This is not a natural acquisition, from-zero Survival or browser/UI test.
 */
async function equippedHorse(t, options = {}) {
  const f = await gameMobFixture(t, options);
  const horse = f.spawn("potion:metadata:horse");
  const saddle = await f.saddle(horse, saddleData);
  assert.equal(f.gameplay.mode, "survival");
  assert.deepEqual(f.horses.state(horse.id).saddle, saddle);
  assert.deepEqual(carriedSaddles(f), [], "quick-move transfers the only owned saddle");
  assert.deepEqual(looseSaddles(f), []);
  assert.equal(f.vehicles.dismount().ok, true);
  assert.equal(f.game.applyVehiclePose(), true);
  f.player.yaw = 0;
  f.player.pitch = -Math.PI / 9;
  f.player.setPosition({ ...point(horse.position), z: horse.position.z + 4 });
  return Object.assign(f, { horse, saddle });
}

function throwBottle(f, id) {
  const stack = potionStack(f.progression.services.catalog, id, {
    form: "splash", name: `Finite ${id} bottle`,
  });
  assert.equal(f.gameplay.getHandStack(), null);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots[f.gameplay.selected] = stack;
    return true;
  }), true);
  const result = f.progression.throwPotion();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.gameplay.getHandStack(), null, "throw consumes the finite held bottle");
  assert.equal(f.progression.services.potions.size, 1);
  assert.deepEqual(f.progression.services.potions.projectiles[0].stack, stack);
}

function nextImpact(f, { allowRefusal = false } = {}) {
  const potions = f.progression.services.potions;
  const id = potions.projectiles[0]?.id;
  assert.ok(id);
  for (let step = 0; step < 16; step++) {
    const before = f.ownership();
    const plan = potions.prepareStep(id);
    assert.deepEqual(f.ownership(), before, "swept impact preparation is read-only");
    if (!plan) {
      assert.equal(allowRefusal, true, "the real swept impact must prepare");
      return null;
    }
    if (plan.result.type === "impact") return plan;
    assert.equal(plan.result.type, "flight", "the authored corridor must contain an impact");
    assert.equal(f.progression.commit(plan).ok, true);
  }
  assert.fail("No real swept potion impact in the bounded authored corridor");
}

async function armedHorse(t, options = {}) {
  const f = await equippedHorse(t, options);
  throwBottle(f, "slowness");
  assert.equal(f.progression.commit(nextImpact(f)).ok, true);
  assert.equal(f.game.mobStatusEffects.effectsFor({
    dimension: f.world.dimension, entityId: f.horse.id, life: f.horse.life,
  }).effects[0].id, "slowness");
  assert.equal(f.horses.hurt(f.horse, f.horse.health - 1, null, {
    retaliate: false,
  }).ok, true);
  assert.equal(f.horse.health, 1);
  throwBottle(f, "harming");
  return f;
}

// Transparent observation only: the actual contribution and native drop
// publisher run unchanged and return their original participant objects.
function observeRewards(t, f) {
  const seen = { deaths: [], groups: [] };
  const contribute = f.game.mobPotionImpact._contributeHealth;
  t.mock.method(f.game.mobPotionImpact, "_contributeHealth", function (...args) {
    const contribution = Reflect.apply(contribute, this, args);
    const mob = args[1];
    if (args[2].dead) {
      const result = contribution?.result;
      const death = {
        kind: mob.kind, entityId: mob.id,
        drops: structuredClone(result?.drops ?? result?.reward?.drops ?? []),
        dropsCommitted: result?.dropsCommitted,
        experience: result?.experience ?? result?.reward?.experience ?? 0,
      };
      seen.deaths.push(death);
    }
    return contribution;
  });
  const prepareGroups = f.game.inventoryActions.prepareDropItemGroups;
  t.mock.method(f.game.inventoryActions, "prepareDropItemGroups", function (groups) {
    seen.groups.push(structuredClone(groups));
    return Reflect.apply(prepareGroups, this, [groups]);
  });
  return seen;
}

function commitHorseDeath(f, seen, { vetoes = false } = {}) {
  const plan = nextImpact(f);
  const horseReward = seen.deaths.find(({ kind }) => kind === "horse");
  assert.ok(horseReward);
  assert.equal(horseReward.dropsCommitted, false, "the horse defers its real loot");
  assert.deepEqual(horseReward.drops.find(({ id }) => id === ITEM.SADDLE), f.saddle);
  assert.deepEqual(seen.groups, [[{
    drops: horseReward.drops,
    position: point(f.horse.position),
    options: { pickupDelay: 0.4, velocity: { x: 0, y: 1.5, z: 0 } },
  }]], "grouping preserves the complete owned drops and their publication position");
  const owners = plan.participants.map((part) => part.owner);
  assert.equal(new Set(owners).size, owners.length);
  for (const owner of [
    f.progression.services.potions, f.horses, f.wildlife, f.overflow,
    f.game.experienceOrbs, f.game.mobStatusEffects, f.gameplay,
  ]) assert.equal(owners.filter((entry) => entry === owner).length, 1);
  if (vetoes) {
    const before = f.ownership();
    for (let index = 0; index < plan.participants.length; index++) {
      const participants = plan.participants.map((part, candidate) =>
        index === candidate ? { ...part, validate: () => false } : part);
      assert.equal(f.coordinator.commit(participants).ok, false);
      assert.deepEqual(f.ownership(), before, `owner ${index} veto must be atomic`);
    }
  }
  const committed = f.progression.commit(plan);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.deepEqual(committed.observerErrors, []);
  assert.equal(f.horses.state(f.horse.id).alive, false);
  assert.equal(f.wildlife.byId.has(f.horse.id), false);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 0);
  assert.equal(f.progression.services.potions.size, 0);
  assert.deepEqual(carriedSaddles(f), []);
  assert.equal(looseSaddles(f).reduce((sum, stack) => sum + stack.count, 0), 1);
  assert.equal(f.game.experienceOrbs.serialize().orbs.reduce((sum, orb) =>
    sum + orb.amount, 0), horseReward.experience);
  const paid = f.ownership();
  assert.equal(f.progression.commit(plan).ok, false, "an impact plan cannot pay twice");
  assert.deepEqual(f.ownership(), paid);
  assert.equal(f.progression.services.potions.prepareStep(plan.result.id), null);
}

async function coldRestore(t, f, options = {}) {
  const saved = parseWorldFile(exportWorldFile(f.snapshot()));
  const restored = await gameMobFixture(t, { saved, ...options });
  return restored;
}

test("paid splash death preserves the exact equipped saddle after every owner veto and replay", async (t) => {
  const f = await armedHorse(t);
  const seen = observeRewards(t, f);
  commitHorseDeath(f, seen, { vetoes: true });
  assert.deepEqual(looseSaddles(f), [f.saddle],
    "paid splash death must retain the equipped saddle's supported metadata");
});

test("named saddle survives paid potion death, cold archive restoration and actual pickup", async (t) => {
  const f = await armedHorse(t);
  commitHorseDeath(f, observeRewards(t, f));
  const restored = await coldRestore(t, f);
  assert.notEqual(restored.horses, f.horses);
  assert.notEqual(restored.overflow, f.overflow);
  assert.notEqual(restored.gameplay, f.gameplay);
  assert.equal(restored.horses.state(f.horse.id).alive, false);
  assert.equal(restored.wildlife.byId.has(f.horse.id), false);
  assert.equal(restored.progression.services.potions.size, 0);
  assert.deepEqual(restored.game.experienceOrbs.serialize(), f.game.experienceOrbs.serialize());
  assert.deepEqual(looseSaddles(restored), [f.saddle],
    "the cold archive restores the exact published saddle");
  const drop = restored.game.pickups.serialize().items.find(({ id }) => id === ITEM.SADDLE);
  assert.ok(drop, "the real post-commit overflow flush supplies a collectible saddle");
  restored.player.setPosition(point(drop));
  for (let step = 0; step < 8; step++)
    restored.game.pickups.update(0.1, step / 10, restored.player.position, restored.gameplay);
  assert.deepEqual(looseSaddles(restored), [], "pickup moves, rather than copies, the saddle");
  assert.equal(carriedSaddles(restored).length, 1);
  assert.deepEqual(carriedSaddles(restored), [f.saddle],
    "cold-restored potion loot must keep its metadata when collected into finite Gameplay");
});

test("real overflow capacity refusal preserves named saddle, paid flight and status across cold restore", async (t) => {
  const f = await armedHorse(t, { overflowMaxEntries: 1 });
  const seen = observeRewards(t, f);
  assert.equal(nextImpact(f, { allowRefusal: true }), null);
  assert.equal(seen.groups.length, 1, "refusal occurs at the real reward grouping boundary");
  assert.deepEqual(f.horses.state(f.horse.id).saddle, f.saddle);
  assert.equal(f.horse.health, 1);
  assert.equal(f.progression.services.potions.size, 1);
  assert.equal(f.gameplay.getHandStack(), null, "the already-paid bottle is not refunded");
  assert.deepEqual(looseItems(f), []);
  assert.equal(f.game.experienceOrbs.size, 0);
  const restored = await coldRestore(t, f, { overflowMaxEntries: 1 });
  assert.deepEqual(restored.horses.state(f.horse.id).saddle, f.saddle);
  assert.deepEqual(restored.game.mobStatusEffects.serialize(), f.game.mobStatusEffects.serialize());
  // JSON archives canonically encode -0 as 0; compare the persisted flight.
  assert.deepEqual(restored.progression.services.potions.serialize(),
    JSON.parse(JSON.stringify(f.progression.services.potions.serialize())));
  const before = restored.ownership();
  assert.equal(nextImpact(restored, { allowRefusal: true }), null);
  assert.deepEqual(restored.ownership(), before);
});

test("mixed real potion deaths retain legacy name-only Ecology and numeric generic loot conversion", async (t) => {
  const f = await armedHorse(t, { generatorFactory: combatBeach });
  const cow = f.wildlife.spawn("cow", {
    ...point(f.horse.position), x: f.horse.position.x + 2,
  }, { id: "potion:metadata:cow" });
  assert.ok(cow);
  const admission = f.ecology.prepareAdmission("turtle", {
    ...point(f.horse.position), x: f.horse.position.x - 2,
  });
  assert.ok(admission);
  assert.equal(f.ecology.commit(admission).ok, true);
  const turtle = f.wildlife.byId.get(admission.result.id);
  assert.ok(turtle);
  assert.equal(f.wildlife.damage(cow, cow.health - 1, null, false).killed, false);
  assert.equal(f.ecology.hurt(turtle, turtle.health - 1, null, { retaliate: false }).ok, true);
  const seen = observeRewards(t, f);
  const plan = nextImpact(f);
  const symbolic = seen.deaths.find(({ kind }) => kind === "turtle")?.drops;
  assert.ok(symbolic?.length, "the authored turtle must supply nonempty real symbolic loot");
  assert.ok(symbolic.every((drop) => typeof drop.name === "string" && drop.id === undefined));
  const groups = seen.groups[0];
  assert.equal(groups.length, 3, "each death retains its own positioned drop group");
  const groupAt = (mob) => groups.find(({ position }) =>
    position.x === mob.position.x && position.z === mob.position.z);
  assert.deepEqual(groupAt(turtle).drops,
    symbolic.map(({ name, count }) => ({ id: ITEM[name], count })));
  assert.deepEqual(groupAt(f.horse).drops,
    seen.deaths.find(({ kind }) => kind === "horse").drops,
    "numeric owned drops keep metadata alongside legacy symbolic loot");
  assert.ok(groupAt(cow).drops.some(({ id, count }) => id === ITEM.RAW_BEEF && count > 0));
  assert.equal(f.progression.commit(plan).ok, true);
  assert.equal(f.ecology.ecology.state(turtle.id).alive, false);
  assert.equal(f.horses.state(f.horse.id).alive, false);
  assert.equal(f.wildlife.byId.has(cow.id), false);
  for (const { name, count } of symbolic)
    assert.equal(looseItems(f).filter((drop) => drop.id === ITEM[name])
      .reduce((sum, drop) => sum + drop.count, 0), count);
  assert.ok(looseItems(f).some(({ id }) => id === ITEM.RAW_BEEF));
  assert.deepEqual(looseSaddles(f), [f.saddle]);
  assert.equal(f.progression.services.potions.size, 0);
});
