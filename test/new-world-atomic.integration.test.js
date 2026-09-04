import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Scene, PerspectiveCamera, Vector3 } from "three";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { WorldStorage } from "../src/storage.js";
import { World } from "../src/world.js";
import { Gameplay } from "../src/gameplay.js";
import { GameArchive } from "../src/game-archive.js";
import * as playerModule from "../src/player.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Only presentation constructors are substituted. initialize, install, native
// admission/component staging and IndexedDB transactions remain production code.
let fault, resources = [];
class Presentation {
  constructor() { this.disposed = false; resources.push(this); }
  dispose() { this.disposed = true; }
}
class Renderer extends Presentation {
  constructor() {
    if (fault === "renderer") throw new Error("injected renderer construction");
    super();
    this.camera = new PerspectiveCamera();
    this.scene = new Scene();
    this.renderer = { domElement: {} };
  }
  setQuality() {}
  setFullbrightInspection() {}
  setTime() {}
  rebuildDirty() {}
  setBiome() {}
  update() {}
  render() { if (fault === "render") throw new Error("injected render"); }
}
class Player extends Presentation {
  constructor(_camera, world) {
    super(); this.world = world; this.position = new Vector3();
  }
  setPosition(p) { this.position.copy(p); }
  update() {}
  unlock() {}
}
class Pickups extends Presentation {
  load() { return true; }
  serialize() { return { version: 1, pickups: [] }; }
}
if (!mock.module) {
  // Keep the canonical `node --test test/*.test.js` runner usable without
  // enabling experimental module mocks for every unrelated test process.
  test("real installer atomic replacement fault matrix (isolated)", { timeout: 180000 }, () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--test", fileURLToPath(import.meta.url),
    ], { env, encoding: "utf8", timeout: 175000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
mock.module("../src/renderer.js", { namedExports: { GameRenderer: Renderer } });
mock.module("../src/player.js", { namedExports: { ...playerModule, Player } });
mock.module("../src/effects.js", { namedExports: { Effects: Presentation } });
mock.module("../src/player-visual.js", { namedExports: { PlayerVisual: Presentation } });
mock.module("../src/pickups.js", { namedExports: { Pickups } });
const { VoxelGame } = await import("../src/game.js");

async function records(storage) {
  const reader = new WorldStorage({ indexedDB: storage.indexedDB, name: storage.name });
  try {
    const { metadata, chunks } = await reader.readRecords();
    return JSON.stringify({ metadata, chunks });
  } finally { await reader.close(); }
}

async function fixture(t) {
  fault = null; resources = [];
  const previous = { window: globalThis.window, document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.window = { confirm: () => true };
  globalThis.document = { querySelector: () => ({}) };
  let frames = 0;
  const hooks = {};
  globalThis.requestAnimationFrame = (callback) => queueMicrotask(() => {
    hooks.frame?.(++frames); callback(0);
  });
  const storage = new WorldStorage({ indexedDB: new IDBFactory(), name: "atomic-new-world" });
  const oldWorld = new World("old-precious-world", { useWorker: false });
  const oldGameplay = new Gameplay();
  const archive = { version: 3, world: oldWorld.serialize(),
    gameplay: oldGameplay.serialize(), quality: "low", soundEnabled: false, time: 0.62 };
  await storage.save(archive);
  const before = await records(storage), stages = [];
  const game = Object.create(VoxelGame.prototype);
  Object.assign(game, {
    world: oldWorld, gameplay: oldGameplay, storage,
    player: new Player(null, oldWorld), quality: "low", soundEnabled: false,
    viewPreferences: { fullbrightInspection: true, showFps: true },
    controlPreferences: { inputMode: "remote", sensitivity: 1.2 },
    started: true, building: false, paused: true, elapsed: 0, currentTime: 0.62,
    ui: { setLoading() {}, ready() {}, showMenu() {}, updateHurt() {}, toast() {} },
    closeScreens: async () => true, resetActions() {}, refreshHud() {},
    resetSwimmingPresentation() {}, scheduleSave() {},
    bindWorldServiceEvents() {}, applyVehiclePose() { return false; }, select() {},
    renderWeather() {},
    async prepareWorld(...args) {
      const staged = await VoxelGame.prototype.prepareWorld.apply(this, args);
      stages.push(staged);
      // Service staging is real; their presentation binding is isolated from GPU.
      staged.mobIntegration.install = (host) => {
        if (fault === "activation") throw new Error("injected activation");
        host.mobIntegration = staged.mobIntegration;
        return true;
      };
      staged.mobIntegration.activate = () => true;
      for (const key of ["vehicleServices", "buildingServices", "fluidServices",
        "gravityServices", "projectileServices", "progressionIntegration",
        "explorationServices", "weatherServices"]) {
        if (staged[key]) staged[key].activate = (host) => {
          host[key] = staged[key]; return { ok: true };
        };
      }
      return staged;
    },
  });
  game.archive = new GameArchive(game, storage);
  const validate = () => {
    if (oldWorld.dimension !== "overworld") throw new Error("injected stale owner");
  };
  t.after(async () => {
    for (const stage of stages) stage.dispose();
    for (const resource of resources) resource.dispose();
    oldWorld.dispose(); oldGameplay.dispose();
    await storage.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { game, storage, archive, before, oldWorld, oldGameplay, stages, hooks,
    run: () => game.initialize("candidate-world", null,
      { generatorVersion: 3, persistNewWorld: true, validate }) };
}

for (const kind of ["post-write-owner", "final-frame-owner", "renderer", "activation", "render", "final-commit"]) {
  test(`failed replacement preserves exact durable records: ${kind}`, { timeout: 90000 }, async (t) => {
    const f = await fixture(t);
    const preferences = JSON.stringify([f.game.controlPreferences, f.game.viewPreferences]);
    if (kind === "post-write-owner") {
      const put = IDBObjectStore.prototype.put;
      t.mock.method(IDBObjectStore.prototype, "put", function (value) {
        const result = put.call(this, value);
        if (this.name === "worlds" && value.snapshot?.world.seed === "candidate-world")
          f.oldWorld.setDimension("nether");
        return result;
      });
    } else if (kind === "final-frame-owner") {
      f.hooks.frame = (n) => { if (n === 2) f.oldWorld.setDimension("nether"); };
    } else if (kind === "final-commit") {
      const put = IDBObjectStore.prototype.put;
      t.mock.method(IDBObjectStore.prototype, "put", function (value) {
        const result = put.call(this, value);
        if (this.name === "worlds" && value.snapshot?.world.seed === "candidate-world")
          result.addEventListener("success", () => this.transaction.abort(), { once: true });
        return result;
      });
    } else fault = kind;
    await assert.rejects(f.run(), /injected|interrupted/);
    assert.equal(await records(f.storage), f.before, "archive bytes, revision and timestamp stay unchanged");
    const reader = new WorldStorage({ indexedDB: f.storage.indexedDB, name: f.storage.name });
    const restored = await reader.load();
    await reader.close();
    assert.equal(restored.world.seed, "old-precious-world");
    assert.equal(restored.soundEnabled, false);
    assert.equal(JSON.stringify([f.game.controlPreferences, f.game.viewPreferences]), preferences);
    assert.equal(f.stages[0].world._disposed, true, "candidate terrain released");
    assert.equal(f.stages[0].world.coordinator.budget.totalBytes, 0, "candidate owner reservations released");
    if (kind === "final-commit")
      assert.equal(f.oldWorld._disposed, true, "fault occurs after full activation");
    if (!f.oldWorld._disposed) {
      assert.equal(f.game.world, f.oldWorld);
      assert.equal(f.game.gameplay, f.oldGameplay);
    } else {
      assert.equal(f.game.world, null, "failed candidate cannot be autosaved");
      assert.equal(f.game.player, null);
      assert.equal(f.game.failed, true);
      assert.equal((await f.game.archive.save()).ok, false);
      assert.ok(resources.every((r) => r.disposed), "all constructed presentation resources released");
    }
    // Exercise native saved-world staging AND the real installer on a fresh
    // reload host, not just JSON parsing. No rollback writes or item injection.
    fault = null;
    const reload = Object.assign(Object.create(VoxelGame.prototype), f.game, {
      world: null, gameplay: null, player: null, failed: false, started: false,
    });
    await reload.initialize(restored.world.seed, restored);
    assert.equal(reload.world.seed, "old-precious-world");
    assert.equal(reload.world.generatorVersion, restored.world.generatorVersion);
    assert.equal(reload.gameplay.mode, "survival");
    assert.deepEqual(reload.gameplay.serialize().slots, f.archive.gameplay.slots);
    assert.equal(reload.currentTime, 0.62);
    assert.equal(reload.soundEnabled, false);
    assert.equal(await records(f.storage), f.before, "reload recovery never writes");
  });
}

test("newer cross-tab revision rejects before teardown and recovery never overwrites it", async (t) => {
  const f = await fixture(t);
  const other = new WorldStorage({ indexedDB: f.storage.indexedDB, name: f.storage.name });
  t.after(() => other.close());
  await other.load();
  const latest = structuredClone(f.archive);
  latest.time = 0.8;
  const prepare = f.game.prepareWorld;
  let newer;
  f.game.prepareWorld = async (...args) => {
    const staged = await prepare.apply(f.game, args);
    await other.save(latest);
    newer = await records(other);
    return staged;
  };
  await assert.rejects(f.run(), { code: "STALE_WORLD" });
  assert.equal(f.game.world, f.oldWorld);
  assert.equal(f.oldWorld._disposed, false);
  assert.equal(f.stages[0].world._disposed, true);
  assert.equal(await records(f.storage), newer);
  await assert.rejects(f.storage.save(f.archive), { code: "STALE_WORLD" });
  assert.equal(await records(f.storage), newer);
});

test("cross-tab write queued during failed activation survives reload recovery", async (t) => {
  const f = await fixture(t);
  const other = new WorldStorage({ indexedDB: f.storage.indexedDB, name: f.storage.name });
  t.after(() => other.close());
  await other.load();
  const latest = structuredClone(f.archive);
  latest.time = 0.9;
  let concurrent;
  const prepare = f.game.prepareWorld;
  f.game.prepareWorld = async (...args) => {
    const staged = await prepare.apply(f.game, args);
    staged.mobIntegration.install = () => {
      concurrent = other.save(latest);
      throw new Error("injected activation with concurrent writer");
    };
    return staged;
  };
  await assert.rejects(f.run(), /injected activation/);
  await concurrent;
  const newer = await records(other);
  assert.equal(f.game.world, null);
  assert.equal((await f.game.archive.save()).ok, false);
  assert.equal(await records(f.storage), newer);
  await assert.rejects(f.storage.save(f.archive), { code: "STALE_WORLD" });
  assert.equal((await other.load()).time, 0.9);
});

test("successful activation commits once, stays blocked until commit, and observer failure is not replacement failure", async (t) => {
  const f = await fixture(t);
  const prepare = f.game.prepareWorld;
  let saveWhileActivating;
  f.game.prepareWorld = async (...args) => {
    const staged = await prepare.apply(f.game, args);
    const install = staged.mobIntegration.install;
    staged.mobIntegration.install = (host) => {
      assert.equal(host.building, true);
      saveWhileActivating = host.archive.save();
      return install(host);
    };
    return staged;
  };
  f.game.ui.ready = () => { throw new Error("optional UI observer"); };
  t.mock.method(console, "error", () => {});
  await f.run();
  assert.equal((await saveWhileActivating).ok, false);
  assert.equal(f.game.world.seed, "candidate-world");
  assert.equal(f.game.building, false);
  assert.equal(f.oldWorld._disposed, true);
  assert.equal((await f.storage.load()).world.seed, "candidate-world");
});

test("invalid direct new-world initialization rejects before screens, admission or writes", async () => {
  const host = new Proxy({}, { get() { assert.fail("invalid version touched game"); } });
  for (const generatorVersion of [null, "7", 1, 4, {}, NaN])
    await assert.rejects(VoxelGame.prototype.initialize.call(host, "bad", null,
      { persistNewWorld: true, generatorVersion }), RangeError);
});

test("post-teardown failure exposes reload recovery and retires pending UI callbacks", async (t) => {
  const f = await fixture(t);
  fault = "renderer";
  const error = await f.run().then(() => assert.fail("expected renderer failure"), (error) => error);
  assert.equal(error.reloadRequired, true);
  const element = (tag) => ({
    tag, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  const root = element("root");
  document.createElement = element;
  document.querySelector = () => root;
  let uiDisposed = false, reloaded = false;
  f.game.ui.dispose = () => { uiDisposed = true; };
  const oldLocation = globalThis.location;
  globalThis.location = { reload() { reloaded = true; } };
  t.after(() => {
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  });
  t.mock.method(console, "error", () => {});
  f.game.showError(error);
  assert.equal(uiDisposed, true);
  const button = root.children[0].children.find((child) => child.tag === "button");
  assert.equal(button.textContent, "Reload saved world");
  button.onclick();
  assert.equal(reloaded, true);
  assert.equal((await f.game.archive.save()).ok, false);
  assert.equal(await records(f.storage), f.before);
});
}
