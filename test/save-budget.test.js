import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  encodedBytes,
  MAX_ARCHIVE_BYTES,
  MAX_RESERVED_BYTES,
  SaveBudget,
} from "../src/save-budget.js";

const change = (owner, beforeBytes, afterBytes) => ({
  owner,
  beforeBytes,
  afterBytes,
});
const invalidBytes = [-1, 0.5, NaN, Infinity, "1", null, 1n, 2 ** 53];

test("reservations use reference identity and distinguish unknown from zero-byte owners", () => {
  const budget = new SaveBudget();
  const first = { name: "inventory" };
  const second = { name: "inventory" };
  const callableOwner = () => {};
  assert.equal(budget.usage(first), undefined);
  assert.equal(budget.register(first), true);
  assert.equal(budget.register(second, 12), true);
  assert.equal(budget.register(callableOwner, 3), true);
  assert.equal(budget.usage(first), 0);
  assert.equal(budget.usage(second), 12);
  assert.equal(budget.totalBytes, 15);
  assert.equal(budget.release(first), true);
  assert.equal(budget.release(first), false);
  assert.equal(budget.usage(first), undefined);
  assert.equal(budget.release(second), true);
  assert.equal(budget.totalBytes, 3);
  for (const owner of [
    null,
    undefined,
    "inventory",
    1,
    false,
    Symbol("owner"),
  ]) {
    assert.equal(budget.register(owner, 1), false);
    assert.equal(budget.release(owner), false);
  }
  assert.equal(budget.totalBytes, 3);
});

test("staged-load registration replaces usage atomically, including failure paths", () => {
  const budget = new SaveBudget();
  const owner = {};
  const other = {};
  budget.register(owner, 20);
  budget.register(other, MAX_RESERVED_BYTES - 20);
  for (const bytes of [...invalidBytes, 21]) {
    assert.equal(budget.register(owner, bytes), false);
    assert.equal(budget.usage(owner), 20);
    assert.equal(budget.totalBytes, MAX_RESERVED_BYTES);
  }
  for (const options of [
    null,
    [],
    true,
    { allowOverBudget: "yes" },
    { allowOverBudget: null },
    {
      get allowOverBudget() {
        throw new Error("invalid registration options");
      },
    },
  ]) {
    assert.equal(budget.register(owner, 21, options), false);
    assert.equal(budget.usage(owner), 20);
    assert.equal(budget.totalBytes, MAX_RESERVED_BYTES);
  }
  assert.equal(budget.register(owner, 7), true);
  assert.equal(budget.usage(owner), 7);
  assert.equal(budget.totalBytes, MAX_RESERVED_BYTES - 13);
  const unknown = {};
  assert.equal(budget.register(unknown, 14), false);
  assert.equal(budget.usage(unknown), undefined);
  assert.equal(budget.totalBytes, MAX_RESERVED_BYTES - 13);
});

test("the whole batch frees capacity before accounting for any consumption", () => {
  const budget = new SaveBudget();
  const consumer = {};
  const source = {};
  budget.register(consumer);
  budget.register(source, MAX_RESERVED_BYTES);
  const changes = [
    change(consumer, 0, 30),
    change(source, MAX_RESERVED_BYTES, MAX_RESERVED_BYTES - 30),
  ];
  assert.equal(budget.canCommit(changes), true);
  assert.equal(budget.usage(consumer), 0, "admission is read-only");
  assert.equal(budget.totalBytes, MAX_RESERVED_BYTES);
  assert.equal(budget.commit(changes), true);
  assert.equal(budget.usage(consumer), 30);
  assert.equal(budget.usage(source), MAX_RESERVED_BYTES - 30);
  assert.equal(budget.totalBytes, MAX_RESERVED_BYTES);
  assert.equal(
    budget.commit(changes),
    false,
    "old byte reservations are stale"
  );
  assert.equal(budget.usage(consumer), 30);
  assert.equal(budget.totalBytes, MAX_RESERVED_BYTES);
});

test("invalid, duplicate, unknown, and stale reservations never partially commit", () => {
  const budget = new SaveBudget();
  const first = {};
  const second = {};
  budget.register(first, 10);
  budget.register(second, 20);
  const invalid = [
    null,
    {},
    new Array(1),
    [null],
    [{}],
    [change(first, 10, 0), change(first, 10, 3)],
    [change(first, 10, 0), change({}, 0, 3)],
    [change(first, 10, 0), change(second, 19, 3)],
    [change(first, 10, 0), change(second, 20, MAX_RESERVED_BYTES + 1)],
    ...[...invalidBytes, undefined].flatMap((bytes) => [
      [change(first, 10, 0), change(second, bytes, 0)],
      [change(first, 10, 0), change(second, 20, bytes)],
    ]),
  ];
  for (const changes of invalid) {
    assert.equal(budget.canCommit(changes), false);
    assert.equal(budget.commit(changes), false);
    assert.equal(budget.usage(first), 10);
    assert.equal(budget.usage(second), 20);
    assert.equal(budget.totalBytes, 30);
  }
  assert.equal(budget.commit([]), true);
  assert.equal(budget.totalBytes, 30);
});

test("commit rechecks admissions after registration replacement or release", () => {
  const budget = new SaveBudget();
  const owner = {};
  budget.register(owner, 10);
  const changes = [change(owner, 10, 15)];
  assert.equal(budget.canCommit(changes), true);
  budget.register(owner, 12);
  assert.equal(budget.commit(changes), false);
  assert.equal(budget.usage(owner), 12);
  budget.register(owner, 10);
  assert.equal(budget.canCommit(changes), true);
  budget.release(owner);
  assert.equal(budget.commit(changes), false);
  assert.equal(budget.usage(owner), undefined);
  assert.equal(budget.totalBytes, 0);
});

test("accepted large imports retain every reserved byte and permit only non-increasing totals", () => {
  const budget = new SaveBudget();
  const archive = {};
  const destination = {};
  const retainedBytes = MAX_ARCHIVE_BYTES - 1;
  assert.equal(budget.register(archive, 48 * 1024 * 1024), true);
  assert.equal(budget.register(archive, retainedBytes), false);
  assert.equal(
    budget.register(archive, retainedBytes, { allowOverBudget: true }),
    true
  );
  assert.equal(budget.usage(archive), retainedBytes);
  assert.equal(budget.register(destination), true);
  assert.equal(budget.register(destination, 1), false);
  assert.equal(budget.register(archive, retainedBytes + 1), false);
  assert.equal(
    budget.commit([change(archive, retainedBytes, retainedBytes)]),
    true
  );
  assert.equal(
    budget.commit([
      change(destination, 0, 30),
      change(archive, retainedBytes, retainedBytes - 30),
    ]),
    true
  );
  assert.equal(budget.totalBytes, retainedBytes);
  assert.equal(budget.commit([change(destination, 30, 31)]), false);
  assert.equal(budget.register(archive, retainedBytes - 31), true);
  assert.equal(budget.totalBytes, retainedBytes - 1);
  assert.equal(
    budget.commit([
      change(archive, retainedBytes - 31, MAX_RESERVED_BYTES - 31),
    ]),
    true
  );
  assert.equal(budget.totalBytes, MAX_RESERVED_BYTES - 1);
  assert.equal(budget.commit([change(destination, 30, 31)]), true);
  assert.equal(budget.commit([change(destination, 31, 32)]), false);
});

test("aggregate arithmetic stays exact and transfers do not overflow transiently", () => {
  const budget = new SaveBudget();
  const first = {};
  const second = {};
  const third = {};
  const maximum = Number.MAX_SAFE_INTEGER;
  assert.equal(
    budget.register(first, maximum, { allowOverBudget: true }),
    true
  );
  assert.equal(budget.register(second), true);
  assert.equal(budget.register(third, 1, { allowOverBudget: true }), false);
  assert.equal(budget.usage(third), undefined);
  assert.equal(
    budget.commit([change(second, 0, maximum), change(first, maximum, 0)]),
    true
  );
  assert.equal(budget.totalBytes, maximum);
  assert.equal(
    budget.commit([change(first, 0, 1), change(second, maximum, maximum)]),
    false
  );
  assert.equal(budget.usage(first), 0);
  assert.equal(budget.usage(second), maximum);
});

test("encodedBytes measures UTF-8 JSON, including punctuation, escaping, and non-ASCII", () => {
  assert.equal(encodedBytes("é水😀"), 11);
  for (const value of [
    null,
    true,
    0,
    -0,
    [1, 2, 3],
    { é: "雪", name: "🧱", escaped: '"\\\n\t', loneSurrogate: "\ud800" },
    { nested: [{ name: "café" }, ["地", false]] },
  ]) {
    assert.equal(
      encodedBytes(value),
      Buffer.byteLength(JSON.stringify(value), "utf8")
    );
  }
});

test("encodedBytes follows JSON projection rather than estimating in-memory objects", () => {
  const value = {
    kept: "é",
    omitted: undefined,
    callback: () => {},
    symbol: Symbol("not archived"),
    numbers: [undefined, NaN, Infinity],
  };
  const json = '{"kept":"é","numbers":[null,null,null]}';
  assert.equal(encodedBytes(value), Buffer.byteLength(json, "utf8"));
  assert.equal(encodedBytes({ toJSON: () => ["雪"] }), encodedBytes(["雪"]));
});

test("encodedBytes rejects unsupported roots, bigint, cycles, and failed JSON projection", () => {
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    () => {},
    Symbol("not JSON"),
    1n,
    { nested: 1n },
    cycle,
    { toJSON: () => undefined },
  ]) {
    assert.throws(() => encodedBytes(value), TypeError);
  }
  const failure = new Error("projection failed");
  assert.throws(
    () =>
      encodedBytes({
        toJSON() {
          throw failure;
        },
      }),
    (error) => error === failure
  );
});
