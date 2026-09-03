import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ecologyCanOccupy, ecologyEye } from "../src/aquatic-ai.js";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { ECOLOGY_EFFECT_LIMIT, EcologyEffects } from "../src/ecology-effects.js";
import { ECOLOGY_HOST_LIMITS } from "../src/ecology-population.js";
import { ECOLOGY_ATTACK_LIMITS, EcologyAttackRenderer } from "../src/ecology-render.js";
import { createEcologyState, ecologyCollider, ECOLOGY_SPECIES } from "../src/expansion-ecology.js";
import { createMobModel, MAX_PARTS_PER_MOB } from "../src/mob-models.js";
import { getMobSkinAtlasData, MAX_MOB_SKINS, MOB_SKIN_ATLAS_SIZE, paintMobAtlasFace } from "../src/mob-skin-atlas.js";
import { MOB_SPECIES, speciesForBiome } from "../src/mob-species.js";
import { ecologyFortress, ecologyHostFixture } from "./ecology-host-fixture.js";
import { ecologyFixture, ecologyMob, monumentFixture } from "./ecology-fixtures.js";

function guardian(t) {
  const f = ecologyHostFixture(t);
  const { structure } = monumentFixture();
  f.markerIndex.add(structure);
  f.player.position = { x: 10.5, y: 2, z: 1.5 };
  f.mob = f.admit("guardian", { x: 1.5, y: 2, z: 1.5 }, { structure });
  return f;
}
function blaze(t) {
  const f = ecologyHostFixture(t, { dimension: "nether", water: -1 });
  const site = ecologyFortress(f);
  f.player.position = { x: 18.5, y: 2, z: 8.5 };
  f.mob = f.admit("blaze", { x: 8.5, y: 2, z: 8.5 }, site);
  return f;
}
const shotFor = (f) => ({
  kind: "blaze_fireball", from: ecologyEye(f.mob), target: { ...f.wildlife.context.playerEye },
  speed: 9, damage: f.mob.spec.damage, fireSeconds: 4, lifetime: 3, radius: 0.15, explosive: false,
});
function wall(f, x, { low = 1, high = 7, z0 = -16, z1 = 31 } = {}) {
  const changes = [];
  for (let y = low; y <= high; y++)
    for (let z = z0; z <= z1; z++)
      changes.push({ x, y, z, before: f.world.getCell(x, y, z), after: { id: BLOCK.STONE } });
  assert.equal(f.world.applyCells(changes), true);
}

test("every ecology species dispatches to its original rig and the existing single skin atlas", () => {
  const atlas = getMobSkinAtlasData();
  assert.equal(atlas.size, MOB_SKIN_ATLAS_SIZE);
  assert.ok(atlas.entries.size <= MAX_MOB_SKINS && atlas.usedHeight <= atlas.size);
  for (const kind of Object.keys(ECOLOGY_SPECIES)) {
    assert.equal(MOB_SPECIES[kind], ECOLOGY_SPECIES[kind]);
    const model = createMobModel(kind);
    assert.ok(model.parts.length > 0 && model.parts.length <= MAX_PARTS_PER_MOB);
    assert.equal(model.kind, kind);
    const unit = new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)
    );
    const bounds = new THREE.Box3();
    model.root.updateWorldMatrix(true, true);
    for (const part of model.parts)
      bounds.union(unit.clone().applyMatrix4(part.node.matrixWorld));
    assert.ok(Math.abs(bounds.min.y) < 1e-8, `${kind}: original rig stays grounded`);
    assert.ok(bounds.max.y <= ECOLOGY_SPECIES[kind].height + 1e-8,
      `${kind}: visual fitting must not enlarge a collider to fit decorative parts`);
    assert.deepEqual(model.root.scale.toArray(), [1, 1, 1], "physical root remains available for age scaling");
    assert.ok(model.pickHeight >= bounds.max.y && model.pickFloor <= bounds.min.y);
    for (const part of model.parts) {
      assert.equal(part.skin.family, ["blaze", "villager"].includes(kind) ? "npc" : "aquatic");
      assert.ok(atlas.entries.has(part.skin.key));
      assert.equal(part.node.isMesh, undefined, "parts share the Wildlife instanced batch");
      for (let face = 0; face < 6; face++) {
        const pixels = paintMobAtlasFace(part.skin, face);
        assert.equal(pixels.data.byteLength, pixels.width * pixels.height * 4);
        assert.deepEqual(paintMobAtlasFace(part.skin, face), pixels);
      }
    }
  }
  for (const hostile of [true, false])
    assert.ok(speciesForBiome({ id: "ocean" }, { water: true, hostile })
      .every((kind) => !ECOLOGY_SPECIES[kind]), "ecology must not enter legacy waterHome dispatch");
});

test("real Wildlife presents guardian charge batches before real Gameplay damage", (t) => {
  const f = guardian(t);
  f.tick(15);
  assert.equal(f.damage.length, 0);
  assert.ok(f.mob.beamCharge > 0 && f.mob.beamCharge < 1);
  assert.ok(f.host.attacks.mesh.count > 0);
  f.tick(40);
  assert.equal(f.damage.length, 1);
  assert.equal(f.damage[0].attack.kind, "guardian_beam");
  assert.ok(f.damage[0].visible > 0);
  assert.equal(f.gameplay.health, 20 - f.mob.spec.damage);
  assert.equal(f.wildlife.context.health, f.gameplay.health);
});

test("CPU-only charge cannot damage; paused rendering also removes beams occluded by a new wall", (t) => {
  const f = guardian(t);
  for (let i = 0; i < 60; i++) {
    f.host.stepMob(f.mob, 0.05);
    f.host.stepWorld(0.05);
  }
  assert.equal(f.damage.length, 0, "upload on an earlier render, not a CPU timer, permits beam damage");
  assert.equal(f.host.attacks.mesh.count, 0);
  const g = guardian(t);
  g.tick(15);
  assert.ok(g.host.attacks.mesh.count > 0);
  wall(g, 5);
  g.tick(1, 0);
  assert.equal(g.host.attacks.mesh.count, 0);
  g.tick(60);
  assert.equal(g.damage.length, 0);
  assert.equal(g.mob.beamCharge, 0);
});

for (const invalidation of ["life", "creative", "invulnerable", "unloaded"])
  test(`guardian charge cannot survive ${invalidation} invalidation`, (t) => {
    const f = guardian(t);
    f.tick(15);
    assert.ok(f.host.attacks.mesh.count > 0);
    if (invalidation === "life") f.player.targetKey = "player:life:2";
    if (invalidation === "creative") assert.equal(f.gameplay.setMode("creative"), true);
    if (invalidation === "invulnerable") f.player.invulnerable = true;
    if (invalidation === "unloaded") f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
    f.tick();
    assert.equal(f.damage.length, 0);
    assert.ok(f.mob.beamCharge <= 0.025 + 1e-8, "a new life can start only a fresh first charge frame");
    if (invalidation !== "life") assert.equal(f.host.attacks.beams.size, 0);
  });

test("paused host rendering re-reads player life instead of retaining a stale visible attack target", (t) => {
  const f = guardian(t);
  f.tick(15);
  assert.ok(f.host.attacks.mesh.count > 0);
  const before = f.ownership();
  f.player.targetKey = "player:life:2";
  f.host.render(f.player.position);
  assert.equal(f.host.attacks.mesh.count, 0);
  assert.equal(f.host.attacks.beams.size, 0);
  assert.equal(f.damage.length, 0);
  assert.deepEqual(f.ownership(), before);
});

test("a blaze fireball is presented before travel/damage and carries non-explosive fire metadata", (t) => {
  const f = blaze(t), attacks = f.host.attacks;
  assert.equal(attacks.shootBlaze(f.mob, shotFor(f)), true);
  const born = { ...attacks.projectiles[0].position };
  for (let i = 0; i < 60; i++) attacks.update(0.1);
  assert.deepEqual(attacks.projectiles[0].position, born);
  assert.equal(f.damage.length, 0);
  attacks.render(f.player.position);
  assert.equal(attacks.mesh.count, 1);
  for (let i = 0; i < 30; i++) attacks.update(0.05);
  assert.equal(attacks.projectiles.length, 0);
  assert.equal(f.damage.length, 1);
  assert.ok(f.damage[0].visible > 0);
  assert.equal(f.damage[0].attack.kind, "blaze_fireball");
  assert.equal(f.damage[0].attack.explosive, false);
  assert.equal(f.damage[0].attack.fireSeconds, 4, "parent Combat applies actual ignition/shields");
  assert.equal(f.gameplay.health, 15);
});

test("blaze sweeps respect solid geometry and never grant a hit through a newly placed wall", (t) => {
  const f = blaze(t), attacks = f.host.attacks;
  assert.equal(attacks.shootBlaze(f.mob, shotFor(f)), true);
  attacks.render(f.player.position);
  attacks.update(0.05);
  wall(f, 12, { low: 2, high: 5, z0: 6, z1: 10 });
  for (let i = 0; i < 30; i++) attacks.update(0.05);
  assert.equal(attacks.projectiles.length, 0);
  assert.equal(f.damage.length, 0);
  assert.equal(f.gameplay.health, 20);
});

test("source eviction cancels an already-presented fireball even during paused rendering", (t) => {
  const f = blaze(t), attacks = f.host.attacks;
  assert.equal(attacks.shootBlaze(f.mob, shotFor(f)), true);
  attacks.render(f.player.position);
  for (let i = 0; i < 18; i++) attacks.update(0.05);
  assert.ok(attacks.projectiles[0].position.x > 16, "the projectile reached a different loaded column");
  assert.equal(f.mob.dormant, false, "the outer AI loop has not processed eviction yet");
  f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
  attacks.render(f.player.position);
  assert.equal(attacks.projectiles.length, 0);
  assert.equal(attacks.mesh.count, 0);
  assert.equal(f.damage.length, 0);
  assert.equal(f.gameplay.health, 20);
});

test("one attack batch has fixed pool capacity and disposes every allocated resource exactly once", (t) => {
  const f = blaze(t), attacks = f.host.attacks;
  for (let i = 0; i < ECOLOGY_ATTACK_LIMITS.projectiles; i++)
    assert.equal(attacks.shootBlaze(f.mob, shotFor(f)), true);
  assert.equal(attacks.shootBlaze(f.mob, shotFor(f)), false);
  const mesh = attacks.mesh, geometry = mesh.geometry, material = mesh.material;
  const disposed = { mesh: 0, geometry: 0, material: 0 };
  for (const [name, object] of Object.entries({ mesh, geometry, material }))
    object.addEventListener("dispose", () => disposed[name]++);
  attacks.render(f.player.position);
  assert.equal(mesh.count, ECOLOGY_ATTACK_LIMITS.projectiles);
  assert.equal(mesh.instanceMatrix.count, ECOLOGY_ATTACK_LIMITS.projectiles + ECOLOGY_ATTACK_LIMITS.beams);
  for (let i = 0; i < 20; i++) {
    attacks.clear();
    assert.equal(attacks.shootBlaze(f.mob, shotFor(f)), true);
    attacks.render(f.player.position);
    assert.equal(attacks.mesh.geometry, geometry);
    assert.equal(attacks.mesh.material, material);
  }
  assert.equal(f.wildlife.group.children.filter((child) => child === mesh).length, 1);
  assert.equal(f.host.suspend(), true);
  attacks.dispose();
  assert.deepEqual(disposed, { mesh: 1, geometry: 1, material: 1 });
  assert.equal(attacks.mesh, null);
  assert.equal(f.wildlife.group.children.includes(mesh), false);
  assert.equal(attacks.shootBlaze(f.mob, shotFor(f)), false);
});

test("beam pool refuses the ninth source and a fire without a rendered near-complete telegraph", () => {
  const f = ecologyFixture(), group = new THREE.Group();
  f.ctx.player = { x: 8, y: 2, z: 0 };
  f.ctx.playerEye = { x: 8, y: 3.62, z: 0 };
  const renderer = new EcologyAttackRenderer(group, f.ctx);
  try {
    for (let i = 0; i <= ECOLOGY_ATTACK_LIMITS.beams; i++) {
      const mob = ecologyMob("guardian", `beam-source-${i}`, { x: 0, y: 2, z: 0 });
      f.mobs.set(mob.id, mob);
      assert.equal(renderer.beam(mob, { phase: "charge", charge: 0.95,
        from: ecologyEye(mob), to: f.ctx.playerEye }), i < ECOLOGY_ATTACK_LIMITS.beams);
    }
    const mob = f.mobs.get("beam-source-0");
    const fire = { phase: "fire", charge: 1, from: ecologyEye(mob), to: f.ctx.playerEye };
    assert.equal(renderer.beam(mob, fire), false);
    renderer.render(f.ctx.player);
    assert.equal(renderer.mesh.count, ECOLOGY_ATTACK_LIMITS.beams);
    assert.equal(renderer.beam(mob, { ...fire, charge: 0.5 }), false);
    assert.equal(renderer.beam(mob, fire), true);
    assert.equal(renderer.beam(mob, fire), false);
  } finally {
    renderer.dispose();
    f.owner.dispose();
  }
});

test("source-scoped grace/fatigue are bounded, non-stacking and cleared by source/life/dimension loss", () => {
  const sources = new Set(Array.from({ length: ECOLOGY_EFFECT_LIMIT + 1 }, (_, i) => `source-${i}`));
  const effects = new EcologyEffects({ sourceActive: (id) => sources.has(id) });
  const ctx = { dimension: "overworld", targetKey: "player:life:1", health: 20 };
  effects.step(0, ctx);
  for (let i = 0; i < ECOLOGY_EFFECT_LIMIT; i++)
    assert.equal(effects.apply({ id: "dolphins_grace", source: `source-${i}`, duration: 1.5, swimSpeedMultiplier: 1.6 }, ctx), true);
  assert.equal(effects.modifiers().swimSpeedMultiplier, 1.6);
  assert.equal(effects.apply({ id: "mining_fatigue", source: `source-${ECOLOGY_EFFECT_LIMIT}`, duration: 40, level: 2 }, ctx), false);
  effects.clearSource("source-0");
  assert.equal(effects.apply({ id: "mining_fatigue", source: "source-0", duration: 40, level: 2 }, ctx), true);
  assert.equal(effects.modifiers().miningSpeedMultiplier, 0.0027);
  sources.delete("source-0");
  effects.step(0, ctx);
  assert.equal(effects.modifiers().miningSpeedMultiplier, 1);
  effects.step(0, { ...ctx, targetKey: "player:life:2" });
  assert.equal(effects.size, 0);
  assert.equal(effects.apply({ id: "dolphins_grace", source: "source-1", duration: 1.5, swimSpeedMultiplier: 1.6 }, ctx), false);
  effects.step(0, ctx);
  assert.equal(effects.apply({ id: "dolphins_grace", source: "source-1", duration: 1.5, swimSpeedMultiplier: 1.6 }, ctx), true);
  effects.step(0, { ...ctx, dimension: "nether" });
  assert.equal(effects.size, 0);
  effects.dispose();
});

test("live feeding supplies a useful modifier and loss of the actual dolphin source revokes it immediately", (t) => {
  const f = ecologyHostFixture(t);
  f.player.position = { x: 8.5, y: 2, z: 10.5 };
  const mob = f.admit("dolphin", { x: 8.5, y: 2, z: 8.5 });
  f.hold("RAW_COD");
  assert.equal(f.host.commit(f.host.prepareInteraction(mob.id)).ok, true);
  f.tick();
  assert.equal(f.host.modifiers().swimSpeedMultiplier, 1.6);
  f.player.swimming = false;
  assert.equal(f.host.modifiers().swimSpeedMultiplier, 1);
  f.player.swimming = true;
  f.tick(12);
  assert.equal(f.host.modifiers().swimSpeedMultiplier, 1.6);
  assert.equal(f.wildlife.suspendEcology(mob), true);
  assert.equal(f.host.modifiers().swimSpeedMultiplier, 1);
});

for (const waterId of [BLOCK.WATER, BLOCK.KELP, BLOCK.SEAGRASS])
  test(`bounded natural population admits dolphin/drowned through shared fluid volumes (${waterId})`, (t) => {
    const f = ecologyHostFixture(t, { radius: 3, waterId });
    t.mock.method(f.world, "getBiome", () => assert.fail("population cannot generate biome metadata"));
    t.mock.method(f.world, "surfaceYAt", () => assert.fail("population cannot scan terrain tops"));
    const before = f.generated(), random = f.wildlife.randomState;
    const work = f.host.populate();
    assert.ok(work.admitted > 0 && work.admitted <= ECOLOGY_HOST_LIMITS.admissions);
    assert.ok(work.attempts <= ECOLOGY_HOST_LIMITS.naturalAttempts * ECOLOGY_HOST_LIMITS.verticalProbes);
    assert.ok(f.wildlife.entities.some((mob) => mob.kind === "dolphin"));
    assert.ok(f.wildlife.entities.some((mob) => mob.kind === "drowned"));
    assert.equal(f.generated(), before);
    assert.equal(f.wildlife.randomState, random);
    assert.ok(f.markerIndex.requests.every((request) =>
      request.limit <= ECOLOGY_HOST_LIMITS.markerCandidates));
  });

for (const [label, options, y] of [
  ["dry ocean", { water: -1 }, 1],
  ["one-block shallows", { water: 1 }, 1],
  ["frozen ocean", { biomeId: "frozen_ocean" }, 2],
  ["river", { biomeId: "river" }, 2],
  ["lava-filled ocean", { waterId: BLOCK.LAVA }, 2],
  ["one waterlogged slab", { water: -1,
    initial: [[8, 1, 8, { id: BLOCK.OAK_SLAB, state: 0, fluid: FLUID.WATER_SOURCE }]],
  }, 1.5],
])
  test(`natural dolphin habitat rejects ${label} without publishing an admission`, (t) => {
    const f = ecologyHostFixture(t, options), position = { x: 8.5, y, z: 8.5 };
    assert.equal(ecologyCanOccupy(f.world, position, ecologyCollider("dolphin")), true,
      "negative control changes habitat, not solid body clearance");
    const before = f.ownership(), generated = f.generated();
    assert.equal(f.host.prepareAdmission("dolphin", position), null);
    assert.deepEqual(f.ownership(), before);
    assert.equal(f.generated(), generated);
  });

for (const patch of [{ blockLight: 1 }, { skyLight: 8 }, { biomeId: "plains" }])
  test(`drowned admission pins actual habitat/light reads (${JSON.stringify(patch)})`, (t) => {
    let habitat = { biomeId: "ocean", blockLight: 0, skyLight: 7 };
    const f = ecologyHostFixture(t, { hooks: { readHabitat: () => habitat } });
    const position = { x: -15.5, y: 2, z: 12.5 };
    const plan = f.host.prepareAdmission("drowned", position);
    assert.ok(plan);
    habitat = { ...habitat, ...patch };
    const before = f.ownership();
    assert.equal(f.host.commit(plan).ok, false);
    assert.equal(f.host.prepareAdmission("drowned", position), null);
    assert.deepEqual(f.ownership(), before);
  });

for (const [label, readHabitat] of [
  ["refusal", () => null],
  ["missing reading", () => undefined],
  ["reader exception", () => { throw new Error("fixture habitat unavailable"); }],
])
  test(`an explicit habitat ${label} never falls back to a guessed natural admission`, (t) => {
    const f = ecologyHostFixture(t, { hooks: { readHabitat } });
    const before = f.ownership(), at = { x: 8.5, y: 2, z: 8.5 };
    assert.equal(f.host.habitat(at), null);
    assert.equal(f.host.prepareAdmission("dolphin", at), null);
    assert.deepEqual(f.ownership(), before);
  });

test("water-born turtles pin a detached, physically supported home beach before admission", (t) => {
  const homeBeach = { x: 12.5, y: 7, z: 8.5 };
  const f = ecologyHostFixture(t, { hooks: {
    readHabitat: () => ({ biomeId: "ocean", homeBeach }),
  } });
  for (let z = 7; z <= 9; z++)
    for (let x = 11; x <= 13; x++) f.put(x, 6, z, BLOCK.SAND);
  const at = { x: 8.5, y: 2, z: 8.5 };
  const captured = f.host.habitat(at), plan = f.host.prepareAdmission("turtle", at);
  assert.ok(plan);
  homeBeach.x += 0.25;
  assert.equal(captured.homeBeach.x, 12.5, "provider-owned mutable coordinates cannot rewrite a prepared home");
  const before = f.ownership();
  assert.equal(f.host.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), before);
  const next = f.host.prepareAdmission("turtle", at);
  assert.ok(next);
  assert.equal(f.host.commit(next).ok, true);
  assert.deepEqual(f.host.ecology.state(next.result.id).homeBeach, homeBeach);
});

test("natural beach population finds real sand support with a fixed vertical probe budget", (t) => {
  const f = ecologyHostFixture(t, { radius: 3, floor: 63, water: -1, biomeId: "beach" });
  f.player.position.y = 64;
  const before = f.generated(), work = f.host.populate();
  assert.ok(work.admitted > 0);
  assert.ok(work.attempts <= ECOLOGY_HOST_LIMITS.naturalAttempts * ECOLOGY_HOST_LIMITS.verticalProbes);
  assert.ok(f.wildlife.entities.every((mob) => mob.kind === "turtle"));
  for (const mob of f.wildlife.entities)
    assert.equal(f.world.get(Math.floor(mob.position.x), Math.floor(mob.position.y - 1), Math.floor(mob.position.z)), BLOCK.SAND);
  assert.equal(f.generated(), before);
});

test("dormant waking does bounded work without enlarging the active render pool or truncating saved residents", (t) => {
  const source = ecologyHostFixture(t), saved = source.snapshot();
  const entities = Array.from({ length: 100 }, (_, i) => ({
    id: `overworld:ecology:${i}`, kind: "dolphin", position: { x: 1000 + i * 2, y: 2, z: 1000 },
    health: 7, yaw: 0, tamed: false, angry: 0, attackCooldown: 0, fuse: 0, pacified: 0,
  }));
  saved.ecology.ecology.entries = entities.map((mob) =>
    createEcologyState(mob.kind, mob.id, mob.position, source.context));
  saved.ecology.mobsByDimension.overworld = {
    version: 1, seed: source.world.seed, dimension: "overworld",
    randomState: 7, nextId: entities.length, killed: [], entities,
  };
  const f = ecologyHostFixture(t, { saved });
  assert.equal(f.wildlife.dormantEcology.size, 100);
  const original = f.host.canWake.bind(f.host);
  let checked = 0;
  t.mock.method(f.host, "canWake", (mob) => { checked++; return original(mob); });
  f.tick(1, 0.2);
  assert.ok(checked <= ECOLOGY_HOST_LIMITS.dormantPerFrame);
  assert.equal(f.wildlife.mesh.count, 0);
  assert.equal(f.wildlife.entities.length, 0);
  assert.equal(f.host.serialize().mobsByDimension.overworld.entities.length, 100);
  assert.equal(f.wildlife.byId.get("overworld:ecology:99").health, 7);
});
