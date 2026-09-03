import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { VoxelGame } from "../src/game.js";
import { stageWorld } from "../src/game-world-stage.js";
import { findSafeLanding } from "../src/world-interactions.js";

// Authored lifecycle fixture, not natural-generation or visual-quality evidence.
function candidate({ ground = 10, minY = 0, maxY = 96 } = {}) {
  const calls = { disposed: 0, writes: 0, loaded: [] };
  const world = {
    dimension: "overworld",
    seed: "staged-world",
    generatorVersion: minY < 0 ? 4 : 3,
    spec: { minY, maxY, seaLevel: minY < 0 ? 63 : 24 },
    loadEdits: () => true,
    getSpawn: () => ({ x: 0.5, y: ground + 1.01, z: 0.5 }),
    isLoaded: () => true,
    get: (_x, y) => (y >= minY && y <= ground ? BLOCK.STONE : BLOCK.AIR),
    getBlockState: () => 0,
    getFluid: () => 0,
    isSolid: (_x, y) => y >= minY && y <= ground,
    getBiome: () => ({ id: "lush_caves", category: "cave" }),
    getCell(x, y, z) {
      if (y < minY || y >= maxY) return null;
      return { id: this.get(x, y, z), state: 0, fluid: 0 };
    },
    set() {
      calls.writes++;
      return true;
    },
    async ensureArea(position, radius) {
      calls.loaded.push({ position: { ...position }, radius });
    },
    dispose() {
      calls.disposed++;
    },
  };
  return { world, calls };
}

test("successful staging owns only a ready candidate and never builds a landing platform", async () => {
  const { world, calls } = candidate();
  const progress = [];
  const staged = await stageWorld(
    {
      seed: world.seed,
      quality: "low",
      onProgress: (value) => progress.push(value),
    },
    { worldFactory: () => world }
  );
  assert.equal(staged.world, world);
  assert.deepEqual(staged.pose.position, world.getSpawn());
  assert.equal(staged.pose.flying, false);
  assert.equal(staged.pose.pitch, -0.12);
  assert.deepEqual(calls.loaded, [{ position: world.getSpawn(), radius: 3 }]);
  assert.deepEqual(progress, [0.2, 0.65]);
  assert.equal(calls.disposed, 0, "the successful caller owns the candidate");
  assert.equal(calls.writes, 0);
});

test("valid saved high-flight poses restore exactly without a landing search", async () => {
  const { world, calls } = candidate();
  const player = {
    x: 12.25,
    y: 400.125,
    z: -9.75,
    yaw: -17.12,
    pitch: 0.4,
    flying: true,
  };
  const staged = await stageWorld(
    { seed: world.seed, mode: "creative", saved: { player } },
    {
      worldFactory: () => world,
      selectLanding: () =>
        assert.fail("a valid saved pose must not be relocated"),
    }
  );
  assert.equal(staged.restored, true);
  assert.deepEqual(staged.pose.position, {
    x: player.x,
    y: player.y,
    z: player.z,
  });
  assert.equal(staged.pose.yaw, player.yaw);
  assert.equal(staged.pose.pitch, player.pitch);
  assert.equal(staged.pose.flying, true);
  assert.equal(calls.disposed, 0);
  assert.equal(calls.writes, 0);
});

test("invalid edits, spawn failure and rejected terrain loading dispose only the candidate", async () => {
  for (const phase of ["edits", "spawn", "load"]) {
    const { world, calls } = candidate();
    const failure = new Error(`candidate ${phase} failed`);
    const saved = phase === "edits" ? { world: {} } : null;
    if (phase === "edits") world.loadEdits = () => false;
    if (phase === "spawn")
      world.getSpawn = () => {
        throw failure;
      };
    if (phase === "load")
      world.ensureArea = async () => {
        throw failure;
      };
    await assert.rejects(
      stageWorld({ seed: world.seed, saved }, { worldFactory: () => world }),
      phase === "edits" ? /terrain edits/ : (error) => error === failure
    );
    assert.equal(calls.disposed, 1);
    assert.equal(calls.writes, 0);
  }
});

test("a failed footprint is rejected without allowing terrain modification", async () => {
  const { world, calls } = candidate();
  await assert.rejects(
    stageWorld(
      { seed: world.seed },
      {
        worldFactory: () => world,
        selectLanding(_world, _origin, options) {
          assert.equal(options.allowPlatform, false);
          return null;
        },
      }
    ),
    /unobstructed player footprint/
  );
  assert.equal(calls.disposed, 1);
  assert.equal(calls.writes, 0);
});

test("nonmodifying landing search can fail cleanly and searches negative cave heights", () => {
  const empty = candidate({ ground: -100 });
  assert.equal(
    findSafeLanding(
      empty.world,
      { x: 0, y: 20, z: 0 },
      { allowPlatform: false }
    ),
    null
  );
  assert.equal(empty.calls.writes, 0);
  const deep = candidate({ ground: -40, minY: -64, maxY: 320 });
  const landing = findSafeLanding(
    deep.world,
    { x: 0, y: -45, z: 0 },
    { preferUnderground: true, allowPlatform: false }
  );
  assert.deepEqual(landing, { x: 0.5, y: -38.99, z: 0.5 });
  assert.equal(deep.calls.writes, 0);
});

test("failed candidate loading leaves the live Game and every existing resource intact", async (t) => {
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previous;
  });
  let disposals = 0;
  const owner = () => ({ dispose: () => disposals++ });
  const menus = [];
  const game = Object.create(VoxelGame.prototype);
  Object.assign(game, {
    started: true,
    paused: true,
    building: false,
    currentTime: 0.62,
    quality: "medium",
    world: owner(),
    player: { ...owner(), unlock() {} },
    wildlife: owner(),
    pickups: owner(),
    experienceOrbs: owner(),
    playerVisual: owner(),
    effects: owner(),
    graphics: owner(),
    gameplay: { mode: "creative", marker: "original inventory" },
    closeScreens: async () => true,
    resetActions() {},
    refreshHud() {},
    ui: {
      setLoading() {},
      ready() {},
      showMenu: (kind) => menus.push(kind),
    },
  });
  const original = {
    world: game.world,
    player: game.player,
    gameplay: game.gameplay,
  };
  const failure = new Error("worker admission failed");
  game.prepareWorld = async () => {
    throw failure;
  };
  await assert.rejects(
    game.initialize("candidate"),
    (error) => error === failure
  );
  assert.equal(game.world, original.world);
  assert.equal(game.player, original.player);
  assert.equal(game.gameplay, original.gameplay);
  assert.equal(game.currentTime, 0.62);
  assert.equal(game.building, false);
  assert.equal(game.paused, true);
  assert.equal(disposals, 0);
  assert.deepEqual(menus, ["pause"]);
});
