import assert from "node:assert/strict";
import test from "node:test";
import { TransactionInvariantError } from "../src/transactions.js";
import { horseFixture } from "./horse-fixture.js";
import { finishResidentBatch, residentSource, residentState } from "./resident-edit-batch-fixture.js";

for (const failureKinds of [
  ["fatal"],
  ["ordinary", "fatal"],
  ["fatal", "ordinary"],
  ["fatal", "fatal"],
  ["ordinary", "ordinary"],
]) {
  test(`resident observers preserve ${failureKinds.join("/")} classification after all notifications`, (t) => {
    const f = horseFixture(t), w = f.wildlife;
    const failures = failureKinds.map((kind, index) => kind === "fatal"
      ? new TransactionInvariantError(`fatal observer ${index}`, new Error("underlying invariant"))
      : new Error(`ordinary observer ${index}`));
    const fatal = failures[failureKinds.indexOf("fatal")];
    const mobs = Array.from({ length: failures.length + 1 }, (_, index) => residentSource(f, {
      id: `resident-batch:observer:${index}`, kind: "zombie",
      position: { x: 2.5 + index * 2, y: 1, z: 2.5 },
    }));
    const before = residentState(f), revision = w._ecologyRevision;
    const health = mobs.map((mob) => mob.health), expectedHealth = health.map((value) => value - 1);
    const notifications = [];
    const batch = w.beginResidentEditBatch();
    const contributions = mobs.map((mob, index) => w.contributeLegacyDamage(batch, mob, 1, null, {
      retaliate: false,
      notify() {
        notifications.push({ index, health: mobs.map((entry) => entry.health), revision: w._ecologyRevision });
        if (index < failures.length) throw failures[index];
      },
    }));
    const plan = finishResidentBatch(w, batch, contributions);
    assert.deepEqual(residentState(f), before);
    assert.deepEqual(notifications, []);
    assert.equal(plan.participants.length, 1);
    const result = f.coordinator.commit(plan.participants);
    assert.equal(result.ok, true);
    assert.deepEqual(mobs.map((mob) => mob.health), expectedHealth);
    assert.equal(w._ecologyRevision, revision + 1);
    assert.deepEqual(notifications, mobs.map((_, index) => ({ index, health: expectedHealth, revision: revision + 1 })));
    assert.equal(result.observerErrors.length, 1);
    const [error] = result.observerErrors;
    if (fatal) {
      assert.equal(error, fatal, "surface the original first invariant, including its cause");
      assert.throws(() => {
        for (const observerError of result.observerErrors)
          if (observerError instanceof TransactionInvariantError) throw observerError;
      }, (surfaced) => surfaced === fatal);
    } else {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "Resident edit observers failed after commit");
      assert.deepEqual(error.errors, failures);
    }
    const committed = residentState(f);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(residentState(f), committed);
    assert.equal(notifications.length, mobs.length);
  });
}
