import assert from "node:assert/strict";
import test from "node:test";
import { COMBAT_RUNTIME_LIMITS } from "../src/combat-runtime.js";
import {
  combatRuntimeFixture, runtimeActorFixture, runtimeHealthPeer,
} from "./combat-runtime-fixture.js";

test("data-owner scope: legacy and blaze retain independent twelve-shot quotas", (t) => {
  const f = combatRuntimeFixture(t), batch = f.runtime.begin();
  for (let index = 0; index < 12; index++) {
    assert.equal(batch.launch(f.shotSpec(index % 2 ? "ghast_fireball" : "arrow")).ok, true);
    assert.equal(batch.launch(f.shotSpec("blaze_fireball")).ok, true);
  }
  const plan = batch.finalize();
  assert.equal(plan.participants.length, 1);
  f.commit(plan);
  assert.equal(f.runtime.shots.filter((shot) => shot.pool === "legacy").length, 12);
  assert.equal(f.runtime.shots.filter((shot) => shot.pool === "blaze").length, 12);
  for (const kind of ["arrow", "ghast_fireball", "blaze_fireball"]) {
    const full = f.runtime.begin();
    assert.equal(full.launch(f.shotSpec(kind)).reason, "shot-capacity");
    assert.equal(full.finalize().ok, false);
  }
  const free = f.runtime.begin(), old = f.runtime.shots.find((shot) => shot.pool === "legacy");
  assert.equal(free.cancel(old.ticket).ok, true);
  const replacement = free.launch(f.shotSpec("ghast_fireball"));
  assert.equal(replacement.ok, true);
  f.commit(free.finalize());
  assert.equal(f.runtime.shots.length, 24);
  assert.equal(f.runtime.shot(old.ticket), null);
});

test("supplied flight/payload bounds reject unsupported cases, without inventing radius or kinematic policy", (t) => {
  const f = combatRuntimeFixture(t);
  for (const [kind, changes] of [
    ["arrow", { ttl: 6.001 }], ["blaze_fireball", { ttl: 3.001 }],
    ["arrow", { ttl: 0 }], ["arrow", { ttl: Infinity }],
    ["arrow", { radius: undefined }], ["arrow", { radius: 1.001 }],
    ["arrow", { gravity: COMBAT_RUNTIME_LIMITS.gravity + 1 }],
    ["arrow", { velocity: { x: Infinity, y: 0, z: 0 } }],
    ["arrow", { velocity: { x: COMBAT_RUNTIME_LIMITS.vectorMagnitude + 1, y: 0, z: 0 } }],
    ["arrow", { provenance: f.provenance("fireball") }],
    ["arrow", { provenance: f.provenance("arrow", { effects: [{ kind: "fire", durationSeconds: 4 }] }) }],
    ["blaze_fireball", { provenance: f.provenance("blaze_fireball", { effects: [] }) }],
    ["blaze_fireball", { provenance: f.provenance("blaze_fireball", { rawDamage: 6 }) }],
    ["arrow", { provenance: f.provenance("arrow", { playerOwnerId: "local-player" }) }],
  ]) {
    const batch = f.runtime.begin();
    assert.equal(batch.launch(f.shotSpec()).ok, true);
    assert.equal(batch.launch(f.shotSpec(kind, changes)).ok, false);
    assert.equal(batch.finalize().ok, false);
    assert.equal(f.runtime.shots.length, 0);
  }
});

test("blaze movement/contact needs a previously committed completed presentation, never launch-frame CPU work", (t) => {
  const f = combatRuntimeFixture(t);
  let batch = f.runtime.begin();
  const staged = batch.launch(f.shotSpec("blaze_fireball"));
  assert.equal(staged.ok, true);
  assert.equal(batch.acknowledgePresentation(staged.ticket, { validateCompleted: f.guard() }).ok, false);
  assert.equal(batch.finalize().ok, false);
  assert.equal(f.runtime.shots.length, 0);
  const ticket = f.launch("blaze_fireball");
  f.advance(0.1);
  batch = f.runtime.begin();
  assert.equal(batch.motion(ticket, f.motionOptions(ticket)).reason, "presentation-required");
  assert.equal(batch.finalize().ok, false);
  const observation = { done: false, ticket }, current = f.guard();
  batch = f.runtime.begin();
  assert.equal(batch.acknowledgePresentation(ticket, {
    validateCompleted: () => current() && observation.done && observation.ticket === ticket,
  }).ok, false);
  observation.done = true;
  batch = f.runtime.begin();
  const acknowledged = batch.acknowledgePresentation(ticket, {
    validateCompleted: () => current() && observation.done && observation.ticket === ticket,
  });
  assert.equal(acknowledged.ok, true);
  assert.equal(batch.motion(acknowledged.ticket, f.motionOptions(ticket)).ok, false);
  assert.equal(batch.finalize().ok, false, "same-transaction acknowledgement cannot enable motion");
  assert.equal(f.runtime.shot(ticket).acknowledged, false);
  const presented = f.present(ticket);
  batch = f.runtime.begin();
  const moved = batch.motion(presented, f.motionOptions(presented, { to: { x: 5, y: 20, z: 4.5 } }));
  assert.equal(moved.kind, "flight");
  f.commit(batch.finalize());
  assert.equal(f.runtime.shot(moved.ticket).position.x, 5);
  assert.equal(f.runtime.shot(moved.ticket).lifetime.elapsedSeconds, 0.1);
  assert.equal(f.runtime.shot(moved.ticket).provenance.effects[0].durationSeconds, 4);
});

test("an expired presentation acknowledgement cannot resurrect a blaze or reset its deadline", (t) => {
  const f = combatRuntimeFixture(t), ticket = f.launch("blaze_fireball"), batch = f.runtime.begin();
  const observation = { ticket, done: true }, current = f.guard();
  assert.equal(batch.acknowledgePresentation(ticket, {
    validateCompleted: () => current() && observation.done && observation.ticket === ticket,
  }).ok, true);
  const plan = batch.finalize();
  f.advance(3);
  assert.equal(f.runtime.shot(ticket), null);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.runtime.begin().acknowledgePresentation(ticket, { validateCompleted: current }).ok, false);
  assert.equal(f.runtime.shots.length, 0);
});

test("real guarded geometry rejects a newly intervening actor even without any owner revision bump", (t) => {
  const f = combatRuntimeFixture(t);
  const other = runtimeActorFixture(f.world, { id: "runtime/intervening", box: [5, 19, 7, 6, 21, 8] });
  f.sync([f.source, f.target, other]);
  const ticket = f.launch(), batch = f.runtime.begin(), revision = f.runtime.revision;
  const contact = batch.motion(ticket, f.motionOptions(ticket));
  assert.equal(contact.kind, "contact");
  assert.equal(contact.contact.actor.id, f.target.id);
  const plan = batch.finalize();
  other.box = [5, 19, 4, 6, 21, 5];
  assert.equal(f.runtime.revision, revision, "relocation does not notify this metadata owner");
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.runtime.shot(ticket).position.x, 4);
  assert.equal(f.runtime.shot(contact.ticket), null);
  const retry = f.runtime.begin(), nearest = retry.motion(ticket, f.motionOptions(ticket));
  assert.equal(nearest.contact.actor.id, other.id);
  f.commit(retry.finalize());
});

test("foreground owner refusal stays pending and never exposes a farther actor", (t) => {
  const f = combatRuntimeFixture(t);
  const foreground = runtimeActorFixture(f.world, { id: "runtime/unavailable", box: [5, 19, 4, 6, 21, 5] });
  f.sync([f.source, foreground, f.target]);
  const ticket = f.pending();
  assert.equal(f.runtime.shot(ticket).pending.contact.actor.id, foreground.id);
  const batch = f.runtime.begin();
  const quote = batch.quoteContact(ticket, {
    difficulty: "normal", readCandidates: f.readCandidates, validate: f.guard(foreground),
  });
  assert.equal(quote.ok, true);
  assert.equal(batch.acceptHit(quote, null).ok, false, "unavailable owner is not a made-up success");
  assert.equal(batch.finalize().ok, false);
  assert.equal(f.runtime.shot(ticket).position.x, 4);
  assert.equal(f.runtime.begin().motion(ticket, f.motionOptions(ticket)).reason, "pending-contact-blocks-motion");
  assert.equal(f.runtime.actor(f.target).hurt, null);
});

test("source death removes source metadata but preserves launched provenance and guarded contact", (t) => {
  const f = combatRuntimeFixture(t), health = runtimeHealthPeer(t, f);
  const sourceRef = f.source.ref, ticket = f.launch();
  const provenance = f.runtime.shot(ticket).provenance;
  f.sync([f.target]);
  assert.equal(f.runtime.actor(f.source), null);
  assert.deepEqual(f.runtime.shot(ticket).provenance, provenance);
  const movement = f.runtime.begin(), contact = movement.motion(ticket, f.motionOptions(ticket));
  assert.equal(contact.kind, "contact");
  f.commit(movement.finalize());
  const hit = f.runtime.begin(), quote = hit.quoteContact(contact.ticket, {
    difficulty: "normal", readCandidates: f.readCandidates, validate: f.guard(f.target),
  });
  const owner = health.prepare(quote);
  assert.equal(hit.acceptHit(quote, owner).ok, true);
  f.commit(hit.finalize({ participants: owner.participants }));
  assert.equal(health.gameplay.health, 18);
  assert.equal(f.runtime.shots.length, 0);
  assert.equal(provenance.responsible.id, f.source.id);
  assert.equal(Object.isFrozen(sourceRef), false);
});

test("launch envelope exits are sticky and returning shots can contact the source", (t) => {
  const f = combatRuntimeFixture(t);
  f.source.box = [4, 19, 4, 5, 21, 5];
  f.sync([f.source]);
  const ticket = f.launch("arrow", {
    position: { x: 4.5, y: 20, z: 4.5 },
    sourceEnvelope: { exited: false, box: f.source.box, members: [f.source] },
  });
  let batch = f.runtime.begin();
  const outward = batch.motion(ticket, f.motionOptions(ticket, { to: { x: 8, y: 20, z: 4.5 } }));
  assert.equal(outward.kind, "flight");
  f.commit(batch.finalize());
  assert.equal(f.runtime.shot(outward.ticket).sourceEnvelope.exited, true);
  batch = f.runtime.begin();
  const returned = batch.motion(outward.ticket, f.motionOptions(outward.ticket, {
    to: { x: 4.5, y: 20, z: 4.5 }, velocity: { x: -12, y: 0, z: 0 },
  }));
  assert.equal(returned.kind, "contact");
  assert.equal(returned.contact.actor.id, f.source.id);
  f.commit(batch.finalize());
});

test("unknown terrain freezes a supplied segment; load/retry cannot extend six admitted seconds", (t) => {
  const f = combatRuntimeFixture(t);
  f.world.chunks.delete("1,0");
  const ticket = f.launch("ghast_fireball", { position: { x: 13, y: 20, z: 4.5 } });
  let batch = f.runtime.begin();
  const frontier = batch.motion(ticket, f.motionOptions(ticket, { to: { x: 15, y: 20, z: 4.5 } }));
  assert.equal(frontier.kind, "frontier");
  f.commit(batch.finalize());
  f.advance(5.9);
  assert.equal(f.runtime.shot(frontier.ticket).position.x, 13);
  batch = f.runtime.begin();
  assert.equal(batch.motion(frontier.ticket, f.motionOptions(frontier.ticket)).reason, "pending-segment-changed");
  assert.equal(batch.finalize().ok, false);
  f.world.generate(1);
  batch = f.runtime.begin();
  const resumed = batch.motion(frontier.ticket, f.motionOptions(frontier.ticket, { to: { x: 15, y: 20, z: 4.5 } }));
  assert.equal(resumed.kind, "flight");
  f.commit(batch.finalize());
  assert.equal(f.runtime.shot(resumed.ticket).lifetime.elapsedSeconds, 5.9);
  f.advance(0.1);
  assert.equal(f.runtime.shot(resumed.ticket), null);
});

test("difficulty guards veto prepared launches and Peaceful refuses mob-owned flight admission", (t) => {
  const f = combatRuntimeFixture(t), batch = f.runtime.begin();
  assert.equal(batch.launch(f.shotSpec()).ok, true);
  const plan = batch.finalize();
  f.difficulty.value = "peaceful";
  f.difficulty.revision++;
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  for (const kind of ["arrow", "blaze_fireball", "ghast_fireball"])
    assert.equal(f.runtime.begin().launch(f.shotSpec(kind)).reason, "peaceful-suppressed");
  assert.equal(f.runtime.shots.length, 0);
});
