import assert from "node:assert/strict";
import test from "node:test";
import {
  RENDER_SCALE_DEFAULTS,
  RenderScaleController,
} from "../src/render-scale.js";

const viewport = { width: 1280, height: 720, maxRatio: 0.8 };
const create = (options = {}) =>
  new RenderScaleController({ ...viewport, ...options });

// Synthetic raw frame intervals exercise policy, not browser/GPU performance.
function feed(controller, frameMs, frames, state) {
  const changes = [];
  for (let frame = 1; frame <= frames; frame++) {
    const change = controller.observe(frameMs, state);
    if (change) changes.push({ ...change, frame });
  }
  return changes;
}

test("starts at the quality cap without depending on a renderer or browser", () => {
  const controller = create();
  assert.equal(RENDER_SCALE_DEFAULTS.targetFrameMs, 1000 / 45);
  assert.equal(controller.pixelRatio, 0.8);
  assert.equal(controller.minRatio, 0.5);
  assert.equal(controller.maxRatio, 0.8);
  assert.equal(create({ pixelRatio: 2 }).pixelRatio, 0.8);
  assert.equal(create({ pixelRatio: 0.1 }).pixelRatio, 0.5);
  assert.equal(create({ maxRatio: 0.4 }).minRatio, 0.4);
  assert.equal(create({ maxRatio: 0.4 }).pixelRatio, 0.4);
});

test("warmup and two sustained slow windows precede the first small recommendation", () => {
  const controller = create();
  assert.deepEqual(feed(controller, 50, 30), []);
  assert.deepEqual(feed(controller, 50, 15), []);
  assert.deepEqual(feed(controller, 50, 14), []);
  assert.deepEqual(controller.observe(50), {
    pixelRatio: 0.75,
    previousRatio: 0.8,
    reason: "slow",
    averageFrameMs: 50,
  });
  assert.equal(controller.pixelRatio, 0.75);
});

test("very long active frames remain evidence but cannot skip warmup or multiple steps", () => {
  const controller = create();
  // Every huge interval contributes only 250ms and one actual sample.
  assert.deepEqual(feed(controller, Number.MAX_VALUE, 6), []);
  assert.deepEqual(feed(controller, 2000, 7), []);
  const change = controller.observe(2000);
  assert.equal(change.pixelRatio, 0.75);
  assert.equal(change.averageFrameMs, 250);
  assert.equal(controller.observe(Number.MAX_VALUE), null);
  assert.equal(controller.pixelRatio, 0.75);
});

test("a single multi-second spike in a fast stream does not lower the ratio", () => {
  for (const precedingFrames of [0, 10, 40, 100]) {
    const controller = create({ warmupMs: 0 });
    assert.deepEqual(feed(controller, 16, precedingFrames), []);
    assert.equal(controller.observe(5000), null);
    assert.deepEqual(feed(controller, 16, 600), []);
    assert.equal(controller.pixelRatio, 0.8);
  }
});

test("occasional 33ms frames do not turn a healthy average into a tail-driven downgrade", () => {
  const controller = create({ warmupMs: 0 });
  for (let frame = 0; frame < 3000; frame++) {
    const interval = frame % 10 === 0 ? 33.4 : 16.7;
    assert.equal(controller.observe(interval), null);
  }
  assert.equal(controller.pixelRatio, 0.8);
});

test("sustained slow frames descend to the floor with bounded steps and cooldowns", () => {
  const controller = create();
  const changes = feed(controller, 100, 400);
  assert.deepEqual(
    changes.map((change) => change.pixelRatio),
    [0.75, 0.7, 0.65, 0.6, 0.55, 0.5]
  );
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    assert.equal(change.reason, "slow");
    assert.ok(change.previousRatio - change.pixelRatio <= 0.05 + 1e-12);
    if (i > 0)
      assert.ok(
        (change.frame - changes[i - 1].frame) * 100 >=
          RENDER_SCALE_DEFAULTS.cooldownMs
      );
  }
  assert.equal(controller.pixelRatio, 0.5);
  assert.deepEqual(feed(controller, 200, 400), []);
});

test("recovery needs four fast windows and fresh post-cooldown evidence", () => {
  const controller = create({ warmupMs: 0, pixelRatio: 0.5 });
  // 47 * 16ms fills one 750ms window; recovery requires four.
  assert.deepEqual(feed(controller, 16, 187), []);
  assert.equal(controller.observe(16).pixelRatio, 0.55);
  assert.deepEqual(feed(controller, 16, 125), []);
  assert.deepEqual(feed(controller, 16, 187), []);
  const next = controller.observe(16);
  assert.equal(next.pixelRatio, 0.6);
  assert.equal(next.reason, "recovery");
});

test("recovery can reach an off-grid cap but never exceeds it or repeats unchanged recommendations", () => {
  const controller = create({
    warmupMs: 0,
    pixelRatio: 0.5,
    maxRatio: 0.83,
  });
  const changes = feed(controller, 16, 4000);
  assert.deepEqual(
    changes.map((change) => change.pixelRatio),
    [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.83]
  );
  assert.equal(controller.pixelRatio, 0.83);
  assert.deepEqual(feed(controller, 16, 1000), []);
});

test("off-grid starting ratios cannot produce an adaptive step larger than configured", () => {
  for (const pixelRatio of [0.7777774, 0.7777776]) {
    for (const interval of [16, 50]) {
      const controller = create({ warmupMs: 0, pixelRatio });
      for (const change of feed(controller, interval, 500))
        assert.ok(
          Math.abs(change.pixelRatio - change.previousRatio) <= 0.05 + 1e-12
        );
    }
  }
});

test("the raw-interval target is configurable independently of quality features", () => {
  const normal = create({ warmupMs: 0 });
  const relaxed = create({ warmupMs: 0, targetFrameMs: 1000 / 30 });
  assert.ok(feed(normal, 30, 100).length > 0);
  assert.deepEqual(feed(relaxed, 30, 100), []);
  assert.equal(relaxed.pixelRatio, 0.8);
});

test("deadband jitter and alternating fast/slow windows do not oscillate the ratio", () => {
  const controller = create({ warmupMs: 0, pixelRatio: 0.7 });
  for (let i = 0; i < 2000; i++)
    assert.equal(controller.observe(i % 2 === 0 ? 21 : 24), null);
  controller.reset();
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(feed(controller, 16, 47), []);
    assert.deepEqual(feed(controller, 50, 15), []);
  }
  assert.equal(controller.pixelRatio, 0.7);
});

for (const flag of ["paused", "hidden"]) {
  test(`${flag} frames and the first resumed interval do not train or retain slow evidence`, () => {
    const controller = create({ warmupMs: 0 });
    assert.deepEqual(feed(controller, 50, 15), []);
    assert.deepEqual(feed(controller, 5000, 100, { [flag]: true }), []);
    assert.equal(controller.pixelRatio, 0.8);
    assert.equal(controller.observe(100000), null);
    assert.deepEqual(feed(controller, 50, 15), []);
    assert.deepEqual(feed(controller, 50, 14), []);
    assert.equal(controller.observe(50).pixelRatio, 0.75);
  });
}

test("pause freezes cooldown and resuming cannot spend hidden time on a new change", () => {
  const controller = create({ warmupMs: 0 });
  assert.equal(feed(controller, 50, 30).at(-1).pixelRatio, 0.75);
  assert.deepEqual(feed(controller, 10000, 100, { paused: true }), []);
  assert.equal(controller.observe(10000), null);
  assert.deepEqual(feed(controller, 50, 40), []);
  assert.deepEqual(feed(controller, 50, 29), []);
  assert.equal(controller.observe(50).pixelRatio, 0.7);
});

test("resuming restarts warmup as well as discarding pre-pause confidence", () => {
  const controller = create();
  assert.deepEqual(feed(controller, 50, 45), []);
  assert.equal(controller.observe(10000, { hidden: true }), null);
  assert.equal(controller.observe(10000), null);
  assert.deepEqual(feed(controller, 50, 45), []);
  assert.deepEqual(feed(controller, 50, 14), []);
  assert.equal(controller.observe(50).pixelRatio, 0.75);
});

test("resize and quality resets discard old evidence and immediately honor new caps", () => {
  const controller = create();
  assert.deepEqual(feed(controller, 50, 45), []);
  assert.equal(controller.reset({ width: 1920, height: 1200 }), null);
  assert.deepEqual(feed(controller, 50, 45), []);
  assert.equal(feed(controller, 50, 15).at(-1).pixelRatio, 0.75);
  assert.deepEqual(controller.reset({ maxRatio: 0.6 }), {
    pixelRatio: 0.6,
    previousRatio: 0.75,
    reason: "reset",
    averageFrameMs: null,
  });
  assert.equal(controller.maxRatio, 0.6);
  assert.equal(
    controller.reset({ maxRatio: 1.25, pixelRatio: 1.25 }).pixelRatio,
    1.25
  );
  assert.equal(controller.maxRatio, 1.25);
  assert.deepEqual(feed(controller, 50, 45), []);
});

test("safe drawing-buffer dimensions override the preferred floor for very large viewports", () => {
  for (const [width, height] of [
    [10001, 4501],
    [4501, 10001],
  ]) {
    const controller = create({
      width,
      height,
      maxRatio: 1.25,
      maxDimension: 2048,
    });
    assert.equal(controller.pixelRatio, 2048 / 10001);
    assert.equal(controller.minRatio, controller.maxRatio);
    assert.ok(controller.pixelRatio < 0.5);
    for (const dimension of [width, height]) {
      const pixels = Math.floor(dimension * controller.pixelRatio);
      assert.ok(pixels >= 1 && pixels <= 2048);
    }
    assert.deepEqual(feed(controller, 200, 200), []);
    const resized = controller.reset({ width: 1000, height: 500 });
    assert.equal(resized.pixelRatio, 0.5);
    assert.equal(controller.maxRatio, 1.25);
  }
});

test("tiny buffers stay nonzero and impossible viewport/cap combinations are rejected", () => {
  const controller = create({
    width: 2,
    height: 2,
    minRatio: 0.1,
    pixelRatio: 0.1,
  });
  assert.equal(controller.minRatio, 0.5);
  assert.equal(controller.pixelRatio, 0.5);
  assert.throws(() => create({ width: 1, height: 1 }));
  assert.throws(() => create({ width: 1e9, height: 1 }));
  assert.throws(() => create({ maxRatio: Number.MIN_VALUE }));
});

test("invalid numeric configuration cannot leak NaN, infinity, or unsafe dimensions", () => {
  for (const key of [
    ...Object.keys(RENDER_SCALE_DEFAULTS),
    "pixelRatio",
    "width",
    "height",
  ]) {
    for (const value of [NaN, Infinity, -Infinity, null, "1"])
      assert.throws(() => create({ [key]: value }), RangeError);
  }
  for (const options of [
    { minRatio: 0 },
    { maxRatio: -1 },
    { pixelRatio: 0 },
    { maxRatio: 5 },
    { targetFrameMs: 0 },
    { step: 0 },
    { step: 1 },
    { warmupMs: -1 },
    { cooldownMs: -1 },
    { windowMs: 0 },
    { width: 0 },
    { height: -1 },
    { width: Number.MAX_VALUE },
    { maxDimension: 0 },
    { maxDimension: 4096.5 },
    { maxDimension: 32768 },
  ])
    assert.throws(() => create(options), RangeError);
  for (const options of [undefined, null, [], "low"])
    assert.throws(() => new RenderScaleController(options), TypeError);
});

test("invalid reset is atomic, preserving bounds, ratio, and accumulated evidence", () => {
  const controller = create({ warmupMs: 0 });
  const unchanged = create({ warmupMs: 0 });
  feed(controller, 50, 15);
  feed(unchanged, 50, 15);
  assert.throws(() => controller.reset({ width: NaN, pixelRatio: 0.5 }));
  assert.throws(() => controller.reset({ maxRatio: Infinity }));
  assert.throws(() => controller.reset(null));
  assert.equal(controller.minRatio, unchanged.minRatio);
  assert.equal(controller.maxRatio, unchanged.maxRatio);
  assert.equal(controller.pixelRatio, unchanged.pixelRatio);
  assert.deepEqual(feed(controller, 50, 15), feed(unchanged, 50, 15));
});

test("invalid frame intervals are ignored without advancing learning or poisoning state", () => {
  const controller = create({ warmupMs: 0 });
  const unchanged = create({ warmupMs: 0 });
  feed(controller, 50, 15);
  feed(unchanged, 50, 15);
  for (const interval of [
    NaN,
    Infinity,
    -Infinity,
    0,
    -0,
    -1,
    undefined,
    null,
    "33",
    false,
    {},
    [],
    1n,
    Symbol("frame"),
  ])
    assert.equal(controller.observe(interval), null);
  assert.equal(controller.pixelRatio, unchanged.pixelRatio);
  assert.deepEqual(feed(controller, 50, 15), feed(unchanged, 50, 15));
});

test("mixed valid intervals keep every recommendation finite, bounded, and incremental", () => {
  const controller = create({ warmupMs: 0, pixelRatio: 0.7, step: 0.03 });
  const intervals = [16, 22, 34, 125, 1000, Number.MAX_VALUE, 0.001];
  for (let frame = 0; frame < 10000; frame++) {
    const change = controller.observe(intervals[frame % intervals.length]);
    assert.ok(Number.isFinite(controller.pixelRatio));
    assert.ok(controller.pixelRatio >= controller.minRatio);
    assert.ok(controller.pixelRatio <= controller.maxRatio);
    if (change) {
      assert.ok(Number.isFinite(change.averageFrameMs));
      assert.ok(
        Math.abs(change.pixelRatio - change.previousRatio) <= 0.03 + 1e-12
      );
    }
  }
});
