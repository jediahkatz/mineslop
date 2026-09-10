import assert from "node:assert/strict";
import test from "node:test";
import {
  DropOverflow, normalizeOverflowSnapshot, OVERFLOW_AGGREGATE_LIMITS,
} from "../src/drop-overflow.js";
import { ITEM } from "../src/items.js";
import { MAX_PICKUPS } from "../src/pickups.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { DROP_POSITION as at, pickupFixture, PreparedInventoryFixture } from "./metadata-fixture.js";

const named = (name, count = 1) => ({ id: ITEM.APPLE, count, data: { version: 1, name } });
const tool = (wear = 7) => ({
  id: ITEM.IRON_PICKAXE, count: 1, durability: wear,
  data: { version: 1, name: "矿:洞|west", enchantments: { efficiency: 3, unbreaking: 2 } },
});
const entry = (stack = named("retained"), extra = {}) => ({
  ...stack, ...at, dimension: "overworld", ...extra,
});
const fixture = (t, options = {}) => {
  const f = pickupFixture(t, options);
  f.overflow = new DropOverflow({
    coordinator: f.coordinator, context: f.world, maxEntries: options.maxEntries,
  });
  t.after(() => f.overflow.dispose());
  return f;
};
const snapshot = (f) => ({
  overflow: f.overflow.serialize(), revision: f.overflow.revision,
  bytes: f.overflow.reservedBytes, usage: f.coordinator.usage(f.overflow),
  totalBytes: f.coordinator.budget.totalBytes, pickups: f.pickups.serialize(),
});
const exactBytes = (f) => {
  assert.equal(f.overflow.reservedBytes, encodedBytes(f.overflow.serialize().entries) - 2);
  assert.equal(f.coordinator.usage(f.overflow), f.overflow.reservedBytes);
};
const additions = (f, groups) => groups.map((entries) => {
  const part = f.overflow.prepareAddBatch(entries);
  assert.ok(part);
  assert.equal(part.validate(), true);
  return part;
});
const combine = (f, parts) => {
  const combined = f.overflow.prepareParticipantBatch(parts);
  assert.ok(combined);
  assert.equal(combined.owner, f.overflow);
  assert.equal(Object.isFrozen(combined), true);
  assert.equal(combined.validate(), true);
  return combined;
};

test("native add aggregation preserves full detached position, dimension, motion, metadata and wear quotes", (t) => {
  const f = fixture(t), oracle = fixture(t);
  const groups = [
    [
      entry(named("a:|[b", 3), { pickupDelay: 0.4, velocity: { x: 1, y: 1.5, z: -2 } }),
      entry({ ...tool(), count: 3, durability: [7, 17, 7] }),
    ],
    [
      entry(named("a:|[b", 4), { x: 3.5, pickupDelay: 0.8, velocity: { x: -1, y: 2.2, z: 2 } }),
      entry(named("a:|[b", 2), { dimension: "nether" }),
      entry({ ...tool(), data: { ...tool().data, name: "another tool" } }),
    ],
  ];
  const original = structuredClone(groups);
  assert.equal(oracle.overflow.addBatch(original.flat()), true);
  const before = snapshot(f), parts = additions(f, groups);
  groups[0][0].data.name = "mutated caller metadata";
  groups[0][0].velocity.y = 0;
  groups[0][1].durability[0] = 1;
  const combined = combine(f, parts);
  assert.deepEqual(snapshot(f), before);
  let notices = 0;
  f.overflow.onChange = () => {
    notices++;
    assert.deepEqual(f.overflow.serialize(), oracle.overflow.serialize());
    assert.equal(parts.every((part) => part.validate() === false), true);
  };
  assert.equal(combined.afterBytes, oracle.overflow.reservedBytes);
  assert.equal(f.coordinator.commit([combined]).ok, true);
  assert.equal(notices, 1);
  assert.equal(f.overflow.revision, before.revision + 1);
  assert.deepEqual(f.overflow.serialize(), oracle.overflow.serialize());
  exactBytes(f);
  const paid = snapshot(f);
  for (const part of [...parts, combined]) assert.equal(f.coordinator.commit([part]).ok, false);
  assert.deepEqual(snapshot(f), paid);
});

for (const stock of [9, 4_503_599_627_370_497, Number.MAX_SAFE_INTEGER - 2])
  test(`same-key aggregation counts existing stock ${stock} exactly once`, (t) => {
    const f = fixture(t);
    assert.equal(f.overflow.addBatch([entry(named("same", stock))]), true);
    const before = snapshot(f);
    const parts = additions(f, [[entry(named("same"))], [entry(named("same"))]]);
    const combined = combine(f, parts);
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.coordinator.commit([combined]).ok, true);
    assert.equal(f.overflow.size, 1);
    assert.equal(f.overflow.serialize().entries[0].count, Number(BigInt(stock) + 2n));
    exactBytes(f);
  });

for (const stock of [0, Number.MAX_SAFE_INTEGER - 1])
  test(`unsafe combined count rejects every addition with existing stock ${stock}`, (t) => {
    const f = fixture(t);
    if (stock) assert.equal(f.overflow.addBatch([entry(named("same", stock))]), true);
    const parts = additions(f, [
      [entry(named("same", stock ? 1 : Number.MAX_SAFE_INTEGER)), entry(named("other"))],
      [entry(named("same"))],
    ]);
    const before = snapshot(f);
    assert.equal(f.overflow.prepareParticipantBatch(parts), null);
    assert.deepEqual(snapshot(f), before);
    assert.equal(parts.every((part) => part.validate()), true);
  });

for (const amount of [0, -1])
  test(`native provenance does not authorize a non-additive delta of ${amount}`, (t) => {
    const f = fixture(t);
    assert.equal(f.overflow.addBatch([entry(named("retained", 3))]), true);
    let reads = 0;
    const source = entry(named("retained"));
    // The legacy preparer reads count during both validation and normalization.
    // Even a natively constructed plan must prove its recorded delta is additive.
    Object.defineProperty(source, "count", { get: () => ++reads <= 2 ? 1 : amount });
    const unusual = f.overflow.prepareAddBatch([source]);
    assert.ok(unusual);
    assert.equal(unusual.validate(), true);
    const [ordinary] = additions(f, [[entry(named("other"))]]);
    const before = snapshot(f);
    assert.equal(f.overflow.prepareParticipantBatch([unusual, ordinary]), null);
    assert.deepEqual(snapshot(f), before);
  });

test("same-key repeated source rows, canonical metadata and worn duplicates add only their deltas", (t) => {
  const f = fixture(t), oracle = fixture(t);
  const initial = [entry(tool()), entry(named("same", 9))];
  for (const target of [f, oracle]) assert.equal(target.overflow.addBatch(initial), true);
  const groups = [
    [entry(tool()), entry(named("same")), entry(named("same", 2))],
    [
      entry({ ...tool(), count: 3, durability: [7, 17, 7] }),
      entry({ ...named("same", 3), data: { name: "same", version: 1 } }),
    ],
  ];
  const combined = combine(f, additions(f, groups));
  assert.equal(oracle.overflow.addBatch(groups.flat()), true);
  assert.equal(combined.afterBytes, oracle.overflow.reservedBytes);
  assert.equal(f.coordinator.commit([combined]).ok, true);
  assert.deepEqual(f.overflow.serialize(), oracle.overflow.serialize());
  assert.deepEqual(f.overflow.serialize().entries.map(({ count }) => count), [4, 15, 1]);
  exactBytes(f);
});

test("combined record capacity refuses two individually valid native additions", (t) => {
  const f = fixture(t, { maxEntries: 1 });
  const parts = additions(f, [[entry(named("first"))], [entry(named("second"))]]);
  const before = snapshot(f);
  assert.equal(f.overflow.prepareParticipantBatch(parts), null);
  assert.deepEqual(snapshot(f), before);
  assert.equal(parts.every((part) => part.validate()), true);
});

test("combined byte admission fails atomically and the same unspent plan succeeds after budget release", (t) => {
  const f = fixture(t);
  const parts = additions(f, [[entry(named("first"))], [entry(named("second"))]]);
  const combined = combine(f, parts), padding = {};
  const spare = Math.max(...parts.map((part) => part.afterBytes - part.beforeBytes));
  assert.equal(f.coordinator.register(padding, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes - spare), true);
  assert.equal(parts.every((part) => f.coordinator.budget.canCommit([part])), true);
  assert.equal(f.coordinator.budget.canCommit([combined]), false);
  const before = snapshot(f);
  assert.equal(f.coordinator.commit([combined]).reason, "budget-rejected");
  assert.deepEqual(snapshot(f), before);
  assert.equal(parts.every((part) => part.validate()), true);
  assert.equal(f.coordinator.release(padding), true);
  assert.equal(f.coordinator.commit([combined]).ok, true);
  exactBytes(f);
});

test("another owner's veto leaves every member unused; one overflow notice sees the complete source debit", (t) => {
  const f = fixture(t), slots = Array(36).fill(null);
  slots[0] = named("first", 2);
  const inventory = new PreparedInventoryFixture(f.coordinator, slots);
  const parts = additions(f, [[entry(named("first"))], [entry(named("first"))]]);
  const combined = combine(f, parts), before = snapshot(f);
  const debit = (valid) => inventory.prepare((next) => { next[0] = null; return true; }, { valid });
  assert.equal(f.coordinator.commit([combined, debit(() => false)]).ok, false);
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(inventory.slots[0], slots[0]);
  assert.equal(parts.every((part) => part.validate()), true);
  let notices = 0;
  const failure = new Error("deliberate combined overflow observer failure");
  f.overflow.onChange = () => {
    notices++;
    assert.equal(inventory.slots[0], null);
    assert.equal(f.overflow.serialize().entries[0].count, 2);
    throw failure;
  };
  const committed = f.coordinator.commit([combined, debit(() => true)]);
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.observerErrors, [failure]);
  assert.equal(notices, 1);
  assert.equal(inventory.notifications, 1);
});

const staleCases = [
  ["same-byte write", (f) => {
    const bytes = f.overflow.reservedBytes;
    assert.equal(f.overflow.addBatch([entry(named("retained"))]), true);
    assert.equal(f.overflow.reservedBytes, bytes);
  }],
  ["same-byte cold reload", (f) => assert.equal(f.overflow.load(f.overflow.serialize()), true)],
  ["touched record ABA", (f) => {
    const [key, value] = f.overflow.entries.entries().next().value;
    f.overflow.entries.delete(key);
    f.overflow.entries.set(key, { ...value });
  }],
  ["entries-map replacement", (f) => { f.overflow.entries = new Map(f.overflow.entries); }],
  ["capacity replacement", (f) => { f.overflow.maxEntries--; }],
  ["context replacement", (f) => { f.overflow.context = { ...f.world }; }],
  ["context seed replacement", (f) => { f.world.seed += ":changed"; }],
  ["generator replacement", (f) => { f.world.generatorVersion++; }],
  ["dimension resolver replacement", (f) => {
    const resolver = f.world.specForDimension;
    f.world.specForDimension = (dimension) => resolver(dimension);
  }],
  ["coordinator replacement", (f) => {
    const coordinator = new TransactionCoordinator();
    assert.equal(coordinator.register(f.overflow, f.overflow.reservedBytes), true);
    f.overflow.coordinator = coordinator;
  }],
  ["legacy flush in progress", (f) => { f.overflow._legacyBusy = true; }],
  ["disposal", (f) => f.overflow.dispose()],
];
for (const [name, invalidate] of staleCases)
  test(`native aggregation preserves member guards for ${name} before and after preparation`, (t) => {
    const f = fixture(t);
    assert.equal(f.overflow.addBatch([entry(named("retained"))]), true);
    const parts = additions(f, [[entry(named("retained"))], [entry(named("other"))]]);
    const combined = combine(f, parts);
    invalidate(f);
    const before = snapshot(f);
    assert.equal(f.overflow.prepareParticipantBatch(parts), null);
    assert.equal(f.coordinator.commit([combined]).ok, false);
    assert.deepEqual(snapshot(f), before);
    f.overflow._legacyBusy = false;
    f.overflow.coordinator = f.coordinator;
  });

test("a consumed empty member cannot be revived even by a same-byte revision ABA", (t) => {
  const f = fixture(t), parts = additions(f, [[], []]);
  const combined = combine(f, parts), revision = f.overflow.revision;
  assert.equal(f.coordinator.commit([parts[0]]).ok, true);
  f.overflow._revision = revision;
  assert.equal(parts[0].validate(), false);
  assert.equal(f.overflow.prepareParticipantBatch(parts), null);
  assert.equal(f.coordinator.commit([combined]).ok, false);
  assert.equal(f.overflow.size, 0);
});

test("aggregate publication consumes all member tokens, not only their captured revisions", (t) => {
  const f = fixture(t), parts = additions(f, [[], []]);
  const combined = combine(f, parts), revision = f.overflow.revision;
  assert.equal(f.coordinator.commit([combined]).ok, true);
  f.overflow._revision = revision;
  for (const part of [...parts, combined]) assert.equal(part.validate(), false);
  assert.equal(f.overflow.prepareParticipantBatch(parts), null);
});

test("only authentic native add identities may enter aggregation; forged callbacks never run", (t) => {
  const f = fixture(t), other = fixture(t, { coordinator: f.coordinator });
  const [a, b] = additions(f, [[entry(named("a"))], [entry(named("b"))]]);
  const [foreign] = additions(other, [[entry(named("foreign"))]]);
  let calls = 0;
  const forged = {
    owner: f.overflow, beforeBytes: 0, afterBytes: 0,
    validate: () => { calls++; return true; },
    publish: () => { calls++; },
  };
  const ownerGetter = { get owner() { calls++; throw new Error("owner getter must not run"); } };
  const accessor = [a, b];
  Object.defineProperty(accessor, 1, { get() { calls++; return b; } });
  const revoked = Proxy.revocable([a, b], {});
  revoked.revoke();
  const before = snapshot(f);
  for (const input of [
    null, {}, [], [a], new Array(2), [a, null], [a, a], accessor, revoked.proxy,
    [a, forged], [a, ownerGetter], [a, { ...b }], [a, Object.create(b)],
    [a, new Proxy(b, {})], [a, { ...b, publish: forged.publish }],
    [a, foreign], [a, { ...foreign, owner: f.overflow }],
  ]) assert.equal(f.overflow.prepareParticipantBatch(input), null);
  assert.equal(calls, 0);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.coordinator.commit([a, b]).reason, "duplicate-owner");
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.coordinator.commit([combine(f, [a, b])]).ok, true);
});

test("overridden public preparers cannot inject the aggregate publisher", (t) => {
  const f = fixture(t);
  t.mock.method(f.overflow, "_prepareChanges", () => assert.fail("native plans must not trust a public override"));
  const parts = additions(f, [[entry(named("a"))], [entry(named("b"))]]);
  t.mock.method(f.overflow, "prepareAddBatch", () => assert.fail("aggregate must use native construction"));
  const combined = combine(f, parts);
  assert.equal(f.coordinator.commit([combined]).ok, true);
  assert.deepEqual(f.overflow.serialize().entries.map(({ data }) => data.name), ["a", "b"]);
});

test("flushes, generic rewrites, nested aggregates and overlapping constituent plans stay unsupported", (t) => {
  const f = fixture(t);
  assert.equal(f.overflow.addBatch([entry(named("retained", 4))]), true);
  const [a, b, c] = additions(f, [
    [entry(named("a"))], [entry(named("b"))], [entry(named("c"))],
  ]);
  const [key, retained] = f.overflow.entries.entries().next().value;
  const flush = f.overflow.prepareFlushRecord(key, f.world, f.pickups).participants[0];
  const rewrite = f.overflow._prepareChanges(new Map([[key, { ...retained, count: 5 }]]));
  const ab = combine(f, [a, b]), bc = combine(f, [b, c]), before = snapshot(f);
  for (const parts of [[a, flush], [a, rewrite], [ab, c], [ab, a], [ab, bc]])
    assert.equal(f.overflow.prepareParticipantBatch(parts), null);
  assert.equal(f.coordinator.commit([ab, bc]).reason, "duplicate-owner");
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.coordinator.commit([ab]).ok, true);
  const paid = snapshot(f);
  assert.equal(f.coordinator.commit([bc]).ok, false);
  assert.deepEqual(snapshot(f), paid);
});

test("the aggregate snapshots the member list and retains guards for removed caller entries", (t) => {
  const f = fixture(t), members = additions(f, [[entry(named("a"))], [entry(named("b"))]]);
  const first = members[0], combined = combine(f, members);
  members.shift();
  assert.equal(f.coordinator.commit([first]).ok, true);
  const before = snapshot(f);
  assert.equal(f.coordinator.commit([combined]).ok, false);
  assert.deepEqual(snapshot(f), before);
});

test("aggregate member and normalized-work bounds are inclusive and reject excess work before publication", (t) => {
  const f = fixture(t), cap = OVERFLOW_AGGREGATE_LIMITS;
  assert.deepEqual(cap, { parts: 64, records: 4096 });
  const empty = additions(f, Array.from({ length: cap.parts + 1 }, () => []));
  assert.equal(f.overflow.prepareParticipantBatch(empty), null);
  assert.ok(f.overflow.prepareParticipantBatch(empty.slice(0, cap.parts)));
  const rows = Array.from({ length: cap.records / 2 + 1 }, (_, index) =>
    entry(named("same"), { x: at.x + index }));
  const [a, b, excess] = additions(f, [rows.slice(1), rows.slice(1), rows]);
  const before = snapshot(f);
  assert.equal(f.overflow.prepareParticipantBatch([a, excess]), null);
  const combined = combine(f, [a, b]);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.coordinator.commit([combined]).ok, true);
  assert.equal(f.overflow.size, cap.records / 2);
  assert.equal(f.overflow.serialize().entries.every(({ count }) => count === 2), true);
  exactBytes(f);
});

test("aggregated metadata and worn duplicates survive cold saves and actual overflow-to-pickup transfers", (t) => {
  const f = fixture(t), motion = { pickupDelay: 2, velocity: { x: 3, y: 2, z: -1 } };
  const parts = additions(f, [
    [entry(named("first", 3), motion), entry({ ...tool(), count: 3, durability: [7, 17, 7] }, motion)],
    [entry(named("second", 2), motion), entry(tool(), motion)],
  ]);
  assert.equal(f.coordinator.commit([combine(f, parts)]).ok, true);
  const saved = JSON.parse(JSON.stringify(f.overflow.serialize()));
  assert.deepEqual(normalizeOverflowSnapshot(saved, { context: f.world }), saved);
  const restored = fixture(t);
  assert.equal(restored.overflow.load(saved), true);
  assert.deepEqual(restored.overflow.serialize(), saved);
  saved.entries[0].data.name = "mutated import";
  assert.equal(restored.overflow.serialize().entries[0].data.name, "first");
  let transfers = 0;
  // A round-robin cursor wrap is a valid zero-transfer call.
  for (let i = 0; i < 16 && restored.overflow.size; i++) {
    transfers += restored.overflow.flush(restored.world, restored.pickups, 1);
    exactBytes(restored);
  }
  assert.equal(transfers, 6);
  assert.equal(restored.overflow.size, 0);
  const records = restored.pickups.serialize().items;
  assert.deepEqual(records.filter(({ id }) => id === ITEM.APPLE)
    .map(({ data, count }) => [data.name, count]), [["first", 3], ["second", 2]]);
  assert.deepEqual(records.filter(({ id }) => id === ITEM.IRON_PICKAXE)
    .flatMap(({ durability }) => durability).sort((a, b) => a - b), [7, 7, 7, 17]);
  for (const record of records) {
    assert.equal(record.pickupDelay, motion.pickupDelay);
    assert.deepEqual(record.velocity, motion.velocity);
    if (record.id === ITEM.IRON_PICKAXE) assert.deepEqual(record.data, tool().data);
  }
});

test("a full visible pickup pool cannot discard any part of a committed aggregate", (t) => {
  const f = fixture(t);
  assert.equal(f.pickups.spawn(ITEM.WOOD_PICKAXE, MAX_PICKUPS, at), true);
  const parts = additions(f, [[entry(named("one", 3))], [entry(tool(17))]]);
  assert.equal(f.coordinator.commit([combine(f, parts)]).ok, true);
  const before = snapshot(f);
  assert.equal(f.overflow.flush(f.world, f.pickups), 0);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.overflow.serialize().entries.reduce((sum, row) => sum + row.count, 0), 4);
});
