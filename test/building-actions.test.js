import assert from "node:assert/strict";
import test from "node:test";
import { buildingSupportCandidates } from "../src/building-actions.js";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "../src/transactions.js";
import { buildingFixture, placedBed } from "./building-fixture.js";

function commitBreak(f, proposal) {
  if (!proposal?.ok) return false;
  const mutation = f.world.prepareMutation(proposal.changes, {
    reads: proposal.reads,
    epoch: proposal.epoch,
  });
  if (!mutation) return false;
  const participants = [
    {
      ...mutation,
      validate: () => proposal.validate() && mutation.validate(),
    },
  ];
  if (proposal.dropCount)
    participants.push(
      f.game.preparePlayerDrops([
        { id: proposal.dropId, count: proposal.dropCount },
      ])
    );
  return f.coordinator.commit(participants).ok;
}

test("placing either hand debits once and publishes both door halves before observers", (t) => {
  for (const hand of ["main", "offhand"]) {
    const f = buildingFixture(t);
    f.hold(BLOCK.OAK_DOOR, 3, hand);
    let notifications = 0;
    f.world.onMutation = () => {
      notifications++;
      assert.equal(f.actions._busy, false);
      assert.equal(f.world.get(2, 21, 3), BLOCK.OAK_DOOR);
      assert.equal(f.world.get(2, 22, 3), BLOCK.OAK_DOOR);
      assert.equal(f.gameplay.getHandStack(hand).count, 2);
    };
    assert.equal(f.actions.place(hand, BLOCK.OAK_DOOR, f.hit()), true);
    assert.equal(notifications, 1);
    assert.equal(
      f.world.getBlockState(2, 22, 3) ^ f.world.getBlockState(2, 21, 3),
      S.PART
    );
  }
});

test("Creative requires the requested held item, including finite offhand, but never consumes it", (t) => {
  for (const hand of ["main", "offhand"]) {
    const f = buildingFixture(t);
    f.gameplay.setMode("creative");
    f.gameplay.select(0);
    if (hand === "main")
      assert.equal(f.gameplay.assignSlot(0, BLOCK.OAK_SLAB), true);
    else f.hold(BLOCK.OAK_SLAB, 4, hand);
    const held = f.gameplay.getHandStack(hand);
    assert.equal(f.actions.place(hand, BLOCK.OAK_STAIRS, f.hit()), false);
    assert.equal(f.actions.place(hand, BLOCK.OAK_SLAB, f.hit()), true);
    assert.deepEqual(f.gameplay.getHandStack(hand), held);
  }
});

test("slab merging costs one additional item, dries the double, and breaks into exactly two", (t) => {
  const f = buildingFixture(t);
  f.hold(BLOCK.OAK_SLAB, 4);
  f.put(2, 21, 3, BLOCK.WATER);
  assert.equal(f.actions.place("main", BLOCK.OAK_SLAB, f.hit()), true);
  assert.equal(f.world.getFluid(2, 21, 3), FLUID.WATER_SOURCE);
  assert.equal(
    f.actions.place(
      "main",
      BLOCK.OAK_SLAB,
      f.hit(2, 21, 3, { x: 0, y: 1, z: 0 }, { x: 0.5, y: 0.5, z: 0.5 })
    ),
    true
  );
  assert.equal(f.gameplay.getHandStack().count, 2);
  assert.equal(f.world.getBlockState(2, 21, 3), S.DOUBLE);
  assert.equal(f.world.getFluid(2, 21, 3), FLUID.NONE);
  const proposal = f.actions.prepareBreak(f.hit(2, 21, 3));
  assert.equal(proposal.dropId, BLOCK.OAK_SLAB);
  assert.equal(proposal.dropCount, 2);
  assert.equal(commitBreak(f, proposal), true);
  assert.equal(f.overflow.serialize().entries[0].count, 2);
  assert.equal(commitBreak(f, proposal), false);
  assert.equal(f.overflow.serialize().entries[0].count, 2);
});

test("capacity, support, intersection and source vetoes leave both inventory and terrain intact", (t) => {
  for (const reason of ["capacity", "support", "intersection", "source"]) {
    const f = buildingFixture(t);
    f.hold(BLOCK.OAK_DOOR, 3);
    if (reason === "support") f.put(2, 20, 3, BLOCK.OAK_SLAB);
    if (reason === "intersection") f.player.intersectsPlacement = () => true;
    if (reason === "source") {
      const prepare = f.gameplay.prepareHandCost.bind(f.gameplay);
      f.gameplay.prepareHandCost = (...args) => {
        const participant = prepare(...args);
        return { ...participant, validate: () => false };
      };
    }
    if (reason === "capacity") {
      const owner = {};
      assert.equal(
        f.coordinator.register(
          owner,
          MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
        ),
        true
      );
      t.after(() => f.coordinator.release(owner));
    }
    const before = f.snapshot();
    assert.equal(
      f.actions.place("main", BLOCK.OAK_DOOR, f.hit()),
      false,
      reason
    );
    assert.deepEqual(f.snapshot(), before, reason);
  }
});

test("a selected-slot change or player entering the proposed shape invalidates placement", (t) => {
  for (const cause of ["selection", "body"]) {
    const f = buildingFixture(t);
    f.hold(BLOCK.OAK_SLAB, 4);
    const selected = f.gameplay.selected;
    const prepare = f.world.prepareMutation.bind(f.world);
    f.world.prepareMutation = (...args) => {
      const participant = prepare(...args);
      if (cause === "selection") f.gameplay.select((selected + 1) % 9);
      else Object.assign(f.player.position, { x: 2.5, y: 21, z: 3.5 });
      return participant;
    };
    assert.equal(f.actions.place("main", BLOCK.OAK_SLAB, f.hit()), false);
    assert.equal(f.world.get(2, 21, 3), BLOCK.AIR);
    assert.equal(f.gameplay.slots[selected].count, 4);
  }
});

test("named blocks and replaceable player plants are retained instead of stripped or erased", (t) => {
  const f = buildingFixture(t);
  f.hold(BLOCK.OAK_SLAB, 2, "main", { version: 1, name: "Do not strip this" });
  let before = f.snapshot();
  assert.equal(f.actions.place("main", BLOCK.OAK_SLAB, f.hit()), false);
  assert.match(f.actions.lastResult.message, /plain/);
  assert.deepEqual(f.snapshot(), before);
  f.hold(BLOCK.OAK_SLAB, 2);
  f.put(2, 21, 3, BLOCK.TALL_GRASS);
  before = f.snapshot();
  assert.equal(f.actions.place("main", BLOCK.OAK_SLAB, f.hit()), false);
  assert.match(f.actions.lastResult.message, /plant/);
  assert.deepEqual(f.snapshot(), before);
});

test("door interaction toggles both halves atomically from either hit and returns no loot", (t) => {
  const f = buildingFixture(t);
  f.hold(BLOCK.OAK_DOOR, 2);
  assert.equal(f.actions.place("main", BLOCK.OAK_DOOR, f.hit()), true);
  const beforeCount = f.gameplay.getHandStack().count;
  for (const y of [22, 21]) {
    const expectedOpen = y === 22;
    f.world.onMutation = () => {
      assert.equal(f.actions._busy, false);
      assert.equal(!!(f.world.getBlockState(2, 21, 3) & S.OPEN), expectedOpen);
      assert.equal(!!(f.world.getBlockState(2, 22, 3) & S.OPEN), expectedOpen);
    };
    assert.equal(f.actions.tryUse(f.hit(2, y, 3)).ok, true);
  }
  assert.equal(f.gameplay.getHandStack().count, beforeCount);
  assert.equal(f.overflow.size, 0);
  f.world.onMutation = undefined;
  const prepare = f.world.prepareMutation.bind(f.world);
  f.world.prepareMutation = (...args) => ({
    ...prepare(...args),
    validate: () => false,
  });
  const before = f.snapshot();
  assert.equal(f.actions.tryUse(f.hit(2, 22, 3)).ok, false);
  assert.deepEqual(f.snapshot(), before);
});

test("trapdoors and gates toggle interactively, retain valid fluid, and preserve caller sneak bypass", (t) => {
  for (const id of [BLOCK.OAK_TRAPDOOR, BLOCK.OAK_FENCE_GATE]) {
    const f = buildingFixture(t);
    f.hold(id, 2);
    if (id === BLOCK.OAK_TRAPDOOR) f.put(2, 21, 3, BLOCK.WATER);
    assert.equal(f.actions.place("main", id, f.hit()), true);
    f.player.sneaking = true;
    // The caller chooses not to invoke tryUse during sneak-place. Explicit use
    // still works; a recognized refusal must never turn into a placement fallback.
    assert.equal(f.actions.tryUse(f.hit(2, 21, 3)).ok, true);
    assert.ok(f.world.getBlockState(2, 21, 3) & S.OPEN);
    assert.equal(
      f.world.getFluid(2, 21, 3),
      id === BLOCK.OAK_TRAPDOOR ? FLUID.WATER_SOURCE : FLUID.NONE
    );
    f.player.intersectsPlacement = () => true;
    assert.equal(f.actions.tryUse(f.hit(2, 21, 3)).ok, false);
    assert.equal(f.actions.tryUse(f.hit(2, 20, 3)), null);
  }
});

test("linked breaks are detached pure proposals with one item and a canonical root from either half", (t) => {
  for (const id of [BLOCK.OAK_DOOR, BLOCK.WHITE_BED]) {
    const f = buildingFixture(t);
    f.floor();
    f.hold(id, 2);
    assert.equal(f.actions.place("main", id, f.hit()), true);
    const root = f.hit(2, 21, 3);
    const other = id === BLOCK.OAK_DOOR ? f.hit(2, 22, 3) : f.hit(2, 21, 2);
    const before = f.snapshot();
    const a = f.actions.prepareBreak(root),
      b = f.actions.prepareBreak(other);
    assert.equal(a.rootKey, b.rootKey);
    assert.equal(a.dropCount, 1);
    assert.equal(b.dropCount, 1);
    assert.equal(a.dropId, id);
    assert.equal(a.changes.length, 2);
    assert.deepEqual(f.snapshot(), before);
    assert.throws(() => {
      a.changes[0].after.id = BLOCK.STONE;
    }, TypeError);
    assert.equal(commitBreak(f, b), true);
    assert.equal(f.world.get(root.x, root.y, root.z), BLOCK.AIR);
    assert.equal(f.world.get(other.x, other.y, other.z), BLOCK.AIR);
    assert.equal(f.overflow.serialize().entries[0].count, 1);
    assert.equal(commitBreak(f, a), false);
  }
});

test("invalid loaded partners clean up without loot, while unavailable partners refuse entirely", (t) => {
  const f = buildingFixture(t);
  f.put(2, 21, 3, BLOCK.OAK_DOOR);
  assert.equal(f.actions.tryUse(f.hit(2, 21, 3)).ok, false);
  const orphan = f.actions.prepareBreak(f.hit(2, 21, 3));
  assert.equal(orphan.ok, true);
  assert.equal(orphan.dropCount, 0);
  assert.equal(orphan.changes.length, 1);
  assert.equal(commitBreak(f, orphan), true);
  assert.equal(f.overflow.size, 0);
  f.put(31, 21, 3, BLOCK.WHITE_BED, 1);
  const unavailable = f.actions.prepareBreak(f.hit(31, 21, 3));
  assert.equal(unavailable.ok, false);
  assert.equal(f.world.get(31, 21, 3), BLOCK.WHITE_BED);
});

test("proposal validation rejects removed-and-replaced identical cells and wrong dimensions", (t) => {
  const f = buildingFixture(t);
  f.put(2, 21, 3, BLOCK.OAK_SLAB);
  const proposal = f.actions.prepareBreak(f.hit(2, 21, 3));
  f.put(2, 21, 3, BLOCK.AIR);
  f.put(2, 21, 3, BLOCK.OAK_SLAB);
  assert.equal(proposal.validate(), false);
  assert.equal(commitBreak(f, proposal), false);
  assert.equal(f.overflow.size, 0);
  assert.equal(
    f.actions.prepareBreak({ ...f.hit(2, 21, 3), dimension: "nether" }).ok,
    false
  );
});

test("observer errors cannot reject committed placement and guards are released for reentry", (t) => {
  const f = buildingFixture(t);
  f.hold(BLOCK.OAK_DOOR, 2);
  const error = new Error("building observer");
  f.world.onMutation = () => {
    assert.equal(f.actions._busy, false);
    assert.equal(f.gameplay.getHandStack().count, 1);
    const inventory = f.gameplay.prepareInventory(() => true);
    assert.equal(f.coordinator.commit([inventory]).ok, true);
    throw error;
  };
  f.game.refreshHud = () => {
    throw new Error("HUD observer");
  };
  assert.equal(f.actions.place("main", BLOCK.OAK_DOOR, f.hit()), true);
  assert.equal(f.world.get(2, 22, 3), BLOCK.OAK_DOOR);
  assert.equal(f.actions.observerErrors.length, 2);
  assert.equal(f.actions.observerErrors[0], error);
});

test("publication invariant failures are fatal instead of a retryable placement refusal", (t) => {
  const f = buildingFixture(t);
  f.hold(BLOCK.OAK_SLAB);
  const prepare = f.world.prepareMutation.bind(f.world);
  f.world.prepareMutation = (...args) => ({
    ...prepare(...args),
    publish: () => {
      throw new Error("injected invariant");
    },
  });
  assert.throws(
    () => f.actions.place("main", BLOCK.OAK_SLAB, f.hit()),
    TransactionInvariantError
  );
});

test("nested publication invariants from observers remain fatal after building commits", (t) => {
  for (const source of ["world", "feedback"]) {
    const f = buildingFixture(t);
    f.hold(BLOCK.OAK_SLAB, 3);
    const error = new TransactionInvariantError(
      "nested publication",
      new Error("injected")
    );
    const fail = () => {
      throw error;
    };
    if (source === "world") f.world.onMutation = fail;
    else f.game.scheduleSave = fail;
    assert.throws(
      () => f.actions.place("main", BLOCK.OAK_SLAB, f.hit()),
      (value) => value === error
    );
    assert.equal(f.world.get(2, 21, 3), BLOCK.OAK_SLAB);
    assert.equal(f.gameplay.getHandStack().count, 2);
  }
});

test("support loss keeps ladders and source water until prepared drops can commit", (t) => {
  const f = buildingFixture(t);
  f.put(2, 21, 3, BLOCK.STONE);
  f.put(3, 21, 3, BLOCK.LADDER, 1, FLUID.WATER_SOURCE);
  f.put(2, 21, 3, BLOCK.AIR);
  const candidate = { x: 3, y: 21, z: 3 };
  let result = f.actions.reconcileSupport([candidate], {
    prepareDrops: () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(f.world.get(3, 21, 3), BLOCK.LADDER);
  assert.equal(f.overflow.size, 0);
  assert.deepEqual(result.retry, [candidate]);
  result = f.actions.reconcileSupport(result.retry);
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.equal(f.world.get(3, 21, 3), BLOCK.WATER);
  assert.equal(f.overflow.serialize().entries[0].id, BLOCK.LADDER);
  assert.equal(f.overflow.serialize().entries[0].count, 1);
  assert.equal(f.actions.reconcileSupport([candidate]).removed, 0);
});

test("support removal validates source after drop preparation and rejects foreign owners", (t) => {
  for (const failure of ["world", "foreign"]) {
    const f = buildingFixture(t);
    f.put(3, 21, 3, BLOCK.LADDER, 1);
    let proposals = 0;
    const foreign = new TransactionCoordinator(),
      owner = {};
    foreign.register(owner, 0);
    const before = f.world.serialize();
    const result = f.actions.reconcileSupport([{ x: 3, y: 21, z: 3 }], {
      prepareDrops(stacks) {
        proposals++;
        if (failure === "foreign")
          return {
            owner,
            beforeBytes: 0,
            afterBytes: 0,
            validate: () => true,
            publish: () => assert.fail("foreign publication"),
          };
        const participant = f.game.preparePlayerDrops(stacks);
        f.put(10, 25, 10, BLOCK.STONE);
        return participant;
      },
    });
    assert.equal(proposals, 1);
    assert.equal(result.ok, false);
    assert.equal(f.world.get(3, 21, 3), BLOCK.LADDER);
    assert.equal(f.overflow.size, 0);
    if (failure === "foreign") assert.deepEqual(f.world.serialize(), before);
  }
});

test("bed support loss removes its pair once; scans are bounded and unavailable attachments defer", (t) => {
  const f = placedBed(t);
  f.put(2, 20, 3, BLOCK.AIR);
  const result = f.actions.reconcileSupport([f.foot, f.head]);
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  assert.equal(f.overflow.serialize().entries[0].count, 1);
  f.put(31, 21, 3, BLOCK.LADDER, 3);
  const unavailable = f.actions.reconcileSupport([{ x: 31, y: 21, z: 3 }]);
  assert.equal(unavailable.removed, 0);
  assert.equal(unavailable.deferred.length, 1);
  const iterator = buildingSupportCandidates({
    dimension: f.world.dimension,
    epoch: f.world.epoch,
    changes: [{ x: 10, y: 25, z: 10 }],
  });
  const bounded = f.actions.reconcileSupport(iterator, { limit: 4 });
  assert.equal(bounded.checked, 4);
  assert.equal(bounded.done, false);
  assert.equal(bounded.remaining, iterator);
});

test("real fence connection geometry rejects a player in the new rail, not empty space above it", (t) => {
  const f = buildingFixture(t);
  f.put(3, 21, 3, BLOCK.OAK_FENCE);
  f.hold(BLOCK.OAK_FENCE, 4);
  Object.assign(f.player.position, { x: 3.05, y: 21.01, z: 3.5 });
  const before = f.snapshot();
  assert.equal(f.actions.place("main", BLOCK.OAK_FENCE, f.hit()), false);
  assert.deepEqual(f.snapshot(), before);
  f.player.position.y = 23;
  assert.equal(f.actions.place("main", BLOCK.OAK_FENCE, f.hit()), true);
  assert.equal(f.gameplay.getHandStack().count, 3);
});

test("reentrant disposal cannot erase bed ownership or invalidate the controller outside publication", (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  const before = f.beds.serialize();
  const bytes = f.coordinator.usage(f.beds);
  const owner = {};
  f.coordinator.register(owner, 0);
  const result = f.coordinator.commit([
    {
      owner,
      beforeBytes: 0,
      afterBytes: 0,
      validate: () => {
        assert.equal(f.actions.dispose(), false);
        return true;
      },
      publish: () => assert.fail("reentry must veto before any publication"),
    },
  ]);
  assert.equal(result.ok, false);
  assert.equal(f.actions._disposed, false);
  assert.deepEqual(f.beds.serialize(), before);
  assert.equal(f.coordinator.usage(f.beds), bytes);
  assert.equal(f.actions.dispose(), true);
  assert.equal(f.coordinator.usage(f.beds), undefined);
});
