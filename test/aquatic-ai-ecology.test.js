import assert from "node:assert/strict";
import test from "node:test";
import {
  admitEcologySpawn,
  ecologyBodySample,
  ecologyCanOccupy,
  ecologySupportAt,
  findDolphinGuide,
  guardianRetaliation,
  moveEcologyMob,
  stepAquaticMob,
} from "../src/aquatic-ai.js";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { ecologyCollider, ECOLOGY_LIMITS } from "../src/expansion-ecology.js";
import { sampleFluid } from "../src/fluid-sampling.js";
import {
  ecologyFixture,
  ecologyMob,
  ecologyState,
  ecologyWorld,
  monumentFixture,
  solidWall,
} from "./ecology-fixtures.js";

test("admission includes underwater hostiles and requires actual light/monument metadata", () => {
  const world = ecologyWorld();
  const { ctx } = ecologyFixture({ world });
  const position = { x: 0.5, y: 2, z: 0.5 };
  assert.equal(admitEcologySpawn("drowned", position, ecologyCollider("drowned"), ctx), true);
  for (const patch of [{ blockLight: 1 }, { blockLight: undefined }, { biomeId: "plains" }])
    assert.equal(admitEcologySpawn("drowned", position, ecologyCollider("drowned"), { ...ctx, ...patch }), false);
  assert.equal(admitEcologySpawn("drowned", position, ecologyCollider("drowned"),
    { ...ctx, timeOfDay: 0.5, skyLight: 15 }), false);
  assert.equal(admitEcologySpawn("drowned", position, ecologyCollider("drowned"),
    { ...ctx, timeOfDay: 0.5, skyLight: 3 }), true, "a shaded underwater context can admit at daytime");
  assert.equal(admitEcologySpawn("dolphin", position, ecologyCollider("dolphin"),
    { ...ctx, biomeId: "frozen_ocean" }), false);
  assert.equal(admitEcologySpawn("guardian", position, ecologyCollider("guardian"), ctx), false);
  const { structure, markers } = monumentFixture();
  assert.equal(admitEcologySpawn("guardian", position, ecologyCollider("guardian"),
    { ...ctx, structure }), true);
  assert.equal(admitEcologySpawn("guardian", { ...position, x: 25 }, ecologyCollider("guardian"),
    { ...ctx, structure }), false);
  const marker = markers[0];
  const elderPosition = { x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5 };
  assert.equal(admitEcologySpawn("elder_guardian", elderPosition, ecologyCollider("elder_guardian"),
    { ...ctx, structure, marker }), true);
  assert.equal(admitEcologySpawn("elder_guardian", elderPosition, ecologyCollider("elder_guardian"), {
    ...ctx, world: ecologyWorld({ dimension: "nether" }), structure, marker,
  }), false, "an Overworld marker cannot admit an elder into another dimension");
  assert.equal(world.unloadedReads, 0);
});

test("the injectable rich sampler preserves shared partial-water shapes and fails closed", () => {
  const world = ecologyWorld({ water: () => -1 });
  world.setCell(0, 1, 0, { id: BLOCK.OAK_SLAB, state: 0, fluid: FLUID.WATER_SOURCE });
  const body = { radius: 0.2, height: 0.4, eyeHeight: 0.35 };
  const position = { x: 0.5, y: 1.5, z: 0.5 };
  let calls = 0;
  const provider = (...args) => { calls++; return sampleFluid(...args); };
  assert.equal(ecologyCanOccupy(world, position, body), true);
  const sample = ecologyBodySample(world, position, body, provider);
  assert.ok(sample.waterImmersion > 0.9);
  assert.equal(sample.canBreathe, false);
  assert.equal(calls, 1);
  assert.equal(ecologyBodySample(world, position, { ...body, radius: Infinity }), null);
  assert.equal(ecologyBodySample(world, position, body, () => null), null);
  assert.equal(ecologyBodySample(world, position, body, async () => sample), null);
  for (const field of ["loaded", "eyeLoaded"])
    assert.equal(ecologyBodySample(world, position, body, () => ({ ...sample, [field]: false })), null);
});

test("amphibious support uses a slab top and does not step into a cliff or missing column", () => {
  const world = ecologyWorld({ water: () => -1 });
  const collider = ecologyCollider("turtle", { scuteClaimed: false });
  world.setCell(0, 1, 0, { id: BLOCK.OAK_SLAB, state: 0, fluid: FLUID.NONE });
  assert.equal(ecologySupportAt(world, { x: 0.5, y: 1.5, z: 0.5 }, collider), 1.5);
  const cliff = ecologyWorld({ water: () => -10, ground: (x) => x < 1 ? 0 : -4 });
  const mob = ecologyMob("turtle", "cliff-turtle", { x: 0.5, y: 1, z: 0.5 });
  moveEcologyMob(cliff, mob, { x: 1, y: 0, z: 0 }, { collider });
  assert.ok(mob.position.x + collider.radius <= 1.00001);
  const frontier = ecologyWorld({ loaded: (x) => x < 1 });
  const swimmer = ecologyMob("dolphin", "frontier-dolphin", { x: 0, y: 2, z: 0.5 });
  moveEcologyMob(frontier, swimmer, { x: 2, y: 0, z: 0 }, { locomotion: "swimmer" });
  assert.ok(swimmer.position.x + swimmer.spec.radius <= 1);
  assert.equal(frontier.unloadedReads, 0);
  const before = { ...swimmer.position };
  assert.equal(moveEcologyMob(frontier, swimmer, { x: Infinity, y: 0, z: 0 }), false);
  assert.deepEqual(swimmer.position, before);
});

test("a gravid turtle climbs from water to its actual supported home beach without drowning", () => {
  const world = ecologyWorld({
    water: (x) => x < 0 ? 3 : -1,
    ground: (x) => x < 0 ? 0 : 3,
  });
  const state = ecologyState(world, "turtle", "shore-turtle", { x: -0.8, y: 3.7, z: 0.5 }, {
    homeBeach: { x: 1.5, y: 4, z: 0.5 }, gravid: true,
  });
  const f = ecologyFixture({ world, entries: [state] });
  const mob = f.mobs.get(state.id);
  f.ctx.player = { x: -2, y: 4, z: 0.5 };
  for (let i = 0; i < 50; i++) f.owner.update(mob, 0.1, f.ctx);
  assert.ok(mob.position.x > 0.4, "partial bank support allows completing a landing");
  assert.ok(mob.position.y >= 3.99);
  assert.equal(mob.swimming, false);
  assert.equal(f.hurt.length, 0, "turtles have no drowning timer on either shore");
});

test("dolphins deplete air, surface through shared water geometry and breathe", () => {
  const world = ecologyWorld({ water: () => 3 });
  const state = ecologyState(world, "dolphin", "breathing-dolphin", { x: 0, y: 2.9, z: 0 }, { air: 0.2 });
  const f = ecologyFixture({ world, entries: [state] });
  const mob = f.mobs.get(state.id);
  let pitchedUp = false;
  for (let i = 0; i < 12; i++) {
    f.owner.update(mob, 0.1, f.ctx);
    pitchedUp ||= mob.swimPitch < 0;
  }
  assert.equal(pitchedUp, true);
  assert.ok(f.owner.state(mob.id).air > ECOLOGY_LIMITS.dolphinAir - 2);
  assert.ok(mob.position.y > state.home.y);
  assert.equal(world.unloadedReads, 0);
});

test("a roof cancels a dolphin's air-pocket route; suffocation is bounded, not a teleport", () => {
  const world = ecologyWorld({ water: () => 3 });
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      world.setCell(x, 4, z, { id: BLOCK.STONE, state: 0, fluid: FLUID.NONE });
  const state = ecologyState(world, "dolphin", "roof-dolphin", { x: 0.5, y: 3, z: 0.5 }, { air: 0 });
  const f = ecologyFixture({ world, entries: [state] });
  const mob = f.mobs.get(state.id);
  for (let i = 0; i < 8; i++) f.owner.update(mob, 0.1, f.ctx);
  assert.equal(f.hurt.length, 1);
  assert.ok(mob.position.y + mob.spec.height <= 4.00001);
  assert.equal(f.owner.state(mob.id).air, 0);
});

test("guidance rejects invented kinds and is bounded and deterministic over descriptors", () => {
  const from = { x: 0, y: 2, z: 0 };
  const descriptor = (id, x, kind = "shipwreck") => ({
    id, kind, dimension: "overworld", origin: { x, y: 1, z: 0 },
  });
  const input = [descriptor("not-an-ocean-goal", 7, "village"), descriptor("far", 1000),
    descriptor("b", 12), descriptor("a", 12)];
  assert.equal(findDolphinGuide(from, "overworld", input).id, "a");
  assert.equal(findDolphinGuide(from, "nether", input), null);
  assert.equal(findDolphinGuide(from, "overworld", Array(8).fill(input[0]).concat(input[2])), null);
});

test("guardian beam requires a visible full charge, LOS and a current attackable target", () => {
  const world = ecologyWorld();
  const state = ecologyState(world, "guardian", "guardian-beam", { x: 0, y: 2, z: 0 });
  const f = ecologyFixture({ world, entries: [state] });
  f.ctx.player = { x: 8, y: 2, z: 0 };
  f.ctx.playerEye = { x: 8, y: 3.62, z: 0 };
  const mob = f.mobs.get(state.id);
  for (let i = 0; i < 12; i++) f.owner.update(mob, 0.1, f.ctx);
  assert.ok(mob.beamCharge > 0 && mob.beamCharge < 1);
  assert.equal(f.damage.length, 0);
  assert.deepEqual(mob.eyeTarget, f.ctx.playerEye);
  solidWall(world, 3);
  f.owner.update(mob, 0.1, f.ctx);
  assert.equal(mob.beamCharge, 0);
  assert.ok(f.beams.some((event) => event.phase === "cancel"));
  assert.equal(f.damage.length, 0);
  const open = ecologyFixture({ entries: [state] });
  open.ctx.player = f.ctx.player;
  open.ctx.playerEye = f.ctx.playerEye;
  const second = open.mobs.get(state.id);
  for (let i = 0; i < 28; i++) open.owner.update(second, 0.1, open.ctx);
  assert.equal(open.damage.length, 1);
  assert.ok(open.beams.findIndex((event) => event.phase === "charge") <
    open.beams.findIndex((event) => event.phase === "fire"));
});

test("guardian charges cancel on death/protection/dimension/life changes and renderer refusal", () => {
  for (const invalidate of [
    (f) => { f.ctx.health = 0; },
    (f) => { f.ctx.spawnProtected = true; },
    (f) => { f.ctx.mode = "creative"; },
    (f) => { f.ctx.playerDimension = "nether"; },
    (f) => { f.ctx.playerTargetKey = "player:life:2"; },
    (f) => { f.ctx.onBeam = () => false; },
  ]) {
    const world = ecologyWorld();
    const state = ecologyState(world, "guardian", "cancel-guardian", { x: 0, y: 2, z: 0 });
    const f = ecologyFixture({ world, entries: [state] });
    f.ctx.player = { x: 8, y: 2, z: 0 };
    f.ctx.playerEye = { x: 8, y: 3.62, z: 0 };
    const mob = f.mobs.get(state.id);
    for (let i = 0; i < 8; i++) f.owner.update(mob, 0.1, f.ctx);
    assert.ok(mob.beamCharge > 0);
    invalidate(f);
    f.owner.update(mob, 0.1, f.ctx);
    assert.ok(mob.beamCharge <= 0.05, "at most a new target's first telegraph frame");
    assert.equal(f.damage.length, 0);
  }
});

test("spikes retaliate only once per dealt melee hit when actually extended", () => {
  const world = ecologyWorld();
  const state = ecologyState(world, "guardian", "spike-guardian", { x: 0, y: 2, z: 0 });
  const f = ecologyFixture({ world, entries: [state] });
  f.ctx.player = { x: 2.8, y: 0.85, z: 0 };
  f.ctx.playerEye = { x: 2.8, y: 2.47, z: 0 };
  const mob = f.mobs.get(state.id);
  // Freeze cooldown pursuit against a fixed corner while still exercising the
  // pose-driven retaliation gate; no natural-fight/renderer claim is made.
  mob.spikesExtended = 0.2;
  const hit = { id: "melee-hit-1", kind: "melee", source: "player", dealt: 3 };
  assert.equal(guardianRetaliation(mob, hit, f.ctx), null);
  mob.spikesExtended = 1;
  assert.equal(guardianRetaliation(mob, { ...hit, kind: "projectile" }, f.ctx), null);
  assert.equal(guardianRetaliation(mob, { ...hit, dealt: 0 }, f.ctx), null);
  assert.equal(guardianRetaliation(mob, hit, f.ctx).kind, "thorns");
  assert.equal(guardianRetaliation(mob, hit, f.ctx), null);
});

test("unloaded residents freeze, huge dt stays bounded and pose targets stay finite", () => {
  let loaded = true;
  const world = ecologyWorld({ loaded: () => loaded });
  const state = ecologyState(world, "dolphin", "finite-dolphin", { x: 0, y: 2, z: 0 });
  const f = ecologyFixture({ world, entries: [state] });
  const mob = f.mobs.get(state.id);
  f.owner.update(mob, Number.MAX_VALUE, f.ctx);
  assert.ok(f.owner.state(mob.id).air >= state.air - 0.11);
  const before = f.owner.serialize();
  loaded = false;
  f.owner.update(mob, 0.1, f.ctx);
  assert.deepEqual(f.owner.serialize(), before);
  assert.equal(world.unloadedReads, 0);
  assert.equal(mob.beamCharge, 0);
  assert.equal(mob.moving, false);
  loaded = true;
  const current = f.owner.state(mob.id);
  for (const value of [NaN, Infinity, -1, 0])
    stepAquaticMob(mob, value, { ...f.ctx, playerEye: { x: NaN, y: 0, z: 0 } }, current);
  assert.ok(Number.isFinite(mob.swimPitch));
  assert.ok(Number.isFinite(mob.beamCharge));
  assert.ok(Object.values(mob.position).every(Number.isFinite));
});
