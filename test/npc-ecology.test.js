import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { animateAquaticMob } from "../src/aquatic-animation.js";
import { createAquaticModel } from "../src/aquatic-models.js";
import { stepAquaticMob } from "../src/aquatic-ai.js";
import { AQUATIC_KINDS } from "../src/aquatic-skins.js";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { ecologyCollider, ecologyDeathReward, ECOLOGY_SPECIES } from "../src/expansion-ecology.js";
import {
  admitNpcSpawn,
  captureVillagerTrade,
  normalizeVillagerAssignment,
  villagerAssignmentFromMarkers,
  villagerAssignmentFromTrader,
  villagerJobsiteUsable,
} from "../src/npc-ai.js";
import { animateNpcMob, createNpcModel, MAX_NPC_PARTS_PER_MODEL } from "../src/npc-models.js";
import { createNpcSkin, NPC_KINDS, paintNpcSkinFace } from "../src/npc-skins.js";
import {
  ecologyFixture,
  ecologyMob,
  ecologyState,
  ecologyWorld,
} from "./ecology-fixtures.js";

test("villagers expose work/home/flee intents without inventing stock or requiring a bed to trade", () => {
  const world = ecologyWorld({ water: () => -1 });
  world.setCell(3, 1, 0, { id: BLOCK.CHEST, state: 0, fluid: FLUID.NONE });
  const state = ecologyState(world, "villager", "farmer", { x: 1.5, y: 1, z: 0.5 });
  const f = ecologyFixture({ world, entries: [state] });
  const mob = f.mobs.get(state.id);
  let assignment = {
    id: mob.id, structureId: "village", dimension: "overworld", profession: "farmer", revision: 1,
    home: { id: "home", position: { x: 0.5, y: 1, z: 0.5 } },
    jobSite: { id: "composter", position: { x: 3.5, y: 1, z: 0.5 } },
  };
  const stock = Object.freeze({ wheatUses: 4 });
  const intents = [];
  Object.assign(f.ctx, {
    timeOfDay: 0.5, player: { x: 1.5, y: 1, z: 2 }, playerEye: { x: 1.5, y: 2.62, z: 2 },
    getVillagerAssignment: () => assignment,
    jobsitePresent: () => assignment.jobSite !== null,
    onVillagerIntent: (mob, intent) => intents.push(intent),
  });
  f.owner.update(mob, 0.1, f.ctx);
  assert.equal(mob.npcIntent, "work");
  assert.equal(intents[0].atJobsite, true, "work LOS targets above the solid jobsite, not its interior");
  assert.equal(mob.availableForTrade, true);
  const guard = captureVillagerTrade(mob, f.ctx);
  assert.ok(guard?.validate());
  const before = f.owner.readAvailability(mob.id, f.ctx);
  f.owner.update(mob, 0.1, f.ctx);
  assert.ok(f.owner.readAvailability(mob.id, f.ctx).revision > before.revision);
  assert.equal(guard.validate(), false, "movement invalidates an outstanding interactive plan");
  const jobsite = { id: "composter", dimension: "overworld", position: { x: 3, y: 1, z: 0 } };
  assert.equal(villagerJobsiteUsable(mob, jobsite, f.ctx), true);
  assignment = { ...assignment, home: null, jobSite: null, revision: 2 };
  f.ctx.timeOfDay = 0;
  f.owner.update(mob, 0.1, f.ctx);
  assert.equal(mob.npcIntent, "home");
  assert.equal(f.owner.readAvailability(mob.id, f.ctx).available, true);
  assert.equal(mob.availableForTrade, true, "remaining Trading-owned stock survives a broken jobsite");
  assert.equal(villagerJobsiteUsable(mob, jobsite, f.ctx), false);
  assert.ok(captureVillagerTrade(mob, f.ctx));
  f.ctx.threats = [ecologyMob("drowned", "threat", { x: mob.position.x + 1.5, y: 1, z: 0.5 })];
  f.owner.update(mob, 0.1, f.ctx);
  assert.equal(mob.npcIntent, "flee");
  assert.equal(mob.availableForTrade, false);
  assert.equal(f.owner.readAvailability(mob.id, f.ctx).available, false);
  assert.deepEqual(stock, { wheatUses: 4 });
});

test("NPC adapters use real structure and Trading field names without duplicating profession/offer archives", () => {
  const world = ecologyWorld();
  const member = {
    type: "member", entity: "villager", id: "village/member/grower", structureId: "village",
    dimension: "overworld", profession: "farmer", homeId: "village/home/farm",
    jobSiteId: "village/job_site/composter",
  };
  const home = { type: "home", id: member.homeId, structureId: "village", position: { x: 0, y: 1, z: 0 } };
  const site = {
    type: "job_site", id: member.jobSiteId, structureId: "village", profession: "farmer",
    memberId: member.id, position: { x: 4, y: 1, z: 0 },
  };
  const assignment = villagerAssignmentFromMarkers(member, home, site, world, 7);
  assert.ok(assignment);
  assert.equal(assignment.jobSite.position.x, 4.5);
  assert.equal(villagerAssignmentFromMarkers(member, home, { ...site, memberId: "another" }, world), null);
  const trader = { id: member.id, profession: "farmer", locked: true, xp: 12, offers: [{ uses: 5 }],
    jobsite: { id: site.id, kind: "COMPOSTER", dimension: "overworld", position: site.position } };
  const fromTrade = villagerAssignmentFromTrader(trader, {
    structureId: "village", home: assignment.home, revision: 8,
  }, world);
  assert.equal(fromTrade.jobSite.position.x, 4.5);
  assert.equal(fromTrade.offers, undefined);
  assert.equal(fromTrade.locked, undefined);
  const withoutSite = villagerAssignmentFromTrader({ ...trader, jobsite: null }, {
    structureId: "village", revision: 9,
  }, world);
  assert.equal(withoutSite.profession, "farmer");
  assert.equal(withoutSite.jobSite, null);
  assert.equal(normalizeVillagerAssignment({ ...fromTrade, offers: [] }, world), null);
  assert.equal(normalizeVillagerAssignment({ ...fromTrade, home: { ...fromTrade.home,
    position: { x: 0, y: -1000, z: 0 } } }, world), null);
});

test("blazes are admitted by the authored fortress spawner region, not generic Nether ground", () => {
  const world = ecologyWorld({ dimension: "nether", water: () => -1 });
  const f = ecologyFixture({ world });
  const structure = { id: "fortress", kind: "nether_fortress", dimension: "nether",
    bounds: { minX: -10, maxX: 10, minY: 1, maxY: 12, minZ: -10, maxZ: 10 } };
  const marker = { id: "fortress/encounter/blaze_nest", structureId: structure.id,
    type: "encounter", key: "blaze_nest", role: "blaze_spawner", entity: "blaze", mechanism: "spawner",
    block: "SPAWNER", position: { x: 4, y: 2, z: 0 },
    dimension: "nether", bounds: { minX: 1, maxX: 5, minY: 2, maxY: 7, minZ: -2, maxZ: 3 } };
  const position = { x: 2.5, y: 3, z: 0.5 };
  assert.equal(admitNpcSpawn("blaze", position, ecologyCollider("blaze"), f.ctx), false);
  assert.equal(admitNpcSpawn("blaze", position, ecologyCollider("blaze"), { ...f.ctx, structure, marker }), false);
  world.setCell(4, 2, 0, { id: BLOCK.SPAWNER, state: 0, fluid: FLUID.NONE });
  assert.equal(admitNpcSpawn("blaze", position, ecologyCollider("blaze"), { ...f.ctx, structure, marker }), true);
  assert.equal(admitNpcSpawn("blaze", { ...position, x: -2 }, ecologyCollider("blaze"),
    { ...f.ctx, structure, marker }), false);
});

test("blazes visibly charge a bounded non-explosive burst and cancel invalid targets", () => {
  const setup = () => {
    const world = ecologyWorld({ dimension: "nether", water: () => -1 });
    const state = ecologyState(world, "blaze", "blaze", { x: 0, y: 2, z: 0 }, { structureId: "fortress" });
    const f = ecologyFixture({ world, entries: [state] });
    f.ctx.player = { x: 8, y: 2, z: 0 };
    f.ctx.playerEye = { x: 8, y: 3.62, z: 0 };
    const shots = [];
    f.ctx.shootBlaze = (mob, shot) => { shots.push(shot); return true; };
    return { ...f, mob: f.mobs.get(state.id), shots };
  };
  const f = setup();
  for (let i = 0; i < 20; i++) f.owner.update(f.mob, 0.1, f.ctx);
  assert.ok(f.mob.beamCharge > 0 && f.mob.beamCharge < 1);
  assert.equal(f.shots.length, 0);
  for (let i = 0; i < 16; i++) f.owner.update(f.mob, 0.1, f.ctx);
  assert.equal(f.shots.length, 3);
  assert.ok(f.shots.every((shot) => shot.explosive === false && shot.lifetime <= 3 &&
    Object.values(shot.from).every(Number.isFinite) && Object.values(shot.target).every(Number.isFinite)));
  const cancelled = setup();
  for (let i = 0; i < 20; i++) cancelled.owner.update(cancelled.mob, 0.1, cancelled.ctx);
  cancelled.ctx.mode = "creative";
  for (let i = 0; i < 20; i++) cancelled.owner.update(cancelled.mob, 0.1, cancelled.ctx);
  assert.equal(cancelled.shots.length, 0);
  assert.equal(cancelled.mob.beamCharge, 0);
  assert.ok(ecologyDeathReward("blaze", true).drops.some((drop) => drop.name === "BLAZE_ROD"));
  assert.deepEqual(ecologyDeathReward("blaze", false).drops, []);
  assert.ok(!ecologyDeathReward("drowned", true).drops.some((drop) => drop.name === "TRIDENT"));
});

test("suspended blazes discard partial attacks and require a fresh visible telegraph", () => {
  for (const reason of ["dormant", "unloaded", "distant", "outer-loop"]) {
    let loaded = true;
    const world = ecologyWorld({ dimension: "nether", water: () => -1, loaded: () => loaded });
    const state = ecologyState(world, "blaze", "suspended-blaze", { x: 0, y: 2, z: 0 });
    const f = ecologyFixture({ world, entries: [state] });
    const mob = f.mobs.get(state.id), shots = [];
    f.ctx.player = { x: 8, y: 2, z: 0 };
    f.ctx.playerEye = { x: 8, y: 3.62, z: 0 };
    f.ctx.shootBlaze = (mob, shot) => { shots.push(shot); return true; };
    for (let i = 0; i < 20; i++) f.owner.update(mob, 0.1, f.ctx);
    assert.ok(mob.beamCharge > 0 && mob.beamCharge < 1);
    if (reason === "dormant") mob.dormant = true;
    if (reason === "unloaded") loaded = false;
    if (reason === "distant") f.ctx.player.x = 100;
    if (reason === "outer-loop") f.owner.clearIntent(mob, f.ctx);
    else f.owner.update(mob, 0.1, f.ctx);
    assert.equal(mob.beamCharge, 0);
    assert.equal(mob.attacking, false);
    loaded = true;
    mob.dormant = false;
    f.ctx.player.x = 8;
    for (let i = 0; i < 12; i++) f.owner.update(mob, 0.1, f.ctx);
    assert.equal(shots.length, 0, reason);
    assert.ok(mob.beamCharge < 1);
    const before = { ...mob.position };
    f.owner.dispose();
    f.owner.update(mob, 0.1, f.ctx);
    assert.deepEqual(mob.position, before);
    assert.equal(mob.beamCharge, 0);
    assert.equal(world.unloadedReads, 0);
  }
});

test("NPC models/skin painters use bounded original CPU cuboids with finite local animation", () => {
  for (const kind of NPC_KINDS) {
    const model = createNpcModel(kind);
    assert.ok(model.parts.length > 5 && model.parts.length <= MAX_NPC_PARTS_PER_MODEL);
    assert.equal(new Set(model.parts.map((part) => part.name)).size, model.parts.length);
    const entity = { kind, model, spec: ECOLOGY_SPECIES[kind], moving: true, beamCharge: 0.8, phase: 1 };
    model.root.position.set(28_000_000.5, 2, -28_000_000.25);
    model.root.rotation.y = 0.7;
    const root = model.root.position.clone(), neutral = model.localBounds.clone();
    const skins = model.parts.map((part) => part.skin);
    for (const dt of [0.1, 1e6, NaN, -1, Infinity, 0, 0.01])
      animateNpcMob(entity, dt, Number.MAX_VALUE, { x: NaN, y: 0, z: 0 });
    assert.deepEqual(model.root.position, root);
    assert.deepEqual(model.localBounds, neutral);
    model.root.traverse((node) => {
      assert.ok(node.matrixWorld.elements.every(Number.isFinite));
      assert.equal(node.isMesh, undefined);
      assert.equal(node.material, undefined);
      assert.equal(node.geometry, undefined);
    });
    for (const [index, part] of model.parts.entries()) {
      assert.equal(part.skin, skins[index]);
      assert.equal(part.skin.family, "npc");
      for (let face = 0; face < 6; face++) {
        const first = paintNpcSkinFace(part.skin, face);
        assert.ok(first.width <= 64 && first.height <= 64);
        assert.deepEqual(paintNpcSkinFace(part.skin, face), first);
        assert.equal(first.data.length, first.width * first.height * 4);
      }
    }
  }
  assert.throws(() => createNpcModel("__proto__"));
  assert.throws(() => createNpcSkin("blaze", "rod", [Infinity, 1, 1]));
});

test("aquatic ecology pose inputs drive existing rigs without treating visual bounds as colliders", () => {
  const world = ecologyWorld();
  const { ctx } = ecologyFixture({ world });
  ctx.player = { x: 8, y: 2, z: 0 };
  ctx.playerEye = { x: 8, y: 3.62, z: 0 };
  for (const kind of AQUATIC_KINDS) {
    const state = ecologyState(world, kind, `pose-${kind}`, { x: 0, y: 2, z: 0 });
    const model = createAquaticModel(kind);
    const mob = ecologyMob(kind, state.id, state.home);
    mob.model = model;
    mob.root = model.root;
    mob.position = model.root.position;
    mob.position.copy(state.home);
    const collider = ecologyCollider(kind, state);
    const neutral = model.localBounds.clone();
    for (let i = 0; i < 8; i++) {
      stepAquaticMob(mob, 0.1, ctx, state, collider);
      const physical = mob.position.clone();
      animateAquaticMob(mob, 0.1, i * 0.1, new THREE.Vector3(8, 3.62, 0));
      assert.deepEqual(mob.position, physical);
      assert.ok([mob.swimPitch, mob.beamCharge, mob.spikesExtended].every(Number.isFinite));
      assert.equal(typeof mob.moving, "boolean");
      assert.equal(typeof mob.swimming, "boolean");
      for (const part of model.parts) assert.ok(part.node.matrixWorld.elements.every(Number.isFinite));
    }
    assert.deepEqual(model.localBounds, neutral);
    assert.ok(collider.radius > 0 && collider.height > 0);
  }
});
