import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { BLOCK, isSolid } from "../src/blocks.js";
import { FLUID, normalizeCell } from "../src/block-state.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { ITEM } from "../src/items.js";
import { boatBox } from "../src/boat-physics.js";
import { gameGravityOccupied } from "../src/gravity-occupancy.js";
import { FALLING_BLOCK_LIMITS as LIMITS } from "../src/falling-blocks.js";
import { gravityGame, stagedWorlds } from "./gravity-game-runtime.fixture.mjs";

const mass = (world, x = 3, z = 3) => {
  let result = 0;
  for (let y = 65; y < world.maxY; y++)
    if ([BLOCK.SAND, BLOCK.RED_SAND, BLOCK.GRAVEL].includes(world.get(x, y, z))) result++;
  return result;
};
function placeBoat(f) {
  const { game } = f;
  game.gameplay.add(ITEM.OAK_BOAT);
  game.gameplay.select(game.gameplay.hotbar.indexOf(ITEM.OAK_BOAT));
  for (let x = 11; x <= 14; x++)
    for (let z = 9; z <= 12; z++) f.put(x, 65, z, BLOCK.WATER);
  const placed = game.boats.place({ point: { x: 12.5, y: 65.5, z: 10.5 } });
  assert.equal(placed.ok, true, placed.reason);
  return placed.id;
}

test("actual initialize installs active gravity; Game placement/break wake and settle stacks", async (t) => {
  const f = await gravityGame(t), { game } = f, world = game.world;
  f.put(5, 67, 8, BLOCK.DIRT);
  game.gameplay.add(BLOCK.SAND, 2);
  game.gameplay.select(game.gameplay.hotbar.indexOf(BLOCK.SAND));
  for (const y of [67, 68]) {
    game.target = { x: 5, y, z: 8, id: world.get(5, y, 8), normal: { x: 0, y: 1, z: 0 } };
    assert.equal(game.useActions.place("main", BLOCK.SAND), true);
  }
  f.frame(4);
  assert.equal(world.get(5, 68, 8), BLOCK.SAND);
  const broken = game.harvestActions.break({ x: 5, y: 67, z: 8, id: BLOCK.DIRT });
  assert.equal(broken.ok, true);
  f.frame(15);
  assert.equal(world.get(5, 65, 8), BLOCK.SAND);
  assert.equal(world.get(5, 66, 8), BLOCK.SAND);
  assert.equal(mass(world, 5, 8), 2);
  assert.ok(f.saves > 0);
});

test("actual Game pauses/death/hidden freeze gravity; inventory overlay keeps simulation", async (t) => {
  const f = await gravityGame(t), { game, doc } = f;
  f.put(3, 74, 3, BLOCK.GRAVEL);
  for (const [owner, key] of [[game, "paused"], [game, "building"],
    [game, "failed"], [game.gameplay, "dead"], [doc, "hidden"]]) {
    owner[key] = true;
    f.frame(3);
    assert.equal(game.world.get(3, 74, 3), BLOCK.GRAVEL, key);
    owner[key] = false;
  }
  game.overlayChanged(true);
  assert.equal(game.active, false);
  assert.equal(game.simulating, true);
  f.frame(1);
  assert.equal(game.world.get(3, 73, 3), BLOCK.GRAVEL);
  game.overlayChanged(false);
  f.frame(12);
  assert.equal(game.world.get(3, 65, 3), BLOCK.GRAVEL);
});

test("generated-cell admission replay, eviction and normal archive reload conserve mass", async (t) => {
  const f = await gravityGame(t, { seed: "generated-gravity" }), { game } = f;
  assert.equal(mass(game.world), 3);
  assert.equal(game.world.edits.size, 0, "initial blocks are generator-owned");
  f.frame(85);
  assert.equal(game.world.get(3, 65, 3), BLOCK.SAND);
  assert.equal(mass(game.world), 3);
  f.put(3, 75, 3, BLOCK.GRAVEL);
  const old = game.world.chunks.get("0,0");
  game.world._removeChunk("0,0", old);
  f.frame(3);
  assert.equal(game.world.chunks.has("0,0"), false);
  game.world._generateSync(0, 0);
  f.frame(90);
  assert.equal(mass(game.world), 4);
  assert.equal(game.world.get(3, 68, 3), BLOCK.GRAVEL);
  f.put(3, 78, 3, BLOCK.GRAVEL);
  f.frame(1);
  const snapshot = game.snapshot();
  const retired = game.gravityServices;
  const retiredCoordinator = game.coordinator;
  await f.initialize(snapshot.world.seed, snapshot);
  assert.equal(retired._disposed, true);
  assert.equal(retiredCoordinator.usage(retired.gravity), undefined);
  assert.equal(retiredCoordinator.budget.totalBytes, 0);
  assert.notEqual(game.gravityServices, retired);
  f.frame(95);
  assert.equal(mass(game.world), 5);
  assert.equal(game.world.get(3, 69, 3), BLOCK.GRAVEL);
  assert.equal(Object.hasOwn(game.snapshot(), "gravity"), false);
});

test("native historical terrain sand/gravel survives support removal and real archive restoration", async (t) => {
  const f = await gravityGame(t, { seed: "native-gravity-cedar" }), { game } = f;
  const world = game.world;
  const desert = world.locateBiome("desert", game.player.position);
  assert.ok(desert, "native terrain supplies the desert test destination");
  const arrival = await game.travel.teleport(desert);
  assert.equal(arrival.ok, true, arrival.message);
  f.resume();
  let chosen;
  for (const chunk of world.chunks.values()) {
    for (let at = 0; at < chunk.blocks.length; at++) {
      const id = chunk.blocks[at];
      if (id !== BLOCK.SAND && id !== BLOCK.GRAVEL) continue;
      const x = chunk.cx * 16 + at % 16;
      const z = chunk.cz * 16 + Math.floor(at / 16) % 16;
      const y = world.minY + Math.floor(at / 256);
      if (y <= world.minY + 2 ||
          Math.hypot(x - game.player.position.x, z - game.player.position.z) < 4)
        continue;
      const support = world.get(x, y - 1, z);
      if ([BLOCK.AIR, BLOCK.BEDROCK, BLOCK.SAND, BLOCK.GRAVEL].includes(support)) continue;
      if (!isSolid(world.get(x, y - 2, z))) continue;
      chosen = { x, y, z, id };
      break;
    }
    if (chosen) break;
  }
  assert.ok(chosen, "native generator must supply an actual granular cell");
  const { x, y, z, id } = chosen;
  const count = () => {
    let total = 0;
    for (let cy = game.world.minY; cy < game.world.maxY; cy++)
      if ([BLOCK.SAND, BLOCK.RED_SAND, BLOCK.GRAVEL].includes(game.world.get(x, cy, z))) total++;
    return total;
  };
  const before = count();
  f.put(x, y - 1, z, BLOCK.AIR);
  f.frame(12);
  assert.equal(game.world.get(x, y - 1, z), id);
  assert.equal(count(), before);
  const saved = game.snapshot();
  await f.initialize(saved.world.seed, saved);
  f.frame(12);
  assert.equal(game.world.get(x, y - 1, z), id);
  assert.equal(count(), before);
});

test("read-only boat bounds include stationary unmounted hulls and reject malformed bounds", async (t) => {
  const f = await gravityGame(t), { game } = f;
  const id = placeBoat(f);
  const record = game.boats.serialize().boats.find((boat) => boat.id === id);
  const before = game.boats.serialize();
  assert.equal(game.boats.intersectsBounds(boatBox(record)), true);
  for (const bounds of [[1, 0, 0, 0, 1, 1], [0, 0, 0, Infinity, 1, 1], [], null])
    assert.equal(game.boats.intersectsBounds(bounds), true);
  assert.deepEqual(game.boats.serialize(), before);
  f.put(12, 67, 10, BLOCK.GRAVEL);
  f.frame(20);
  assert.equal(game.world.get(12, 66, 10), BLOCK.AIR, "cannot fall into the hull");
  assert.ok([66, 67].some((y) => game.world.get(12, y, 10) === BLOCK.GRAVEL));
  assert.equal(game.boats.mountFor(), null);
  assert.equal(game.boats.activeSize, 1);
  const archived = game.snapshot();
  archived.boats.boats[0].dimension = "nether";
  await f.initialize(archived.world.seed, archived);
  assert.equal(game.boats.size, 1);
  assert.equal(game.boats.activeSize, 0);
  assert.equal(game.boats.intersectsBounds(boatBox(record)), false);
});

test("player, horse and non-horse living bodies consistently suspend without crushing", async (t) => {
  const f = await gravityGame(t), { game } = f;
  const sheep = game.wildlife.spawn("sheep", { x: 3.5, y: 65, z: 3.5 }, { id: "sheep:gravity" });
  const horse = game.wildlife.spawn("horse", { x: 5.5, y: 65, z: 3.5 }, { id: "horse:gravity" });
  assert.ok(sheep && horse);
  const health = [sheep.health, horse.health, game.gameplay.health];
  for (const [x, z] of [[3, 3], [5, 3], [8, 11]]) f.put(x, 68, z, BLOCK.SAND);
  f.frame(8);
  assert.equal(game.world.get(3, 65, 3), BLOCK.AIR);
  assert.equal(game.world.get(5, 65, 3), BLOCK.AIR);
  assert.equal(game.world.get(8, 65, 11), BLOCK.AIR);
  assert.deepEqual([sheep.health, horse.health, game.gameplay.health], health);
  assert.equal(mass(game.world, 3, 3), 1);
  assert.equal(mass(game.world, 5, 3), 1);
});

test("late real horse dismount is consumed before gravity and the sole mesh budget", async (t) => {
  const f = await gravityGame(t), { game } = f;
  const horse = game.wildlife.spawn("horse", { x: 8.5, y: 65, z: 8.5 }, { id: "horse:exit" });
  assert.ok(horse);
  assert.equal(game.gameplay.inventoryTransaction((draft) => {
    draft.slots[game.gameplay.selected] = null;
    return true;
  }), true);
  const mounted = game.horses.mount(horse.id);
  assert.equal(mounted.ok, true, mounted.reason);
  assert.equal(game.applyVehiclePose(), true);
  const plan = game.horses.prepareDismount();
  assert.equal(plan.ok, true, plan.reason);
  let bx, by, bz;
  const events = [];
  const update = game.wildlife.update;
  t.mock.method(game.wildlife, "update", function (...args) {
    const result = Reflect.apply(update, this, args);
    if (game.horses.mountFor()) {
      const result = game.horses.dismount();
      assert.equal(result.ok, true, result.reason);
      events.push("exit-published");
      const { x, y, z } = result.exit.position;
      bx = Math.floor(x);
      bz = Math.floor(z);
      by = Math.ceil(y + 1.8);
      // Author the newly unsupported cube after the real exit selection, but
      // before Game consumes its pending handoff. Earlier gravity ordering
      // would see the old seated Player and allow this cell into the exit.
      f.put(bx, by, bz, BLOCK.SAND);
      assert.equal(game.player.seated, true);
      assert.equal(gameGravityOccupied(game,
        [bx, by - 1, bz, bx + 1, by + 1, bz + 1]), false);
    }
    return result;
  });
  const frame = game.gravityServices.frame;
  t.mock.method(game.gravityServices, "frame", function (...args) {
    assert.equal(game.player.seated, false);
    assert.equal(game.vehicleServices.takeExitPose(), null);
    events.push("gravity");
    return Reflect.apply(frame, this, args);
  });
  const budgets = game.graphics.budgets.length;
  f.frame();
  assert.deepEqual(events, ["exit-published", "gravity"]);
  assert.equal(game.world.get(bx, by, bz), BLOCK.SAND);
  assert.deepEqual(game.graphics.budgets.slice(budgets), [1]);
  assert.equal(gameGravityOccupied(game, [bx, by - 1, bz, bx + 1, by + 1, bz + 1]), true);
});

test("Game gravity and fluids retain tracked crops through real settlement/overflow", async (t) => {
  const f = await gravityGame(t), { game } = f;
  f.put(3, 64, 3, BLOCK.FARMLAND);
  game.gameplay.add(ITEM.SEEDS);
  game.gameplay.select(game.gameplay.hotbar.indexOf(ITEM.SEEDS));
  assert.equal(game.settlement.plant(game.world,
    { x: 3, y: 64, z: 3, id: BLOCK.FARMLAND }, game.gameplay), true);
  assert.equal(game.settlement.crops.size, 1);
  f.put(3, 66, 3, BLOCK.GRAVEL);
  const inventory = game.gameplay.serialize().slots;
  f.frame(1);
  assert.equal(game.world.get(3, 65, 3), BLOCK.GRAVEL,
    JSON.stringify({ gravity: game.gravityServices.diagnostics(),
      fluid: game.fluidServices.diagnostics() }));
  assert.equal(game.settlement.crops.size, 0);
  assert.ok(game.overflow.size > 0);
  const retained = game.overflow.serialize().entries.reduce((sum, entry) => sum + entry.count, 0);
  assert.ok(retained > 0);
  assert.deepEqual(game.gameplay.serialize().slots, inventory);
  f.put(4, 65, 3, { id: BLOCK.WATER, fluid: FLUID.WATER_SOURCE });
  f.put(4, 68, 3, BLOCK.SAND);
  f.frame(12);
  assert.equal(game.world.get(4, 65, 3), BLOCK.SAND);
  assert.equal(mass(game.world, 3, 3), 1);
  assert.equal(mass(game.world, 4, 3), 1);
  const remaining = [...game.overflow.serialize().entries, ...game.pickups.serialize().items]
    .reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(remaining, retained, "retained crop yield transfers, never duplicates");
});

test("full shared reservation defers generated mass and retries without duplicate loops", async (t) => {
  const f = await gravityGame(t, { seed: "generated-budget" }), { game } = f;
  const blocker = {};
  const bytes = MAX_RESERVED_BYTES - game.coordinator.budget.totalBytes;
  assert.equal(game.coordinator.register(blocker, bytes), true);
  t.after(() => game.coordinator.release(blocker));
  f.frame(80);
  assert.equal(mass(game.world), 3);
  assert.equal(game.world.get(3, 70, 3), BLOCK.SAND);
  game.coordinator.release(blocker);
  f.frame(20);
  assert.equal(game.world.get(3, 65, 3), BLOCK.SAND);
  assert.equal(mass(game.world), 3);
});

test("actual cross-dimension travel and failed destination rollback re-admit pending mass", async (t) => {
  const f = await gravityGame(t), { game } = f;
  f.put(3, 72, 3, BLOCK.SAND);
  const service = game.gravityServices;
  const sourceEpoch = game.world.epoch;
  const result = await game.travel.teleport({ x: 8.5, y: 65, z: 11.5, dimension: "nether" });
  assert.equal(result.ok, true, result.message);
  assert.equal(game.gravityServices, service);
  assert.ok(game.world.epoch > sourceEpoch);
  assert.equal(service.gravity._epoch, game.world.epoch);
  f.resume();
  f.put(3, 70, 3, BLOCK.GRAVEL);
  f.frame(10);
  assert.equal(game.world.get(3, 65, 3), BLOCK.GRAVEL);
  const returned = await game.travel.teleport({ x: 8.5, y: 65, z: 11.5, dimension: "overworld" });
  assert.equal(returned.ok, true, returned.message);
  f.resume();
  f.frame(90);
  assert.equal(game.world.get(3, 65, 3), BLOCK.SAND);
  f.put(4, 71, 3, BLOCK.SAND);
  const ensure = game.world.ensureArea;
  let refused = false;
  t.mock.method(game.world, "ensureArea", async function (...args) {
    if (this.dimension === "nether" && !refused) {
      refused = true;
      throw new Error("destination admission fixture refusal");
    }
    return Reflect.apply(ensure, this, args);
  });
  const failed = await game.travel.teleport({ x: 8.5, y: 65, z: 11.5, dimension: "nether" });
  assert.equal(failed.ok, false);
  assert.equal(failed.rollbackFailed, undefined);
  assert.equal(game.world.dimension, "overworld");
  assert.equal(service.gravity._epoch, game.world.epoch);
  f.resume();
  f.frame(90);
  assert.equal(game.world.get(4, 65, 3), BLOCK.SAND);
});

test("failed actual initialization stages preserve live gravity and release detached owners", async (t) => {
  const f = await gravityGame(t), { game } = f;
  f.put(3, 72, 3, BLOCK.GRAVEL);
  const source = game.world, service = game.gravityServices;
  const saved = game.snapshot();
  saved.world.seed = "gravity-invalid-stage";
  // Direct prepareWorld loads real owners; bypass normalization only to test its
  // own cleanup on a later malformed vehicle sidecar.
  saved.horses = { invalid: true };
  const start = stagedWorlds.length;
  await assert.rejects(game.prepareWorld(saved.world.seed, saved, { generatorVersion: 3 }));
  for (const world of stagedWorlds.slice(start)) {
    assert.equal(world._disposed, true);
    assert.equal(world.coordinator.budget.totalBytes, 0);
  }
  assert.equal(game.world, source);
  assert.equal(game.gravityServices, service);
  assert.equal(service.active, true);
  f.frame(12);
  assert.equal(source.get(3, 65, 3), BLOCK.GRAVEL);
});

test("commit-heavy real Game frames expose measured work, not a framerate claim", async (t) => {
  const f = await gravityGame(t), { game } = f;
  const changes = [];
  for (let z = 1; z < 8; z++)
    for (let x = 1; x < 15; x++)
      changes.push({ x, y: 85, z, before: game.world.getCell(x, 85, z),
        after: normalizeCell({ id: BLOCK.SAND }) });
  assert.equal(game.world.applyCells(changes), true);
  game.wildlife.spawn("sheep", { x: 12.5, y: 65, z: 13.5 }, { id: "sheep:load" });
  game.wildlife.spawn("horse", { x: 5.5, y: 65, z: 12.5 }, { id: "horse:load" });
  placeBoat(f);
  const frames = [], gravityTimes = [];
  const frame = game.gravityServices.frame;
  t.mock.method(game.gravityServices, "frame", function (...args) {
    const start = performance.now();
    const result = Reflect.apply(frame, this, args);
    gravityTimes.push(performance.now() - start);
    return result;
  });
  let commits = 0;
  const commit = game.coordinator.commit;
  t.mock.method(game.coordinator, "commit", function (participants) {
    if (participants.some((p) => p.owner === game.gravityServices.gravity)) commits++;
    return Reflect.apply(commit, this, [participants]);
  });
  let peakCommits = 0;
  for (let i = 0; i < 35; i++) {
    commits = 0;
    const start = performance.now();
    const budgets = game.graphics.budgets.length;
    f.frame();
    frames.push(performance.now() - start);
    peakCommits = Math.max(peakCommits, commits);
    const stats = game.gravityServices.diagnostics().last;
    assert.ok(commits <= LIMITS.mutationsPerUpdate);
    assert.ok(stats.prepared <= LIMITS.mutationsPerUpdate);
    assert.ok(stats.evaluated <= LIMITS.evaluationsPerTick);
    assert.ok(stats.scanCells <= LIMITS.scanCellsPerUpdate);
    assert.deepEqual(game.graphics.budgets.slice(budgets), [1]);
  }
  assert.equal(peakCommits, LIMITS.mutationsPerUpdate);
  const summary = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) };
  };
  console.log("GRAVITY_ACTIVE_OWNER_BENCHMARK", JSON.stringify({
    samples: frames.length, peakCommits, gravity: summary(gravityTimes),
    wholeFrame: summary(frames), boats: game.boats.activeSize,
    mobs: game.wildlife.entities.length, webgl: false,
  }));
});
