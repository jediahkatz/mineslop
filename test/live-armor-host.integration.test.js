import assert from "node:assert/strict";
import test from "node:test";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { durabilityLoss } from "../src/enchantment-effects.js";
import { armorItemId } from "../src/gear-content.js";
import { getItem, ITEM, ITEMS } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { liveArmorFixture } from "./live-armor-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("live Wildlife melee cooldown gates health and saved armor RNG before the Game damage route", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  const mob = f.game.wildlife.spawn("zombie", { x: 8.5, y: 65, z: 10 });
  assert.ok(mob);
  mob.attackCooldown = 0;
  const step = () => f.game.wildlife.update(0.05, f.game.elapsed += 0.05, f.player.position, {
    timeOfDay: 0, mode: "survival", health: f.gameplay.health,
    playerEye: f.player.eyePosition, playerForward: f.player.forward,
  });
  step();
  assert.equal(f.events.length, 1);
  const health = f.gameplay.health, gear = f.gameplay.equipment, rng = f.services.stations.randomState;
  for (let i = 0; i < Math.floor(mob.spec.cooldown / 0.05) - 2; i++) step();
  assert.equal(f.events.length, 1);
  assert.equal(f.gameplay.health, health);
  assert.deepEqual(f.gameplay.equipment, gear);
  assert.equal(f.services.stations.randomState, rng);
  for (let i = 0; i < 4; i++) step();
  assert.equal(f.events.length, 2);
});

test("actual Game melee/projectile bridge applies toughness and EPF once, with saved Unbreaking RNG", (t) => {
  for (const kind of ["melee", "projectile"]) {
    const f = liveArmorFixture(t);
    f.armor();
    const equipment = f.gameplay.equipment;
    let seed = f.services.stations.randomState;
    const expectedWear = {};
    for (const [slot, stack] of Object.entries(equipment)) {
      const rolls = Array.from({ length: 5 }, () => {
        seed = nextEnchantingSeed(seed);
        return seed / 0x100000000;
      });
      expectedWear[slot] = durabilityLoss(stack, rolls, f.context);
    }
    const tableSeed = f.services.stations.playerState;
    const result = f.hit(20, `readable ${kind} cause`, kind);
    close(result.damage, 2.592);
    close(f.gameplay.health, 17.408);
    assert.equal(f.events.length, 1);
    assert.equal(f.services.stations.randomState, seed);
    assert.deepEqual(f.services.stations.playerState, tableSeed);
    for (const [slot, stack] of Object.entries(equipment)) {
      assert.equal(f.gameplay.equipment[slot].durability, stack.durability - expectedWear[slot]);
      assert.deepEqual(f.gameplay.equipment[slot].data, stack.data);
    }
    close(f.game.wildlife.context.health, f.gameplay.health);
    const loaded = liveArmorFixture(t, { saved: f.snapshot() });
    assert.deepEqual(loaded.gameplay.equipment, f.gameplay.equipment);
    assert.equal(loaded.services.stations.randomState, seed);
    close(loaded.hit(20, "another attack", kind).damage, 2.592);
    assert.equal(loaded.events.length, 1);
  }
});

test("explicit projectile kind wins over readable cause and activates projectile protection", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  f.editInventory((owned) => {
    owned.equipment.head = progressionStack(armorItemId("netherite", "head"), 1, {
      enchantments: { projectile_protection: 4 },
    });
    return true;
  });
  close(f.hit(20, "Skeleton arrow", "projectile").damage, 1.44);
});

test("a real swept skeleton arrow hits the Game host once and retires without a second armor debit", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  const wildlife = f.game.wildlife;
  const skeleton = wildlife.spawn("skeleton", { x: 8.5, y: 65, z: 6 });
  assert.ok(skeleton);
  wildlife.update(0, 0, f.player.position, {
    mode: "survival", health: 20, playerEye: f.player.eyePosition,
  });
  wildlife.shoot(skeleton);
  assert.equal(wildlife.projectiles.length, 1);
  for (let i = 0; i < 20 && wildlife.projectiles.length; i++) wildlife.updateProjectiles(0.05);
  assert.equal(wildlife.projectiles.length, 0);
  assert.equal(f.events.length, 1);
  const raw = skeleton.spec.damage;
  close(f.events[0].damage, raw * (1 - (20 - raw / 5) / 25) * 0.36);
  const gear = f.gameplay.equipment, rng = f.services.stations.randomState;
  wildlife.updateProjectiles(0.05);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.gameplay.equipment, gear);
  assert.equal(f.services.stations.randomState, rng);
});

test("physical Player landing uses actual Game fall binding, Feather Falling and no armor wear", (t) => {
  const f = liveArmorFixture(t);
  f.editInventory((owned) => {
    owned.equipment.feet = progressionStack(ITEM.IRON_BOOTS, 1, {
      enchantments: { feather_falling: 4 },
    });
    return true;
  });
  const equipment = f.gameplay.equipment, random = f.services.stations.randomState;
  f.player.allowFlight = false;
  f.player.enabled = true;
  f.player.setPosition({ x: 8.5, y: 73, z: 11.5 });
  for (let i = 0; i < 100 && !f.player.grounded; i++)
    f.player.update(0.05);
  assert.equal(f.player.grounded, true);
  assert.equal(f.events.length, 1);
  close(f.events[0].damage, 5 * 0.52);
  assert.deepEqual(f.gameplay.equipment, equipment);
  assert.equal(f.services.stations.randomState, random);
  f.player.update(0.05);
  assert.equal(f.events.length, 1);
  const callback = f.player.onFall;
  f.game.player = { world: f.world };
  assert.equal(callback(10), 0, "an old Player callback cannot damage a replacement");
  f.game.player = f.player;
});

test("Gameplay update routes lava/drowning/starvation and fall into the live host", (t) => {
  const lava = liveArmorFixture(t);
  lava.armor();
  lava.gameplay.update(0.5, { inLava: true });
  close(20 - lava.gameplay.health, 4 * (1 - 19.2 / 25) * 0.36);
  const drowning = liveArmorFixture(t);
  drowning.armor();
  drowning.status("resistance");
  drowning.gameplay.air = 0;
  const gear = drowning.gameplay.equipment, rng = drowning.services.stations.randomState;
  drowning.gameplay.update(1, { underwater: true });
  close(20 - drowning.gameplay.health, 2 * 0.8 * 0.36);
  assert.deepEqual(drowning.gameplay.equipment, gear);
  assert.equal(drowning.services.stations.randomState, rng);
  const hunger = liveArmorFixture(t);
  hunger.armor();
  hunger.status("resistance", 4);
  hunger.gameplay.hunger = 0;
  const before = hunger.gameplay.equipment, random = hunger.services.stations.randomState;
  hunger.gameplay.update(4);
  close(hunger.gameplay.health, 19);
  assert.deepEqual(hunger.gameplay.equipment, before);
  assert.equal(hunger.services.stations.randomState, random);
  const fall = liveArmorFixture(t);
  fall.editInventory((owned) => {
    owned.equipment.feet = progressionStack(ITEM.IRON_BOOTS, 1, {
      enchantments: { feather_falling: 4 },
    });
    return true;
  });
  fall.gameplay.update(0.05, { fallDistance: 8 });
  close(fall.gameplay.health, 20 - 5 * 0.52);
});

test("fire immunity precedes health, armor wear and RNG; readable void bypasses resistance and EPF", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  f.status("fire_resistance");
  f.status("resistance", 4);
  const before = f.gameplay.equipment, random = f.services.stations.randomState;
  for (const kind of ["fire", "on_fire", "in_fire", "lava", "magma", "campfire", "fireball"])
    assert.equal(f.gameplay.damage(4, "a hot thing", kind), 0);
  f.gameplay.update(1, { inLava: true });
  assert.equal(f.gameplay.health, 20);
  assert.deepEqual(f.gameplay.equipment, before);
  assert.equal(f.services.stations.randomState, random);
  assert.equal(f.events.length, 0);
  assert.equal(f.gameplay.damage(20, "the void"), 20);
  assert.equal(f.gameplay.deathCause, "the void");
  assert.equal(f.services.effects.hasActiveEffects, false);
  assert.equal(f.events.length, 1);
});

test("lethal health, effect clear and wear RNG publish before hurt/death observers, once", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  f.status("speed");
  assert.equal(f.gameplay.damage(19, "fall"), 19 * 0.36);
  // Authored low-health state; no legacy damage callbacks are used to prepare it.
  assert.equal(f.coordinator.commit([f.gameplay._prepareState((draft) => {
    draft.health = 1; return true;
  })]).ok, true);
  let deaths = 0, hurts = 0;
  const death = f.gameplay.onDeath;
  f.gameplay.onHurt = () => {
    hurts++;
    assert.equal(f.services.effects.hasActiveEffects, false);
    assert.equal(f.coordinator.usage(f.gameplay), f.gameplay.reservedBytes);
    throw new Error("presentation failure after publish");
  };
  f.gameplay.onDeath = (cause) => { deaths++; death(cause); };
  const life = f.pearls.life;
  assert.equal(f.hit(20, "Skeleton arrow", "projectile").damage, 1);
  assert.equal(f.gameplay.dead, true);
  assert.equal(f.gameplay.deathCause, "Skeleton arrow");
  assert.equal(f.pearls.life, life + 1);
  assert.equal(deaths, 1);
  assert.equal(hurts, 1);
  assert.equal(f.gameplay.damage(4), 0);
  assert.equal(deaths, 1);
});

test("stale hosts, effect revisions, replay and overflowing wear plans refuse without changing health/RNG", (t) => {
  for (const invalidate of [
    (f) => { f.game.paused = true; },
    (f) => { f.game.player = { world: f.world }; },
    (f) => { f.world.setDimension("nether").generate(0); },
    (f) => { f.status("resistance"); },
    (f) => { f.gameplay.select(1); },
  ]) {
    const f = liveArmorFixture(t);
    f.armor();
    const plan = f.integration.prepareDamage(8, "Zombie", "melee");
    assert.ok(plan?.participants);
    invalidate(f);
    const health = f.gameplay.health, gear = f.gameplay.equipment, random = f.services.stations.randomState;
    assert.equal(f.integration.commit(plan).ok, false);
    assert.equal(f.gameplay.health, health);
    assert.deepEqual(f.gameplay.equipment, gear);
    assert.equal(f.services.stations.randomState, random);
    f.game.player = f.player;
    f.game.paused = false;
  }
  const f = liveArmorFixture(t);
  f.armor();
  const plan = f.integration.prepareDamage(8, "Zombie", "melee");
  assert.equal(f.integration.commit(plan).ok, true);
  const snapshot = f.snapshot();
  assert.equal(f.integration.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), snapshot);
  const owner = {};
  assert.equal(f.coordinator.register(owner, MAX_RESERVED_BYTES, { allowOverBudget: true }), true);
  t.after(() => f.coordinator.release(owner));
  const extra = { owner, beforeBytes: MAX_RESERVED_BYTES, afterBytes: MAX_RESERVED_BYTES + 1000,
    validate: () => true, publish: () => assert.fail("overflow published") };
  const overflowPlan = f.integration.prepareDamage(8, "Zombie", "melee");
  assert.equal(f.coordinator.commit([...overflowPlan.participants, extra]).ok, false);
  assert.deepEqual(f.snapshot(), snapshot);
  f.game.progressionIntegration = null;
  assert.equal(f.gameplay.damage(8, "Zombie"), 0, "stale live owners never fall back to iron math");
  f.game.progressionIntegration = f.integration;
});

test("raised shields stop incoming damage before armor, including oversized wear", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  f.editInventory((owned) => {
    owned.offhand = progressionStack(ITEM.SHIELD, 1, { enchantments: { unbreaking: 3 } });
    return true;
  });
  const use = f.game.useActions;
  use.use.start("shield", "offhand", f.gameplay.offhand, f.gameplay.getHandRevision("offhand"));
  use.use.advance(0.25);
  const armor = f.gameplay.equipment, shield = f.gameplay.offhand;
  let seed = f.services.stations.randomState;
  const rolls = Array.from({ length: 5 }, () => {
    seed = nextEnchantingSeed(seed); return seed / 0x100000000;
  });
  assert.equal(f.hit(4, "arrow", "projectile").blocked, true);
  assert.equal(f.gameplay.health, 20);
  assert.deepEqual(f.gameplay.equipment, armor);
  assert.equal(f.gameplay.offhand.durability, shield.durability - durabilityLoss(shield, rolls, f.context));
  assert.equal(f.services.stations.randomState, seed);
  assert.equal(f.events.length, 0);
  f.game.effects.sound = () => { throw new Error("audio observer failed"); };
  assert.equal(f.hit(4, "another arrow", "projectile").blocked, true);
  assert.equal(f.gameplay.health, 20);
  assert.equal(f.events.length, 0);
  assert.equal(use.observerErrors.length, 1);
  // Oversized valid wear uses a bounded count sample, not a refused block.
  const before = f.gameplay.offhand.durability, random = f.services.stations.randomState;
  assert.equal(f.hit(300, "huge arrow", "projectile").blocked, true);
  assert.ok(f.gameplay.offhand.durability < before);
  assert.equal(f.services.stations.randomState, nextEnchantingSeed(random));
  assert.equal(f.gameplay.health, 20);
  assert.deepEqual(f.gameplay.equipment, armor);
  assert.equal(f.hit(4, "from behind", "melee", {
    x: f.player.position.x, y: f.player.eyePosition.y, z: f.player.position.z + 2,
  }).blocked, false);
  assert.equal(f.events.length, 1);
  use.reset();
  use.use.start("shield", "offhand", f.gameplay.offhand, f.gameplay.getHandRevision("offhand"));
  assert.equal(f.hit(4, "not raised", "melee").blocked, false);
  assert.equal(f.events.length, 2);
});

test("main-hand shield cannot block environmental fire, and invalid damage never spends saved RNG", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  f.editInventory((owned) => { owned.slots[0] = progressionStack(ITEM.SHIELD); return true; });
  const use = f.game.useActions;
  use.use.start("shield", "main", f.gameplay.getHandStack(), f.gameplay.getHandRevision("main"));
  use.use.advance(0.25);
  const before = f.snapshot();
  for (const amount of [NaN, Infinity, 0, -1])
    assert.equal(use.damage(amount, "invalid").damage, 0);
  assert.deepEqual(f.snapshot(), before);
  const shield = f.gameplay.getHandStack();
  const result = f.hit(4, "flames", "fire");
  assert.equal(result.blocked, false);
  close(result.damage, 4 * (1 - 19.2 / 25) * 0.36);
  assert.deepEqual(f.gameplay.getHandStack(), shield);
  assert.equal(f.events.length, 1);
});

test("right-click equips all registered armor tiers from finite hands and preserves decorated occupied slots", (t) => {
  const f = liveArmorFixture(t);
  const armor = Object.values(ITEMS).filter((item) => item.equipmentSlot);
  assert.ok(armor.length >= 29);
  for (const item of armor) for (const hand of ["main", "offhand"])
    for (const occupied of [false, true]) {
    const previous = occupied ? progressionStack(armorItemId("iron", item.equipmentSlot), 1, {
      name: "Displaced", repairCost: 2, enchantments: { unbreaking: 2 },
    }, 20) : null;
    const stack = progressionStack(item.id, 1, {
      name: "Equipped", repairCost: 3, enchantments: { unbreaking: 3 },
    }, getItem(item.id).durability - 1);
    f.editInventory((owned) => {
      owned.slots.fill(null);
      owned.equipment[item.equipmentSlot] = previous;
      if (hand === "main") owned.slots[0] = stack;
      else owned.offhand = stack;
      return true;
    });
    f.gameplay.select(0);
    assert.equal(f.game.useActions.useHand(hand, f.gameplay.getHandStack(hand), false), true);
    assert.deepEqual(f.gameplay.equipment[item.equipmentSlot], stack);
    assert.deepEqual(f.gameplay.getHandStack(hand), previous);
  }
  f.gameplay.setMode("creative");
  f.gameplay.assignSlot(0, ITEM.DIAMOND_HELMET);
  const before = f.snapshot();
  assert.equal(f.game.useActions.useHand("main", f.gameplay.getHandStack(), false), false);
  assert.deepEqual(f.snapshot(), before, "virtual palette armor cannot mint finite equipment");
});
