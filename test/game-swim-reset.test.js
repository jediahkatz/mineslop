import assert from "node:assert/strict";
import test from "node:test";
import { VoxelGame } from "../src/game.js";

test("swim reset tolerates absent or partial presentation transports", () => {
  for (const playerVisual of [undefined, null, {}]) {
    for (const effects of [undefined, null, {}, { sound() {} }]) {
      const game = Object.assign(Object.create(VoxelGame.prototype), {
        playerVisual, effects, elapsed: 42,
        swimPresentation: { swimming: true, moving: true, fluidKnown: true },
      });
      assert.doesNotThrow(() => game.resetSwimmingPresentation());
      assert.equal(game.swimPresentation.swimming, false);
      assert.equal(game.swimPresentation.moving, false);
      assert.equal(game.swimPresentation.fluidKnown, false);
    }
  }
});

test("swim reset still resets each available transport exactly once with its receiver", () => {
  const calls = [];
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    elapsed: 42,
    playerVisual: { update(...args) { calls.push(["player", this, args]); } },
    effects: { update(...args) { calls.push(["hands", this, args]); } },
  });
  game.resetSwimmingPresentation();
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], game.playerVisual);
  assert.deepEqual(calls[0][2], [0, { perspective: "first" }]);
  assert.equal(calls[1][1], game.effects);
  assert.deepEqual(calls[1][2], [0, 42, false, false, null, game.swimPresentation]);
});

test("an existing presentation method's error is not silently treated as absence", () => {
  const failure = new Error("render failure");
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    effects: { update() { throw failure; } },
  });
  assert.throws(() => game.resetSwimmingPresentation(), (error) => error === failure);
});
