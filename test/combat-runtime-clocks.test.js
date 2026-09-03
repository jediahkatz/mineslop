import assert from "node:assert/strict";
import test from "node:test";
import { advanceCombatCredit, advanceHurtWindow } from "../src/combat-rules.js";
import { combatRuntimeFixture, runtimeHealthPeer } from "./combat-runtime-fixture.js";

function hit(f, health, provenance, victim = f.target) {
  const batch = f.runtime.begin();
  const quote = batch.quoteHit({
    victim, provenance, difficulty: f.difficulty.value,
    validate: f.guard(victim, ...(provenance.attackKind === "fire_tick" ? [] : [provenance.responsible])),
  });
  const owner = health.prepare(quote);
  assert.equal(batch.acceptHit(quote, owner).ok, true);
  f.commit(batch.finalize({ participants: owner.participants }));
  return quote;
}

test("data-owner scope: Easy full 8→10 becomes 5→6, then the hurt-window pre-armor delta is one", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  f.difficulty.value = "easy";
  f.difficulty.revision++;
  const first = hit(f, health, f.provenance("melee", { rawDamage: 8 }));
  assert.equal(first.adjusted.difficultyAdjustedFullDamage, 5);
  assert.equal(health.gameplay.health, 15);
  f.advance(0.1);
  const second = hit(f, health, f.provenance("melee", { rawDamage: 10 }));
  assert.equal(second.adjusted.difficultyAdjustedFullDamage, 6);
  assert.equal(second.preArmorDamage, 1);
  assert.equal(health.gameplay.health, 14);
  assert.equal(f.runtime.actor(f.target).hurt.difficultyAdjustedFullDamage, 6);
  assert.equal(f.runtime.actor(f.target).hurt.elapsedSeconds, 0.1);
  const weaker = f.runtime.begin(), quote = weaker.quoteHit({
    victim: f.target, provenance: f.provenance("melee", { rawDamage: 9 }),
    difficulty: "easy", validate: f.guard(f.source, f.target),
  });
  assert.equal(quote.preArmorDamage, 0);
  assert.equal(weaker.acceptHit(quote, health.prepare(quote)).ok, false);
  assert.equal(weaker.finalize().ok, false);
  assert.equal(health.gameplay.health, 14);
  f.advance(0.4);
  assert.equal(f.runtime.actor(f.target).hurt, null);
  assert.equal(hit(f, health, f.provenance("melee", { rawDamage: 2 })).preArmorDamage, 2);
});

test("runtime delegates hurt and credit clocks to pure helpers under admitted-dt partitions", (t) => {
  for (const partition of [[5], [2.5, 2.5], [0.13, 0.17, 4.7], Array(100).fill(0.05), Array(5000).fill(0.001)]) {
    const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
    hit(f, health, f.provenance("melee", {
      responsibleSpecies: "wolf", playerOwnerId: "local-player", rawDamage: 1,
    }));
    let expectedHurt = f.runtime.actor(f.target).hurt;
    let expectedCredit = f.runtime.actor(f.target).credit;
    assert.equal(expectedCredit.playerOwnerId, "local-player");
    for (const dt of partition) {
      expectedHurt = advanceHurtWindow(expectedHurt, dt);
      expectedCredit = advanceCombatCredit(expectedCredit, dt);
      f.advance(dt);
      assert.deepEqual(f.runtime.actor(f.target).hurt, expectedHurt);
      assert.deepEqual(f.runtime.actor(f.target).credit, expectedCredit);
    }
    assert.equal(expectedHurt, null);
    assert.equal(expectedCredit, null);
  }
  for (const partition of [[0.5], [0.25, 0.25], [0.13, 0.17, 0.2], Array(10).fill(0.05), Array(500).fill(0.001)]) {
    const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
    hit(f, health, f.provenance("melee", { rawDamage: 1 }));
    for (let index = 0; index < partition.length; index++) {
      f.advance(partition[index]);
      if (index < partition.length - 1) assert.notEqual(f.runtime.actor(f.target).hurt, null);
    }
    assert.equal(f.runtime.actor(f.target).hurt, null);
  }
});

test("uncredited damage and DoT neither erase nor refresh stable five-second reward credit", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  hit(f, health, f.provenance("melee", {
    responsibleSpecies: "wolf", playerOwnerId: "local-player", rawDamage: 1,
  }));
  f.advance(2);
  const credit = f.runtime.actor(f.target).credit;
  hit(f, health, f.provenance("melee", { rawDamage: 1 }));
  assert.deepEqual(f.runtime.actor(f.target).credit, credit);
  hit(f, health, f.provenance("fire_tick", {
    responsibleSpecies: "wolf", playerOwnerId: "local-player", rawDamage: 2,
  }));
  assert.deepEqual(f.runtime.actor(f.target).credit, credit);
  f.advance(3);
  assert.equal(f.runtime.actor(f.target).credit, null);
});

test("explicit player-owner provenance also earns credit without copying player pose or hand state", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  hit(f, health, f.provenance("melee", {
    responsible: f.target, responsibleSpecies: null, playerOwnerId: "local-player", rawDamage: 1,
  }), f.source);
  assert.equal(f.runtime.actor(f.source).credit.playerOwnerId, "local-player");
  const nextLife = { ...f.target, life: f.target.life + 1 };
  f.sync([f.source, nextLife]);
  assert.equal(f.runtime.actor(f.source).credit.playerOwnerId, "local-player",
    "reward ownership does not become the player's new attack life or pose");
});

test("zero admitted time and read-only views/saves freeze clocks, ages and token identity", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  hit(f, health, f.provenance("melee", {
    responsibleSpecies: "wolf", playerOwnerId: "local-player", rawDamage: 1,
  }));
  const shot = f.launch("blaze_fireball"), blast = f.blast();
  f.advance(0.1);
  const before = { shots: f.runtime.shots, blasts: f.runtime.blasts, actors: f.runtime.actors };
  const revision = f.runtime.revision;
  for (let index = 0; index < 30; index++) {
    f.advance(0);
    f.world.serialize();
    health.gameplay.getState();
    JSON.stringify([f.runtime.shots, f.runtime.blasts, f.runtime.actors]);
  }
  assert.deepEqual({ shots: f.runtime.shots, blasts: f.runtime.blasts, actors: f.runtime.actors }, before);
  assert.equal(f.runtime.revision, revision);
  assert.equal(f.runtime.shot(shot).ticket, shot);
  assert.equal(f.runtime.blast(blast).ticket, blast);
});

test("six-second shots, three-second blaze and one-second blast deadlines do not depend on partition size", (t) => {
  for (const partition of [[6], [3, 3], Array(120).fill(0.05), Array(600).fill(0.01)]) {
    const f = combatRuntimeFixture(t);
    const arrow = f.launch(), blaze = f.launch("blaze_fireball"), blast = f.blast();
    for (const dt of partition) f.advance(dt);
    assert.equal(f.runtime.shot(arrow), null);
    assert.equal(f.runtime.shot(blaze), null);
    assert.equal(f.runtime.blast(blast), null);
  }
  const f = combatRuntimeFixture(t);
  const arrow = f.launch(), blaze = f.launch("blaze_fireball"), blast = f.blast();
  f.advance(1 - 1e-9);
  assert.notEqual(f.runtime.blast(blast), null);
  f.advance(1e-9);
  assert.equal(f.runtime.blast(blast), null);
  f.advance(2);
  assert.equal(f.runtime.shot(blaze), null);
  assert.notEqual(f.runtime.shot(arrow), null);
  f.advance(3);
  assert.equal(f.runtime.shot(arrow), null);
});

test("invalid and duplicate admitted-dt contributions cannot publish earlier staged work", (t) => {
  const f = combatRuntimeFixture(t);
  for (const dt of [-1, NaN, Infinity, null, undefined, "0.1"]) {
    const batch = f.runtime.begin();
    assert.equal(batch.launch(f.shotSpec()).ok, true);
    assert.equal(batch.advanceClocks(dt, { validate: f.guard() }).ok, false);
    assert.equal(batch.finalize().ok, false);
  }
  const batch = f.runtime.begin();
  assert.equal(batch.launch(f.shotSpec()).ok, true);
  assert.equal(batch.advanceClocks(0.1, { validate: f.guard() }).ok, true);
  assert.equal(batch.advanceClocks(0.1, { validate: f.guard() }).ok, false);
  assert.equal(batch.finalize().ok, false);
  assert.equal(f.runtime.shots.length, 0);
});

test("fixed Peaceful policy suppresses mob-owned fire while environmental fire remains distinct and unscaled", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  f.difficulty.value = "peaceful";
  f.difficulty.revision++;
  const mob = f.runtime.begin(), suppressed = mob.quoteHit({
    victim: f.target, provenance: f.provenance("fire_tick", { rawDamage: 2 }),
    difficulty: "peaceful", validate: f.guard(f.target),
  });
  assert.equal(suppressed.adjusted.suppressed, true);
  assert.equal(suppressed.preArmorDamage, 0);
  assert.equal(mob.acceptHit(suppressed, health.prepare(suppressed)).ok, false);
  assert.equal(mob.finalize().ok, false);
  assert.equal(f.runtime.actor(f.target).hurt, null);
  const environmental = hit(f, health, f.provenance("fire_tick", {
    responsible: null, responsibleSpecies: null, rawDamage: 2,
  }));
  assert.equal(environmental.adjusted.suppressed, false);
  assert.equal(environmental.adjusted.scaling, "none");
  assert.equal(environmental.preArmorDamage, 2);
  assert.equal(health.gameplay.health, 18);
  assert.equal(f.runtime.actor(f.target).credit, null);
});

test("actual immune owner results do not establish hurt or credit and do not silently consume contact", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  const effects = health.effects.prepare({
    version: 1, tickRemainder: 0,
    effects: [{ id: "fire_resistance", amplifier: 0, remainingTicks: 100 }],
  });
  assert.ok(effects);
  assert.equal(f.coordinator.commit([effects]).ok, true);
  const ticket = f.pending("blaze_fireball"), batch = f.runtime.begin();
  const quote = batch.quoteContact(ticket, {
    difficulty: "normal", readCandidates: f.readCandidates, validate: f.guard(f.target),
  });
  const immune = health.prepare(quote);
  assert.equal(immune.result.damage, 0);
  assert.equal(batch.acceptHit(quote, immune).reason, "damaging-owner-result-required");
  assert.equal(batch.finalize().ok, false);
  assert.equal(f.runtime.actor(f.target).hurt, null);
  assert.equal(f.runtime.actor(f.target).credit, null);
  assert.notEqual(f.runtime.shot(ticket), null);
  assert.equal(health.gameplay.health, 20);
});
