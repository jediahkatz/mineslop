import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  assertRuntimeScalars, combatRuntimeFixture, runtimeActorFixture, runtimeHealthPeer,
} from "./combat-runtime-fixture.js";

const ghastSpec = (f, changes = {}) => ({
  radius: 1.8, ttl: 1,
  victims: [{ actor: f.target, exposure: 1, rawDamage: 2 }],
  difficulty: f.difficulty.value, readCandidates: f.readCandidates,
  validate: f.guard(f.target), ...changes,
});

test("data-owner scope: four blast tickets capture at most 29 bounded detached victims each", (t) => {
  const f = combatRuntimeFixture(t);
  const mobs = [f.source, ...Array.from({ length: 27 }, (_, index) =>
    runtimeActorFixture(f.world, { id: `runtime/blast-victim/${index}` }))];
  const roster = [...mobs, f.target];
  f.sync(roster);
  for (let index = 0; index < 4; index++) f.blast(roster);
  assert.equal(f.runtime.blasts.length, 4);
  assert.ok(f.runtime.blasts.every((blast) => blast.victims.length === 29));
  assertRuntimeScalars(f.runtime.blasts);
  assert.equal(f.runtime.begin().admitBlast(f.blastSpec(roster)).reason, "blast-capacity");
  const cancel = f.runtime.begin();
  assert.equal(cancel.cancel(f.runtime.blasts[0].ticket).ok, true);
  f.commit(cancel.finalize());
  for (const changes of [
    { victims: Array(30).fill({ actor: f.target, exposure: 1, rawDamage: 2 }) },
    { victims: [{ actor: f.target, exposure: 2, rawDamage: 2 }] },
    { victims: [{ actor: f.target, exposure: 1, rawDamage: Infinity }] },
    { ttl: 1.01 }, { radius: 17 },
    { provenance: f.provenance("ghast_explosion") },
    { provenance: f.provenance("tnt_explosion") },
  ]) {
    const batch = f.runtime.begin();
    assert.equal(batch.admitBlast(f.blastSpec(roster, changes)).ok, false);
    assert.equal(batch.finalize().ok, false);
    assert.equal(f.runtime.blasts.length, 3);
  }
});

test("ghast full-pool refusal preserves pending shot, position, provenance, lifetime and health", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  for (let index = 0; index < 4; index++) f.blast([]);
  const ticket = f.pending("ghast_fireball");
  const before = f.runtime.shot(ticket), worldBefore = f.world.serialize();
  for (let attempt = 0; attempt < 3; attempt++) {
    const batch = f.runtime.begin();
    assert.equal(batch.admitGhastBlast(ticket, ghastSpec(f)).reason, "blast-capacity");
    assert.equal(batch.finalize().ok, false);
    assert.deepEqual(f.runtime.shot(ticket), before);
  }
  assert.equal(f.runtime.shot(ticket).position.x, 4);
  assert.equal(health.gameplay.health, 20);
  assert.deepEqual(health.hurt, []);
  assert.deepEqual(f.world.serialize(), worldBefore);
  assert.equal(f.runtime.begin().quoteContact(ticket, {
    difficulty: "normal", readCandidates: f.readCandidates, validate: f.guard(),
  }).reason, "ghast-is-blast-only");
  const free = f.runtime.begin();
  assert.equal(free.cancel(f.runtime.blasts[0].ticket).ok, true);
  const admitted = free.admitGhastBlast(ticket, ghastSpec(f));
  assert.equal(admitted.ok, true, admitted.reason);
  const plan = free.finalize();
  assert.equal(plan.participants.length, 1, "retirement, capacity release and admission share one publisher");
  assert.notEqual(f.runtime.shot(ticket), null, "preparation has not consumed the shot");
  f.commit(plan);
  assert.equal(f.runtime.shot(ticket), null);
  assert.equal(f.runtime.blasts.length, 4);
  assert.equal(f.runtime.blast(admitted.ticket).center.x, before.pending.contact.center.x);
  assert.equal(f.runtime.blast(admitted.ticket).provenance.attackKind, "ghast_explosion");
  assert.deepEqual(f.runtime.blast(admitted.ticket).provenance.responsible, before.provenance.responsible);
  assert.equal(health.gameplay.health, 20, "admission alone never delivers blast damage");
});

test("a ghast retry repeats guarded nearest contact and refuses an intervening body without partial retirement", (t) => {
  const f = combatRuntimeFixture(t);
  const other = runtimeActorFixture(f.world, { id: "runtime/blast-interloper", box: [5, 19, 7, 6, 21, 8] });
  f.sync([f.source, f.target, other]);
  const ticket = f.pending("ghast_fireball"), batch = f.runtime.begin();
  const admitted = batch.admitGhastBlast(ticket, ghastSpec(f));
  assert.equal(admitted.ok, true);
  const plan = batch.finalize(), revision = f.runtime.revision;
  other.box = [5, 19, 4, 6, 21, 5];
  assert.equal(f.runtime.revision, revision);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.notEqual(f.runtime.shot(ticket), null);
  assert.equal(f.runtime.blasts.length, 0);
  const retry = f.runtime.begin();
  assert.equal(retry.admitGhastBlast(ticket, ghastSpec(f)).reason, "stale-pending-contact");
  assert.equal(retry.finalize().ok, false);
  other.box = [5, 19, 7, 6, 21, 8];
  const fresh = f.runtime.begin(), success = fresh.admitGhastBlast(ticket, ghastSpec(f));
  assert.equal(success.ok, true);
  f.commit(fresh.finalize());
  assert.equal(f.runtime.shot(ticket), null);
});

test("queued ghast admission never extends original expiry and frontier is never an explosion", (t) => {
  const f = combatRuntimeFixture(t);
  for (let index = 0; index < 4; index++) f.blast([]);
  const ticket = f.pending("ghast_fireball");
  assert.equal(f.runtime.begin().admitGhastBlast(ticket, ghastSpec(f)).ok, false);
  f.advance(5.5);
  const almost = f.runtime.shot(ticket);
  assert.equal(almost.lifetime.duration, 6);
  assert.equal(almost.lifetime.elapsedSeconds, 5.5);
  const pending = f.runtime.begin();
  assert.equal(pending.admitGhastBlast(ticket, ghastSpec(f)).ok, true);
  const plan = pending.finalize();
  f.advance(0.5);
  assert.equal(f.runtime.shot(ticket), null);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.runtime.blasts.length, 0);
  const flight = f.launch("ghast_fireball");
  assert.equal(f.runtime.begin().admitGhastBlast(flight, ghastSpec(f)).reason, "pending-contact-required");
});

test("blast exposure is captured once and accepted health loss advances exactly one victim", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  const other = runtimeActorFixture(f.world, { id: "runtime/second-blast-victim" });
  f.sync([f.source, f.target, other]);
  const spec = f.blastSpec([f.target, other]), admission = f.runtime.begin();
  const created = admission.admitBlast(spec);
  assert.equal(created.ok, true);
  const admissionPlan = admission.finalize();
  spec.victims[0].exposure = 0;
  spec.victims[0].rawDamage = 100;
  spec.center.x = 99;
  f.commit(admissionPlan);
  const batch = f.runtime.begin();
  const quote = batch.quoteBlastVictim(created.ticket, { difficulty: "normal", validate: f.guard(f.target) });
  assert.equal(quote.preArmorDamage, 2);
  const owner = health.prepare(quote), accepted = batch.acceptHit(quote, owner);
  assert.equal(accepted.ok, true);
  const plan = batch.finalize({ participants: owner.participants });
  assert.equal(f.runtime.blast(created.ticket).cursor, 0);
  assert.equal(health.gameplay.health, 20);
  f.commit(plan);
  assert.equal(health.gameplay.health, 18);
  assert.equal(f.runtime.blast(created.ticket), null, "old cursor token is consumed");
  const next = f.runtime.blast(accepted.ticket);
  assert.equal(next.cursor, 1);
  assert.equal(next.victims[0].outcome, "accepted");
  assert.equal(next.victims[0].exposure, 1);
  assert.equal(next.center.x, 7);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.runtime.begin().skipBlastVictim(created.ticket, "unavailable", { validate: f.guard() }).ok, false);
  const skip = f.runtime.begin();
  assert.equal(skip.skipBlastVictim(accepted.ticket, "unavailable", { validate: f.guard() }).ok, true);
  f.commit(skip.finalize());
  assert.equal(f.runtime.blasts.length, 0);
  assert.equal(health.gameplay.health, 18);
});

test("budget-vetoed blast victim is explicitly skipped once and cannot retry after capacity frees", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f), filler = {};
  const other = runtimeActorFixture(f.world, { id: "runtime/after-budget-refusal" });
  f.sync([f.source, f.target, other]);
  const ticket = f.blast([f.target, other]);
  assert.equal(f.coordinator.register(filler, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes), true);
  t.after(() => f.coordinator.release(filler));
  const worldPart = f.world.prepareMutation([{
    x: 12, y: 24, z: 4, before: f.world.getCell(12, 24, 4),
    after: normalizeCell({ id: BLOCK.STONE }),
  }]);
  assert.ok(worldPart);
  const batch = f.runtime.begin(), quote = batch.quoteBlastVictim(ticket, {
    difficulty: "normal", validate: f.guard(f.target),
  });
  const owner = health.prepare(quote);
  assert.equal(batch.acceptHit(quote, owner).ok, true);
  const rejected = batch.finalize({ participants: [...owner.participants, worldPart] });
  assert.equal(rejected.ok, true);
  assert.equal(f.coordinator.commit(rejected.participants).ok, false);
  assert.equal(health.gameplay.health, 20);
  assert.equal(f.runtime.blast(ticket).cursor, 0);
  const skip = f.runtime.begin(), skipped = skip.skipBlastVictim(ticket, "capacity", { validate: f.guard() });
  assert.equal(skipped.ok, true);
  f.commit(skip.finalize());
  assert.equal(f.runtime.blast(skipped.ticket).victims[0].outcome, "skipped:capacity");
  assert.equal(f.runtime.blastVictim(skipped.ticket).victim.id, other.id);
  assert.equal(f.coordinator.release(filler), true);
  assert.equal(f.coordinator.commit(rejected.participants).ok, false);
  assert.equal(health.gameplay.health, 20);
  assert.equal(f.world.get(12, 24, 4), BLOCK.AIR);
});

test("player-life and actor-incarnation replacement invalidate only that captured victim", (t) => {
  const f = combatRuntimeFixture(t);
  const other = runtimeActorFixture(f.world, { id: "runtime/unrelated-blast-victim" });
  f.sync([f.source, f.target, other]);
  const ticket = f.blast([f.target, other]), shot = f.launch();
  const newPlayer = { ...f.target, life: f.target.life + 1 };
  f.sync([f.source, newPlayer, other]);
  assert.equal(f.runtime.blastVictim(ticket).matchesRoster, false);
  assert.equal(f.runtime.begin().quoteBlastVictim(ticket, {
    difficulty: "normal", validate: f.guard(newPlayer),
  }).reason, "stale-actor");
  const skip = f.runtime.begin(), next = skip.skipBlastVictim(ticket, "stale", { validate: f.guard() });
  f.commit(skip.finalize());
  assert.equal(f.runtime.blastVictim(next.ticket).victim.id, other.id);
  assert.equal(f.runtime.blastVictim(next.ticket).matchesRoster, true);
  assert.notEqual(f.runtime.shot(shot), null);
  f.sync([f.source, newPlayer, { ...other, ref: {}, incarnation: other.incarnation + 1 }]);
  assert.equal(f.runtime.blastVictim(next.ticket).matchesRoster, false);
  const last = f.runtime.begin();
  assert.equal(last.skipBlastVictim(next.ticket, "stale", { validate: f.guard() }).ok, true);
  f.commit(last.finalize());
  assert.equal(f.runtime.blasts.length, 0);
  assert.notEqual(f.runtime.shot(shot), null);
});

test("observer-induced real World epoch replacement retires all remaining scope without damage", (t) => {
  const f = combatRuntimeFixture(t);
  const other = runtimeActorFixture(f.world, { id: "runtime/world-replaced-victim" });
  f.sync([f.source, f.target, other]);
  const ticket = f.blast([f.target, other]), shot = f.launch(), batch = f.runtime.begin();
  assert.equal(batch.skipBlastVictim(ticket, "unavailable", { validate: f.guard() }).ok, true);
  const epoch = f.world.epoch;
  const plan = batch.finalize({ notify() {
    assert.equal(f.world.loadEdits(f.world.serialize()), true);
  } });
  f.commit(plan);
  assert.notEqual(f.world.epoch, epoch);
  assert.equal(f.runtime.available, false);
  assert.equal(f.runtime.shot(shot), null);
  assert.deepEqual(f.runtime.blasts, []);
  assert.deepEqual(f.runtime.actors, []);
  assert.equal(f.runtime.begin(), null);
});
