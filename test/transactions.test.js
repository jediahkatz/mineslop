import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RESERVED_BYTES, SaveBudget } from "../src/save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "../src/transactions.js";

function state(coordinator, bytes = 0) {
  const owner = { value: 0, revision: 0 };
  assert.equal(coordinator.register(owner, bytes), true);
  return owner;
}

function prepare(
  coordinator,
  owner,
  afterBytes = coordinator.usage(owner),
  overrides = {}
) {
  const revision = owner.revision;
  let used = false;
  return {
    owner,
    beforeBytes: coordinator.usage(owner),
    afterBytes,
    validate: () => !used && owner.revision === revision,
    publish() {
      owner.value++;
      owner.revision++;
      used = true;
    },
    ...overrides,
  };
}

function assertRejected(result) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
}

test("the coordinator owns a default budget or uses the supplied shared budget", () => {
  const defaultCoordinator = new TransactionCoordinator();
  assert.ok(defaultCoordinator.budget instanceof SaveBudget);
  const budget = new SaveBudget();
  const coordinator = new TransactionCoordinator({ budget });
  const owner = state(coordinator, 12);
  assert.equal(coordinator.budget, budget);
  assert.equal(coordinator.usage(owner), 12);
  assert.equal(coordinator.register(owner, 13), true);
  assert.equal(budget.usage(owner), 13);
  assert.equal(coordinator.register(owner, -1), false);
  assert.equal(coordinator.usage(owner), 13);
  assert.equal(coordinator.release(owner), true);
  assert.equal(coordinator.release(owner), false);
  assert.equal(coordinator.usage(owner), undefined);
  assert.equal(budget.totalBytes, 0);
  assert.deepEqual(coordinator.commit([]), { ok: true, observerErrors: [] });
  assert.throws(() => new TransactionCoordinator({ budget: {} }), TypeError);
});

test("all owners and the budget publish before the first observer runs", () => {
  const coordinator = new TransactionCoordinator();
  const first = state(coordinator, 10);
  const second = state(coordinator, 20);
  const observations = [];
  const notify = () => {
    observations.push([
      first.value,
      second.value,
      coordinator.usage(first),
      coordinator.usage(second),
      coordinator.budget.totalBytes,
    ]);
  };
  const result = coordinator.commit([
    prepare(coordinator, first, 15, { notify }),
    prepare(coordinator, second, 8, { notify }),
  ]);
  assert.deepEqual(result, { ok: true, observerErrors: [] });
  assert.deepEqual(observations, [
    [1, 1, 15, 8, 23],
    [1, 1, 15, 8, 23],
  ]);
});

test("failed, thrown, and thenable validations leave every owner and reservation unchanged", () => {
  const validators = [
    () => false,
    () => undefined,
    () => 1,
    () => ({}),
    () => {
      throw new Error("stale prerequisite");
    },
    () => Promise.resolve(true),
    () => ({
      then() {
        assert.fail("invalid thenable must not be invoked");
      },
    }),
  ];
  for (const validate of validators) {
    const coordinator = new TransactionCoordinator();
    const first = state(coordinator, 10);
    const second = state(coordinator, 20);
    let notifications = 0;
    assertRejected(
      coordinator.commit([
        prepare(coordinator, first, 0, { notify: () => notifications++ }),
        prepare(coordinator, second, 40, { validate }),
      ])
    );
    assert.deepEqual(first, { value: 0, revision: 0 });
    assert.deepEqual(second, { value: 0, revision: 0 });
    assert.equal(coordinator.usage(first), 10);
    assert.equal(coordinator.usage(second), 20);
    assert.equal(coordinator.budget.totalBytes, 30);
    assert.equal(notifications, 0);
  }
});

test("async and generator callbacks reject during preflight without invoking their bodies", () => {
  for (const field of ["validate", "publish", "notify"]) {
    let invoked = 0;
    const asynchronous = async () => {
      invoked++;
      return true;
    };
    const generator = function* () {
      invoked++;
      yield true;
    };
    const asyncGenerator = async function* () {
      invoked++;
      yield true;
    };
    for (const callback of [
      asynchronous,
      asynchronous.bind(null),
      generator,
      asyncGenerator,
      null,
    ]) {
      const coordinator = new TransactionCoordinator();
      const first = state(coordinator);
      const second = state(coordinator);
      assertRejected(
        coordinator.commit([
          prepare(coordinator, first, 1),
          prepare(coordinator, second, 1, { [field]: callback }),
        ])
      );
      assert.equal(first.value, 0);
      assert.equal(second.value, 0);
      assert.equal(coordinator.budget.totalBytes, 0);
      assert.equal(invoked, 0);
    }
  }
});

test("malformed participants, duplicate owners, and unknown owners reject the whole batch", () => {
  const coordinator = new TransactionCoordinator();
  const owner = state(coordinator, 10);
  const participant = prepare(coordinator, owner, 20);
  for (const participants of [
    null,
    undefined,
    {},
    new Array(1),
    [null],
    [{}],
    [participant, participant],
    [participant, { ...participant }],
    [participant, { ...participant, owner: {} }],
    [participant, { ...participant, owner: "inventory" }],
  ]) {
    assertRejected(coordinator.commit(participants));
    assert.equal(owner.value, 0);
    assert.equal(coordinator.usage(owner), 10);
    assert.equal(coordinator.budget.totalBytes, 10);
  }
});

test("invalid byte counts reject before installation, including a valid freeing participant", () => {
  const coordinator = new TransactionCoordinator();
  const first = state(coordinator, 10);
  const second = state(coordinator, 20);
  for (const field of ["beforeBytes", "afterBytes"]) {
    for (const bytes of [
      -1,
      0.1,
      NaN,
      Infinity,
      "1",
      null,
      undefined,
      1n,
      2 ** 53,
    ]) {
      assertRejected(
        coordinator.commit([
          prepare(coordinator, first, 0),
          prepare(coordinator, second, 20, { [field]: bytes }),
        ])
      );
      assert.equal(first.value, 0);
      assert.equal(second.value, 0);
      assert.equal(coordinator.usage(first), 10);
      assert.equal(coordinator.usage(second), 20);
      assert.equal(coordinator.budget.totalBytes, 30);
    }
  }
});

test("changed reservations and released owners invalidate prepared transactions", () => {
  const coordinator = new TransactionCoordinator();
  const owner = state(coordinator, 10);
  const participant = prepare(coordinator, owner, 15);
  coordinator.register(owner, 12);
  assertRejected(coordinator.commit([participant]));
  assert.equal(coordinator.usage(owner), 12);
  assert.equal(owner.value, 0);
  coordinator.release(owner);
  assertRejected(coordinator.commit([participant]));
  assert.equal(coordinator.budget.totalBytes, 0);
  assert.equal(owner.value, 0);
});

test("read-only neighbor prerequisites reject stale geometry even with unchanged owner bytes", () => {
  const coordinator = new TransactionCoordinator();
  const owner = state(coordinator, 10);
  const neighbor = { revision: 4 };
  const neighborRevision = neighbor.revision;
  const participant = prepare(coordinator, owner, 10);
  const validateOwner = participant.validate;
  participant.validate = () =>
    validateOwner() && neighbor.revision === neighborRevision;
  neighbor.revision++;
  assertRejected(coordinator.commit([participant]));
  assert.equal(owner.value, 0);
  assert.equal(coordinator.usage(owner), 10);
});

test("replacement registration does not waive domain revisions or single-use checks", () => {
  const coordinator = new TransactionCoordinator();
  const owner = state(coordinator, 10);
  const beforeLoad = prepare(coordinator, owner);
  owner.value = 8;
  owner.revision++;
  assert.equal(coordinator.register(owner, 10), true);
  assertRejected(coordinator.commit([beforeLoad]));
  assert.equal(owner.value, 8);
  const current = prepare(coordinator, owner);
  assert.equal(coordinator.commit([current]).ok, true);
  assert.equal(coordinator.register(owner, 10), true);
  assertRejected(coordinator.commit([current]));
  assert.equal(owner.value, 9);
  assert.equal(coordinator.budget.totalBytes, 10);
});

test("participant methods retain their receiver for domain-owned single-use state", () => {
  const coordinator = new TransactionCoordinator();
  const owner = state(coordinator);
  let observed = false;
  const participant = {
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    used: false,
    validate() {
      return !this.used;
    },
    publish() {
      this.used = true;
      owner.value++;
    },
    notify() {
      observed = this.used;
    },
  };
  assert.deepEqual(coordinator.commit([participant]), {
    ok: true,
    observerErrors: [],
  });
  assert.equal(observed, true);
  assertRejected(coordinator.commit([participant]));
  assert.equal(owner.value, 1);
});

test("capacity is aggregated across owners and rejects before any publication", () => {
  const coordinator = new TransactionCoordinator();
  const consumer = state(coordinator);
  const source = state(coordinator, MAX_RESERVED_BYTES);
  assertRejected(coordinator.commit([prepare(coordinator, consumer, 40)]));
  assert.equal(consumer.value, 0);
  assert.deepEqual(
    coordinator.commit([
      prepare(coordinator, consumer, 40),
      prepare(coordinator, source, MAX_RESERVED_BYTES - 40),
    ]),
    { ok: true, observerErrors: [] }
  );
  assert.equal(consumer.value, 1);
  assert.equal(source.value, 1);
  assert.equal(coordinator.usage(consumer), 40);
  assert.equal(coordinator.budget.totalBytes, MAX_RESERVED_BYTES);
});

test("retained over-budget input permits equal or smaller aggregate reservations only", () => {
  const coordinator = new TransactionCoordinator();
  const source = state(coordinator);
  const consumer = state(coordinator);
  const importedBytes = MAX_RESERVED_BYTES + 100;
  assert.equal(
    coordinator.register(source, importedBytes, { allowOverBudget: true }),
    true
  );
  assertRejected(coordinator.commit([prepare(coordinator, consumer, 1)]));
  assert.equal(consumer.value, 0);
  assert.equal(
    coordinator.commit([
      prepare(coordinator, consumer, 10),
      prepare(coordinator, source, importedBytes - 10),
    ]).ok,
    true
  );
  assert.equal(coordinator.budget.totalBytes, importedBytes);
  assert.equal(
    coordinator.commit([prepare(coordinator, source, MAX_RESERVED_BYTES - 11)])
      .ok,
    true
  );
  assert.equal(coordinator.budget.totalBytes, MAX_RESERVED_BYTES - 1);
  assert.equal(
    coordinator.commit([prepare(coordinator, consumer, 11)]).ok,
    true
  );
});

test("recursive validation commits reject both requests before publication and release the guard", () => {
  const coordinator = new TransactionCoordinator();
  const first = state(coordinator);
  const second = state(coordinator);
  const nested = prepare(coordinator, second, 1);
  let nestedResult;
  const result = coordinator.commit([
    prepare(coordinator, first, 1, {
      validate() {
        nestedResult = coordinator.commit([nested]);
        return true;
      },
    }),
  ]);
  assert.deepEqual(nestedResult, { ok: false, reason: "reentrant-commit" });
  assert.deepEqual(result, { ok: false, reason: "reentrant-commit" });
  assert.equal(first.value, 0);
  assert.equal(second.value, 0);
  assert.equal(coordinator.budget.totalBytes, 0);
  assert.equal(coordinator.commit([nested]).ok, true);
  assert.equal(second.value, 1);
});

test("registration and release through the coordinator cannot mutate validation reservations", () => {
  for (const mutate of [
    (coordinator, owner) => coordinator.register(owner, 1),
    (coordinator, owner) => coordinator.release(owner),
  ]) {
    const coordinator = new TransactionCoordinator();
    const owner = state(coordinator);
    let mutationResult;
    const result = coordinator.commit([
      prepare(coordinator, owner, 2, {
        validate() {
          mutationResult = mutate(coordinator, owner);
          return true;
        },
      }),
    ]);
    assert.equal(mutationResult, false);
    assertRejected(result);
    assert.equal(owner.value, 0);
    assert.equal(coordinator.usage(owner), 0);
    assert.equal(coordinator.release(owner), true);
  }
});

test("postcommit observers may intentionally commit a follow-up action", () => {
  const coordinator = new TransactionCoordinator();
  const first = state(coordinator);
  const second = state(coordinator);
  let followUp;
  const result = coordinator.commit([
    prepare(coordinator, first, 10, {
      notify() {
        assert.equal(first.value, 1);
        assert.equal(coordinator.budget.totalBytes, 10);
        followUp = coordinator.commit([prepare(coordinator, second, 20)]);
      },
    }),
  ]);
  assert.deepEqual(result, { ok: true, observerErrors: [] });
  assert.deepEqual(followUp, { ok: true, observerErrors: [] });
  assert.equal(second.value, 1);
  assert.equal(coordinator.budget.totalBytes, 30);
});

test("throwing observers are collected without rejection or skipping subsequent observers", () => {
  const coordinator = new TransactionCoordinator();
  const first = state(coordinator);
  const second = state(coordinator);
  const failure = new Error("renderer failed");
  let observed = false;
  const result = coordinator.commit([
    prepare(coordinator, first, 10, {
      notify() {
        throw failure;
      },
    }),
    prepare(coordinator, second, 20, {
      notify() {
        observed = first.value === 1 && second.value === 1;
      },
    }),
  ]);
  assert.deepEqual(result, { ok: true, observerErrors: [failure] });
  assert.equal(observed, true);
  assert.equal(coordinator.usage(first), 10);
  assert.equal(coordinator.usage(second), 20);
});

test("thenable notifications report an observer error after ownership is committed", () => {
  const coordinator = new TransactionCoordinator();
  const owner = state(coordinator);
  const result = coordinator.commit([
    prepare(coordinator, owner, 1, { notify: () => Promise.resolve() }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.observerErrors.length, 1);
  assert.ok(result.observerErrors[0] instanceof TypeError);
  assert.equal(owner.value, 1);
  assert.equal(coordinator.usage(owner), 1);
});

test("publication throws are fatal invariants, not ordinary rejection or arbitrary rollback", () => {
  const coordinator = new TransactionCoordinator();
  const first = state(coordinator, 10);
  const second = state(coordinator, 20);
  const failure = new Error("invalid fallible publisher");
  let notifications = 0;
  assert.throws(
    () =>
      coordinator.commit([
        prepare(coordinator, first, 11, { notify: () => notifications++ }),
        prepare(coordinator, second, 21, {
          publish() {
            throw failure;
          },
        }),
      ]),
    (error) =>
      error instanceof TransactionInvariantError && error.cause === failure
  );
  assert.equal(
    first.value,
    1,
    "a contract-breaking publisher cannot be rolled back"
  );
  assert.equal(second.value, 0);
  assert.equal(coordinator.usage(first), 10);
  assert.equal(coordinator.usage(second), 20);
  assert.equal(notifications, 0);
});

test("thenable publication is a fatal invariant even when its synchronous prefix wrote state", () => {
  const coordinator = new TransactionCoordinator();
  const owner = state(coordinator);
  assert.throws(
    () =>
      coordinator.commit([
        prepare(coordinator, owner, 1, {
          publish() {
            owner.value = 7;
            return {
              then() {
                assert.fail("invalid publication thenable must not be invoked");
              },
            };
          },
        }),
      ]),
    (error) => error instanceof TransactionInvariantError
  );
  assert.equal(owner.value, 7);
  assert.equal(coordinator.usage(owner), 0);
});

test("publication has no boolean veto return; rejection belongs to validation", () => {
  const coordinator = new TransactionCoordinator();
  const owner = state(coordinator);
  const result = coordinator.commit([
    prepare(coordinator, owner, 1, {
      publish() {
        owner.value = 7;
        return false;
      },
    }),
  ]);
  assert.deepEqual(result, { ok: true, observerErrors: [] });
  assert.equal(owner.value, 7);
  assert.equal(coordinator.usage(owner), 1);
});
