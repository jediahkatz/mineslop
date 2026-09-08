import assert from "node:assert/strict";
import test from "node:test";
import { BIOMES, getBiomeById } from "../src/biomes.js";
import { normalizePotionData } from "../src/item-stack-data.js";
import { MOB_POTION_POLICIES } from "../src/game-mob-potion-impact.js";
import { GameTravel } from "../src/game-travel.js";
import { stepMob } from "../src/mob-ai.js";
import { MOB_SPECIES } from "../src/mob-species.js";
import {
  gameMobFixture,
  gameMobGenerator,
} from "./game-mob-integration-fixture.js";

const splash = (id, options = {}) =>
  normalizePotionData({ id, form: "splash", ...options });

test("every physical species has an explicit immutable potion policy", () => {
  assert.deepEqual(Object.keys(MOB_POTION_POLICIES).sort(),
    Object.keys(MOB_SPECIES).sort());
  assert.equal(MOB_POTION_POLICIES.zombie.undead, true);
  assert.equal(MOB_POTION_POLICIES.drowned.undead, true);
  assert.equal(MOB_POTION_POLICIES.spider.poisonImmune, true);
  assert.equal(MOB_POTION_POLICIES.horse.effectImmune, false);
  assert.ok(Object.values(MOB_POTION_POLICIES).every(Object.isFrozen));
});

function beachGenerator(seed, dimension, generatorVersion) {
  const source = gameMobGenerator(seed, dimension, generatorVersion);
  if (dimension !== "overworld") return source;
  return {
    ...source,
    getBiome: () => getBiomeById("beach"),
    generateChunk(cx, cz) {
      const chunk = source.generateChunk(cx, cz);
      chunk.biomes.fill(BIOMES.findIndex((entry) => entry.id === "beach"));
      return chunk;
    },
  };
}

function turtle(f, position = { x: 12.5, y: 65, z: 9.5 }) {
  const plan = f.ecology.prepareAdmission("turtle", position);
  assert.ok(plan);
  assert.equal(f.ecology.commit(plan).ok, true);
  return f.wildlife.byId.get(plan.result.id);
}

function target(f, mob) {
  return f.game.mobPotionImpact.readTargets()
    .find((entry) => entry.entityId === mob.id);
}

function impact(f, potion, entries) {
  const plan = f.game.mobPotionImpact.prepareImpact({
    potion,
    impacts: entries.map(({ target, distance = 0, directHit = true }) => ({
      target,
      splash: { distance, directHit },
    })),
    validate: () => true,
  });
  assert.ok(plan);
  assert.equal(new Set(plan.participants.map((part) => part.owner)).size,
    plan.participants.length);
  return plan;
}

test("mixed cow, horse and ecology instant deaths publish once per owner with rewards", async (t) => {
  const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
  const cow = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:cow",
  });
  const horse = f.spawn("potion:horse", { x: 10.5, y: 65, z: 9.5 });
  const resident = turtle(f);
  assert.ok(cow && horse && resident);
  assert.equal(f.wildlife.damage(cow, 10, null, false).damage, 10);
  assert.equal(f.horses.hurt(horse, 19, null, { retaliate: false }).damage, 19);
  assert.equal(f.ecology.hurt(resident, 25, null, { retaliate: false }).damage, 25);
  const beforeRng = f.wildlife.randomState;
  const plan = impact(f, splash("harming"), [
    { target: target(f, cow) },
    { target: target(f, horse) },
    { target: target(f, resident) },
  ]);
  const owners = plan.participants.map((part) => part.owner);
  for (const owner of [
    f.wildlife,
    f.horses,
    f.ecology.ecology,
    f.overflow,
    f.game.experienceOrbs,
  ])
    assert.equal(owners.filter((entry) => entry === owner).length, 1);
  const committed = f.game.mobPotionImpact.commit(plan);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(f.wildlife.byId.has(cow.id), false);
  assert.equal(f.wildlife.killed.has(cow.id), true);
  assert.equal(f.horses.state(horse.id).alive, false);
  assert.equal(f.ecology.ecology.state(resident.id).alive, false);
  assert.ok(f.overflow.size + f.game.pickups.serialize().items.length > 0);
  assert.ok(f.game.experienceOrbs.size > 0);
  const itemPositions = [
    ...f.overflow.serialize().entries,
    ...f.game.pickups.serialize().items,
  ].map(({ x, y, z }) => `${x}:${y}:${z}`);
  const xpPositions = f.game.experienceOrbs.serialize().orbs
    .map(({ x, y, z }) => `${x}:${y}:${z}`);
  for (const mob of [cow, horse]) {
    const position = `${mob.position.x}:${mob.position.y}:${mob.position.z}`;
    assert.ok(itemPositions.includes(position), `missing drops at ${position}`);
  }
  for (const mob of [cow, horse]) {
    const position = `${mob.position.x}:${mob.position.y}:${mob.position.z}`;
    assert.ok(xpPositions.includes(position), `missing XP at ${position}`);
  }
  assert.notEqual(f.wildlife.randomState, beforeRng);
  assert.equal(f.game.mobPotionImpact.commit(plan).ok, false);
});

test("same-owner horse and ecology victims coalesce into one participant each", async (t) => {
  const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
  const horses = [
    f.spawn("potion:horse-batch:1", { x: 5.5, y: 65, z: 8.5 }),
    f.spawn("potion:horse-batch:2", { x: 8.5, y: 65, z: 8.5 }),
  ];
  const turtles = [
    turtle(f, { x: 11.5, y: 65, z: 8.5 }),
    turtle(f, { x: 14.5, y: 65, z: 8.5 }),
  ];
  for (const horse of horses)
    assert.equal(f.horses.hurt(horse, 19, null, { retaliate: false }).damage, 19);
  for (const resident of turtles)
    assert.equal(f.ecology.hurt(resident, 25, null, { retaliate: false }).damage, 25);
  const plan = impact(f, splash("harming"), [...horses, ...turtles].map((mob) => ({
    target: target(f, mob),
  })));
  assert.equal(plan.participants.filter((part) => part.owner === f.horses).length, 1);
  assert.equal(plan.participants.filter((part) => part.owner === f.ecology.ecology).length, 1);
  const view = () => JSON.stringify({
    mobs: [...horses, ...turtles].map(({ id, health, dead }) => ({ id, health, dead })),
    status: f.game.mobStatusEffects.serialize(),
    horses: f.horses.serialize(),
    ecology: f.ecology.ecology.serialize(),
    overflow: f.overflow.serialize(),
    experience: f.game.experienceOrbs.serialize(),
  });
  const before = view();
  for (let veto = 0; veto < plan.participants.length; veto++) {
    const participants = plan.participants.map((part, index) =>
      index === veto ? Object.freeze({ ...part, validate: () => false }) : part);
    assert.equal(f.game.coordinator.commit(participants).ok, false);
    assert.equal(view(), before, `owner ${veto} published despite veto`);
  }
  const committed = f.game.mobPotionImpact.commit(plan);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.ok(horses.every((horse) => f.horses.state(horse.id).alive === false));
  assert.ok(turtles.every((resident) =>
    f.ecology.ecology.state(resident.id).alive === false));
});

test("direct and falloff exposure affect player and mobs atomically; veto is retryable", async (t) => {
  const f = await gameMobFixture(t);
  const direct = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:direct",
  });
  const edge = f.wildlife.spawn("cow", { x: 11.5, y: 65, z: 9.5 }, {
    id: "potion:edge",
  });
  const player = f.game.mobPotionImpact.readTargets()
    .find((entry) => entry.ownerType === "player");
  const plan = impact(f, splash("harming"), [
    { target: player, distance: 2, directHit: false },
    { target: target(f, direct) },
    { target: target(f, edge), distance: 3, directHit: false },
  ]);
  const before = {
    player: f.gameplay.health,
    direct: direct.health,
    edge: edge.health,
  };
  for (let veto = 0; veto < plan.participants.length; veto++) {
    const vetoed = plan.participants.map((part, index) =>
      index === veto ? { ...part, validate: () => false } : part);
    assert.equal(f.coordinator.commit(vetoed).ok, false);
    assert.deepEqual({
      player: f.gameplay.health,
      direct: direct.health,
      edge: edge.health,
    }, before);
  }
  assert.equal(f.game.mobPotionImpact.commit(plan).ok, true);
  assert.equal(f.gameplay.health, 17);
  assert.equal(direct.health, 8);
  assert.equal(edge.health, 12);
});

test("undead inversion, poison immunity and timed pulses use canonical mob statuses", async (t) => {
  const f = await gameMobFixture(t);
  const zombie = f.wildlife.spawn("zombie", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:zombie",
  });
  const spider = f.wildlife.spawn("spider", { x: 10.5, y: 65, z: 9.5 }, {
    id: "potion:spider",
  });
  const cow = f.wildlife.spawn("cow", { x: 12.5, y: 65, z: 9.5 }, {
    id: "potion:timed",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("healing"), [
    { target: target(f, zombie) },
  ])).ok, true);
  assert.equal(zombie.health, 14);
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("harming"), [
    { target: target(f, zombie) },
  ])).ok, true);
  assert.equal(zombie.health, 18);
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("poison"), [
    { target: target(f, spider) },
    { target: target(f, cow) },
  ])).ok, true);
  assert.equal(f.game.mobStatusEffects.effectsFor(target(f, spider)).effects.length, 0);
  assert.equal(f.game.mobStatusEffects.effectsFor(target(f, cow)).effects[0].id, "poison");
  for (let index = 0; index < 30; index++)
    f.game.mobPotionImpact.frame(0.05, { simulating: true });
  assert.equal(cow.health, 12);
  assert.equal(spider.health, 16);
});

test("regeneration pulses heal through the canonical prepared owner adapter", async (t) => {
  const f = await gameMobFixture(t);
  const cow = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:regeneration",
  });
  assert.equal(f.wildlife.damage(cow, 4, null, false).damage, 4);
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("regeneration"), [
    { target: target(f, cow) },
  ])).ok, true);
  for (let index = 0; index < 60; index++)
    f.game.mobPotionImpact.frame(0.05, { simulating: true });
  assert.ok(cow.health > 10 && cow.health <= cow.spec.health);
});

test("timed horse and ecology healing stays canonical across archive reload", async (t) => {
  const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
  const horse = f.spawn("potion:timed-horse", { x: 8.5, y: 65, z: 8.5 });
  const resident = turtle(f, { x: 12.5, y: 65, z: 8.5 });
  assert.equal(f.horses.hurt(horse, 6, null, { retaliate: false }).damage, 6);
  assert.equal(f.ecology.hurt(resident, 6, null, { retaliate: false }).damage, 6);
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("regeneration"), [
    { target: target(f, horse) },
    { target: target(f, resident) },
  ])).ok, true);
  for (let index = 0; index < 60; index++)
    f.game.mobPotionImpact.frame(0.05, { simulating: true });
  assert.ok(horse.health > 18);
  assert.ok(resident.health > 24);
  assert.equal(f.horses.state(horse.id).alive, true);
  assert.equal(f.ecology.ecology.state(resident.id).alive, true);
  const saved = f.snapshot();
  const restored = await gameMobFixture(t, {
    saved,
    generatorFactory: beachGenerator,
  });
  assert.equal(restored.wildlife.byId.get(horse.id).health, horse.health);
  assert.equal(restored.wildlife.byId.get(resident.id).health, resident.health);
  assert.equal(restored.horses.state(horse.id).alive, true);
  assert.equal(restored.ecology.ecology.state(resident.id).alive, true);
});

test("timed status survives archive reload and freezes while its mob is dormant", async (t) => {
  const f = await gameMobFixture(t);
  const cow = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:saved",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
    { target: target(f, cow) },
  ])).ok, true);
  assert.equal(f.game.mobStatusEffects.modifiers(target(f, cow)).movementMultiplier, 0.85);
  const saved = f.snapshot();
  const restored = await gameMobFixture(t, { saved });
  const mob = restored.wildlife.byId.get(cow.id);
  assert.equal(mob.life, cow.life);
  assert.equal(restored.game.mobStatusEffects.modifiers(target(restored, mob))
    .movementMultiplier, 0.85);
  mob.dormant = true;
  const before = restored.game.mobStatusEffects.effectsFor({
    dimension: restored.world.dimension,
    entityId: mob.id,
    life: mob.life,
  });
  restored.game.mobPotionImpact.frame(0.25, { simulating: true });
  assert.deepEqual(restored.game.mobStatusEffects.effectsFor({
    dimension: restored.world.dimension,
    entityId: mob.id,
    life: mob.life,
  }), before);
});

test("Wildlife life reuse cannot inherit status and archive reconciliation retires the old life", async (t) => {
  const f = await gameMobFixture(t);
  const first = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:reused-id",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
    { target: target(f, first) },
  ])).ok, true);
  assert.equal(f.wildlife.remove(first), undefined);
  const replacement = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: first.id,
  });
  assert.ok(replacement.life > first.life);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 0);
  assert.equal(f.game.mobStatusEffects.modifiers(target(f, replacement))
    .movementMultiplier, 1);
  const saved = f.snapshot();
  assert.equal(saved.mobStatusEffects.entries.length, 0);
  assert.equal(saved.mobs.entities[0].life, replacement.life);
  const malformed = structuredClone(saved);
  malformed.mobStatusEffects = {
    ...saved.mobStatusEffects,
    entries: [{
      dimension: f.world.dimension,
      entityId: replacement.id,
      life: first.life,
      effects: f.game.mobStatusEffects.effectsFor(target(f, first)),
    }],
  };
  await assert.rejects(() => gameMobFixture(t, { saved: malformed }));
});

test("repeated removal retires status immediately under sidecar cap pressure", async (t) => {
  const f = await gameMobFixture(t);
  for (let index = 0; index < 1025; index++) {
    const mob = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
      id: "potion:status-cap-reuse",
    });
    assert.ok(mob);
    assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
      { target: target(f, mob) },
    ])).ok, true);
    assert.equal(f.game.mobStatusEffects.serialize().entries.length, 1);
    f.wildlife.remove(mob);
    assert.equal(f.game.mobStatusEffects.serialize().entries.length, 0);
  }
});

test("canonical horse, ecology and Wildlife removals retire live statuses", async (t) => {
  const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
  const horse = f.spawn("potion:retire-horse", { x: 6.5, y: 65, z: 8.5 });
  const resident = turtle(f, { x: 10.5, y: 65, z: 8.5 });
  const cow = f.wildlife.spawn("cow", { x: 14.5, y: 65, z: 8.5 }, {
    id: "potion:retire-cow",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
    { target: target(f, horse) },
    { target: target(f, resident) },
    { target: target(f, cow) },
  ])).ok, true);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 3);
  assert.equal(f.horses.hurt(horse, horse.health, null, { retaliate: false }).killed, true);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 2);
  assert.equal(f.ecology.hurt(resident, resident.health, null, { retaliate: false }).killed, true);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 1);
  assert.equal(f.wildlife.damage(cow, cow.health, null, false).killed, true);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 0);
});

test("retirement veto atomically retains direct, horse and ecology lives", async (t) => {
  const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
  const horse = f.spawn("potion:veto-retire-horse", { x: 6.5, y: 65, z: 8.5 });
  const resident = turtle(f, { x: 10.5, y: 65, z: 8.5 });
  const cow = f.wildlife.spawn("cow", { x: 14.5, y: 65, z: 8.5 }, {
    id: "potion:veto-retire-cow",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"),
    [horse, resident, cow].map((mob) => ({ target: target(f, mob) })))).ok, true);
  const prepare = f.game.mobStatusEffects.prepareRetire.bind(f.game.mobStatusEffects);
  t.mock.method(f.game.mobStatusEffects, "prepareRetire", (...args) => {
    const participant = prepare(...args);
    return participant && Object.freeze({ ...participant, validate: () => false });
  });
  assert.equal(f.horses.hurt(horse, horse.health, null, { retaliate: false }).killed, false);
  assert.equal(f.ecology.hurt(resident, resident.health, null, { retaliate: false }).killed, false);
  assert.equal(f.wildlife.damage(cow, cow.health, null, false).killed, false);
  assert.equal(f.wildlife.byId.get(horse.id), horse);
  assert.equal(f.wildlife.byId.get(resident.id), resident);
  assert.equal(f.wildlife.byId.get(cow.id), cow);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 3);
});

test("removal observer failure cannot own roster or status publication", async (t) => {
  const f = await gameMobFixture(t);
  const cow = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:observer-retire-cow",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
    { target: target(f, cow) },
  ])).ok, true);
  f.wildlife.onRemove = () => { throw new Error("deliberate removal observer failure"); };
  assert.equal(f.wildlife.damage(cow, cow.health, null, false).killed, true);
  assert.equal(f.wildlife.byId.has(cow.id), false);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 0);
});

test("creeper explosion retirement veto and stale pose fail before every effect", async (t) => {
  for (const refusal of ["retirement", "stale-pose"]) {
    const f = await gameMobFixture(t);
    const creeper = f.wildlife.spawn("creeper", { x: 8.5, y: 65, z: 9.5 }, {
      id: `potion:explosion-${refusal}`,
    });
    assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
      { target: target(f, creeper) },
    ])).ok, true);
    if (refusal === "retirement") {
      const prepare = f.game.mobStatusEffects.prepareRetire.bind(f.game.mobStatusEffects);
      t.mock.method(f.game.mobStatusEffects, "prepareRetire", (...args) => {
        const participant = prepare(...args);
        return participant && Object.freeze({ ...participant, validate: () => false });
      });
    }
    const health = f.gameplay.health, revision = f.world._editRevision;
    const plan = f.wildlife.prepareMobExplosion(creeper, 3);
    assert.ok(plan);
    if (refusal === "stale-pose") creeper.position.x += 0.25;
    assert.equal(f.wildlife.commitMobExplosion(plan).ok, false);
    assert.equal(f.wildlife.byId.get(creeper.id), creeper);
    assert.equal(f.wildlife.killed.has(creeper.id), false);
    assert.equal(f.game.mobStatusEffects.serialize().entries.length, 1);
    assert.equal(f.gameplay.health, health);
    assert.equal(f.world._editRevision, revision);
    if (refusal === "retirement")
      f.game.mobStatusEffects.prepareRetire.mock.restore();
  }
});

test("successful creeper explosion publishes removal before real player/world effects", async (t) => {
  const f = await gameMobFixture(t);
  const creeper = f.wildlife.spawn("creeper", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:explosion-success",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
    { target: target(f, creeper) },
  ])).ok, true);
  const health = f.gameplay.health, revision = f.world._editRevision;
  assert.equal(f.wildlife.explodeMob(creeper, 3), true);
  assert.equal(f.wildlife.byId.has(creeper.id), false);
  assert.equal(f.wildlife.killed.has(creeper.id), true);
  assert.equal(f.game.mobStatusEffects.serialize().entries.length, 0);
  assert.ok(f.gameplay.health < health);
  assert.ok(f.world._editRevision > revision);
});

test("impact descriptors reject duplicates and roster identity mismatches", async (t) => {
  const f = await gameMobFixture(t);
  const first = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:descriptor-a",
  });
  const second = f.wildlife.spawn("cow", { x: 11.5, y: 65, z: 9.5 }, {
    id: "potion:descriptor-b",
  });
  const descriptor = target(f, first);
  assert.equal(f.game.mobPotionImpact.prepareImpact({
    potion: splash("harming"),
    impacts: [
      { target: descriptor, splash: { distance: 0, directHit: true } },
      { target: descriptor, splash: { distance: 2, directHit: false } },
    ],
    validate: () => true,
  }), null);
  const plan = impact(f, splash("harming"), [
    { target: target(f, second), distance: 3, directHit: false },
    { target: descriptor },
  ]);
  assert.equal(f.game.mobPotionImpact.commit(plan).ok, true);
  assert.equal(first.health, 8);
  assert.equal(second.health, 12);
  f.wildlife.byId.delete(first.id);
  assert.equal(f.game.mobPotionImpact.readTargets(), null);
  f.wildlife.byId.set(first.id, first);
});

test("travel freezes inactive-dimension timers and restores the same life", async (t) => {
  const f = await gameMobFixture(t);
  const cow = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
    id: "potion:travel",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("poison"), [
    { target: target(f, cow) },
  ])).ok, true);
  const identity = {
    dimension: "overworld",
    entityId: cow.id,
    life: cow.life,
  };
  const before = f.game.mobStatusEffects.effectsFor(identity);
  f.game.travel = new GameTravel(f.game);
  assert.equal((await f.game.travel.teleport({
    x: 40.5, y: 65, z: 40.5, dimension: "nether",
  })).ok, true);
  f.game.mobPotionImpact.frame(0.25, { simulating: true });
  assert.deepEqual(f.game.mobStatusEffects.effectsFor(identity), before);
  f.game.travel = new GameTravel(f.game);
  assert.equal((await f.game.travel.teleport({
    x: 8.5, y: 65, z: 11.5, dimension: "overworld",
  })).ok, true);
  const restored = f.game.wildlife.byId.get(cow.id);
  assert.equal(restored.life, cow.life);
  assert.deepEqual(f.game.mobStatusEffects.effectsFor(identity), before);
});

test("slowness changes actual ground AI and weakness changes actual melee creation", async (t) => {
  const f = await gameMobFixture(t);
  const normal = f.wildlife.spawn("zombie", { x: 5.5, y: 65, z: 7.5 }, {
    id: "potion:normal-speed",
  });
  const slowed = f.wildlife.spawn("zombie", { x: 11.5, y: 65, z: 7.5 }, {
    id: "potion:slow-speed",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
    { target: target(f, slowed) },
  ])).ok, true);
  for (const mob of [normal, slowed]) {
    mob.walking = true;
    mob.wanderTimer = 1;
    mob.targetYaw = 0;
  }
  const beforeNormal = normal.position.clone(), beforeSlowed = slowed.position.clone();
  stepMob(normal, 0.2, f.wildlife.context);
  stepMob(slowed, 0.2, f.wildlife.context);
  assert.ok(normal.position.distanceTo(beforeNormal) >
    slowed.position.distanceTo(beforeSlowed), JSON.stringify({
      normal: normal.position.distanceTo(beforeNormal),
      slowed: slowed.position.distanceTo(beforeSlowed),
      normalModifiers: f.wildlife.context.mobStatusModifiers(normal),
      slowedModifiers: f.wildlife.context.mobStatusModifiers(slowed),
    }));

  const zombie = f.wildlife.spawn("zombie", { x: 8.5, y: 65, z: 10 }, {
    id: "potion:weak-melee",
  });
  assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("weakness"), [
    { target: target(f, zombie) },
  ])).ok, true);
  zombie.attackCooldown = 0;
  f.wildlife.context.player.copy(f.player.position);
  f.wildlife.hasPlayer = true;
  f.wildlife.context.health = f.gameplay.health;
  stepMob(zombie, 0.05, f.wildlife.context);
  assert.ok(zombie.attackCooldown > 0, "the hostile attempted its actual melee");
  assert.equal(f.gameplay.health, 20, "Weakness I reduces this three-damage melee to zero");
});

test("slowness reaches the actual ridden-horse physics speed", async (t) => {
  const distance = async (slowed, suffix) => {
    const f = await gameMobFixture(t, { seed: `potion-horse-speed-${suffix}` });
    const horse = f.spawn(`potion:horse-speed:${suffix}`);
    await f.saddle(horse);
    if (slowed) {
      assert.equal(f.game.mobPotionImpact.commit(impact(f, splash("slowness"), [
        { target: target(f, horse) },
      ])).ok, true);
    }
    const before = horse.position.clone();
    f.key("KeyW");
    f.frame(12);
    f.key("KeyW", false);
    return horse.position.distanceTo(before);
  };
  const normal = await distance(false, "normal");
  const slowed = await distance(true, "slowed");
  assert.ok(normal > slowed, JSON.stringify({ normal, slowed }));
});
