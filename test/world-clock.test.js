import assert from "node:assert/strict";
import test from "node:test";
import { encodedBytes } from "../src/save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "../src/transactions.js";
import {
  advanceWorldClock,
  DAWN_TIME,
  DAY_SECONDS,
  isSleepTime,
  normalizeWorldClock,
  sleepWorldClock,
  WorldClock,
  WORLD_CLOCK_BYTES,
} from "../src/world-clock.js";

const state = (time, day = 0) => ({ version: 1, day, time });

test("calendar advancement counts midnight crossings without touching its input", () => {
  const original = Object.freeze(state(0.75, 8));
  assert.deepEqual(
    advanceWorldClock(original, DAY_SECONDS / 2),
    state(0.25, 9)
  );
  assert.deepEqual(
    advanceWorldClock(original, DAY_SECONDS * 2),
    state(0.75, 10)
  );
  assert.deepEqual(original, state(0.75, 8));
  assert.deepEqual(advanceWorldClock(original, 0), original);
});

test("late and early night sleep reach the next dawn without a second midnight increment", () => {
  assert.deepEqual(sleepWorldClock(state(0.9, 4)), state(DAWN_TIME, 5));
  assert.deepEqual(sleepWorldClock(state(0.1, 5)), state(DAWN_TIME, 5));
  assert.equal(isSleepTime(0.75), true);
  assert.equal(isSleepTime(0.25), false);
  assert.equal(isSleepTime(DAWN_TIME), false);
  assert.equal(sleepWorldClock(state(DAWN_TIME)), null);
  assert.equal(sleepWorldClock(state(0.5)), null);
});

test("preflight rejects unknown versions, malformed clocks and unsafe day arithmetic", () => {
  for (const value of [
    null,
    {},
    [],
    { ...state(0.4), version: 2 },
    state(-0.1),
    state(1),
    state(Infinity),
    state(NaN),
    state(0.4, -1),
    state(0.4, 0.5),
    state(0.4, Number.MAX_SAFE_INTEGER + 1),
    { ...state(0.4), elapsed: 50000 },
  ])
    assert.equal(normalizeWorldClock(value), null);
  for (const seconds of [-1, Infinity, NaN, "1"])
    assert.equal(advanceWorldClock(state(0.4), seconds), null);
  assert.equal(
    advanceWorldClock(state(0.9, Number.MAX_SAFE_INTEGER), DAY_SECONDS),
    null
  );
  assert.equal(sleepWorldClock(state(0.9, Number.MAX_SAFE_INTEGER)), null);
});

test("clock state has one bounded reservation and prepared sleep can be vetoed jointly", () => {
  const coordinator = new TransactionCoordinator();
  const clock = new WorldClock({ coordinator, snapshot: state(0.9, 3) });
  const owner = {};
  assert.equal(coordinator.register(owner, 0), true);
  const before = clock.serialize();
  const sleep = clock.prepareSleep();
  assert.deepEqual(clock.serialize(), before);
  assert.equal(
    coordinator.commit([
      sleep,
      {
        owner,
        beforeBytes: 0,
        afterBytes: 0,
        validate: () => false,
        publish: () =>
          assert.fail("a rejected clock never publishes the other owner"),
      },
    ]).ok,
    false
  );
  assert.deepEqual(clock.serialize(), before);
  assert.equal(coordinator.commit([clock.prepareSleep()]).ok, true);
  assert.deepEqual(clock.serialize(), state(DAWN_TIME, 4));
  assert.equal(coordinator.usage(clock), WORLD_CLOCK_BYTES);
  assert.ok(encodedBytes(clock.serialize()) < WORLD_CLOCK_BYTES);
  assert.equal(clock.advance(DAY_SECONDS * 20), true);
  assert.equal(coordinator.usage(clock), WORLD_CLOCK_BYTES);
  clock.dispose();
  assert.equal(coordinator.usage(clock), undefined);
});

test("loading invalidates pending clock edits and returns detached snapshots", () => {
  const clock = new WorldClock();
  const pending = clock.prepareAdvance(60);
  const replacement = state(0.88, 9);
  assert.equal(clock.load(replacement), true);
  replacement.day = 200;
  assert.equal(clock.day, 9);
  assert.equal(clock.coordinator.commit([pending]).ok, false);
  const snapshot = clock.serialize();
  snapshot.time = 0;
  assert.equal(clock.time, 0.88);
  assert.equal(clock.load({ ...snapshot, version: 99 }), false);
  assert.deepEqual(clock.serialize(), state(0.88, 9));
  const sleep = clock.prepareSleep();
  clock.dispose();
  assert.equal(clock.coordinator.commit([sleep]).ok, false);
});

test("clock observers run after joint publication and cannot reject a committed dawn", () => {
  const error = new Error("clock observer");
  const clock = new WorldClock({
    snapshot: state(0.9),
    onChange: (snapshot) => {
      assert.deepEqual(snapshot, state(DAWN_TIME, 1));
      throw error;
    },
  });
  const committed = clock.coordinator.commit([clock.prepareSleep()]);
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.observerErrors, [error]);
  assert.deepEqual(clock.serialize(), state(DAWN_TIME, 1));
  clock.dispose();
});

test("clock convenience methods retain observer errors and propagate nested publication invariants", () => {
  const error = new Error("clock observer");
  const clock = new WorldClock({
    onChange: () => {
      throw error;
    },
  });
  assert.equal(clock.setTime(0.5), true);
  assert.deepEqual(clock.observerErrors, [error]);
  const fatal = new TransactionInvariantError("nested publication", error);
  clock.onChange = () => {
    throw fatal;
  };
  assert.throws(
    () => clock.advance(DAY_SECONDS),
    (value) => value === fatal
  );
  assert.deepEqual(clock.serialize(), state(0.5, 1));
  clock.dispose();
});

test("the existing time slider can set a normalized phase without advancing its day", () => {
  const observations = [];
  const clock = new WorldClock({
    snapshot: state(0.5, 7),
    onChange: (snapshot) => observations.push(snapshot),
  });
  assert.equal(clock.setTime(1), true);
  assert.deepEqual(clock.serialize(), state(0, 7));
  assert.equal(clock.setTime(0.1), true);
  assert.deepEqual(clock.serialize(), state(0.1, 7));
  assert.equal(clock.setTime(Infinity), false);
  assert.equal(observations.length, 2);
  assert.equal(clock.load(state(0.3), null), false);
  clock.dispose();
});

test("clock disposal rejected during validation leaves its reservation and state intact", () => {
  const clock = new WorldClock();
  const coordinator = clock.coordinator,
    owner = {};
  coordinator.register(owner, 0);
  const before = clock.serialize();
  const result = coordinator.commit([
    {
      owner,
      beforeBytes: 0,
      afterBytes: 0,
      validate: () => {
        assert.equal(clock.dispose(), false);
        return true;
      },
      publish: () => assert.fail("reentrant disposal cannot publish"),
    },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(clock.serialize(), before);
  assert.equal(coordinator.usage(clock), WORLD_CLOCK_BYTES);
  assert.equal(clock.dispose(), true);
});
