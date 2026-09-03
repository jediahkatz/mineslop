import assert from "node:assert/strict";
import test from "node:test";
import {
  ecologyCanTarget, ecologyDistance, ecologyEye, ecologyLineOfSight,
} from "../src/aquatic-ai.js";
import { BLOCK } from "../src/blocks.js";
import { ecologyHostFixture } from "./ecology-host-fixture.js";
import { monumentFixture } from "./ecology-fixtures.js";
import { finishResidentBatch, residentState } from "./resident-edit-batch-fixture.js";

function playerFacts(f) {
  const view = f.view();
  return {
    health: view.health, targetKey: view.targetKey, dimension: view.dimension,
    mode: view.mode, invulnerable: view.invulnerable, swimming: view.swimming,
    position: view.position, eye: view.eye,
    worldDimension: f.world.dimension, epoch: f.world.epoch, hostActive: f.host.active,
  };
}

function targetFacts(f, mob) {
  const ctx = f.host.readRuntimeContext();
  return {
    canonical: f.wildlife.byId.get(mob.id) === mob,
    targetable: !!ctx && ecologyCanTarget(mob, ctx),
    withinReach: !!ctx && ecologyDistance(ecologyEye(mob), ctx.playerEye) <= 3,
    lineOfSight: !!ctx && ecologyLineOfSight(f.world, ecologyEye(mob), ctx.playerEye),
    spikesExtended: mob.spikesExtended,
  };
}

function reflectionState(f) {
  const ctx = f.wildlife.context;
  return {
    owners: residentState(f), player: playerFacts(f), changes: f.changes,
    ai: {
      health: ctx.health, targetKey: ctx.playerTargetKey, dimension: ctx.playerDimension,
      mode: ctx.mode, swimming: ctx.playerSwimming, invulnerable: ctx.playerInvulnerable,
    },
    spikes: f.guardians.map((mob) => mob.spikesExtended),
    damage: structuredClone(f.damage),
  };
}

function reflectionFixture(t, { health = 20, afterFirst } = {}) {
  const f = ecologyHostFixture(t), { structure } = monumentFixture();
  f.markerIndex.add(structure);
  f.guardians = [1.5, 2.5].map((x) => f.admit("guardian", { x, y: 2, z: 1.5 }, { structure }));
  f.player.position = { x: 1.5, y: 2, z: 3.5 };
  for (const mob of f.guardians) mob.spikesExtended = 1;
  if (health < 20) assert.equal(f.gameplay.damage(20 - health, "fixture health"), 20 - health);
  f.notices = [];
  f.damageObservations = [];
  const lifetime = f.host._guard();

  // Observe each original afterHit, including notifications that skip retaliation.
  const prepare = f.host._prepareHitParts;
  t.mock.method(f.host, "_prepareHitParts", function (id, amount, direction, options, add) {
    return prepare.call(this, id, amount, direction, options, (domain, edit) => add(domain, {
      ...edit,
      notify: () => {
        const mob = f.guardians.find((entry) => entry.id === id);
        f.notices.push({ id, guardianHealth: f.guardians.map((entry) => entry.health),
          lifetimeCurrent: lifetime(), target: targetFacts(f, mob) });
        return edit.notify();
      },
    }));
  });

  const onDamage = f.wildlife.onDamage;
  t.mock.method(f.wildlife, "onDamage", function (...args) {
    const before = playerFacts(f), result = onDamage.apply(this, args);
    const afterDamage = playerFacts(f);
    f.damageObservations.push({ before, afterDamage, guardianHealth: f.guardians.map((mob) => mob.health) });
    if (f.damage.length === 1) afterFirst?.(f);
    return result;
  });
  return f;
}

function hitOptions(f, mob) {
  return {
    playerKill: true,
    validate: () => f.wildlife.byId.get(mob.id) === mob && !mob.dead,
    hit: { id: `guardian-hit-${f.guardians.indexOf(mob)}`, source: "player", kind: "melee" },
  };
}

function prepareReflections(f, singleIndex) {
  const before = reflectionState(f), notices = f.notices.length;
  let plan;
  if (singleIndex === undefined) {
    const batch = f.wildlife.beginResidentEditBatch();
    const contributions = f.guardians.map((mob) =>
      f.host.contributeHit(batch, mob.id, 2, null, hitOptions(f, mob)));
    plan = finishResidentBatch(f.wildlife, batch, contributions);
  } else {
    const mob = f.guardians[singleIndex];
    plan = f.host.prepareHit(mob.id, 2, null, hitOptions(f, mob));
  }
  assert.ok(plan);
  assert.deepEqual(reflectionState(f), before, "detached preparation has no owner, player, AI or damage effects");
  assert.equal(f.notices.length, notices, "preparation must not invoke afterHit");
  return plan;
}

function commitReflections(f, plan, { standalone = false } = {}) {
  return standalone ? f.host.commit(plan) : f.coordinator.commit(plan.participants);
}

function assertReplaySilent(f, plan, standalone = false) {
  const before = reflectionState(f), notices = f.notices.length;
  assert.equal(commitReflections(f, plan, { standalone }).ok, false);
  assert.deepEqual(reflectionState(f), before);
  assert.equal(f.notices.length, notices, "a replay must not enter either afterHit again");
}

test("accepted guardian batch reflects both player-credited hits after real Gameplay damage", (t) => {
  const f = reflectionFixture(t), plan = prepareReflections(f);
  assert.equal(f.damage.length, 0);
  const result = commitReflections(f, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, []);
  assert.deepEqual(f.guardians.map((mob) => mob.health), [28, 28]);
  assert.deepEqual(f.notices.map((entry) => entry.id), f.guardians.map((mob) => mob.id));
  for (const entry of f.notices) {
    assert.deepEqual(entry.guardianHealth, [28, 28], "all base edits precede the first notification");
    assert.equal(entry.lifetimeCurrent, true);
    assert.deepEqual(entry.target, {
      canonical: true, targetable: true, withinReach: true, lineOfSight: true, spikesExtended: 1,
    });
  }
  assertReplaySilent(f, plan);
  assert.deepEqual({
    reflectionCallbacks: f.damage.length, playerHealth: f.gameplay.health,
    reflectedSources: f.damage.map((entry) => entry.source),
  }, {
    reflectionCallbacks: 2, playerHealth: 16, reflectedSources: f.guardians.map((mob) => mob.id),
  });
  assert.deepEqual(f.damageObservations.map((entry) => [entry.before.health, entry.afterDamage.health]),
    [[20, 18], [18, 16]]);
});

for (const stale of ["health", "life"])
  test(`guardian batch still vetoes stale player ${stale} before publication`, (t) => {
    const f = reflectionFixture(t), plan = prepareReflections(f);
    if (stale === "health") assert.equal(f.gameplay.damage(1, "precommit damage"), 1);
    else f.player.targetKey = "player:life:replacement";
    const before = reflectionState(f);
    assert.equal(commitReflections(f, plan).ok, false);
    assert.deepEqual(reflectionState(f), before, "no participant or reflection may publish after a stale read");
    assert.deepEqual(f.guardians.map((mob) => mob.health), [30, 30]);
    assert.equal(f.damage.length, 0);
    assert.equal(f.notices.length, 0);
  });

const interruptions = [
  {
    name: "replacement life with the original health", expectedHealth: 20,
    change(f) {
      assert.equal(f.gameplay.damage(100, "observer death"), 18);
      assert.equal(f.gameplay.dead, true);
      assert.equal(f.gameplay.respawn(), true);
      f.player.targetKey = "player:life:replacement";
    },
  },
  { name: "player killed by the first reflection", health: 2, expectedHealth: 0 },
  { name: "player in another dimension", change: (f) => { f.player.dimension = "nether"; } },
  { name: "creative player", expectedHealth: 20, change: (f) => { assert.equal(f.gameplay.setMode("creative"), true); } },
  { name: "invulnerable player", change: (f) => { f.player.invulnerable = true; } },
  { name: "spawn-protected player", change: (f) => { f.wildlife.context.spawnProtected = true; } },
  { name: "player outside reflection reach", change: (f) => { f.player.position.z = 10.5; } },
  {
    name: "blocked current line of sight",
    change(f) {
      for (const x of [1, 2])
        for (const y of [2, 3]) f.put(x, y, 2, BLOCK.STONE);
      assert.equal(targetFacts(f, f.guardians[1]).lineOfSight, false);
    },
  },
  { name: "changed world dimension", change: (f) => { f.world.setDimension("nether"); } },
  { name: "changed world epoch", change: (f) => { assert.equal(f.world.loadEdits(f.world.serialize()), true); } },
  { name: "suspended ecology host", change: (f) => { assert.equal(f.host.suspend(), true); } },
];

for (const interruption of interruptions)
  test(`guardian batch skips the second reflection for ${interruption.name} between notifications`, (t) => {
    const f = reflectionFixture(t, { health: interruption.health, afterFirst: interruption.change });
    const plan = prepareReflections(f), result = commitReflections(f, plan);
    assert.equal(result.ok, true, "postcommit ineligibility does not undo already accepted guardian damage");
    assert.deepEqual(result.observerErrors, []);
    assert.deepEqual(f.guardians.map((mob) => mob.health), [28, 28]);
    assert.deepEqual(f.notices.map((entry) => entry.id), f.guardians.map((mob) => mob.id));
    assert.equal(f.damage.length, 1);
    assert.equal(f.damage[0].source, f.guardians[0].id);
    assert.deepEqual(f.damageObservations[0].guardianHealth, [28, 28]);
    assert.equal(f.gameplay.health, interruption.expectedHealth ?? 18);
    assertReplaySilent(f, plan);
  });

test("standalone guardian hits retain fresh context synchronization and exactly-once reflection", (t) => {
  const f = reflectionFixture(t);
  assert.equal(f.gameplay.setMode("creative"), true);
  f.host._syncPlayer();
  assert.equal(f.gameplay.setMode("survival"), true);
  const first = prepareReflections(f, 0);
  assert.equal(f.wildlife.context.mode, "creative", "preparation must not synchronize the shared AI context");
  assert.equal(f.damage.length, 0);
  const firstResult = commitReflections(f, first, { standalone: true });
  assert.equal(firstResult.ok, true);
  assert.deepEqual(firstResult.observerErrors, []);
  assert.equal(f.wildlife.context.mode, "survival");
  assert.equal(f.gameplay.health, 18);
  assert.equal(f.damage.length, 1);
  assertReplaySilent(f, first, true);
  const second = prepareReflections(f, 1), secondResult = commitReflections(f, second, { standalone: true });
  assert.equal(secondResult.ok, true);
  assert.deepEqual(secondResult.observerErrors, []);
  assert.equal(f.gameplay.health, 16);
  assert.deepEqual(f.guardians.map((mob) => mob.health), [28, 28]);
  assert.deepEqual(f.damage.map((entry) => entry.source), f.guardians.map((mob) => mob.id));
  assertReplaySilent(f, second, true);
});
