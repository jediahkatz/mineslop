import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { COMBAT_CONTACT_EPSILON, traceCombatSegment } from "../src/combat-collision.js";
import {
  combatActor, combatCell, combatFacts, combatTrace, combatWorld,
} from "./combat-collision-fixtures.js";

test("guard re-queries intervening relocation even when the selected victim and shared revision are unchanged", (t) => {
  const world = combatWorld(t), sharedRevision = 17;
  const selected = combatActor(world, { id: "combat/selected", box: [8, 19, 4, 9, 22, 5] });
  const other = combatActor(world, { id: "combat/intervening", box: [5, 19, 7, 6, 22, 8] });
  let current = combatFacts(world, { candidates: [selected, other], sharedRevision });
  let enumerations = 0;
  const pending = traceCombatSegment(current, () => { enumerations++; return current; });
  assert.equal(pending.contact.actor.id, selected.id);
  assert.equal(pending.validate(), true);
  assert.equal(enumerations, 1);
  const relocated = Object.freeze({ ...other, box: Object.freeze([5, 19, 4, 6, 22, 5]) });
  current = combatFacts(world, { candidates: [selected, relocated], sharedRevision });
  assert.equal(current.candidates[0], selected);
  assert.equal(current.sharedRevision, sharedRevision);
  assert.equal(pending.validate(), false);
  assert.equal(enumerations, 2, "exactly one current-roster read per guard");
  assert.equal(combatTrace(current).contact.actor.id, relocated.id);
});

test("guard detects newly admitted foreground membership and never retargets a pending contact", (t) => {
  const world = combatWorld(t);
  const far = combatActor(world);
  let current = combatFacts(world, { candidates: [far] });
  const pending = traceCombatSegment(current, () => current);
  current = combatFacts(world, {
    candidates: [far, combatActor(world, { id: "combat/new", box: [5, 19, 4, 6, 22, 5] })],
  });
  assert.equal(pending.validate(), false);
  assert.equal(pending.contact.actor.id, far.id, "refusal cannot rewrite the prepared victim");
  current = combatFacts(world, { candidates: [] });
  assert.equal(pending.validate(), false);
});

test("immune and unavailable foreground bodies remain contacts, without reading health or owner APIs", (t) => {
  const world = combatWorld(t);
  const front = Object.freeze({
    ...combatActor(world, { id: "combat/foreground", box: [5, 19, 4, 6, 22, 5] }),
    immune: true, ownerAvailable: false,
    get health() { assert.fail("collision must not consult health"); },
    get prepareDamage() { assert.fail("collision must not call a victim owner"); },
  });
  const far = combatActor(world, { id: "combat/background" });
  const result = combatTrace(combatFacts(world, { candidates: [far, front] }));
  assert.equal(result.kind, "contact");
  assert.equal(result.contact.actor.id, front.id);
  assert.equal(result.validate(), true, "damage refusal is not a hole in physical geometry");
});

test("guard accepts order changes but rejects canonical replacement, incarnation changes and player life changes", (t) => {
  const world = combatWorld(t);
  const chosen = combatActor(world, { kind: "player", id: "combat/player", life: 3 });
  const behind = combatActor(world, { id: "combat/behind", box: [9, 19, 4, 10, 22, 5] });
  let current = combatFacts(world, { candidates: [chosen, behind] });
  const pending = traceCombatSegment(current, () => current);
  current = combatFacts(world, { candidates: [behind, chosen] });
  assert.equal(pending.validate(), true);
  for (const change of [
    { ref: Object.freeze({}) }, { incarnation: chosen.incarnation + 1 }, { life: chosen.life + 1 },
  ]) {
    current = combatFacts(world, { candidates: [Object.freeze({ ...chosen, ...change }), behind] });
    assert.equal(pending.validate(), false);
  }
});

test("guard compares contact geometry within the declared tolerance, not a selected-victim boolean", (t) => {
  const world = combatWorld(t);
  const chosen = combatActor(world);
  let current = combatFacts(world, { candidates: [chosen] });
  const pending = traceCombatSegment(current, () => current);
  const shift = (amount) => Object.freeze({
    ...chosen, box: chosen.box.map((value, axis) => value + (axis === 0 || axis === 3 ? amount : 0)),
  });
  current = combatFacts(world, { candidates: [shift(COMBAT_CONTACT_EPSILON / 4)] });
  assert.equal(pending.validate(), true);
  current = combatFacts(world, { candidates: [shift(COMBAT_CONTACT_EPSILON * 2)] });
  assert.equal(pending.validate(), false);
});

test("frontier is neither air nor impact and cannot advance source-envelope state", (t) => {
  const world = combatWorld(t);
  world.chunks.delete("1,0");
  const getCell = world.getCell.bind(world);
  let calls = 0;
  world.getCell = (...args) => { calls++; return getCell(...args); };
  const source = combatActor(world, { box: [12, 19, 4, 13.5, 22, 5] });
  const facts = combatFacts(world, {
    from: { x: 13, y: 20, z: 4.5 }, to: { x: 15, y: 20, z: 4.5 },
    candidates: [source],
    sourceEnvelope: { exited: false, box: source.box, members: [source] },
  });
  const result = combatTrace(facts);
  assert.equal(result.kind, "frontier");
  assert.deepEqual(result.columns, [{ cx: 1, cz: 0 }]);
  assert.equal(result.contact, undefined);
  assert.equal(result.sourceEnvelopeExited, false);
  assert.equal(result.stats.cellReads, 0);
  assert.equal(calls, 0);
  assert.equal(result.validate(), true);
  world.generate(1);
  assert.equal(result.validate(), false);
  assert.equal(combatTrace(facts).kind, "flight");
});

test("unload and equal-cell chunk readmission invalidate identity/incarnation guards", (t) => {
  const world = combatWorld(t);
  const facts = combatFacts(world);
  const pending = combatTrace(facts);
  const chunk = world.chunks.get("0,0"), before = world.getCell(7, 20, 4), epoch = world.epoch;
  assert.equal(pending.validate(), true);
  world.chunks.delete("0,0");
  assert.equal(pending.validate(), false);
  assert.equal(combatTrace(facts).kind, "frontier");
  world.generate(1);
  assert.equal(world.epoch, epoch);
  assert.deepEqual(world.getCell(7, 20, 4), before);
  assert.notEqual(world.chunks.get("0,0"), chunk);
  assert.notEqual(world.chunks.get("0,0").incarnation, chunk.incarnation);
  assert.equal(pending.validate(), false);
  assert.equal(combatTrace(facts).validate(), true);
});

test("real World revision changes, epoch reloads and replacement all invalidate pending work", (t) => {
  const world = combatWorld(t);
  let current = combatFacts(world);
  let pending = traceCombatSegment(current, () => current);
  combatCell(world, 7, 20, 4, BLOCK.STONE);
  assert.equal(pending.validate(), false);
  pending = traceCombatSegment(current, () => current);
  assert.equal(pending.kind, "contact");
  combatCell(world, 12, 25, 8, BLOCK.STONE);
  assert.equal(pending.validate(), false, "pin the read column's revision even if the nearest box is unchanged");
  pending = traceCombatSegment(current, () => current);
  const epoch = world.epoch;
  assert.equal(world.loadEdits(world.serialize()), true);
  assert.notEqual(world.epoch, epoch);
  assert.equal(pending.validate(), false);
  world.generate(1);
  current = combatFacts(world);
  pending = traceCombatSegment(current, () => current);
  current = combatFacts(combatWorld(t));
  assert.equal(pending.validate(), false, "another World cannot impersonate the pending world's epoch");
});

test("guard pins the exact pending segment and runtime ticket and fails closed on unavailable readers", (t) => {
  const world = combatWorld(t), original = combatFacts(world);
  let current = original;
  const pending = traceCombatSegment(original, () => current);
  for (const change of [
    { ticket: { ...original.ticket, revision: 1 } },
    { ticket: { ...original.ticket, runtimeEpoch: 2 } },
    { ticket: { ...original.ticket, id: "combat/contact/replacement" } },
    { from: { ...original.from, x: original.from.x + 1 } },
    { to: { ...original.to, x: original.to.x + 1 } },
    { radius: 0.2 },
  ]) {
    current = { ...original, ...change };
    assert.equal(pending.validate(), false);
  }
  current = null;
  assert.equal(pending.validate(), false, "consumed tickets must return null");
  assert.equal(traceCombatSegment(original, () => { throw new Error("unavailable"); }).validate(), false);
  assert.equal(traceCombatSegment(original, () => Promise.resolve(original)).validate(), false);
  assert.equal(traceCombatSegment(original).kind, "invalid", "no guardless successful query");
});

function mountedLaunch(world) {
  const shooter = combatActor(world, {
    kind: "player", id: "combat/rider", life: 4, box: [4, 20, 4, 5, 22, 5],
  });
  const mount = combatActor(world, {
    id: "combat/horse", box: [3.5, 18, 3.5, 5.5, 20.5, 5.5],
  });
  return {
    shooter, mount,
    facts: combatFacts(world, {
      from: { x: 4.5, y: 20.25, z: 4.5 }, to: { x: 8, y: 20.25, z: 4.5 },
      candidates: [shooter, mount],
      sourceEnvelope: { exited: false, box: [3.5, 18, 3.5, 5.5, 22, 5.5], members: [shooter, mount] },
    }),
  };
}

test("launch envelope excludes rider and mount only until exit; returning shots can hit each separately", (t) => {
  const world = combatWorld(t), { facts, shooter, mount } = mountedLaunch(world);
  const launch = combatTrace(facts);
  assert.equal(launch.kind, "flight");
  assert.equal(launch.sourceEnvelopeExited, true);
  const returned = combatTrace({
    ...facts, from: facts.to, to: facts.from,
    sourceEnvelope: { ...facts.sourceEnvelope, exited: launch.sourceEnvelopeExited },
  });
  assert.equal(returned.contact.actor.id, mount.id);
  assert.equal(returned.sourceEnvelopeExited, true);
  const high = combatTrace({
    ...facts, from: { x: 8, y: 21, z: 4.5 }, to: { x: 4.5, y: 21, z: 4.5 },
    sourceEnvelope: { ...facts.sourceEnvelope, exited: true },
  });
  assert.equal(high.contact.actor.id, shooter.id);
  assert.equal(high.contact.actor.life, 4);
});

test("a contact before envelope exit does not eagerly install the proposed end-of-segment exit", (t) => {
  const world = combatWorld(t), { facts } = mountedLaunch(world);
  const front = combatActor(world, { id: "combat/inside-envelope", box: [4.75, 20, 4, 5, 21, 5] });
  const pending = combatTrace({ ...facts, candidates: [...facts.candidates, front] });
  assert.equal(pending.contact.actor.id, front.id);
  assert.equal(pending.sourceEnvelopeExited, false);
});

test("source death/removal does not invalidate a launched shot or make an absent source a victim", (t) => {
  const world = combatWorld(t), { facts } = mountedLaunch(world);
  const victim = combatActor(world, { id: "combat/distant-victim", box: [7, 19, 4, 8, 22, 5] });
  let current = { ...facts, candidates: [...facts.candidates, victim] };
  const pending = traceCombatSegment(current, () => current);
  assert.equal(pending.contact.actor.id, victim.id);
  current = { ...facts, candidates: [victim] };
  assert.equal(pending.validate(), true);
  assert.equal(combatTrace(current).contact.actor.id, victim.id);
});

test("source identity replacement is not immune and an unchanged source body beyond the envelope is eligible", (t) => {
  const world = combatWorld(t), { facts, shooter, mount } = mountedLaunch(world);
  const replacement = { ...shooter, ref: Object.freeze({}), life: shooter.life + 1 };
  const contact = combatTrace({ ...facts, candidates: [replacement, mount] });
  assert.equal(contact.contact.actor.id, shooter.id);
  assert.equal(contact.contact.fraction, 0);
  const single = combatFacts(world, {
    from: { x: 4.5, y: 20.5, z: 4.5 }, to: { x: 8, y: 20.5, z: 4.5 },
    candidates: [{ ...shooter, box: [5, 20, 4, 6, 22, 5] }],
    sourceEnvelope: { exited: false, box: shooter.box, members: [shooter] },
  });
  const moved = combatTrace(single);
  assert.equal(moved.kind, "contact");
  assert.equal(moved.contact.actor.id, shooter.id);
  assert.equal(moved.sourceEnvelopeExited, true);
});
