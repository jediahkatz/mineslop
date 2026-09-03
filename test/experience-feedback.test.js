import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperienceFeedback,
  EXPERIENCE_PULSE_SECONDS,
  experienceProgress,
  LEVEL_NOTICE_SECONDS,
} from "../src/experience-feedback.js";
import { experienceForLevel, MAX_EXPERIENCE } from "../src/experience.js";

test("readable XP preserves exact Java boundaries and the two curve changes", () => {
  assert.deepEqual(experienceProgress(0), {
    total: 0, level: 0, progress: 0, earned: 0, needed: 7, remaining: 7,
    label: "Level 0 · 0 / 7 XP · 7 XP to level 1",
  });
  for (const [level, needed] of [[1, 9], [16, 42], [17, 47], [31, 121], [32, 130]]) {
    const total = experienceForLevel(level);
    const before = experienceProgress(total - 1);
    const next = experienceProgress(total);
    assert.equal(before.level, level - 1);
    assert.equal(before.remaining, 1);
    assert.equal(next.level, level);
    assert.equal(next.progress, 0);
    assert.equal(next.earned, 0);
    assert.equal(next.needed, needed);
    assert.equal(next.remaining, needed);
  }
  assert.ok(experienceProgress(MAX_EXPERIENCE).remaining > 0);
  assert.throws(() => experienceProgress(MAX_EXPERIENCE + 1), RangeError);
});

test("only a positive committed receipt produces feedback, never a snapshot or level spending", () => {
  const feedback = new ExperienceFeedback();
  assert.equal(feedback.view().visible, false);
  assert.equal(feedback.update(0, { total: experienceForLevel(40) }).visible, false);
  for (const receipt of [
    null, {}, { previousTotal: 7, total: 7 }, { previousTotal: 100, total: 7 },
    { previousTotal: -1, total: 1 }, { previousTotal: 0, total: 0.5 },
    { previousTotal: 0, total: MAX_EXPERIENCE + 1 },
  ])
    assert.equal(feedback.earned(receipt), null);
  assert.equal(feedback.view().visible, false);
  const receipt = Object.freeze({ previousTotal: 6, total: 7 });
  assert.deepEqual(feedback.earned(receipt), { amount: 1, level: 1, levels: 1, soundLevel: null });
  assert.equal(feedback.view().levelUp, true);
  assert.equal(feedback.view().level, 1);
  assert.equal(feedback.earned(receipt), null, "a receipt cannot celebrate twice");
  feedback.reset();
  assert.equal(feedback.earned(receipt), null, "lifecycle clearing does not reopen a receipt");
  assert.equal(feedback.view().visible, false);
});

test("ordinary gains pulse the existing bar; a large gain coalesces level notices and milestone audio", () => {
  const feedback = new ExperienceFeedback();
  const small = feedback.earned({ previousTotal: 0, total: 1 });
  assert.equal(small.levels, 0);
  assert.equal(feedback.view().levelUp, false);
  assert.equal(feedback.pulseRemaining, EXPERIENCE_PULSE_SECONDS);
  const large = feedback.earned({ previousTotal: 1, total: experienceForLevel(16) });
  assert.equal(large.levels, 16);
  assert.equal(large.soundLevel, 16);
  assert.equal(feedback.view().sequence, 1);
  assert.equal(feedback.noticeRemaining, LEVEL_NOTICE_SECONDS);
  assert.equal(
    feedback.earned({ previousTotal: experienceForLevel(16), total: experienceForLevel(20) }).soundLevel,
    null,
    "a second milestone inside the cooldown cannot start an audio burst"
  );
  assert.equal(feedback.view().level, 20);
  assert.equal(feedback.view().sequence, 2);
  for (let i = 0; i < 20; i++) feedback.update(0.25);
  assert.equal(feedback.view().visible, false);
  assert.equal(
    feedback.earned({ previousTotal: experienceForLevel(20), total: experienceForLevel(25) }).soundLevel,
    25
  );
});

test("pause and visibility cannot award XP or replay audio; death, Creative and disposal clear notices", () => {
  const feedback = new ExperienceFeedback();
  const receipt = { previousTotal: 0, total: experienceForLevel(5) };
  feedback.earned(receipt);
  const remaining = feedback.noticeRemaining;
  assert.equal(feedback.update(30, { simulating: false }).visible, false);
  assert.equal(feedback.noticeRemaining, remaining);
  assert.equal(feedback.update(0, { visible: false }).visible, false);
  assert.equal(feedback.noticeRemaining, remaining);
  assert.equal(feedback.update(0).visible, true);
  assert.equal(feedback.earned(receipt), null);
  assert.equal(feedback.update(0, { dead: true }).visible, false);
  assert.equal(feedback.update(0).visible, false);
  feedback.earned({ previousTotal: 0, total: 7 });
  assert.equal(feedback.update(0, { mode: "creative" }).visible, false);
  feedback.earned({ previousTotal: 0, total: 7 });
  feedback.dispose();
  assert.equal(feedback.view().visible, false);
  assert.equal(feedback.earned({ previousTotal: 0, total: 7 }), null);
});
