import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { Effects } from "../src/effects.js";
import { VoxelGame } from "../src/game.js";
import { audioFixture } from "./audio-fixture.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { shapeWorld } from "./shape-fixture.js";

/** Real controller/host/mixer, with authored terrain and WebAudio transport only. */
export async function waterControllerFixture(t, { depth = 1, frame = 1 / 120 } = {}) {
  const f = controlFixture(t);
  let loaded = true;
  const cells = [];
  for (let x = -4; x <= 4; x++)
    for (let z = -80; z <= 8; z++) {
      cells.push([x, 0, z, BLOCK.STONE]);
      if (z < 0)
        for (let y = 1; y <= depth; y++) cells.push([x, y, z, BLOCK.WATER]);
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
  const events = [], crossings = [];
  effects.sound = (...args) => {
    const accepted = Effects.prototype.sound.apply(effects, args);
    if (args[0].startsWith("water-"))
      events.push({ kind: args[0], accepted, at: context.currentTime,
        y: f.player.position.y, vy: f.player.velocity.y });
    return accepted;
  };
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    player: f.player, effects, audioEngine: audio, started: true,
    paused: false, building: false, gameplay: { dead: false }, failed: false,
  });
  game.bindPlayerAudio();
  const observe = f.player.onWaterSample;
  let wet;
  f.player.onWaterSample = (sample, state) => {
    const next = sample.waterImmersion > 0;
    if (wet !== next) crossings.push({ wet: next, y: f.player.position.y,
      vy: f.player.velocity.y, at: context.currentTime, reset: state.reset });
    wet = next;
    return observe(sample, state);
  };
  const key = (code, down) => dispatch(f.document, down ? "keydown" : "keyup", {
    code, target: f.element,
  });
  const step = (seconds) => {
    for (let elapsed = 0, i = 0; elapsed < seconds - 1e-9; i++) {
      const dt = Math.min(seconds - elapsed, Array.isArray(frame) ? frame[i % frame.length] : frame);
      context.advance(dt);
      f.player.update(dt);
      elapsed += dt;
    }
  };
  return { ...f, world, game, audio, context, events, crossings, key, step,
    load: (value) => { loaded = value; },
    kinds: () => events.map(({ kind }) => kind),
  };
}
