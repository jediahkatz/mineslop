import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { GameTravel, RESPAWN_LOAD_RADIUS } from "../src/game-travel.js";
import { TransitionGate } from "../src/transition-gate.js";
import { buildingFixture, placedBed } from "./building-fixture.js";

function travelFixture(f) {
  const game = f.game;
  const calls = { spawn: 0, loads: [], toasts: [], wildlife: [] };
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
  });
  game.wildlife = wildlife();
  game.createWildlife = (saved, options) => {
    calls.wildlife.push({ saved, options });
    game.wildlife = wildlife();
  };
  f.world.getSpawn = () => {
    calls.spawn++;
    assert.equal(f.world.dimension, "overworld");
    return { x: 8.5, y: 21.01, z: 8.5 };
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
  const travel = new GameTravel(game);
  return { game, travel, calls };
}

function die(f) {
  f.gameplay.dead = true;
  f.gameplay.health = 0;
}

test("valid bed respawn inspects the bounded footprint before moving the player once", async (t) => {
  const f = placedBed(t);
  assert.equal(f.actions.tryUse(f.foot).ok, true);
  const expected = f.beds.findRespawn(f.world);
  const { travel, calls } = travelFixture(f);
  die(f);
  const originalPosition = f.player.position.clone();
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
  assert.equal(f.gameplay.dead, false);
  assert.equal(f.gameplay.health, 20);
  assert.deepEqual(f.world.serialize(), before);
  assert.equal(calls.wildlife[0].options.safeSpawn, true);
});

test("Nether and End deaths inspect and respawn at the Overworld bed without inspection teleports", async (t) => {
  for (const dimension of ["nether", "end"]) {
    const f = placedBed(t);
    assert.equal(f.actions.tryUse(f.head).ok, true);
    const expected = f.beds.findRespawn(f.world);
    f.world.setDimension(dimension);
    Object.assign(f.player.position, { x: 5.5, y: 40, z: 7.5 });
    const { travel, game, calls } = travelFixture(f);
    die(f);
    const before = f.player.position.clone();
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
    assert.equal(calls.loads.length, 2, cause);
    assert.ok(
      calls.loads.every(({ radius }) => radius === RESPAWN_LOAD_RADIUS)
    );
    assert.deepEqual(f.player.position.clone(), { x: 8.5, y: 21.01, z: 8.5 });
    assert.deepEqual(f.world.serialize(), before, cause);
    assert.match(calls.toasts.at(-1), /missing or obstructed/);
  }
});

test("without a bed, cross-dimension death uses Overworld spawn and a single bounded load", async (t) => {
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
  assert.deepEqual(f.player.position.clone(), { x: 8.5, y: 21.01, z: 8.5 });
});

test("an unavailable footprint restores the original dimension and leaves the dead player unmoved", async (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  f.world.setDimension("nether");
  const { travel, game } = travelFixture(f);
  die(f);
  const before = f.player.position.clone();
  const edits = f.world.serialize();
  f.world.ensureArea = async () => {
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
  assert.equal(game.building, false);
});

test("a blocked world spawn fails without reviving, moving or fabricating an arrival platform", async (t) => {
  const f = buildingFixture(t); // The designated spawn column has no floor.
  const { travel } = travelFixture(f);
  die(f);
  const before = f.snapshot();
  const result = await travel.respawn();
  assert.equal(result.ok, false);
  assert.match(result.message, /standing space/);
  assert.equal(f.calls.teleports.length, 0);
  assert.deepEqual(f.snapshot(), before);
});

test("the transition gate stays held while loading a cross-dimension bed", async (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  f.world.setDimension("nether");
  const { travel, game } = travelFixture(f);
  die(f);
  let release, entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const ensure = f.world.ensureArea.bind(f.world);
  f.world.ensureArea = async (...args) => {
    entered();
    await held;
    return ensure(...args);
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
  const { travel, game } = travelFixture(f);
  die(f);
  const replacement = { dimension: "end" };
  f.world.ensureArea = async () => {
    game.world = replacement;
  };
  const result = await travel.respawn();
  assert.equal(result.ok, false);
  assert.equal(game.world, replacement);
  assert.deepEqual(replacement, { dimension: "end" });
  assert.equal(f.calls.teleports.length, 0);
  assert.equal(f.gameplay.dead, true);
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
