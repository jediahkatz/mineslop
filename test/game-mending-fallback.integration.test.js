import assert from "node:assert/strict";
import test from "node:test";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { MAX_EXPERIENCE_ORBS, MAX_ORB_EXPERIENCE } from "../src/experience-orbs.js";
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
function fillPool(f) {
  assert.equal(f.orbs.spawn(MAX_EXPERIENCE_ORBS * MAX_ORB_EXPERIENCE, {
    ...f.player.position, y: f.player.position.y + 0.8,
  }, { pickupDelay: 20, velocity: { x: 0, y: 0, z: 0 } }), true);
  assert.equal(f.orbs.size, MAX_EXPERIENCE_ORBS);
}

test("real awardExperience full-pool fallback mends six items and pays leftover XP/RNG once", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip({ total: 54 });
  fillPool(f);
  const before = f.paidState(), orbs = f.orbs.serialize(), table = f.stations.playerState;
  const snapshots = [];
  f.game.scheduleSave = () => snapshots.push(f.snapshot());
  assert.equal(f.game.awardExperience(7, f.player.position), true);
  assert.equal(f.gameplay.getState().experience.total, 55);
  for (const stack of equipped(f)) assert.equal(stack.durability, getItem(stack.id).durability);
  assert.deepEqual(f.orbs.serialize(), orbs, "fallback must not retire existing unrelated orbs");
  assert.equal(f.stations.randomState, nextSix(before.stations.randomState));
  assert.deepEqual(f.stations.playerState, table);
  assert.deepEqual(f.calls.sounds.filter(([sound]) => ["xp", "levelup"].includes(sound)),
    [["levelup", 5]]);
  assert.equal(f.progression.feedback.view().level, 5);
  assert.ok(snapshots.length > 0);
  for (const saved of snapshots) {
    assert.equal(saved.gameplay.experience.total, 55);
    assert.deepEqual(saved.gameplay.equipment, f.gameplay.serialize().equipment);
    assert.equal(saved.progression.stations.randomState, nextSix(before.stations.randomState));
    assert.deepEqual(saved.experienceOrbs, orbs);
  }
  f.collect();
  assert.equal(f.gameplay.getState().experience.total, 55);
  assert.equal(f.stations.randomState, nextSix(before.stations.randomState));
  assert.equal(f.orbs.size, MAX_EXPERIENCE_ORBS);
});

test("failed physical spawning uses identical fully-spent and unenchanted collection policies", async (t) => {
  for (const enchanted of [true, false]) {
    const f = await gameMendingFixture(t);
    f.equip({ enchanted, multiple: false, damage: 20, total: 54 });
    // A separate refused-spawn case, not an accepting or eager-credit mock.
    t.mock.method(f.orbs, "spawn", () => false);
    const before = f.paidState(), durability = f.gameplay.getHandStack().durability;
    assert.equal(f.game.awardExperience(7, f.player.position), true);
    assert.equal(f.gameplay.getHandStack().durability, durability + (enchanted ? 14 : 0));
    assert.equal(f.gameplay.getState().experience.total, enchanted ? 54 : 61);
    assert.equal(f.stations.randomState, nextSix(before.stations.randomState));
    assert.equal(f.orbs.size, 0);
    assert.equal(f.progression.feedback.view().levelUp, !enchanted);
    assert.deepEqual(f.calls.sounds.filter(([sound]) => ["xp", "levelup"].includes(sound)),
      enchanted ? [] : [["levelup", 5]]);
  }
});

test("full-pool fallback reservation refusal pays nothing and an explicit retry pays exactly once", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip();
  fillPool(f);
  const before = f.paidState();
  const deny = t.mock.method(f.coordinator.budget, "canCommit", () => false);
  assert.equal(f.game.awardExperience(7, f.player.position), false);
  assert.deepEqual(f.paidState(), before);
  assert.deepEqual(f.calls.sounds, []);
  assert.equal(f.progression._rewardBusy, false);
  deny.mock.restore();
  assert.equal(f.game.awardExperience(7, f.player.position), true);
  assert.equal(f.gameplay.getState().experience.total, 1);
  assert.equal(f.stations.randomState, nextSix(before.stations.randomState));
  assert.equal(f.orbs.size, MAX_EXPERIENCE_ORBS);
});

test("full-pool fallback rejects stale preparation, pause and death without partial repairs", async (t) => {
  for (const kind of ["paused", "dead", "stale"]) {
    const f = await gameMendingFixture(t);
    f.equip();
    fillPool(f);
    if (kind === "paused") f.game.paused = true;
    if (kind === "dead") f.gameplay.damage(100, "test");
    if (kind === "stale") {
      const prepare = f.progression.prepareMending.bind(f.progression);
      t.mock.method(f.progression, "prepareMending", (amount) => {
        const plan = prepare(amount);
        f.game.paused = true;
        return plan;
      });
    }
    const before = f.paidState();
    assert.equal(f.game.awardExperience(7, f.player.position), false, kind);
    assert.deepEqual(f.paidState(), before, kind);
    assert.equal(f.progression._rewardBusy, false);
  }
});

test("fallback observer reentry, observer throws and plan replay cannot double-credit", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip();
  fillPool(f);
  const prepare = f.progression.prepareMending.bind(f.progression);
  let captured;
  t.mock.method(f.progression, "prepareMending", (amount) => {
    captured = prepare(amount);
    return captured;
  });
  const nested = [];
  f.gameplay.onChange = () => {
    nested.push(f.game.awardExperience(7, f.player.position));
    throw new Error("failing gameplay observer");
  };
  f.game.effects.sound = () => { throw new Error("failing sound observer"); };
  const seed = f.stations.randomState;
  assert.equal(f.game.awardExperience(7, f.player.position), true);
  assert.deepEqual(nested, [false]);
  assert.equal(f.gameplay.getState().experience.total, 1);
  assert.equal(f.stations.randomState, nextSix(seed));
  assert.equal(f.orbs.size, MAX_EXPERIENCE_ORBS);
  const paid = f.paidState();
  assert.equal(f.progression.commit(captured).ok, false);
  assert.deepEqual(f.paidState(), paid);
  assert.equal(f.progression._rewardBusy, false);
  assert.ok(f.progression.observerErrors.length > 0);
});

test("ordinary prepared and Gameplay XP remain non-Mending rewards even with worn enchanted gear", async (t) => {
  const f = await gameMendingFixture(t);
  f.equip();
  const gear = equipped(f), stations = f.stations.serialize();
  const ordinary = f.progression.prepareExperience(7);
  assert.equal(ordinary.owner, f.gameplay);
  assert.equal(f.coordinator.commit([ordinary]).ok, true);
  assert.equal(f.gameplay.getState().experience.total, 7);
  assert.deepEqual(equipped(f), gear);
  assert.deepEqual(f.stations.serialize(), stations);
  assert.deepEqual(f.calls.sounds, [["xp", 7]]);
  assert.equal(f.gameplay.addExperience(3), true);
  assert.equal(f.gameplay.getState().experience.total, 10);
  assert.deepEqual(equipped(f), gear);
  assert.deepEqual(f.stations.serialize(), stations);
});
