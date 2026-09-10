import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { Pickups } from "../src/pickups.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  finishResidentBatch, residentBorrowersFixture, residentSource, residentState,
} from "./resident-edit-batch-fixture.js";

function borrowers(t, options) {
  const f = residentBorrowersFixture(t, options);
  f.source = residentSource(f);
  f.horse = f.spawn();
  f.turtle = f.admitTurtle();
  return f;
}

function contribute(f) {
  const batch = f.wildlife.beginResidentEditBatch();
  const source = f.wildlife.contributeSourceEdit(batch, f.source, { attackCooldown: 0.25 });
  const horse = f.horses.contributeHit(batch, f.horse.id, 1000, null);
  const turtle = f.host.contributeHit(batch, f.turtle.id, 1000, null);
  const tokens = [source, horse, turtle];
  assert.equal(tokens.every((token) => token?.complete === false), true);
  return { batch, tokens, peers: tokens.flatMap((token) => token.peers) };
}

const expectedDrops = () => [
  { id: ITEM.LEATHER, count: 2, x: 8.5, y: 1, z: 8.5, dimension: "overworld",
    pickupDelay: 0.4, velocity: { x: 0, y: 1.5, z: 0 } },
  { id: BLOCK.SEAGRASS, count: 2, x: 13.5, y: 1, z: 8.5, dimension: "overworld",
    pickupDelay: 0.4, velocity: { x: 0, y: 2.2, z: 0 } },
];

function assertPaid(f) {
  assert.equal(f.source.attackCooldown, 0.25);
  assert.deepEqual(f.wildlife.entities, [f.source]);
  assert.equal(f.wildlife.byId.get(f.source.id), f.source);
  assert.equal(f.wildlife.byId.has(f.horse.id), false);
  assert.equal(f.wildlife.byId.has(f.turtle.id), false);
  assert.equal(f.horses.state(f.horse.id).alive, false);
  assert.equal(f.host.ecology.state(f.turtle.id).alive, false);
  assert.deepEqual(f.overflow.serialize().entries, expectedDrops());
  assert.equal(f.overflow.reservedBytes, 235);
  assert.equal(f.overflow.reservedBytes, encodedBytes(f.overflow.serialize().entries) - 2);
  assert.equal(f.coordinator.usage(f.overflow), f.overflow.reservedBytes);
  assert.equal(f.experience.serialize().orbs.length, 0, "uncredited deaths still retain base resources, not XP");
  assert.ok(f.host.serialize());
}

test("two real borrower deaths retain both complete quotes once, preserve identities and cold-save into real pickups", (t) => {
  const f = borrowers(t), w = f.wildlife, before = residentState(f);
  const entities = w.entities, byId = w.byId, entries = f.overflow.entries;
  const revision = w._ecologyRevision, overflowRevision = f.overflow.revision;
  const { batch, tokens, peers } = contribute(f);
  assert.equal(peers.filter((part) => part.owner === f.overflow).length, 2);
  const plan = finishResidentBatch(w, batch, tokens);
  assert.equal(plan.participants.filter((part) => part.owner === f.overflow).length, 1);
  assert.deepEqual(residentState(f), before);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(w.entities, entities);
  assert.equal(w.byId, byId);
  assert.equal(f.overflow.entries, entries);
  assert.equal(w._ecologyRevision, revision + 1);
  assert.equal(f.overflow.revision, overflowRevision + 1);
  assertPaid(f);
  const paid = residentState(f);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.coordinator.commit(peers).ok, false, "incomplete tokens cannot be replayed as publishers");
  assert.deepEqual(residentState(f), paid);

  const saved = JSON.parse(JSON.stringify({ ...f.snapshot(), ecology: f.host.serialize() }));
  const restored = residentBorrowersFixture(t, { saved });
  assert.equal(restored.wildlife.byId.has(f.horse.id), false);
  assert.equal(restored.wildlife.byId.has(f.turtle.id), false);
  assert.equal(restored.horses.state(f.horse.id).alive, false);
  assert.equal(restored.host.ecology.state(f.turtle.id).alive, false);
  assert.equal(restored.wildlife.byId.get(f.source.id).attackCooldown, 0.25);
  assert.deepEqual(restored.overflow.serialize(), saved.overflow);
  assert.equal(restored.overflow.reservedBytes, 235);
  assert.ok(restored.host.serialize());
  const pickups = new Pickups(restored.scene, restored.world, {
    coordinator: restored.coordinator, context: restored.context,
  });
  t.after(() => pickups.dispose());
  assert.equal(restored.overflow.flush(restored.world, pickups), 2);
  assert.equal(restored.overflow.size, 0);
  assert.equal(restored.coordinator.usage(restored.overflow), 0);
  assert.deepEqual(pickups.serialize().items.map(({ id, count, x, y, z, pickupDelay, velocity }) => ({
    id, count, x, y, z, dimension: "overworld", pickupDelay, velocity,
  })), expectedDrops());
});

for (const omitted of [1, 2])
  test(`omitting borrower ${omitted}'s exact drop token still poisons the entire batch`, (t) => {
    const f = borrowers(t), before = residentState(f);
    const { batch, tokens, peers } = contribute(f);
    const missing = tokens[omitted].peers.find((part) => part.owner === f.overflow);
    assert.ok(missing);
    assert.equal(f.wildlife.finalizeResidentEditBatch(batch, {
      contributions: tokens, participants: peers.filter((part) => part !== missing),
    }), null);
    assert.equal(f.coordinator.commit(peers).ok, false);
    assert.deepEqual(residentState(f), before);
  });

test("every real owner can veto mixed borrower deaths without partial source, tombstone or resource publication", (t) => {
  const f = borrowers(t), { batch, tokens } = contribute(f);
  const plan = finishResidentBatch(f.wildlife, batch, tokens), before = residentState(f);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.horses, f.host.ecology, f.overflow, f.wildlife]));
  for (const veto of plan.participants) {
    const refused = plan.participants.map((part) =>
      part === veto ? { ...part, validate: () => false } : part);
    assert.equal(f.coordinator.commit(refused).ok, false);
    assert.deepEqual(residentState(f), before, veto.owner.constructor.name);
  }
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assertPaid(f);
});

test("combined retained-record capacity refuses both deaths although each complete quote fits alone", (t) => {
  const f = borrowers(t, { overflowEntries: 1 }), before = residentState(f);
  const { batch, tokens, peers } = contribute(f);
  assert.equal(peers.filter((part) => part.owner === f.overflow).length, 2);
  assert.equal(f.wildlife.finalizeResidentEditBatch(batch, {
    contributions: tokens, participants: peers,
  }), null);
  assert.equal(f.coordinator.commit(peers).ok, false);
  assert.deepEqual(residentState(f), before);
});

test("genuine combined save-budget failure cannot pay the source or install either corpse, and remains retryable", (t) => {
  const f = borrowers(t), { batch, tokens, peers } = contribute(f);
  const plan = finishResidentBatch(f.wildlife, batch, tokens);
  const drops = peers.filter((part) => part.owner === f.overflow);
  const domains = peers.filter((part) => part.owner !== f.overflow);
  const domainDelta = domains.reduce((sum, part) => sum + part.afterBytes - part.beforeBytes, 0);
  const singleDropDelta = Math.max(...drops.map((part) => part.afterBytes - part.beforeBytes));
  const padding = {};
  assert.equal(f.coordinator.register(padding,
    MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes - domainDelta - singleDropDelta), true);
  assert.equal(drops.every((part) => f.coordinator.budget.canCommit([...domains, part])), true);
  assert.equal(f.coordinator.budget.canCommit(plan.participants), false);
  const before = residentState(f);
  assert.equal(f.coordinator.commit(plan.participants).reason, "budget-rejected");
  assert.deepEqual(residentState(f), before);
  assert.equal(f.coordinator.release(padding), true);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assertPaid(f);
});

const stale = [
  ["horse lifetime", (f) => { f.horse.life++; }],
  ["turtle lifetime", (f) => { f.turtle.life++; }],
  ["turtle position", (f) => { f.turtle.position.x += 0.1; }],
  ["source lifetime", (f) => { f.source.life++; }],
  ["same-byte overflow reload", (f) => assert.equal(f.overflow.load(f.overflow.serialize()), true)],
  ["world epoch", (f) => assert.equal(f.world.loadEdits(f.world.serialize()), true)],
  ["chunk ABA", (f) => {
    const previous = f.world.chunks.get("0,0");
    f.world._removeChunk("0,0", previous);
    f.world._generateSync(0, 0);
    assert.notEqual(f.world.chunks.get("0,0").incarnation, previous.incarnation);
  }],
  ["ecology suspension", (f) => assert.equal(f.host.suspend(), true)],
];
for (const [name, invalidate] of stale)
  test(`mixed death aggregation retains ${name} guards through the final cross-owner commit`, (t) => {
    const f = borrowers(t), { batch, tokens } = contribute(f);
    const plan = finishResidentBatch(f.wildlife, batch, tokens);
    invalidate(f);
    const before = residentState(f);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(residentState(f), before);
    assert.equal(f.source.attackCooldown, 0.5);
    assert.equal(f.horse.health, 24);
    assert.equal(f.turtle.health, 30);
    assert.equal(f.overflow.size, 0);
  });
