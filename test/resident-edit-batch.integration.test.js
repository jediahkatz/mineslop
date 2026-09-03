import assert from "node:assert/strict";
import test from "node:test";
import { contributeResidentEditBatch, RESIDENT_EDIT_LIMITS } from "../src/wildlife-resident-batch.js";
import { horseFixture } from "./horse-fixture.js";
import {
  finishResidentBatch, residentSource, residentState,
} from "./resident-edit-batch-fixture.js";

function legacyPair(t) {
  const f = horseFixture(t);
  f.source = residentSource(f, { kind: "creeper" });
  f.victim = f.wildlife.spawn("cow", { x: 8.5, y: 1, z: 8.5 }, { id: "resident-batch:cow" });
  assert.ok(f.victim);
  return f;
}

function pairPlan(f, options) {
  const batch = f.wildlife.beginResidentEditBatch();
  const source = f.wildlife.contributeSourceEdit(batch, f.source, {
    attackCooldown: f.source.spec.cooldown, fuse: 1.2,
  });
  const victim = f.wildlife.contributeLegacyDamage(batch, f.victim, 2, { x: 1, y: 0, z: 0 }, options);
  return { batch, source, victim, plan: finishResidentBatch(f.wildlife, batch, [source, victim]) };
}

test("source cooldown/fuse and legacy nonlethal damage install once without callbacks or RNG in preparation", (t) => {
  const f = legacyPair(t), w = f.wildlife;
  const identity = { entities: w.entities, animals: w.animals, byId: w.byId,
    position: f.victim.position, root: f.victim.root, home: f.victim.home, knockback: f.victim.knockback };
  const before = residentState(f), health = f.victim.health, revision = w._ecologyRevision;
  let validations = 0, notifications = 0;
  t.mock.method(w, "random", () => assert.fail("Preparation cannot consume Wildlife RNG"));
  const { source, victim, plan } = pairPlan(f, {
    validate: () => { validations++; return true; },
    notify: () => { notifications++; },
  });
  for (const contribution of [source, victim]) {
    assert.equal(contribution.complete, false);
    for (const key of ["ok", "participants", "result", "hit", "dropsCommitted"])
      assert.equal(Object.hasOwn(contribution, key), false, key);
  }
  assert.deepEqual(residentState(f), before);
  assert.equal(validations, 0);
  assert.equal(notifications, 0);
  assert.equal(plan.participants.length, 1);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(w._ecologyRevision, revision + 1);
  assert.equal(f.source.attackCooldown, f.source.spec.cooldown);
  assert.equal(f.source.fuse, 1.2);
  assert.equal(f.victim.health, health - 2);
  assert.equal(f.victim.hitFlash, 0.24);
  assert.equal(f.victim.fleeTime, 5);
  assert.equal(f.victim.knockback.x, 3.3);
  assert.equal(f.victim.velocityY, 2.4);
  assert.equal(validations, 1);
  assert.equal(notifications, 1);
  assert.equal(w.randomState, before.mobs.randomState);
  assert.deepEqual(f.totals(), { drops: [], xp: 0 });
  for (const key of ["entities", "animals", "byId"]) assert.equal(w[key], identity[key]);
  for (const key of ["position", "root", "home", "knockback"]) assert.equal(f.victim[key], identity[key]);
  assert.equal(Object.isFrozen(f.source), false);
  const committed = residentState(f);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(residentState(f), committed);
});

test("source fields and impulse inputs are detached and do not constitute launch authorization", (t) => {
  const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
  const fields = { attackCooldown: 0.25, fuse: 0.8 }, direction = { x: 1, y: 0, z: 0 };
  const source = w.contributeSourceEdit(batch, f.source, fields);
  const victim = w.contributeLegacyDamage(batch, f.victim, 1, direction);
  fields.attackCooldown = 1000;
  fields.fuse = 1000;
  direction.x = -1;
  const plan = finishResidentBatch(w, batch, [source, victim]);
  assert.deepEqual(plan.results[0], { type: "source-edit", entityId: f.source.id });
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.source.attackCooldown, 0.25);
  assert.equal(f.source.fuse, 0.8);
  assert.equal(f.victim.knockback.x, 2.9);
});

for (const conflict of ["same-field", "disjoint-fields", "damage-same-record", "copied-identity"])
  test(`a ${conflict} write poisons the entire batch even if its failure is ignored`, (t) => {
    const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
    const first = w.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
    const before = residentState(f);
    const failed = conflict === "damage-same-record"
      ? w.contributeLegacyDamage(batch, f.source, 1, null)
      : w.contributeSourceEdit(batch, conflict === "copied-identity" ? { ...f.source } : f.source,
        conflict === "disjoint-fields" ? { fuse: 1 } : { attackCooldown: 0.3 });
    assert.equal(failed, null);
    assert.equal(w.finalizeResidentEditBatch(batch, { contributions: [first] }), null);
    assert.equal(w.contributeLegacyDamage(batch, f.victim, 1, null), null);
    assert.deepEqual(residentState(f), before);
  });

for (const fields of [{}, { health: 1 }, { attackCooldown: Infinity }, { fuse: 1.66 }])
  test(`malformed source fields ${JSON.stringify(fields)} cannot leave a committable victim edit`, (t) => {
    const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
    const victim = w.contributeLegacyDamage(batch, f.victim, 1, null);
    const before = residentState(f);
    assert.equal(w.contributeSourceEdit(batch, f.source, fields), null);
    assert.equal(w.finalizeResidentEditBatch(batch, { contributions: [victim] }), null);
    assert.deepEqual(residentState(f), before);
  });

for (const malformed of ["sparse", "too-many", "accessor-peer", "throwing-preparer"])
  test(`a ${malformed} borrower peer list poisons even an already-added base edit`, (t) => {
    const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
    const source = w.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
    const before = residentState(f);
    const peers = malformed === "sparse" ? Array(1) :
      malformed === "too-many" ? Array(RESIDENT_EDIT_LIMITS.peers + 1).fill(null) :
        [{ get owner() { assert.fail("A peer cannot execute an accessor during preparation"); } }];
    const prepare = () => contributeResidentEditBatch(w, batch, (add) => {
      assert.equal(add("source", { mob: f.victim, fields: { attackCooldown: 0.25 } }), true);
      if (malformed === "throwing-preparer") throw new Error("Failed borrower preparation");
      return { peers, result: {} };
    });
    if (malformed === "throwing-preparer") assert.throws(prepare, /Failed borrower preparation/);
    else assert.equal(prepare(), null);
    assert.equal(w.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
    assert.deepEqual(residentState(f), before);
  });

test("sparse or accessor-bearing finalization arrays refuse without running their getters", (t) => {
  for (const malformed of ["sparse", "accessor"]) {
    const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
    const source = w.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
    const participants = Array(1);
    if (malformed === "accessor") Object.defineProperty(participants, "0", {
      enumerable: true, get: () => assert.fail("A detached peer list cannot run an accessor"),
    });
    const before = residentState(f);
    assert.equal(w.finalizeResidentEditBatch(batch, { contributions: [source], participants }), null);
    assert.equal(w.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
    assert.deepEqual(residentState(f), before);
  }
});

test("legacy lethal damage is refused without preparing loot, XP, sulfur cargo or RNG", (t) => {
  const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
  const source = w.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
  t.mock.method(w, "random", () => assert.fail("No legacy lethal quote contract exists"));
  t.mock.method(f.overflow, "prepareEnqueue", () => assert.fail("Legacy loot is gated"));
  t.mock.method(f.experience, "prepareSpawn", () => assert.fail("Legacy XP is gated"));
  const before = residentState(f);
  assert.equal(w.contributeLegacyDamage(batch, f.victim, f.victim.health, null), null);
  assert.equal(w.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
  assert.deepEqual(residentState(f), before);
});

for (const subject of ["source", "victim"])
  for (const change of ["health", "position", "yaw", "cooldown", "fuse", "canonical", "dormant"])
    test(`stale ${subject} ${change} vetoes both edits without relying on a base revision bump`, (t) => {
      const f = legacyPair(t), w = f.wildlife, { plan } = pairPlan(f);
      const mob = f[subject], revision = w._ecologyRevision;
      if (change === "health") mob.health -= 0.25;
      if (change === "position") mob.position.x += 0.125;
      if (change === "yaw") mob.root.rotation.y += 0.1;
      if (change === "cooldown") mob.attackCooldown += 0.1;
      if (change === "fuse") mob.fuse += 0.1;
      if (change === "canonical") w.byId.set(mob.id, { ...mob });
      if (change === "dormant") mob.dormant = true;
      assert.equal(w._ecologyRevision, revision);
      const before = residentState(f);
      assert.equal(f.coordinator.commit(plan.participants).ok, false);
      assert.deepEqual(residentState(f), before);
    });

for (const change of ["epoch", "active-array", "base-map", "reservation"])
  test(`a stale ${change} invalidates the detached batch`, (t) => {
    const f = legacyPair(t), w = f.wildlife, { plan } = pairPlan(f);
    if (change === "epoch") assert.equal(f.world.loadEdits(f.world.serialize()), true);
    if (change === "active-array") w.entities = w.animals = w.entities.slice();
    if (change === "base-map") w.byId = new Map(w.byId);
    if (change === "reservation") assert.equal(f.coordinator.register(w, 1), true);
    const before = residentState(f);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(residentState(f), before);
  });

test("stale contributions before finalization cannot yield a partial source-only plan", (t) => {
  const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
  const source = w.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
  f.source.position.x += 0.1;
  const before = residentState(f);
  assert.equal(w.contributeLegacyDamage(batch, f.victim, 1, null), null);
  assert.equal(w.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
  assert.deepEqual(residentState(f), before);
});

test("eight entries/touched actors are finite; the ninth poisons rather than truncates", (t) => {
  const f = horseFixture(t), w = f.wildlife;
  assert.equal(RESIDENT_EDIT_LIMITS.entries, 8);
  assert.equal(RESIDENT_EDIT_LIMITS.actors, 8);
  const mobs = Array.from({ length: 9 }, (_, i) => residentSource(f, { id: `resident-batch:limit:${i}` }));
  let batch = w.beginResidentEditBatch();
  let contributions = mobs.slice(0, 8).map((mob) => w.contributeSourceEdit(batch, mob, { attackCooldown: 0.25 }));
  const revision = w._ecologyRevision;
  assert.equal(f.coordinator.commit(finishResidentBatch(w, batch, contributions).participants).ok, true);
  assert.equal(w._ecologyRevision, revision + 1);
  batch = w.beginResidentEditBatch();
  contributions = mobs.slice(0, 8).map((mob) => w.contributeSourceEdit(batch, mob, { attackCooldown: 0.3 }));
  const before = residentState(f);
  assert.equal(w.contributeSourceEdit(batch, mobs[8], { attackCooldown: 0.3 }), null);
  assert.equal(w.finalizeResidentEditBatch(batch, { contributions }), null);
  assert.deepEqual(residentState(f), before);
});

test("copied/omitted contribution identities and a second finalization refuse", (t) => {
  for (const invalid of ["copy", "omit", "finalize-again"]) {
    const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
    const source = w.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
    const before = residentState(f);
    if (invalid === "finalize-again") {
      const plan = finishResidentBatch(w, batch, [source]);
      assert.equal(w.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
      assert.equal(f.coordinator.commit(plan.participants).ok, false);
    } else assert.equal(w.finalizeResidentEditBatch(batch, {
      contributions: invalid === "copy" ? [{ ...source }] : [],
    }), null);
    assert.deepEqual(residentState(f), before);
  }
});

test("late additions invalidate a cached final plan, including reentry from a peer validator", (t) => {
  for (const duringValidation of [false, true]) {
    const f = legacyPair(t), w = f.wildlife, batch = w.beginResidentEditBatch();
    const source = w.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
    const owner = {};
    assert.equal(f.coordinator.register(owner, 0), true);
    t.after(() => f.coordinator.release(owner));
    const late = () => assert.equal(w.contributeLegacyDamage(batch, f.victim, 1, null), null);
    const peer = { owner, beforeBytes: 0, afterBytes: 0,
      validate: () => { if (duringValidation) late(); return true; },
      publish: () => assert.fail("Late contribution must veto every peer"),
    };
    const plan = finishResidentBatch(w, batch, [source], [peer]);
    const before = residentState(f);
    if (!duringValidation) late();
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(residentState(f), before);
  }
});

test("observers see all edits and can reenter only with a fresh batch; old receipts never replay", (t) => {
  const f = legacyPair(t), w = f.wildlife, health = f.victim.health, revision = w._ecologyRevision;
  let plan, observed = false;
  ({ plan } = pairPlan(f, { notify: () => {
    observed = true;
    assert.equal(f.source.attackCooldown, f.source.spec.cooldown);
    assert.equal(f.victim.health, health - 2);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    const nested = w.beginResidentEditBatch();
    const contribution = w.contributeLegacyDamage(nested, f.victim, 1, null);
    assert.equal(f.coordinator.commit(finishResidentBatch(w, nested, [contribution]).participants).ok, true);
    throw new Error("Deliberate observer failure after both commits");
  } }));
  const result = f.coordinator.commit(plan.participants);
  assert.equal(result.ok, true);
  assert.equal(observed, true);
  assert.equal(result.observerErrors.length, 1);
  assert.equal(f.victim.health, health - 3);
  assert.equal(w._ecologyRevision, revision + 2);
});
