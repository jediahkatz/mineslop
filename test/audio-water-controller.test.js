import assert from "node:assert/strict";
import test from "node:test";
import { waterControllerFixture } from "./audio-water-fixture.js";

function counts(f) {
  return {
    requested: f.events.length,
    entry: f.events.filter((e) => e.kind === "water-entry").length,
    exit: f.events.filter((e) => e.kind === "water-jump").length,
    started: f.events.filter((e) => e.accepted).length,
    physicalCrossings: f.crossings.filter((c) => !c.reset).length - 1,
  };
}

function enter(f) {
  f.step(0.1);
  f.key("KeyW", true);
  f.step(1.2);
  f.key("KeyW", false);
  assert.deepEqual(f.kinds(), ["water-entry"]);
}

for (const frame of [1 / 30, 1 / 60, 1 / 144, [1 / 30, 1 / 144, 1 / 60]]) {
  const name = Array.isArray(frame) ? "partitioned dt" : `${Math.round(1 / frame)}Hz`;

  test(`real controller: idle floating and steady swimming do not repeat entry (${name})`, async (t) => {
    const f = await waterControllerFixture(t, { depth: 3, frame });
    enter(f);
    f.step(12);
    assert.deepEqual(f.kinds(), ["water-entry"]);
    f.key("KeyW", true);
    f.step(12);
    f.key("KeyW", false);
    assert.deepEqual(f.kinds(), ["water-entry"]);
    assert.ok(f.player.fluidState.waterImmersion > 0);
    assert.ok(f.context.sources.every((source) => !source.loop), "impacts never loop");
    t.diagnostic(`${name} idle + swim: ${JSON.stringify(counts(f))}`);
  });

  test(`real controller: held Space makes real exits then settles without an impact loop (${name})`, async (t) => {
    const f = await waterControllerFixture(t, { depth: 3, frame });
    enter(f);
    f.step(10);
    f.key("Space", true);
    f.step(5);
    const settled = f.events.length;
    f.key("KeyW", true);
    f.step(5);
    f.key("KeyW", false);
    assert.equal(f.events.length, settled, "surface chatter must not retrigger the impact");
    assert.ok(f.kinds().includes("water-jump"), "actual ascent out of water remains audible");
    assert.ok(f.events.filter((e) => e.kind === "water-entry").length >= 2,
      "real re-entry remains audible");
    f.key("Space", false);
    f.step(2);
    const landed = f.events.length;
    f.step(5);
    assert.equal(f.events.length, landed);
    assert.equal(f.events.length, Array.isArray(frame) ? 9 : 7,
      "count initial entry, real exit/landings, and final release into water");
    assert.ok(f.context.sources.every((source) => !source.loop));
    t.diagnostic(`${name} held Space (10s) + release: ${JSON.stringify(counts(f))}`);
  });

  test(`real controller: shoreline wading, exit and re-entry each admit one entry (${name})`, async (t) => {
    const f = await waterControllerFixture(t, { frame });
    enter(f);
    f.step(5);
    assert.deepEqual(f.kinds(), ["water-entry"]);
    f.key("KeyS", true);
    f.step(1.6);
    f.key("KeyS", false);
    assert.equal(f.player.fluidState.waterImmersion, 0);
    f.step(0.2);
    f.key("KeyW", true);
    f.step(1.6);
    f.key("KeyW", false);
    f.step(3);
    assert.deepEqual(f.kinds(), ["water-entry", "water-entry"]);
    t.diagnostic(`${name} shore out/re-enter: ${JSON.stringify(counts(f))}`);
  });
}

test("real controller: deliberate jump-out and landing produce exactly one event each", async (t) => {
  const f = await waterControllerFixture(t);
  enter(f);
  f.key("Space", true);
  // Release on the real collision-sampled dry edge, not by teleporting/forcing a sample.
  for (let i = 0; i < 120 && !f.kinds().includes("water-jump"); i++) f.step(1 / 120);
  f.key("Space", false);
  f.step(3);
  assert.deepEqual(f.kinds(), ["water-entry", "water-jump", "water-entry"]);
  assert.equal(counts(f).started, 3);
  t.diagnostic(`deliberate hop: ${JSON.stringify(counts(f))}`);
});

test("real controller: reset, restore, world replacement and unknown boundaries seed silently", async (t) => {
  const f = await waterControllerFixture(t);
  f.step(0.1);
  f.player.setPosition({ x: 0.5, y: 1, z: -3.5 });
  f.step(2);
  f.load(false);
  f.step(1);
  f.load(true);
  f.step(2);
  const savedPosition = { ...f.player.position };
  f.game.bindPlayerAudio();
  f.player.setPosition(savedPosition);
  f.step(2);
  f.player.world = { ...f.world };
  f.step(2);
  assert.deepEqual(f.kinds(), []);
  assert.equal(f.context.sources.length, 0);
});

test("real Game mixer gate: pause/death silence an entry and resume cannot replay it", async (t) => {
  const f = await waterControllerFixture(t);
  enter(f);
  const starts = f.context.sources.length;
  f.game.paused = true;
  f.game.updateAudio(0);
  assert.equal(f.audio.voices.size, 0);
  f.context.advance(10); // Game admits no physics while paused.
  f.game.paused = false;
  f.game.updateAudio(0);
  f.step(3);
  assert.deepEqual(f.kinds(), ["water-entry"]);
  f.game.gameplay.dead = true;
  f.game.updateAudio(0);
  assert.equal(f.audio.play("water-entry"), false);
  f.game.gameplay.dead = false;
  f.game.updateAudio(0);
  f.step(2);
  assert.deepEqual(f.kinds(), ["water-entry"]);
  assert.equal(f.context.sources.length, starts);
});
