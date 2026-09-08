import assert from "node:assert/strict";
import test from "node:test";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";

function fixture(t, message) {
  const raf = globalThis.requestAnimationFrame, window = globalThis.window;
  globalThis.requestAnimationFrame = callback => queueMicrotask(callback);
  globalThis.window = { confirm: () => true };
  t.after(() => {
    if (raf) globalThis.requestAnimationFrame = raf; else delete globalThis.requestAnimationFrame;
    if (window) globalThis.window = window; else delete globalThis.window;
  });
  const events = [];
  const source = { seed: "source", dispose: () => assert.fail("retired source") };
  const graphics = { dispose: () => assert.fail("retired source GPU") };
  const staged = {
    world: {}, pose: {}, quality: "medium",
    weatherServices: { dispose: () => events.push("weather") },
    dispose() {
      events.push("all-staged-owners");
      this.weatherServices.dispose();
      this.world._disposed = true;
    },
  };
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    world: source, graphics, started: true, gameplay: {},
    closeScreens: async () => true,
    resetActions() {}, resetSwimmingPresentation() {}, resetFrameRate() {}, refreshHud() {},
    ui: {
      setLoading: () => events.push("loading"), ready: () => events.push("ready"),
      showMenu: value => events.push(value), toast: value => events.push(value),
    },
    prepareWorld: async () => staged,
    prepareGraphics: () => ({
      prepareArrival: async () => { throw new Error(message); },
      dispose: () => events.push("candidate-GPU"),
    }),
    activatePreparedWorld: () => assert.fail("activated a rejected candidate"),
    snapshotPreparedNewWorld: () => ({}),
    storage: { replace: () => assert.fail("published rejected candidate storage") },
  });
  return { game, source, graphics, staged, events };
}

for (const message of ["Arrival GPU context is unavailable", "Arrival mesh budget refused"]) {
  test(`import rolls back all staged owners after ${message}`, async t => {
    const f = fixture(t, message);
    const archive = new GameArchive(f.game, {});
    let checkpoints = 0;
    archive.save = async () => {
      assert.equal(f.game.world, f.source, "only the original archive may be checkpointed");
      checkpoints++;
      return { ok: true };
    };
    const text = JSON.stringify({ version: 2, world: {
      version: 2, generatorVersion: 2, dimension: "overworld", seed: "imported", edits: [],
    } });
    const result = await archive.importFile({ size: text.length, text: async () => text });
    assert.equal(result.ok, false);
    assert.match(result.message, /Arrival/);
    assert.equal(checkpoints, 1);
    assert.equal(f.game.world, f.source);
    assert.equal(f.game.graphics, f.graphics);
    assert.equal(f.game.building, false);
    assert.equal(f.game.failed, undefined);
    assert.deepEqual(f.events.slice(0, 6), ["loading", "candidate-GPU", "all-staged-owners", "weather", "ready", "pause"]);
    assert.equal(f.staged.world._disposed, true);
    t.diagnostic(JSON.stringify({ result, building: f.game.building, checkpoints, events: f.events }));
  });
}

test("persisted initialization arrival rejection retains the durable source without entering CAS", async t => {
  const f = fixture(t, "Arrival GPU context is unavailable");
  await assert.rejects(f.game.initialize("candidate", null, { persistNewWorld: true, generatorVersion: 3 }), /Arrival/);
  assert.equal(f.game.world, f.source);
  assert.equal(f.game.graphics, f.graphics);
  assert.equal(f.game.building, false);
  assert.equal(f.events.filter(e => e === "all-staged-owners").length, 1);
});
