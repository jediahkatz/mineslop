import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ExperienceOrbs, MAX_EXPERIENCE_RECEIVERS } from "../src/experience-orbs.js";
import { Gameplay } from "../src/gameplay.js";
import { entityWorld } from "./entity-context-fixtures.js";

const at = { x: 0.5, y: 1.5, z: 0.5 };
const feet = { ...at, y: 1 };
const plan = (participants) => ({ ok: true, prepared: true, participants });
function fixture(t) {
  const world = entityWorld({ generatorVersion: 3, floor: 0 });
  const { coordinator, context } = world;
  const gameplay = new Gameplay({ coordinator, context });
  const orbs = new ExperienceOrbs(new THREE.Scene(), world, { coordinator, context });
  t.after(() => { orbs.dispose(); gameplay.dispose(); });
  const collect = () => orbs.update(0.01, 1, feet, gameplay);
  const spawn = () => assert.equal(orbs.spawn(7, at, { velocity: { x: 0, y: 0, z: 0 } }), true);
  return { orbs, gameplay, coordinator, collect, spawn };
}

test("explicit prepared receiver plans publish all bounded owners before observing orb removal", (t) => {
  const f = fixture(t);
  let published = 0;
  const observed = [];
  const peers = Array.from({ length: MAX_EXPERIENCE_RECEIVERS - 1 }, () => {
    const owner = {};
    assert.equal(f.coordinator.register(owner, 0), true);
    return {
      owner, beforeBytes: 0, afterBytes: 0,
      validate: () => true, publish: () => { published++; },
      notify: () => {
        observed.push([published, f.orbs.size, f.gameplay.getState().experience.total]);
      },
    };
  });
  f.orbs.prepareCollect = (amount) => plan([f.gameplay.prepareExperience(amount), ...peers]);
  f.spawn();
  f.collect();
  assert.equal(f.orbs.size, 0);
  assert.equal(published, MAX_EXPERIENCE_RECEIVERS - 1);
  assert.deepEqual(observed, Array.from({ length: MAX_EXPERIENCE_RECEIVERS - 1 },
    () => [MAX_EXPERIENCE_RECEIVERS - 1, 0, 7]));
});

test("invalid, duplicate, foreign, nested, async and over-limit receivers retain the orb and XP", (t) => {
  let oversizedReads = 0;
  const invalid = [
    () => plan([]),
    (f, p) => plan([p, p]),
    (f, p) => plan([p, { ...p, owner: f.orbs }]),
    (f, p) => plan([p, { ...p, owner: {} }]),
    (f, p) => plan([p, { ...p, owner: {}, then() {} }]),
    (f, p) => ({ ...plan([p]), then() {} }),
    (f, p) => plan(Object.assign([p], { then() {} })),
    (f, p) => plan([plan([p])]),
    (f, p) => plan([{ ...p, validate: async () => true }]),
    (f, p) => plan([{ ...p, validate: () => Promise.resolve(true) }]),
    (f, p) => ({ ...plan([p]), ok: false }),
    (f, p) => ({ participants: [p] }),
    (f, p) => [p],
    () => plan(new Array(MAX_EXPERIENCE_RECEIVERS + 1)),
    () => {
      const parts = new Array(0xffffffff);
      Object.defineProperty(parts, 0, { get() { oversizedReads++; return null; } });
      return plan(parts);
    },
    () => Object.defineProperty({}, "then", { get() { throw new Error("bad getter"); } }),
  ];
  for (const make of invalid) {
    const f = fixture(t);
    f.orbs.prepareCollect = (amount) => make(f, f.gameplay.prepareExperience(amount));
    f.spawn();
    const bytes = f.coordinator.budget.totalBytes;
    f.collect();
    assert.equal(f.orbs.size, 1);
    assert.equal(f.gameplay.getState().experience.total, 0);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
  }
  assert.equal(oversizedReads, 0);
});

test("multi-receiver validation reentry aborts all owners and never retires the source", (t) => {
  const f = fixture(t);
  let nested;
  f.orbs.prepareCollect = (amount) => {
    const player = f.gameplay.prepareExperience(amount);
    return plan([{
      ...player,
      validate: () => {
        nested = f.coordinator.commit([player]);
        return true;
      },
    }]);
  };
  f.spawn();
  f.collect();
  assert.equal(nested.reason, "reentrant-commit");
  assert.equal(f.orbs.size, 1);
  assert.equal(f.gameplay.getState().experience.total, 0);
});

test("receiver list length is captured once before any indexed access", (t) => {
  const f = fixture(t);
  let lengthReads = 0, indexedReads = 0;
  f.orbs.prepareCollect = (amount) => plan(new Proxy([f.gameplay.prepareExperience(amount)], {
    get(target, key) {
      if (key === "length") return ++lengthReads === 1 ? 1 : 0xffffffff;
      if (key === "0") indexedReads++;
      return Reflect.get(target, key);
    },
  }));
  f.spawn();
  f.collect();
  assert.equal(lengthReads, 1);
  assert.equal(indexedReads, 1);
  assert.equal(f.orbs.size, 0);
  assert.equal(f.gameplay.getState().experience.total, 7);
});

test("stale source revisions veto an otherwise valid multi-receiver plan", (t) => {
  const f = fixture(t);
  f.spawn();
  const orb = f.orbs._orbs[0], removal = f.orbs._prepareRemoval(orb);
  const receive = f.gameplay.prepareExperience(7);
  f.orbs.update(0.01, 0.01, feet, { dead: true });
  assert.equal(f.coordinator.commit([receive, removal]).ok, false);
  assert.equal(f.orbs.size, 1);
  assert.equal(f.gameplay.getState().experience.total, 0);
});
