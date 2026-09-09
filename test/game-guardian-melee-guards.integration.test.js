import assert from "node:assert/strict";
import test from "node:test";
import { GameMobActions } from "../src/game-mob-actions.js";
import { armorItemId } from "../src/gear-content.js";
import { ITEM } from "../src/items.js";
import {
  chargedShot, effect, equip, uniqueAttackOwners,
} from "./combat-effects-fixture.js";
import {
  afterGuardianPayment, approachGuardian, guardianFixture, guardianState,
  guardianWall, observeGuardian,
} from "./game-guardian-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `expected ${expected}, got ${actual}`);
const edit = (f, change) => assert.equal(f.gameplay.inventoryTransaction((owned) => {
  change(owned);
  return true;
}), true);
const noReflection = (f, observed, health = 20) => {
  assert.equal(f.gameplay.health, health);
  assert.equal(observed.damage.mock.callCount(), 0);
};
const hitContext = (observed, index = 0) => observed.parts.mock.calls[index].arguments[3].hit;

test("direct melee context is immutable, unique across facades, detached and replay safe", async (t) => {
  const f = await guardianFixture(t), observed = observeGuardian(t, f);
  const before = guardianState(f);
  const first = f.actions.prepareMelee(f.mob);
  uniqueAttackOwners(f, first.participants);
  const firstHit = hitContext(observed);
  assert.deepEqual({ source: firstHit.source, kind: firstHit.kind },
    { source: "player", kind: "melee" });
  assert.equal(Object.isFrozen(firstHit), true);
  assert.ok(firstHit.id.length > 0 && firstHit.id.length <= 100);
  f.game.mobActions = new GameMobActions(f.game);
  const second = f.game.mobActions.prepareMelee(f.mob);
  uniqueAttackOwners(f, second.participants);
  assert.notEqual(hitContext(observed, 1).id, firstHit.id);
  assert.deepEqual(guardianState(f), before, "preparing identities must not edit any resource owner");
  assert.equal(observed.reflect.mock.callCount(), 0);
  assert.equal(f.game.mobActions.commit(first).ok, true);
  assert.equal(f.mob.health, 24);
  assert.equal(f.gameplay.health, 18);
  assert.equal(f.gameplay.getHandStack().durability, 249);
  const paid = guardianState(f);
  for (const plan of [first, second]) assert.equal(f.game.mobActions.commit(plan).ok, false);
  assert.deepEqual(guardianState(f), paid);
  assert.equal(observed.damage.mock.callCount(), 1);
});

for (const owner of ["gameplay", "wildlife"])
  test(`normal primary ${owner} veto neither pays nor reflects; immediate retry succeeds once`, async (t) => {
    const f = await guardianFixture(t), observed = observeGuardian(t, f);
    const commit = f.coordinator.commit;
    const veto = t.mock.method(f.coordinator, "commit", function (parts) {
      return commit.call(this, parts.some((part) => part.owner === f.wildlife)
        ? parts.map((part) => part.owner === f[owner] ? { ...part, validate: () => false } : part)
        : parts);
    });
    const before = guardianState(f);
    f.game.primary(0.05, true);
    assert.equal(observed.prepare.mock.callCount(), 1);
    assert.deepEqual(guardianState(f), before);
    assert.equal(observed.reflect.mock.callCount(), 0);
    noReflection(f, observed);
    veto.mock.restore();
    f.game.primary(0.05, true);
    assert.equal(f.mob.health, 24);
    assert.equal(f.gameplay.health, 18);
    assert.equal(f.gameplay.getHandStack().durability, 249);
    assert.equal(f.gameplay.exhaustion, 0.1);
    assert.equal(observed.damage.mock.callCount(), 1);
  });

const staleActions = [
  ["identical hand replacement", (f) => edit(f, (owned) => {
    owned.slots[f.gameplay.selected] = { ...owned.slots[f.gameplay.selected] };
  })],
  ["selection away and back", (f) => { f.gameplay.select(1); f.gameplay.select(0); }],
  ["equipment replacement", (f) => edit(f, (owned) => {
    owned.equipment.head = progressionStack(ITEM.IRON_HELMET);
  })],
  ["status revision", (f) => effect(f, "resistance")],
  ["player health", (f) => assert.equal(f.gameplay.damage(1, "fall"), 1)],
  ["player life", (f) => assert.equal(f.projectiles.cancel("respawn", { advanceLife: true }), true)],
  ["victim life", (f) => { f.mob.life++; }],
  ["victim dormancy", (f) => { f.mob.dormant = true; }],
  ["player movement", (f) => f.player.setPosition({ ...f.player.position, z: f.player.position.z + 8 })],
  ["blocked physical ray", guardianWall],
  ["world epoch", (f) => assert.equal(f.world.loadEdits(f.world.serialize()), true)],
  ["suspended ecology", (f) => assert.equal(f.ecology.suspend(), true)],
];
for (const [name, invalidate] of staleActions)
  test(`prepared guardian melee rejects stale ${name} before payment or reflection`, async (t) => {
    const f = await guardianFixture(t), observed = observeGuardian(t, f);
    const plan = f.actions.prepareMelee(f.mob);
    uniqueAttackOwners(f, plan.participants);
    invalidate(f);
    const before = guardianState(f);
    assert.equal(f.actions.commit(plan).ok, false);
    assert.deepEqual(guardianState(f), before);
    assert.equal(observed.reflect.mock.callCount(), 0);
    assert.equal(observed.damage.mock.callCount(), 0);
    assert.equal(f.mob.health, 30);
    assert.equal(f.gameplay.getHandStack().durability, 250);
  });

const postPayment = [
  ["retracted spikes", (f) => { f.mob.spikesExtended = 0.2; }],
  ["player outside spike range", (f) => f.player.setPosition({
    ...f.player.position, z: f.player.position.z + 8,
  })],
  ["blocked current LOS", guardianWall],
  ["player life replacement", (f) => assert.equal(f.projectiles.cancel("respawn", { advanceLife: true }), true)],
  ["victim life replacement", (f) => { f.mob.life++; }],
  ["victim dormancy", (f) => { f.mob.dormant = true; }],
  ["creative player", (f) => assert.equal(f.gameplay.setMode("creative"), true)],
  ["spawn protection", (f) => { f.wildlife.context.spawnProtected = true; }],
  ["world epoch replacement", (f) => assert.equal(f.world.loadEdits(f.world.serialize()), true)],
  ["ecology suspension", (f) => assert.equal(f.ecology.suspend(), true)],
  ["player death", (f) => assert.equal(f.gameplay.damage(1000, "fall"), 20), 0],
];
for (const [name, change, health = 20] of postPayment)
  test(`committed guardian melee skips reflection after ${name} during tool notification`, async (t) => {
    const f = await guardianFixture(t), observed = observeGuardian(t, f);
    const notified = afterGuardianPayment(t, f, change);
    f.game.primary(0.05, true);
    notified();
    assert.equal(f.mob.health, 24, "post-payment eligibility cannot undo the accepted base hit");
    assert.equal(f.gameplay.serialize().slots[0], null, "the survival sword was paid even after a mode change");
    noReflection(f, observed, health);
    const paid = guardianState(f);
    assert.equal(f.actions.commit(observed.prepare.mock.calls[0].result).ok, false);
    assert.deepEqual(guardianState(f), paid);
  });

test("death and respawn during payment cannot reflect into a replacement player at the original health", async (t) => {
  const f = await guardianFixture(t), observed = observeGuardian(t, f);
  const life = f.projectiles.projectiles.life;
  const notified = afterGuardianPayment(t, f, () => {
    assert.equal(f.gameplay.damage(1000, "fall"), 20);
    assert.equal(f.gameplay.dead, true);
    assert.equal(f.projectiles.projectiles.life, life + 1);
    assert.equal(f.gameplay.respawn(), true);
    assert.equal(f.gameplay.health, 20);
  });
  f.game.primary(0.05, true);
  notified();
  noReflection(f, observed);
  assert.equal(f.mob.health, 24);
});

test("the last sword use still reflects with fresh same-life health after payment", async (t) => {
  const f = await guardianFixture(t), observed = observeGuardian(t, f);
  const notified = afterGuardianPayment(t, f, () => {
    assert.equal(f.gameplay.damage(1, "fall"), 1);
  });
  f.game.primary(0.05, true);
  notified();
  assert.equal(f.mob.health, 24);
  assert.equal(f.gameplay.health, 17);
  assert.equal(f.gameplay.getHandStack(), null);
  assert.equal(observed.damage.mock.callCount(), 1);
});

for (const duringPayment of [false, true])
  test(`guardian spikes use real armor, Protection and Resistance ${duringPayment ? "changed during" : "present before"} payment`, async (t) => {
    const f = await guardianFixture(t), observed = observeGuardian(t, f);
    const armor = progressionStack(armorItemId("iron", "chest"), 1, { enchantments: { protection: 4 } });
    const equipDefense = () => {
      edit(f, (owned) => { owned.equipment.chest = armor; });
      effect(f, "resistance");
    };
    const notified = duringPayment ? afterGuardianPayment(t, f, equipDefense) : () => {};
    if (!duringPayment) equipDefense();
    const defense = t.mock.method(f.progression, "prepareDamage");
    f.game.primary(0.05, true);
    notified();
    uniqueAttackOwners(f, observed.prepare.mock.calls[0].result.participants);
    assert.equal(defense.mock.callCount(), 1);
    const { arguments: args, result: plan } = defense.mock.calls[0];
    assert.deepEqual(args, [2, "Guardian spikes", "thorns"]);
    assert.equal(plan.participants.filter((part) => part.owner === f.gameplay).length, 1);
    assert.equal(new Set(plan.participants.map((part) => part.owner)).size, plan.participants.length);
    close(f.gameplay.health, 20 - 1.0752);
    assert.equal(f.gameplay.getEquipmentStack("chest").durability, armor.durability - 1);
    assert.equal(f.gameplay.getHandStack()?.durability ?? null, duringPayment ? null : 249);
    assert.equal(f.gameplay.exhaustion, 0.1);
    assert.equal(f.mob.health, 24, "the thorns classification must not recursively hit the guardian");
    assert.equal(observed.damage.mock.callCount(), 1);
  });

test("refused player defense transaction never falls back to raw damage or repeats the accepted sword hit", async (t) => {
  const f = await guardianFixture(t), observed = observeGuardian(t, f);
  edit(f, (owned) => { owned.equipment.chest = progressionStack(armorItemId("iron", "chest")); });
  const armor = f.gameplay.getEquipmentStack("chest");
  const random = f.progression.services.stations.randomState;
  const commit = f.coordinator.commit;
  t.mock.method(f.coordinator, "commit", function (parts) {
    const reflection = parts.some((part) => part.owner === f.gameplay) &&
      !parts.some((part) => part.owner === f.wildlife);
    return commit.call(this, reflection ? parts.map((part) =>
      part.owner === f.gameplay ? { ...part, validate: () => false } : part) : parts);
  });
  f.game.primary(0.05, true);
  assert.equal(f.mob.health, 24);
  assert.equal(f.gameplay.getHandStack().durability, 249);
  assert.equal(f.gameplay.health, 20);
  assert.deepEqual(f.gameplay.getEquipmentStack("chest"), armor);
  assert.equal(f.progression.services.stations.randomState, random);
  assert.equal(observed.damage.mock.callCount(), 1);
  const paid = guardianState(f);
  assert.equal(f.actions.commit(observed.prepare.mock.calls[0].result).ok, false);
  assert.deepEqual(guardianState(f), paid);
  assert.equal(observed.damage.mock.callCount(), 1);
});

for (const hand of ["main", "offhand"])
  test(`${hand} charged bow damages the close guardian without melee reflection`, async (t) => {
    const f = await guardianFixture(t), observed = observeGuardian(t, f);
    const bow = equip(f, { bow: true, hand });
    const shot = chargedShot(f, hand);
    assert.equal(f.game.useActions.fireBow(shot), true);
    assert.equal(f.mob.health, 26);
    assert.equal(f.gameplay.getHandStack(hand).durability, bow.durability - 1);
    assert.equal(f.gameplay.countPlain(ITEM.ARROW), 2);
    assert.equal(hitContext(observed), undefined);
    assert.equal(observed.reflect.mock.callCount(), 0);
    noReflection(f, observed);
    const paid = guardianState(f);
    assert.equal(f.game.useActions.fireBow(shot), false);
    assert.deepEqual(guardianState(f), paid);
  });

test("a physical bow bash remains melee, independent of arrow availability or Power", async (t) => {
  const f = await guardianFixture(t), observed = observeGuardian(t, f);
  const bow = equip(f, { bow: true, enchantments: { power: 3 }, arrows: 0 });
  f.game.primary(0.05, true);
  assert.equal(f.mob.health, 29);
  assert.equal(f.gameplay.health, 18);
  assert.deepEqual(f.gameplay.getHandStack(), bow);
  assert.equal(f.gameplay.exhaustion, 0);
  assert.equal(observed.damage.mock.callCount(), 1);
});

for (const direct of [false, true])
  test(`${direct ? "unclassified Game hit" : "environmental ecology damage"} does not acquire melee credit from proximity`, async (t) => {
    const f = await guardianFixture(t), observed = observeGuardian(t, f);
    const result = direct ? f.actions.hit(f.mob, 3)
      : f.wildlife.context.hurt(f.mob, 3, null, false);
    assert.equal(result.damage, 3);
    assert.equal(f.mob.health, 27);
    assert.equal(hitContext(observed), undefined);
    assert.equal(observed.reflect.mock.callCount(), 0);
    noReflection(f, observed);
  });

for (const kind of ["projectile", "explosion", "thorns"])
  test(`explicit ${kind} hit metadata cannot activate the melee reflection consumer`, async (t) => {
    const f = await guardianFixture(t), observed = observeGuardian(t, f);
    const plan = f.ecology.prepareHit(f.mob.id, 3, null, {
      playerKill: true, validate: () => true,
      hit: { id: `guardian-${kind}-control`, source: "player", kind },
    });
    assert.ok(plan);
    assert.equal(f.ecology.commit(plan).ok, true);
    assert.equal(f.mob.health, 27);
    noReflection(f, observed);
  });

for (const refusal of ["environment", "no-retaliation"])
  test(`${refusal} suppresses even supplied player-melee metadata`, async (t) => {
    const f = await guardianFixture(t), observed = observeGuardian(t, f);
    const options = {
      playerKill: true, validate: () => true, retaliate: refusal !== "no-retaliation",
      hit: { id: `guardian-${refusal}-control`, source: "player", kind: "melee" },
    };
    const result = refusal === "environment" ? f.ecology.hurt(f.mob, 3, null, options)
      : f.ecology.commit(f.ecology.prepareHit(f.mob.id, 3, null, options));
    assert.equal(result.damage, 3);
    assert.equal(f.mob.health, 27);
    noReflection(f, observed);
  });

test("zero effective primary damage cannot pay or reflect", async (t) => {
  const f = await guardianFixture(t), observed = observeGuardian(t, f);
  effect(f, "weakness", 1);
  const before = guardianState(f);
  f.game.primary(0.05, true);
  assert.deepEqual(guardianState(f), before);
  assert.equal(observed.parts.mock.callCount(), 0);
  noReflection(f, observed);
});

test("a lethal normal sword hit removes the guardian without postmortem reflection", async (t) => {
  const f = await guardianFixture(t);
  assert.equal(f.ecology.hurt(f.mob, 24, null, { retaliate: false }).damage, 24);
  const observed = observeGuardian(t, f);
  f.game.primary(0.05, true);
  assert.equal(f.mob.dead, true);
  assert.equal(f.wildlife.byId.has(f.mob.id), false);
  assert.equal(f.gameplay.getHandStack().durability, 249);
  assert.equal(observed.reflect.mock.callCount(), 0);
  noReflection(f, observed);
});

test("native elder guardian also reflects through the same normal primary path", async (t) => {
  const f = await guardianFixture(t, "elder_guardian"), observed = observeGuardian(t, f);
  const health = f.mob.health;
  f.game.primary(0.05, true);
  assert.equal(f.mob.health, health - 6);
  assert.equal(f.gameplay.health, 18);
  assert.equal(observed.damage.mock.callCount(), 1);
});

test("a new direct melee hit reflects again after the existing spike cooldown expires", async (t) => {
  const f = await guardianFixture(t), observed = observeGuardian(t, f);
  f.game.primary(0.05, true);
  assert.equal(f.gameplay.health, 18);
  f.ecology._syncPlayer();
  for (let i = 0; i < 8; i++) f.ecology.stepMob(f.mob, 0.05);
  approachGuardian(f);
  f.mob.spikesExtended = 1;
  f.game.elapsed += 0.5;
  f.game.primary(0.05, true);
  assert.equal(f.mob.health, 18);
  assert.equal(f.gameplay.health, 16);
  assert.equal(observed.damage.mock.callCount(), 2);
  assert.notEqual(hitContext(observed).id, hitContext(observed, 1).id);
});
