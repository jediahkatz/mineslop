import assert from "node:assert/strict";
import test from "node:test";
import { AudioEngine, AUDIO_LIMITS } from "../src/audio-engine.js";
import { soundDescription } from "../src/audio-samples.js";
import { BLOCK } from "../src/blocks.js";
import { RAIN_SOUND, synthesizeRain } from "../src/rain-sample.js";
import { FakeAudioContext } from "./audio-fixture.js";

function fixture(t, options) {
  const context = new FakeAudioContext(options);
  let created = 0;
  const audio = new AudioEngine({ createContext: () => { created++; return context; } });
  t.after(() => audio.dispose());
  return { audio, context, get created() { return created; } };
}

test("original rain PCM is deterministic, finite, bounded and has no repeated attack envelope", () => {
  const pcm = synthesizeRain();
  assert.deepEqual(pcm, synthesizeRain());
  assert.equal(pcm.length, 36000);
  assert.ok(pcm.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 0.681));
  const rms = (part) => Math.sqrt(part.reduce((sum, value) => sum + value * value, 0) / part.length);
  assert.ok(rms(pcm) > 0.05);
  assert.ok(rms(pcm.subarray(0, 240)) > rms(pcm) * 0.5);
  assert.ok(rms(pcm.subarray(-240)) > rms(pcm) * 0.5);
  assert.ok(Math.abs(pcm.reduce((sum, value) => sum + value, 0) / pcm.length) < 1e-7);
});

test("locked/suspended rain projections never create contexts or replay on gesture resolution", async (t) => {
  const f = fixture(t, { state: "suspended" }), { audio, context } = f;
  assert.equal(audio.setRain(0.35), false);
  assert.equal(f.created, 0);
  let finish;
  context.resumeTask = () => new Promise((resolve) => {
    finish = () => { context.state = "running"; resolve(); };
  });
  const unlocking = audio.unlock();
  assert.equal(audio.setRain(0.35), false);
  audio.setHidden(true);
  audio.setRain(0);
  finish();
  assert.equal(await unlocking, false);
  audio.setHidden(false);
  audio.update(0.1);
  assert.equal(context.sources.length, 0);
  assert.equal(audio.setRain(0.35), true, "only a fresh live projection can admit rain");
});

test("steady rain reuses one loop/buffer and unchanged gain adds no automation", async (t) => {
  const { audio, context } = fixture(t);
  await audio.unlock();
  assert.equal(audio.setRain(0.35), true);
  const voice = audio.rainVoice, buffer = voice.source.buffer;
  const automation = voice.gain.gain.events.length;
  for (let i = 0; i < 1000; i++) {
    context.currentTime += 0.016;
    assert.equal(audio.setRain(0.35), true);
  }
  assert.equal(audio.rainVoice, voice);
  assert.equal(context.sources.length, 1);
  assert.equal(context.buffers.length, 1);
  assert.equal(voice.gain.gain.events.length, automation);
  assert.equal(voice.source.loop, true);
  assert.equal(voice.endTime, Infinity);
  assert.equal(audio.setRain(0.1), true);
  assert.equal(context.sources.length, 1);
  assert.equal(audio.rainVoice.level, RAIN_SOUND.gain * 0.1);
  audio.setRain(0);
  assert.equal(audio.rainVoice, null);
  assert.equal(voice.source.disconnected, true);
  assert.equal(audio.setRain(0.35), true);
  assert.equal(audio.rainVoice.source.buffer, buffer);
});

test("mute, hidden, pause, zero volume, teardown and device failure release rain immediately", async (t) => {
  const { audio, context } = fixture(t);
  await audio.unlock();
  for (const [off, on] of [
    [() => audio.setEnabled(false), () => audio.setEnabled(true)],
    [() => audio.setHidden(true), () => audio.setHidden(false)],
    [() => audio.setPaused(true), () => audio.setPaused(false)],
    [() => audio.setVolume(0), () => audio.setVolume(1)],
  ]) {
    audio.setRain(0.35);
    const source = audio.rainVoice.source;
    off();
    assert.equal(audio.rainVoice, null);
    assert.equal(audio.voices.size, 0);
    assert.equal(source.disconnected, true);
    const created = context.sources.length;
    on();
    audio.update(0.1);
    assert.equal(context.sources.length, created);
  }
  context.failGain = true;
  assert.equal(audio.setRain(0.35), false);
  assert.equal(audio.rainVoice, null);
  assert.equal(audio.voices.size, 0);
  assert.equal(context.sources.at(-1).disconnected, true);
  context.failGain = false;
  audio.setRain(0.35);
  audio.dispose();
  assert.equal(audio.rainVoice, null);
  assert.equal(audio.voices.size, 0);
  assert.equal(audio.cachedBytes, 0);
  assert.equal(context.closeCount, 1);
});

test("rain occupies one existing voice slot and its PCM stays inside the shared cache budget", async (t) => {
  const { audio, context } = fixture(t);
  await audio.unlock();
  audio.setRain(0.35);
  const buffer = audio.rainVoice.source.buffer;
  const materials = [BLOCK.STONE, BLOCK.PLANKS, BLOCK.GRASS, BLOCK.DIRT,
    BLOCK.SAND, BLOCK.GRAVEL, BLOCK.SNOW, BLOCK.WOOL, BLOCK.GLASS, BLOCK.COPPER_BLOCK];
  for (let variant = 0; variant < 3; variant++) {
    for (const species of ["horse", "cow", "sheep", "pig", "chicken", "wolf", "goat"])
      audio.bufferFor(soundDescription("animal", species), variant);
    for (const id of materials)
      for (const kind of ["step", "mine", "horse-step"])
        audio.bufferFor(soundDescription(kind, id), variant);
    assert.equal(audio.buffers.get("rain:0"), buffer);
    assert.ok(audio.cachedBytes <= AUDIO_LIMITS.cachedBytes);
    assert.ok(audio.buffers.size <= AUDIO_LIMITS.cachedBuffers);
  }
  assert.ok(context.buffers.length > audio.buffers.size, "test exercises real LRU eviction");
  assert.equal(audio.voices.size, 1);
  // Existing voice admission, not a separate weather budget.
  const ordinaryLimit = AUDIO_LIMITS.voices - AUDIO_LIMITS.reservedVoices;
  for (const event of [["animal", "horse"], ["xp", 3], ["shoot"], ["block"],
    ["step", BLOCK.STONE], ["place", BLOCK.STONE], ["mine", BLOCK.STONE],
    ["fishing-splash"], ["fishing-bite"]])
    assert.equal(audio.play(...event), true);
  assert.equal(audio.voices.size, ordinaryLimit);
  audio.setRain(0);
  assert.equal(audio.play("horse-step", BLOCK.STONE), true);
  const sources = context.sources.length;
  assert.equal(audio.setRain(0.35), false);
  assert.equal(context.sources.length, sources);
  assert.equal(audio.play("levelup", 5), true, "reserved gameplay cues remain available");
  assert.ok(audio.voices.size <= AUDIO_LIMITS.voices);
});
