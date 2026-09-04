import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { ITEM, ITEMS } from "../src/items.js";
import { Effects } from "../src/effects.js";
import { PlayerVisual } from "../src/player-visual.js";
import {
  createHeldItemView, disposeHeldItemView, selectHeldItem,
} from "../src/held-item.js";
import { fluidLifecycleHost } from "./game-fluid-lifecycle-fixture.js";
import { dispatch } from "./control-fixture.js";
import { playerSnapshot, seatPose } from "./mounted-player-fixture.js";

function fixture(t) {
  const cells = [];
  for (let x = 7; x <= 10; x++)
    for (let z = 7; z <= 10; z++)
      for (let y = 1; y <= 4; y++) cells.push([x, y, z, BLOCK.WATER]);
  const f = fluidLifecycleHost(t, { cells, position: { x: 8.5, y: 2, z: 8.5 } });
  const { game, player, gameplay } = f;
  const texture = new THREE.Texture();
  const atlas = { texture, uvFor: () => [0, 0, 1, 1] };
  const textures = new Map(ITEMS.map((item) => [item.id, texture]));
  const main = createHeldItemView(player.camera, atlas, textures);
  const offhand = createHeldItemView(player.camera, atlas, textures, true);
  gameplay.add(ITEM.SHIELD);
  gameplay.select(gameplay.hotbar.indexOf(ITEM.SHIELD));
  gameplay.swapHands();
  gameplay.add(ITEM.BOW);
  gameplay.select(gameplay.hotbar.indexOf(ITEM.BOW));
  assert.equal(gameplay.getHandStack("main").id, ITEM.BOW);
  assert.equal(gameplay.getHandStack("offhand").id, ITEM.SHIELD);
  selectHeldItem(main, ITEM.BOW);
  selectHeldItem(offhand, ITEM.SHIELD);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1
  );
  // DOM texture creation/GPU submission are the only Effects transports omitted.
  // Both retained real hand views and the actual Effects.update implementation run.
  game.effects = Object.assign(Object.create(Effects.prototype), main, {
    offhand, mesh, particles: [], arrows: [], scene: game.graphics.scene,
    motionPreference: { matches: false },
  });
  const visual = (game.playerVisual = new PlayerVisual(game.graphics.scene));
  t.after(() => {
    visual.dispose();
    disposeHeldItemView(main);
    disposeHeldItemView(offhand);
    mesh.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
    texture.dispose();
  });
  const events = [];
  const physical = () => ({
    player: playerSnapshot(player),
    inventory: gameplay.serialize(),
    queries: player.fluidDiagnostics(),
    fluid: structuredClone(player.fluidState),
  });
  for (const [owner, name, label, readonly] of [
    [player, "update", "physics", false],
    [player, "gameplayEnvironment", "environment", false],
    [game, "swimmingObservation", "observation", true],
    [visual, "update", "visual", true],
    [game.effects, "update", "effects", true],
  ]) {
    const original = owner[name];
    t.mock.method(owner, name, function (...args) {
      const before = readonly ? physical() : null;
      const result = Reflect.apply(original, this, args);
      if (readonly) assert.deepEqual(physical(), before, `${label} cannot alter gameplay or query fluids`);
      events.push({
        label, args, state: structuredClone(label === "observation" ? result :
          label === "visual" ? args[1] : label === "effects" ? args[5] : null),
      });
      return result;
    });
  }
  return Object.assign(f, {
    main: game.effects, offhand, visual, events,
    key(code, down = true) {
      dispatch(f.shell.document, down ? "keydown" : "keyup", { code, target: player.element });
    },
    warm() { for (let i = 0; i < 8; i++) f.frame(50); },
    last(label) { return events.findLast((event) => event.label === label); },
  });
}

test("real Game.frame forwards cached accepted movement after physics to both real render paths", (t) => {
  const f = fixture(t);
  f.key("KeyW");
  f.frame();
  assert.equal(f.player.swimming, true);
  assert.equal(f.game.swimPresentation.moving, true);
  assert.equal(f.last("effects").args[5], f.game.swimPresentation);
  assert.ok(f.main.motion.swim.weight.value > 0);
  assert.equal(f.offhand.motion.swim.weight.value, f.main.motion.swim.weight.value);
  const labels = f.events.map(({ label }) => label);
  assert.ok(labels.indexOf("physics") < labels.indexOf("environment"));
  assert.ok(labels.indexOf("environment") < labels.indexOf("observation"));
  assert.ok(labels.indexOf("observation") < labels.indexOf("effects"));
  const observation = f.game.swimPresentation;
  f.key("KeyW", false);
  f.player.perspective = "back";
  f.warm();
  assert.equal(f.game.swimPresentation, observation, "one reused Game payload");
  assert.equal(f.last("visual").state.swimming, true);
  assert.ok(f.visual.rig.swim.weight.value > 0.9);
  assert.equal(f.main.motion.swim.weight.value, 0, "F5 hides/resets the first-person channels");
  assert.equal(f.visual.rig.gait, 0);
  const batch = f.visual.mesh;
  f.player.perspective = "front";
  f.frame();
  assert.equal(f.visual.mesh, batch, "front/back retain the batch");
  f.player.perspective = "first";
  f.frame();
  assert.equal(f.visual.visible, false);
  assert.equal(f.visual.rig.swim.weight.value, 0);
  assert.ok(f.main.motion.swim.weight.value > 0 && f.main.motion.swim.weight.value < 0.2);
});

test("real Game.frame resets pause, inventory overlay, hidden tab, loading and failure transitions", (t) => {
  const f = fixture(t);
  for (const [owner, key] of [
    [f.game, "paused"], [f.game, "overlayOpen"], [f.shell.document, "hidden"],
    [f.game, "building"], [f.game, "failed"],
  ]) {
    f.player.perspective = "back";
    f.warm();
    assert.ok(f.visual.rig.swim.weight.value > 0.9);
    owner[key] = true;
    const physical = playerSnapshot(f.player), queries = f.player.fluidDiagnostics();
    f.frame();
    assert.equal(f.visual.rig.swim.weight.value, 0, key);
    assert.equal(f.main.motion.swim.weight.value, 0, key);
    assert.equal(f.game.swimPresentation.swimming, false, key);
    assert.equal(f.game.swimPresentation.fluidKnown, false, key);
    if (key !== "overlayOpen") {
      assert.deepEqual(playerSnapshot(f.player), physical);
      assert.deepEqual(f.player.fluidDiagnostics(), queries);
    }
    owner[key] = false;
    f.frame();
    assert.ok(f.visual.rig.swim.weight.value > 0 && f.visual.rig.swim.weight.value < 0.2);
  }
  f.player.perspective = "first";
  f.warm();
  f.game.ui.isHudVisible = false;
  f.frame();
  assert.equal(f.main.hand.visible, false);
  assert.equal(f.main.motion.swim.weight.value, 0);
  f.game.ui.isHudVisible = true;
  f.frame();
  assert.ok(f.main.motion.swim.weight.value < 0.2);
});

test("real Game.frame prioritizes grounded wading, flight, seats, attached ladders and unloaded frontiers", (t) => {
  const f = fixture(t);
  f.player.perspective = "back";
  for (const [name, prepare] of [
    ["grounded", () => {
      f.mutate([[3, 1, 3, { id: BLOCK.OAK_SLAB, fluid: FLUID.WATER_SOURCE }]]);
      f.player.setPosition({ x: 3.5, y: 1.5, z: 3.5 });
    }],
    ["flying", () => { f.player.allowFlight = true; f.player.flying = true; }],
    ["seated", () => {
      f.player.update(0, { riderPose: seatPose({ position: { x: 8.5, y: 2, z: 8.5 } }) });
    }],
    ["climbing", () => {
      const cells = [];
      for (let y = 1; y <= 4; y++)
        cells.push(
          [4, y, 4, { id: BLOCK.LADDER, fluid: FLUID.WATER_SOURCE }],
          [4, y, 5, BLOCK.STONE]
        );
      f.mutate(cells);
      f.player.setPosition({ x: 4.5, y: 2, z: 4.7 });
    }],
    ["unknown", () => {
      f.player.setPosition({ x: 15.8, y: 2, z: 8.5 });
    }],
  ]) {
    f.warm();
    assert.ok(f.visual.rig.swim.weight.value > 0.9, name);
    prepare();
    f.frame();
    assert.equal(f.game.swimPresentation.swimming, false, name);
    if (name === "grounded") {
      assert.equal(f.player.grounded, true);
      assert.ok(f.player.fluidState.waterImmersion > 0);
    }
    if (name === "climbing") assert.equal(f.player.climbing, true);
    if (name === "unknown") assert.equal(f.player.fluidMovementBlocked, true);
    if (name !== "grounded") assert.equal(f.visual.rig.swim.weight.value, 0, name);
    f.player.flying = false;
    f.player.setPosition({ x: 8.5, y: 2, z: 8.5 });
  }
  f.warm();
  f.gameplay.damage(1000, "swim-test");
  f.frame();
  assert.equal(f.game.swimPresentation.dead, true);
  assert.equal(f.game.swimPresentation.swimming, false);
  assert.equal(f.visual.rig.swim.weight.value, 0);
});

test("real Game.frame follows the live reduced-motion preference without changing owned inventory", (t) => {
  const f = fixture(t);
  f.warm();
  const pose = f.main.hand.position.toArray();
  f.main.motionPreference.matches = true;
  f.frame();
  assert.equal(f.game.swimPresentation.bob, false);
  assert.notDeepEqual(f.main.hand.position.toArray(), pose);
  assert.equal(f.main.motion.bob, false);
  assert.equal(f.offhand.motion.bob, false);
  f.main.motionPreference.matches = false;
  f.frame();
  assert.equal(f.game.swimPresentation.bob, true);
});

test("real pause and overlay transitions discard swimming even when no further RAF runs", async (t) => {
  const f = fixture(t);
  t.mock.method(f.game, "save", async () => true);
  f.warm();
  assert.ok(f.main.motion.swim.weight.value > 0.9);
  const paused = f.game.pause();
  assert.equal(f.main.motion.swim.weight.value, 0, "reset before the first await");
  assert.equal(f.offhand.motion.swim.weight.value, 0);
  assert.equal(f.game.swimPresentation.swimming, false);
  await paused;
  f.game.paused = false;
  f.player.enabled = true;
  f.player.perspective = "back";
  f.warm();
  assert.ok(f.visual.rig.swim.weight.value > 0.9);
  f.game.overlayChanged(true);
  assert.equal(f.visual.visible, false);
  assert.equal(f.visual.rig.swim.weight.value, 0);
  assert.equal(f.game.swimPresentation.swimming, false);
});

test("real initialize resets old swim owners before staging a replacement world", async (t) => {
  const f = fixture(t);
  f.player.perspective = "back";
  f.warm();
  const state = f.game.swimPresentation;
  assert.ok(f.visual.rig.swim.weight.value > 0.9);
  // Exercise actual initialize up to its asynchronous staging boundary. The
  // separate audio lifecycle regression exercises successful owner replacement.
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { queueMicrotask(callback); return 1; };
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  f.game.prepareWorld = async () => { throw new Error("staging boundary"); };
  await assert.rejects(f.game.initialize("replacement"), /staging boundary/);
  assert.equal(f.visual.visible, false);
  assert.equal(f.visual.rig.swim.weight.value, 0);
  assert.equal(f.main.motion.swim.weight.value, 0);
  assert.equal(state.swimming, false);
  assert.equal(state.fluidKnown, false);
});
