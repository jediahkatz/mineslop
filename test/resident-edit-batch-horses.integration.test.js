import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { MAX_EXPERIENCE_ORBS, MAX_ORB_EXPERIENCE } from "../src/experience-orbs.js";
import { MAX_LIVING_HORSES, MAX_RETAINED_HORSE_IDS } from "../src/horse-definitions.js";
import { emptyHorseSnapshot } from "../src/horse-save.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { horseFixture } from "./horse-fixture.js";
import {
  finishResidentBatch, residentRiderFixture, residentSource, residentState, residentWear,
} from "./resident-edit-batch-fixture.js";

function horsePair(t, options) {
  const f = horseFixture(t, options);
  f.source = residentSource(f);
  f.horse = f.spawn();
  return f;
}

function contributeHorse(f, amount = 3, options = {}) {
  const batch = f.wildlife.beginResidentEditBatch();
  const source = f.wildlife.contributeSourceEdit(batch, f.source, { attackCooldown: f.source.spec.cooldown });
  const victim = f.horses.contributeHit(batch, f.horse.id, amount, { x: 1, y: 0, z: 0 }, options);
  return { batch, source, victim };
}

test("an untracked wild horse contributes through Horses, never legacy base damage", (t) => {
  const f = horsePair(t), w = f.wildlife, health = f.horse.health;
  const identities = { entities: w.entities, byId: w.byId, living: f.horses._living, entries: f.horses._entries };
  assert.equal(f.horses.identityReserved(f.horse.id), false);
  const before = residentState(f), revision = w._ecologyRevision;
  t.mock.method(w, "damage", () => assert.fail("Every new-path horse hit belongs to Horses"));
  t.mock.method(w, "random", () => assert.fail("No RNG mutation during hit preparation"));
  const { batch, source, victim } = contributeHorse(f);
  assert.equal(victim.complete, false);
  assert.equal(f.horses.commit(victim).reason, "incomplete-resident-contribution");
  assert.equal(f.coordinator.commit(victim.peers).ok, false, "unfinalized peers cannot commit independently");
  assert.deepEqual(residentState(f), before);
  const plan = finishResidentBatch(w, batch, [source, victim]);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)), new Set([w, f.horses]));
  assert.equal(f.coordinator.commit(victim.peers).ok, false, "finalization never turns peer tokens into an action");
  assert.equal(victim.peers.every((peer) => !peer.validate && !peer.publish), true);
  assert.deepEqual(residentState(f), before);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(w._ecologyRevision, revision + 1);
  assert.equal(f.source.attackCooldown, f.source.spec.cooldown);
  assert.equal(f.horse.health, health - 3);
  assert.equal(w.byId.get(f.horse.id), f.horse);
  assert.equal(f.horses.retainsMob(f.horse), true);
  assert.equal(f.horse.tamed, false);
  assert.equal(w.entities, identities.entities);
  assert.equal(w.byId, identities.byId);
  assert.equal(f.horses._living, identities.living);
  assert.equal(f.horses._entries, identities.entries);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);

  const another = f.spawn("resident-batch:another-wild-horse");
  const denied = w.beginResidentEditBatch();
  const first = w.contributeSourceEdit(denied, f.source, { attackCooldown: 0.25 });
  const unchanged = residentState(f);
  assert.equal(w.contributeLegacyDamage(denied, another, 1, null), null);
  assert.equal(w.finalizeResidentEditBatch(denied, { contributions: [first] }), null);
  assert.deepEqual(residentState(f), unchanged);
});

for (const playerKill of [false, true])
  test(`source plus mounted horse death preserves saddle and safe exit (playerKill=${playerKill})`, (t) => {
    const f = residentRiderFixture(t);
    f.source = residentSource(f);
    const sword = f.hold("IRON_SWORD"), saddle = f.horses.state(f.horse.id).saddle;
    const seat = f.horses.riderPose(), revision = f.wildlife._ecologyRevision;
    const before = residentState(f), wear = residentWear(f);
    const { batch, source, victim } = contributeHorse(f, 1000, {
      playerKill, validate: () => true, participants: [wear],
    });
    assert.equal(victim.complete, false);
    assert.deepEqual(residentState(f), before, "neither rider, health nor rewards publish while preparing");
    const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
    assert.deepEqual(new Set(plan.participants.map((part) => part.owner)), new Set([
      f.wildlife, f.horses, f.gameplay, f.overflow, ...(playerKill ? [f.experience] : []),
    ]));
    const result = plan.results[1];
    assert.deepEqual(result.exit.position, seat.position);
    assert.deepEqual(result.exit.velocity, seat.velocity);
    assert.equal(result.exit.grounded, false);
    assert.equal(f.coordinator.commit(plan.participants).ok, true);
    assert.equal(f.wildlife._ecologyRevision, revision + 1);
    assert.equal(f.source.attackCooldown, f.source.spec.cooldown);
    assert.equal(f.horse.dead, true);
    assert.equal(f.horse.health, 0);
    assert.equal(f.wildlife.byId.has(f.horse.id), false);
    assert.equal(f.wildlife.killed.has(f.horse.id), false);
    assert.equal(f.wildlife._retainedHorseIds.has(f.horse.id), false);
    assert.equal(f.horses.mountFor(), null);
    assert.equal(f.horses.ownsMotionThisFrame(f.horse), true);
    assert.deepEqual(f.horses.state(f.horse.id), { id: f.horse.id, dimension: "overworld", alive: false });
    assert.deepEqual(f.horses.poseForArchive(), result.exit);
    assert.deepEqual(f.horses.takeExitPose(), result.exit);
    assert.equal(f.horses.takeExitPose(), null);
    assert.deepEqual(f.totals().drops.find((drop) => drop.id === ITEM.SADDLE).data, saddle.data);
    assert.equal(f.totals().drops.filter((drop) => drop.id === ITEM.LEATHER).length, 1);
    assert.equal(f.totals().xp, result.experience);
    assert.equal(playerKill ? result.experience > 0 : result.experience === 0, true);
    assert.equal(f.gameplay.getHandStack().durability, sword.durability - 1);
    const after = residentState(f);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(residentState(f), after);
  });

for (const missing of ["horses", "overflow", "experience", "gameplay", "copied-peer"])
  test(`omitting ${missing} cannot finalize a horse contribution`, (t) => {
    const f = residentRiderFixture(t);
    f.source = residentSource(f);
    f.hold("IRON_SWORD");
    const { batch, source, victim } = contributeHorse(f, 1000, {
      playerKill: true, validate: () => true, participants: [residentWear(f)],
    });
    assert.equal(victim.complete, false);
    const peers = missing === "copied-peer" ? victim.peers.map((part) => ({ ...part })) :
      victim.peers.filter((part) => part.owner !== f[missing]);
    const before = residentState(f);
    assert.equal(f.wildlife.finalizeResidentEditBatch(batch, {
      contributions: [source, victim], participants: peers,
    }), null);
    assert.equal(f.coordinator.commit(victim.peers).ok, false, "failed finalization also invalidates its peers");
    assert.deepEqual(residentState(f), before);
  });

test("a pre-existing standalone hit plan cannot be concatenated with a shared source edit", (t) => {
  const f = horsePair(t), w = f.wildlife;
  const hit = f.horses.prepareHit(f.horse.id, 3);
  assert.equal(hit.ok, true, "the standalone compatibility API is still complete");
  const batch = w.beginResidentEditBatch();
  const source = w.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
  const before = residentState(f);
  assert.equal(w.finalizeResidentEditBatch(batch, {
    contributions: [source], participants: hit.participants,
  }), null, "must re-prepare as a contribution, never drop one Wildlife callback");
  assert.deepEqual(residentState(f), before);
  assert.equal(f.horses.commit(hit).ok, true, "the independent standalone plan remains its own action");
});

test("two horse sidecar writers refuse rather than deduplicate either domain callback", (t) => {
  const f = horsePair(t), other = f.spawn("resident-batch:other-horse"), w = f.wildlife;
  const { batch, source, victim } = contributeHorse(f);
  const before = residentState(f);
  const duplicateOwner = f.horses.contributeHit(batch, other.id, 1, null);
  assert.equal(duplicateOwner.ok, false);
  assert.equal(w.finalizeResidentEditBatch(batch, {
    contributions: [source, victim], participants: victim.peers,
  }), null);
  assert.deepEqual(residentState(f), before);
});

for (const refusal of ["drop-capacity", "xp-capacity", "unsafe-exit"])
  test(`${refusal} poisons a horse batch without source payment or partial death`, (t) => {
    const f = residentRiderFixture(t, { overflowEntries: refusal === "drop-capacity" ? 1 : undefined });
    f.source = residentSource(f);
    f.hold("IRON_SWORD");
    if (refusal === "xp-capacity") assert.equal(f.experience.spawn(
      MAX_EXPERIENCE_ORBS * MAX_ORB_EXPERIENCE, { x: 24.5, y: 2, z: 24.5 },
    ), true);
    if (refusal === "unsafe-exit") f.put([[8, 10, 8, BLOCK.STONE]]);
    const before = residentState(f);
    const { batch, source, victim } = contributeHorse(f, 1000, {
      playerKill: true, validate: () => true, participants: [residentWear(f)],
    });
    assert.equal(victim.ok, false);
    assert.equal(f.wildlife.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
    assert.deepEqual(residentState(f), before);
    assert.equal(f.horses.mountFor().id, f.horse.id);
    assert.equal(f.horses._pendingExit, null);
  });

test("a filled living sidecar or permanent identity ledger cannot be ignored after adding a source", (t) => {
  for (const capacity of ["living", "identities"]) {
    const f = horseFixture(t, { bind: capacity !== "identities" });
    if (capacity === "identities") {
      assert.equal(f.horses.load({ ...emptyHorseSnapshot(f.context),
        entries: Array.from({ length: MAX_RETAINED_HORSE_IDS }, (_, i) => ({
          id: `resident-batch:dead:${i}`, dimension: "overworld", alive: false,
        })),
      }), true);
      assert.equal(f.horses.bindWildlife(f.wildlife), true);
    } else for (let i = 0; i < MAX_LIVING_HORSES; i++)
      assert.equal(f.horses.track(f.spawn(`resident-batch:tracked:${i}`).id).ok, true);
    f.source = residentSource(f);
    f.horse = f.spawn("resident-batch:unretained");
    const before = residentState(f), { batch, source, victim } = contributeHorse(f);
    assert.equal(victim.reason, "horse-capacity-or-reserved-id");
    assert.equal(f.wildlife.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
    assert.deepEqual(residentState(f), before);
  }
});

test("the real shared save budget veto preserves both edits and can retry the unchanged complete plan", (t) => {
  const f = horsePair(t), { batch, source, victim } = contributeHorse(f);
  const plan = finishResidentBatch(f.wildlife, batch, [source, victim]), blocker = {};
  assert.equal(f.coordinator.register(blocker, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes), true);
  const before = residentState(f);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(residentState(f), before);
  assert.equal(f.coordinator.release(blocker), true);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
});

test("a prepared rider death rechecks the actual seat before releasing anything", (t) => {
  const f = residentRiderFixture(t);
  f.source = residentSource(f);
  const { batch, source, victim } = contributeHorse(f, 1000);
  const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
  f.put([[8, 10, 8, BLOCK.STONE]]);
  const before = residentState(f);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(residentState(f), before);
  assert.equal(f.horses.mountFor().id, f.horse.id);
  assert.equal(f.horses._pendingExit, null);
});

for (const stale of ["health", "position", "yaw", "sidecar-revision", "player-life", "hand", "host", "epoch"])
  test(`horse ${stale} guards survive shared-batch preparation`, (t) => {
    const f = horsePair(t);
    f.hold("IRON_SWORD");
    const { batch, source, victim } = contributeHorse(f, 3, {
      playerKill: true, validate: () => true, participants: [residentWear(f)],
    });
    const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
    if (stale === "health") f.horse.health--;
    if (stale === "position") f.horse.position.x += 0.1;
    if (stale === "yaw") f.horse.root.rotation.y += 0.1;
    if (stale === "sidecar-revision") f.horses.resetInput();
    if (stale === "player-life") f.actor.targetKey = "player:horse-replacement-life";
    if (stale === "hand") f.hold("IRON_SWORD");
    if (stale === "host") assert.equal(f.horses.suspend(), true);
    if (stale === "epoch") assert.equal(f.world.loadEdits(f.world.serialize()), true);
    const before = residentState(f);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(residentState(f), before);
  });

test("source editing never bypasses direct-player current reach or required authorization", (t) => {
  for (const guard of ["missing", "out-of-reach"]) {
    const f = horsePair(t);
    if (guard === "out-of-reach") f.actor.position = { x: 28.5, y: 1, z: 28.5 };
    const before = residentState(f);
    const { batch, source, victim } = contributeHorse(f, 2, {
      playerKill: true, ...(guard === "missing" ? {} : { validate: () => true }),
    });
    assert.equal(victim.ok, false);
    assert.equal(f.wildlife.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
    assert.deepEqual(residentState(f), before);
  }
});

test("horse death observer reentry sees source, safe release and resources already committed", (t) => {
  let f, plan, observed = false;
  f = residentRiderFixture(t, { hooks: { onEvent: (event) => {
    if (event.type !== "death") return;
    observed = true;
    assert.equal(f.source.attackCooldown, f.source.spec.cooldown);
    assert.equal(f.wildlife.byId.has(event.id), false);
    assert.equal(f.horses.mountFor(), null);
    assert.deepEqual(f.horses.poseForArchive(), event.exit);
    assert.ok(f.totals().xp > 0);
    assert.equal(f.totals().drops.length, 2);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    const nested = f.wildlife.beginResidentEditBatch();
    const entry = f.wildlife.contributeSourceEdit(nested, f.source, { attackCooldown: 0.25 });
    assert.equal(f.coordinator.commit(finishResidentBatch(f.wildlife, nested, [entry]).participants).ok, true);
    throw new Error("Deliberate horse observer failure");
  } } });
  f.source = residentSource(f);
  const { batch, source, victim } = contributeHorse(f, 1000, { playerKill: true, validate: () => true });
  plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
  const result = f.coordinator.commit(plan.participants);
  assert.equal(result.ok, true);
  assert.equal(observed, true);
  assert.equal(result.observerErrors.length, 1);
  assert.equal(f.source.attackCooldown, 0.25);
});
