import assert from "node:assert/strict";
import test from "node:test";
import {
  experienceForLevel,
  experienceState,
  experienceToNextLevel,
  MAX_EXPERIENCE,
} from "../src/experience.js";
import { Gameplay } from "../src/gameplay.js";

test("Java XP boundaries roundtrip on both sides of each level-curve transition", () => {
  for (const level of [0, 1, 2, 15, 16, 17, 30, 31, 32, 100, 1000]) {
    const total = experienceForLevel(level);
    assert.deepEqual(experienceState(total), { total, level, progress: 0 });
    assert.equal(
      experienceToNextLevel(level),
      experienceForLevel(level + 1) - total
    );
    if (level > 0) {
      const before = experienceState(total - 1);
      assert.equal(before.level, level - 1);
      assert.ok(before.progress > 0 && before.progress < 1);
    }
    const within = experienceState(
      total + Math.floor(experienceToNextLevel(level) / 2)
    );
    assert.equal(within.level, level);
    assert.ok(within.progress > 0 && within.progress < 1);
  }
  assert.equal(experienceForLevel(16), 352);
  assert.equal(experienceForLevel(17), 394);
  assert.equal(experienceForLevel(31), 1507);
  assert.equal(experienceForLevel(32), 1628);
});

test("XP totals remain finite and accurately bracket the maximum Java total", () => {
  const state = experienceState(MAX_EXPERIENCE);
  assert.ok(experienceForLevel(state.level) <= state.total);
  assert.ok(experienceForLevel(state.level + 1) > state.total);
  assert.ok(state.progress >= 0 && state.progress < 1);
  for (const invalid of [-1, 1.5, Infinity, NaN, "7", MAX_EXPERIENCE + 1]) {
    assert.throws(() => experienceState(invalid), RangeError);
  }
});

test("experience additions survive reload and invalid awards fail atomically", () => {
  const game = new Gameplay();
  assert.equal(game.addExperience(350), true);
  assert.equal(game.addExperience(44), true);
  assert.deepEqual(game.getState().experience, {
    total: 394,
    level: 17,
    progress: 0,
  });
  const before = game.serialize();
  for (const amount of [-1, 0.5, "7", Infinity, NaN, MAX_EXPERIENCE]) {
    assert.equal(game.addExperience(amount), false);
    assert.deepEqual(game.serialize(), before);
  }
  const restored = new Gameplay();
  assert.equal(restored.load(JSON.parse(JSON.stringify(before))), true);
  assert.deepEqual(restored.getState().experience, game.getState().experience);
  restored.damage(100);
  restored.respawn();
  assert.deepEqual(
    restored.getState().experience,
    game.getState().experience,
    "death-loss policy is unchanged"
  );
});
