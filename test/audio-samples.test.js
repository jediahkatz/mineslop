import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { animalCallProfile } from "../src/animal-audio.js";
import {
  AUDIO_SAMPLE_RATE,
  AUDIO_VARIANTS,
  MAX_SAMPLE_SECONDS,
  sampleArray,
} from "../src/audio-dsp.js";
import {
  soundDescription,
  soundMaterial,
  synthesizeSound,
} from "../src/audio-samples.js";
import { BLOCK, BLOCK_CATALOG } from "../src/blocks.js";
import { ITEM_IDS } from "../src/content-ids.js";

const digest = (samples) =>
  createHash("sha256").update(new Uint8Array(samples.buffer)).digest("hex");

function peak(samples) {
  let maximum = 0;
  for (const value of samples) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

function assertFiniteEnvelope(samples) {
  assert.ok(samples instanceof Float32Array);
  assert.ok(samples.length <= Math.ceil(MAX_SAMPLE_SECONDS * AUDIO_SAMPLE_RATE));
  assert.ok(samples.every(Number.isFinite));
  assert.equal(Math.abs(samples[0]), 0);
  assert.equal(Math.abs(samples.at(-1)), 0);
  const maximum = peak(samples);
  assert.ok(maximum > 0.001 && maximum < 0.69);
  assert.ok(peak(samples.subarray(0, 16)) < maximum * 0.2);
  assert.ok(peak(samples.subarray(-16)) < maximum * 0.2);
}

test("expanded woods share material audio without mistaking basalt for a log", () => {
  const wood = BLOCK_CATALOG.filter((block) => block.woodFamily);
  assert.ok(wood.length > 1);
  assert.deepEqual(
    new Set(wood.map((block) => soundDescription("step", block.id).key)),
    new Set([soundDescription("step", BLOCK.PLANKS).key])
  );
  // Basalt shipped with log art despite being a pickaxe material.
  assert.equal(soundMaterial(BLOCK.BASALT), soundMaterial(BLOCK.STONE));
  assert.notEqual(soundMaterial(BLOCK.BASALT), soundMaterial(BLOCK.OAK_LOG));
  assert.notEqual(soundMaterial(BLOCK.GRAVEL), soundMaterial(BLOCK.STONE));
  assert.notEqual(soundMaterial(BLOCK.SNOW), soundMaterial(BLOCK.SAND));
  assert.equal(soundMaterial(BLOCK.SPONGE), soundMaterial(BLOCK.WOOL));
  assert.equal(soundDescription("step", BLOCK.AIR), null);
  assert.equal(soundDescription("horse-step", NaN), null);
});

test("material footsteps, placement, fracture and hoof pairs retain different audible signatures", () => {
  const signatures = new Set();
  for (const kind of ["step", "place", "mine", "horse-step"]) {
    for (const id of [BLOCK.STONE, BLOCK.PLANKS, BLOCK.GRASS, BLOCK.GLASS]) {
      const description = soundDescription(kind, id);
      const samples = synthesizeSound(description, 1);
      assertFiniteEnvelope(samples);
      // Placement/mining deliberately reuse PCM at distinct playback rates.
      signatures.add(`${digest(samples)}:${description.rate}`);
      assert.equal(
        samples.length,
        Math.ceil(description.duration * AUDIO_SAMPLE_RATE)
      );
    }
  }
  assert.equal(signatures.size, 16);
});

test("common animal calls are finite, distinct and reproducible with restrained variants", () => {
  const signatures = new Set();
  for (const species of [
    "horse", "cow", "sheep", "pig", "chicken", "wolf", "goat",
  ]) {
    const description = soundDescription("animal", species);
    const first = synthesizeSound(description, 0);
    assertFiniteEnvelope(first);
    signatures.add(digest(first));
    assert.equal(digest(first), digest(synthesizeSound(description, 0)));
    const last = synthesizeSound(description, AUDIO_VARIANTS - 1);
    assertFiniteEnvelope(last);
    assert.equal(first.length, last.length);
    assert.notEqual(digest(first), digest(last));
  }
  assert.equal(signatures.size, 7);
});

test("fish and unknown species stay silent while mooshrooms share the cow cache gate", () => {
  for (const species of [
    "cod", "salmon", "squid", "unknown", "__proto__", null, 42,
  ]) {
    assert.equal(soundDescription("animal", species), null);
    assert.equal(animalCallProfile(species), null);
  }
  assert.deepEqual(
    soundDescription("animal", "mooshroom"),
    soundDescription("animal", "cow")
  );
});

test("XP and level-up remain distinct without adding cache keys for levels or amounts", () => {
  const pickup = synthesizeSound(soundDescription("xp", 3));
  const levelup = synthesizeSound(soundDescription("levelup", 3));
  assertFiniteEnvelope(pickup);
  assertFiniteEnvelope(levelup);
  assert.ok(levelup.length > pickup.length * 2);
  assert.notEqual(digest(levelup), digest(pickup));
  const amounts = [-1, 0, 1, 3, 6, 8, 32, 999999, Infinity, NaN];
  assert.equal(
    new Set(amounts.map((amount) => soundDescription("xp", amount).key)).size,
    1
  );
  assert.equal(
    new Set(amounts.map((level) => soundDescription("levelup", level).key)).size,
    1
  );
});

test("the existing hit, eating, bow, pearl, shield, teleport and fishing DSP remains available", () => {
  for (const kind of [
    "hit", "eat", "shoot", "block", "teleport",
    "fishing-splash", "fishing-bite", "fishing-catch",
  ])
    assertFiniteEnvelope(synthesizeSound(soundDescription(kind)));
  const bow = soundDescription("shoot");
  const pearl = soundDescription("shoot", ITEM_IDS.ENDER_PEARL);
  assertFiniteEnvelope(synthesizeSound(pearl));
  assert.notEqual(pearl.key, bow.key);
  assert.notEqual(digest(synthesizeSound(pearl)), digest(synthesizeSound(bow)));
  assert.equal(soundDescription("unknown"), null);
  assert.equal(soundDescription("__proto__"), null);
  assert.equal(soundDescription("break", "boat-1").material, "wood");
  assert.throws(() => sampleArray(Infinity), RangeError);
  assert.throws(() => sampleArray(MAX_SAMPLE_SECONDS + 0.01), RangeError);
});
