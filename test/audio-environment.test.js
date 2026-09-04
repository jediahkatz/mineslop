import assert from "node:assert/strict";
import test from "node:test";
import { soundDescription, synthesizeSound } from "../src/audio-samples.js";
import { attachAudioUI } from "../src/audio-ui-events.js";
import { WaterAudioTracker } from "../src/audio-water-events.js";
import { BLOCK } from "../src/blocks.js";
import { audioFixture } from "./audio-fixture.js";
import { controlFixture, dispatch } from "./control-fixture.js";

const settleAudio = () => new Promise((resolve) => setImmediate(resolve));

test("original menu, splash and music PCM is deterministic, finite and tapered", () => {
  for (const [kind, id] of [["ui-click"], ["water-entry"], ["water-jump"],
    ...Array.from({ length: 6 }, (_, note) => ["music", note])]) {
    const definition = soundDescription(kind, id);
    const pcm = synthesizeSound(definition);
    assert.deepEqual(pcm, synthesizeSound(definition));
    assert.ok(pcm.every(Number.isFinite));
    assert.ok(pcm.length <= 36000);
    assert.equal(Math.abs(pcm[0]), 0);
    assert.equal(Math.abs(pcm.at(-1)), 0);
    assert.ok(pcm.some((value) => Math.abs(value) > 0.01));
    assert.ok(pcm.every((value) => Math.abs(value) <= 0.681));
  }
  assert.equal(soundDescription("music", 99), null);
  assert.notDeepEqual(synthesizeSound(soundDescription("water-entry"), 0),
    synthesizeSound(soundDescription("water-entry"), 2));
});

test("real Player footsteps deliver actual floor materials to the quiet mixer", async (t) => {
  const f = controlFixture(t);
  const { audio, context } = audioFixture();
  t.after(() => audio.dispose());
  await audio.unlock();
  let floor = BLOCK.GRASS;
  f.world.get = (_x, y) => y === 0 ? floor : BLOCK.AIR;
  const heard = [];
  f.player.onStep = (id) => {
    heard.push(id);
    assert.equal(audio.play("step", id), true);
  };
  dispatch(f.document, "keydown", { code: "KeyW", target: f.element });
  const buffers = new Set();
  for (const material of [BLOCK.GRASS, BLOCK.STONE, BLOCK.PLANKS, BLOCK.SAND, BLOCK.SNOW]) {
    floor = material;
    const before = heard.length;
    for (let frame = 0; frame < 70; frame++) {
      context.advance(1 / 60);
      f.player.update(1 / 60);
    }
    assert.ok(heard.length > before);
    assert.ok(heard.slice(before).every((id) => id === material));
    buffers.add(context.sources.at(-1).buffer);
    assert.equal(soundDescription("step", material).gain, 0.036);
  }
  assert.equal(buffers.size, 5);
});

test("water samples fire entry/jump once, ignoring spawn, teleports, lava and surface jitter", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  const heard = [];
  const tracker = new WaterAudioTracker((kind) => {
    heard.push(kind);
    return audio.play(kind);
  });
  let poseRevision = 1;
  function sample(waterImmersion, options = {}) {
    context.advance(0.4);
    return tracker.observe({ valid: true, waterImmersion }, { poseRevision, ...options });
  }
  sample(0.9); // Spawn in water: no splash.
  sample(0);
  assert.equal(sample(0.4), true);
  for (let i = 0; i < 100; i++) sample(i % 2 ? 0.008 : 0.4);
  assert.deepEqual(heard, ["water-entry"]);
  assert.equal(sample(0, { jumping: true }), true);
  sample(0, { jumping: true });
  sample(0.6); // Landing back in the water.
  assert.deepEqual(heard, ["water-entry", "water-jump", "water-entry"]);
  poseRevision++;
  sample(0);
  sample(0.5, { flying: true });
  sample(0, { seated: true });
  tracker.observe({ valid: true, waterImmersion: 0, lavaImmersion: 1 }, { poseRevision });
  assert.equal(heard.length, 3);
  audio.dispose();
});

function uiDocument() {
  const handlers = new Map();
  const doc = {
    hidden: false,
    addEventListener: (type, handler) => handlers.set(type, handler),
    removeEventListener: (type) => handlers.delete(type),
    emit: (type, event = {}) => handlers.get(type)?.({ type, ...event }),
  };
  const control = {
    disabled: false,
    blocked: false,
    inUI: true,
    closest(selector) {
      if (selector === "#ui") return this.inUI ? {} : null;
      if (selector.startsWith("[hidden]")) return this.blocked ? {} : null;
      return selector === "select" ? null : this;
    },
  };
  return { doc, control, handlers };
}

test("real UI event contract accepts trusted clicks only, including keyboard buttons, and disposes", async () => {
  const { audio, context } = audioFixture({ state: "suspended" });
  const { doc, control, handlers } = uiDocument();
  const detach = attachAudioUI(() => audio, doc);
  doc.emit("click", { target: control, isTrusted: false });
  assert.equal(audio.context, null);
  control.inUI = false;
  doc.emit("click", { target: control, isTrusted: true });
  assert.equal(audio.context, null);
  control.inUI = true;
  control.disabled = true;
  doc.emit("click", { target: control, isTrusted: true });
  assert.equal(audio.context, null);
  control.disabled = false;
  control.blocked = true;
  doc.emit("click", { target: control, isTrusted: true });
  assert.equal(audio.context, null);
  control.blocked = false;
  doc.emit("click", { target: control, isTrusted: true, detail: 0 });
  await audio.resuming;
  await settleAudio();
  assert.equal(context.resumeCount, 1);
  assert.equal(context.sources.length, 1);
  audio.setPaused(true);
  context.advance(1);
  doc.emit("click", { target: control, isTrusted: true });
  control.blocked = true; // Resume hides the menu in its target handler.
  await settleAudio();
  assert.equal(context.sources.length, 2, "pause menu remains audible");
  control.blocked = false;
  audio.setEnabled(false);
  doc.emit("click", { target: control, isTrusted: true });
  await settleAudio();
  assert.equal(context.sources.length, 2);
  audio.setEnabled(true);
  doc.hidden = true;
  doc.emit("visibilitychange");
  assert.equal(audio.voices.size, 0);
  doc.emit("click", { target: control, isTrusted: true });
  assert.equal(context.sources.length, 2);
  detach();
  assert.equal(handlers.size, 0);
  audio.dispose();
  assert.ok(context.nodes.every((node) => node.disconnected));
});

test("mute checkbox takes effect before captured click playback; select changes sound once", async () => {
  const { audio, context } = audioFixture();
  const { doc, control } = uiDocument();
  await audio.unlock();
  const detach = attachAudioUI(() => audio, doc);
  control.id = "sound-setting";
  control.checked = false;
  doc.emit("click", { target: control, isTrusted: true });
  await settleAudio();
  assert.equal(context.sources.length, 0, "unchecked sound control stays silent even before change");
  audio.setEnabled(false); // Actual onSoundChange target handler.
  await settleAudio();
  assert.equal(context.sources.length, 0);
  audio.setEnabled(true);
  const select = {
    closest: (selector) => selector === "select" ? select : selector === "#ui" ? {} : null,
  };
  doc.emit("click", { target: select, isTrusted: true });
  await settleAudio();
  assert.equal(context.sources.length, 0);
  doc.emit("change", { target: select, isTrusted: true });
  await settleAudio();
  assert.equal(context.sources.length, 1);
  detach();
  audio.dispose();
});

test("late browser unlock cannot replay a stale hidden or detached UI click", async () => {
  const { audio, context } = audioFixture({ state: "suspended" });
  const { doc, control } = uiDocument();
  let finish;
  context.resumeTask = () => new Promise((resolve) => {
    finish = () => { context.state = "running"; resolve(); };
  });
  const detach = attachAudioUI(() => audio, doc);
  doc.emit("click", { target: control, isTrusted: true });
  doc.hidden = true;
  doc.emit("visibilitychange");
  detach();
  finish();
  await audio.resuming;
  await settleAudio();
  assert.equal(context.sources.length, 0);
  audio.dispose();
});

test("sparse music is frame-driven, deterministic, bounded and never catches up after a stall", async () => {
  async function sequence() {
    const { audio, context } = audioFixture();
    await audio.unlock();
    const notes = [];
    const play = audio.play.bind(audio);
    audio.play = (kind, id, ...rest) => {
      if (kind === "music") notes.push([Number(context.currentTime.toFixed(2)), id]);
      return play(kind, id, ...rest);
    };
    for (let i = 0; i < 1800; i++) {
      context.advance(0.1);
      audio.update(0.1);
      assert.ok(audio.voices.size <= 2);
      assert.ok(audio.buffers.size <= 6, "one cached PCM per pitch");
    }
    assert.ok(notes.length > 10 && notes.length < 20);
    assert.ok(notes[0][0] >= 9);
    assert.ok(notes.some((note, i) => i > 0 && note[0] - notes[i - 1][0] > 30));
    const before = notes.length;
    audio.update(3600);
    assert.ok(notes.length - before <= 1);
    audio.dispose();
    assert.equal(audio.cachedBytes, 0);
    assert.ok(context.nodes.every((node) => node.disconnected));
    return notes;
  }
  assert.deepEqual(await sequence(), await sequence());
});

test("mute, pause, visibility, volume and disposal suppress sequence and gameplay allocations", async () => {
  const { audio, context } = audioFixture();
  await audio.unlock();
  for (const [method, blocked, restored] of [
    ["setPaused", true, false], ["setHidden", true, false],
    ["setVolume", 0, 0.4], ["setEnabled", false, true],
  ]) {
    context.advance(2);
    audio.play("music", 0);
    audio[method](blocked);
    context.advance(1);
    const count = context.sources.length;
    for (let i = 0; i < 1000; i++) audio.update(0.1);
    assert.equal(audio.play("water-entry"), false);
    assert.equal(context.sources.length, count);
    assert.equal(audio.voices.size, 0);
    audio[method](restored);
    audio.update(0.1);
    assert.equal(context.sources.length, count, "restored sequence starts with a natural rest");
  }
  assert.equal(audio.master.gain.value, 0.72 * 0.4);
  audio.setVolume(NaN);
  assert.equal(audio.volume, 0.4);
  audio.dispose();
  audio.update(100);
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.play("ui-click"), false);
});
