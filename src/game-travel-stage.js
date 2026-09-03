import { BLOCK } from "./blocks.js";
import { cellsEqual, normalizeCell } from "./block-state.js";
import { findBedRespawn, isSafeRespawnPosition } from "./bed-spawn.js";
import { BED_STATE_VERSION, normalizeBedSnapshot } from "./bed-system.js";
import { bodyBox, boxCollides } from "./collision.js";
import { captureEntityContext } from "./entity-context.js";
import { sampleFluid } from "./fluid-sampling.js";
import { validBodyPosition } from "./geometry-world.js";
import { World } from "./world.js";
import { findSafeLanding } from "./world-interactions.js";
import { createWorldContext, isDimension } from "./world-spec.js";

export const RESPAWN_LOAD_RADIUS = 1;
const liquidOrAir = new Set([BLOCK.AIR, BLOCK.WATER, BLOCK.LAVA]);

export function travelLandingValid(world, position) {
  if (!position?.flying) return isSafeRespawnPosition(world, position);
  if (!validBodyPosition(position, world, { radius: 0.3, height: 1.8 }) ||
      boxCollides(world, bodyBox(position))) return false;
  const fluid = sampleFluid(world, position, { radius: 0.3, height: 1.8, eyeHeight: 1.62 });
  return fluid.valid && fluid.loaded && fluid.eyeLoaded && fluid.lavaImmersion === 0;
}

/**
 * The old landing helper writes a platform cell by cell. Inspection instead
 * prepares one bounded proposal in a detached World, then travel re-prepares
 * those exact reads against the real destination. Never overwrite a station,
 * egg, chest, crop or other resource owner to make an arrival fit.
 */
function arrivalPlatform(world, destination) {
  const { minY, maxY, seaLevel } = world.spec;
  const x = Math.floor(destination.x), z = Math.floor(destination.z);
  const y = Math.max((seaLevel ?? minY) + 4,
    Math.min(maxY - 4, Math.floor(destination.y) || minY + 40));
  const changes = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++) {
        const at = { x: x + dx, y: y + dy, z: z + dz };
        const before = world.getCell(at.x, at.y, at.z);
        const after = normalizeCell({ id: dy < 0
          ? world.dimension === "end" ? BLOCK.END_STONE : BLOCK.OBSIDIAN
          : BLOCK.AIR });
        if (!before || (!liquidOrAir.has(before.id) && !cellsEqual(before, after))) return null;
        if (!cellsEqual(before, after)) changes.push({ ...at, before, after });
      }
  if (changes.length && !world.applyCells(changes)) return null;
  const landing = { x: x + 0.5, y: y + 0.01, z: z + 0.5 };
  return travelLandingValid(world, landing) ? { landing, changes } : null;
}

export const createTravelPreviewWorld = (source, dimension) => new World(source.seed, {
  dimension, generatorVersion: source.generatorVersion,
  generatorFactory: source._generatorFactory,
  useWorker: !source._workerDisabled,
});

/**
 * No live World epoch/chunks, Player pose, mob binding or source ledger changes
 * during an await. The preview has its own coordinator and no service observers.
 * worldFactory is a test seam for authored terrain, not a runtime fallback.
 */
export async function stageTravelDestination(game, destination, {
  respawn = false, worldFactory = createTravelPreviewWorld,
} = {}) {
  const source = game.world, player = game.player, gameplay = game.gameplay;
  const wildlife = game.wildlife, vehicles = game.vehicleServices, mobs = game.mobIntegration;
  const dimension = respawn ? "overworld" : destination?.dimension ?? source.dimension;
  if (!(source instanceof World) || !isDimension(dimension) || source._disposed ||
      (!respawn && ![destination?.x, destination?.z].every(Number.isFinite)))
    throw new Error("Invalid destination inspection world or position");
  const context = createWorldContext(source), sourceCurrent = captureEntityContext(source, context);
  const revision = source._editRevision, mode = gameplay.mode, dead = gameplay.dead;
  const beds = game.beds ?? game.buildingActions?.beds;
  const bedRevision = beds?.revision;
  const spawn = normalizeBedSnapshot({
    version: BED_STATE_VERSION, spawn: beds?.getRespawn?.() ?? null,
  }, context);
  if (!spawn) throw new Error("Invalid saved bed before travel");
  const current = () => game.world === source && game.player === player &&
    game.gameplay === gameplay && player.world === source && sourceCurrent() &&
    game.wildlife === wildlife && game.vehicleServices === vehicles && game.mobIntegration === mobs &&
    source._editRevision === revision && gameplay.mode === mode && gameplay.dead === dead &&
    (!respawn || ((game.beds ?? game.buildingActions?.beds) === beds && beds?.revision === bedRevision));
  let preview;
  try {
    preview = worldFactory(source, dimension);
    if (!(preview instanceof World) || preview === source ||
        preview.coordinator === source.coordinator)
      throw new Error("Travel requires a detached destination World");
    if (!preview.loadEdits({ ...source.serialize(), dimension }))
      throw new Error("Cannot stage destination terrain edits");
    const ensure = async (at, radius) => {
      await preview.ensureArea(at, radius);
      if (!current()) throw new Error("Travel owners changed during destination inspection");
    };
    let landing, changes = [];
    if (respawn) {
      if (spawn.spawn) {
        await ensure(spawn.spawn, RESPAWN_LOAD_RADIUS);
        const bed = findBedRespawn(preview, spawn.spawn);
        if (bed && travelLandingValid(preview, bed)) landing = { ...bed, fromBed: true };
      }
      if (!landing) {
        const at = preview.getSpawn();
        await ensure(at, RESPAWN_LOAD_RADIUS);
        if (!travelLandingValid(preview, at))
          throw new Error("No unobstructed standing space at the world spawn");
        landing = { ...at, fromBed: false, missingBed: !!spawn.spawn };
      }
    } else {
      await ensure(destination, game.graphics.renderRadius + 1);
      landing = findSafeLanding(preview, destination, {
        allowFlying: mode === "creative", allowPlatform: false,
        // Reject wet/shape-invalid candidates inside the search, not after its
        // first coarse match has suppressed later landings and the platform.
        validateLanding: (candidate) => travelLandingValid(preview, candidate),
      });
      if (!landing && mode !== "creative") {
        const platform = arrivalPlatform(preview, destination);
        if (platform) ({ landing, changes } = platform);
      }
      if (!landing || !travelLandingValid(preview, landing))
        throw new Error("No safe destination was found");
    }
    if (!current()) throw new Error("Travel owners changed during destination inspection");
    return {
      world: preview, dimension, position: { ...landing, dimension },
      changes, current,
      radius: respawn ? RESPAWN_LOAD_RADIUS : game.graphics.renderRadius + 1,
      dispose: () => preview.dispose(),
    };
  } catch (error) {
    if (preview && preview !== source) preview.dispose();
    throw error;
  }
}

/** Recheck the exact prepared platform and standing space after live admission. */
export function installTravelLanding(world, stage) {
  if (world.dimension !== stage.dimension) return false;
  if (stage.changes.length) {
    const mutation = world.prepareMutation(stage.changes);
    if (!mutation || !world.coordinator.commit([mutation]).ok) return false;
  }
  return travelLandingValid(world, stage.position);
}

/** One World edit; blocked return portals never erase station/egg ownership. */
export function installTravelPortal(world, position, endPortal = false) {
  const { minY, maxY } = world.spec;
  const x = Math.floor(position.x) + 2, z = Math.floor(position.z);
  const y = Math.min(maxY - 6, Math.max(minY + 1, Math.floor(position.y) - 1));
  const cells = new Map();
  const set = (x, y, z, id) => cells.set(`${x},${y},${z}`, { x, y, z, id });
  if (endPortal) {
    for (let dx = 0; dx < 3; dx++)
      for (let dz = 0; dz < 3; dz++) {
        set(x + dx, y, z + dz, BLOCK.OBSIDIAN);
        set(x + dx, y + 1, z + dz, BLOCK.END_PORTAL);
        set(x + dx, y + 2, z + dz, BLOCK.AIR);
      }
  } else {
    for (let dx = 0; dx < 4; dx++)
      for (let dy = 0; dy < 5; dy++)
        set(x + dx, y + dy, z, dx === 0 || dx === 3 || dy === 0 || dy === 4
          ? BLOCK.OBSIDIAN : BLOCK.NETHER_PORTAL);
    for (let dx = -1; dx <= 2; dx++) {
      set(x + dx, y, z - 1, BLOCK.OBSIDIAN);
      set(x + dx, y + 1, z - 1, BLOCK.AIR);
      set(x + dx, y + 2, z - 1, BLOCK.AIR);
    }
  }
  const changes = [];
  for (const { x, y, z, id } of cells.values()) {
    const before = world.getCell(x, y, z), after = normalizeCell({ id });
    if (!before || (!liquidOrAir.has(before.id) && !cellsEqual(before, after)))
      return { ok: false, reason: "return-portal-obstructed" };
    if (!cellsEqual(before, after)) changes.push({ x, y, z, before, after });
  }
  if (!changes.length) return { ok: true, observerErrors: [] };
  const mutation = world.prepareMutation(changes);
  return mutation ? world.coordinator.commit([mutation])
    : { ok: false, reason: "return-portal-unavailable" };
}
