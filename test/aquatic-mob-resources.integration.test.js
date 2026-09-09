import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ingredientMobLoot } from "../src/ingredient-mob-loot.js";
import { ITEM } from "../src/items.js";
import { combatFixture, combatOcean, combatState, equip, uniqueAttackOwners } from "./combat-effects-fixture.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { attackLootMob, constrainLootRetention } from "./game-mob-loot-acquisition-fixture.js";

const loose = (f) => f.game.pickups.serialize().items.map(({ id, count }) => ({ id, count }));
const xp = (f) => f.game.experienceOrbs.serialize().orbs.reduce((total, orb) => total + orb.amount, 0);
const rewardIds = { cod: ITEM.RAW_COD, squid: ITEM.INK_SAC };

// Authored ocean, victim health and finite equipment isolate real Game input
// and owner transactions. Native habitat/acquisition is verified separately.
for (const kind of ["cod", "squid"]) {
  for (const weapon of ["melee", "bow"])
    test(`${kind} normal Game ${weapon} retains its whole resource and XP with one payment`, async (t) => {
      const f = await combatFixture(t, kind);
      f.mob.health = 1;
      equip(f, { bow: weapon === "bow" });
      const hand = f.gameplay.getHandStack(), rng = f.wildlife.randomState;
      const effects = f.progression.services.effects.serialize();
      const arrows = f.gameplay.countPlain(ITEM.ARROW);
      attackLootMob(f, f.mob, weapon);
      assert.equal(f.mob.dead, true);
      assert.equal(f.wildlife.byId.has(f.mob.id), false);
      assert.equal(f.wildlife.killed.has(f.mob.id), true);
      assert.equal(f.gameplay.getHandStack().durability, hand.durability - 1);
      assert.equal(f.gameplay.countPlain(ITEM.ARROW), arrows - (weapon === "bow" ? 1 : 0));
      assert.equal(loose(f).length, 1, "normal input must create retained aquatic material");
      assert.equal(loose(f)[0].id, rewardIds[kind]);
      const quote = ingredientMobLoot(f.world, f.mob, true);
      assert.deepEqual(loose(f), quote.drops);
      assert.equal(xp(f), quote.experience);
      assert.equal(f.wildlife.randomState, rng, "loot preparation cannot consume motion RNG");
      assert.deepEqual(f.progression.services.effects.serialize(), effects);
      const committed = combatState(f);
      assert.equal(f.game.hitMob(f.mob, 100).hit, false);
      assert.equal(f.wildlife.damage(f.mob, 100).hit, false);
      assert.deepEqual(combatState(f), committed, "the retired identity cannot pay twice");
    });

  test(`${kind} environmental death keeps material but cannot mint player XP or wear`, async (t) => {
    const f = await combatFixture(t, kind);
    equip(f);
    const before = combatState(f), rng = f.wildlife.randomState;
    const quote = ingredientMobLoot(f.world, f.mob, false);
    const hit = f.wildlife.damage(f.mob, 100, null, false);
    assert.equal(hit.killed, true);
    assert.equal(hit.provenance, "environment");
    assert.equal(loose(f)[0]?.id, rewardIds[kind]);
    assert.deepEqual(loose(f), quote.drops);
    assert.equal(xp(f), 0);
    assert.deepEqual(f.gameplay.serialize(), before.gameplay);
    assert.deepEqual(f.progression.services.effects.serialize(), before.effects);
    assert.equal(f.wildlife.randomState, rng);
  });

  for (const owner of ["gameplay", "overflow", "experienceOrbs", "wildlife"])
    test(`${kind} ${owner} veto leaves victim, hand, loot, XP and RNG intact; retry pays once`, async (t) => {
      const f = await combatFixture(t, kind);
      f.mob.health = 1;
      equip(f);
      const before = combatState(f);
      const plan = f.actions.prepareMelee(f.mob);
      uniqueAttackOwners(f, plan.participants);
      assert.deepEqual(new Set(plan.participants.map((part) => part.owner)), new Set([
        f.gameplay, f.overflow, f.game.experienceOrbs, f.wildlife,
      ]));
      assert.deepEqual(combatState(f), before, "preparation cannot publish any owner");
      const veto = { ...plan, participants: plan.participants.map((part) =>
        part.owner === f.game[owner] ? { ...part, validate: () => false } : part) };
      assert.equal(f.actions.commit(veto).ok, false);
      assert.deepEqual(combatState(f), before);
      const retry = f.actions.prepareMelee(f.mob);
      assert.deepEqual(retry.result.drops, plan.result.drops);
      assert.equal(f.actions.commit(retry).ok, true);
      const committed = combatState(f);
      assert.equal(f.actions.commit(retry).ok, false);
      assert.deepEqual(combatState(f), committed);
    });

  for (const denial of ["records", "budget"])
    test(`${kind} real ${denial} exhaustion refuses both normal player and environmental kills`, async (t) => {
      const f = await combatFixture(t, kind);
      f.mob.health = 1;
      equip(f);
      constrainLootRetention(t, f, f.mob, denial);
      const before = combatState(f);
      attackLootMob(f, f.mob);
      assert.deepEqual(combatState(f), before);
      assert.equal(f.wildlife.damage(f.mob, 100, null, false).hit, false);
      assert.deepEqual(combatState(f), before);
    });

  test(`${kind} cold archive before/after physical pickup preserves reward and dead identity`, async (t) => {
    const f = await combatFixture(t, kind);
    f.mob.health = 1;
    equip(f);
    const alive = f.snapshot();
    const restoredAlive = await gameMobFixture(t, { saved: alive, generatorFactory: combatOcean });
    assert.deepEqual(restoredAlive.snapshot().mobs, alive.mobs);
    attackLootMob(f, f.mob);
    const quote = ingredientMobLoot(f.world, f.mob, true);
    assert.ok(quote?.drops[0]?.count > 0);
    const dead = f.snapshot();
    const restored = await gameMobFixture(t, { saved: dead, generatorFactory: combatOcean });
    for (const key of ["mobs", "mobStates", "mobsByDimension", "overflow", "pickups", "experienceOrbs", "gameplay"])
      assert.deepEqual(restored.snapshot()[key], dead[key], key);
    assert.equal(restored.wildlife.byId.has(f.mob.id), false);
    assert.equal(restored.wildlife.killed.has(f.mob.id), true);
    restored.game.pickups.update(0.25, 0, f.mob.position, restored.gameplay);
    assert.equal(restored.gameplay.countPlain(rewardIds[kind]), quote.drops[0].count);
    assert.equal(loose(restored).length, 0);
    const collected = restored.snapshot();
    const again = await gameMobFixture(t, { saved: collected, generatorFactory: combatOcean });
    assert.equal(again.gameplay.countPlain(rewardIds[kind]), quote.drops[0].count);
    assert.equal(again.wildlife.byId.has(f.mob.id), false);
    assert.equal(again.wildlife.killed.has(f.mob.id), true);
    assert.deepEqual(again.snapshot().pickups, collected.pickups);
    assert.equal(again.gameplay.countPlain(BLOCK.COBBLESTONE), 0);
  });
}
