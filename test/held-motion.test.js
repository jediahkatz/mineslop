import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceHeldMotion,
  composeHeldMotion,
  createHeldMotion,
  HELD_MINING_PERIOD,
  HELD_MOTION_MAX_DT,
  requestHeldSelection,
} from "../src/held-motion.js";

const TAU = Math.PI * 2;
const schedules = [
  [1 / 30], [1 / 60], [1 / 144], [0.1],
  [1 / 144, 1 / 30, 1 / 60, 0.06, 1 / 120, 0.1],
];
const closeTo = (actual, expected, epsilon = 1e-10) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);

function advanceFor(motion, seconds, schedule = [1 / 60], input = {}) {
  let remaining = seconds;
  let frame = 0;
  while (remaining > 1e-12) {
    const dt = Math.min(remaining, schedule[frame % schedule.length]);
    if (input.mining) motion.miningRequested = true;
    advanceHeldMotion(
      motion, dt, input.moving, true, input.kind, input.progress,
      frame === 0 ? input.swing : 0
    );
    remaining -= dt;
    frame++;
  }
}

function sameMotion(actual, expected) {
  for (let i = 0; i < actual.channels.length; i++) {
    closeTo(actual.channels[i].lead, expected.channels[i].lead);
    closeTo(actual.channels[i].value, expected.channels[i].value);
  }
  for (const phase of ["walkPhase", "miningPhase", "foodPhase"]) {
    const distance = Math.abs(actual[phase] - expected[phase]);
    closeTo(Math.min(distance, TAU - distance), 0);
  }
  const a = composeHeldMotion(actual, false, false, false);
  const b = composeHeldMotion(expected, false, false, false);
  for (const key of Object.keys(a)) closeTo(a[key], b[key]);
}

test("equal input intervals give equal poses at 30/60/144 Hz and variable dt", () => {
  const states = schedules.map(() => createHeldMotion());
  for (const state of states) requestHeldSelection(state);
  // Edges/progress changes occur at identical times, not at frame indices.
  for (const [seconds, input] of [
    [0.13, {}],
    [0.41, { mining: true, moving: true }],
    [0.37, {}],
    [0.24, { kind: "food", moving: true }],
    [0.32, { kind: "bow", progress: 0.65 }],
    [0.18, { kind: "bow", progress: 1 }],
    [0.21, { kind: "shield" }],
    [0.35, { swing: 1 }],
    [0.7, {}],
  ]) {
    for (let i = 0; i < states.length; i++)
      advanceFor(states[i], seconds, schedules[i], input);
    for (const state of states) sameMotion(state, states[0]);
  }
});

test("accepted mining leases produce repeated strokes at dt=0.1, then ease out", () => {
  const motion = createHeldMotion();
  const pitches = new Set();
  for (let i = 0; i < 30; i++) {
    motion.miningRequested = true;
    advanceHeldMotion(motion, 0.1, false, true);
    assert.equal(motion.miningRequested, false, "each lease is consumed");
    assert.equal(motion.miningActive, true);
    const pose = composeHeldMotion(motion, false, false, false);
    assert.ok(pose.rx >= -0.53 - 1e-12 && pose.rx <= 0.15);
    pitches.add(pose.rx.toFixed(4));
  }
  assert.ok(pitches.size > 8, "a top-up must not pin the hand to one angle");
  closeTo(motion.miningPhase, (3 * TAU / HELD_MINING_PERIOD) % TAU);
  advanceFor(motion, 0.35);
  assert.equal(motion.miningActive, false, "no lease means mining ended");
  assert.ok(motion.mining.value < 0.004);
  closeTo(composeHeldMotion(motion, false, false, false).rx, 0.15, 0.003);
});

test("swing requests stay one-shot impulses and never imply sustained mining", () => {
  const motion = createHeldMotion();
  advanceHeldMotion(motion, 1 / 144, false, true, null, 0, 1);
  assert.ok(motion.strike.value > 0);
  assert.equal(motion.miningActive, false);
  advanceFor(motion, 0.8);
  assert.ok(motion.strike.value < 0.0001);
  for (let i = 0; i < 40; i++)
    advanceHeldMotion(motion, 1 / 60, false, true, null, 0, 0.25);
  assert.equal(motion.mining.value, 0, "no swing-value heuristic");
  assert.equal(motion.miningActive, false);
});

test("walking entry/exit is continuous even away from a sine zero", () => {
  const motion = createHeldMotion();
  const idle = { ...composeHeldMotion(motion, false, false, false) };
  advanceHeldMotion(motion, 0, true, true);
  assert.deepEqual(composeHeldMotion(motion, false, false, false), idle);
  advanceHeldMotion(motion, 1 / 144, true, true);
  closeTo(composeHeldMotion(motion, false, false, false).y, idle.y, 0.0001);
  advanceFor(motion, 0.15 - 1 / 144, [1 / 60], { moving: true });
  const walking = { ...composeHeldMotion(motion, false, false, false) };
  assert.ok(walking.y - idle.y > 0.007);
  advanceHeldMotion(motion, 0, false, true);
  assert.deepEqual(composeHeldMotion(motion, false, false, false), walking);
  advanceHeldMotion(motion, 1 / 144, false, true);
  const stopping = composeHeldMotion(motion, false, false, false);
  assert.ok(Math.abs(stopping.y - idle.y) > 0.006, "do not remove bob in one frame");
  closeTo(stopping.y, walking.y, 0.0005);
  advanceFor(motion, 0.5);
  closeTo(composeHeldMotion(motion, false, false, false).y, idle.y, 0.00001);
});

for (const kind of ["food", "bow", "shield"]) {
  test(`${kind} enters and releases through the same bounded visual envelope`, () => {
    const motion = createHeldMotion();
    const idle = { ...composeHeldMotion(motion, false, kind === "shield", false) };
    advanceHeldMotion(motion, 0, false, true, kind, 1);
    assert.deepEqual(composeHeldMotion(motion, false, kind === "shield", false), idle);
    advanceHeldMotion(motion, 0.1, false, true, kind, 1);
    closeTo(motion[kind].value, 1 - 3.2 * Math.exp(-2.2));
    const entering = composeHeldMotion(motion, false, kind === "shield", false);
    assert.ok(entering.depth < 0.82 && entering.depth > 0.72);
    advanceFor(motion, 0.6, [1 / 60], { kind, progress: 1 });
    const held = { ...composeHeldMotion(motion, false, kind === "shield", false) };
    advanceHeldMotion(motion, 0, false, true);
    assert.deepEqual(composeHeldMotion(motion, false, kind === "shield", false), held);
    advanceHeldMotion(motion, 1 / 60, false, true);
    assert.ok(motion[kind].value > 0.94, "release starts near the previous pose");
    if (kind === "bow")
      assert.ok(composeHeldMotion(motion, false, false, false).scaleY > 1.1);
    advanceFor(motion, 0.35);
    assert.ok(motion[kind].value < 0.004);
    closeTo(composeHeldMotion(motion, false, kind === "shield", false).x, idle.x, 0.002);
  });
}

test("rapid use reversals and invalid progress stay bounded, with no queued poses", () => {
  const motion = createHeldMotion();
  const kinds = ["food", "bow", "shield", null];
  const progress = [-3, NaN, Infinity, 0, 0.6, 20];
  for (let i = 0; i < 300; i++) {
    advanceHeldMotion(
      motion, schedules[4][i % schedules[4].length], false, true,
      kinds[i % kinds.length], progress[i % progress.length]
    );
    for (const channel of motion.channels) {
      assert.ok(channel.lead >= 0 && channel.lead <= 1);
      assert.ok(channel.value >= 0 && channel.value <= 1);
    }
    assert.ok(motion.food.value + motion.bow.value + motion.shield.value <= 1 + 1e-12);
    const pose = composeHeldMotion(motion, true, false, false);
    assert.ok(Object.values(pose).every(Number.isFinite));
    assert.ok(pose.depth >= 0.72 - 1e-12 && pose.depth <= 0.82 + 1e-12);
    assert.ok(pose.scaleY >= 1 - 1e-12 && pose.scaleY <= 1.72 + 1e-12);
    for (const phase of ["walkPhase", "miningPhase", "foodPhase"])
      assert.ok(motion[phase] >= 0 && motion[phase] < TAU);
  }
});

test("selection pulses preserve the rendered pose and rapid selections stay bounded", () => {
  const motion = createHeldMotion();
  const before = { ...composeHeldMotion(motion, false, false, false) };
  requestHeldSelection(motion);
  assert.deepEqual(composeHeldMotion(motion, false, false, false), before);
  for (let i = 0; i < 24; i++) {
    requestHeldSelection(motion);
    advanceHeldMotion(motion, 0.005, false, true);
    const pose = composeHeldMotion(motion, false, false, false);
    assert.ok(pose.y >= -0.83 - 1e-12 && pose.y < -0.75);
  }
  advanceFor(motion, 0.8);
  closeTo(composeHeldMotion(motion, false, false, false).y, before.y, 0.00001);
});

test("invalid/zero dt freezes state and preserves a pending lease", () => {
  const motion = createHeldMotion();
  advanceFor(motion, 0.12, [1 / 60], { moving: true, kind: "bow", progress: 0.5 });
  motion.miningRequested = true;
  const before = structuredClone(motion);
  for (const dt of [0, -1, NaN, Infinity, -Infinity, undefined, "0.01"]) {
    assert.equal(advanceHeldMotion(motion, dt, true, true, "shield", 1, 1), 0);
    assert.deepEqual(motion, before);
  }
  advanceHeldMotion(motion, 0.01, false, true);
  assert.equal(motion.miningRequested, false);
  assert.equal(motion.miningActive, true);
});

test("oversized deltas take one bounded visual step, not a catch-up loop", () => {
  const actual = createHeldMotion();
  const expected = createHeldMotion();
  actual.miningRequested = expected.miningRequested = true;
  assert.equal(
    advanceHeldMotion(actual, 300, true, true, "bow", 1, 1),
    HELD_MOTION_MAX_DT
  );
  advanceHeldMotion(expected, HELD_MOTION_MAX_DT, true, true, "bow", 1, 1);
  sameMotion(actual, expected);
});

test("hidden frames clear transient work without replacing state", () => {
  const motion = createHeldMotion();
  const channels = [...motion.channels];
  const pose = motion.pose;
  requestHeldSelection(motion);
  advanceFor(motion, 0.4, [1 / 60], { mining: true, moving: true, swing: 1 });
  motion.miningRequested = true;
  advanceHeldMotion(motion, 0, true, false, "shield", 1, 1);
  assert.equal(motion.miningRequested, false);
  assert.equal(motion.miningActive, false);
  for (let i = 0; i < channels.length; i++) {
    assert.equal(motion.channels[i], channels[i]);
    assert.deepEqual(channels[i], { lead: 0, value: 0 });
  }
  assert.equal(composeHeldMotion(motion, false, false, false), pose);
  advanceHeldMotion(motion, 1 / 60, false, true);
  closeTo(composeHeldMotion(motion, false, false, false).rx, 0.15);
});

test("reduced motion suppresses decoration but retains useful held-use poses", () => {
  const motion = createHeldMotion();
  requestHeldSelection(motion);
  advanceFor(motion, 0.1, [1 / 60], { mining: true, moving: true, swing: 1 });
  assert.notEqual(composeHeldMotion(motion, false, false, false).rx, 0.15);
  const quiet = composeHeldMotion(motion, false, false, true);
  closeTo(quiet.rx, 0.15);
  closeTo(quiet.y, -0.75);
  for (const kind of ["food", "bow", "shield"]) {
    advanceFor(motion, 1, [1 / 60], { kind, progress: 1, moving: true });
    const held = composeHeldMotion(motion, false, kind === "shield", true);
    assert.ok(held.depth < 0.8, `${kind} still communicates active use`);
    if (kind === "food") closeTo(held.y, -0.26, 1e-8);
    if (kind === "bow") assert.ok(held.scaleY > 1.11);
    if (kind === "shield") closeTo(held.scale, 1.6, 1e-8);
  }
});
