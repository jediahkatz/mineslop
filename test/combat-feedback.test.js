import assert from "node:assert/strict";
import test from "node:test";
import {
  CombatFeedback,
  COMBAT_ACK_SECONDS,
  meleeReadiness,
} from "../src/combat-feedback.js";

const input = (overrides = {}) => ({
  now: 10,
  lastAction: -Infinity,
  active: true,
  hasTarget: true,
  usingItem: false,
  pressed: true,
  ...overrides,
});

test("readiness mirrors the observed 0.49/0.5/0.51-second shared action guard", () => {
  assert.deepEqual(meleeReadiness(10, -Infinity), {
    ready: true,
    progress: 1,
    remaining: 0,
  });
  for (const [age, ready, progress] of [
    [0, false, 0],
    [0.25, false, 0.5],
    [0.49, false, 0.98],
    [0.5, true, 1],
    [0.51, true, 1],
  ]) {
    const state = meleeReadiness(10 + age, 10);
    assert.equal(state.ready, ready);
    assert.ok(Math.abs(state.progress - progress) < 1e-9);
    assert.ok(state.remaining >= 0 && state.remaining <= 0.5);
  }
});

test("a rejected fresh press records feedback without advancing the caller's timestamp", () => {
  const feedback = new CombatFeedback();
  const attempt = Object.freeze(input({ now: 10.49, lastAction: 10 }));
  assert.deepEqual(feedback.noteAttempt(attempt), {
    eligible: false,
    reason: "cooldown",
    acknowledged: true,
  });
  const state = feedback.view(attempt);
  assert.equal(state.phase, "cooldown");
  assert.equal(state.blockedReason, "cooldown");
  assert.equal(state.ready, false);
  assert.equal(attempt.lastAction, 10);
  const ready = input({ now: 10.51, lastAction: 10 });
  assert.equal(feedback.noteAttempt(ready).eligible, true);
  assert.equal(feedback.view(ready).blockedReason, null);
  assert.equal(
    ready.lastAction,
    10,
    "eligibility never records an accepted hit"
  );
  assert.equal(feedback.view(ready).progress, 1);
  assert.equal(
    feedback.view({ ...ready, lastAction: ready.now }).progress,
    0,
    "only the existing action owner starts a new cooldown"
  );
});

test("near-boundary rejection remains visible briefly even after readiness fills", () => {
  const feedback = new CombatFeedback();
  feedback.noteAttempt(input({ now: 10.49, lastAction: 10 }));
  const state = feedback.view(input({ now: 10.51, lastAction: 10 }));
  assert.equal(state.ready, true);
  assert.equal(state.phase, "ready");
  assert.equal(
    state.blockedReason,
    "cooldown",
    "acknowledges the previous press"
  );
  assert.equal(
    feedback.view(
      input({
        now: 10.49 + COMBAT_ACK_SECONDS + 0.001,
        lastAction: 10,
      })
    ).blockedReason,
    null
  );
});

test("repeated blocked presses are rate limited and cannot perpetually extend the tint", () => {
  const feedback = new CombatFeedback();
  assert.equal(
    feedback.noteAttempt(input({ usingItem: true })).acknowledged,
    true
  );
  let extraAcknowledgements = 0;
  for (let i = 1; i < 250; i++) {
    const result = feedback.noteAttempt(
      input({
        now: 10 + i / 1000,
        usingItem: true,
      })
    );
    extraAcknowledgements += Number(result.acknowledged);
    assert.equal(result.eligible, false);
  }
  assert.equal(extraAcknowledgements, 0);
  assert.equal(
    feedback.view(input({ now: 10.25, usingItem: true })).blockedReason,
    null,
    "subsequent refused presses did not restart the first tint"
  );
  assert.equal(
    feedback.noteAttempt(
      input({
        now: 10.5,
        usingItem: true,
      })
    ).acknowledged,
    true
  );
});

test("held acquisition is never an eligible attack or a fresh-press acknowledgement", () => {
  const feedback = new CombatFeedback();
  assert.equal(
    feedback.noteAttempt(input({ hasTarget: false })).eligible,
    false
  );
  for (const now of [10.6, 11.2, 100]) {
    assert.deepEqual(feedback.noteAttempt(input({ now, pressed: false })), {
      eligible: false,
      reason: "held",
      acknowledged: false,
    });
    assert.equal(feedback.view(input({ now })).blockedReason, null);
  }
  assert.equal(feedback.noteAttempt(input({ now: 100.01 })).eligible, true);
});

test("active use reports unavailable melee even when the cooldown is fully ready", () => {
  const feedback = new CombatFeedback();
  const attempt = input({ usingItem: true });
  assert.deepEqual(feedback.noteAttempt(attempt), {
    eligible: false,
    reason: "using-item",
    acknowledged: true,
  });
  const state = feedback.view(attempt);
  assert.equal(state.progress, 1);
  assert.equal(state.ready, false);
  assert.equal(state.phase, "using-item");
  assert.equal(state.blockedReason, "using-item");
  assert.equal(
    feedback.noteAttempt(
      input({
        now: 11,
        pressed: false,
        usingItem: true,
      })
    ).acknowledged,
    false
  );
  assert.equal(
    feedback.noteAttempt(
      input({
        now: 11.01,
        pressed: false,
      })
    ).eligible,
    false,
    "canceling a shield does not auto-attack"
  );
});

test("inactive, no-target and hidden-HUD states are quiet, and reset preserves cooldown", () => {
  const feedback = new CombatFeedback();
  for (const override of [{ active: false }, { hasTarget: false }]) {
    const attempt = input({ usingItem: true, ...override });
    assert.equal(feedback.noteAttempt(attempt).acknowledged, false);
    assert.equal(feedback.view(attempt).visible, false);
  }
  feedback.noteAttempt(input({ now: 10.25, lastAction: 10 }));
  assert.equal(feedback.view(input({ hudVisible: false })).visible, false);
  const state = input({ now: 10.25, lastAction: 10 });
  feedback.reset();
  assert.equal(feedback.view(state).blockedReason, null);
  assert.equal(feedback.view(state).progress, 0.5);
  assert.equal(state.lastAction, 10);
});

test("readiness is bounded for invalid clocks and backwards time", () => {
  const feedback = new CombatFeedback();
  for (const now of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(meleeReadiness(now, 10), {
      ready: false,
      progress: 0,
      remaining: 0.5,
    });
    assert.equal(feedback.noteAttempt(input({ now })).acknowledged, false);
    assert.equal(feedback.view(input({ now })).visible, false);
  }
  assert.equal(meleeReadiness(9, 10).progress, 0);
  assert.equal(meleeReadiness(9, 10).ready, false);
  assert.equal(meleeReadiness(10, NaN).ready, false);
  feedback.noteAttempt(input({ now: 10, usingItem: true }));
  assert.equal(feedback.view(input({ now: 9 })).blockedReason, null);
});
