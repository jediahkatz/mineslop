import assert from "node:assert/strict";
import test from "node:test";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { getItem } from "../src/items.js";
import { gameMendingFixture } from "./game-mending-fixture.js";

const nextSix = (seed) => {
  for (let i = 0; i < 6; i++) seed = nextEnchantingSeed(seed);
  return seed;
};
const equipped = (f) => [
  f.gameplay.getHandStack(), f.gameplay.getHandStack("offhand"),
  ...Object.values(f.gameplay.equipment),
].filter(Boolean);

test("real Game frame collects one orb, mends six equipped items and saves only leftover XP", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip({ total: 6 });
  const inventory = f.gameplay.serialize();
  const seed = f.stations.randomState, table = f.stations.playerState;
  f.spawnXp(7);
  assert.equal(f.orbs.spawn(3, f.player.position, { pickupDelay: 10 }), true);
  const observations = [];
  f.game.scheduleSave = () => observations.push({
    xp: f.gameplay.getState().experience.total,
    equipment: equipped(f).map((stack) => stack.durability),
    seed: f.stations.randomState, amounts: f.orbs.serialize().orbs.map((orb) => orb.amount),
  });
  f.frame(6);
  assert.equal(f.gameplay.getState().experience.total, 7);
  assert.equal(f.orbs.size, 1);
  assert.equal(f.orbs.serialize().orbs[0].amount, 3);
  for (const stack of equipped(f)) assert.equal(stack.durability, getItem(stack.id).durability);
  assert.deepEqual(f.gameplay.serialize().slots[9], inventory.slots[9]);
  assert.deepEqual(f.gameplay.serialize().cursor, inventory.cursor);
  assert.equal(f.stations.randomState, nextSix(seed));
  assert.deepEqual(f.stations.playerState, table);
  assert.deepEqual(f.calls.sounds.filter(([sound]) => ["xp", "levelup"].includes(sound)), [["xp", 1]]);
  assert.equal(f.progression.feedback.view().levelUp, true);
  const paid = observations.filter((entry) => entry.xp === 7);
  assert.ok(paid.length > 0);
  for (const entry of paid) {
    assert.equal(entry.seed, nextSix(seed));
    assert.deepEqual(entry.amounts, [3]);
    assert.deepEqual(entry.equipment, equipped(f).map((stack) => stack.durability));
  }
});

test("fully spent Mending XP never announces or awards a false level-up", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip({ multiple: false, damage: 20, total: 54 });
  const durability = f.gameplay.getHandStack().durability;
  f.spawnXp(7);
  f.collect();
  assert.equal(f.orbs.size, 0);
  assert.equal(f.gameplay.getHandStack().durability, durability + 14);
  assert.equal(f.gameplay.getState().experience.total, 54);
  assert.equal(f.progression.feedback.view().levelUp, false);
  assert.equal(f.calls.sounds.some(([sound]) => ["xp", "levelup"].includes(sound)), false);
});

test("unenchanted equipment receives full XP without repairs", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip({ enchanted: false });
  const before = equipped(f), seed = f.stations.randomState;
  f.spawnXp(7);
  f.collect();
  assert.equal(f.orbs.size, 0);
  assert.equal(f.gameplay.getState().experience.total, 7);
  assert.deepEqual(equipped(f), before);
  // Existing gear policy reserves six deterministic draws per Mending reward.
  assert.equal(f.stations.randomState, nextSix(seed));
});

test("only leftover XP crossing a five-level milestone emits its chime", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip({ total: 54 });
  f.spawnXp(7);
  f.collect();
  assert.equal(f.gameplay.getState().experience.total, 55);
  assert.deepEqual(f.calls.sounds.filter(([sound]) => ["xp", "levelup"].includes(sound)),
    [["levelup", 5]]);
  assert.equal(f.progression.feedback.view().level, 5);
});

test("staged, paused, building, failed and dead hosts cannot consume physical XP", async (t) => {
  const staged = await gameMendingFixture(t, { activate: false });
  assert.equal(staged.orbs.spawn(7, {
    ...staged.player.position, y: staged.player.position.y + 0.8,
  }), true);
  assert.equal(staged.orbs.prepareCollect(7), null);
  staged.collect();
  assert.equal(staged.orbs.size, 1);
  for (const state of ["paused", "building", "failed", "dead"]) {
    const f = await gameMendingFixture(t);
    f.equip();
    if (state === "dead") f.gameplay.damage(100, "test");
    f.spawnXp(7);
    if (state !== "dead") f.game[state] = true;
    const before = f.paidState();
    f.collect();
    assert.deepEqual(f.paidState(), before, state);
    if (state === "paused") {
      const orbs = f.orbs.serialize();
      f.frame(2);
      assert.deepEqual(f.orbs.serialize(), orbs);
    }
  }
});

test("prepared Mending rejects stale host, source, hand, RNG, life and world without payment", async (t) => {
  for (const kind of ["host", "source", "hand", "rng", "life", "epoch", "dimension", "paused", "dead"]) {
    const f = await gameMendingFixture(t);
    f.equip();
    f.spawnXp(7);
    const prepare = f.orbs.prepareCollect;
    let before;
    f.orbs.prepareCollect = (amount) => {
      const plan = prepare(amount);
      assert.equal(plan.ok, true);
      assert.equal(plan.participants.length, 2);
      assert.equal(new Set(plan.participants.map((part) => part.owner)).size, 2);
      if (kind === "host") f.game.progressionIntegration = null;
      if (kind === "source") f.game.mobIntegration = null;
      if (kind === "hand") { f.gameplay.select(1); f.gameplay.select(0); }
      if (kind === "rng") {
        const random = f.stations.prepareRandom(1, { validate: () => true });
        assert.equal(f.coordinator.commit([random.participant]).ok, true);
      }
      if (kind === "life") f.projectiles.cancel("test", { advanceLife: true });
      if (kind === "epoch") f.world._epoch++;
      if (kind === "dimension") f.world.dimension = "nether";
      if (kind === "paused") f.game.paused = true;
      if (kind === "dead") f.gameplay.damage(100, "test");
      before = f.paidState();
      return plan;
    };
    f.collect();
    assert.deepEqual(f.paidState(), before, kind);
    assert.equal(f.orbs.size, 1, kind);
  }
});

test("reservation refusal preserves orb, repairs, XP and RNG, then retries once", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip();
  f.spawnXp(7);
  const before = f.paidState();
  const refusal = t.mock.method(f.coordinator.budget, "canCommit", () => false);
  f.collect();
  assert.deepEqual(f.paidState(), before);
  refusal.mock.restore();
  f.orbs.update(0.6, 1, f.player.position, f.gameplay);
  assert.equal(f.orbs.size, 0);
  assert.equal(f.gameplay.getState().experience.total, 1);
  assert.equal(f.stations.randomState, nextSix(before.stations.randomState));
});

test("observer throws, recursive collection and replay cannot double-mend or double-credit", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip();
  f.spawnXp(7);
  const prepare = f.orbs.prepareCollect;
  let captured;
  f.orbs.prepareCollect = (amount) => {
    const before = f.paidState();
    captured = prepare(amount);
    f.collect();
    assert.equal(f.orbs.spawn(99, f.player.position), false);
    assert.equal(f.orbs.load(undefined), false);
    assert.deepEqual(f.paidState(), before);
    return captured;
  };
  f.game.scheduleSave = () => { throw new Error("save observer"); };
  f.game.effects.sound = () => { throw new Error("sound observer"); };
  f.gameplay.onChange = () => { f.collect(); throw new Error("gameplay observer"); };
  f.orbs.onCollect = () => { f.collect(); throw new Error("source observer"); };
  f.collect();
  assert.equal(f.orbs.size, 0);
  assert.equal(f.gameplay.getState().experience.total, 1);
  const paid = f.paidState();
  assert.equal(f.coordinator.commit(captured.participants).ok, false);
  assert.deepEqual(f.paidState(), paid);
  assert.ok(f.progression.observerErrors.length > 0);
  f.orbs.prepareCollect = () => captured;
  f.game.scheduleSave = () => {};
  f.spawnXp(7);
  const replay = f.paidState();
  f.collect();
  assert.deepEqual(f.paidState(), replay);
});

test("equipment, leftover XP, owned RNG and remaining orb survive real archive reload", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip();
  f.spawnXp(7);
  f.collect();
  f.spawnXp(4);
  const snapshot = f.snapshot();
  const loaded = await gameMendingFixture(t, { saved: snapshot });
  assert.deepEqual(loaded.gameplay.serialize(), snapshot.gameplay);
  assert.deepEqual(loaded.stations.serialize(), snapshot.progression.stations);
  assert.deepEqual(loaded.orbs.serialize(), snapshot.experienceOrbs);
  assert.equal(loaded.calls.sounds.length, 0);
  loaded.collect();
  assert.equal(loaded.gameplay.getState().experience.total, 5);
  assert.equal(loaded.orbs.size, 0);
  assert.equal(loaded.stations.randomState, nextSix(snapshot.progression.stations.randomState));
  loaded.collect();
  assert.equal(loaded.gameplay.getState().experience.total, 5);
});

test("malformed Mending plans refuse atomically, release collection guards and allow a clean retry", async (t) => {
  const throwsOn = (object, key) => Object.defineProperty(object, key, {
    get() { throw new Error(`malformed ${key}`); },
  });
  const cases = {
    nullParticipant: (plan) => ({ ...plan, participants: [plan.participants[0], null] }),
    nullOwner: (plan) => ({ ...plan, participants: [
      plan.participants[0], { ...plan.participants[1], owner: null },
    ] }),
    sourceOwner: (plan, f) => ({ ...plan, participants: [
      plan.participants[0], { ...plan.participants[1], owner: f.orbs },
    ] }),
    ownerGetter: (plan) => ({ ...plan, participants: [
      plan.participants[0], throwsOn({ ...plan.participants[1] }, "owner"),
    ] }),
    publicationGetter: (plan) => ({ ...plan, participants: [
      plan.participants[0], throwsOn({ ...plan.participants[1] }, "publish"),
    ] }),
    reservationGetter: (plan) => ({ ...plan, participants: [
      plan.participants[0], throwsOn({ ...plan.participants[1] }, "beforeBytes"),
    ] }),
    listGetter: (plan) => throwsOn({ ...plan }, "participants"),
    thenGetter: (plan) => throwsOn({ ...plan }, "then"),
    thenablePlan: (plan) => ({ ...plan, then() {} }),
    thenableParticipant: (plan) => ({ ...plan, participants: [
      plan.participants[0], { ...plan.participants[1], then() {} },
    ] }),
  };
  for (const [kind, malformed] of Object.entries(cases)) {
    const f = await gameMendingFixture(t);
    f.equip();
    f.spawnXp(7);
    const prepare = f.orbs.prepareCollect;
    f.orbs.prepareCollect = (amount) => malformed(prepare(amount), f);
    let notifications = 0;
    f.orbs.onCollect = () => notifications++;
    const before = f.paidState();
    assert.doesNotThrow(() => f.collect(), kind);
    assert.deepEqual(f.paidState(), before, kind);
    assert.equal(notifications, 0, kind);
    assert.equal(f.orbs._preparingCollect, false, kind);
    assert.equal(f.orbs._updating, false, kind);
    f.orbs.prepareCollect = prepare;
    f.orbs.update(0.6, 1, f.player.position, f.gameplay);
    assert.equal(f.orbs.size, 0, kind);
    assert.equal(f.gameplay.getState().experience.total, 1, kind);
    assert.equal(f.stations.randomState, nextSix(before.stations.randomState), kind);
    assert.equal(notifications, 1, kind);
  }
});
