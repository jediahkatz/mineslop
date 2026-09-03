import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { CombatRuntime, COMBAT_RUNTIME_LIMITS } from "../src/combat-runtime.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionInvariantError } from "../src/transactions.js";
import { combatWorld } from "./combat-collision-fixtures.js";
import {
  assertRuntimeScalars, combatRuntimeFixture, runtimeActorFixture, runtimeHealthPeer,
} from "./combat-runtime-fixture.js";

test("data-owner scope: one real World registration, zero save bytes, no activation or serialization", (t) => {
  const f = combatRuntimeFixture(t), before = f.world.serialize();
  const bytes = f.coordinator.budget.totalBytes, worldBytes = f.coordinator.usage(f.world);
  assert.equal(f.coordinator.usage(f.runtime), 0);
  assert.equal(f.runtime.reservedBytes, 0);
  for (const name of ["activate", "update", "render", "damage", "serialize", "load"])
    assert.equal(f.runtime[name], undefined);
  assert.throws(() => new CombatRuntime({ world: f.world, context: f.context }), RangeError);
  assert.throws(() => new CombatRuntime({ world: { ...f.world }, context: f.context }), RangeError);
  const other = combatWorld(t);
  assert.throws(() => new CombatRuntime({ world: other, context: { ...f.context, seed: "wrong" } }), RangeError);
  const ticket = f.launch();
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.deepEqual(f.world.serialize(), before);
  assert.equal(JSON.stringify(f.runtime), "{}", "non-enumerable bindings never traverse live owners");
  const batch = f.runtime.begin();
  assert.equal(batch.cancel(ticket).ok, true);
  const old = batch.finalize();
  assert.equal(f.runtime.dispose(), true);
  assert.equal(f.runtime.dispose(), true);
  assert.equal(f.coordinator.usage(f.runtime), undefined);
  assert.equal(f.coordinator.usage(f.world), worldBytes);
  assert.equal(f.runtime.begin(), null);
  assert.deepEqual(f.runtime.shots, []);
  assert.equal(f.coordinator.commit(old.participants).ok, false);
  const replacement = new CombatRuntime({ world: f.world, context: f.context });
  t.after(() => replacement.dispose());
  assert.notEqual(replacement.runtimeEpoch, f.runtime.runtimeEpoch);
  assert.equal(replacement.shot(ticket), null);
});

test("many detached operations finalize exactly one runtime publisher and one revision", (t) => {
  const f = combatRuntimeFixture(t);
  const removed = f.launch(), presented = f.launch();
  const revision = f.runtime.revision, original = f.runtime.shots;
  const batch = f.runtime.begin();
  assert.equal(batch.advanceClocks(0.1, { validate: f.guard() }).ok, true);
  assert.equal(batch.cancel(removed).ok, true);
  const completed = { ticket: presented }, current = f.guard();
  const acknowledgment = batch.acknowledgePresentation(presented, {
    validateCompleted: () => current() && completed.ticket === presented,
  });
  assert.equal(acknowledgment.ok, true);
  const first = batch.launch(f.shotSpec()), second = batch.launch(f.shotSpec("blaze_fireball"));
  assert.equal(first.ok && second.ok, true);
  assert.equal(batch.rememberTarget(f.source, f.target, { validate: f.guard(f.source, f.target) }).ok, true);
  assert.deepEqual(f.runtime.shots, original, "no eager state installation");
  const plan = batch.finalize();
  assert.equal(plan.participants.length, 1);
  assert.equal(plan.participant, plan.participants[0]);
  assert.equal(plan.participant.owner, f.runtime);
  assert.equal(plan.participant.beforeBytes, 0);
  assert.equal(plan.participant.afterBytes, 0);
  f.commit(plan);
  assert.equal(f.runtime.revision, revision + 1);
  assert.equal(f.runtime.shots.length, 3);
  assert.equal(f.runtime.shot(presented), null);
  assert.equal(f.runtime.shot(acknowledgment.ticket).lifetime.elapsedSeconds, 0.1);
  assert.equal(f.runtime.shot(first.ticket).lifetime.elapsedSeconds, 0);
  assert.equal(f.runtime.actor(f.source).target.id, f.target.id);
  assert.equal(batch.launch(f.shotSpec()).ok, false, "sealed batches reject late contributions");
});

test("prepared inputs detach deeply without freezing, traversing or serializing canonical refs", (t) => {
  const f = combatRuntimeFixture(t);
  const ref = f.source.ref;
  Object.defineProperties(ref, {
    health: { get() { assert.fail("no canonical health reads"); } },
    position: { get() { assert.fail("no canonical pose reads"); } },
    toJSON: { get() { assert.fail("never serialize the canonical ref"); } },
  });
  const spec = f.shotSpec("blaze_fireball", {
    sourceEnvelope: { exited: false, box: [1, 19, 4, 4.5, 21, 5], members: [f.source] },
  });
  const batch = f.runtime.begin(), launch = batch.launch(spec), plan = batch.finalize();
  assert.equal(launch.ok, true);
  assert.equal(Object.isFrozen(ref), false);
  assert.equal(Object.isFrozen(spec.position), false);
  spec.position.x = 99;
  spec.velocity.x = -99;
  spec.provenance.sourcePosition.y = 200;
  spec.provenance.rawDamage = 77;
  spec.provenance.effects[0].durationSeconds = 99;
  spec.sourceEnvelope.box[0] = -99;
  ref.unrelatedMutableState = 4;
  f.commit(plan);
  const shot = f.runtime.shot(launch.ticket);
  assert.equal(shot.position.x, 4);
  assert.equal(shot.velocity.x, 9);
  assert.equal(shot.provenance.sourcePosition.y, 20);
  assert.equal(shot.provenance.rawDamage, 5);
  assert.equal(shot.provenance.effects[0].durationSeconds, 4);
  assert.equal(shot.sourceEnvelope.box[0], 1);
  assertRuntimeScalars(shot);
  assertRuntimeScalars(f.runtime.actors);
  assert.doesNotThrow(() => JSON.stringify([f.runtime.shots, f.runtime.actors]));
  assert.throws(() => { shot.position.x = 8; }, TypeError);
});

test("refused/conflicting/malformed contributions poison the batch, never publish a partial success", (t) => {
  const f = combatRuntimeFixture(t), ticket = f.launch(), before = f.runtime.shots;
  let batch = f.runtime.begin();
  assert.equal(batch.launch(f.shotSpec()).ok, true);
  assert.equal(batch.launch(f.shotSpec("arrow", { radius: undefined })).ok, false);
  assert.equal(batch.finalize().ok, false);
  assert.deepEqual(f.runtime.shots, before);
  batch = f.runtime.begin();
  assert.equal(batch.cancel(ticket).ok, true);
  assert.equal(batch.cancel(ticket).ok, false);
  assert.equal(batch.finalize().ok, false);
  assert.deepEqual(f.runtime.shots, before);
  batch = f.runtime.begin();
  assert.equal(batch.launch(f.shotSpec()).ok, true);
  assert.equal(batch.advanceClocks(1, {
    get validate() { assert.fail("non-data options must reject before getter execution"); },
  }).ok, false);
  assert.equal(batch.finalize().ok, false);
  batch = f.runtime.begin();
  assert.equal(batch.launch(f.shotSpec("arrow", { validate: async () => f.runtime.available })).ok, false);
  assert.equal(batch.finalize().ok, false);
  assert.deepEqual(f.runtime.shots, before);
});

test("empty or unreadable guard errors poison all earlier contributions", (t) => {
  const f = combatRuntimeFixture(t);
  const before = { shots: f.runtime.shots, actors: f.runtime.actors, revision: f.runtime.revision };
  const errors = [
    new RangeError(),
    ...[null, undefined, false, 0].map((message) => Object.assign(new RangeError(), { message })),
  ];
  const unreadable = new RangeError();
  Object.defineProperty(unreadable, "message", { get() { throw new Error("unreadable message"); } });
  errors.push(unreadable);
  for (const error of errors) {
    const batch = f.runtime.begin();
    const launch = batch.launch(f.shotSpec());
    assert.equal(launch.ok, true);
    const refused = batch.advanceClocks(0.1, { validate() { throw error; } });
    assert.deepEqual(refused, { ok: false, reason: "preparation-reader-failed" });
    assert.equal(batch.launch(f.shotSpec()).ok, false);
    assert.deepEqual(batch.finalize(), refused);
    assert.equal(f.runtime.shot(launch.ticket), null);
    assert.deepEqual(
      { shots: f.runtime.shots, actors: f.runtime.actors, revision: f.runtime.revision }, before
    );
  }
  assert.notEqual(f.runtime.shot(f.launch()), null, "only the failed batch is poisoned");
});

test("empty finalization errors retain a nonempty reason and leave the batch closed", (t) => {
  const f = combatRuntimeFixture(t), batch = f.runtime.begin();
  assert.equal(batch.launch(f.shotSpec()).ok, true);
  const refusal = batch.finalize({
    participants: [{ get owner() { throw new RangeError(); } }],
  });
  assert.deepEqual(refusal, { ok: false, reason: "invalid-finalization" });
  assert.deepEqual(batch.finalize(), refusal);
  assert.equal(batch.launch(f.shotSpec()).ok, false);
  assert.equal(f.runtime.shots.length, 0);
  assert.notEqual(f.runtime.shot(f.launch()), null);
});

test("fatal guard and error-metadata invariants propagate after poisoning the batch", (t) => {
  const f = combatRuntimeFixture(t);
  const fatal = new TransactionInvariantError("test invariant");
  const metadata = new RangeError();
  Object.defineProperty(metadata, "message", { get() { throw fatal; } });
  for (const error of [fatal, metadata]) {
    const batch = f.runtime.begin();
    assert.equal(batch.launch(f.shotSpec()).ok, true);
    assert.throws(() => batch.advanceClocks(0.1, { validate() { throw error; } }),
      (caught) => caught === fatal);
    assert.equal(batch.finalize().ok, false);
    assert.equal(batch.launch(f.shotSpec()).ok, false);
    assert.equal(f.runtime.shots.length, 0);
  }
});

test("copied tickets, copied participants, conflicting plans and replay reject", (t) => {
  const f = combatRuntimeFixture(t), ticket = f.launch();
  for (const copy of [{ ...ticket }, structuredClone(ticket), Object.freeze({ ...ticket })]) {
    assert.equal(f.runtime.shot(copy), null);
    assert.equal(f.runtime.begin().cancel(copy).ok, false);
  }
  const a = f.runtime.begin(), b = f.runtime.begin();
  assert.equal(a.cancel(ticket).ok, true);
  assert.equal(b.cancel(ticket).ok, true);
  const first = a.finalize(), second = b.finalize();
  assert.equal(f.coordinator.commit([{ ...first.participant }]).ok, false);
  f.commit(first);
  assert.equal(f.coordinator.commit(first.participants).ok, false);
  assert.equal(f.coordinator.commit(second.participants).ok, false);
  assert.equal(f.runtime.shot(ticket), null);
});

test("notification reentry sees installed state, cannot replay, and notifies only once", (t) => {
  const f = combatRuntimeFixture(t), batch = f.runtime.begin();
  const launch = batch.launch(f.shotSpec());
  let notices = 0, replay;
  const plan = batch.finalize({ notify(receipt) {
    notices++;
    assert.equal(receipt.scope, "data-owner-only");
    assert.notEqual(f.runtime.shot(launch.ticket), null);
    replay = f.coordinator.commit(plan.participants);
    const next = f.runtime.begin();
    assert.equal(next.cancel(launch.ticket).ok, true);
    f.commit(next.finalize());
  } });
  plan.participant.notify();
  assert.equal(notices, 0);
  f.commit(plan);
  assert.equal(replay.ok, false);
  assert.equal(f.runtime.shot(launch.ticket), null);
  plan.participant.notify();
  assert.equal(notices, 1);
});

test("real World resource veto preserves the whole preparation and permits guarded retry", (t) => {
  const f = combatRuntimeFixture(t), filler = {};
  const bytes = f.coordinator.budget.totalBytes;
  assert.equal(f.coordinator.register(filler, MAX_RESERVED_BYTES - bytes), true);
  t.after(() => f.coordinator.release(filler));
  const worldPart = f.world.prepareMutation([{
    x: 4, y: 20, z: 4, before: f.world.getCell(4, 20, 4), after: normalizeCell({ id: BLOCK.STONE }),
  }]);
  assert.ok(worldPart);
  const batch = f.runtime.begin(), launch = batch.launch(f.shotSpec());
  const plan = batch.finalize({ participants: [worldPart] });
  assert.equal(plan.ok, true);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.runtime.shot(launch.ticket), null);
  assert.equal(f.world.get(4, 20, 4), BLOCK.AIR);
  assert.equal(f.coordinator.release(filler), true);
  f.commit(plan);
  assert.notEqual(f.runtime.shot(launch.ticket), null);
  assert.equal(f.world.get(4, 20, 4), BLOCK.STONE);
});

test("29 actor slots reject oversized/duplicate rosters, without copying a mob archive", (t) => {
  const f = combatRuntimeFixture(t);
  const mobs = Array.from({ length: 28 }, (_, index) =>
    runtimeActorFixture(f.world, { id: `runtime/mob/${index}` }));
  f.sync([...mobs, f.target]);
  assert.equal(f.runtime.actors.length, COMBAT_RUNTIME_LIMITS.actors);
  for (const roster of [
    [...mobs, runtimeActorFixture(f.world, { id: "runtime/mob/29" }), f.target],
    [f.target, { ...f.target, id: "other-player", ref: {} }],
    [mobs[0], mobs[0]], [mobs[0], { ...mobs[1], ref: mobs[0].ref }],
  ]) {
    const batch = f.runtime.begin();
    assert.equal(batch.syncActors(roster, { validate: f.guard() }).ok, false);
    assert.equal(batch.finalize().ok, false);
    assert.equal(f.runtime.actors.length, 29);
  }
});

test("actual owner health result is mandatory and cannot omit or duplicate its participants", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  const prepare = () => {
    const batch = f.runtime.begin();
    const quote = batch.quoteHit({ victim: f.target, provenance: f.provenance("melee"),
      difficulty: "normal", validate: f.guard(f.source, f.target) });
    return { batch, quote, owner: health.prepare(quote) };
  };
  let p = prepare();
  assert.equal(p.batch.acceptHit({ ...p.quote }, p.owner).ok, false);
  p = prepare();
  assert.equal(p.batch.acceptHit(p.quote, { ok: true }).ok, false);
  p = prepare();
  assert.equal(p.batch.acceptHit(p.quote, p.owner).ok, true);
  assert.equal(p.batch.finalize().ok, false);
  assert.equal(health.gameplay.health, 20);
  assert.equal(f.runtime.actor(f.target).hurt, null);
  p = prepare();
  assert.equal(p.batch.acceptHit(p.quote, p.owner).ok, true);
  assert.equal(p.batch.finalize({ participants: [...p.owner.participants, ...p.owner.participants] }).ok, false);
  p = prepare();
  assert.equal(p.batch.acceptHit(p.quote, p.owner).ok, true);
  const plan = p.batch.finalize({ participants: p.owner.participants });
  assert.equal(plan.participants.filter((part) => part.owner === f.runtime).length, 1);
  f.commit(plan);
  assert.equal(health.gameplay.health, 18);
  assert.equal(health.hurt.length, 1);
  assert.equal(f.runtime.actor(f.target).hurt.difficultyAdjustedFullDamage, 2);
});

test("preparation readers cannot commit an older runtime plan, dispose it, or reenter their batch", (t) => {
  const f = combatRuntimeFixture(t), oldBatch = f.runtime.begin();
  const oldLaunch = oldBatch.launch(f.shotSpec()), oldPlan = oldBatch.finalize();
  const batch = f.runtime.begin(), current = f.guard();
  let nested;
  const launch = batch.launch(f.shotSpec("arrow", { validate() {
    assert.equal(f.runtime.begin(), null);
    assert.equal(f.runtime.dispose(), false);
    nested = f.coordinator.commit(oldPlan.participants);
    return current();
  } }));
  assert.equal(launch.ok, true);
  assert.equal(nested.ok, false);
  assert.equal(f.runtime.shot(oldLaunch.ticket), null);
  assert.equal(f.runtime.shots.length, 0);
  // The reader above intentionally violates the read-only contract; never use
  // it as a bridge. Discard its detached batch and exercise same-batch reentry.
  const reentered = f.runtime.begin();
  assert.equal(reentered.launch(f.shotSpec("arrow", { validate() {
    assert.equal(reentered.finalize().ok, false);
    return current();
  } })).ok, false);
  assert.equal(reentered.finalize().ok, false);
  assert.equal(f.runtime.shots.length, 0);
  f.commit(oldPlan);
  assert.notEqual(f.runtime.shot(oldLaunch.ticket), null);
});

test("a bounded batch cannot retain an unbounded ledger of quotes or guards", (t) => {
  const f = combatRuntimeFixture(t), batch = f.runtime.begin();
  assert.equal(batch.launch(f.shotSpec()).ok, true);
  const request = { victim: f.target, provenance: f.provenance("melee"),
    difficulty: "normal", validate: f.guard(f.source, f.target) };
  for (let index = 1; index < COMBAT_RUNTIME_LIMITS.batchOperations; index++)
    assert.equal(batch.quoteHit(request).ok, true);
  assert.equal(batch.quoteHit(request).reason, "batch-capacity");
  assert.equal(batch.finalize().ok, false);
  assert.equal(f.runtime.shots.length, 0);
});

test("changing an actual owner participant after finalization vetoes runtime metadata too", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f), batch = f.runtime.begin();
  const quote = batch.quoteHit({ victim: f.target, provenance: f.provenance("melee"),
    difficulty: "normal", validate: f.guard(f.source, f.target) });
  const owner = health.prepare(quote);
  assert.equal(batch.acceptHit(quote, owner).ok, true);
  const plan = batch.finalize({ participants: owner.participants });
  const peer = owner.participants[0], original = peer.publish;
  peer.publish = () => assert.fail("mutated publisher must never execute");
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(health.gameplay.health, 20);
  assert.equal(f.runtime.actor(f.target).hurt, null);
  peer.publish = original;
  f.commit(plan);
  assert.equal(health.gameplay.health, 18);
});
