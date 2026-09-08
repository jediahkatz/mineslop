import { BIOMES } from "./biomes.js";
import { BLOCK_STATE, FLUID } from "./block-state.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import { opaqueCube } from "./mesh-palette.js";
import { CHUNK_SIZE } from "./terrain.js";

export const GAMEPLAY_LIGHT_LIMITS = Object.freeze({
  maxBlockLevel: 15,
  maxSkyColumns: 1,
  maxBlockCells: 24_000,
  latticeSide: 31,
  maxChunks: 9,
});

const chunkKey = (x, z) =>
  `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
const LATTICE_SIDE = GAMEPLAY_LIGHT_LIMITS.latticeSide;
const LATTICE_HALF = (LATTICE_SIDE - 1) / 2;
const LATTICE_PLANE = LATTICE_SIDE * LATTICE_SIDE;
const LATTICE_CELLS = LATTICE_SIDE ** 3;
const GAMEPLAY_EMISSION = new Uint8Array(65536);
GAMEPLAY_EMISSION[BLOCK.GLOWSTONE] = 15;
GAMEPLAY_EMISSION[BLOCK.SEA_LANTERN] = 15;
GAMEPLAY_EMISSION[BLOCK.LAVA] = 15;
GAMEPLAY_EMISSION[BLOCK.TORCH] = 14;
GAMEPLAY_EMISSION[BLOCK.GLOW_BERRIES] = 10;
GAMEPLAY_EMISSION[BLOCK.NETHER_PORTAL] = 11;
GAMEPLAY_EMISSION[BLOCK.END_PORTAL] = 15;
const GAMEPLAY_DEFAULT_FLUID = new Uint8Array(65536);
const GAMEPLAY_SLAB = new Uint8Array(65536);
for (let id = 0; id < BLOCKS.length; id++) {
  if (id === BLOCK.WATER || BLOCKS[id]?.aquatic === true)
    GAMEPLAY_DEFAULT_FLUID[id] = FLUID.WATER_SOURCE;
  else if (id === BLOCK.LAVA) GAMEPLAY_DEFAULT_FLUID[id] = FLUID.LAVA_SOURCE;
  if (BLOCKS[id]?.shape === "slab") GAMEPLAY_SLAB[id] = 1;
}

export function gameplayEmissionLevel(id) {
  return GAMEPLAY_EMISSION[id] ?? 0;
}

/** Fixed reusable query memory. Game owns one; standalone callers get an
 * isolated scratch. A reentrant query fails unknown rather than sharing state.
 */
export class GameplayLightScratch {
  constructor() {
    this.costs = new Uint8Array(LATTICE_CELLS);
    this.generations = new Uint16Array(LATTICE_CELLS);
    this.queue = new Uint16Array(LATTICE_CELLS);
    this.chunkX = new Int32Array(GAMEPLAY_LIGHT_LIMITS.maxChunks);
    this.chunkZ = new Int32Array(GAMEPLAY_LIGHT_LIMITS.maxChunks);
    this.incarnations = new Float64Array(GAMEPLAY_LIGHT_LIMITS.maxChunks);
    this.revisions = new Float64Array(GAMEPLAY_LIGHT_LIMITS.maxChunks);
    this.chunks = Array(GAMEPLAY_LIGHT_LIMITS.maxChunks).fill(null);
    this.generation = 0;
    this.busy = false;
  }

  begin() {
    if (this.busy) return false;
    this.busy = true;
    this.chunkCount = 0;
    this.generation++;
    if (this.generation > 65535) {
      this.generations.fill(0);
      this.generation = 1;
    }
    return true;
  }

  end() {
    for (let i = 0; i < this.chunks.length; i++) this.chunks[i] = null;
    this.chunkCount = 0;
    this.busy = false;
  }
}

export function readGameplayHabitat(world, position, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  if (options.light === true) return readGameplayHabitatLight(world, position, options);
  if (!world?.chunks || !position ||
    ![position.x, position.y, position.z].every(Number.isFinite)) return null;
  const x = Math.floor(position.x), z = Math.floor(position.z);
  const key = chunkKey(x, z), chunk = world.chunks.get(key);
  if (!chunk || !world.isLoaded?.(x, z)) return null;
  const identity = {
    epoch: world.epoch, dimension: world.dimension, generator: world.generator,
    incarnation: chunk.incarnation, revision: chunk.revision,
  };
  const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
  const index = (z - cz * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE;
  const biomeId = BIOMES[chunk.biomes?.[index]]?.id;
  return biomeId && world.epoch === identity.epoch &&
    world.dimension === identity.dimension && world.generator === identity.generator &&
    world.chunks.get(key) === chunk && chunk.incarnation === identity.incarnation &&
    chunk.revision === identity.revision
    ? Object.freeze({ biomeId })
    : null;
}

/**
 * Synchronous Minecraft-style gameplay light at one loaded cell.
 *
 * Sky light begins at 15 above the loaded column, loses one level per water
 * cell, and is fully stopped only by full opaque cubes. Partial resolved
 * shapes remain light-permeable instead of becoming fictitious full cubes.
 * Block light uses an explicit gameplay 0..15 emission table and attenuation
 * of one per ordinary transparent cell and two per water cell.
 *
 * Null means unknown, never darkness: an unloaded dependency, unsupported
 * world, over-budget read, mutation, chunk replacement, epoch, or dimension
 * change invalidates the complete observation.
 */
export function readGameplayHabitatLight(world, position, options = {}) {
  if (!world?.chunks || typeof world.getCell !== "function" ||
    !position || ![position.x, position.y, position.z].every(Number.isFinite) ||
    !options || typeof options !== "object" || Array.isArray(options))
    return null;
  const maxCells = options.maxCells ?? GAMEPLAY_LIGHT_LIMITS.maxBlockCells;
  const skipBlockAboveSky = options.skipBlockAboveSky;
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 ||
    maxCells > GAMEPLAY_LIGHT_LIMITS.maxBlockCells ||
    (skipBlockAboveSky !== undefined &&
      (!Number.isInteger(skipBlockAboveSky) || skipBlockAboveSky < 0 ||
        skipBlockAboveSky > GAMEPLAY_LIGHT_LIMITS.maxBlockLevel))) return null;
  const stats = options.stats && typeof options.stats === "object" ? options.stats : {};
  Object.assign(stats, { cellReads: 0, queuedCells: 0, maxQueue: 0 });
  const scratch = options.scratch ?? new GameplayLightScratch();
  if (!(scratch instanceof GameplayLightScratch) || !scratch.begin()) return null;
  try {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const spec = world.spec;
    if (!spec || y < spec.minY || y >= spec.maxY || !world.isLoaded?.(x, z))
      return null;
    const identity = {
      epoch: world.epoch,
      dimension: world.dimension,
      generator: world.generator,
      editRevision: world._editRevision,
    };
    const ownerX = Math.floor(x / CHUNK_SIZE), ownerZ = Math.floor(z / CHUNK_SIZE);
    let reads = 0, unknown = false;
    let cellId = 0, cellState = 0, cellFluid = 0;
    const chunkAt = (cx, cz) => {
      const offsetX = cx - ownerX + 1, offsetZ = cz - ownerZ + 1;
      if (offsetX < 0 || offsetX > 2 || offsetZ < 0 || offsetZ > 2) {
        unknown = true;
        return null;
      }
      const at = offsetZ * 3 + offsetX;
      if (scratch.chunks[at]) return scratch.chunks[at];
      const chunk = world.chunks.get(`${cx},${cz}`);
      if (!chunk?.blocks) {
        unknown = true;
        return null;
      }
      scratch.chunkCount++;
      scratch.chunkX[at] = cx;
      scratch.chunkZ[at] = cz;
      scratch.incarnations[at] = chunk.incarnation;
      scratch.revisions[at] = chunk.revision;
      scratch.chunks[at] = chunk;
      return chunk;
    };
    const read = (atX, atY, atZ) => {
      if (++reads > maxCells) {
        unknown = true;
        stats.cellReads = reads;
        return false;
      }
      stats.cellReads = reads;
      if (atY < spec.minY || atY >= spec.maxY) return false;
      const cx = Math.floor(atX / CHUNK_SIZE), cz = Math.floor(atZ / CHUNK_SIZE);
      const chunk = chunkAt(cx, cz);
      if (!chunk) return false;
      const localX = atX - cx * CHUNK_SIZE, localZ = atZ - cz * CHUNK_SIZE;
      const at = (atY - spec.minY) * CHUNK_SIZE * CHUNK_SIZE +
        localZ * CHUNK_SIZE + localX;
      cellId = chunk.blocks[at];
      const sy = Math.floor(atY / CHUNK_SIZE);
      const section = chunk.sections?.get(sy);
      const local = (atY - sy * CHUNK_SIZE) * CHUNK_SIZE * CHUNK_SIZE +
        localZ * CHUNK_SIZE + localX;
      cellState = section?.states?.[local] ?? 0;
      cellFluid = section?.fluids?.[local] ?? GAMEPLAY_DEFAULT_FLUID[cellId];
      return true;
    };
    const blocked = () => opaqueCube[cellId] === 1 ||
      (GAMEPLAY_SLAB[cellId] === 1 && !!(cellState & BLOCK_STATE.DOUBLE));

    const owner = chunkAt(ownerX, ownerZ);
    const biomeIndex = (z - Math.floor(z / CHUNK_SIZE) * CHUNK_SIZE) * CHUNK_SIZE +
      x - Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE;
    const biomeId = BIOMES[owner?.biomes?.[biomeIndex]]?.id;
    if (!biomeId) return null;

    let skyLight = GAMEPLAY_LIGHT_LIMITS.maxBlockLevel;
    for (let atY = spec.maxY - 1; atY >= y && skyLight > 0; atY--) {
      if (!read(x, atY, z)) break;
      if (blocked()) { skyLight = 0; break; }
      if (cellFluid >= FLUID.WATER_SOURCE && cellFluid <= FLUID.BUBBLE_DOWN) skyLight--;
    }

    let blockLight = 0;
    const skipBlock = skipBlockAboveSky !== undefined && skyLight > skipBlockAboveSky;
    stats.queuedCells = stats.maxQueue = Number(!skipBlock);
    let head = 0, tail = 0;
    const center =
      LATTICE_HALF * LATTICE_PLANE + LATTICE_HALF * LATTICE_SIDE + LATTICE_HALF;
    if (!skipBlock) {
      scratch.queue[tail++] = center;
      scratch.generations[center] = scratch.generation;
      scratch.costs[center] = 0;
    }
    while (!skipBlock && head < tail && !unknown) {
      const index = scratch.queue[head++];
      const dy = Math.floor(index / LATTICE_PLANE) - LATTICE_HALF;
      const remainder = index % LATTICE_PLANE;
      const dz = Math.floor(remainder / LATTICE_SIDE) - LATTICE_HALF;
      const dx = remainder % LATTICE_SIDE - LATTICE_HALF;
      const cost = scratch.costs[index];
      if (!read(x + dx, y + dy, z + dz)) break;
      const sourceId = cellFluid === FLUID.LAVA_SOURCE ? BLOCK.LAVA : cellId;
      const level = GAMEPLAY_EMISSION[sourceId];
      if (level > cost) blockLight = Math.max(blockLight, level - cost);
      if (cost >= GAMEPLAY_LIGHT_LIMITS.maxBlockLevel || blocked()) continue;
      const nextCost = cost +
        (cellFluid >= FLUID.WATER_SOURCE && cellFluid <= FLUID.BUBBLE_DOWN ? 2 : 1);
      if (nextCost >= GAMEPLAY_LIGHT_LIMITS.maxBlockLevel) continue;
      for (let i = 0; i < 6; i++) {
        let next = -1;
        if (i === 0 && dx < LATTICE_HALF) next = index + 1;
        else if (i === 1 && dx > -LATTICE_HALF) next = index - 1;
        else if (i === 2 && dz < LATTICE_HALF) next = index + LATTICE_SIDE;
        else if (i === 3 && dz > -LATTICE_HALF) next = index - LATTICE_SIDE;
        else if (i === 4 && dy < LATTICE_HALF && y + dy + 1 < spec.maxY)
          next = index + LATTICE_PLANE;
        else if (i === 5 && dy > -LATTICE_HALF && y + dy - 1 >= spec.minY)
          next = index - LATTICE_PLANE;
        if (next < 0 || (scratch.generations[next] === scratch.generation &&
          scratch.costs[next] <= nextCost)) continue;
        if (tail >= maxCells) { unknown = true; break; }
        scratch.generations[next] = scratch.generation;
        scratch.costs[next] = nextCost;
        scratch.queue[tail++] = next;
        stats.queuedCells++;
        stats.maxQueue = Math.max(stats.maxQueue, tail - head);
      }
    }

    let current = !unknown &&
      world.epoch === identity.epoch && world.dimension === identity.dimension &&
      world.generator === identity.generator && world._editRevision === identity.editRevision;
    for (let i = 0; current && i < scratch.chunks.length; i++) {
      const chunk = scratch.chunks[i];
      if (!chunk) continue;
      current = world.chunks.get(`${scratch.chunkX[i]},${scratch.chunkZ[i]}`) === chunk &&
        chunk?.incarnation === scratch.incarnations[i] &&
        chunk?.revision === scratch.revisions[i];
    }
    return current ? Object.freeze({
      biomeId, ...(skipBlock ? {} : { blockLight }), skyLight,
    }) : null;
  } finally {
    scratch.end();
  }
}
