import assert from "node:assert/strict";
import test from "node:test";
import { CombatRuntime } from "../src/combat-runtime.js";
import { captureEntityContext } from "../src/entity-context.js";
import { ITEM } from "../src/items.js";
import {
  finishResidentBatch, residentBorrowersFixture, residentRiderFixture,
  residentSource, residentState,
} from "./resident-edit-batch-fixture.js";

const point = ({ x, y, z }) => ({ x, y, z });

// Actual owner composition, not a live AI/contact authorization or Game cutover.
function compositionFixture(t, kind) {
  const f = kind === "mounted" ? residentRiderFixture(t) : residentBorrowersFixture(t);
  const source = residentSource(f);
  const victim = kind === "ecology" ? f.admitTurtle()
    : kind === "mounted" ? f.horse : f.spawn();
  const runtime = new CombatRuntime({ world: f.world, context: f.context });
  t.after(() => runtime.dispose());
  const handle = (mob) => Object.freeze({
    kind: "mob", id: mob.id, ref: mob, incarnation: 1,
    dimension: f.world.dimension, worldEpoch: f.world.epoch,
  });
  const sourceHandle = handle(source), victimHandle = handle(victim);
  const worldCurrent = captureEntityContext(f.world, f.context);
  const sourcePosition = point(source.position), victimPosition = point(victim.position);
  const current = () => worldCurrent() && runtime.available &&
    f.wildlife.byId.get(source.id) === source && !source.dead && !source.dormant &&
    f.wildlife.byId.get(victim.id) === victim && !victim.dead && !victim.dormant &&
    ["x", "y", "z"].every((axis) => source.position[axis] === sourcePosition[axis] &&
      victim.position[axis] === victimPosition[axis]);
  const roster = runtime.begin();
  assert.equal(roster.syncActors([sourceHandle, victimHandle], { validate: current }).ok, true);
  assert.equal(f.coordinator.commit(roster.finalize().participants).ok, true);
  return { ...f, source, victim, runtime, sourceHandle, victimHandle, current };
}

function prepareComposition(f, amount, kind) {
  const runtimeBatch = f.runtime.begin();
  const quote = runtimeBatch.quoteHit({
    victim: f.victimHandle, difficulty: "normal", validate: f.current,
    provenance: {
      attackKind: "melee", responsible: f.sourceHandle, responsibleSpecies: f.source.kind,
      playerOwnerId: null, sourcePosition: point(f.source.position),
      rawDamage: amount, impulse: { x: 1, y: 0, z: 0 },
      effects: [], damageOverTime: false,
    },
  });
  assert.equal(quote.ok, true);
  const baseBatch = f.wildlife.beginResidentEditBatch();
  const source = f.wildlife.contributeSourceEdit(
    baseBatch, f.source, { attackCooldown: f.source.spec.cooldown }, { validate: f.current }
  );
  const borrower = kind === "ecology" ? f.host : f.horses;
  const victim = borrower.contributeHit(
    baseBatch, f.victim.id, quote.preArmorDamage, { x: 1, y: 0, z: 0 },
    { retaliate: false, validate: f.current }
  );
  const complete = finishResidentBatch(f.wildlife, baseBatch, [source, victim]);
  assert.equal(complete.results[1].hit, true);
  // Adapt the actual finalized owner result, not an invented health success.
  const ownerPlan = Object.freeze({
    ok: true, prepared: true, participants: complete.participants,
    result: Object.freeze({ ...complete.results[1], ok: true }),
  });
  assert.equal(runtimeBatch.acceptHit(quote, ownerPlan).ok, true);
  return { runtimeBatch, ownerPlan };
}

const snapshot = (f) => ({
  owners: residentState(f), runtimeRevision: f.runtime.revision,
  actors: f.runtime.actors, shots: f.runtime.shots, blasts: f.runtime.blasts,
});

for (const kind of ["horse", "ecology", "mounted"]) {
  test(`runtime and ${kind} owner share one source/victim base transaction`, (t) => {
    const f = compositionFixture(t, kind), before = snapshot(f);
    const health = f.victim.health, baseRevision = f.wildlife._ecologyRevision;
    const runtimeRevision = f.runtime.revision;
    const { runtimeBatch, ownerPlan } = prepareComposition(f, kind === "mounted" ? 1000 : 2, kind);
    const plan = runtimeBatch.finalize({ participants: ownerPlan.participants });
    assert.equal(plan.ok, true);
    assert.equal(new Set(plan.participants.map((part) => part.owner)).size, plan.participants.length);
    assert.equal(plan.participants.filter((part) => part.owner === f.runtime).length, 1);
    assert.equal(plan.participants.filter((part) => part.owner === f.wildlife).length, 1);
    assert.deepEqual(snapshot(f), before, "every owner remains unchanged during both preparations");
    for (const owner of plan.participants.map((part) => part.owner)) {
      const refused = f.coordinator.commit(plan.participants.map((part) =>
        part.owner === owner ? { ...part, validate: () => false } : part));
      assert.equal(refused.ok, false);
      assert.deepEqual(snapshot(f), before, "each individual veto preserves all owners");
    }
    const committed = f.coordinator.commit(plan.participants);
    assert.equal(committed.ok, true);
    assert.deepEqual(committed.observerErrors, []);
    assert.equal(f.runtime.revision, runtimeRevision + 1);
    assert.equal(f.wildlife._ecologyRevision, baseRevision + 1);
    assert.equal(f.source.attackCooldown, f.source.spec.cooldown);
    assert.equal(f.victim.health, kind === "mounted" ? 0 : health - 2);
    assert.equal(f.runtime.actor(f.victimHandle).hurt.difficultyAdjustedFullDamage,
      kind === "mounted" ? 1000 : 2);
    assert.equal(f.runtime.actor(f.victimHandle).credit, null, "uncredited source does not mint XP credit");
    if (kind === "mounted") {
      assert.equal(f.horses.mountFor(), null);
      assert.equal(f.wildlife.byId.has(f.victim.id), false);
      assert.equal(f.horses.state(f.victim.id).alive, false);
      assert.deepEqual(f.horses.poseForArchive(), ownerPlan.result.exit);
      assert.equal(f.totals().drops.filter((drop) => drop.id === ITEM.SADDLE).length, 1);
      assert.equal(f.totals().xp, 0);
    }
    const after = snapshot(f);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(snapshot(f), after, "the composed contact cannot replay");
  });
}

test("runtime finalization cannot omit a required finalized horse peer", (t) => {
  const f = compositionFixture(t, "horse"), before = snapshot(f);
  const { runtimeBatch, ownerPlan } = prepareComposition(f, 2, "horse");
  const incomplete = runtimeBatch.finalize({
    participants: ownerPlan.participants.filter((part) => part.owner !== f.horses),
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, "missing-owner-participant");
  assert.deepEqual(snapshot(f), before);
});
