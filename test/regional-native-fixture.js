import { createGenerator } from "../src/terrain.js";
import { getWorldSpec } from "../src/world-spec.js";
import { normalizeGeneratedChunk } from "../src/chunk-data.js";
import { BLOCK } from "../src/blocks.js";
import { rebuildSectionMeshes, usesSectionMeshing, clearSectionJobs } from "../src/section-renderer.js";
import { meshRevisionCurrent, sectionYs } from "../src/mesh-snapshot.js";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";

/** Native packets in a minimal CPU host; never change generation or dimensions. */
export function nativeGeometryFixture({
  seed = "cedar-valley", version = 7, dimension = "overworld", radius = 1,
  cx = 0, cz = 0, locate, legacyAdapter = true,
} = {}) {
  const generator = createGenerator(seed, dimension, version);
  const destination = locate ? generator.locateBiome(locate, { x: cx * 16, z: cz * 16 }) : null;
  if (locate && (!destination || destination.dimension !== dimension))
    throw new Error(`No native ${dimension} location for ${locate}`);
  if (destination) { cx = Math.floor(destination.x / 16); cz = Math.floor(destination.z / 16); }
  const world = authoredColumns([]);
  Object.assign(world, { generatorVersion: version, dimension, seed, generator,
    spec: getWorldSpec(version, dimension), getBiome: (x, z) => generator.getBiome(x, z) });
  const admit = (x, z) => {
    const chunk = world.admit(x, z);
    const packet = generator.generateChunk(x, z);
    return Object.assign(chunk, normalizeGeneratedChunk(packet, {
      type: "generate", schemaVersion: 2, id: 1, epoch: world.epoch,
      seed, generatorVersion: version, dimension, cx: x, cz: z,
      minY: world.spec.minY, maxY: world.spec.maxY,
    }));
  };
  const started = performance.now();
  for (let z = cz - radius - 1; z <= cz + radius + 1; z++)
    for (let x = cx - radius - 1; x <= cx + radius + 1; x++) admit(x, z);
  const generationMs = performance.now() - started;
  const renderer = shapeRenderer(world);
  renderer.camera.position.set(cx * 16 + 8, Math.min(100, world.spec.maxY - 8), cz * 16 + 8);
  renderer.renderDistanceOverride = radius;
  renderer.meshLimits = { regionalPages: true };
  const nativeRoute = usesSectionMeshing(world);
  // Test-only equivalent of the recommended parent renderer condition:
  // usesSectionMeshing(world) || meshLimits.regionalPages === true.
  const legacyRoutingAdapter = !nativeRoute && legacyAdapter;
  if (legacyRoutingAdapter) renderer.rebuildDirty = function(maximum = 2) {
    for (const key of world.removedChunks) {
      this.removeChunk(key);
      if (!world.chunks.has(key)) world.dirtyChunks.delete(key);
    }
    world.removedChunks.clear();
    this.syncVisibleChunks();
    return rebuildSectionMeshes(this, maximum);
  };
  const fixture = { world, renderer, generator, admit, generationMs, destination,
    seed, version, dimension, radius, cx, cz, nativeRoute, legacyRoutingAdapter };
  fixture.dispose = () => { clearSectionJobs(renderer); disposeShapeRenderer(renderer); };
  return fixture;
}

export function requiredGeometryState(fixture) {
  const { world, renderer, radius, cx, cz } = fixture;
  const coverage = renderer.detailCoverage(), ys = sectionYs(world);
  let covered = 0, fresh = 0, dirtySections = 0, sections = 0;
  for (let z = cz - radius; z <= cz + radius; z++)
    for (let x = cx - radius; x <= cx + radius; x++) {
      const key = `${x},${z}`, column = renderer.chunks.get(key);
      covered += Number(coverage.has(key));
      let current = coverage.has(key);
      for (const sy of ys) {
        const section = column?.userData.sections?.get(sy);
        sections += Number(!!section);
        const dirty = world.dirtySectionRevisions.has(`${key},${sy}`);
        dirtySections += Number(dirty);
        // Installed tickets have been acknowledged; compare the captured
        // sources/incarnations/revisions against a now-absent pending ticket.
        current &&= !!section && !dirty &&
          meshRevisionCurrent(world, { ...section.stamp, ticket: undefined });
      }
      fresh += Number(current);
    }
  return { required: (radius * 2 + 1) ** 2, requiredSections: ys.length * (radius * 2 + 1) ** 2,
    covered, fresh, sections, dirtySections };
}

export function markNativeNeighbors(fixture, cx, cz, sy) {
  const ys = sy === undefined ? sectionYs(fixture.world) : [sy - 1, sy, sy + 1]
    .filter((y) => sectionYs(fixture.world).includes(y));
  for (let z = cz - 1; z <= cz + 1; z++)
    for (let x = cx - 1; x <= cx + 1; x++)
      if (fixture.world.chunks.has(`${x},${z}`))
        for (const y of ys) fixture.world.dirty(x, z, y);
}

export function unloadNativeColumn(fixture, cx, cz) {
  const key = `${cx},${cz}`;
  fixture.world.chunks.delete(key);
  fixture.world.dirtyChunks.delete(key);
  for (const ticket of fixture.world.dirtySectionRevisions.keys())
    if (ticket.startsWith(`${key},`)) fixture.world.dirtySectionRevisions.delete(ticket);
  fixture.renderer.removeChunk(key);
}

export function nativeDistribution(fixture) {
  const flags = new Uint8Array(65536);
  for (const [name, id] of Object.entries(BLOCK))
    if (name === "LEAVES" || name.endsWith("_LEAVES")) flags[id] = 1;
    else if (name === "WATER") flags[id] = 2;
    else if (name.endsWith("_LOG")) flags[id] = 3;
  const cells = [0, 0, 0, 0], biomes = {};
  for (let z = fixture.cz - fixture.radius; z <= fixture.cz + fixture.radius; z++)
    for (let x = fixture.cx - fixture.radius; x <= fixture.cx + fixture.radius; x++) {
      const id = fixture.generator.getBiome(x * 16 + 8, z * 16 + 8).id;
      biomes[id] = (biomes[id] ?? 0) + 1;
      for (const block of fixture.world.chunks.get(`${x},${z}`).blocks) {
        if (block) cells[0]++;
        if (flags[block]) cells[flags[block]]++;
      }
    }
  return { columnCenterBiomes: biomes, nonAirCells: cells[0],
    leafCells: cells[1], waterCells: cells[2], logCells: cells[3] };
}
