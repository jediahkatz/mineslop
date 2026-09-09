import assert from "node:assert/strict";
import { ecologyCanOccupy } from "../src/aquatic-ai.js";
import { isWaterFluid } from "../src/block-state.js";
import { GameWeatherServices } from "../src/game-weather-services.js";
import { streamingDistanceLayout } from "../src/render-distance.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { World } from "../src/world.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";
import { findNaturalColumn } from "./terrain-v4-helpers.js";

export const NATIVE_AQUATIC_RESOURCE_LIMITS = Object.freeze({
  fixtureVersion: 2,
  seed: "cedar-valley", generatorVersion: 4, coarseSamples: 9409,
  admissionRadius: 2, boxRadius: 3, columns: 49, maximumGenerations: 100,
  populationFrames: 32, approachRadius: 1,
});
const BODY = Object.freeze({ radius: 0.3, height: 1.8 });
const counts = (world) => ({
  chunks: world.generator.counters.chunkGenerations,
  regions: world.generator.counters.regionGenerations,
});
const pose = (f) => ({
  ...point(f.player.position), yaw: f.player.yaw, pitch: f.player.pitch, flying: f.player.flying,
});

function areaColumns(at, radius) {
  const cx = Math.floor(at.x / 16), cz = Math.floor(at.z / 16), columns = [];
  for (let z = cz - radius; z <= cz + radius; z++)
    for (let x = cx - radius; x <= cx + radius; x++) columns.push(`${x},${z}`);
  return columns.sort();
}

async function admitArea(proof, at, label, requireReady = false) {
  const { f } = proof, { world } = f;
  const columns = areaColumns(at, NATIVE_AQUATIC_RESOURCE_LIMITS.admissionRadius);
  assert.ok(columns.every((key) => proof.columns.includes(key)), "admission stays in the predeclared R3 box");
  assert.deepEqual(counts(world), proof.generated, "unaccounted asynchronous terrain work is a failure");
  const missing = columns.filter((key) => !world.chunks.has(key));
  if (requireReady) {
    assert.deepEqual(missing, [], "freezing must not repair incomplete live demand");
    assert.equal(world.streamingStatus().missing, 0);
    assert.equal(world.streamingStatus().inflight, 0);
  }
  const before = counts(world);
  f.game.paused = true;
  f.game.resetActions();
  world.clearStreaming();
  await world.ensureArea(at, NATIVE_AQUATIC_RESOURCE_LIMITS.admissionRadius);
  assert.equal(world.generator.counters.chunkGenerations - before.chunks, missing.length);
  assert.deepEqual([...world.chunks.keys()].sort(), columns);
  proof.generated = counts(world);
  proof.currentColumns = columns;
  assert.ok(proof.generated.chunks <= NATIVE_AQUATIC_RESOURCE_LIMITS.maximumGenerations);
  proof.evidence.admissions.push({ label, columns, missing, ...proof.generated });
}

function activate(t, f, saved) {
  const weather = new GameWeatherServices({ world: f.world, saved });
  t.after(() => weather.dispose());
  assert.equal(weather.activate(f.game).ok, true);
  f.weather = weather;
  f.activate();
}

/**
 * One native ocean, a fixed 49-column box and 32 ordinary population frames.
 * This CPU transport has renderRadius=0 and real R2/25-column streaming demand.
 * Each approach declares/adopts that exact R2 footprint before input; normal
 * eviction and any later re-generation are counted, never hidden by pinning.
 * No injected residents, RNG changes, platforms, test drops or alternate seed.
 * The finite starting sword and later test approach are explicit prerequisites.
 */
export async function nativeAquaticResources(t) {
  const limits = NATIVE_AQUATIC_RESOURCE_LIMITS;
  const world = new World(limits.seed, { generatorVersion: limits.generatorVersion, useWorker: false });
  t.after(() => world.dispose());
  let samples = 0;
  const column = findNaturalColumn(world.generator, (candidate) => {
    assert.ok(++samples <= limits.coarseSamples);
    return /(^|_)ocean$/.test(candidate.id) && !candidate.frozen && !/frozen/.test(candidate.id) &&
      candidate.waterLevel !== null && candidate.waterLevel - candidate.top >= 8;
  }, "deep non-frozen aquatic resource ocean");
  assert.equal(world.generator.counters.chunkGenerations, 0);
  const center = { x: column.x + 0.5, y: world.spec.seaLevel - 2, z: column.z + 0.5 };
  const cx = Math.floor(center.x / 16), cz = Math.floor(center.z / 16);
  const columns = areaColumns(center, limits.boxRadius);
  assert.equal(columns.length, limits.columns);
  const initialColumns = areaColumns(center, limits.admissionRadius);
  await world.ensureArea(center, limits.admissionRadius);
  const f = await gameMobFixture(t, {
    world, generatorFactory: null, spawnPosition: center,
    admissionRadius: 1, autoSpawn: true, activate: false,
  });
  activate(t, f);
  assert.equal(f.game.graphics.renderRadius, 0);
  assert.equal(streamingDistanceLayout(0).demandRadius, limits.admissionRadius);
  assert.deepEqual([...world.chunks.keys()].sort(), initialColumns);
  assert.equal(world.generator.counters.chunkGenerations, initialColumns.length);
  assert.equal(world.edits.size, 0, "the initial habitat is unedited native terrain");
  f.hold("IRON_SWORD");
  const generated = counts(world);
  f.frame(limits.populationFrames);
  assert.deepEqual(counts(world), generated, "normal population frames cannot load undeclared terrain");
  assert.equal(f.gameplay.dead, false);
  assert.equal(f.gameplay.health, 20);
  assert.ok(f.wildlife.entities.some((mob) => mob.kind === "cod"), "the real scheduler must admit cod");
  assert.ok(f.wildlife.entities.some((mob) => mob.kind === "squid"), "the real scheduler must admit squid");
  const proof = {
    f, center, cx, cz, columns, generated,
    evidence: {
      seed: world.seed, generatorVersion: world.generatorVersion,
      nativeColumn: { x: column.x, z: column.z, top: column.top, biome: column.id },
      fixtureVersion: limits.fixtureVersion,
      coarseSamples: samples, columns, populationFrames: limits.populationFrames,
      admissions: [{ label: "initial", columns: initialColumns, missing: initialColumns, ...generated }],
      population: f.wildlife.entities.map((mob) => ({
        id: mob.id, kind: mob.kind, life: mob.life, health: mob.health, position: point(mob.position),
      })),
      systemEditsAfterPopulation: world.edits.size,
    },
  };
  await admitArea(proof, center, "frozen population", true);
  t.diagnostic?.(`native aquatic population: ${JSON.stringify(proof.evidence)}`);
  return proof;
}

/** First live scheduled resident with a clear, loaded inner-R1 physical approach. */
export async function approachNativeAquatic(proof, kind) {
  const { f, cx, cz } = proof;
  f.game.paused = false;
  for (const mob of f.wildlife.entities) {
    if (mob.kind !== kind || mob.dead || mob.dormant) continue;
    for (const [dx, dz] of [[0, 1.7], [1.7, 0], [0, -1.7], [-1.7, 0]]) {
      const at = { x: mob.position.x + dx, y: mob.position.y, z: mob.position.z + dz };
      if (Math.abs(Math.floor(at.x / 16) - cx) > NATIVE_AQUATIC_RESOURCE_LIMITS.approachRadius ||
          Math.abs(Math.floor(at.z / 16) - cz) > NATIVE_AQUATIC_RESOURCE_LIMITS.approachRadius ||
          !ecologyCanOccupy(f.world, at, BODY) ||
          !isWaterFluid(f.world.getCell(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))?.fluid))
        continue;
      f.player.setPosition(at);
      f.aim(mob);
      f.game.updateTarget();
      if (f.game.meleeTarget?.entity !== mob) continue;
      assert.equal(mob.health, mob.spec.health, "the resource victim keeps its full native health");
      assert.deepEqual(counts(f.world), proof.generated, "physical approach only reads loaded terrain");
      await admitArea(proof, at, `${kind} approach`);
      f.game.paused = false;
      f.game.updateTarget();
      assert.equal(f.game.meleeTarget?.entity, mob, "public admission cannot substitute the selected resident");
      return { mob, pose: pose(f) };
    }
  }
  assert.fail(`No native ${kind} has a clear physical approach inside the declared inner R1`);
}

export async function freezeAquaticResources(proof) {
  const { f } = proof;
  await admitArea(proof, f.player.position, "frozen checkpoint", true);
  assert.equal(f.world.streamingStatus().inflight, 0);
  assert.equal(f.world.streamingStatus().demand, 0);
}

export function checkedAquaticArchive(proof) {
  assert.equal(proof.f.game.paused, true);
  const text = exportWorldFile(proof.f.snapshot()), saved = parseWorldFile(text);
  assert.deepEqual(saved, JSON.parse(text), "file normalization is lossless");
  const { context, ...components } = normalizeWorldComponents(saved);
  assert.equal(context.generatorVersion, NATIVE_AQUATIC_RESOURCE_LIMITS.generatorVersion);
  assert.deepEqual({ ...saved, ...components }, saved, "no owner is defaulted or lost at preflight");
  return { text, saved };
}

export async function restoreAquaticArchive(t, proof, saved) {
  const f = await gameMobFixture(t, {
    saved, generatorFactory: null, autoSpawn: true, admissionRadius: 1, activate: false,
  });
  activate(t, f, saved);
  const restored = { ...proof, f };
  f.game.paused = true;
  const columns = areaColumns(saved.player, NATIVE_AQUATIC_RESOURCE_LIMITS.admissionRadius);
  assert.deepEqual(columns, proof.currentColumns);
  await f.world.ensureArea(saved.player, NATIVE_AQUATIC_RESOURCE_LIMITS.admissionRadius);
  assert.equal(f.world.generator.counters.chunkGenerations, columns.length);
  assert.deepEqual([...f.world.chunks.keys()].sort(), columns);
  const after = f.snapshot();
  assert.deepEqual(Object.keys(after).sort(), Object.keys(saved).sort());
  const resources = (fluids) => ({
    ...fluids,
    dimensions: fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
  });
  for (const key of Object.keys(saved))
    assert.deepEqual(key === "fluids" ? resources(after[key]) : after[key],
      key === "fluids" ? resources(saved[key]) : saved[key], `cold native owner: ${key}`);
  return restored;
}
