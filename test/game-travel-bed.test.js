import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { GameTravel, RESPAWN_LOAD_RADIUS } from "../src/game-travel.js";
import { TransitionGate } from "../src/transition-gate.js";
import { World } from "../src/world.js";
import { buildingFixture, placedBed } from "./building-fixture.js";

function travelFixture(f) {
  const game = f.game;
  const calls = { spawn: 0, loads: [], inspections: [], previews: [], toasts: [], wildlife: [], protection: [] };
  const hooks = { beforeInspection: null };
  f.player.world = f.world;
  game.transitionGate = new TransitionGate();
  game.mobStates = {};
  game.closeScreens = async () => true;
  game.save = async () => ({ ok: true });
  game.graphics.renderRadius = 3;
  game.ui = {
    setLoading() {},
    ready() {},
    showMenu() {},
    toast: (message) => calls.toasts.push(message),
  };
  const wildlife = () => ({
    dimension: f.world.dimension,
    entities: [],
    serialize: () => ({ marker: f.world.dimension }),
    dispose() {},
    protectSpawn(position) {
      calls.protection.push({
        position: { ...position }, dimension: this.dimension,
        dead: f.gameplay.dead, health: f.gameplay.health,
      });
    },
  });
  game.wildlife = wildlife();
  game.createWildlife = (saved, options) => {
    calls.wildlife.push({ saved, options });
    game.wildlife = wildlife();
  };
  const ensure = f.world.ensureArea.bind(f.world);
  f.world.ensureArea = async (position, radius) => {
    calls.loads.push({
      position: { ...position },
      radius,
      dimension: f.world.dimension,
    });
    return ensure(position, radius);
  };
  const worldFactory = (source, dimension) => {
    const preview = new World(source.seed, {
      dimension, generatorVersion: source.generatorVersion,
      generatorFactory: source._generatorFactory, useWorker: false,
    });
    assert.notEqual(preview, source);
    assert.notEqual(preview.coordinator, source.coordinator);
    calls.previews.push(preview);
    preview.getSpawn = () => {
      calls.spawn++;
      assert.equal(preview.dimension, "overworld");
      return { x: 8.5, y: 21.01, z: 8.5 };
    };
    const inspect = preview.ensureArea.bind(preview);
    preview.ensureArea = async (position, radius) => {
      calls.inspections.push({ position: { ...position }, radius, dimension: preview.dimension });
      await hooks.beforeInspection?.(preview, position, radius);
      return inspect(position, radius);
    };
    return preview;
  };
  const travel = new GameTravel(game, { worldFactory });
  return { game, travel, calls, hooks };
}

function die(f) {
  f.gameplay.dead = true;
  f.gameplay.health = 0;
}

test("valid bed respawn inspects the bounded footprint before moving the player once", async (t) => {
  const f = placedBed(t);
  assert.equal(f.actions.tryUse(f.foot).ok, true);
  const expected = f.beds.findRespawn(f.world);
  const { travel, calls, hooks } = travelFixture(f);
  die(f);
  const originalPosition = f.player.position.clone();
  const epoch = f.world.epoch;
  hooks.beforeInspection = (preview) => {
    assert.notEqual(preview, f.world);
    assert.equal(f.world.epoch, epoch);
    assert.deepEqual(f.player.position.clone(), originalPosition);
    assert.equal(f.calls.teleports.length, 0);
    assert.equal(f.gameplay.dead, true);
  };
  const ensure = f.world.ensureArea.bind(f.world);
  f.world.ensureArea = async (...args) => {
    assert.deepEqual(f.player.position.clone(), originalPosition);
    assert.equal(f.calls.teleports.length, 0);
    assert.equal(f.gameplay.dead, true);
    return ensure(...args);
  };
  const before = f.world.serialize();
  const result = await travel.respawn();
  assert.equal(result.ok, true);
  assert.equal(result.fromBed, true);
  assert.equal(f.calls.teleports.length, 1);
  assert.deepEqual(f.player.position.clone(), {
    x: expected.x,
    y: expected.y,
    z: expected.z,
  });
  assert.equal(calls.spawn, 0);
  assert.deepEqual(
    calls.loads.map(({ radius }) => radius),
    [RESPAWN_LOAD_RADIUS]
  );
  assert.deepEqual(calls.inspections.map(({ radius }) => radius), [RESPAWN_LOAD_RADIUS]);
  assert.equal(f.gameplay.dead, false);
  assert.equal(f.gameplay.health, 20);
  assert.deepEqual(f.world.serialize(), before);
  assert.equal(calls.wildlife[0].options, undefined);
  assert.deepEqual(calls.protection, [{
    position: f.player.position.clone(), dimension: "overworld", dead: false, health: 20,
  }], "spawn protection observes the successful Gameplay respawn");
  assert.ok(calls.previews.every((preview) => preview._disposed));
});

test("Nether and End deaths inspect and respawn at the Overworld bed without inspection teleports", async (t) => {
  for (const dimension of ["nether", "end"]) {
    const f = placedBed(t);
    assert.equal(f.actions.tryUse(f.head).ok, true);
    const expected = f.beds.findRespawn(f.world);
    f.world.setDimension(dimension);
    Object.assign(f.player.position, { x: 5.5, y: 40, z: 7.5 });
    const { travel, game, calls, hooks } = travelFixture(f);
    die(f);
    const before = f.player.position.clone();
    const epoch = f.world.epoch;
    hooks.beforeInspection = (preview) => {
      assert.equal(preview.dimension, "overworld");
      assert.equal(f.world.dimension, dimension, "destination inspection never switches the live source");
      assert.equal(f.world.epoch, epoch);
      assert.deepEqual(f.player.position.clone(), before);
      assert.equal(f.calls.teleports.length, 0);
    };
    const ensure = f.world.ensureArea.bind(f.world);
    f.world.ensureArea = async (...args) => {
      assert.equal(f.world.dimension, "overworld");
      assert.deepEqual(f.player.position.clone(), before);
      assert.equal(f.calls.teleports.length, 0);
      return ensure(...args);
    };
    const result = await travel.respawn();
    assert.equal(result.ok, true);
    assert.equal(result.fromBed, true);
    assert.equal(f.world.dimension, "overworld");
    assert.equal(f.calls.teleports.length, 1);
    assert.deepEqual(f.player.position.clone(), {
      x: expected.x,
      y: expected.y,
      z: expected.z,
    });
    assert.equal(calls.spawn, 0);
    assert.equal(calls.loads.length, 1);
    assert.equal(calls.inspections.length, 1);
    assert.deepEqual(game.mobStates[dimension], { marker: dimension });
  }
});

test("missing or obstructed beds fall back to world spawn without making platforms", async (t) => {
  for (const cause of ["missing", "roof", "exits"]) {
    const f = placedBed(t);
    f.actions.tryUse(f.foot);
    if (cause === "missing") f.put(2, 21, 2, BLOCK.AIR);
    if (cause === "roof") f.put(2, 22, 2, BLOCK.STONE);
    if (cause === "exits")
      for (let x = 1; x <= 3; x++)
        for (let z = 1; z <= 4; z++) {
          if (x === 2 && [2, 3].includes(z)) continue;
          for (const y of [21, 22]) f.put(x, y, z, BLOCK.STONE);
        }
    const { travel, calls } = travelFixture(f);
    die(f);
    const before = f.world.serialize();
    const result = await travel.respawn();
    assert.equal(result.ok, true, cause);
    assert.equal(result.fromBed, false, cause);
    assert.equal(calls.spawn, 1, cause);
    assert.equal(calls.inspections.length, 2, cause);
    assert.equal(calls.loads.length, 1, cause);
    assert.ok(
      [...calls.inspections, ...calls.loads].every(({ radius }) => radius === RESPAWN_LOAD_RADIUS)
    );
    assert.deepEqual(f.player.position.clone(), { x: 8.5, y: 21.01, z: 8.5 });
    assert.deepEqual(f.world.serialize(), before, cause);
    assert.match(calls.toasts.at(-1), /missing or obstructed/);
  }
});

test("without a bed, cross-dimension death uses one detached inspection and one bounded live load", async (t) => {
  const f = buildingFixture(t);
  f.floor();
  f.world.setDimension("nether");
  const { travel, calls } = travelFixture(f);
  die(f);
  const result = await travel.respawn();
  assert.equal(result.ok, true);
  assert.equal(result.fromBed, false);
  assert.equal(f.world.dimension, "overworld");
  assert.equal(calls.spawn, 1);
  assert.equal(calls.loads.length, 1);
  assert.equal(calls.inspections.length, 1);
  assert.deepEqual(f.player.position.clone(), { x: 8.5, y: 21.01, z: 8.5 });
});

test("an unavailable footprint restores the original dimension and leaves the dead player unmoved", async (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  f.world.setDimension("nether");
  const { travel, game, calls, hooks } = travelFixture(f);
  die(f);
  const before = f.player.position.clone();
  const edits = f.world.serialize();
  hooks.beforeInspection = async () => {
    throw new Error("unavailable footprint");
  };
  const result = await travel.respawn();
  assert.equal(result.ok, false);
  assert.match(result.message, /unavailable footprint/);
  assert.equal(f.world.dimension, "nether");
  assert.equal(f.gameplay.dead, true);
  assert.equal(f.gameplay.health, 0);
  assert.equal(f.calls.teleports.length, 0);
  assert.deepEqual(f.player.position.clone(), before);
  assert.deepEqual(f.world.serialize(), edits);
  assert.equal(calls.loads.length, 0);
  assert.equal(calls.previews[0]._disposed, true);
  assert.equal(game.building, false);
});

test("a blocked world spawn fails without reviving, moving or fabricating an arrival platform", async (t) => {
  const f = buildingFixture(t); // The designated spawn column has no floor.
  const { travel, calls } = travelFixture(f);
  die(f);
  const before = f.snapshot();
  const result = await travel.respawn();
  assert.equal(result.ok, false);
  assert.match(result.message, /standing space/);
  assert.equal(f.calls.teleports.length, 0);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(calls.loads.length, 0);
});

test("the transition gate stays held while loading a cross-dimension bed", async (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  f.world.setDimension("nether");
  const { travel, game, hooks } = travelFixture(f);
  die(f);
  let release, entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  hooks.beforeInspection = async () => {
    entered();
    await held;
  };
  const respawning = travel.respawn();
  await started;
  assert.equal(game.transitionGate.busy, true);
  const competing = await travel.teleport({
    x: 0,
    y: 30,
    z: 0,
    dimension: "end",
  });
  assert.equal(competing.ok, false);
  assert.match(competing.message, /transition/);
  assert.equal(f.calls.teleports.length, 0);
  release();
  assert.equal((await respawning).ok, true);
  assert.equal(game.transitionGate.busy, false);
});

test("replaced live owners abort inspection without teleporting or editing the replacement", async (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  const { travel, game, calls, hooks } = travelFixture(f);
  die(f);
  const replacement = { dimension: "end" };
  hooks.beforeInspection = async () => {
    game.world = replacement;
  };
  const result = await travel.respawn();
  assert.equal(result.ok, false);
  assert.equal(game.world, replacement);
  assert.deepEqual(replacement, { dimension: "end" });
  assert.equal(f.calls.teleports.length, 0);
  assert.equal(f.gameplay.dead, true);
  assert.equal(calls.loads.length, 0);
  assert.equal(calls.previews[0]._disposed, true);
});

test("a post-respawn save error cannot return a living player to the death dimension", async (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  f.world.setDimension("end");
  const { travel, game } = travelFixture(f);
  die(f);
  const error = new Error("save observer");
  game.save = async () => {
    throw error;
  };
  const result = await travel.respawn();
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, [error]);
  assert.equal(f.world.dimension, "overworld");
  assert.equal(f.gameplay.dead, false);
  assert.equal(f.gameplay.health, 20);
  assert.equal(f.calls.teleports.length, 1);
});

test("post-respawn renderer and HUD observers cannot skip the destination wildlife or ready state", async (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  f.world.setDimension("end");
  const { travel, game, calls } = travelFixture(f);
  die(f);
  const renderError = new Error("renderer observer");
  const hudError = new Error("HUD observer");
  let ready = 0;
  game.graphics.rebuildDirty = () => {
    throw renderError;
  };
  game.refreshHud = () => {
    throw hudError;
  };
  game.ui.ready = () => {
    ready++;
  };
  const result = await travel.respawn();
  assert.equal(result.ok, true);
  assert.equal(result.fromBed, true);
  assert.deepEqual(result.observerErrors, [renderError, hudError]);
  assert.equal(calls.wildlife.length, 1);
  assert.equal(game.wildlife.dimension, "overworld");
  assert.equal(ready, 1);
  assert.equal(game.building, false);
  assert.equal(f.gameplay.dead, false);
  assert.equal(f.calls.teleports.length, 1);
});
