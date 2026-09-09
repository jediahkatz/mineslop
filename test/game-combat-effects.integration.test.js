import assert from "node:assert/strict";
import test from "node:test";
import { meleeTargetFamily, observeMeleeAttack } from "../src/game-combat-effects.js";
import { getItem, ITEM } from "../src/items.js";
import {
  chargedShot, combatFixture, combatState, effect, equip, uniqueAttackOwners,
} from "./combat-effects-fixture.js";

for (const [kind, family, damage] of [
  ["zombie", "undead", 11], ["skeleton", "undead", 11],
  ["husk", "undead", 11], ["stray", "undead", 11], ["drowned", "undead", 11],
  ["horse", "other", 6], ["turtle", "other", 6],
  ["spider", "arthropod", 6], ["enderman", "other", 6],
]) {
  test(`actual primary applies Smite to the ${kind} family exactly once`, async (t) => {
    const f = await combatFixture(t, kind);
    const hand = equip(f, { enchantments: { smite: 2 } });
    assert.equal(meleeTargetFamily(kind), family);
    assert.equal(f.gameplay.attackDamage(), getItem(ITEM.IRON_SWORD).damage,
      "Gameplay retains its raw catalog attribute");
    const health = f.mob.health;
    f.game.primary(0.05, true);
    assert.equal(health - f.mob.health, damage);
    assert.equal(f.gameplay.getHandStack().durability, hand.durability - 1);
    assert.equal(f.gameplay.exhaustion, 0.1);
    assert.equal(f.gameplay.getState().experience.total, 0);
  });
}

for (const [status, amplifier, baseMultiplier, attackStrength, expected] of [
  ["strength", 0, 1.5, 1, 15.5],
  ["strength", 0, 0.6, 0.5, 6.4],
  ["weakness", 0, 1.5, 1, 5],
  ["weakness", 1, 1.5, 1, 2],
]) {
  test(`owned melee orders ${status} ${amplifier}, base scale ${baseMultiplier}, enchant strength ${attackStrength}`,
    async (t) => {
      const f = await combatFixture(t);
      const hand = equip(f, { enchantments: { sharpness: 3 } });
      effect(f, status, amplifier);
      // The supplied base scale represents the caller's charge/critical stage.
      // This tests the composition contract, not a new automatic critical hit.
      const before = combatState(f), health = f.mob.health;
      const plan = f.actions.prepareMelee(f.mob, { baseMultiplier, attackStrength });
      uniqueAttackOwners(f, plan.participants);
      assert.deepEqual(combatState(f), before, "projection/preparation cannot pay");
      assert.equal(f.actions.commit(plan).ok, true);
      assert.ok(Math.abs(health - f.mob.health - expected) < 1e-9);
      assert.equal(f.gameplay.getHandStack().durability, hand.durability - 1);
      assert.equal(f.gameplay.exhaustion, 0.1);
      assert.deepEqual(f.progression.services.effects.serialize(), before.effects);
      assert.deepEqual(f.progression.services.stations.serialize(), before.stations);
      const paid = combatState(f);
      assert.equal(f.actions.commit(plan).ok, false);
      assert.deepEqual(combatState(f), paid);
    });
}

for (const status of ["strength", "weakness"])
  for (const hand of ["main", "offhand"])
    for (const [seconds, expected] of [[1, 8], [0.4, 3]]) {
      test(`${hand} Power bow at ${seconds}s ignores ${status} and rounds only after charge`, async (t) => {
        const f = await combatFixture(t);
        // Distinct opposite-hand damage must never enter the bow calculation.
        equip(f, { enchantments: { smite: 2 } });
        const bow = equip(f, { bow: true, hand, enchantments: { power: 3 } });
        effect(f, status);
        const other = f.gameplay.getHandStack(hand === "main" ? "offhand" : "main");
        const before = combatState(f), health = f.mob.health;
        const shot = chargedShot(f, hand, seconds);
        assert.equal(f.game.useActions.fireBow(shot), true);
        assert.equal(health - f.mob.health, expected);
        assert.equal(f.gameplay.getHandStack(hand).durability, bow.durability - 1);
        assert.equal(f.gameplay.countPlain(ITEM.ARROW), 2);
        assert.deepEqual(f.gameplay.getHandStack(hand === "main" ? "offhand" : "main"), other);
        assert.deepEqual(f.progression.services.effects.serialize(), before.effects);
        const paid = combatState(f);
        assert.equal(f.game.useActions.fireBow(shot), false);
        assert.deepEqual(combatState(f), paid);
      });
    }

for (const kind of ["horse", "zombie", "spider", "turtle"]) {
  test(`${kind}: Power never turns no-arrow bow melee into a projectile`, async (t) => {
    const f = await combatFixture(t, kind);
    const bow = equip(f, { bow: true, enchantments: { power: 3 }, arrows: 0 });
    const health = f.mob.health, exhaustion = f.gameplay.exhaustion;
    f.game.primary(0.05, true);
    assert.equal(health - f.mob.health, 1);
    assert.deepEqual(f.gameplay.getHandStack(), bow);
    assert.equal(f.gameplay.countPlain(ITEM.ARROW), 0);
    assert.equal(f.gameplay.exhaustion, exhaustion);
  });

  test(`${kind}: final enchanted sword wear uses the paid source, not the now-empty hand`, async (t) => {
    const f = await combatFixture(t, kind);
    equip(f, { enchantments: { sharpness: 3 }, durability: 1 });
    effect(f);
    const health = f.mob.health;
    f.game.primary(0.05, true);
    assert.equal(health - f.mob.health, 11);
    assert.equal(f.gameplay.getHandStack(), null);
    assert.equal(f.gameplay.exhaustion, 0.1);
  });

  test(`${kind}: final Power bow wear still lands exactly one eight-damage shot`, async (t) => {
    const f = await combatFixture(t, kind);
    equip(f, { bow: true, enchantments: { power: 3 }, durability: 1 });
    const health = f.mob.health, shot = chargedShot(f);
    assert.equal(f.game.useActions.fireBow(shot), true);
    assert.equal(health - f.mob.health, 8);
    assert.equal(f.gameplay.getHandStack(), null);
    assert.equal(f.gameplay.countPlain(ITEM.ARROW), 2);
    const paid = combatState(f);
    assert.equal(f.game.useActions.fireBow(shot), false);
    assert.deepEqual(combatState(f), paid);
  });

  test(`${kind}: raw environmental hits never borrow the local player's outgoing bonuses`, async (t) => {
    const f = await combatFixture(t, kind);
    const hand = equip(f, { enchantments: { sharpness: 3 } });
    effect(f);
    const health = f.mob.health;
    if (kind === "turtle") {
      assert.equal(f.wildlife.damage(f.mob, 3, null, false).reason,
        "prepared-ecology-hit-required");
      assert.equal(f.mob.health, health, "unprepared ecology damage must remain refused");
    }
    const result = f.wildlife.context.hurt(f.mob, 3, null, false);
    assert.equal(result.damage, 3);
    assert.equal(health - f.mob.health, 3);
    assert.deepEqual(f.gameplay.getHandStack(), hand);
    assert.equal(f.gameplay.exhaustion, 0);
  });
}

test("invalid family/scaling refuses without changing actual owners", async (t) => {
  const f = await combatFixture(t);
  equip(f, { enchantments: { sharpness: 3 } });
  effect(f);
  const before = combatState(f);
  for (const [family, options] of [
    [undefined, {}], ["hostile", {}],
    ["other", { baseMultiplier: NaN }], ["other", { baseMultiplier: -1 }],
    ["other", { attackStrength: 1.1 }], ["other", { attackStrength: -0.1 }],
  ])
    assert.equal(observeMeleeAttack(f.game, family, options), null);
  assert.deepEqual(combatState(f), before);
});
