import assert from "node:assert/strict";
import test from "node:test";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { ProgressionGearEffects } from "../src/progression-gear-effects.js";
import { StatusEffects } from "../src/status-effects.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";
import {
  approach, chargedShot, combatBeach, combatFixture, combatState, effect, equip,
  uniqueAttackOwners,
} from "./combat-effects-fixture.js";

const edit = (f, change) => assert.equal(f.gameplay.inventoryTransaction((owned) => {
  change(owned);
  return true;
}), true);
const replace = (owner, key, next) => {
  const previous = owner[key];
  owner[key] = next;
  return () => { owner[key] = previous; };
};
const invalidations = [
  { name: "status refresh", change: (f) => { effect(f, "strength", 0, 200); } },
  { name: "status expiry", damage: 8, change: (f) => {
    assert.equal(f.progression.frame(0.25).ok, true);
    assert.equal(f.progression.services.effects.hasActiveEffects, false);
  } },
  { name: "identical hand replacement", change: (f) =>
    edit(f, (owned) => { owned.slots[0] = { ...owned.slots[0] }; }) },
  { name: "selection away and back", change: (f) => {
    f.gameplay.select(1); f.gameplay.select(0);
  } },
  { name: "offhand replacement", change: (f) =>
    edit(f, (owned) => { owned.offhand = progressionStack(ITEM.APPLE); }) },
  { name: "equipment replacement", change: (f) =>
    edit(f, (owned) => { owned.equipment.head = progressionStack(ITEM.IRON_HELMET); }) },
  { name: "progression detachment", unavailable: true,
    change: (f) => replace(f.game, "progressionIntegration", null) },
  { name: "service binding replacement", unavailable: true,
    change: (f) => replace(f.game, "progressionServices", {}) },
  { name: "damage host detachment", unavailable: true,
    change: (f) => replace(f.gameplay, "damageHost", null) },
  { name: "gear Gameplay detachment", unavailable: true,
    change: (f) => replace(f.progression.gear, "gameplay", null) },
  { name: "gear status detachment", unavailable: true,
    change: (f) => replace(f.progression.gear, "effects", null) },
  { name: "gear owner replacement", unavailable: true, change: (f) => {
    const services = f.progression.services;
    return replace(services, "gear",
      new ProgressionGearEffects(f.gameplay, services.effects, services.stations));
  } },
  { name: "status owner replacement", unavailable: true, change: (f) => {
    const services = f.progression.services;
    const other = new StatusEffects({
      coordinator: f.coordinator, state: services.effects.serialize(),
    });
    const restore = replace(services, "effects", other);
    return () => { restore(); other.dispose(); };
  } },
  { name: "Gameplay owner replacement", unavailable: true, change: (f) => {
    const other = new Gameplay({ coordinator: f.coordinator, context: f.context });
    const restore = replace(f.game, "gameplay", other);
    return () => { restore(); other.dispose(); };
  } },
  { name: "player replacement", unavailable: true,
    change: (f) => replace(f.game, "player", { world: f.world }) },
  { name: "world replacement", unavailable: true,
    change: (f) => replace(f.game, "world", {}) },
];

for (const kind of ["horse", "spider", "turtle"])
  for (const invalidation of invalidations) {
    test(`${kind} melee rejects stale ${invalidation.name} before any payment`, async (t) => {
      const f = await combatFixture(t, kind);
      equip(f, { enchantments: { sharpness: 3 } });
      effect(f, "strength", 0, 5);
      const plan = f.actions.prepareMelee(f.mob);
      uniqueAttackOwners(f, plan.participants);
      const paid = plan.participants.find((part) => part.owner === f.gameplay);
      const restore = invalidation.change(f);
      try {
        const before = combatState(f);
        assert.equal(paid.validate(), false, "the existing Gameplay participant carries the observation");
        assert.equal(f.actions.commit(plan).ok, false);
        if (invalidation.unavailable)
          assert.equal(f.actions.prepareMelee(f.mob).ok, false,
            "an unavailable installed host cannot silently become a raw-damage fallback");
        assert.deepEqual(combatState(f), before);
      } finally {
        if (typeof restore === "function") restore();
      }
      const health = f.mob.health, hand = f.gameplay.getHandStack();
      const fresh = f.actions.prepareMelee(f.mob);
      uniqueAttackOwners(f, fresh.participants);
      assert.equal(f.actions.commit(fresh).ok, true);
      assert.equal(health - f.mob.health, invalidation.damage ?? 11);
      assert.equal(f.gameplay.getHandStack().durability, hand.durability - 1);
      assert.equal(f.gameplay.exhaustion, 0.1);
    });
  }

for (const kind of ["horse", "spider", "turtle", "zombie"])
  for (const invalidation of invalidations.filter(({ name }) => [
    "status refresh", "status expiry", "identical hand replacement",
    "equipment replacement", "progression detachment",
  ].includes(name))) {
    test(`${kind} bow observes effects before a ${invalidation.name} during cost preparation`, async (t) => {
      const f = await combatFixture(t, kind);
      equip(f, { bow: true, enchantments: { power: 3 } });
      effect(f, "strength", 0, 5);
      const shot = chargedShot(f);
      const prepare = f.gameplay.prepareBowShot;
      let restore, changed;
      const interleave = t.mock.method(f.gameplay, "prepareBowShot", function (...args) {
        const part = Reflect.apply(prepare, this, args);
        assert.ok(part);
        restore = invalidation.change(f);
        changed = combatState(f);
        return part;
      });
      try {
        assert.equal(f.game.useActions.fireBow(shot), false);
        assert.ok(changed, "the real bow cost was prepared before the authored invalidation");
        assert.deepEqual(combatState(f), changed);
      } finally {
        interleave.mock.restore();
        if (typeof restore === "function") restore();
      }
      const hand = f.gameplay.getHandStack(), health = f.mob.health;
      const fresh = chargedShot(f);
      assert.equal(f.game.useActions.fireBow(fresh), true);
      assert.equal(health - f.mob.health, 8);
      assert.equal(f.gameplay.getHandStack().durability, hand.durability - 1);
      assert.equal(f.gameplay.countPlain(ITEM.ARROW), 2);
    });
  }

for (const kind of ["horse", "spider"])
  for (const weapon of ["melee", "bow"])
    for (const sink of ["cost", "victim", "loot", "xp"]) {
      test(`${kind} boosted ${weapon}: ${sink} veto preserves ownership and an immediate retry pays once`, async (t) => {
        const f = await combatFixture(t, kind);
        const bow = weapon === "bow";
        const hand = equip(f, { bow, enchantments: bow ? { power: 3 } : { sharpness: 3 } });
        effect(f);
        // Actual environmental damage makes this a BONUS-dependent lethal hit:
        // unmodified six/four damage could not produce any reward receipts.
        const remaining = bow ? 7 : 9;
        assert.equal(f.wildlife.damage(f.mob, f.mob.health - remaining, null, false).damage,
          f.mob.spec.health - remaining);
        assert.equal(f.mob.health, remaining);
        const shot = bow ? chargedShot(f) : null;
        const owner = {
          cost: f.gameplay, victim: f.wildlife, loot: f.overflow, xp: f.mobs.experienceOrbs,
        }[sink];
        const original = f.coordinator.commit;
        let refusedParts;
        const veto = t.mock.method(f.coordinator, "commit", function (parts) {
          if (parts.some((part) => part.owner === f.gameplay) &&
              parts.some((part) => part.owner === f.wildlife)) {
            uniqueAttackOwners(f, parts);
            assert.equal(parts.filter((part) => part.owner === owner).length, 1);
            refusedParts = parts;
            return Reflect.apply(original, this, [parts.map((part) =>
              part.owner === owner ? { ...part, validate: () => false } : part)]);
          }
          return Reflect.apply(original, this, [parts]);
        });
        const before = combatState(f);
        if (bow) assert.equal(f.game.useActions.fireBow(shot), false);
        else f.game.primary(0.05, true);
        assert.ok(refusedParts);
        assert.deepEqual(combatState(f), before);
        veto.mock.restore();
        if (bow) assert.equal(f.game.useActions.fireBow(shot), true);
        else f.game.primary(0.05, true);
        assert.equal(f.wildlife.byId.has(f.mob.id), false);
        assert.equal(f.gameplay.getHandStack().durability, hand.durability - 1);
        assert.equal(f.gameplay.countPlain(ITEM.ARROW), bow ? 2 : 0);
        assert.equal(f.gameplay.exhaustion, bow ? 0 : 0.1);
        assert.ok(f.mobs.experienceOrbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0) > 0);
        assert.ok(f.overflow.size + f.game.pickups.serialize().items.length > 0);
        assert.deepEqual(f.progression.services.stations.serialize(), before.stations,
          "offense does not consume the Fortune/table/durability RNG streams");
        const paid = combatState(f);
        assert.equal(f.coordinator.commit(refusedParts).ok, false);
        if (bow) assert.equal(f.game.useActions.fireBow(shot), false);
        assert.deepEqual(combatState(f), paid);
      });
    }

test("actual archive restore continues worn gear, fractional Strength time and victim health without reapplying effects", async (t) => {
  const f = await combatFixture(t, "enderman");
  const hand = equip(f, { enchantments: { sharpness: 3 } });
  effect(f, "strength", 0, 40);
  f.game.primary(0.05, true);
  assert.equal(f.mob.health, 29);
  assert.equal(f.progression.frame(0.125).ok, true);
  const saved = f.snapshot();
  assert.equal(saved.progression.statusEffects.effects[0].remainingTicks, 38);
  assert.equal(saved.progression.statusEffects.tickRemainder, 0.5);
  const restored = await gameMobFixture(t, { saved, generatorFactory: combatBeach });
  const mob = restored.wildlife.byId.get(f.mob.id);
  assert.ok(mob);
  assert.equal(restored.gameplay.getHandStack().durability, hand.durability - 1);
  assert.deepEqual(restored.progression.services.effects.serialize(), saved.progression.statusEffects);
  approach(restored, mob);
  restored.game.primary(0.05, true);
  assert.equal(mob.health, 18);
  assert.equal(f.mob.health, 29, "a new Game never writes the source owner");
  const remaining = restored.progression.services.effects.serialize();
  restored.game.paused = true;
  const paused = combatState(restored);
  restored.frame(12);
  restored.game.primary(0.05, true);
  assert.deepEqual(combatState(restored), paused);
  assert.deepEqual(restored.progression.services.effects.serialize(), remaining);
  await restored.game.play();
  for (let i = 0; i < 8; i++) assert.equal(restored.progression.frame(0.25).ok, true);
  assert.equal(restored.progression.services.effects.hasActiveEffects, false);
  restored.game.elapsed += 0.51;
  approach(restored, mob);
  restored.game.primary(0.05, true);
  assert.equal(mob.health, 10, "only Sharpness remains after real status expiry");
  const continuation = restored.snapshot();
  const again = await gameMobFixture(t, { saved: continuation, generatorFactory: combatBeach });
  const last = again.wildlife.byId.get(mob.id);
  approach(again, last);
  again.game.primary(0.05, true);
  assert.equal(last.health, 2);
  assert.equal(again.gameplay.getHandStack().durability, hand.durability - 4);
  assert.equal(again.progression.services.effects.hasActiveEffects, false);
  t.diagnostic("actual health continuation 40→29→18→10→2; wear 4; Strength expires, Sharpness persists");
});

test("real dimension departure invalidates a held attack and a fresh restored resident receives current offense", async (t) => {
  const f = await combatFixture(t);
  const hand = equip(f, { enchantments: { sharpness: 3 } });
  effect(f);
  const plan = f.actions.prepareMelee(f.mob);
  uniqueAttackOwners(f, plan.participants);
  const oldWildlife = f.wildlife, epoch = f.world.epoch;
  const departure = await f.game.travel.teleport({ x: 40.5, y: 65, z: 40.5, dimension: "nether" });
  assert.equal(departure.ok, true, departure.message);
  assert.equal(oldWildlife.disposed, true);
  assert.ok(f.world.epoch > epoch);
  const away = combatState(f);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(combatState(f), away);
  const back = await f.game.travel.teleport({ x: 2.5, y: 65, z: 11, dimension: "overworld" });
  assert.equal(back.ok, true, back.message);
  await f.game.play();
  const mob = f.wildlife.byId.get(f.mob.id);
  assert.ok(mob);
  assert.equal(mob === f.mob, false);
  assert.equal(mob.health, 24);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  approach(f, mob);
  f.game.primary(0.05, true);
  assert.equal(mob.health, 13);
  assert.equal(f.mob.health, 24);
  assert.equal(f.gameplay.getHandStack().durability, hand.durability - 1);
});

for (const weapon of ["melee", "bow"]) {
  test(`real death/respawn retires old ${weapon} observations and clears Strength before a fresh attack`, async (t) => {
    const f = await combatFixture(t);
    const bow = weapon === "bow";
    const hand = equip(f, { bow, enchantments: bow ? { power: 3 } : { sharpness: 3 } });
    effect(f);
    const old = bow ? chargedShot(f) : f.actions.prepareMelee(f.mob);
    const life = f.projectiles.projectiles.life;
    assert.equal(f.gameplay.damage(1000, "fall"), 20);
    assert.equal(f.gameplay.dead, true);
    assert.equal(f.progression.services.effects.hasActiveEffects, false);
    assert.equal(f.projectiles.projectiles.life, life + 1);
    const dead = combatState(f);
    assert.equal(bow ? f.game.useActions.fireBow(old) : f.actions.commit(old).ok, false);
    assert.deepEqual(combatState(f), dead);
    const respawned = await f.game.travel.respawn();
    assert.equal(respawned.ok, true, respawned.message);
    await f.game.play();
    assert.equal(f.gameplay.dead, false);
    assert.equal(f.projectiles.projectiles.life, life + 2);
    assert.equal(f.progression.services.effects.hasActiveEffects, false);
    const alive = combatState(f);
    assert.equal(bow ? f.game.useActions.fireBow(old) : f.actions.commit(old).ok, false);
    assert.deepEqual(combatState(f), alive);
    const mob = f.wildlife.byId.get(f.mob.id);
    approach(f, mob);
    if (bow) assert.equal(f.game.useActions.fireBow(chargedShot(f)), true);
    else f.game.primary(0.05, true);
    assert.equal(mob.health, 16, "fresh Sharpness or Power applies, cleared Strength does not");
    assert.equal(f.gameplay.getHandStack().durability, hand.durability - 1);
  });
}
