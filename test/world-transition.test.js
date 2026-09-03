import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";
import { GameTravel } from "../src/game-travel.js";
import { TransitionGate } from "../src/transition-gate.js";

function fixture(t) {
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: () => true };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const saving = Promise.withResolvers();
  const reading = Promise.withResolvers();
  const initializing = Promise.withResolvers();
  const traveling = Promise.withResolvers();
  const firstInitialization = Promise.withResolvers();
  const state = {
    saves: 0,
    fileReads: 0,
    initialized: [],
    activeInitializations: 0,
    activeTravels: 0,
    maxConcurrent: 0,
  };
  const game = {
    building: false,
    gameplay: { mode: "survival" },
    world: {
      seed: "original",
      dimension: "overworld",
      get: () => 0,
      isLoaded: () => true,
      isSolid: (_x, y) => y === 19,
      getBiome: () => ({ name: "Plains" }),
      setDimension(dimension) {
        this.dimension = dimension;
      },
      updateStreaming() {},
      async ensureArea() {
        state.activeTravels++;
        state.maxConcurrent = Math.max(
          state.maxConcurrent,
          state.activeTravels + state.activeInitializations
        );
        await traveling.promise;
        state.activeTravels--;
      },
    },
    player: {
      position: new Vector3(5.5, 20.01, 6.5),
      yaw: 0,
      pitch: 0,
      flying: false,
      unlock() {},
      update() {},
      setPosition(position) {
        this.position.set(position.x, position.y, position.z);
      },
    },
    graphics: { renderRadius: 1, rebuildDirty() {} },
    wildlife: { serialize: () => [], dispose() {} },
    mobStates: {},
    createWildlife() {},
    containerUI: { close() {} },
    ui: {
      closeInventory() {},
      closeAtlas() {},
      setLoading() {},
      ready() {},
      showMenu() {},
      toast() {},
    },
    refreshHud() {},
    showError(error) {
      throw error;
    },
    async save() {
      state.saves++;
      await saving.promise;
      return { ok: true };
    },
    async initialize(seed) {
      state.initialized.push(seed);
      state.activeInitializations++;
      state.maxConcurrent = Math.max(
        state.maxConcurrent,
        state.activeTravels + state.activeInitializations
      );
      game.building = true;
      firstInitialization.resolve();
      await initializing.promise;
      state.activeInitializations--;
      game.world.seed = seed;
      game.building = false;
    },
  };
  game.transitionGate = new TransitionGate();
  game.travel = new GameTravel(game);
  const archive = new GameArchive(game, {});
  archive.save = () => game.save();
  const file = {
    size: 200,
    text() {
      state.fileReads++;
      return reading.promise;
    },
  };
  const imported = {
    version: 2,
    world: {
      version: 2,
      generatorVersion: 2,
      dimension: "overworld",
      seed: "imported",
      edits: [],
    },
  };
  return {
    game,
    archive,
    file,
    imported,
    state,
    saving,
    reading,
    initializing,
    traveling,
    firstInitialization,
  };
}

for (const scenario of [
  "generate / generate",
  "import / generate",
  "import / travel",
]) {
  test(`${scenario} transitions never overlap`, async (t) => {
    const f = fixture(t);
    const first = scenario.startsWith("generate")
      ? VoxelGame.prototype.newWorld.call(f.game, "first")
      : f.archive.importWorld(f.file);
    // The first transition is still awaiting its save or file read.
    const second = scenario.endsWith("travel")
      ? VoxelGame.prototype.teleport.call(f.game, { x: 5, y: 20, z: 6 })
      : VoxelGame.prototype.newWorld.call(f.game, "second");
    f.reading.resolve(JSON.stringify(f.imported));
    f.saving.resolve();
    await f.firstInitialization.promise;
    f.traveling.resolve();
    f.initializing.resolve();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], { ok: true });
    assert.equal(results[1].ok, false);
    assert.match(results[1].message, /transition.*in progress/);
    assert.equal(
      f.state.maxConcurrent,
      1,
      "Only one world-changing operation may be active"
    );
    assert.deepEqual(f.state.initialized, [
      scenario.startsWith("generate") ? "first" : "imported",
    ]);
    assert.equal(f.state.saves, 2);
    assert.equal(f.state.fileReads, scenario.startsWith("import") ? 1 : 0);
    assert.equal(f.state.activeInitializations, 0);
    assert.equal(f.state.activeTravels, 0);
    assert.equal(f.game.transitionGate.busy, false);
  });
}
