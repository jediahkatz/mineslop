import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { Effects } from "../src/effects.js";
import { VoxelGame } from "../src/game.js";
import { audioFixture } from "./audio-fixture.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { shapeWorld } from "./shape-fixture.js";

async function fixture(t) {
  const f = controlFixture(t);
  let loaded = true;
  const cells = [];
  for (let x = -3; x <= 3; x++)
    for (let z = -8; z <= 8; z++) {
      cells.push([x, 0, z, BLOCK.STONE]);
      if (z < 0) cells.push([x, 1, z, BLOCK.WATER]);
    }
  const world = shapeWorld(cells, { loaded: () => loaded });
  world.getSpawn = () => ({ x: 0.5, y: 1, z: 2.5 });
  f.player.world = world;
  f.player.allowFlight = false;
  f.player.setPosition(world.getSpawn());
  const { audio, context } = audioFixture();
  await audio.unlock();
  t.after(() => audio.dispose());
  const effects = Object.assign(Object.create(Effects.prototype), {
    audioEngine: audio, camera: f.camera,
    audioListener: { position: new THREE.Vector3(), right: new THREE.Vector3() },
  });
  effects.soundEnabled = true;
  const heard = [];
  effects.sound = (...args) => {
    const played = Effects.prototype.sound.apply(effects, args);
    if (played) heard.push(args);
    return played;
  };
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    player: f.player, effects, audioEngine: audio,
  });
  game.bindPlayerAudio();
  const key = (code, down) => dispatch(f.document, down ? "keydown" : "keyup", {
    code, target: f.element,
  });
  const step = (seconds) => {
    for (let i = 0; i < Math.ceil(seconds * 120); i++) {
      context.advance(1 / 120);
      f.player.update(1 / 120);
    }
  };
  return { ...f, world, game, audio, context, heard, key, step,
    load: (value) => { loaded = value; },
    splashes: () => heard.filter(([kind]) => kind.startsWith("water-")).map(([kind]) => kind),
  };
}

test("actual Player collision samples route entry, jump-out and landing through Game to shared mixer", async (t) => {
  const f = await fixture(t);
  f.step(0.1);
  f.key("KeyW", true);
  f.step(1);
  f.key("KeyW", false);
  assert.deepEqual(f.splashes(), ["water-entry"]);
  assert.ok(f.player.fluidState.waterImmersion > 0);
  assert.ok(f.heard.some(([kind, id]) => kind === "step" && id === BLOCK.STONE));
  const waterBuffers = f.audio.buffers.size;
  f.step(0.5);
  assert.deepEqual(f.splashes(), ["water-entry"], "remaining immersed is silent");
  f.key("Space", true);
  f.step(0.8);
  f.key("Space", false);
  assert.ok(f.splashes().includes("water-jump"));
  f.step(1);
  assert.deepEqual(f.splashes(), ["water-entry", "water-jump", "water-entry"]);
  assert.ok(f.audio.buffers.size <= waterBuffers + 3, "splash variants share canonical PCM");
});

test("teleport/restore, mounted handoff and unloaded-to-loaded water do not synthesize an entry", async (t) => {
  const f = await fixture(t);
  f.step(0.1);
  f.player.setPosition({ x: 0.5, y: 1, z: -2.5 });
  f.step(0.3);
  assert.deepEqual(f.splashes(), []);
  f.player.setPosition({ x: 0.5, y: 1, z: 2.5 });
  f.step(0.1);
  f.player.update(0, { riderPose: {
    id: "audio-boat", vehicleType: "boat", position: { x: 0.5, y: 1, z: -2.5 },
    velocity: { x: 0, y: 0, z: 0 }, grounded: false, hullYaw: 0,
  } });
  assert.deepEqual(f.splashes(), []);
  f.player.setPosition({ x: 0.5, y: 1, z: -2.5 });
  f.load(false);
  f.step(0.2);
  assert.equal(f.player.fluidMovementBlocked, true);
  f.load(true);
  f.step(0.2);
  assert.equal(f.player.fluidMovementBlocked, false);
  assert.deepEqual(f.splashes(), []);
});

test("throwing audio observers are disabled once without interrupting motion", async (t) => {
  const f = await fixture(t);
  let waters = 0, steps = 0;
  f.player.onWaterSample = () => { waters++; throw Error("audio observer"); };
  f.player.onStep = () => { steps++; throw Error("step observer"); };
  f.key("KeyW", true);
  const initialZ = f.player.position.z;
  assert.doesNotThrow(() => f.step(1));
  assert.ok(f.player.position.z < initialZ - 2);
  assert.equal(waters, 1);
  assert.equal(steps, 1);
  assert.equal(f.player.onWaterSample, null);
  assert.equal(f.player.onStep, null);
  assert.ok(Number.isFinite(f.camera.position.y));
});

test("old Game audio callbacks cannot route events into a replacement world", async (t) => {
  const f = await fixture(t);
  const staleStep = f.player.onStep;
  const staleWater = f.player.onWaterSample;
  staleWater({ valid: true, waterImmersion: 0 });
  f.game.player = {};
  assert.equal(staleStep(BLOCK.STONE), false);
  assert.equal(staleWater({ valid: true, waterImmersion: 0.5 }), false);
  assert.equal(f.context.sources.length, 0);
});
