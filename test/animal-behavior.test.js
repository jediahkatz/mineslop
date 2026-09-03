import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMAL_BEHAVIOR_LIMITS,
  animalCanGraze,
  createAnimalBehavior,
  planAnimalBehavior,
  planAnimalVocalization,
} from "../src/animal-behavior.js";
import { BLOCK } from "../src/blocks.js";

const observation = (changes = {}) => ({
  kind: "sheep",
  position: { x: 0, y: 9, z: 0 },
  home: { x: 0, y: 9, z: 0 },
  player: { x: 10, y: 9, z: 0 },
  yaw: 0,
  speed: 1,
  daylight: true,
  playerVisible: true,
  attracted: false,
  canGraze: true,
  audible: true,
  ...changes,
});

test("grazing is a pure habitat-gated intent, not a terrain or resource edit", () => {
  const state = Object.freeze({
    ...createAnimalBehavior("sheep"), remaining: 0, seed: 0,
  });
  const seen = observation();
  const before = structuredClone({ state, seen });
  const result = planAnimalBehavior(state, seen, 0.1);
  assert.equal(result.intent.mode, "graze");
  assert.equal(result.intent.speed, 0);
  assert.deepEqual({ state, seen }, before);
  const lostGround = planAnimalBehavior(result.state, observation({ canGraze: false }), 0.1);
  assert.equal(lostGround.intent.mode, "idle");
  assert.ok(animalCanGraze("sheep", BLOCK.GRASS));
  assert.equal(animalCanGraze("sheep", BLOCK.STONE), false);
  assert.ok(animalCanGraze("mooshroom", BLOCK.MYCELIUM));
  assert.equal(animalCanGraze("mooshroom", BLOCK.GRASS), false);
  assert.equal(animalCanGraze("zombie", BLOCK.GRASS), false);
});

test("food following has start/stop hysteresis and requires physical visible range", () => {
  let state = createAnimalBehavior("follower");
  for (const [distance, approaching] of [
    [3.3, true], [2.6, true], [2, false], [2.6, false], [3.3, true],
  ]) {
    const result = planAnimalBehavior(state, observation({
      attracted: true, player: { x: distance, y: 9, z: 0 },
    }), 0.1);
    state = result.state;
    assert.equal(result.intent.mode, "follow");
    assert.equal(result.intent.speed > 0, approaching);
  }
  for (const changes of [
    { playerVisible: false },
    { player: { x: 20, y: 9, z: 0 } },
    { player: { x: 4, y: 14, z: 0 } },
  ]) {
    assert.notEqual(planAnimalBehavior(state, observation({
      attracted: true, ...changes,
    }), 0.1).intent.mode, "follow");
  }
});

test("injury overrides food and fleeting startles do not cause frame-by-frame reversals", () => {
  const hurt = planAnimalBehavior(createAnimalBehavior("hurt"), observation({
    attracted: true, fleeTime: 2, threat: { x: -3, z: 0 },
  }), 0.1);
  assert.equal(hurt.intent.mode, "flee");
  assert.ok(hurt.intent.speed > 1);
  assert.equal(hurt.intent.yaw, Math.PI / 2);
  const continuing = planAnimalBehavior(hurt.state, observation({
    player: { x: 30, y: 9, z: 0 },
  }), 0.1);
  assert.equal(continuing.intent.mode, "flee");
  assert.equal(continuing.intent.yaw, hurt.intent.yaw);

  const startled = planAnimalBehavior(createAnimalBehavior("rabbit"), observation({
    kind: "rabbit", player: { x: 2, y: 9, z: 0 },
  }), 0.1);
  assert.equal(startled.intent.mode, "flee");
  const releaseBand = { ...startled.state, remaining: 0 };
  assert.equal(planAnimalBehavior(releaseBand, observation({
    kind: "rabbit", player: { x: 5, y: 9, z: 0 },
  }), 0.1).intent.mode, "flee");
  assert.notEqual(planAnimalBehavior(releaseBand, observation({
    kind: "rabbit", player: { x: 8, y: 9, z: 0 },
  }), 0.1).intent.mode, "flee");
});

test("roaming heads home while stale grazing and paused/controlled motion stay bounded", () => {
  const state = { ...createAnimalBehavior("roamer"), remaining: 0 };
  const away = observation({
    position: { x: 30, y: 9, z: 0 },
    player: { x: 50, y: 9, z: 0 },
  });
  const result = planAnimalBehavior(state, away, 0.1);
  assert.equal(result.intent.mode, "roam");
  assert.equal(result.intent.yaw, -Math.PI / 2);
  for (const changes of [
    { paused: true }, { controlled: true }, { kind: "enderman" },
  ]) {
    const stopped = planAnimalBehavior(state, observation(changes), 0.1);
    assert.equal(stopped.state, state);
    assert.equal(stopped.intent.speed, 0);
    assert.equal(stopped.event, null);
  }
  for (const dt of [0, -1, NaN, Infinity])
    assert.equal(planAnimalBehavior(state, away, dt).state, state);
  assert.deepEqual(
    planAnimalBehavior(state, away, 100),
    planAnimalBehavior(state, away, ANIMAL_BEHAVIOR_LIMITS.step)
  );
});

test("initial and subsequent common-animal calls use independent randomized cooldowns", () => {
  const intervals = new Set();
  for (let index = 0; index < 24; index++) {
    const state = createAnimalBehavior(`voice:${index}`);
    assert.ok(state.callIn >= 12 && state.callIn <= 30);
    intervals.add(state.callIn);
    const due = Object.freeze({ ...state, callIn: 0.05 });
    const voice = planAnimalVocalization(due, { audible: true }, 0.1);
    assert.equal(voice.event.call, "ambient");
    assert.ok(voice.state.callIn >= 12 && voice.state.callIn <= 30);
    assert.equal(due.callIn, 0.05);
    assert.equal(
      planAnimalVocalization(voice.state, { audible: true, alarm: true }, 0.1).event,
      null,
      "a new alarm cannot bypass the common voice cooldown"
    );
  }
  assert.ok(intervals.size > 1);
});

test("out-of-range and refused opportunities cannot accrue a vocalization backlog", () => {
  const due = { ...createAnimalBehavior("voice"), callIn: 0 };
  const audible = planAnimalVocalization(due, { audible: true }, 0.1);
  const distant = planAnimalVocalization(due, { audible: false }, 0.1);
  assert.deepEqual(audible.state, distant.state);
  assert.equal(distant.event, null);
  assert.equal(planAnimalVocalization(distant.state, { audible: true }, 0.1).event, null);
  const alarm = planAnimalVocalization(due, { audible: true, alarm: true }, 0.1);
  assert.equal(alarm.event.call, "alarm");
  assert.deepEqual(alarm.state, audible.state);
  assert.equal(
    planAnimalVocalization(due, { audible: true, paused: true }, 100).state,
    due
  );
});
