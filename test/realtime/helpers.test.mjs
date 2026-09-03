import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "./config.mjs";
import { bounded, RealInputs, traversalPlan } from "./input.mjs";
import { BotMetrics } from "./metrics.js";
import {
  distance,
  evaluateBudgets,
  softwareRenderer,
  summarize,
  summarizeFrames,
} from "./statistics.js";

// Unit tests of harness bookkeeping only. These are not game benchmark results.
test("percentiles are nearest-rank, filter invalid numbers, and leave input untouched", () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 - index);
  const original = [...values];
  const result = summarize([...values, NaN, Infinity]);
  assert.equal(result.p50, 50);
  assert.equal(result.p95, 95);
  assert.equal(result.p99, 99);
  assert.equal(result.max, 100);
  assert.equal(result.samples, 100);
  assert.deepEqual(values, original);
});

test("empty samples report unknown percentiles, never fabricated zero latency", () => {
  const summary = summarize([]);
  assert.equal(summary.samples, 0);
  for (const field of ["min", "p50", "p95", "p99", "max", "mean"])
    assert.equal(summary[field], null);
  assert.equal(summarizeFrames([]).fps.average, null);
});

test("FPS throughput and jank use actual positive, unclamped RAF intervals", () => {
  const frames = summarizeFrames([10, 90, 200, 0, NaN]);
  assert.equal(frames.intervalMs.samples, 3);
  assert.equal(frames.intervalMs.max, 200);
  assert.equal(frames.fps.average, 10);
  assert.notEqual(frames.fps.mean, frames.fps.average);
  assert.equal(frames.jank.over50Ms, 2);
  assert.equal(frames.jank.over100Ms, 1);
  assert.equal(frames.jank.over100MsFraction, 1 / 3);
});

test("performance budgets are opt-in and cannot pass missing measurements", () => {
  assert.deepEqual(evaluateBudgets(undefined, {}), []);
  assert.equal(
    evaluateBudgets(undefined, { frameP95Ms: 100 })[0].passed,
    false
  );
  const measurement = {
    frames: summarizeFrames([20, 25]),
    latency: {
      keyToMotionMs: summarize([8, 12]),
      mouseToCameraMs: summarize([]),
    },
  };
  const budgets = evaluateBudgets(measurement, {
    frameP95Ms: 30,
    minimumFps: 60,
    mouseP95Ms: 50,
  });
  assert.equal(budgets[0].passed, true);
  assert.equal(budgets[1].passed, false);
  assert.equal(budgets[2].passed, false);
});

test("software renderer detection distinguishes unknown metadata", () => {
  assert.equal(softwareRenderer(null), null);
  assert.equal(softwareRenderer(""), null);
  assert.equal(
    softwareRenderer("ANGLE (Google, Vulkan SwiftShader Device)"),
    true
  );
  assert.equal(softwareRenderer("Mesa llvmpipe (LLVM)"), true);
  assert.equal(softwareRenderer("ANGLE (NVIDIA GeForce)"), false);
});

test("CLI arguments override environment while URL parameters are safely encoded", () => {
  const config = readConfig(
    [
      "--duration",
      "8",
      "--quality",
      "low",
      "--seed",
      "river & stone",
      "--output",
      "/tmp/voxelcraft-unit-report.json",
    ],
    {
      VOXELCRAFT_TEST_DURATION: "30",
      VOXELCRAFT_TEST_QUALITY: "high",
      VOXELCRAFT_TEST_URL: "http://example.test:4321/another/path?unused=1",
      VOXELCRAFT_MAX_FRAME_P95_MS: "90",
    }
  );
  const url = new URL(config.url);
  assert.equal(config.durationSeconds, 8);
  assert.equal(config.quality, "low");
  assert.equal(url.port, "4321");
  assert.equal(url.pathname, "/test/realtime/index.html");
  assert.equal(url.searchParams.get("seed"), "river & stone");
  assert.equal(url.searchParams.has("unused"), false);
  assert.deepEqual(config.budgets, { frameP95Ms: 90 });
});

test("invalid durations, qualities, URLs, and budgets fail before browser launch", () => {
  assert.throws(() => readConfig(["--duration", "NaN"], {}), /--duration/);
  assert.throws(() => readConfig(["--quality", "potato"], {}), /--quality/);
  assert.throws(
    () => readConfig([], { VOXELCRAFT_TEST_URL: "file:///tmp/game" }),
    /HTTP/
  );
  assert.throws(
    () => readConfig([], { VOXELCRAFT_MAX_JANK_100_FRACTION: "1.1" }),
    /between/
  );
  assert.throws(() => readConfig(["--seed", ""], {}), /Seed/);
});

test("terrain planning reaches obstacle clearance with Space/Shift and boosts with Ctrl", () => {
  const state = {
    position: { x: 3, y: 30, z: -4 },
    velocity: { x: 0, y: 0, z: 0 },
    planning: {
      worldHeight: 96,
      samples: [
        { terrainHeight: 25, topSolid: 25 },
        { terrainHeight: 26, topSolid: 38 },
      ],
    },
  };
  const original = structuredClone(state);
  const ascending = traversalPlan(state, 0, 0.2);
  assert.equal(ascending.targetAltitude, 41);
  assert.ok(ascending.keys.includes("Space"));
  assert.ok(ascending.keys.includes("KeyW"));
  assert.ok(ascending.keys.includes("ControlLeft"));
  assert.ok(!ascending.keys.includes("ShiftLeft"));
  assert.ok(ascending.pitch < 0);
  assert.deepEqual(state, original);
  const descending = traversalPlan(
    {
      ...state,
      position: { ...state.position, y: 60 },
    },
    10,
    0.2
  );
  assert.ok(descending.keys.includes("ShiftLeft"));
  assert.ok(!descending.keys.includes("Space"));
  assert.throws(
    () => traversalPlan({ planning: { samples: [] } }, 0, 0),
    /samples/
  );
});

test("ocean traversal plans above the water instead of steering into underwater fog", () => {
  const state = {
    position: { x: 0, y: 20, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    planning: {
      worldHeight: 96,
      waterLevel: 24,
      samples: [{ terrainHeight: 5, topSolid: 5 }],
    },
  };
  const plan = traversalPlan(state, 0, 0);
  assert.ok(plan.targetAltitude > state.planning.waterLevel);
  assert.ok(plan.keys.includes("Space"));
});

function inputFixture() {
  const events = [];
  const page = {
    keyboard: {
      down: async (key) => events.push(["down", key]),
      up: async (key) => events.push(["up", key]),
    },
    mouse: {
      down: async ({ button }) => events.push(["mousedown", button]),
      up: async ({ button }) => events.push(["mouseup", button]),
      move: async (x, y) => events.push(["move", x, y]),
    },
  };
  return {
    events,
    input: new RealInputs(page, {
      viewport: { width: 1280, height: 720 },
      timeoutMs: 1000,
    }),
  };
}

test("held-key diffs preserve continuous W and always release owned inputs", async () => {
  const { input, events } = inputFixture();
  await input.setHeld(["KeyW", "ControlLeft"]);
  await input.setHeld(["KeyW", "ControlLeft"]);
  await input.setHeld(["KeyW", "KeyD"]);
  await input.mouseDown();
  await input.mouseDown();
  await input.release();
  assert.deepEqual(events, [
    ["down", "KeyW"],
    ["down", "ControlLeft"],
    ["up", "ControlLeft"],
    ["down", "KeyD"],
    ["mousedown", "left"],
    ["up", "KeyW"],
    ["up", "KeyD"],
    ["mouseup", "left"],
  ]);
  assert.equal(input.held.size, 0);
  assert.equal(input.buttons.size, 0);
});

test("flight toggles use two fresh trusted Space press/release pairs", async () => {
  const { input, events } = inputFixture();
  await input.doubleTap("Space");
  assert.deepEqual(events, [
    ["down", "Space"],
    ["up", "Space"],
    ["down", "Space"],
    ["up", "Space"],
  ]);
  assert.equal(input.counts.keydown, 2);
  assert.equal(input.counts.keyup, 2);
  assert.equal(input.held.size, 0);
});

test("flight altitude corrections cannot accidentally double-tap Space", async () => {
  const { input, events } = inputFixture();
  await input.setHeld(["Space"], { flight: true });
  await input.setHeld(["Space"], { flight: true });
  await input.setHeld([], { flight: true });
  await input.setHeld(["Space"], { flight: true });
  assert.deepEqual(events, [
    ["down", "Space"],
    ["up", "Space"],
  ]);
  assert.equal(input.held.has("Space"), false);
  input.lastSpacePressAt = -Infinity;
  await input.setHeld(["Space"], { flight: true });
  assert.equal(input.held.has("Space"), true);
  await input.release();
});

test("native steering uses mouse movement; explicit fallback returns Arrow inputs", async () => {
  const { input, events } = inputFixture();
  const state = { yaw: 0, pitch: 0 };
  assert.deepEqual(await input.steer(state, 0.1, -0.3), []);
  assert.equal(events[0][0], "move");
  assert.ok(events[0][1] < 640);
  assert.ok(events[0][2] > 360);
  input.lookMode = "arrow-fallback";
  assert.deepEqual(await input.steer(state, 0.1, -0.3), [
    "ArrowLeft",
    "ArrowDown",
  ]);
  assert.equal(events.length, 1);
  assert.deepEqual(state, { yaw: 0, pitch: 0 });
});

test("bounded requests preserve successful results and reject hangs", async () => {
  assert.equal(await bounded(Promise.resolve(42), 1000, "unit result"), 42);
  await assert.rejects(
    bounded(new Promise(() => {}), 1, "unit hang"),
    /timed out/
  );
});

function metricsFixture() {
  let now = 0;
  let shouldThrow = false;
  const game = {
    active: true,
    paused: false,
    miningProgress: 0,
    player: {
      position: { x: 0, y: 30, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      enabled: true,
      locked: true,
      camera: { rotation: { x: 0, y: 0 } },
      update() {
        now += 1;
      },
    },
    world: {
      chunks: new Map(),
      _requests: new Map(),
      _inFlight: new Map(),
      _nextRequestId: 0,
      dirtyChunks: new Set(),
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
      rebuildDirty() {
        now += 2;
      },
      update() {
        now += 3;
      },
      render() {
        now += 4;
      },
    },
    archive: {
      identity: "actual-receiver",
      snapshot() {
        now += 5;
        if (shouldThrow) throw new Error("snapshot failure");
        return this.identity;
      },
    },
    wildlife: {
      update() {
        now += 6;
      },
    },
    frame() {
      this.player.update();
      this.graphics.rebuildDirty();
      this.graphics.update();
      this.graphics.render();
      this.wildlife.update();
      return "frame-result";
    },
  };
  const metrics = new BotMetrics(game, {
    clock: () => now,
    eventTarget: { addEventListener() {} },
  });
  return {
    game,
    metrics,
    setNow: (value) => {
      now = value;
    },
    throwSnapshot: () => {
      shouldThrow = true;
    },
  };
}

test("phase wrappers preserve receivers, return values, exceptions, and stop boundaries", () => {
  const { game, metrics, throwSnapshot } = metricsFixture();
  metrics.reset("unit-bookkeeping-only");
  assert.equal(game.frame(100), "frame-result");
  game.frame(116);
  assert.equal(game.archive.snapshot(), "actual-receiver");
  throwSnapshot();
  assert.throws(() => game.archive.snapshot(), /snapshot failure/);
  const result = metrics.results({ stop: true });
  assert.equal(result.frames.intervalMs.p95, 16);
  assert.equal(result.phaseMs["graphics.render"].p50, 4);
  assert.equal(result.phaseMs["archive.snapshot"].samples, 2);
  assert.equal(result.phaseMs["archive.snapshot"].p95, 5);
  game.frame(200);
  assert.equal(metrics.results().frames.callbacks, 2);
});

test("latency bookkeeping does not confuse existing forward motion with new strafe input", () => {
  const { game, metrics, setNow } = metricsFixture();
  metrics.reset("unit-latency-bookkeeping-only");
  metrics.observeInput({
    type: "keydown",
    code: "KeyD",
    repeat: false,
    isTrusted: true,
    timeStamp: 0,
  });
  game.player.position.z = -1;
  game.player.velocity.z = -5;
  setNow(8);
  metrics.playerUpdated();
  assert.equal(metrics.results().latency.keyToMotionMs.samples, 0);
  game.player.position.x = 0.1;
  game.player.velocity.x = 1;
  setNow(16);
  metrics.playerUpdated();
  assert.equal(metrics.results().latency.keyToMotionMs.p50, 16);
});

test("Shift descent latency is measured in flight, not invented for ground sneak", () => {
  const { game, metrics, setNow } = metricsFixture();
  metrics.reset("unit-flight-descent-bookkeeping-only");
  const event = {
    type: "keydown",
    code: "ShiftLeft",
    repeat: false,
    isTrusted: true,
    timeStamp: 0,
  };
  metrics.observeInput(event);
  assert.equal(metrics.pending.length, 0);
  game.player.flying = true;
  metrics.observeInput(event);
  game.player.position.y -= 0.1;
  game.player.velocity.y = -1;
  setNow(16);
  metrics.playerUpdated();
  assert.equal(metrics.results().latency.keyToMotionMs.p50, 16);
});

test("horizontal distance excludes ascent from traversal-distance assertions", () => {
  assert.equal(distance({ x: 0, y: 10, z: 0 }, { x: 3, y: 22, z: 4 }, true), 5);
  assert.equal(distance({ x: 0, y: 10, z: 0 }, { x: 3, y: 22, z: 4 }), 13);
});
