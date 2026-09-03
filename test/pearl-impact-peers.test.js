import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PEARL_IMPACT_PEERS } from "../src/player-projectiles.js";
import { floorImpact, pearlFixture } from "./pearl-fixtures.js";

// Protocol tests for an auxiliary owner, not boat physics or live rider proof.
function peer(t, coordinator) {
  const owner = { attached: true, revision: 0 };
  assert.equal(coordinator.register(owner, 0), true);
  t.after(() => coordinator.release(owner));
  const revision = owner.revision;
  let used = false;
  return {
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () => !used && owner.revision === revision,
    publish() {
      used = true;
      owner.attached = false;
      owner.revision++;
    },
  };
}

test("auxiliary ownership publishes with the actual swept impact, pose, health and retirement", (t) => {
  const f = pearlFixture(t);
  floorImpact(f);
  const departure = peer(t, f.coordinator);
  const extras = [departure];
  f.pearls.prepareImpact = (request) => ({
    ...f.prepareImpact(request),
    extraParticipants: extras,
  });
  const plan = f.pearls.prepareImpactTransaction(1);
  assert.ok(plan);
  assert.equal(plan.participants.length, 4);
  assert.equal(new Set(plan.participants.map(({ owner }) => owner)).size, 4);
  assert.equal(departure.owner.attached, true);
  assert.equal(f.game.health, 20);
  assert.equal(f.pearls.size, 1);
  extras.length = 0;
  assert.equal(
    plan.participants.length,
    4,
    "the caller cannot remove a prepared peer"
  );
  let notified = 0;
  departure.notify = () => {
    notified++;
    assert.equal(departure.owner.attached, false);
    assert.equal(f.game.health, 15);
    assert.equal(f.pearls.size, 0);
    assert.equal(f.player.position.y, plan.request.position.y);
  };
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(notified, 1);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(notified, 1);
});

test("a stale or refusing peer leaves the impact and every owner unpublished", (t) => {
  for (const change of [
    (participant) => {
      participant.owner.revision++;
    },
    (participant) => {
      participant.validate = () => false;
    },
  ]) {
    const f = pearlFixture(t);
    floorImpact(f);
    const departure = peer(t, f.coordinator);
    f.pearls.prepareImpact = (request) => ({
      ...f.prepareImpact(request),
      extraParticipants: [departure],
    });
    const plan = f.pearls.prepareImpactTransaction(1);
    assert.ok(plan);
    const pose = { ...f.player.position };
    const packet = f.pearls.serialize();
    const gameplay = f.game.serialize();
    change(departure);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.equal(departure.owner.attached, true);
    assert.deepEqual(f.player.position, pose);
    assert.deepEqual(f.game.serialize(), gameplay);
    assert.deepEqual(f.pearls.serialize(), packet);
  }
});

test("missing peer lists remain compatible with the three-owner impact", (t) => {
  const f = pearlFixture(t);
  floorImpact(f);
  const plan = f.pearls.prepareImpactTransaction(1);
  assert.ok(plan);
  assert.equal(plan.participants.length, 3);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.game.health, 15);
});

test("invalid, duplicate, foreign, sparse, asynchronous or excessive peer lists veto preparation", (t) => {
  for (const make of [
    () => null,
    () => ({}),
    () => new Array(1),
    (_f, effects) => [effects.pose],
    (_f, effects) => [effects.damage],
    (f) => {
      const duplicate = peer(t, f.coordinator);
      return [duplicate, duplicate];
    },
    () => [
      {
        owner: {},
        beforeBytes: 0,
        afterBytes: 0,
        validate: () => true,
        publish() {},
      },
    ],
    (f) => [
      {
        owner: f.pearls,
        beforeBytes: 0,
        afterBytes: 0,
        validate: () => true,
        publish() {},
      },
    ],
    (f) => [{ ...peer(t, f.coordinator), validate: async () => true }],
    (f) => [{ ...peer(t, f.coordinator), publish: async () => {} }],
    (f) =>
      Array.from({ length: MAX_PEARL_IMPACT_PEERS + 1 }, () =>
        peer(t, f.coordinator)
      ),
  ]) {
    const f = pearlFixture(t);
    floorImpact(f);
    const before = f.pearls.serialize();
    f.pearls.prepareImpact = (request) => {
      const effects = f.prepareImpact(request);
      return { ...effects, extraParticipants: make(f, effects) };
    };
    assert.equal(f.pearls.prepareImpactTransaction(1), null);
    assert.equal(f.game.health, 20);
    assert.deepEqual(f.pearls.serialize(), before);
  }
});
