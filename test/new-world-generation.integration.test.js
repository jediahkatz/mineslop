import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { VoxelGame } from "../src/game.js";
import { GameTravel } from "../src/game-travel.js";
import { stageWorld } from "../src/game-world-stage.js";
import { Gameplay } from "../src/gameplay.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { normalizeSave, WorldStorage } from "../src/storage.js";
import { createGenerator } from "../src/terrain.js";
import { TransitionGate } from "../src/transition-gate.js";
import { World } from "../src/world.js";

// CPU-only host: native Game preparation, World admission and IndexedDB writes.
// Only the final renderer installation and old-world checkpoint are adapters.
async function fixture(t) {
  const previousWindow = globalThis.window, previousRAF = globalThis.requestAnimationFrame;
  globalThis.window = { confirm: () => true };
  globalThis.requestAnimationFrame = (callback) => queueMicrotask(() => callback(0));
  const storage = new WorldStorage({ indexedDB: new IDBFactory(), name: "new-world-test" });
  const oldWorld = new World("original-save", { useWorker: false });
  const oldGameplay = new Gameplay();
  const originalArchive = { version: 3, world: oldWorld.serialize(), gameplay: oldGameplay.serialize(), quality: "low", soundEnabled: false };
  await storage.save(originalArchive);
  const stages = [], writes = [], messages = [], optionsSeen = [];
  const game = Object.create(VoxelGame.prototype);
  Object.assign(game, {
    world: oldWorld, gameplay: oldGameplay, storage,
    player: { unlock() {} }, quality: "low", soundEnabled: false,
    controlPreferences: { inputMode: "remote", sensitivity: 1.2 },
    viewPreferences: { fullbrightInspection: false, showFps: true },
    currentTime: 0.62, started: true, paused: true, building: false,
    transitionGate: new TransitionGate(),
    ui: { setLoading() {}, ready() {}, showMenu() {}, toast: (text) => messages.push(text) },
    closeScreens: async () => true, resetActions() {}, refreshHud() {},
    resetSwimmingPresentation() {},
    showError() { assert.fail("recoverable preparation/write failure must not destroy old UI/resources"); },
    async save() {
      try { await storage.save(originalArchive); return { ok: true }; }
      catch (error) { return { ok: false, message: error.message, code: error.code }; }
    },
    async prepareWorld(seed, saved, options) {
      optionsSeen.push(options);
      const staged = await VoxelGame.prototype.prepareWorld.call(this, seed, saved, options);
      stages.push(staged);
      return staged;
    },
    async installPreparedWorld(staged, _saved, validate, publish) {
      validate?.();
      assert.equal(staged.world._generatorFactory, createGenerator);
      assert.ok(staged.world.chunks.size > 0);
      // No renderer, generated cell edits, injected inventory, or real browser DB.
      const activate = () => {
        this.world = staged.world;
        this.gameplay = staged.gameplay;
        this.player = { ...staged.pose, unlock() {} };
        this.quality = staged.quality;
        this.currentTime = staged.buildingServices.worldClock.time;
      };
      if (publish) await publish(activate);
      else activate();
      this.building = false;
    },
  });
  game.travel = new GameTravel(game);
  const save = storage.save.bind(storage);
  storage.save = async (snapshot) => {
    writes.push(snapshot.world.generatorVersion);
    return save(snapshot);
  };
  const replace = storage.replace.bind(storage);
  storage.replace = (snapshot, activate) => {
    writes.push(snapshot.world.generatorVersion);
    return replace(snapshot, activate);
  };
  t.after(() => {
    for (const staged of stages.reverse()) staged.dispose();
    oldWorld.dispose();
    oldGameplay.dispose();
    storage.database?.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRAF;
  });
  return { game, storage, originalArchive, oldWorld, oldGameplay, stages, writes, messages, optionsSeen };
}

test("real New World stages native Expanded, persists 7, and reloads its actual pose/spec", { timeout: 180000 }, async (t) => {
  const f = await fixture(t), preferences = [f.game.controlPreferences, f.game.viewPreferences];
  const result = await f.game.newWorld("  cedar-valley  ", 7);
  assert.equal(result.ok, true, result.message);
  assert.equal(f.optionsSeen[0].generatorVersion, 7);
  assert.equal(f.game.world.seed, "cedar-valley");
  assert.equal(f.game.world.generatorVersion, 7);
  assert.equal(f.game.world.minY, -64);
  assert.equal(f.game.world.maxY, 320);
  assert.deepEqual(f.writes, [3, 7]);
  const saved = await f.storage.load();
  assert.equal(saved.world.generatorVersion, 7);
  assert.equal(saved.quality, "low");
  assert.equal(saved.soundEnabled, false);
  const normalized = { ...saved, ...normalizeWorldComponents(saved) };
  const reload = await f.game.prepareWorld(saved.world.seed, normalized, { generatorVersion: 3 });
  assert.equal(reload.world.generatorVersion, 7, "saved version wins over new-world choice");
  assert.deepEqual(reload.pose, f.stages[0].pose);
  assert.deepEqual([f.game.controlPreferences, f.game.viewPreferences], preferences);
  assert.equal(f.game.transitionGate.busy, false);
});

test("legacy newWorld(seed) stages native Classic 3 with existing seed fallback", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  f.game.gameplay.setMode("creative");
  assert.equal((await f.game.newWorld(" ")).ok, true);
  assert.equal(f.optionsSeen[0].generatorVersion, 3);
  assert.equal(f.game.world.generatorVersion, 3);
  assert.equal(f.game.world.seed, "cedar-valley");
  assert.equal(f.game.gameplay.mode, "creative");
  assert.equal((await f.storage.load()).world.generatorVersion, 3);
  assert.deepEqual(f.writes, [3, 3]);
});

test("cancel, busy gate and failed checkpoint leave old world/settings/archive untouched", async (t) => {
  const f = await fixture(t);
  window.confirm = () => false;
  assert.equal(await f.game.newWorld("replacement", 7), false);
  assert.deepEqual(f.writes, []);
  window.confirm = () => true;
  f.game.closeScreens = async () => false;
  assert.equal((await f.game.newWorld("replacement", 7)).ok, false);
  assert.deepEqual(f.writes, []);
  f.game.closeScreens = async () => true;
  const release = f.game.transitionGate.tryAcquire();
  assert.equal((await f.game.newWorld("replacement", 7)).ok, false);
  release();
  f.storage.save = async () => { throw new Error("Quota exceeded"); };
  assert.equal((await f.game.newWorld("replacement", 7)).ok, false);
  assert.equal(f.stages.length, 0);
  assert.equal(f.game.world, f.oldWorld);
  assert.equal(f.game.gameplay, f.oldGameplay);
  assert.equal(f.game.currentTime, 0.62);
  assert.equal(f.game.soundEnabled, false);
  assert.equal((await f.storage.load()).world.seed, "original-save");
});

test("failed preparation is nonfatal and preserves current resources and settings", async (t) => {
  const f = await fixture(t);
  f.game.prepareWorld = async () => { throw new Error("admission failed"); };
  const result = await f.game.newWorld("candidate", 7);
  assert.deepEqual(result, { ok: false, message: "admission failed" });
  assert.equal(f.game.world, f.oldWorld);
  assert.equal(f.game.gameplay, f.oldGameplay);
  assert.equal(f.game.building, false);
  assert.equal(f.game.quality, "low");
  assert.equal(f.game.currentTime, 0.62);
  assert.equal(f.game.transitionGate.busy, false);
  assert.equal((await f.storage.load()).world.seed, "original-save");
});

test("failed replacement write disposes native staged owners before old-world teardown", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  let disposed = 0;
  f.storage.replace = async () => {
    throw new Error("replacement quota exceeded");
  };
  const prepare = f.game.prepareWorld;
  f.game.prepareWorld = async (...args) => {
    const staged = await prepare.apply(f.game, args), dispose = staged.dispose;
    staged.dispose = () => { disposed++; return dispose(); };
    return staged;
  };
  const result = await f.game.newWorld("cedar-valley", 7);
  assert.equal(result.ok, false);
  assert.match(result.message, /replacement quota/);
  assert.equal(disposed, 1);
  assert.equal(f.game.world, f.oldWorld);
  assert.equal(f.game.gameplay, f.oldGameplay);
  assert.equal(f.game.currentTime, 0.62);
  assert.equal(f.game.soundEnabled, false);
  assert.equal(f.game.building, false);
  assert.equal(f.game.transitionGate.busy, false);
  assert.equal((await f.storage.load()).world.seed, "original-save");
});

test("owner changes during checkpoint refuse generation before any candidate admission", async (t) => {
  const f = await fixture(t);
  f.game.save = async () => {
    f.oldWorld.setDimension("nether");
    return { ok: true };
  };
  assert.equal((await f.game.newWorld("candidate", 7)).ok, false);
  assert.equal(f.stages.length, 0);
  assert.deepEqual(f.writes, []);
});

test("owner changes during native preparation refuse replacement before storage writes", { timeout: 90000 }, async (t) => {
  const f = await fixture(t), prepare = f.game.prepareWorld;
  let disposed = 0;
  f.game.prepareWorld = async (...args) => {
    const staged = await prepare.apply(f.game, args), dispose = staged.dispose;
    staged.dispose = () => { disposed++; return dispose(); };
    f.oldWorld.setDimension("nether");
    return staged;
  };
  assert.equal((await f.game.newWorld("candidate", 3)).ok, false);
  assert.equal(disposed, 1);
  assert.deepEqual(f.writes, [3], "only the original checkpoint was written");
  assert.equal((await f.storage.load()).world.seed, "original-save");
  assert.equal(f.game.world, f.oldWorld);
  assert.equal(f.game.building, false);
});

test("final install ownership rejection disposes the detached candidate, not live resources", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const staged = await f.game.prepareWorld("candidate", null, { generatorVersion: 3 });
  let disposed = 0;
  const dispose = staged.dispose;
  staged.dispose = () => { disposed++; return dispose(); };
  f.game.building = true;
  await assert.rejects(VoxelGame.prototype.installPreparedWorld.call(
    f.game, staged, null, () => { throw new Error("stale final owner"); },
  ), /stale final owner/);
  assert.equal(disposed, 1);
  assert.equal(f.game.world, f.oldWorld);
  assert.equal(f.game.gameplay, f.oldGameplay);
  assert.equal(f.game.building, false);
  assert.deepEqual(f.writes, []);
});

test("recorded archive versions 1–7 override the new-world selector during staging", async () => {
  // This bounded routing test uses a factory spy; native admission is proven above.
  for (let version = 1; version <= 7; version++) {
    const world = new World("saved-version", { generatorVersion: version, useWorker: false });
    const archive = normalizeSave({ version: 3, world: world.serialize() });
    world.dispose();
    let selected;
    await assert.rejects(stageWorld({
      seed: archive.world.seed, saved: archive, generatorVersion: version === 7 ? 3 : 7,
    }, { worldFactory(_seed, options) {
      selected = options.generatorVersion;
      throw new Error("stop before admission");
    } }), /stop before admission/);
    assert.equal(selected, version);
  }
});
