import assert from "node:assert/strict";
import test from "node:test";
import { TransitionGate } from "../src/transition-gate.js";

test("transitions acquire synchronously before IO and reject competing requests", async () => {
  const gate = new TransitionGate();
  const reading = Promise.withResolvers();
  let started = false;
  let competingCalls = 0;
  const first = gate.run(async () => {
    started = true;
    await reading.promise;
    return { ok: true };
  });
  assert.equal(started, true);
  assert.equal(gate.busy, true);
  for (let i = 0; i < 2; i++) {
    const result = await gate.run(() => competingCalls++);
    assert.equal(result.ok, false);
    assert.match(result.message, /transition.*in progress/);
  }
  assert.equal(competingCalls, 0);
  reading.resolve();
  assert.deepEqual(await first, { ok: true });
  assert.equal(gate.busy, false);
  assert.equal(await gate.run(() => "next world"), "next world");
  assert.equal(competingCalls, 0, "Rejected requests must never be queued");
});

test("the gate stays held through initialization and the final save", async () => {
  const gate = new TransitionGate();
  const initializing = Promise.withResolvers();
  const saving = Promise.withResolvers();
  const saveStarted = Promise.withResolvers();
  const first = gate.run(async () => {
    await initializing.promise;
    saveStarted.resolve();
    await saving.promise;
    return "saved";
  });
  initializing.resolve();
  await saveStarted.promise;
  assert.equal(gate.busy, true);
  const result = await gate.run(() => assert.fail("Concurrent transition ran"));
  assert.equal(result.ok, false);
  saving.resolve();
  assert.equal(await first, "saved");
  assert.equal(gate.busy, false);
});

for (const asynchronous of [false, true]) {
  test(`the gate releases after an ${asynchronous ? "asynchronous" : "immediate"} failure`, async () => {
    const gate = new TransitionGate();
    const error = new Error("World initialization failed");
    const operation = asynchronous
      ? () => Promise.reject(error)
      : () => {
          throw error;
        };
    await assert.rejects(gate.run(operation), (caught) => caught === error);
    assert.equal(gate.busy, false);
    assert.equal(await gate.run(() => "recovered"), "recovered");
  });
}

test("cancelled transitions return their result and release ownership", async () => {
  const gate = new TransitionGate();
  const cancelled = { ok: false, message: "Import cancelled" };
  assert.equal(await gate.run(() => cancelled), cancelled);
  assert.equal(gate.busy, false);
  assert.equal(await gate.run(() => true), true);
});

test("manual leases are exclusive and an old release cannot unlock a new owner", async () => {
  const gate = new TransitionGate();
  const first = gate.tryAcquire();
  assert.equal(typeof first, "function");
  assert.equal(gate.busy, true);
  assert.equal(gate.tryAcquire(), null);
  assert.equal((await gate.run(() => assert.fail("Already owned"))).ok, false);
  first();
  assert.equal(gate.busy, false);
  const second = gate.tryAcquire();
  first();
  assert.equal(gate.busy, true);
  assert.equal(gate.tryAcquire(), null);
  second();
  assert.equal(gate.busy, false);
});
