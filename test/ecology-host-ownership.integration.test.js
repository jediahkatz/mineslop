import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ECOLOGY_LIMITS } from "../src/expansion-ecology.js";
import { MAX_EXPERIENCE_ORBS, MAX_ORB_EXPERIENCE } from "../src/experience-orbs.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { ecologyHostFixture, ecologyTotals, ecologyVeto } from "./ecology-host-fixture.js";
import { monumentFixture } from "./ecology-fixtures.js";

const dolphinAt = { x: 8.5, y: 2, z: 8.5 };
function fedFixture(t, options) {
  const f = ecologyHostFixture(t, options);
  f.player.position = { x: 8.5, y: 2, z: 10.5 };
  f.mob = f.admit("dolphin", dolphinAt);
  return f;
}
function guardianFixture(t, options) {
  const f = ecologyHostFixture(t, options);
  const { structure } = monumentFixture();
  f.markerIndex.add(structure);
  f.mob = f.admit("guardian", { x: 1.5, y: 2, z: 1.5 }, { structure });
  f.hold("IRON_SWORD", { durability: 8, data: { version: 1, name: "Reef keeper" } });
  return f;
}
function swordHit(f, extra = {}) {
  const stack = f.gameplay.getHandStack("main");
  const cost = f.gameplay.prepareHandCost("main", {
    stack, handRevision: f.gameplay.getHandRevision("main"), wear: 1,
  });
  assert.ok(cost);
  // This authored owner test supplies the parent action guard explicitly.
  // Physical input/range/cooldown remain the unchanged Game combat suite.
  return f.host.prepareHit(f.mob.id, 1000, { x: 1, y: 0, z: 0 }, {
    playerKill: true, validate: () => true, participants: [cost], ...extra,
  });
}

test("staging and preparing leave Wildlife self-owned without advancing RNG or admitting a half mob", (t) => {
  const f = ecologyHostFixture(t, { activate: false });
  const before = f.ownership();
  assert.equal(f.coordinator.usage(f.host.ecology), undefined);
  assert.equal(f.coordinator.usage(f.wildlife), 0, "Wildlife registers itself independently of staged Ecology");
  assert.equal(f.wildlife._ownsRegistration, true);
  assert.equal(f.host.attacks, null);
  assert.equal(f.host.prepareAdmission("dolphin", dolphinAt), null);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.host.activate(f.wildlife), false, "restore is an explicit staging step");
  assert.equal(f.coordinator.usage(f.wildlife), 0, "failed activation cannot release another owner");
  assert.equal(f.host.restoreWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
  assert.equal(f.coordinator.usage(f.wildlife), 0, "activation borrows the existing base registration");
  const active = f.ownership(), generated = f.generated();
  const plan = f.host.prepareAdmission("dolphin", dolphinAt);
  assert.ok(plan);
  assert.deepEqual(f.ownership(), active);
  assert.equal(f.generated(), generated);
  assert.equal(f.host.commit(plan).ok, true);
  assert.equal(f.wildlife.randomState, active.mobs.randomState);
  assert.equal(f.wildlife.nextId, active.mobs.nextId + 1);
  assert.equal(f.host.ecology.state(plan.result.id).alive, true);
  assert.equal(f.wildlife.byId.get(plan.result.id).dead, false);
  assert.equal(f.host.commit(plan).ok, false);
  assert.equal(f.host.activate(f.wildlife), false);
  assert.equal(f.host.suspend(), true);
  assert.equal(f.coordinator.usage(f.wildlife), 0, "suspending a borrower preserves the base owner");
  assert.equal(f.host.dispose(), true);
  assert.equal(f.coordinator.usage(f.host.ecology), undefined);
  assert.equal(f.coordinator.usage(f.wildlife), 0, "disposing a borrower also preserves the base owner");
  assert.equal(f.wildlife.dispose(), true);
  assert.equal(f.coordinator.usage(f.wildlife), undefined);
  assert.equal(f.wildlife._ownsRegistration, false);
});

test("stale candidate and failed activation preserve Wildlife ownership without registering Ecology", (t) => {
  const f = ecologyHostFixture(t, { activate: false });
  assert.equal(f.host.restoreWildlife(f.wildlife), true);
  assert.equal(f.world.loadEdits(f.world.serialize()), true);
  const before = f.ownership();
  assert.equal(f.host.activate(f.wildlife), false);
  assert.equal(f.host.restoreWildlife(f.wildlife), false);
  assert.equal(f.coordinator.usage(f.host.ecology), undefined);
  assert.equal(f.coordinator.usage(f.wildlife), 0, "a stale candidate still owns its base registration");
  assert.equal(f.wildlife._ownsRegistration, true);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.wildlife.dispose(), true);
  assert.equal(f.coordinator.usage(f.wildlife), undefined);
  assert.equal(f.wildlife._ownsRegistration, false);
  const g = ecologyHostFixture(t, { activate: false });
  const blocker = {};
  assert.equal(g.coordinator.register(blocker, MAX_RESERVED_BYTES - g.coordinator.budget.totalBytes), true);
  assert.equal(g.host.restoreWildlife(g.wildlife), true);
  const full = g.ownership();
  assert.equal(g.host.activate(g.wildlife), false);
  assert.equal(g.coordinator.usage(g.host.ecology), undefined);
  assert.equal(g.coordinator.usage(g.wildlife), 0, "budget refusal cannot release the pre-existing base owner");
  assert.equal(g.wildlife._ownsRegistration, true);
  assert.deepEqual(g.ownership(), full);
  assert.equal(g.wildlife.dispose(), true);
  assert.equal(g.coordinator.usage(g.wildlife), undefined);
  assert.equal(g.wildlife._ownsRegistration, false);
});

for (const hand of ["main", "offhand"])
  test(`real ${hand} food metadata/revision joins Ecology in exactly one transaction`, (t) => {
    const f = fedFixture(t);
    const stack = f.hold("RAW_COD", { count: 2, hand, data: { version: 1, name: "Reserved catch" } });
    const before = f.ownership();
    const plan = f.host.prepareInteraction(f.mob.id, { hand });
    assert.ok(plan);
    assert.deepEqual(new Set(plan.participants.map((part) => part.owner)), new Set([f.host.ecology, f.gameplay]));
    assert.deepEqual(f.ownership(), before);
    assert.equal(f.wildlife.interact(f.mob, stack.id), false, "legacy interact-then-consume is not available");
    assert.equal(f.host.commit(plan).ok, true);
    assert.deepEqual(f.gameplay.getHandStack(hand), { ...stack, count: 1 });
    assert.equal(f.host.ecology.state(f.mob.id).assistTime, ECOLOGY_LIMITS.assistance);
    assert.equal(f.host.commit(plan).ok, false);
    assert.equal(f.host.prepareInteraction(f.mob.id, { hand }), null);
    assert.equal(f.gameplay.getHandStack(hand).count, 1);
  });

for (const reason of ["hand", "pose", "world-edit", "chunk-aba", "life", "player-position", "dormant", "veto"])
  test(`prepared feed refuses ${reason} changes with no additional owner publication`, (t) => {
    const f = fedFixture(t);
    f.hold("RAW_SALMON", { count: 2 });
    const plan = f.host.prepareInteraction(f.mob.id, {
      participants: reason === "veto" ? [ecologyVeto(f.coordinator)] : [],
    });
    assert.ok(plan);
    if (reason === "hand") f.hold("RAW_SALMON", { count: 2, data: { version: 1, name: "Different catch" } });
    if (reason === "pose") f.mob.position.x += 0.01;
    if (reason === "world-edit") f.put(20, 2, 20, BLOCK.STONE);
    if (reason === "chunk-aba") {
      const previous = f.world.chunks.get("0,0");
      f.world._removeChunk("0,0", previous);
      f.world._generateSync(0, 0);
      assert.notEqual(f.world.chunks.get("0,0").incarnation, previous.incarnation);
    }
    if (reason === "life") f.player.targetKey = "player:life:2";
    if (reason === "player-position") f.player.position.z += 0.25;
    if (reason === "dormant") assert.equal(f.wildlife.suspendEcology(f.mob), true);
    const beforeCommit = f.ownership(), changes = f.changes;
    assert.equal(f.host.commit(plan).ok, false);
    assert.deepEqual(f.ownership(), beforeCommit);
    assert.equal(f.changes, changes);
    assert.equal(f.host.ecology.state(f.mob.id).assistTime, 0);
  });

test("admission pins current physical player reads even before the next Wildlife update", (t) => {
  const f = ecologyHostFixture(t);
  const plan = f.host.prepareAdmission("dolphin", dolphinAt);
  assert.ok(plan);
  f.player.targetKey = "player:life:2";
  const before = f.ownership();
  assert.equal(f.host.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), before);
});

test("lethal hits retain exact drops and XP with tool wear, then retire the real Wildlife entity", (t) => {
  const f = guardianFixture(t);
  const before = f.ownership();
  assert.equal(f.wildlife.damage(f.mob, 1000).hit, false);
  assert.equal(f.wildlife.rememberKilled(f.mob.id), false);
  assert.equal(f.host.prepareHit(f.mob.id, 1000, null, { playerKill: true }), null,
    "the parent must supply its physical action/cooldown guard");
  const plan = swordHit(f);
  assert.ok(plan);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)), new Set([
    f.host.ecology, f.wildlife, f.overflow, f.experienceOrbs, f.gameplay,
  ]));
  assert.deepEqual(f.ownership(), before);
  const committed = f.host.commit(plan);
  assert.equal(committed.ok, true);
  assert.equal(committed.killed, true);
  assert.equal(committed.dropsCommitted, true);
  assert.equal(committed.experienceCommitted, true);
  assert.equal(f.mob.health, 0);
  assert.equal(f.mob.dead, true);
  assert.equal(f.wildlife.byId.has(f.mob.id), false);
  assert.equal(f.host.ecology.state(f.mob.id).alive, false);
  assert.equal(f.wildlife.rememberKilled(f.mob.id), false);
  assert.equal(f.wildlife.killed.has(f.mob.id), false, "permanent ecology state does not use the bounded killed LRU");
  assert.equal(f.gameplay.getHandStack("main").durability, 7);
  assert.deepEqual(ecologyTotals(f), {
    drops: { [ITEM.PRISMARINE_SHARD]: 2, [ITEM.PRISMARINE_CRYSTALS]: 1 }, xp: 5,
  });
  assert.equal(f.host.commit(plan).ok, false);
  assert.equal(swordHit(f), null);
  const restored = ecologyHostFixture(t, { saved: f.snapshot() });
  assert.deepEqual(ecologyTotals(restored), ecologyTotals(f));
  assert.equal(restored.wildlife.byId.has(f.mob.id), false);
});

for (const hook of ["prepareDrops", "prepareExperience"])
  test(`${hook} must return its bound retention owner, never an unrelated participant`, (t) => {
    let unrelated;
    const f = guardianFixture(t, { hooks: { [hook]: () => unrelated } });
    unrelated = ecologyVeto(f.coordinator, () => true);
    const before = f.ownership();
    assert.equal(swordHit(f), null);
    assert.deepEqual(f.ownership(), before);
    assert.equal(f.mob.health, f.mob.spec.health);
    assert.equal(f.mob.dead, false);
    assert.equal(f.gameplay.getHandStack().durability, 8);
    assert.deepEqual(ecologyTotals(f), { drops: {}, xp: 0 });
  });

for (const reason of ["drops-full", "xp-full", "budget", "tool-stale", "xp-stale", "veto"])
  test(`lethal ${reason} refusal conserves health, tool, drops, XP and ecology`, (t) => {
    const f = guardianFixture(t, { maxEntries: reason === "drops-full" ? 1 : undefined });
    if (reason === "xp-full") assert.equal(f.experienceOrbs.spawn(
      MAX_EXPERIENCE_ORBS * MAX_ORB_EXPERIENCE, { x: 24.5, y: 2, z: 24.5 }
    ), true);
    if (reason === "budget") assert.equal(f.coordinator.register({},
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes), true);
    const plan = swordHit(f, reason === "veto" ? { participants: [ecologyVeto(f.coordinator)] } : {});
    if (reason === "tool-stale") f.hold("IRON_SWORD", { durability: 6 });
    if (reason === "xp-stale") assert.equal(f.experienceOrbs.spawn(1, { x: 20, y: 2, z: 20 }), true);
    const beforeCommit = f.ownership();
    if (["drops-full", "xp-full"].includes(reason)) assert.equal(plan, null);
    else {
      assert.ok(plan);
      assert.equal(f.host.commit(plan).ok, false);
    }
    assert.deepEqual(f.ownership(), beforeCommit);
    assert.equal(f.mob.health, f.mob.spec.health);
    assert.equal(f.mob.dead, false);
    assert.equal(f.wildlife.byId.get(f.mob.id), f.mob);
    assert.equal(f.host.ecology.state(f.mob.id).alive, true);
  });

test("legacy empty seeds stage unchanged; imports over budget keep complete residents and refuse new capacity", (t) => {
  const empty = ecologyHostFixture(t, { seed: "", generatorVersion: 3 });
  assert.equal(empty.host.context.seed, "");
  assert.equal(empty.host.serialize().ecology.seed, "");
  const original = fedFixture(t);
  original.hold("RAW_COD", { count: 2 });
  assert.equal(original.host.commit(original.host.prepareInteraction(original.mob.id)).ok, true);
  const saved = original.snapshot();
  const imported = ecologyHostFixture(t, { saved, activate: false, allowOverBudget: true });
  assert.equal(imported.coordinator.register({}, MAX_RESERVED_BYTES + 1, { allowOverBudget: true }), true);
  assert.equal(imported.host.restoreWildlife(imported.wildlife), true);
  assert.equal(imported.host.activate(imported.wildlife), true);
  assert.deepEqual(imported.host.serialize().ecology, saved.ecology.ecology);
  assert.deepEqual(imported.host.serialize().mobsByDimension, saved.ecology.mobsByDimension);
  const plan = imported.host.prepareAdmission("dolphin", { x: 3.5, y: 2, z: 8.5 });
  assert.ok(plan);
  const before = imported.ownership();
  assert.equal(imported.host.commit(plan).ok, false);
  assert.deepEqual(imported.ownership(), before);
});

test("observer exceptions cannot roll back an accepted feed or trigger a second hand debit", (t) => {
  const failure = new Error("fixture observer");
  const f = fedFixture(t, { hooks: { onChange: () => { throw failure; } } });
  f.hold("RAW_COD", { count: 2 });
  const plan = f.host.prepareInteraction(f.mob.id);
  assert.ok(plan);
  const result = f.host.commit(plan);
  assert.equal(result.ok, true);
  assert.ok(result.observerErrors.includes(failure));
  assert.equal(f.gameplay.getHandStack().count, 1);
  assert.equal(f.host.commit(plan).ok, false);
  assert.equal(f.gameplay.getHandStack().count, 1);
});
