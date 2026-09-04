import assert from "node:assert/strict";
import test from "node:test";
import { AUDIO_SAMPLE_RATE, AUDIO_VARIANTS } from "../src/audio-dsp.js";
import { soundDescription, soundSampleKey, synthesizeSound } from "../src/audio-samples.js";
import { audioFixture } from "./audio-fixture.js";

function energy(data) {
  return data.reduce((sum, value) => sum + value * value, 0);
}

test("water impacts are short, soft, deterministic noise transients with clean tails", () => {
  const entry = soundDescription("water-entry");
  const jump = soundDescription("water-jump");
  assert.equal(entry.duration, 0.3);
  assert.equal(jump.duration, entry.duration);
  assert.equal(entry.gain, 0.055);
  assert.equal(jump.gain, 0.035);
  assert.equal(entry.cooldown, 0.28, "no new cooldown hides physical entries");
  assert.equal(soundSampleKey(entry), soundSampleKey(jump));
  const variants = [];
  for (let variant = 0; variant < AUDIO_VARIANTS; variant++) {
    const data = synthesizeSound(entry, variant);
    assert.deepEqual(data, synthesizeSound(entry, variant));
    assert.deepEqual(data, synthesizeSound(jump, variant));
    assert.equal(data.length, 0.3 * AUDIO_SAMPLE_RATE);
    assert.ok(data.every(Number.isFinite));
    assert.equal(Math.abs(data[0]), 0);
    assert.equal(Math.abs(data.at(-1)), 0);
    assert.ok(Math.max(...data.map(Math.abs)) <= 0.681);
    assert.ok(Math.abs(data.reduce((sum, v) => sum + v, 0) / data.length) < 0.001);
    assert.ok(energy(data.subarray(AUDIO_SAMPLE_RATE * 0.15)) < energy(data) * 0.015,
      "energy decays in one gesture, not later bubble syllables");
    assert.ok(Math.max(...data.subarray(-96).map(Math.abs)) < 0.004,
      "last four milliseconds taper into silence");
    variants.push(data);
  }
  assert.notDeepEqual(variants[0], variants[1]);
  assert.notDeepEqual(variants[1], variants[2]);
});

test("repeated legitimate impacts remain one-shots within the existing water and PCM budgets", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  try {
    for (let i = 0; i < 100; i++) {
      audio.random = () => (i % AUDIO_VARIANTS) / AUDIO_VARIANTS;
      assert.equal(audio.play(i % 2 ? "water-jump" : "water-entry"), true);
      assert.ok(audio.voices.size <= 2);
      assert.ok(audio.buffers.size <= AUDIO_VARIANTS);
      context.advance(0.4);
    }
    assert.equal(context.sources.length, 100);
    assert.equal(audio.buffers.size, AUDIO_VARIANTS);
    assert.ok(context.sources.every((source) => !source.loop));
    assert.equal(audio.voices.size, 0);
  } finally {
    audio.dispose();
  }
});

test("continuous rain owns one separate loop; projecting it never retriggers a water impact", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  try {
    audio.setRain(0.35);
    const rain = audio.rainVoice.source;
    assert.equal(audio.play("water-entry"), true);
    const entry = context.sources.at(-1);
    for (let i = 0; i < 1000; i++) {
      context.currentTime += 1 / 60;
      audio.setRain(0.35);
    }
    assert.equal(context.sources.length, 2);
    assert.equal(rain.loop, true);
    assert.ok(!entry.loop);
    assert.equal(audio.rainVoice.source, rain);
    audio.setRain(0);
    context.advance(0); // Deliver the completed one-shot's WebAudio onended callback.
    assert.equal(audio.voices.size, 0);
  } finally {
    audio.dispose();
  }
});
