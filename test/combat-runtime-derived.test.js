import assert from "node:assert/strict";
import test from "node:test";
import { combatRuntimeFixture, runtimeHealthPeer } from "./combat-runtime-fixture.js";

const reflection = (f, changes = {}) => ({
  provenance: f.provenance("guardian_thorns", { responsibleSpecies: "guardian", rawDamage: 1 }),
  victim: f.target, ttl: 0.5, validate: f.guard(f.source, f.target), ...changes,
});

function originatingHit(f, health, amount, batch = f.runtime.begin()) {
  const quote = batch.quoteHit({
    victim: f.source,
    provenance: f.provenance("melee", {
      responsible: f.target, responsibleSpecies: null, playerOwnerId: "local-player", rawDamage: amount,
    }),
    difficulty: "normal", validate: f.guard(f.source, f.target),
  });
  const owner = health.prepare(quote), accepted = batch.acceptHit(quote, owner);
  assert.equal(accepted.ok, true);
  return { batch, owner, accepted };
}

/**
 * These test opaque guardian identities and actual health-owner preparations
 * solely as data-owner composition. They do not claim Wildlife/Ecology
 * authorization for the opaque guardian (that bridge remains inactive).
 */
test("data-owner scope: derived work joins its real originating health preparation and waits until after commit", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  let origin = originatingHit(f, health, 1);
  let derived = origin.batch.admitDerived(origin.accepted.origin, reflection(f));
  assert.equal(derived.ok, true);
  assert.equal(origin.batch.quoteDerived(derived.ticket, { difficulty: "normal", validate: f.guard() }).ok, false);
  assert.equal(origin.batch.finalize({ participants: origin.owner.participants }).ok, false);
  assert.equal(health.gameplay.health, 20);
  assert.equal(f.runtime.derived.length, 0);
  origin = originatingHit(f, health, 1);
  derived = origin.batch.admitDerived(origin.accepted.origin, reflection(f));
  const plan = origin.batch.finalize({ participants: origin.owner.participants });
  assert.equal(plan.participants.filter((part) => part.owner === f.runtime).length, 1);
  f.commit(plan);
  assert.equal(health.gameplay.health, 19);
  assert.equal(f.runtime.derived.length, 1);
  const batch = f.runtime.begin(), quote = batch.quoteDerived(derived.ticket, {
    difficulty: "normal", validate: f.guard(f.target),
  });
  const owner = health.prepare(quote), accepted = batch.acceptHit(quote, owner);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.origin, null, "derived hits cannot recursively issue an origin");
  f.commit(batch.finalize({ participants: owner.participants }));
  assert.equal(health.gameplay.health, 18);
  assert.equal(f.runtime.derived.length, 0);
  assert.equal(f.runtime.begin().admitDerived(accepted.origin, reflection(f)).ok, false);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
});

test("eight derived tickets veto a ninth atomically, preserving both actual health and runtime clocks", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  for (let amount = 1; amount <= 8; amount++) {
    const origin = originatingHit(f, health, amount);
    assert.equal(origin.batch.admitDerived(origin.accepted.origin, reflection(f)).ok, true);
    f.commit(origin.batch.finalize({ participants: origin.owner.participants }));
  }
  assert.equal(f.runtime.derived.length, 8);
  assert.equal(health.gameplay.health, 12);
  const before = f.runtime.actor(f.source), ninth = originatingHit(f, health, 9);
  assert.equal(ninth.batch.admitDerived(ninth.accepted.origin, reflection(f)).reason, "derived-capacity");
  assert.equal(ninth.batch.finalize({ participants: ninth.owner.participants }).ok, false);
  assert.equal(health.gameplay.health, 12);
  assert.deepEqual(f.runtime.actor(f.source), before);
  const batch = f.runtime.begin();
  assert.equal(batch.cancel(f.runtime.derived[0].ticket).ok, true);
  const retry = originatingHit(f, health, 9, batch);
  assert.equal(batch.admitDerived(retry.accepted.origin, reflection(f)).ok, true);
  f.commit(batch.finalize({ participants: retry.owner.participants }));
  assert.equal(health.gameplay.health, 11);
  assert.equal(f.runtime.derived.length, 8);
});

test("copied/consumed origins, unsupported reflection identities and oversized TTL reject the whole preparation", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  let origin = originatingHit(f, health, 1);
  assert.equal(origin.batch.admitDerived({ ...origin.accepted.origin }, reflection(f)).ok, false);
  assert.equal(origin.batch.finalize({ participants: origin.owner.participants }).ok, false);
  for (const changes of [
    { ttl: 0.5001 }, { ttl: 0 }, { victim: f.source },
    { provenance: f.provenance("guardian_thorns", { responsibleSpecies: "skeleton" }) },
  ]) {
    origin = originatingHit(f, health, 1);
    assert.equal(origin.batch.admitDerived(origin.accepted.origin, reflection(f, changes)).ok, false);
    assert.equal(origin.batch.finalize({ participants: origin.owner.participants }).ok, false);
  }
  origin = originatingHit(f, health, 1);
  assert.equal(origin.batch.admitDerived(origin.accepted.origin, reflection(f)).ok, true);
  assert.equal(origin.batch.admitDerived(origin.accepted.origin, reflection(f)).ok, false);
  assert.equal(origin.batch.finalize({ participants: origin.owner.participants }).ok, false);
  assert.equal(health.gameplay.health, 20);
  assert.equal(f.runtime.derived.length, 0);
});

test("derived deadlines are exactly half an admitted second across partitions and pauses", (t) => {
  for (const partition of [[0.5], [0.25, 0.25], [0.13, 0.17, 0.2], Array(10).fill(0.05)]) {
    const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
    const origin = originatingHit(f, health, 1);
    const derived = origin.batch.admitDerived(origin.accepted.origin, reflection(f));
    f.commit(origin.batch.finalize({ participants: origin.owner.participants }));
    const before = f.runtime.derivedContact(derived.ticket);
    f.advance(0);
    assert.deepEqual(f.runtime.derivedContact(derived.ticket), before);
    assert.equal(f.runtime.derivedContact({ ...derived.ticket }), null);
    for (let index = 0; index < partition.length; index++) {
      f.advance(partition[index]);
      if (index < partition.length - 1) assert.notEqual(f.runtime.derivedContact(derived.ticket), null);
    }
    assert.equal(f.runtime.derivedContact(derived.ticket), null);
    assert.equal(f.runtime.begin().quoteDerived(derived.ticket, { difficulty: "normal", validate: f.guard() }).ok, false);
    assert.equal(health.gameplay.health, 19, "expired derived work never damages later");
  }
});

test("source removal preserves derived provenance, but player life replacement invalidates that victim", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  const origin = originatingHit(f, health, 1);
  const derived = origin.batch.admitDerived(origin.accepted.origin, reflection(f));
  f.commit(origin.batch.finalize({ participants: origin.owner.participants }));
  const before = f.runtime.derivedContact(derived.ticket).provenance;
  f.sync([f.target]);
  assert.deepEqual(f.runtime.derivedContact(derived.ticket).provenance, before);
  const newPlayer = { ...f.target, life: f.target.life + 1 };
  f.sync([newPlayer]);
  assert.equal(f.runtime.begin().quoteDerived(derived.ticket, {
    difficulty: "normal", validate: f.guard(newPlayer),
  }).reason, "stale-actor");
  const cancel = f.runtime.begin();
  assert.equal(cancel.cancel(derived.ticket).ok, true);
  f.commit(cancel.finalize());
  assert.equal(health.gameplay.health, 19);
  assert.equal(f.runtime.derived.length, 0);
});
