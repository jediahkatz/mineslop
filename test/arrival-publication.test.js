import assert from "node:assert/strict";
import test from "node:test";
import { VoxelGame } from "../src/game.js";

function frames(t) {
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => queueMicrotask(callback);
  t.after(() => {
    if (previous) globalThis.requestAnimationFrame = previous;
    else delete globalThis.requestAnimationFrame;
  });
}

test("near mesh preparation finishes before storage publication and live activation", async t => {
  frames(t);
  const order = [], source = {}, pose = {};
  const candidate = { prepareArrival: async (received, validate) => {
    assert.equal(received, pose);
    order.push("prepare");
    await Promise.resolve();
    validate();
    order.push("prepared");
  }, dispose: () => order.push("dispose") };
  const game = {
    graphics: source, prepareGraphics: () => candidate,
    activatePreparedWorld() { order.push("activate"); this.graphics = candidate; },
    ui: { ready() {}, showMenu() {} }, refreshHud() {},
  };
  await VoxelGame.prototype.installPreparedWorld.call(game, { world: {}, quality: "medium", pose },
    null, () => {}, async activate => {
      assert.deepEqual(order, ["prepare", "prepared"]);
      assert.equal(game.graphics, source);
      order.push("publish");
      activate();
    });
  assert.deepEqual(order, ["prepare", "prepared", "publish", "activate"]);
});

test("near mesh rejection cannot publish storage or retire the live renderer", async t => {
  frames(t);
  const source = {}, order = [];
  const game = {
    graphics: source, prepareGraphics: () => ({
      prepareArrival: async () => { throw new Error("arrival budget"); },
      dispose: () => order.push("dispose"),
    }),
    activatePreparedWorld: () => assert.fail("activated"),
  };
  await assert.rejects(VoxelGame.prototype.installPreparedWorld.call(game, { world: {}, quality: "medium", pose: {} },
    null, () => {}, () => assert.fail("published")), /arrival budget/);
  assert.equal(game.graphics, source);
  assert.deepEqual(order, ["dispose"]);
});
