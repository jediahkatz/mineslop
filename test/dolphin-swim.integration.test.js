import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { collidesWithWorld } from "../src/player.js";
import { dolphinSwimFixture, closePoint, neutralNextStep, SWIM_START } from "./dolphin-swim-fixture.js";
import { point } from "./game-mob-integration-fixture.js";

for (const ms of [1000 / 120, 1000 / 60, 50, 100, 500]) {
  test(`real Game consumes live Dolphin's Grace in ${ms}ms frames`, async (t) => {
    const f = await dolphinSwimFixture(t);
    f.swimStart();
    const baseline = f.frameMs(ms);
    assert.ok(baseline.before.z > baseline.after.z);
    f.key("KeyW", false);
    f.player.setPosition(SWIM_START);
    f.feed();
    f.swimStart();
    const terrain = f.world.serialize();
    // RAF subtraction can straddle ceil(dt / substep) at fractional ms.
    // Compare identical physical dt, not two almost-equal floating values.
    const dt = Math.min((f.game.lastFrame + ms - f.game.lastFrame) / 1000, 0.1);
    const expected = neutralNextStep(t, f, dt);
    const ordinary = f.player.position.z - expected.position.z;
    const boosted = f.frameMs(ms);
    const assisted = boosted.before.z - boosted.after.z;
    assert.equal(boosted.options.swimSpeedMultiplier, 1.6);
    assert.ok(Math.abs(assisted / ordinary - 1.6) < 1e-9);
    assert.ok(Math.abs(boosted.after.y - expected.position.y) < 1e-9, "no ascent boost");
    assert.deepEqual(f.world.serialize(), terrain, "movement never edits geometry");
    assert.equal(Object.hasOwn(f.player, "swimSpeedMultiplier"), false);
    t.diagnostic(`dt=${Math.min(ms / 1000, 0.1)}s normal=${ordinary.toFixed(9)} boosted=${assisted.toFixed(9)} ratio=1.6`);
  });
}

const invalidations = {
  "source death": (f) => {
    assert.equal(f.ecology.hurt(f.dolphin, 1000, null).killed, true);
    assert.equal(f.wildlife.byId.has(f.dolphin.id), false);
  },
  "source dormancy": (f) => {
    assert.equal(f.wildlife.suspendEcology(f.dolphin), true);
    assert.equal(f.dolphin.dormant, true);
  },
  "source leaves assistance range": (f) => {
    f.player.setPosition({ ...SWIM_START, x: 24.5 });
  },
  "life identity changes": (f) => {
    const life = f.progression.pearls.life;
    assert.equal(f.projectiles.cancel("respawn", { advanceLife: true }), true);
    assert.equal(f.progression.pearls.life, life + 1);
  },
  "missing ecology host": (f) => { f.game.ecologyServices = null; },
  "missing integration owner": (f) => { f.game.mobIntegration = null; },
  "suspended ecology host": (f) => { assert.equal(f.ecology.suspend(), true); },
};

for (const [name, invalidate] of Object.entries(invalidations)) {
  test(`${name} cannot leave a cached swim boost in the next Game update`, async (t) => {
    const f = await dolphinSwimFixture(t);
    f.feed();
    f.swimStart();
    f.frameMs();
    assert.ok(f.player.velocity.z < 0, "invalidate after real accelerated movement");
    const integration = f.game.mobIntegration, host = f.game.ecologyServices;
    t.after(() => {
      f.game.mobIntegration = integration;
      f.game.ecologyServices = host;
    });
    invalidate(f);
    // Deliberately retain a stale render observation. Physics must not read it.
    f.game.ecologyModifiers = Object.freeze({ swimSpeedMultiplier: 1.6 });
    const expected = neutralNextStep(t, f, 0.05);
    const update = f.frameMs();
    assert.equal(update.options.swimSpeedMultiplier ?? 1, 1);
    closePoint(f.player.position, expected.position);
    closePoint(f.player.velocity, expected.velocity);
  });
}

test("replacing Game's host with another active boosted host cannot lend its modifier", async (t) => {
  const f = await dolphinSwimFixture(t), other = await dolphinSwimFixture(t);
  f.feed();
  other.feed();
  f.swimStart();
  f.frameMs();
  const original = f.game.ecologyServices;
  t.after(() => { f.game.ecologyServices = original; });
  f.game.ecologyServices = other.ecology;
  assert.equal(other.ecology.active, true);
  assert.equal(other.ecology.modifiers().swimSpeedMultiplier, 1.6);
  const expected = neutralNextStep(t, f, 0.05);
  assert.equal(f.frameMs().options.swimSpeedMultiplier ?? 1, 1);
  closePoint(f.player.position, expected.position);
});

test("pause freezes movement and assistance clocks; source death is neutral on resume", async (t) => {
  const f = await dolphinSwimFixture(t);
  f.feed();
  f.swimStart();
  f.frameMs();
  f.game.paused = true;
  const position = point(f.player.position), assist = f.ecology.ecology.state(f.dolphin.id).assistTime;
  assert.equal(f.frameMs(), null);
  closePoint(f.player.position, position);
  assert.equal(f.ecology.ecology.state(f.dolphin.id).assistTime, assist);
  assert.equal(f.ecology.hurt(f.dolphin, 1000, null).killed, true);
  f.game.paused = false;
  const expected = neutralNextStep(t, f, 0.05);
  assert.equal(f.frameMs().options.swimSpeedMultiplier ?? 1, 1);
  closePoint(f.player.position, expected.position);
});

test("actual death and respawn retire assistance and never move a dead Player", async (t) => {
  const f = await dolphinSwimFixture(t);
  f.feed();
  f.swimStart();
  f.frameMs();
  const life = f.progression.pearls.life;
  f.gameplay.damage(1000, "swim test");
  assert.equal(f.gameplay.dead, true);
  assert.ok(f.progression.pearls.life > life);
  const position = point(f.player.position);
  assert.equal(f.frameMs(), null);
  closePoint(f.player.position, position);
  assert.equal(f.ecology.modifiers().swimSpeedMultiplier, 1);
  const respawn = await f.game.respawn();
  assert.equal(respawn.ok, true, respawn.message);
  f.game.paused = false;
  f.player.enabled = true;
  f.swimStart();
  const expected = neutralNextStep(t, f, 0.05);
  assert.equal(f.frameMs().options.swimSpeedMultiplier ?? 1, 1);
  closePoint(f.player.position, expected.position);
});

test("real dimension travel and return cannot reuse the previous dimension's boost", async (t) => {
  const f = await dolphinSwimFixture(t);
  f.feed();
  for (const dimension of ["nether", "overworld"]) {
    const travel = await f.game.travel.teleport({ x: 8.5, y: 73, z: 12.5, dimension });
    assert.equal(travel.ok, true, travel.message);
    assert.equal(f.ecology.active, true);
    assert.equal(f.ecology.effects.size, 0);
    f.game.paused = false;
    f.player.enabled = true;
    f.swimStart();
    const expected = neutralNextStep(t, f, 0.05);
    assert.equal(f.frameMs().options.swimSpeedMultiplier ?? 1, 1);
    closePoint(f.player.position, expected.position);
  }
});

test("water exit uses current physical sampling despite a stale boosted render projection", async (t) => {
  const f = await dolphinSwimFixture(t);
  f.feed();
  f.swimStart();
  f.frameMs();
  f.player.setPosition({ ...SWIM_START, y: 73 });
  assert.equal(f.player.sampleFluids().waterImmersion, 0);
  assert.equal(f.game.ecologyModifiers.swimSpeedMultiplier, 1.6);
  const expected = neutralNextStep(t, f, 0.05);
  assert.equal(f.frameMs().options.swimSpeedMultiplier ?? 1, 1);
  closePoint(f.player.position, expected.position);
});

test("boosted Game swimming respects a solid wall and does not tunnel at capped dt", async (t) => {
  const f = await dolphinSwimFixture(t);
  f.feed();
  // Put the wall behind the swimmer so it does not occlude the live dolphin.
  for (let x = 7; x <= 9; x++)
    for (let y = 65; y <= 72; y++) f.put(x, y, 14, BLOCK.STONE);
  f.player.setPosition({ ...SWIM_START, z: 13.68 });
  f.player.yaw = Math.PI;
  f.key("KeyW");
  assert.equal(f.ecology.modifiers().swimSpeedMultiplier, 1.6);
  const terrain = f.world.serialize();
  assert.equal(f.frameMs(500).options.swimSpeedMultiplier, 1.6);
  assert.ok(f.player.position.z <= 13.7);
  assert.equal(f.player.velocity.z, 0);
  assert.equal(collidesWithWorld(f.world, f.player.position), false);
  assert.deepEqual(f.world.serialize(), terrain);
});

test("boosted Game swimming cannot cross an unloaded chunk boundary", async (t) => {
  const f = await dolphinSwimFixture(t);
  f.feed();
  f.player.setPosition({ ...SWIM_START, x: 15.68, z: 9.5 });
  f.player.yaw = -Math.PI / 2;
  f.key("KeyW");
  f.world._removeChunk("1,0", f.world.chunks.get("1,0"));
  const terrain = f.world.serialize(), chunks = [...f.world.chunks.keys()];
  assert.equal(f.ecology.modifiers().swimSpeedMultiplier, 1.6);
  assert.equal(f.frameMs(100).options.swimSpeedMultiplier, 1.6);
  assert.ok(f.player.position.x <= 15.7);
  assert.equal(f.player.velocity.x, 0);
  assert.deepEqual([...f.world.chunks.keys()], chunks, "no movement-triggered generation");
  assert.deepEqual(f.world.serialize(), terrain);
});
