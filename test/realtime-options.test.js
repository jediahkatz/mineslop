import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "./realtime/config.mjs";

test("real-time runs record explicit viewport and resolution experiments", () => {
  const config = readConfig(
    ["--width", "1920", "--height", "1080", "--pixel-ratio", "0.6"],
    {}
  );
  assert.deepEqual(config.viewport, { width: 1920, height: 1080 });
  assert.equal(config.pixelRatioOverride, 0.6);
  assert.equal(new URL(config.url).searchParams.get("pixelRatio"), "0.6");
});

test("invalid render sizes and ratios cannot start misleading benchmarks", () => {
  for (const args of [
    ["--width", "0"],
    ["--height", "-1"],
    ["--pixel-ratio", "NaN"],
    ["--pixel-ratio", "0.1"],
  ])
    assert.throws(() => readConfig(args, {}));
});
