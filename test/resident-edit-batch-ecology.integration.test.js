import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ecologyEncounterProjection } from "../src/ecology-save.js";
import { createEcologyState, ECOLOGY_LIMITS } from "../src/expansion-ecology.js";
import { MAX_EXPERIENCE_ORBS, MAX_ORB_EXPERIENCE } from "../src/experience-orbs.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  ecologyHostFixture, ecologyTotals, ecologyVillage,
} from "./ecology-host-fixture.js";
import { monumentFixture } from "./ecology-fixtures.js";
import {
  finishResidentBatch, residentBorrowersFixture, residentSource, residentState, residentWear,
} from "./resident-edit-batch-fixture.js";

function guardianPair(t, options) {
  const f = ecologyHostFixture(t, options), { structure } = monumentFixture();
  f.markerIndex.add(structure);
  f.mob = f.admit("guardian", { x: 1.5, y: 2, z: 1.5 }, { structure });
  f.source = residentSource(f, { position: { x: 24.5, y: 7, z: 24.5 } });
  return f;
}

function contributeEcology(f, amount = 1000, options = {}) {
  const batch = f.wildlife.beginResidentEditBatch();
  const source = f.wildlife.contributeSourceEdit(batch, f.source, { attackCooldown: f.source.spec.cooldown });
  const victim = f.host.contributeHit(batch, f.mob.id, amount, { x: 1, y: 0, z: 0 }, options);
  return { batch, source, victim };
}

test("one real Wildlife batch composes source, legacy, horse and ecology nonlethal edits", (t) => {
  const f = residentBorrowersFixture(t), w = f.wildlife;
  const sourceMob = residentSource(f), horse = f.spawn(), turtle = f.admitTurtle();
  const cow = w.spawn("cow", { x: 18.5, y: 1, z: 8.5 }, { id: "resident-batch:mixed-cow" });
  assert.ok(cow);
  const before = residentState(f), batch = w.beginResidentEditBatch(), revision = w._ecologyRevision;
  t.mock.method(w, "random", () => assert.fail("The mixed batch cannot draw RNG"));
  const source = w.contributeSourceEdit(batch, sourceMob, { attackCooldown: 0.25 });
  const legacy = w.contributeLegacyDamage(batch, cow, 2, null);
  const equine = f.horses.contributeHit(batch, horse.id, 3, null);
  const ecology = f.host.contributeHit(batch, turtle.id, 4, null);
  assert.equal(f.host.commit(ecology).reason, "incomplete-resident-contribution");
  const plan = finishResidentBatch(w, batch, [source, legacy, equine, ecology]);
  assert.deepEqual(residentState(f), before);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)), new Set([w, f.horses]));
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(w._ecologyRevision, revision + 1);
  assert.equal(sourceMob.attackCooldown, 0.25);
  assert.equal(cow.health, cow.spec.health - 2);
  assert.equal(horse.health, horse.spec.health - 3);
  assert.equal(turtle.health, turtle.spec.health - 4);
  assert.equal(w.byId.get(horse.id), horse);
  assert.equal(w.byId.get(turtle.id), turtle);
  assert.equal(f.horses.retainsMob(horse), true);
  assert.equal(f.host.ecology.state(turtle.id).alive, true);
  assert.ok(f.host.serialize(), "horse/ecology save links remain canonical after the mixed edit");
});

test("two borrower removals preserve live array/map identity and install descending prevalidated indices", (t) => {
  const f = residentBorrowersFixture(t), w = f.wildlife;
  const sourceMob = residentSource(f), horse = f.spawn(), turtle = f.admitTurtle();
  const entities = w.entities, byId = w.byId, revision = w._ecologyRevision;
  const batch = w.beginResidentEditBatch();
  const source = w.contributeSourceEdit(batch, sourceMob, { attackCooldown: 0.25 });
  const equine = f.horses.contributeHit(batch, horse.id, 1000, null);
  const ecology = f.host.contributeHit(batch, turtle.id, 1000, null);
  const plan = finishResidentBatch(w, batch, [source, equine, ecology]);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([w, f.horses, f.host.ecology, f.overflow]));
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(w.entities, entities);
  assert.equal(w.byId, byId);
  assert.equal(w._ecologyRevision, revision + 1);
  assert.deepEqual(w.entities, [sourceMob]);
  assert.equal(w.byId.get(sourceMob.id), sourceMob);
  assert.equal(w.byId.has(horse.id), false);
  assert.equal(w.byId.has(turtle.id), false);
  assert.equal(f.horses.state(horse.id).alive, false);
  assert.equal(f.host.ecology.state(turtle.id).alive, false);
  assert.equal(w.killed.size, 0);
  assert.ok(f.host.serialize());
});

test("guardian death joins exact domain, drop, XP and hand-cost peers with one source/victim base publication", (t) => {
  const f = guardianPair(t), w = f.wildlife;
  const sword = f.hold("IRON_SWORD", { durability: 9 }), revision = w._ecologyRevision;
  const before = residentState(f);
  const { batch, source, victim } = contributeEcology(f, 1000, {
    playerKill: true, validate: () => true, participants: [residentWear(f)],
  });
  assert.equal(victim.complete, false);
  assert.equal(f.coordinator.commit(victim.peers).ok, false);
  assert.deepEqual(residentState(f), before);
  const plan = finishResidentBatch(w, batch, [source, victim]);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([w, f.host.ecology, f.overflow, f.experienceOrbs, f.gameplay]));
  assert.equal(f.coordinator.commit(victim.peers).ok, false, "only the complete final plan exposes publishers");
  assert.deepEqual(residentState(f), before);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(w._ecologyRevision, revision + 1);
  assert.equal(f.source.attackCooldown, f.source.spec.cooldown);
  assert.equal(f.mob.health, 0);
  assert.equal(f.mob.dead, true);
  assert.equal(w.byId.has(f.mob.id), false);
  assert.equal(f.host.ecology.state(f.mob.id).alive, false);
  assert.equal(w.killed.has(f.mob.id), false);
  assert.equal(f.gameplay.getHandStack().durability, sword.durability - 1);
  assert.deepEqual(ecologyTotals(f), {
    drops: { [ITEM.PRISMARINE_SHARD]: 2, [ITEM.PRISMARINE_CRYSTALS]: 1 }, xp: 5,
  });
  const committed = residentState(f);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(residentState(f), committed);
  const restored = ecologyHostFixture(t, { saved: f.snapshot() });
  assert.equal(restored.wildlife.byId.has(f.mob.id), false);
  assert.deepEqual(ecologyTotals(restored), ecologyTotals(f));
  assert.equal(restored.wildlife.byId.get(f.source.id).attackCooldown, f.source.spec.cooldown);
});

for (const missing of ["ecology", "overflow", "experienceOrbs", "gameplay"])
  test(`missing ${missing} peer poisons an ecology death batch`, (t) => {
    const f = guardianPair(t);
    f.hold("IRON_SWORD");
    const { batch, source, victim } = contributeEcology(f, 1000, {
      playerKill: true, validate: () => true, participants: [residentWear(f)],
    });
    const owner = missing === "ecology" ? f.host.ecology : f[missing], before = residentState(f);
    assert.equal(f.wildlife.finalizeResidentEditBatch(batch, {
      contributions: [source, victim], participants: victim.peers.filter((part) => part.owner !== owner),
    }), null);
    assert.equal(f.coordinator.commit(victim.peers).ok, false);
    assert.deepEqual(residentState(f), before);
  });

test("ecology hit preparation reads current player facts without mutating shared AI/player state", (t) => {
  const f = guardianPair(t);
  f.player.position = { x: 7.5, y: 2, z: 10.5 };
  f.player.targetKey = "player:unsynced-current-life";
  const before = residentState(f);
  const { batch, source, victim } = contributeEcology(f, 2, { playerKill: true, validate: () => true });
  const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
  assert.deepEqual(residentState(f), before);
  f.player.targetKey = "player:replacement-life";
  const unchanged = residentState(f);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(residentState(f), unchanged);
});

test("the existing guardian reflection bridge synchronizes current player facts only after commit", (t) => {
  const f = guardianPair(t);
  assert.equal(f.gameplay.setMode("creative"), true);
  f.host._syncPlayer();
  assert.equal(f.gameplay.setMode("survival"), true);
  f.player.position = { x: 1.5, y: 2, z: 3.5 };
  f.mob.spikesExtended = 1;
  const before = residentState(f);
  const { batch, source, victim } = contributeEcology(f, 2, {
    playerKill: true, validate: () => true,
    hit: { id: "resident-batch:direct-melee", source: "player", kind: "melee" },
  });
  const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
  assert.deepEqual(residentState(f), before);
  assert.equal(f.wildlife.context.mode, "creative", "preparation must not rewrite even a stale AI view");
  assert.equal(f.damage.length, 0);
  const result = f.coordinator.commit(plan.participants);
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(f.mob.health, f.mob.spec.health - 2);
  assert.equal(f.wildlife.context.mode, "survival");
  assert.equal(f.damage.length, 1);
  assert.equal(f.damage[0].amount, 2);
  assert.equal(f.gameplay.health, 18);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.damage.length, 1);
});

test("a full ecology sidecar can retire an existing resident without allocating another identity", (t) => {
  const original = guardianPair(t), saved = original.snapshot();
  for (let i = 1; i < ECOLOGY_LIMITS.entries; i++) {
    const state = createEcologyState("turtle", `resident-batch:tombstone:${i}`,
      { x: 24.5, y: 1, z: 24.5 }, original.context);
    assert.ok(state);
    saved.ecology.ecology.entries.push({ ...state, alive: false });
  }
  const f = ecologyHostFixture(t, { saved });
  f.wildlife._wakeEcology();
  f.mob = f.wildlife.byId.get(original.mob.id);
  f.source = f.wildlife.byId.get(original.source.id);
  assert.equal(f.mob.dormant, false);
  assert.equal(f.host.ecology.serialize().entries.length, ECOLOGY_LIMITS.entries);
  const { batch, source, victim } = contributeEcology(f);
  const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.host.ecology.serialize().entries.length, ECOLOGY_LIMITS.entries);
  assert.equal(f.host.ecology.state(f.mob.id).alive, false);
});

for (const refusal of ["drops-full", "xp-full", "save-budget"])
  test(`real ecology ${refusal} cannot pay the source or leave a partial corpse`, (t) => {
    const f = guardianPair(t, { maxEntries: refusal === "drops-full" ? 1 : undefined });
    f.hold("IRON_SWORD");
    if (refusal === "xp-full") assert.equal(f.experienceOrbs.spawn(
      MAX_EXPERIENCE_ORBS * MAX_ORB_EXPERIENCE, { x: 24.5, y: 2, z: 24.5 },
    ), true);
    const blocker = {};
    if (refusal === "save-budget")
      assert.equal(f.coordinator.register(blocker, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes), true);
    const before = residentState(f), { batch, source, victim } = contributeEcology(f, 1000, {
      playerKill: true, validate: () => true, participants: [residentWear(f)],
    });
    if (refusal !== "save-budget") {
      assert.equal(victim, null);
      assert.equal(f.wildlife.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
    } else {
      const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
      assert.equal(f.coordinator.commit(plan.participants).ok, false);
      assert.deepEqual(residentState(f), before);
      assert.equal(f.coordinator.release(blocker), true);
      assert.equal(f.coordinator.commit(plan.participants).ok, true);
      return;
    }
    assert.deepEqual(residentState(f), before);
  });

for (const stale of ["health", "position", "ecology-revision", "player-life", "player-position", "world-edit", "chunk-aba", "epoch", "host"])
  test(`ecology ${stale} guards veto all shared participants`, (t) => {
    const f = guardianPair(t), { batch, source, victim } = contributeEcology(f, 1000, {
      playerKill: true, validate: () => true,
    });
    const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
    if (stale === "health") f.mob.health--;
    if (stale === "position") f.mob.position.x += 0.1;
    if (stale === "ecology-revision") f.host.ecology.invalidateAvailability();
    if (stale === "player-life") f.player.targetKey = "player:replacement-life";
    if (stale === "player-position") f.player.position.x += 0.1;
    if (stale === "world-edit") f.put(20, 2, 20, BLOCK.STONE);
    if (stale === "chunk-aba") {
      const chunk = f.world.chunks.get("0,0");
      f.world._removeChunk("0,0", chunk);
      f.world._generateSync(0, 0);
      assert.notEqual(f.world.chunks.get("0,0").incarnation, chunk.incarnation);
    }
    if (stale === "epoch") assert.equal(f.world.loadEdits(f.world.serialize()), true);
    if (stale === "host") assert.equal(f.host.suspend(), true);
    const before = residentState(f);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(residentState(f), before);
  });

test("elder completion is mandatory and remains owned by Exploration across save/restore", (t) => {
  const f = ecologyHostFixture(t), { structure, markers } = monumentFixture(), marker = markers[0];
  f.markerIndex.add(structure, markers);
  f.mob = f.admit("elder_guardian", {
    x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5,
  }, { structure, marker });
  f.source = residentSource(f, { position: { x: 24.5, y: 7, z: 24.5 } });
  let contribution = contributeEcology(f, 1000, { playerKill: true, validate: () => true });
  const before = residentState(f);
  assert.equal(f.wildlife.finalizeResidentEditBatch(contribution.batch, {
    contributions: [contribution.source, contribution.victim],
    participants: contribution.victim.peers.filter((part) => part.owner !== f.exploration),
  }), null);
  assert.deepEqual(residentState(f), before);
  contribution = contributeEcology(f, 1000, { playerKill: true, validate: () => true });
  const plan = finishResidentBatch(f.wildlife, contribution.batch, [contribution.source, contribution.victim]);
  assert.equal(plan.participants.filter((part) => part.owner === f.exploration).length, 1);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.host.ecology.elder(marker.id).status, "defeated");
  assert.equal(f.exploration.completed(ecologyEncounterProjection(marker)), true);
  assert.deepEqual(ecologyTotals(f), {
    drops: { [BLOCK.WET_SPONGE]: 1, [ITEM.PRISMARINE_SHARD]: 3, [ITEM.PRISMARINE_CRYSTALS]: 2 }, xp: 10,
  });
  const restored = ecologyHostFixture(t, { saved: f.snapshot() });
  assert.equal(restored.host.ecology.elder(marker.id).status, "defeated");
  assert.equal(restored.exploration.completed(ecologyEncounterProjection(marker)), true);
  assert.equal(restored.wildlife.byId.has(f.mob.id), false);
});

function villagerPair(t, options = {}) {
  const f = ecologyHostFixture(t, { water: -1, biomeId: "plains", ...options });
  const village = ecologyVillage(f);
  f.player.position = { x: 8.5, y: 1, z: 11.5 };
  f.mob = f.admit("villager", { x: 8.5, y: 1, z: 8.5 }, {
    structure: village.structure, marker: village.member,
  });
  const jobsite = { id: village.site.id, kind: village.site.block, dimension: "overworld", position: village.site.position };
  const register = f.trading.prepareRegister({ id: f.mob.id, profession: "farmer", jobsite }, {
    clock: { day: 0, time: 2000 }, validate: () => true,
    readAvailability: (id) => f.host.readAvailability(id, { interaction: false }),
    jobsiteUsable: (id, site) => f.host.jobsiteUsable(id, site),
  });
  assert.ok(register);
  assert.equal(f.trading.commit(register).ok, true);
  f.source = residentSource(f);
  return f;
}

test("villager contribution includes its real Trading jobsite release and never invents rewards", (t) => {
  const f = villagerPair(t), { batch, source, victim } = contributeEcology(f);
  const plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.wildlife, f.host.ecology, f.trading]));
  assert.ok(f.trading.get(f.mob.id).jobsite);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.trading.get(f.mob.id).jobsite, null);
  assert.equal(f.host.ecology.state(f.mob.id).alive, false);
  assert.deepEqual(ecologyTotals(f), { drops: {}, xp: 0 });
});

test("ignored villager release refusal poisons the source batch instead of falling back", (t) => {
  const f = villagerPair(t, { hooks: { prepareVillagerDeath: () => null } });
  const before = residentState(f), { batch, source, victim } = contributeEcology(f);
  assert.equal(victim, null);
  assert.equal(f.wildlife.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
  assert.deepEqual(residentState(f), before);
  assert.ok(f.trading.get(f.mob.id).jobsite);
});

test("a source edit does not substitute for ecology direct-player authorization", (t) => {
  const f = guardianPair(t), before = residentState(f);
  const { batch, source, victim } = contributeEcology(f, 2, { playerKill: true });
  assert.equal(victim, null);
  assert.equal(f.wildlife.finalizeResidentEditBatch(batch, { contributions: [source] }), null);
  assert.deepEqual(residentState(f), before);
});

test("ecology observer reentry sees committed source, tombstone, drops and XP exactly once", (t) => {
  let f, plan, observe = false, observed = false;
  f = guardianPair(t, { hooks: { onChange: () => {
    if (!observe) return;
    observed = true;
    assert.equal(f.source.attackCooldown, f.source.spec.cooldown);
    assert.equal(f.mob.dead, true);
    assert.equal(f.host.ecology.state(f.mob.id).alive, false);
    assert.equal(ecologyTotals(f).xp, 5);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    const nested = f.wildlife.beginResidentEditBatch();
    const source = f.wildlife.contributeSourceEdit(nested, f.source, { attackCooldown: 0.25 });
    assert.equal(f.coordinator.commit(finishResidentBatch(f.wildlife, nested, [source]).participants).ok, true);
    throw new Error("Deliberate ecology observer failure");
  } } });
  const { batch, source, victim } = contributeEcology(f, 1000, { playerKill: true, validate: () => true });
  plan = finishResidentBatch(f.wildlife, batch, [source, victim]);
  observe = true;
  const result = f.host.commit({ participants: plan.participants, result: plan.results[1] });
  assert.equal(result.ok, true);
  assert.equal(observed, true);
  assert.equal(result.observerErrors.length, 1);
  assert.equal(f.source.attackCooldown, 0.25);
});
