import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { gravityGame } from "./gravity-game-runtime.fixture.mjs";
import { installRealRendererState } from "./gravity-renderer-state.fixture.mjs";
import { sampleGroundCoverage } from "./realtime/ground-coverage.js";

test("same-frame falling roof edits reach real daylight textures and rebuilt mesh geometry", async (t) => {
  const f = await gravityGame(t), { game } = f;
  const state = installRealRendererState(f), { graphics } = state;
  f.put(3, 68, 3, BLOCK.SAND);
  state.warm();
  assert.equal(state.roofTextureAt(3, 3), 69);
  assert.equal(state.groundHits(3.3, 3.3)[0].point.y, 69);
  f.frame();
  assert.equal(game.world.get(3, 67, 3), BLOCK.SAND);
  assert.equal(state.groundHits(3.3, 3.3)[0].point.y, 68,
    "actual indexed detail already contains the falling block's new position");
  assert.equal(state.roofTextureAt(3, 3), 68,
    "the daylight DataTexture must use the same World revision as this mesh");
  assert.equal(state.roofTextureAt(3, 3, state.drawState.field), 68,
    "the texture is current at draw submission, not repaired after rendering");
  assert.equal(graphics.skyColumns.texture.image.data, graphics.skyColumns.data);
  assert.equal(state.submissions, 1);
});

test("same-frame rebuilt chunk takes LOD ownership with real indexed coverage, not a stale cutout", async (t) => {
  const f = await gravityGame(t), { game } = f;
  const state = installRealRendererState(f), { graphics } = state;
  f.put(3, 68, 3, BLOCK.SAND);
  state.warm();
  graphics.removeChunk("0,0");
  graphics.update(0, game.elapsed, game.player.position);
  assert.equal(graphics.detailCoverage().has("0,0"), false);
  assert.ok(state.groundHits(8.31, 8.31, true).length,
    "missing detail really has indexed fallback geometry before this frame");
  const geometry = graphics.distant._active.terrain.geometry;
  const indexVersion = geometry.index.version;
  const budgets = [];
  const rebuild = graphics.rebuildDirty;
  t.mock.method(graphics, "rebuildDirty", function (budget) {
    budgets.push(budget);
    return Reflect.apply(rebuild, this, [budget]);
  });
  f.frame();
  assert.equal(game.world.get(3, 67, 3), BLOCK.SAND);
  assert.deepEqual(budgets, [1], "one normal budget, no post-update repair rebuild");
  assert.equal(graphics.detailCoverage().has("0,0"), true);
  assert.ok(state.groundHits(8.31, 8.31).length);
  assert.equal(state.groundHits(8.31, 8.31, true).length, 0,
    "new drawn detail must cut away its indexed LOD fallback in the SAME frame");
  assert.ok(geometry.index.version > indexVersion);
  assert.equal(graphics.distant._active.viewKey,
    [...graphics.detailCoverage()].sort().join(";"));
  assert.equal(state.drawState.cutoutKey, state.drawState.coverageKey);
  const coverage = sampleGroundCoverage(game);
  assert.ok(coverage.expected > 0);
  assert.equal(coverage.missing, 0);
});

test("late real dismount refreshes visibility and fills a newly hidden row before drawing", async (t) => {
  const f = await gravityGame(t), { game } = f;
  const state = installRealRendererState(f), { graphics } = state;
  game.world._generateSync(-2, 0);
  game.player.setPosition({ x: 12.5, y: 65, z: 11.5 });
  assert.equal(game.gameplay.inventoryTransaction((draft) => {
    draft.slots[game.gameplay.selected] = null;
    return true;
  }), true);
  const horse = game.wildlife.spawn("horse", { x: 15.5, y: 65, z: 8.5 }, { id: "horse:exit" });
  assert.ok(horse);
  const mounted = game.horses.mount(horse.id);
  assert.equal(mounted.ok, true, mounted.reason);
  assert.equal(game.applyVehiclePose(), true);
  assert.equal(Math.floor(graphics.camera.position.x / 16), 0);
  const planned = game.horses.prepareDismount();
  assert.equal(planned.ok, true, planned.reason);
  assert.equal(Math.floor(planned.exit.position.x / 16), 1);
  state.warm();
  assert.equal(graphics.chunks.get("-2,0").visible, true);
  assert.equal(state.groundHits(-23.69, 8.31, true).length, 0);
  let observedAI = false;
  const update = game.wildlife.update;
  t.mock.method(game.wildlife, "update", function (...args) {
    // Camera direction is sampled directly before Wildlife, independently of
    // the renderer's later lighting/fog/coverage update.
    const view = args[3];
    const forward = graphics.camera.getWorldDirection(new THREE.Vector3());
    assert.deepEqual(view.renderForward.toArray(), forward.toArray());
    assert.deepEqual(view.playerForward.toArray(), game.player.forward.toArray());
    assert.equal(view.timeOfDay, game.currentTime);
    observedAI = true;
    const result = Reflect.apply(update, this, args);
    const exited = game.horses.dismount();
    assert.equal(exited.ok, true, exited.reason);
    return result;
  });
  const rebuild = graphics.rebuildDirty, budgets = [];
  t.mock.method(graphics, "rebuildDirty", function (budget) {
    budgets.push(budget);
    return Reflect.apply(rebuild, this, [budget]);
  });
  f.frame();
  assert.equal(observedAI, true);
  assert.equal(game.player.seated, false);
  assert.equal(Math.floor(graphics.camera.position.x / 16), 1);
  assert.equal(graphics.chunks.get("-2,0").visible, false);
  assert.equal(graphics.detailCoverage().has("-2,0"), false);
  assert.ok(state.groundHits(-23.69, 8.31, true).length,
    "a row hidden by the late exit must regain real LOD triangles before draw");
  assert.equal(graphics.distant._active.viewKey,
    [...graphics.detailCoverage()].sort().join(";"));
  assert.equal(state.drawState.cutoutKey, state.drawState.coverageKey);
  assert.deepEqual(budgets, [1]);
  assert.equal(state.submissions, 1);
  assert.ok(Math.abs(graphics.timeOfDay - game.currentTime) < 1e-12,
    "the moved zero-dt renderer update does not advance the authoritative clock twice");
  assert.equal(sampleGroundCoverage(game).missing, 0);
});
