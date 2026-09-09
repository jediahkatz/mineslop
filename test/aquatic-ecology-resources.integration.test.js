import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ecologyDeathReward } from "../src/expansion-ecology.js";
import {
  EXPERIENCE_ORB_LIFETIME, MAX_EXPERIENCE_ORBS, MAX_ORB_EXPERIENCE,
} from "../src/experience-orbs.js";
import { ITEM } from "../src/items.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import {
  combatBeach, combatFixture, combatOcean, combatState, equip, uniqueAttackOwners,
} from "./combat-effects-fixture.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { attackLootMob } from "./game-mob-loot-acquisition-fixture.js";

const loose = (f) => f.game.pickups.serialize().items.map(({ id, count }) => ({ id, count }));
const retained = (f) => f.overflow.serialize().entries.map(({ id, count }) => ({ id, count }));
const xp = (f) => f.game.experienceOrbs.serialize().orbs.reduce((total, orb) => total + orb.amount, 0);
function quote(f, playerKill = true) {
  const state = f.ecology.ecology.state(f.mob.id);
  const reward = ecologyDeathReward(f.mob.kind, playerKill, {
    seed: f.world.seed, generatorVersion: f.world.generatorVersion,
    dimension: f.world.dimension, id: f.mob.id,
    baby: f.mob.kind === "turtle" && !state.scuteClaimed,
  });
  return {
    drops: reward.drops.map(({ name, count }) => ({ id: ITEM[name] ?? BLOCK[name], count })),
    experience: reward.experience,
  };
}

// Finite authored equipment/health and valid authored habitat exercise the
// actual Game owner graph. These tests do not claim native acquisition.
for (const kind of ["drowned", "dolphin", "turtle"]) {
  for (const weapon of ["melee", "bow"])
    test(`${kind} Game ${weapon} death commits its per-resident resource quote and payment once`, async (t) => {
      const f = await combatFixture(t, kind);
      f.mob.health = 1;
      equip(f, { bow: weapon === "bow" });
      const before = combatState(f), expected = quote(f), rng = f.wildlife.randomState;
      attackLootMob(f, f.mob, weapon);
      assert.equal(f.mob.dead, true);
      assert.equal(f.wildlife.byId.has(f.mob.id), false);
      assert.equal(f.ecology.ecology.state(f.mob.id).alive, false);
      assert.equal(f.wildlife.killed.has(f.mob.id), false, "Ecology keeps its permanent identity owner");
      assert.deepEqual(retained(f), expected.drops, "the Ecology receipt retains every item before presentation");
      f.overflow.flush(f.world, f.game.pickups);
      assert.deepEqual(loose(f), expected.drops, "the real receiver presents those retained items");
      assert.deepEqual(retained(f), []);
      assert.equal(xp(f), expected.experience);
      assert.equal(f.gameplay.getHandStack().durability, before.gameplay.slots[0].durability - 1);
      assert.equal(f.wildlife.randomState, rng);
      assert.deepEqual(f.progression.services.effects.serialize(), before.effects);
      assert.equal(loose(f).some((drop) => drop.id === ITEM.SCUTE || drop.id === ITEM.NAUTILUS_SHELL), false);
      const committed = combatState(f);
      assert.equal(f.game.hitMob(f.mob, 100).ok, false);
      assert.equal(f.wildlife.damage(f.mob, 100).hit, false);
      assert.deepEqual(combatState(f), committed);
    });

  test(`${kind} environmental death retains the same base material without player credit`, async (t) => {
    const f = await combatFixture(t, kind);
    equip(f);
    const expected = quote(f, false), before = combatState(f), rng = f.wildlife.randomState;
    assert.equal(f.wildlife.damage(f.mob, 1000, null, false).hit, false,
      "legacy Wildlife damage cannot bypass the ecology borrower");
    assert.deepEqual(combatState(f), before);
    assert.equal(f.ecology.hurt(f.mob, 1000, null, { retaliate: false }).killed, true);
    assert.deepEqual(retained(f), expected.drops);
    assert.equal(xp(f), 0);
    assert.equal(retained(f).some((drop) => drop.id === ITEM.COPPER_INGOT), false);
    assert.deepEqual(f.gameplay.serialize(), before.gameplay);
    assert.equal(f.wildlife.randomState, rng);
    assert.deepEqual(f.progression.services.effects.serialize(), before.effects);
  });

  test(`${kind} every participating owner can veto death without losing or rerolling resources`, async (t) => {
    const f = await combatFixture(t, kind);
    f.mob.health = 1;
    equip(f);
    const before = combatState(f), expected = quote(f);
    const plan = f.actions.prepareMelee(f.mob);
    uniqueAttackOwners(f, plan.participants);
    const owners = new Set(plan.participants.map((part) => part.owner));
    assert.deepEqual(owners, new Set([
      f.gameplay, f.wildlife, f.ecology.ecology, f.game.experienceOrbs,
      ...(expected.drops.length ? [f.overflow] : []),
    ]));
    assert.deepEqual(combatState(f), before);
    for (const owner of owners) {
      const retry = f.actions.prepareMelee(f.mob);
      const veto = { ...retry, participants: retry.participants.map((part) =>
        part.owner === owner ? { ...part, validate: () => false } : part) };
      assert.equal(f.actions.commit(veto).ok, false);
      assert.deepEqual(combatState(f), before);
      assert.deepEqual(quote(f), expected);
    }
    const retry = f.actions.prepareMelee(f.mob);
    assert.equal(f.actions.commit(retry).ok, true);
    assert.deepEqual(retained(f), expected.drops);
    assert.equal(xp(f), expected.experience);
    const committed = combatState(f);
    assert.equal(f.actions.commit(retry).ok, false);
    assert.deepEqual(combatState(f), committed);
  });

  test(`${kind} cold file restore keeps dead identity, material, XP, wear and clocks exact`, async (t) => {
    const f = await combatFixture(t, kind);
    f.mob.health = 1;
    equip(f);
    attackLootMob(f, f.mob);
    const saved = f.snapshot();
    const restored = await gameMobFixture(t, {
      saved: parseWorldFile(exportWorldFile(saved)),
      generatorFactory: kind === "turtle" ? combatBeach : combatOcean,
    });
    const reloaded = restored.snapshot();
    assert.deepEqual(Object.keys(reloaded).sort(), Object.keys(saved).sort());
    for (const key of Object.keys(saved).filter((key) => !["player", "fluids"].includes(key)))
      assert.deepEqual(reloaded[key], saved[key], key);
    const fluidResources = (fluids) => ({
      ...fluids,
      dimensions: fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
    });
    assert.deepEqual(fluidResources(reloaded.fluids), fluidResources(saved.fluids),
      "resident scan metadata may change; saved fluid resources and clock cannot");
    assert.equal(restored.wildlife.byId.has(f.mob.id), false);
    assert.equal(restored.ecology.ecology.state(f.mob.id).alive, false);
  });
}

for (const kind of ["cod", "squid", "drowned", "dolphin", "turtle"])
  test(`${kind} a genuinely full XP pool refuses its last-durability strike until capacity returns`, async (t) => {
    const f = await combatFixture(t, kind);
    f.mob.health = 1;
    equip(f, { durability: 1 });
    const orbs = f.game.experienceOrbs;
    assert.equal(orbs.spawn(MAX_EXPERIENCE_ORBS * MAX_ORB_EXPERIENCE, {
      x: f.mob.position.x + 3, y: f.mob.position.y + 0.5, z: f.mob.position.z,
    }), true);
    assert.equal(orbs.size, MAX_EXPERIENCE_ORBS);
    const before = combatState(f);
    for (let attempt = 0; attempt < 3; attempt++) {
      attackLootMob(f, f.mob);
      assert.deepEqual(combatState(f), before);
      assert.equal(f.mob.dead, false);
      assert.equal(f.gameplay.getHandStack().durability, 1);
    }
    // A scoped lifetime boundary, not a claim of several minutes of played time.
    // Expiration uses the real owner and does not collect artificial XP.
    orbs.update(EXPERIENCE_ORB_LIFETIME + 1, EXPERIENCE_ORB_LIFETIME + 1,
      f.player.position, f.gameplay);
    assert.equal(orbs.size, 0);
    assert.equal(f.gameplay.getState().experience.total, 0);
    attackLootMob(f, f.mob);
    assert.equal(f.mob.dead, true);
    assert.equal(f.gameplay.getHandStack(), null, "one successful strike breaks the one-wear tool");
    assert.ok(xp(f) > 0);
  });
