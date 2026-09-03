import assert from "node:assert/strict";
import test from "node:test";
import { fluidLifecycleHost } from "./game-fluid-lifecycle-fixture.js";

test("the real frame host samples completed draws using raw time, not capped physics dt", (t) => {
  const f = fluidLifecycleHost(t);
  for (let i = 0; i < 11; i++) f.frame(50);
  assert.equal(f.calls.draws, 11);
  assert.equal(f.game.fps, 20);
  assert.equal(f.game.frameRate.frameMs, 50);
  const elapsed = f.game.elapsed;
  f.frame(1000);
  assert.equal(f.calls.draws, 12);
  assert.equal(f.game.fps, 1);
  assert.equal(f.game.frameRate.frameMs, 1000);
  assert.ok(Math.abs(f.game.elapsed - elapsed - 0.1) < 1e-8);
});

test("skipped hidden/loading frames clear old FPS and the returning interval is excluded", (t) => {
  const f = fluidLifecycleHost(t);
  for (let i = 0; i < 11; i++) f.frame(50);
  assert.equal(f.game.fps, 20);
  const draws = f.calls.draws;
  f.shell.document.hidden = true;
  f.frame(1000);
  assert.equal(f.calls.draws, draws);
  assert.equal(f.game.fps, null);
  f.shell.document.hidden = false;
  f.frame(1000);
  assert.equal(f.game.fps, null);
  for (let i = 0; i < 10; i++) f.frame(50);
  assert.equal(f.game.fps, 20);
  f.game.building = true;
  f.frame(1000);
  assert.equal(f.game.fps, null);
  assert.equal(f.game.frameRate.fps, null);
  f.game.building = false;
});
