import assert from "node:assert/strict";
import test from "node:test";
import { BotMetrics } from "./realtime/metrics.js";

function fixture(start = 0.5) {
  let now = 0;
  let previous = 0;
  const game = {
    currentTime: start,
    active: true,
    paused: false,
    miningProgress: 0,
    player: { position: { x: 0.5, y: 32, z: 0.5 } },
    world: {
      chunks: new Map(),
      _requests: new Map(),
      _inFlight: new Map(),
      dirtyChunks: new Set(),
      _nextRequestId: 0,
      isLoaded: () => true,
    },
    graphics: {
      chunks: new Map(),
      renderer: {
        info: {
          render: { calls: 1, triangles: 12 },
          memory: { geometries: 1, textures: 1 },
        },
      },
    },
    frame(time) {
      if (!this.paused)
        this.currentTime =
          (this.currentTime + (time - previous) / 1000 / 1200) % 1;
      previous = time;
    },
  };
  const metrics = new BotMetrics(game, {
    eventTarget: new EventTarget(),
    clock: () => now,
  });
  metrics.reset("clock-regression");
  return {
    game,
    metrics,
    tick() {
      now += 16;
      game.frame(now);
    },
  };
}

test("clock metrics measure wall-time rate across a day boundary", () => {
  const { metrics, tick } = fixture(0.9998);
  for (let frame = 0; frame < 100; frame++) tick();
  const clock = metrics.results({ stop: true }).clock;
  assert.equal(clock.discontinuities, 0);
  assert.ok(Math.abs(clock.simulatedSeconds - 1.6) < 1e-8);
  assert.ok(Math.abs(clock.simulationRate - 1) < 1e-8);
});

test("clock metrics distinguish pauses from external time-slider jumps", () => {
  const { game, metrics, tick } = fixture();
  game.paused = true;
  for (let frame = 0; frame < 10; frame++) tick();
  assert.equal(metrics.results().clock.simulatedSeconds, 0);
  game.currentTime = 0.1;
  tick();
  assert.equal(metrics.results().clock.discontinuities, 1);
});
