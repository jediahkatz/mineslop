import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import {
  ExperienceOrbs,
  EXPERIENCE_ORB_RECORD_RESERVED_BYTES,
  MAX_EXPERIENCE_ORBS,
  MAX_ORB_EXPERIENCE,
} from "../src/experience-orbs.js";
import { normalizeExperienceOrbSnapshot } from "../src/experience-orb-save.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { MAX_LOOSE_Y } from "../src/loose-entity.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "../src/transactions.js";
import { entityContext, entityWorld } from "./entity-context-fixtures.js";

const at = { x: 0.5, y: 1.5, z: 0.5 };
const feet = { ...at, y: 1 };
const still = { x: 0, y: 0, z: 0 };
const total = (orbs) =>
  orbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0);

function fixture(t, options = {}) {
  const world = entityWorld({ generatorVersion: 3, floor: 0, ...options });
  const { coordinator, context } = world;
  const game = new Gameplay({ coordinator, context });
  const orbs = new ExperienceOrbs(new THREE.Scene(), world, {
    coordinator,
    context,
    prepareCollect: (amount) => game.prepareExperience(amount),
  });
  t.after(() => {
    orbs.dispose();
    game.dispose?.();
  });
  return { world, context, coordinator, game, orbs };
}

test("prepared XP spawn is detached, single-use and atomic with a second owner's veto", (t) => {
  const { orbs, game, coordinator } = fixture(t);
  const position = { ...at };
  const velocity = { ...still };
  const plan = orbs.prepareSpawn(MAX_ORB_EXPERIENCE + 5, position, {
    velocity,
  });
  assert.ok(plan);
  assert.equal(orbs.size, 0);
  assert.equal(orbs.reservedBytes, 0);
  position.y = 30;
  velocity.y = 20;
  assert.equal(coordinator.commit([plan]).ok, true);
  assert.deepEqual(
    orbs.serialize().orbs.map(({ amount }) => amount),
    [MAX_ORB_EXPERIENCE, 5]
  );
  assert.equal(orbs.serialize().orbs[0].y, at.y);
  assert.deepEqual(orbs.serialize().orbs[0].velocity, still);
  const before = orbs.serialize();
  assert.equal(coordinator.commit([plan]).ok, false);
  const merge = orbs.prepareSpawn(2, at, { velocity: still });
  assert.ok(merge);
  assert.deepEqual(orbs.serialize(), before);
  const receive = game.prepareExperience(1);
  assert.ok(receive);
  assert.equal(
    coordinator.commit([merge, { ...receive, validate: () => false }]).ok,
    false
  );
  assert.deepEqual(orbs.serialize(), before);
  assert.equal(game.getState().experience.total, 0);
  assert.equal(orbs.reservedBytes, 2 * EXPERIENCE_ORB_RECORD_RESERVED_BYTES);
});

test("motion, equal-byte reloads, epoch and dimension changes invalidate detached XP plans", (t) => {
  for (const stale of ["motion", "load", "epoch", "dimension", "generator"]) {
    const { world, orbs, coordinator } = fixture(t);
    orbs.spawn(3, at, { velocity: still });
    const plan = orbs.prepareSpawn(2, { ...at, x: 5 });
    assert.ok(plan);
    if (stale === "motion") orbs.update(0.01, 0.01, feet, { dead: true });
    if (stale === "load") assert.equal(orbs.load(orbs.serialize()), true);
    if (stale === "epoch") world.epoch++;
    if (stale === "dimension") world.dimension = "nether";
    if (stale === "generator") world.generatorVersion = 4;
    const before = orbs.serialize();
    assert.equal(coordinator.commit([plan]).ok, false, stale);
    assert.deepEqual(orbs.serialize(), before);
    assert.equal(coordinator.usage(orbs), EXPERIENCE_ORB_RECORD_RESERVED_BYTES);
  }
});

test("full metadata-bearing inventory and a full shared reservation do not block XP collection", (t) => {
  const { orbs, game, coordinator } = fixture(t);
  assert.equal(
    game.inventoryTransaction((draft) => {
      draft.slots.fill(null);
      for (let i = 0; i < draft.slots.length; i++)
        draft.slots[i] = { id: BLOCK.STONE, count: 64 };
      draft.slots[0] = {
        id: ITEM.STICK,
        count: 64,
        data: { version: 1, name: "Named full stack" },
      };
      return true;
    }),
    true
  );
  const before = game.getState().slots;
  assert.equal(orbs.spawn(11, at), true);
  const filler = {};
  assert.equal(
    coordinator.register(
      filler,
      MAX_RESERVED_BYTES - coordinator.budget.totalBytes
    ),
    true
  );
  const notifications = [];
  orbs.onCollect = (amount) => {
    notifications.push({
      amount,
      total: game.getState().experience.total,
      size: orbs.size,
    });
    return false; // Prepared notifications are not vetoes or credit callbacks.
  };
  orbs.update(0.01, 0.01, feet, game);
  assert.equal(orbs.size, 0);
  assert.equal(game.getState().experience.total, 11);
  assert.deepEqual(game.getState().slots, before);
  assert.deepEqual(notifications, [{ amount: 11, total: 11, size: 0 }]);
  assert.equal(coordinator.usage(orbs), 0);
  assert.ok(coordinator.budget.totalBytes < MAX_RESERVED_BYTES);
  orbs.update(1, 1, feet, game);
  assert.equal(game.getState().experience.total, 11);
});

test("refused or foreign prepared receivers keep every XP unit and do not notify", (t) => {
  const { orbs, game } = fixture(t);
  const foreign = new Gameplay({ coordinator: new TransactionCoordinator() });
  t.after(() => foreign.dispose?.());
  let notifications = 0;
  orbs.onCollect = () => notifications++;
  for (const prepare of [
    () => null,
    () => ({ ...game.prepareExperience(7), validate: () => false }),
    () => foreign.prepareExperience(7),
    () => {
      throw new Error("preparation refused");
    },
    async () => assert.fail("Async preparation must not be invoked"),
  ]) {
    orbs.prepareCollect = prepare;
    assert.equal(
      orbs.load({
        version: 1,
        orbs: [{ ...at, dimension: "overworld", amount: 7 }],
      }),
      true
    );
    orbs.update(0.01, 0.01, feet, game);
    assert.equal(total(orbs), 7);
    assert.equal(game.getState().experience.total, 0);
    assert.equal(foreign.getState().experience.total, 0);
    assert.equal(notifications, 0);
  }
  orbs.prepareCollect = (amount) => game.prepareExperience(amount);
  orbs.update(0.6, 1, feet, game);
  assert.equal(orbs.size, 0);
  assert.equal(game.getState().experience.total, 7);
  assert.equal(notifications, 1);
});

test("prepared collection guards reentrant preparation and postcommit spawns wait for the next tick", (t) => {
  const { orbs, game } = fixture(t);
  const duringPrepare = [];
  orbs.prepareCollect = (amount) => {
    duringPrepare.push(orbs.spawn(99, at), orbs.load(undefined));
    orbs.dispose();
    orbs.update(1, 1, feet, game);
    return game.prepareExperience(amount);
  };
  const notifications = [];
  orbs.onCollect = (amount) => {
    notifications.push({
      amount,
      size: orbs.size,
      total: game.getState().experience.total,
    });
    orbs.update(1, 1, feet, game);
    if (amount === 3) notifications.push({ spawned: orbs.spawn(5, at) });
  };
  orbs.spawn(3, at);
  orbs.update(0.01, 0.01, feet, game);
  assert.deepEqual(duringPrepare, [false, false]);
  assert.deepEqual(notifications, [
    { amount: 3, size: 0, total: 3 },
    { spawned: true },
  ]);
  assert.equal(total(orbs), 5);
  orbs.update(0.01, 0.02, feet, game);
  assert.equal(orbs.size, 0);
  assert.equal(game.getState().experience.total, 8);
  assert.deepEqual(notifications.at(-1), { amount: 5, size: 0, total: 8 });
});

test("observer errors cannot resurrect collected XP, while publication invariants propagate", (t) => {
  const { orbs, game, coordinator } = fixture(t);
  let notifications = 0;
  orbs.onCollect = () => {
    notifications++;
    throw new Error("sound failed");
  };
  orbs.spawn(4, at);
  orbs.update(0.01, 0.01, feet, game);
  orbs.update(1, 1, feet, game);
  assert.equal(orbs.size, 0);
  assert.equal(game.getState().experience.total, 4);
  assert.equal(notifications, 1);
  const broken = {};
  coordinator.register(broken, 0);
  orbs.prepareCollect = () => ({
    owner: broken,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () => true,
    publish() {
      throw new Error("illegal fallible publish");
    },
  });
  orbs.spawn(2, at);
  assert.throws(
    () => orbs.update(0.01, 2, feet, game),
    TransactionInvariantError
  );
});

test("a collection observer's dimension change cannot tick or collect that dimension's frozen pool", (t) => {
  const { world, orbs, game } = fixture(t);
  orbs.spawn(3, at);
  world.dimension = "nether";
  orbs.spawn(5, at);
  const frozen = orbs.serialize().orbs[1];
  world.dimension = "overworld";
  orbs.onCollect = () => {
    world.dimension = "nether";
  };
  orbs.update(0.01, 0.01, feet, game);
  assert.equal(game.getState().experience.total, 3);
  assert.deepEqual(orbs.serialize().orbs, [frozen]);
  assert.equal(orbs.mesh.count, 0);
  orbs.onCollect = undefined;
  orbs.update(0.01, 0.02, feet, game);
  assert.equal(game.getState().experience.total, 8);
  assert.equal(orbs.size, 0);
});

test("XP pool and shared-byte capacity refuse without partial merges and allow jointly funded spawn", (t) => {
  const { orbs, coordinator } = fixture(t);
  const capacity = MAX_ORB_EXPERIENCE * MAX_EXPERIENCE_ORBS;
  assert.equal(orbs.spawn(capacity - 1, at), true);
  const before = orbs.serialize();
  assert.equal(orbs.prepareSpawn(2, at), null);
  assert.deepEqual(orbs.serialize(), before);
  assert.equal(orbs.spawn(1, at), true);
  assert.equal(total(orbs), capacity);
  assert.equal(orbs.load(undefined), true);
  const filler = {};
  const bytes = MAX_RESERVED_BYTES - coordinator.budget.totalBytes;
  coordinator.register(filler, bytes);
  assert.equal(orbs.spawn(1, at), false);
  assert.equal(orbs.size, 0);
  const plan = orbs.prepareSpawn(1, at);
  assert.ok(plan);
  assert.equal(
    coordinator.commit([
      plan,
      {
        owner: filler,
        beforeBytes: bytes,
        afterBytes: bytes - EXPERIENCE_ORB_RECORD_RESERVED_BYTES,
        validate: () => true,
        publish() {},
      },
    ]).ok,
    true
  );
  assert.equal(orbs.size, 1);
  assert.equal(coordinator.usage(orbs), EXPERIENCE_ORB_RECORD_RESERVED_BYTES);
});

test("moving XP uses fixed reservations without serializing the pool each frame", (t) => {
  const { orbs, coordinator, game } = fixture(t);
  orbs.spawn(5, at, { pickupDelay: 2 });
  const bytes = coordinator.usage(orbs);
  const serialize = t.mock.method(orbs, "serialize", () =>
    assert.fail("Per-frame serialization")
  );
  for (let i = 0; i < 5; i++) orbs.update(0.05, i / 20, feet, game);
  assert.equal(coordinator.usage(orbs), bytes);
  assert.equal(orbs.reservedBytes, bytes);
  serialize.mock.restore();
  const snapshot = orbs.serialize();
  assert.ok(snapshot.orbs[0].age > 0);
  orbs.prepareCollect = undefined;
  orbs.update(300, 300, feet, game);
  assert.equal(orbs.size, 0);
  assert.equal(coordinator.usage(orbs), 0);
});

test("XP load is contextual, detached and budget-atomic, including accepted over-budget snapshots", (t) => {
  const { orbs, coordinator } = fixture(t, { generatorVersion: 4, floor: -33 });
  const saved = {
    version: 1,
    orbs: ["overworld", "nether", "end"].map((dimension, i) => ({
      dimension,
      x: i + 0.5,
      y: i === 0 ? -32.5 : 200,
      z: 0.5,
      amount: i + 1,
      pickupDelay: 2,
      velocity: { x: 1, y: 2, z: 3 },
      age: 0.5,
    })),
  };
  const blocker = {};
  coordinator.register(
    blocker,
    MAX_RESERVED_BYTES - coordinator.budget.totalBytes
  );
  assert.equal(orbs.load(saved), false);
  assert.equal(orbs.size, 0);
  assert.equal(orbs.load(saved, { allowOverBudget: true }), true);
  assert.deepEqual(orbs.serialize(), saved);
  saved.orbs[0].velocity.x = 9;
  assert.equal(orbs.serialize().orbs[0].velocity.x, 1);
  const before = orbs.serialize();
  assert.equal(orbs.load(before, { context: entityContext(3) }), false);
  assert.deepEqual(orbs.serialize(), before);
  const bad = structuredClone(before);
  bad.orbs[1].y = -1;
  assert.equal(orbs.load(bad), false);
  assert.deepEqual(orbs.serialize(), before);
  assert.equal(orbs.spawn(1, { x: 20, y: -32, z: 20 }), false);
  orbs.dispose();
  assert.equal(coordinator.usage(orbs), undefined);
  assert.equal(orbs.reservedBytes, 0);
});

test("pure XP normalization supports signed loose positions and safe flight without renderer state", () => {
  const context = entityContext();
  const saved = {
    version: 1,
    orbs: [
      {
        dimension: "overworld",
        x: -29_000_000.123456,
        y: -64,
        z: 29_000_000.123456,
        amount: MAX_ORB_EXPERIENCE,
      },
      {
        dimension: "nether",
        x: 0.5,
        y: MAX_LOOSE_Y,
        z: 0.5,
        amount: 1,
        pickupDelay: Number.MIN_VALUE,
        velocity: { x: -Number.MIN_VALUE, y: 31.999999999999, z: 1 / 3 },
        age: Number.MIN_VALUE,
      },
    ],
  };
  const normalized = normalizeExperienceOrbSnapshot(saved, context);
  assert.ok(normalized);
  assert.deepEqual(
    normalizeExperienceOrbSnapshot(normalized, context),
    normalized
  );
  for (const orb of normalized.orbs)
    assert.ok(encodedBytes(orb) + 1 <= EXPERIENCE_ORB_RECORD_RESERVED_BYTES);
  assert.equal(normalizeExperienceOrbSnapshot(saved, entityContext(3)), null);
  for (const patch of [
    { dimension: "nether" },
    { dimension: "end" },
    { y: -65 },
    { age: 300 },
    { reward: {} },
  ])
    assert.equal(
      normalizeExperienceOrbSnapshot(
        {
          version: 1,
          orbs: [{ ...saved.orbs[0], ...patch }],
        },
        context
      ),
      null
    );
});
