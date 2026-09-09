import assert from "node:assert/strict";
import { ecologyCanOccupy, ecologyIsDaylight, isTurtleBeach } from "../src/aquatic-ai.js";
import { isSafeRespawnPosition } from "../src/bed-spawn.js";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { ECOLOGY_HOST_LIMITS } from "../src/ecology-population.js";
import { ecologyCollider } from "../src/expansion-ecology.js";
import { experienceForLevel } from "../src/experience.js";
import { GameMobIntegration } from "../src/game-mob-integration.js";
import { GameWeatherServices } from "../src/game-weather-services.js";
import { VoxelGame } from "../src/game.js";
import { ITEM } from "../src/items.js";
import { footprintLoaded, groundAt } from "../src/mob-navigation.js";
import { streamingDistanceLayout } from "../src/render-distance.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { World, raycast } from "../src/world.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";
import { findNaturalColumn } from "./terrain-v4-helpers.js";

// CPU-only native encounter infrastructure. Graphics/audio remain the shared
// fixture's transports; this is not renderer, frame-budget or from-zero loot proof.
export const NATIVE_COMBAT_LIMITS = Object.freeze({
  seed: "cedar-valley", generatorVersion: 4, dimension: "overworld",
  coarseSamples: 9409, neighborSamplesPerBeach: 8, ensureRadius: 2,
  boxRadius: 3, uniqueColumns: 49, schedulerFrames: 1,
});
const PLAYER_BODY = Object.freeze({ radius: 0.3, height: 1.8 });
const TURTLE_ANGLE = 2.399963229728653;
const TURTLE_RADIUS = 33;
const sorted = (values) => [...values].sort();
export const combatPose = (f) => ({
  ...point(f.player.position), yaw: f.player.yaw, pitch: f.player.pitch,
  flying: f.player.flying,
});

function activateWithWeather(t, f, saved) {
  // The shared mob fixture predates weather. Install its real owner before the
  // first Game frame/event binding; never drop/default an archived clock at reload.
  const weather = new GameWeatherServices({ world: f.world, saved });
  t.after(() => weather.dispose());
  assert.equal(weather.activate(f.game).ok, true);
  f.weather = weather;
  f.activate();
}

function footprint(position, radius) {
  assert.ok(Number.isInteger(radius) && radius >= 0 && radius <= NATIVE_COMBAT_LIMITS.ensureRadius);
  const cx = Math.floor(position.x / 16), cz = Math.floor(position.z / 16);
  const columns = [];
  for (let z = cz - radius; z <= cz + radius; z++)
    for (let x = cx - radius; x <= cx + radius; x++) columns.push(`${x},${z}`);
  return { position: { x: position.x, z: position.z }, cx, cz, radius, columns: sorted(columns) };
}

/** Declare every public admission before the first load, not after seeing geometry. */
export function nativeCombatAdmission(column) {
  const at = { x: column.x + 0.5, y: column.top + 1, z: column.z + 0.5 };
  const observer = footprint({
    x: at.x - Math.sin(TURTLE_ANGLE) * TURTLE_RADIUS,
    z: at.z - Math.cos(TURTLE_ANGLE) * TURTLE_RADIUS,
  }, 2);
  // A fixed neighboring cell inside the selected 3x3 beach; no approach search,
  // platform, alternate beach, or admission widening if its actual ray is bad.
  const approach = footprint({ x: at.x, z: at.z + 1 }, 2);
  const midpoint = {
    x: (observer.position.x + approach.position.x) / 2,
    z: (observer.position.z + approach.position.z) / 2,
  };
  const cx = Math.floor(midpoint.x / 16), cz = Math.floor(midpoint.z / 16);
  const columns = sorted(new Set([...observer.columns, ...approach.columns]));
  const box = {
    midpoint, cx, cz, radius: 3,
    minCX: cx - 3, maxCX: cx + 3, minCZ: cz - 3, maxCZ: cz + 3,
  };
  assert.ok(columns.length <= NATIVE_COMBAT_LIMITS.uniqueColumns);
  for (const key of columns) {
    const [x, z] = key.split(",").map(Number);
    assert.ok(x >= box.minCX && x <= box.maxCX && z >= box.minCZ && z <= box.maxCZ,
      `Declared column ${key} escapes the fixed midpoint R3 box`);
  }
  assert.deepEqual({
    x: Math.floor(observer.position.x + Math.sin(TURTLE_ANGLE) * TURTLE_RADIUS) + 0.5,
    z: Math.floor(observer.position.z + Math.cos(TURTLE_ANGLE) * TURTLE_RADIUS) + 0.5,
  }, { x: at.x, z: at.z });
  return {
    observer, approach, columns, box,
    anvil: { dimension: "overworld", x: column.x + 2, y: column.top + 1, z: column.z + 1 },
    fixtureAdmissions: {
      initial: footprint(observer.position, 1),
      cold: footprint(approach.position, 1),
    },
    // The shared headless fixture has renderRadius 0; normal Game streaming
    // therefore requests R2. No retention settings or private pins are changed.
    frameStreamingRadius: streamingDistanceLayout(0).demandRadius,
  };
}

function discoverBeach(world) {
  const discovery = { coarseSamples: 0, beachCandidates: 0, neighborSamples: 0 };
  const column = findNaturalColumn(world.generator, (candidate) => {
    assert.ok(++discovery.coarseSamples <= NATIVE_COMBAT_LIMITS.coarseSamples);
    if (candidate.id !== "beach" || candidate.waterLevel !== null ||
        candidate.top < 60 || candidate.top > 68) return false;
    discovery.beachCandidates++;
    for (const dz of [-1, 0, 1])
      for (const dx of [-1, 0, 1]) {
        if (dx === 0 && dz === 0) continue;
        discovery.neighborSamples++;
        const neighbor = world.generator.sampleColumn(candidate.x + dx, candidate.z + dz);
        if (neighbor.id !== "beach" || neighbor.top !== candidate.top ||
            neighbor.waterLevel !== null) return false;
      }
    return true;
  }, "flat dry native combat beach", { radius: 6144, step: 128 });
  assert.ok(discovery.neighborSamples <= discovery.beachCandidates * 8);
  assert.equal(world.generator.counters.chunkGenerations, 0);
  assert.equal(world.generator.counters.regionGenerations, 0);
  assert.equal(world.chunks.size, 0);
  return {
    column: { x: column.x, z: column.z, top: column.top, biome: column.id, waterLevel: column.waterLevel },
    discovery,
  };
}

export function assertCombatBounds(world, admission, label) {
  const generated = world.generator.counters.chunkGenerations;
  const resident = sorted(world.chunks.keys()), removed = sorted(world.removedChunks);
  const actual = new Set([...resident, ...removed]);
  assert.ok(generated <= admission.columns.length && generated <= NATIVE_COMBAT_LIMITS.uniqueColumns,
    `${label}: actual generation ${generated} exceeds the declared union ${admission.columns.length}`);
  assert.equal(actual.size, generated, `${label}: no hidden eviction/re-generation`);
  for (const key of actual) assert.ok(admission.columns.includes(key), `${label}: undeclared column ${key}`);
  assert.equal(world.admissionObserverErrors.length, 0, `${label}: no swallowed admission failure`);
  assert.ok([...world.chunks.values()].every((chunk) =>
    chunk.blocks instanceof Uint16Array && Number.isSafeInteger(chunk.incarnation) &&
    chunk.minY === world.spec.minY));
  return {
    label, generatedColumns: generated, residentColumns: resident.length,
    removedColumns: removed.length, resident, removed,
    regionGenerations: world.generator.counters.regionGenerations,
  };
}

function safeFeet(world, position, label, nearY) {
  assert.equal(footprintLoaded(world, position.x, position.z, PLAYER_BODY.radius), true, `${label}: loaded feet`);
  // A bounded scan of this ONE actual admitted footprint. Do not use a sampled
  // terrain height as collision evidence or borrow the turtle's sea-level probe.
  const y = groundAt(world, position.x, position.z, PLAYER_BODY, {
    nearY: nearY ?? world.spec.maxY - PLAYER_BODY.height,
    stepHeight: 0, maxDrop: nearY === undefined ? world.spec.maxY - world.spec.minY : 0.05,
    natural: true, avoidHazards: true,
  });
  assert.notEqual(y, null, `${label}: no dry supported native stance at ${JSON.stringify(position)}`);
  const feet = { ...position, y };
  assert.equal(isSafeRespawnPosition(world, feet), true, `${label}: actual body clearance and dry support`);
  return feet;
}

export function nativeTurtleState(proof) {
  const { f, targetId } = proof;
  const mob = f.wildlife.byId.get(targetId);
  assert.ok(mob && mob.kind === "turtle", `Missing native turtle ${targetId}`);
  return {
    id: mob.id, life: mob.life, health: mob.health, dead: mob.dead,
    position: point(mob.position), sidecar: f.ecology.ecology.state(mob.id),
  };
}

export function aimNativeTurtle(proof) {
  const { f, admission, column } = proof;
  const mob = f.wildlife.byId.get(proof.targetId);
  assert.ok(mob);
  f.player.setPosition(safeFeet(f.world, admission.approach.position, "fixed turtle approach", column.top + 1));
  f.aim(mob, ecologyCollider("turtle", f.ecology.ecology.state(mob.id)).height / 2);
  f.game.updateTarget();
  const precise = f.wildlife.raycast(f.player.eyePosition, f.player.forward, 3);
  const block = raycast(f.world, f.player.eyePosition, f.player.forward, 3);
  assert.equal(precise?.entity, mob, "physical eye ray must hit the actual native turtle model");
  assert.ok(!block || precise.distance < block.distance, "no anvil/terrain between eye and victim");
  assert.equal(f.game.meleeTarget?.entity, mob, "normal Game melee collider must select the same victim");
  assert.equal(f.player.flying, false);
  return combatPose(f);
}

export function aimCombatAnvil(proof) {
  const { f, anvil, admission, column } = proof;
  f.player.setPosition(safeFeet(f.world, admission.approach.position, "fixed anvil approach", column.top + 1));
  f.aim({ x: anvil.x + 0.5, y: anvil.y, z: anvil.z + 0.5 }, 0.5);
  f.game.updateTarget();
  assert.deepEqual(f.game.target && {
    x: f.game.target.x, y: f.game.target.y, z: f.game.target.z,
  }, { x: anvil.x, y: anvil.y, z: anvil.z });
  assert.equal(f.game.mobTarget, null, "physical anvil use is not intercepted by a mob");
  assert.ok([BLOCK.ANVIL, BLOCK.CHIPPED_ANVIL].includes(f.game.target.id));
  return combatPose(f);
}

/** Only authored resources: plain iron sword, one Sharpness III book and 27 XP. */
export function assertUnpaidCombat(proof) {
  const { f, anvil } = proof;
  const inventory = f.gameplay.serialize();
  assert.deepEqual(inventory.slots, [
    progressionStack(ITEM.IRON_SWORD),
    progressionStack(ITEM.ENCHANTED_BOOK, 1, { enchantments: { sharpness: 3 } }),
    ...Array(34).fill(null),
  ]);
  assert.equal(inventory.slots[0].durability, 250);
  assert.equal(inventory.experience.total, 27);
  assert.equal(inventory.experience.level, 3);
  assert.equal(inventory.offhand, null);
  assert.equal(inventory.cursor, null);
  assert.ok(Object.values(inventory.equipment).every((stack) => stack === null));
  assert.ok(inventory.craftingGrid.every((stack) => stack === null));
  assert.deepEqual(inventory.crafting, []);
  assert.equal(f.progression.isOpen, false);
  assert.deepEqual(f.progression.services.effects.serialize().effects, []);
  assert.equal(f.progression.services.stations.get(anvil), null);
  assert.deepEqual(f.world.getCell(anvil.x, anvil.y, anvil.z), normalizeCell({ id: BLOCK.ANVIL }));
  assert.equal(f.world.edits.size, 1);
  assert.equal(nativeTurtleState(proof).health, 30);
  assert.equal(f.wildlife.autoSpawn, true);
}

/** FIRST native beach + unchanged Ecology/Wildlife scheduling in a real Game frame. */
export async function nativeCombatFixture(t) {
  const world = new World(NATIVE_COMBAT_LIMITS.seed, {
    generatorVersion: 4, dimension: "overworld", useWorker: false,
  });
  t.after(() => world.dispose());
  const { column, discovery } = discoverBeach(world);
  const admission = nativeCombatAdmission(column);
  assert.equal(admission.frameStreamingRadius, 2);
  const evidence = {
    seed: world.seed, generatorVersion: world.generatorVersion, dimension: world.dimension,
    discovery, column, admission, observations: [],
    authoredPrerequisites: [
      "starting observer and physical approach",
      "one plain iron sword (250 durability)",
      "one Sharpness III book", "exactly level 3 / 27 XP",
      "one fresh supplied anvil in native air above native sand",
    ],
    scope: "CPU native combat/resources/save proof; not native item acquisition, GUI, GPU or frame-budget evidence",
  };
  t.diagnostic?.(`native combat declared BEFORE loading: ${JSON.stringify(evidence)}`);
  await world.ensureArea(admission.observer.position, 2);
  evidence.observations.push(assertCombatBounds(world, admission, "observer admission"));
  assert.equal(world.generator.counters.chunkGenerations, admission.observer.columns.length);
  assert.deepEqual(sorted(world.chunks.keys()), admission.observer.columns);
  const observer = safeFeet(world, admission.observer.position, "scheduler observer");
  const f = await gameMobFixture(t, {
    world, generatorFactory: null, spawnPosition: observer,
    autoSpawn: true, admissionRadius: 1, activate: false,
  });
  activateWithWeather(t, f);
  assert.equal(f.game.frame, VoxelGame.prototype.frame);
  assert.equal(f.game.primary, VoxelGame.prototype.primary);
  assert.equal(f.player.allowFlight, false);
  assert.equal(f.player.flying, false);
  assert.equal(f.mobs.readHabitat, GameMobIntegration.prototype.readHabitat,
    "the Game's production admitted-cell habitat bridge stays installed");
  assert.equal(ecologyIsDaylight(f.game.currentTime), true);
  assert.equal(f.game.currentTime, 0.36, "unchanged default day");
  assert.equal(f.wildlife.entities.length, 0);
  const beforeFrame = world.generator.counters.chunkGenerations;
  f.frame(1);
  assert.equal(world.generator.counters.chunkGenerations, beforeFrame, "native scheduler does not generate chunks");
  assert.equal(f.gameplay.dead, false);
  assert.equal(isSafeRespawnPosition(world, point(f.player.position)), true);
  const homeBeach = { x: column.x + 0.5, y: column.top + 1, z: column.z + 0.5 };
  assert.equal(f.ecology.habitat(homeBeach, "turtle")?.biomeId, column.biome);
  const mob = f.wildlife.entities.find((entry) => entry.kind === "turtle" &&
    JSON.stringify(f.ecology.ecology.state(entry.id)?.homeBeach) === JSON.stringify(homeBeach));
  assert.ok(mob, `First selected native beach did not admit the serial-1 turtle: ${JSON.stringify({
    observer, homeBeach, residents: f.wildlife.serialize().entities,
  })}`);
  assert.equal(mob.spec.temperament, "passive");
  assert.equal(mob.health, 30);
  assert.equal(mob.dead, false);
  assert.ok(Number.isSafeInteger(mob.life));
  assert.equal(ecologyCanOccupy(world, mob.position, ecologyCollider("turtle")), true);
  assert.equal(isTurtleBeach(world, homeBeach, ecologyCollider("turtle")), true);
  assert.deepEqual(world.serialize().edits, []);
  assert.equal(world.get(column.x, column.top, column.z), BLOCK.SAND);
  assert.ok(homeBeach.y <= world.spec.seaLevel + 6 &&
    homeBeach.y > world.spec.seaLevel + 6 - ECOLOGY_HOST_LIMITS.verticalProbes);
  evidence.scheduler = {
    frames: 1, serial: 1, angle: TURTLE_ANGLE, radius: TURTLE_RADIUS,
    probeTop: world.spec.seaLevel + 6, probes: ECOLOGY_HOST_LIMITS.verticalProbes,
    observer: combatPose(f), id: mob.id, life: mob.life, health: mob.health, homeBeach,
  };
  evidence.observations.push(assertCombatBounds(world, admission, "after unchanged Game scheduler"));
  // Load the declared approach normally. Observer-only columns may be evicted;
  // residency is NOT the generation count and no old 16-column proof is changed.
  await world.ensureArea(admission.approach.position, 2);
  evidence.observations.push(assertCombatBounds(world, admission, "approach admission"));
  assert.equal(world.generator.counters.chunkGenerations, admission.columns.length);
  assert.deepEqual(sorted(world.chunks.keys()), admission.approach.columns);
  assert.equal(world.edits.size, 0);
  const anvil = admission.anvil;
  const before = world.getCell(anvil.x, anvil.y, anvil.z);
  assert.deepEqual(before, normalizeCell({ id: BLOCK.AIR }), "selected anvil cell is native empty space");
  assert.equal(world.get(anvil.x, anvil.y - 1, anvil.z), BLOCK.SAND);
  assert.equal(world.applyCells([{ ...anvil, before, after: normalizeCell({ id: BLOCK.ANVIL }) }]), true);
  assert.equal(world.edits.size, 1, "the supplied anvil is the sole authored world edit");
  assert.equal(ecologyCanOccupy(world, mob.position, ecologyCollider("turtle")), true,
    "the supplied anvil must also leave the native turtle collider clear");
  assert.equal(experienceForLevel(3), 27);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    assert.ok(owned.slots.every((stack) => stack === null));
    assert.equal(owned.cursor, null);
    assert.equal(owned.offhand, null);
    assert.ok(Object.values(owned.equipment).every((stack) => stack === null));
    assert.ok(owned.craftingGrid.every((stack) => stack === null));
    owned.slots[0] = progressionStack(ITEM.IRON_SWORD);
    owned.slots[1] = progressionStack(ITEM.ENCHANTED_BOOK, 1, { enchantments: { sharpness: 3 } });
    owned.experienceTotal = 27;
    return true;
  }), true);
  const proof = { f, column, admission, evidence, anvil, targetId: mob.id };
  proof.poses = { observer: evidence.scheduler.observer, hit: aimNativeTurtle(proof) };
  proof.poses.anvil = aimCombatAnvil(proof);
  proof.poses.initial = combatPose(f);
  evidence.poses = proof.poses;
  evidence.anvil = anvil;
  assertUnpaidCombat(proof);
  t.diagnostic?.(`native combat starting fixture: ${JSON.stringify({
    target: nativeTurtleState(proof), poses: proof.poses, anvil, bounds: evidence.observations,
  })}`);
  return proof;
}

/** Freeze simulation BEFORE awaiting admission or capturing any paid owners. */
export async function freezeNativeCombat(proof) {
  const { f, admission } = proof;
  assert.deepEqual(footprint(f.player.position, 2).columns, admission.approach.columns,
    "checkpoint cannot admit outside the predeclared approach");
  f.game.paused = true;
  f.game.resetActions();
  f.world.clearStreaming();
  const generated = f.world.generator.counters.chunkGenerations;
  await f.world.ensureArea(f.player.position, 2);
  assert.equal(f.world.generator.counters.chunkGenerations, generated, "checkpoint does not repair missing admission");
  assertCombatBounds(f.world, admission, "frozen checkpoint");
  assert.equal(f.world.streamingStatus().inflight, 0);
  assert.equal(f.world.streamingStatus().demand, 0);
}

export function checkedCombatArchive(proof) {
  assert.equal(proof.f.game.paused, true, "freeze the source before serializing");
  const text = exportWorldFile(proof.f.snapshot());
  const saved = parseWorldFile(text);
  assert.deepEqual(saved, JSON.parse(text), "export/parser preserve all owner bytes");
  const { context, ...components } = normalizeWorldComponents(saved);
  assert.equal(context.seed, NATIVE_COMBAT_LIMITS.seed);
  assert.equal(context.generatorVersion, 4);
  assert.deepEqual({ ...saved, ...components }, saved, "preflight preserves resources, clocks and identity");
  return { text, saved };
}

// Only resident scan metadata may rebuild at activation. No resource, random
// state, pending fluid work, simulation clock or other owner is exempt.
function fluidResources(fluids) {
  return {
    ...fluids,
    dimensions: fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
  };
}

export async function reloadNativeCombat(t, proof) {
  await freezeNativeCombat(proof);
  const { text, saved } = checkedCombatArchive(proof);
  t.diagnostic?.(`native combat cold admission BEFORE loading: ${JSON.stringify({
    fixture: proof.admission.fixtureAdmissions.cold, required: proof.admission.approach,
  })}`);
  const f = await gameMobFixture(t, {
    saved, generatorFactory: null, autoSpawn: true, admissionRadius: 1, activate: false,
  });
  activateWithWeather(t, f, saved);
  assert.notEqual(f.game, proof.f.game);
  assert.notEqual(f.world, proof.f.world);
  assert.notEqual(f.coordinator, proof.f.coordinator);
  assert.notEqual(f.wildlife, proof.f.wildlife);
  assert.notEqual(f.progression.services, proof.f.progression.services);
  assert.equal(f.world.seed, saved.world.seed);
  assert.equal(f.world.generatorVersion, saved.world.generatorVersion);
  assert.equal(f.world.dimension, saved.world.dimension);
  const restored = { ...proof, f };
  f.game.paused = true;
  await f.world.ensureArea(proof.admission.approach.position, 2);
  assert.equal(f.world.generator.counters.chunkGenerations, proof.admission.approach.columns.length);
  assert.deepEqual(sorted(f.world.chunks.keys()), proof.admission.approach.columns);
  assertCombatBounds(f.world, proof.admission, "fresh cold reconstruction");
  // Project the authoritative clock; never author a replacement simulation time.
  assert.equal(f.game.currentTime, f.building.worldClock.time);
  const after = f.snapshot();
  assert.deepEqual(Object.keys(after).sort(), Object.keys(saved).sort());
  for (const key of Object.keys(saved)) {
    if (key === "fluids") assert.deepEqual(fluidResources(after[key]), fluidResources(saved[key]), key);
    else assert.deepEqual(after[key], saved[key], `cold reconstruction: ${key}`);
  }
  assert.deepEqual(nativeTurtleState(restored), nativeTurtleState(proof));
  assert.equal(exportWorldFile(proof.f.snapshot()), text, "detached cold reconstruction cannot mutate the frozen source");
  t.diagnostic?.(`native combat cold archive: ${Buffer.byteLength(text)} bytes; all owned resources/clocks exact; only fluid scan metadata re-admitted`);
  return restored;
}
