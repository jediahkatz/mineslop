import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  AUDIO_LIMITS,
  MAX_VOICE_GAIN,
  AudioEffects,
  AudioEngine,
} from "../src/audio.js";
import { AUDIO_VARIANTS } from "../src/audio-dsp.js";
import { soundDescription } from "../src/audio-samples.js";
import { spatialSound } from "../src/audio-spatial.js";
import { BLOCK } from "../src/blocks.js";
import { Effects } from "../src/effects.js";
import { soundDefinition } from "../src/material-sounds.js";
import { FakeAudioContext, audioFixture } from "./audio-fixture.js";

test("both mixer entry points use the same explicit, bounded SoundBank", async () => {
  assert.equal(AudioEffects, AudioEngine);
  const { audio, context } = audioFixture();
  await audio.unlock();
  const bank = audio.bank;
  const original = soundDefinition("step", BLOCK.PLANKS);
  const complete = soundDescription("step", BLOCK.PLANKS);
  const pinned = audio.bufferFor(complete, 0);
  assert.equal(bank.get(original, 0), pinned);
  let previous = -1;
  for (let i = 0; i < 12; i++) {
    const entry = bank.next(original);
    assert.notEqual(entry.variant, previous);
    previous = entry.variant;
  }
  assert.ok(context.buffers.length >= 2);
  assert.ok(context.buffers.length <= AUDIO_VARIANTS);
  assert.equal(context.sources.length, 0);
  assert.equal(audio.buffers, bank.buffers);
  assert.equal(audio.cachedBytes, bank.bytes);
  audio.dispose();
  assert.equal(bank.next(original), null);
  assert.equal(bank.get(original), null);
  assert.equal(bank.bytes, 0);
});

test("muting before unlock and a missing audio device are safe no-ops", async () => {
  let attempts = 0;
  const audio = new AudioEffects({
    createContext: () => {
      attempts++;
      return null;
    },
  });
  audio.setEnabled(false);
  assert.equal(await audio.unlock(), false);
  assert.equal(attempts, 0);
  audio.setEnabled(true);
  assert.equal(await audio.unlock(), false);
  assert.equal(attempts, 1);
  assert.equal(audio.play("levelup", 2), false);
  audio.createContext = () => {
    throw new Error("Audio unavailable");
  };
  assert.equal(await audio.unlock(), false);
  audio.dispose();
});

test("audio is lazy and retries rejected autoplay only on another unlock", async () => {
  const context = new FakeAudioContext({ state: "suspended" });
  let created = 0;
  const audio = new AudioEffects({
    createContext: () => {
      created++;
      return context;
    },
  });
  assert.equal(audio.play("animal", "cow"), false);
  assert.equal(created, 0);
  context.resumeTask = () => Promise.reject(new Error("Gesture required"));
  assert.equal(await audio.unlock(), false);
  assert.equal(context.resumeCount, 1);
  assert.equal(audio.play("step", BLOCK.STONE), false);
  assert.equal(context.buffers.length, 0);
  assert.equal(context.resumeCount, 1);
  context.resumeTask = null;
  assert.equal(await audio.unlock(), true);
  assert.equal(context.sources.length, 0);
  assert.equal(audio.play("step", BLOCK.STONE), true);
  assert.equal(created, 1);
  audio.dispose();
});

test("cold buffer generation cannot truncate a call's scheduled attack or release", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  const createBuffer = context.createBuffer.bind(context);
  context.createBuffer = (...args) => {
    context.currentTime += 0.12;
    return createBuffer(...args);
  };
  assert.equal(audio.play("animal", "horse"), true);
  const voice = [...audio.voices][0];
  assert.equal(voice.source.started, context.currentTime);
  assert.equal(voice.gain.gain.events[0][2], context.currentTime);
  assert.ok(
    voice.endTime >= voice.source.started + voice.source.buffer.duration
  );
  audio.dispose();
});

test("a closed device is replaced without retaining old buffers, voices or cooldowns", async () => {
  const first = new FakeAudioContext();
  const second = new FakeAudioContext();
  let created = 0;
  const audio = new AudioEffects({
    createContext: () => (created++ === 0 ? first : second),
    random: () => 0,
  });
  await audio.unlock();
  assert.equal(audio.play("animal", "cow"), true);
  const oldBuffer = first.sources[0].buffer;
  await first.close();
  assert.equal(audio.play("step", BLOCK.STONE), false);
  assert.equal(await audio.unlock(), true);
  assert.ok(first.nodes.every((node) => node.disconnected));
  assert.equal(audio.diagnostics().cachedBuffers, 0);
  assert.equal(audio.play("animal", "cow"), true);
  assert.notEqual(second.sources[0].buffer, oldBuffer);
  audio.dispose();
});

test("concurrent unlocks share a resume and late resolution cannot reopen a disposed mixer", async () => {
  const { audio, context } = audioFixture({ state: "suspended" });
  let finish;
  context.resumeTask = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = audio.unlock();
  const second = audio.unlock();
  assert.equal(first, second);
  assert.equal(context.resumeCount, 1);
  audio.dispose();
  finish();
  assert.equal(await first, false);
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.play("xp", 4), false);
  assert.equal(context.closeCount, 1);
  assert.equal(audio.diagnostics().state, "disposed");
});

test("positional gain fades, pans with listener orientation and rejects invalid controls", () => {
  const listener = {
    position: { x: 100, y: 20, z: 100 },
    right: { x: 1, y: 0, z: 0 },
  };
  const right = spatialSound({ position: { x: 113, y: 20, z: 100 } }, listener);
  assert.equal(right.pan, 1);
  assert.equal(right.gain, 0.25);
  assert.equal(
    spatialSound({ position: { x: 87, y: 20, z: 100 } }, listener).pan,
    -1
  );
  listener.right.x = -1;
  assert.equal(
    spatialSound({ position: { x: 113, y: 20, z: 100 } }, listener).pan,
    -1
  );
  assert.equal(spatialSound({ distance: 0 }).gain, 1);
  assert.equal(spatialSound({ distance: 24 }).gain, 0);
  assert.equal(spatialSound({ distance: 33, maxDistance: 999 }).gain, 0);
  assert.equal(spatialSound({ distance: 13, pan: 2, volume: 0.5 }).gain, 0.125);
  assert.equal(spatialSound({ pan: 2 }).pan, 1);
  for (const options of [
    null, [], { distance: -1 }, { distance: NaN }, { pan: Infinity },
    { volume: NaN }, { maxDistance: Infinity }, { position: { x: 1, y: 2 } },
    { position: { x: 1, y: 2, z: 3 } },
  ])
    assert.equal(spatialSound(options), null);
});

test("silent, distant and malformed animal events allocate no samples or voices", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  const nodes = context.nodes.length;
  for (const [species, options] of [
    ["cod", {}], ["unknown", {}], ["horse", { distance: 25 }],
    ["cow", { volume: 0 }], ["wolf", { pan: NaN }],
  ])
    assert.equal(audio.play("animal", species, options), false);
  assert.equal(context.nodes.length, nodes);
  assert.equal(context.buffers.length, 0);
  assert.equal(audio.play("animal", "cow", { distance: 13, pan: -0.4 }), true);
  const voice = [...audio.voices][0];
  assert.equal(voice.panner.pan.value, -0.4);
  assert.equal(
    voice.gain.gain.events[1][1],
    Math.min(MAX_VOICE_GAIN, soundDescription("animal", "cow").gain * 0.93) * 0.25
  );
  audio.dispose();
});

test("animal global/species gates suppress herds without throttling local actions", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  assert.equal(audio.play("animal", "horse"), true);
  const buffers = context.buffers.length;
  for (let i = 0; i < 50; i++) assert.equal(audio.play("animal", "cow"), false);
  assert.equal(context.buffers.length, buffers);
  assert.equal(audio.play("step", BLOCK.STONE), true);
  context.advance(AUDIO_LIMITS.animalGapSeconds + 0.01);
  assert.equal(audio.play("animal", "wolf"), true);
  assert.equal(audio.diagnostics().animalVoices, 2);
  context.advance(AUDIO_LIMITS.animalGapSeconds + 0.01);
  assert.equal(audio.play("animal", "horse"), false);
  assert.equal(audio.play("animal", "cow"), true);
  context.advance(AUDIO_LIMITS.animalGapSeconds + 0.01);
  assert.equal(audio.play("animal", "mooshroom"), false);
  context.advance(10);
  assert.equal(audio.play("animal", "horse"), true);
  audio.dispose();
});

test("ordinary storms leave reserved cue slots and all admission is bounded before allocation", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  const ordinary = [
    ["animal", "horse"], ["xp", 3], ["shoot"], ["block"],
    ["step", BLOCK.STONE], ["place", BLOCK.STONE], ["mine", BLOCK.STONE],
    ["fishing-splash"], ["fishing-bite"], ["horse-step", BLOCK.STONE],
  ];
  for (const event of ordinary) assert.equal(audio.play(...event), true);
  const ordinaryLimit = AUDIO_LIMITS.voices - AUDIO_LIMITS.reservedVoices;
  assert.equal(audio.diagnostics().voices, ordinaryLimit);
  const initialNodes = context.nodes.length;
  assert.equal(audio.play("hit"), false);
  assert.equal(context.nodes.length, initialNodes);
  assert.equal(audio.play("levelup", 2), true);
  assert.equal(audio.play("teleport"), true);
  assert.equal(audio.diagnostics().voices, AUDIO_LIMITS.voices);
  context.advance(0.06, false);
  const nodes = context.nodes.length;
  assert.equal(audio.play("mine", BLOCK.PLANKS), false);
  assert.equal(context.nodes.length, nodes);
  for (const source of context.sources.slice(0, 3)) source.finish();
  assert.equal(audio.play("mine", BLOCK.PLANKS), true);
  assert.equal(audio.diagnostics().voices, ordinaryLimit);
  context.advance(2, false);
  assert.equal(audio.play("xp", 2), true);
  assert.equal(audio.diagnostics().voices, 1);
  audio.dispose();
  assert.ok(context.nodes.every((node) => node.disconnected));
});

test("mining and placement retain distinct rates while reusing the original impact bank", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  assert.equal(audio.play("mine", BLOCK.PLANKS), true);
  const mining = context.sources.at(-1);
  context.advance(1);
  assert.equal(audio.play("place", BLOCK.PLANKS), true);
  const placement = context.sources.at(-1);
  assert.equal(placement.buffer, mining.buffer);
  assert.ok(placement.playbackRate.value < mining.playbackRate.value);
  audio.dispose();
});

test("buffers reuse positions and LRU storage stays bounded under all material variants", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  assert.equal(audio.play("step", BLOCK.PLANKS, { distance: 1, pan: -1 }), true);
  const first = context.sources.at(-1).buffer;
  context.advance(0.6);
  assert.equal(audio.play("step", BLOCK.PLANKS, { distance: 3, pan: 1 }), true);
  assert.equal(context.sources.at(-1).buffer, first);
  const materials = [
    BLOCK.STONE, BLOCK.PLANKS, BLOCK.GRASS, BLOCK.DIRT, BLOCK.SAND, BLOCK.GRAVEL,
    BLOCK.SNOW, BLOCK.WOOL, BLOCK.GLASS, BLOCK.COPPER_BLOCK, BLOCK.WATER,
  ];
  for (let variant = 0; variant < AUDIO_VARIANTS; variant++) {
    audio.random = () => (variant + 0.1) / AUDIO_VARIANTS;
    for (const kind of ["step", "mine", "place"]) {
      for (const material of materials) {
        context.advance(0.6);
        assert.equal(audio.play(kind, material), true);
        const stats = audio.diagnostics();
        assert.ok(stats.cachedBuffers <= AUDIO_LIMITS.cachedBuffers);
        assert.ok(stats.cachedBytes <= AUDIO_LIMITS.cachedBytes);
      }
    }
  }
  audio.random = () => 0;
  context.advance(0.6);
  assert.equal(audio.play("step", BLOCK.PLANKS), true);
  assert.notEqual(context.sources.at(-1).buffer, first);
  audio.dispose();
  assert.equal(audio.diagnostics().cachedBytes, 0);
  assert.equal(audio.diagnostics().cachedBuffers, 0);
});

test("large vocal buffers trigger byte eviction even below the entry limit", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  for (let variant = 0; variant < AUDIO_VARIANTS; variant++) {
    audio.random = () => (variant + 0.1) / AUDIO_VARIANTS;
    for (const species of [
      "horse", "cow", "sheep", "pig", "chicken", "wolf", "goat",
    ]) {
      context.advance(11);
      assert.equal(audio.play("animal", species), true);
    }
  }
  for (const material of [
    BLOCK.STONE, BLOCK.PLANKS, BLOCK.GRASS, BLOCK.DIRT, BLOCK.SAND, BLOCK.GRAVEL,
    BLOCK.SNOW, BLOCK.WOOL, BLOCK.GLASS, BLOCK.COPPER_BLOCK, BLOCK.WATER,
  ]) {
    context.advance(1);
    assert.equal(audio.play("mine", material), true);
  }
  assert.ok(context.buffers.length < AUDIO_LIMITS.cachedBuffers);
  assert.ok(audio.diagnostics().cachedBuffers < context.buffers.length);
  assert.ok(audio.diagnostics().cachedBytes <= AUDIO_LIMITS.cachedBytes);
  audio.dispose();
});

test("mute stops old voices, prevents allocation and rapid unmute never replays them", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  audio.play("animal", "horse");
  const old = context.sources[0];
  audio.setEnabled(false);
  assert.ok(old.stops.some((at) => at > 0 && at <= 0.02));
  const allocations = context.nodes.length;
  assert.equal(audio.play("levelup", 8), false);
  assert.equal(await audio.unlock(), false);
  assert.equal(context.nodes.length, allocations);
  audio.setEnabled(true);
  assert.equal(old.disconnected, true);
  assert.equal(audio.diagnostics().voices, 0);
  assert.equal(context.sources.length, 1);
  assert.equal(audio.play("levelup", 8), true);
  audio.dispose();
  audio.dispose();
  assert.equal(context.closeCount, 1);
  assert.equal(await audio.unlock(), false);
});

test("muting an interrupted context releases voices without waiting for its audio clock", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  assert.equal(audio.play("animal", "horse"), true);
  context.state = "suspended";
  audio.setEnabled(false);
  assert.equal(audio.diagnostics().voices, 0);
  assert.equal(context.sources[0].disconnected, true);
  audio.setEnabled(true);
  assert.equal(audio.play("step", BLOCK.STONE), false);
  assert.equal(await audio.unlock(), true);
  assert.equal(context.sources.length, 1);
  audio.dispose();
});

test("optional stereo and failed device setup/start/close do not break gameplay", async () => {
  const { audio, context } = audioFixture({ stereo: false });
  context.failGain = true;
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.context, null);
  assert.equal(context.closeCount, 1);
  context.failGain = false;
  context.state = "running";
  assert.equal(await audio.unlock(), true);
  context.failBuffer = true;
  assert.equal(audio.play("step", BLOCK.STONE), false);
  context.failBuffer = false;
  context.failStart = true;
  assert.equal(audio.play("step", BLOCK.STONE), false);
  assert.equal(audio.diagnostics().voices, 0);
  context.failStart = false;
  assert.equal(audio.play("step", BLOCK.STONE, { pan: 1 }), true);
  assert.equal([...audio.voices][0].panner, null);
  context.closeTask = () => Promise.reject(new Error("Device already closed"));
  assert.doesNotThrow(() => audio.dispose());
  await Promise.resolve();
});

test("Effects forwards camera-space animal/hoof events, level-up and immediate mute", async () => {
  const { audio } = audioFixture();
  const effects = Object.create(Effects.prototype);
  effects.audioEngine = audio;
  effects.soundEnabled = true;
  effects.camera = new THREE.PerspectiveCamera();
  effects.camera.position.set(10, 3, 10);
  effects.audioListener = {
    position: new THREE.Vector3(),
    right: new THREE.Vector3(),
  };
  assert.equal(await effects.unlockAudio(), true);
  assert.equal(
    effects.sound("animal", "cow", { position: { x: 16, y: 3, z: 10 } }),
    true
  );
  assert.equal([...audio.voices][0].panner.pan.value, 1);
  assert.equal(effects.sound("horse-step", BLOCK.STONE), true);
  assert.equal(effects.sound("levelup", 10), true);
  effects.soundEnabled = false;
  assert.equal(effects.soundEnabled, false);
  assert.equal(effects.sound("xp", 1), false);
  assert.equal(effects.audioDiagnostics().enabled, false);
  audio.dispose();
});
