import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { BIOME_INDEX } from "../src/biomes.js";
import { GameWeatherServices } from "../src/game-weather-services.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { weatherGame, stagedWorlds } from "./weather-game.fixture.mjs";

test("actual Game constructor/stage/activation preserves default3 and saves/restores weather v1", async (t) => {
  const f = await weatherGame(t), { game } = f;
  assert.equal(game.world.generatorVersion, 3);
  assert.equal(f.contexts.length, 0, "staging never creates an audio context");
  assert.equal(game.weatherServices, f.staged[0].weatherServices);
  assert.equal(game.effects.audioEngine, game.audioEngine);
  assert.deepEqual(game.snapshot().weather, { version: 1, elapsed: 0 });
  f.frame(4);
  const elapsed = game.weatherServices.state.elapsed;
  assert.ok(elapsed > 0);
  assert.equal((await game.save()).ok, true);
  const saved = f.saves.at(-1), old = game.weatherServices, mixer = game.audioEngine;
  assert.equal(saved.version, 3);
  assert.equal(saved.weather.elapsed, elapsed);
  await f.initialize(saved.world.seed, saved);
  assert.equal(old.disposed, true);
  assert.notEqual(game.weatherServices, old);
  assert.equal(game.weatherServices.state.elapsed, elapsed);
  assert.equal(game.audioEngine, mixer);
  const legacy = game.snapshot();
  delete legacy.weather;
  await f.initialize(legacy.world.seed, legacy);
  assert.deepEqual(game.snapshot().weather, { version: 1, elapsed: 0 });
  await f.initialize("weather-v6", null, { generatorVersion: 6 });
  assert.equal(game.world.generatorVersion, 6);
  assert.equal(game.weatherServices.active, true);
});

test("original malformed/accessor weather rejects before clone, terrain staging or live replacement", async (t) => {
  const f = await weatherGame(t), { game } = f;
  const old = game.weatherServices, world = game.world;
  let getters = 0;
  const invalid = [null, {}, { version: 2, elapsed: 1 }, { version: 1, elapsed: -1 },
    { version: 1, elapsed: Infinity }, { version: 1, elapsed: 0, surprise: true },
    { version: 1, get elapsed() { getters++; return 1; } }];
  for (const weather of invalid) {
    const saved = { ...game.snapshot(), weather }, count = stagedWorlds.length;
    assert.throws(() => normalizeWorldComponents(saved), /weather/);
    await assert.rejects(game.initialize(world.seed, saved), /weather/);
    await assert.rejects(game.prepareWorld(world.seed, saved), /weather/);
    assert.equal(stagedWorlds.length, count);
    assert.equal(game.weatherServices, old);
    assert.equal(old.active, true);
  }
  const saved = game.snapshot();
  Object.defineProperty(saved, "weather", { get() { getters++; return { version: 1, elapsed: 1 }; } });
  await assert.rejects(game.initialize(world.seed, saved), /weather/);
  assert.equal(getters, 0);
  assert.equal(game.world, world);
});

test("actual failed staging and late initialization failure dispose only their weather candidate", async (t) => {
  const f = await weatherGame(t), { game } = f;
  const old = game.weatherServices, disposed = [];
  const dispose = GameWeatherServices.prototype.dispose;
  t.mock.method(GameWeatherServices.prototype, "dispose", function () {
    disposed.push(this);
    return Reflect.apply(dispose, this, []);
  });
  const bad = { ...game.snapshot(), horses: { invalid: true } };
  await assert.rejects(game.prepareWorld(game.world.seed, bad));
  assert.ok(disposed.some((service) => service !== old && service.disposed));
  assert.equal(game.weatherServices, old);
  assert.equal(old.active, true);
  assert.equal(stagedWorlds.at(-1)._disposed, true);
  assert.equal(stagedWorlds.at(-1).coordinator.budget.totalBytes, 0);
  const bind = game.bindWorldServiceEvents;
  t.mock.method(game, "bindWorldServiceEvents", function () {
    Reflect.apply(bind, this, []);
    throw new Error("late presentation installation failure");
  });
  await assert.rejects(f.initialize("weather-late-failure"), /late presentation/);
  assert.equal(old.disposed, true);
  assert.equal(f.staged.at(-1).weatherServices.disposed, true);
  assert.equal(game.weatherServices, null);
  assert.equal(game.audioEngine.rainVoice, null);
});

test("admitted Game simulation advances through inventory overlays but freezes blocked lifecycle states", async (t) => {
  const f = await weatherGame(t), { game, doc } = f;
  for (const [owner, flag] of [[game, "paused"], [game, "building"], [game, "failed"],
    [game.gameplay, "dead"], [doc, "hidden"]]) {
    const before = game.weatherServices.state.elapsed;
    owner[flag] = true;
    f.frame(3);
    assert.equal(game.weatherServices.state.elapsed, before, flag);
    assert.equal(game.weatherServices.desiredAudio.level, 0, flag);
    owner[flag] = false;
  }
  game.overlayChanged(true);
  const before = game.weatherServices.state.elapsed;
  assert.equal(game.active, false);
  assert.equal(game.simulating, true);
  f.frame(3);
  assert.ok(game.weatherServices.state.elapsed > before);
});

test("rain renders after atmosphere without disturbing Wildlife/late-exit/gravity/mesh order", async (t) => {
  const f = await weatherGame(t), { game } = f;
  await f.rainy();
  const events = game.graphics.events;
  for (const [owner, method, label] of [[game.wildlife, "update", "wildlife"],
    [game.gravityServices, "frame", "gravity"], [game.weatherServices, "render", "weather"]]) {
    const original = owner[method];
    t.mock.method(owner, method, function (...args) {
      events.push(label);
      return Reflect.apply(original, this, args);
    });
  }
  const exit = game.vehicleServices.takeExitPose;
  t.mock.method(game.vehicleServices, "takeExitPose", function (...args) {
    events.push("exit");
    return Reflect.apply(exit, this, args);
  });
  events.length = 0;
  f.frame();
  assert.deepEqual(events.filter((event) =>
    ["wildlife", "gravity", "mesh", "atmosphere", "weather", "draw", "exit"].includes(event)),
  ["exit", "wildlife", "exit", "gravity", "mesh", "atmosphere", "weather", "draw"]);
  assert.equal(game.weatherServices.renderer.object.geometry.drawRange.count, 400);
  assert.ok(game.audioEngine.rainVoice);
});

test("actual Game projects admitted rainy/dry/cold/roofed/unknown states without procedural climate reads", async (t) => {
  const f = await weatherGame(t, { generatorVersion: 4 }), { game } = f;
  await f.rainy();
  const service = game.weatherServices;
  f.frame(6);
  const render = service.renderer, positions = render.positions;
  assert.equal(render.object.geometry.drawRange.count, 400);
  assert.ok(service.desiredAudio.level > 0);
  for (const biome of ["desert", "snowy_plains"]) {
    assert.notEqual(BIOME_INDEX[biome], undefined, biome);
    for (const chunk of game.world.chunks.values()) chunk.biomes.fill(BIOME_INDEX[biome]);
    f.frame();
    assert.equal(render.object.visible, false, biome);
    assert.equal(service.desiredAudio.level, 0, biome);
  }
  for (const chunk of game.world.chunks.values()) chunk.biomes.fill(BIOME_INDEX.plains);
  for (let z = 2; z <= 14; z += 3)
    for (let x = 2; x <= 14; x += 3) f.put(x, 90, z, BLOCK.GLASS);
  f.frame(6);
  assert.equal(render.object.visible, false);
  assert.equal(service.desiredAudio.level, 0);
  for (let z = 2; z <= 14; z += 3)
    for (let x = 2; x <= 14; x += 3) f.put(x, 90, z, BLOCK.AIR);
  f.frame(6);
  assert.equal(render.object.geometry.drawRange.count, 400);
  game.graphics.atmosphere.cameraMediumKnown = false;
  f.frame();
  assert.equal(render.object.visible, false);
  assert.equal(service.desiredAudio.level, 0);
  game.graphics.atmosphere.cameraMediumKnown = true;
  game.graphics.atmosphere.underwater = true;
  f.frame();
  assert.equal(render.object.visible, false);
  game.graphics.atmosphere.underwater = false;
  // Rendering itself must not generate biome/cell fallbacks for evicted columns.
  const getBiome = t.mock.method(game.world, "getBiome", () => assert.fail("procedural climate read"));
  game.world.chunks.delete("0,0");
  game.renderWeather();
  assert.equal(render.object.visible, false);
  assert.equal(service.desiredAudio.level, 0);
  assert.equal(render.positions, positions);
  getBiome.mock.restore();
});

test("independent Game mutation fanout retains weather scans through benign churn and observer failure", async (t) => {
  const f = await weatherGame(t, { generatorVersion: 4 }), { game } = f;
  await f.rainy();
  f.frame();
  const exposure = game.weatherServices.renderer.exposure;
  let deliveries = 0, currentEvent;
  const original = game.weatherServices.onMutation;
  t.mock.method(game.weatherServices, "onMutation", function (world, event) {
    deliveries++;
    currentEvent = event;
    assert.equal(event.revision, world._editRevision);
    return Reflect.apply(original, this, [world, event]);
  });
  for (let i = 0; i < 12; i++) {
    f.put(15, 110, 15, i % 2 ? BLOCK.STONE : BLOCK.GLASS);
    f.frame();
    assert.ok(exposure.reads <= 2048);
  }
  assert.equal(deliveries, 12);
  assert.equal(game.weatherServices.renderer.object.geometry.drawRange.count, 400);
  assert.equal(exposure.reads, 0);
  const cached = structuredClone([...exposure.cache]);
  game.weatherServices.onMutation(game.world, currentEvent);
  assert.deepEqual([...exposure.cache], cached, "current replay cannot advance or restart scans");
  assert.equal(original.call(game.weatherServices, game.world,
    { ...currentEvent, revision: currentEvent.revision - 1 }), false, "old revision rejected");
  t.mock.method(game.buildingServices, "onMutation", () => { throw Error("other observer"); });
  f.put(8, 90, 8, BLOCK.GLASS);
  assert.equal(deliveries, 14); // Includes the explicitly replayed notification.
  f.frame();
  assert.equal(game.weatherServices.desiredAudio.level, 0);
});

test("actual Game clouds retain world parallax while wind advances independently", async (t) => {
  const f = await weatherGame(t), { game } = f;
  f.frame();
  const service = game.weatherServices, mesh = game.graphics.atmosphere.clouds;
  const positions = () => new Map(service.clouds.slots.map((slot) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(slot.slot * 3, matrix);
    return [slot.key, matrix.elements[12] + mesh.position.x];
  }));
  const old = positions();
  game.paused = true;
  game.player.position.x += 10;
  game.player._syncCamera(0);
  f.frame();
  for (const [key, x] of positions()) if (old.has(key))
    assert.ok(Math.abs(x - old.get(key)) < 0.00003);
  const before = positions(), elapsed = service.state.elapsed;
  f.resume();
  f.frame(10);
  const wind = (service.state.elapsed - elapsed) * 0.3;
  for (const [key, x] of positions()) if (before.has(key))
    assert.ok(Math.abs(x - before.get(key) - wind) < 0.00004);
  assert.equal(mesh.count, 108);
  assert.equal(service.clouds.slots.length, 36);
});

test("successful travel, failed admission rollback and respawn retain the same weather clock owner", async (t) => {
  const f = await weatherGame(t), { game } = f;
  await f.rainy(); f.frame();
  const service = game.weatherServices, elapsed = service.state.elapsed;
  const travel = game.travel.teleport({ x: 8.5, y: 65, z: 8.5, dimension: "nether" });
  assert.equal(game.audioEngine.rainVoice, null, "travel silences before its first await");
  assert.equal((await travel).ok, true);
  assert.equal(game.weatherServices, service);
  assert.equal(service.epoch, game.world.epoch);
  assert.equal(service.state.elapsed, elapsed);
  f.resume(); f.frame(2);
  assert.ok(service.state.elapsed > elapsed, "other dimensions retain an advancing schedule");
  assert.equal(service.desiredAudio.level, 0);
  assert.equal((await game.travel.teleport({ x: 8.5, y: 65, z: 8.5, dimension: "overworld" })).ok, true);
  const savedElapsed = service.state.elapsed;
  const ensure = game.world.ensureArea;
  let refused = false;
  t.mock.method(game.world, "ensureArea", async function (...args) {
    if (this.dimension === "end" && !refused) { refused = true; throw Error("weather admission failure"); }
    return Reflect.apply(ensure, this, args);
  });
  const failed = await game.travel.teleport({ x: 8.5, y: 65, z: 8.5, dimension: "end" });
  assert.equal(failed.ok, false);
  assert.equal(failed.rollbackFailed, undefined);
  assert.equal(game.world.dimension, "overworld");
  assert.equal(game.weatherServices, service);
  assert.equal(service.epoch, game.world.epoch);
  assert.equal(service.state.elapsed, savedElapsed);
  game.gameplay.damage(100, "test");
  assert.equal((await game.respawn()).ok, true);
  assert.equal(game.weatherServices, service);
  assert.equal(service.state.elapsed, savedElapsed);
});

test("changed Game owners invalidate weather render, save and epoch-rebind without stale audio", async (t) => {
  const f = await weatherGame(t), { game } = f;
  await f.rainy(); f.frame();
  const service = game.weatherServices, elapsed = service.state.elapsed;
  for (const key of ["world", "gameplay", "player", "graphics", "weatherServices"]) {
    const original = game[key];
    game[key] = {};
    assert.equal(service.frame(0.1).ok, false, key);
    assert.equal(service.render().level, 0, key);
    assert.throws(() => service.serialize(), /stale/);
    assert.equal(service.rebindWorldEpoch().ok, false, key);
    game[key] = original;
  }
  assert.equal(service.state.elapsed, elapsed);
  service.dispose();
  assert.equal(game.audioEngine.rainVoice, null);
  assert.equal(game.weatherServices, null);
  assert.equal(service.renderer.object.parent, null);
});

test("real Game rain uses the persistent Effects mixer and immediately silences lifecycle transitions", async (t) => {
  const f = await weatherGame(t), { game, doc } = f;
  await f.rainy(); f.frame();
  const mixer = game.audioEngine, context = f.contexts[0], buffer = mixer.rainVoice.source.buffer;
  assert.equal(game.effects.audioEngine, mixer);
  const sources = context.sources.length;
  f.frame(20);
  assert.equal(context.sources.length, sources, "rain is not repeated events");
  game.setSoundEnabled(false);
  assert.equal(mixer.rainVoice, null);
  game.setSoundEnabled(true);
  assert.equal(mixer.rainVoice, null, "unmuting alone never replays weather");
  f.frame(); assert.equal(mixer.rainVoice.source.buffer, buffer);
  const paused = game.pause();
  assert.equal(mixer.rainVoice, null);
  await paused;
  f.resume(); f.frame();
  doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(mixer.rainVoice, null, "hidden transition needs no RAF");
  doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange"));
  f.resume(); f.frame();
  game.gameplay.damage(100, "test");
  assert.equal(mixer.rainVoice, null);
  const saved = game.snapshot();
  await f.initialize("replacement-weather");
  assert.equal(game.audioEngine, mixer);
  assert.equal(f.contexts.length, 1);
  assert.equal(context.closeCount, 0);
  assert.equal(mixer.rainVoice, null);
  await f.initialize(saved.world.seed, saved);
  assert.equal(mixer.rainVoice, null, "dead restore cannot replay rain");
  game.disposeAudio();
  assert.equal(context.closeCount, 1);
  assert.equal(mixer.voices.size, 0);
});

test("real Game rejects a weather owner replaced during travel inspection before source departure", async (t) => {
  const f = await weatherGame(t), { game } = f;
  await f.rainy(); f.frame();
  const old = game.weatherServices, world = game.world, epoch = world.epoch;
  const replacement = new GameWeatherServices({ world });
  const prepare = game.travel.worldFactory;
  const { createTravelPreviewWorld } = await import("../src/game-travel-stage.js");
  game.travel.worldFactory = (source, dimension) => {
    game.weatherServices = replacement;
    return (prepare ?? createTravelPreviewWorld)(source, dimension);
  };
  t.after(() => {
    replacement.dispose();
    old.dispose();
  });
  const result = await game.travel.teleport({ x: 8.5, y: 65, z: 8.5, dimension: "nether" });
  assert.equal(result.ok, false);
  assert.match(result.message, /owners were replaced/);
  assert.equal(world.epoch, epoch);
  assert.equal(world.dimension, "overworld");
  const elapsed = old.state.elapsed;
  f.frame();
  assert.equal(old.state.elapsed, elapsed);
  assert.equal(game.audioEngine.rainVoice, null);
  assert.equal(old.renderer.object.visible, false);
  assert.equal(replacement.state.elapsed, 0);
  game.weatherServices = old;
});

test("late Wildlife death silences rain before the same real Game draw", async (t) => {
  const f = await weatherGame(t), { game } = f;
  await f.rainy(); f.frame();
  assert.ok(game.audioEngine.rainVoice);
  const update = game.wildlife.update;
  t.mock.method(game.wildlife, "update", function (...args) {
    const result = Reflect.apply(update, this, args);
    game.gameplay.damage(100, "test late weather death");
    return result;
  });
  let observed;
  const render = game.graphics.render;
  t.mock.method(game.graphics, "render", function () {
    observed = {
      rain: game.weatherServices.renderer.object.visible,
      audio: game.audioEngine.rainVoice,
    };
    return Reflect.apply(render, this, []);
  });
  f.frame();
  assert.deepEqual(observed, { rain: false, audio: null });
  const elapsed = game.weatherServices.state.elapsed;
  f.frame(2);
  assert.equal(game.weatherServices.state.elapsed, elapsed);
});
