import { BIOMES } from "./biomes.js";
import { defaultFluidFor, isValidCell } from "./block-state.js";
import { CHUNK_SIZE } from "./terrain.js";
import { cloneTerrainStructures } from "./terrain-v4-transport.js";
import { getWorldSpec, inColumnBounds } from "./world-spec.js";

export const CHUNK_SCHEMA_VERSION = 2;
export const COLUMN_LAYER = CHUNK_SIZE * CHUNK_SIZE;
export const SECTION_VOLUME = COLUMN_LAYER * CHUNK_SIZE;
export const chunkKey = (cx, cz) => `${cx},${cz}`;
export const sectionKey = (cx, cz, sy) => `${cx},${cz},${sy}`;

export function cellIndex(x, y, z, spec) {
  return (
    (y - spec.minY) * COLUMN_LAYER +
    (z - Math.floor(z / CHUNK_SIZE) * CHUNK_SIZE) * CHUNK_SIZE +
    x -
    Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE
  );
}

export function validateChunkJob(job) {
  if (
    !job ||
    !Number.isSafeInteger(job.id) ||
    job.id < 0 ||
    !Number.isSafeInteger(job.epoch) ||
    job.epoch < 0 ||
    typeof job.seed !== "string" ||
    job.seed.length > 80 ||
    !Number.isSafeInteger(job.cx) ||
    !Number.isSafeInteger(job.cz) ||
    !inColumnBounds(job.cx * CHUNK_SIZE, job.cz * CHUNK_SIZE) ||
    (job.schemaVersion !== undefined &&
      job.schemaVersion !== CHUNK_SCHEMA_VERSION)
  )
    throw new RangeError("Invalid terrain job identity");
  const spec = getWorldSpec(job.generatorVersion, job.dimension);
  if (
    (job.minY !== undefined && job.minY !== spec.minY) ||
    (job.maxY !== undefined && job.maxY !== spec.maxY)
  )
    throw new RangeError("Invalid terrain job specification");
  return spec;
}

const typedPlane = (value, Type, length) =>
  value instanceof Type &&
  value.length === length &&
  value.buffer instanceof ArrayBuffer;

function generatorPacket(chunk, job) {
  const spec = validateChunkJob(job);
  if (!chunk || typeof chunk !== "object")
    throw new RangeError("Invalid generated chunk");
  // Native v4 and explicit fixtures must declare their vertical layout; never
  // reinterpret historical bytes as expanded terrain.
  if (
    job.generatorVersion === 4 &&
    (chunk.minY === undefined || chunk.maxY === undefined)
  )
    throw new RangeError("Generated chunks must declare their world spec");
  return {
    type: "chunk",
    schemaVersion: CHUNK_SCHEMA_VERSION,
    id: job.id,
    epoch: job.epoch,
    seed: job.seed,
    dimension: job.dimension,
    generatorVersion: job.generatorVersion,
    minY: spec.minY,
    maxY: spec.maxY,
    encoding: chunk.blocks instanceof Uint16Array ? "u16" : "u8",
    ...chunk,
  };
}

function readPayload(packet, job) {
  const spec = validateChunkJob(job);
  const legacy = packet?.schemaVersion === undefined;
  if (
    !packet ||
    packet.type !== "chunk" ||
    packet.id !== job.id ||
    packet.epoch !== job.epoch ||
    packet.dimension !== job.dimension ||
    packet.cx !== job.cx ||
    packet.cz !== job.cz
  )
    throw new RangeError("Terrain reply does not match the requested job");
  if (legacy) {
    if (
      job.generatorVersion > 3 ||
      packet.minY !== undefined ||
      packet.maxY !== undefined ||
      packet.encoding !== undefined ||
      packet.sections !== undefined ||
      packet.structures !== undefined ||
      (packet.seed !== undefined && packet.seed !== job.seed) ||
      (packet.generatorVersion !== undefined &&
        packet.generatorVersion !== job.generatorVersion)
    )
      throw new RangeError("Invalid historical terrain reply");
  } else if (
    packet.schemaVersion !== CHUNK_SCHEMA_VERSION ||
    packet.seed !== job.seed ||
    packet.generatorVersion !== job.generatorVersion ||
    packet.minY !== spec.minY ||
    packet.maxY !== spec.maxY ||
    !["u8", "u16"].includes(packet.encoding)
  )
    throw new RangeError("Invalid terrain reply schema or specification");
  if (packet.states !== undefined || packet.fluids !== undefined)
    throw new RangeError("Terrain state and fluid planes require sections");
  const encoding = legacy ? "u8" : packet.encoding;
  const Type = encoding === "u8" ? Uint8Array : Uint16Array;
  if (
    !typedPlane(packet.blocks, Type, (spec.maxY - spec.minY) * COLUMN_LAYER) ||
    !typedPlane(packet.biomes, Uint8Array, COLUMN_LAYER) ||
    (packet.sections !== undefined && !Array.isArray(packet.sections))
  )
    throw new RangeError("Invalid terrain buffer encoding or length");
  if (packet.biomes.some((index) => BIOMES[index] === undefined))
    throw new RangeError("Invalid terrain biome index");
  const sections = new Map();
  const minSection = Math.floor(spec.minY / CHUNK_SIZE);
  const maxSection = Math.floor((spec.maxY - 1) / CHUNK_SIZE);
  if ((packet.sections?.length ?? 0) > maxSection - minSection + 1)
    throw new RangeError("Too many terrain sections");
  for (const section of packet.sections ?? []) {
    if (
      !section ||
      !Number.isInteger(section.sy) ||
      section.sy < minSection ||
      section.sy > maxSection ||
      sections.has(section.sy) ||
      (section.states !== undefined &&
        !typedPlane(section.states, Uint16Array, SECTION_VOLUME)) ||
      (section.fluids !== undefined &&
        !typedPlane(section.fluids, Uint8Array, SECTION_VOLUME))
    )
      throw new RangeError("Invalid or duplicate terrain section");
    sections.set(section.sy, section);
  }
  const checkedDefaults = new Set();
  for (let sy = minSection; sy <= maxSection; sy++) {
    const section = sections.get(sy);
    const start = (sy * CHUNK_SIZE - spec.minY) * COLUMN_LAYER;
    for (let local = 0; local < SECTION_VOLUME; local++) {
      const id = packet.blocks[start + local];
      if (!section?.states && !section?.fluids) {
        if (checkedDefaults.has(id)) continue;
        if (!isValidCell({ id }))
          throw new RangeError(
            `Invalid terrain cell at index ${start + local}`
          );
        checkedDefaults.add(id);
      } else if (
        !isValidCell({
          id,
          state: section.states?.[local] ?? 0,
          fluid: section.fluids?.[local] ?? defaultFluidFor(id),
        })
      )
        throw new RangeError(`Invalid terrain cell at index ${start + local}`);
    }
  }
  const structures = cloneTerrainStructures(
    packet.structures,
    job,
    spec,
    packet.blocks
  );
  return {
    type: "chunk",
    schemaVersion: CHUNK_SCHEMA_VERSION,
    id: job.id,
    epoch: job.epoch,
    seed: job.seed,
    dimension: job.dimension,
    generatorVersion: job.generatorVersion,
    cx: job.cx,
    cz: job.cz,
    minY: spec.minY,
    maxY: spec.maxY,
    encoding,
    blocks: new Type(packet.blocks),
    biomes: new Uint8Array(packet.biomes),
    ...(packet.sections === undefined
      ? {}
      : {
          sections: [...sections.values()].map(({ sy, states, fluids }) => ({
            sy,
            ...(states === undefined
              ? {}
              : { states: new Uint16Array(states) }),
            ...(fluids === undefined ? {} : { fluids: new Uint8Array(fluids) }),
          })),
        }),
    ...(structures === undefined ? {} : { structures }),
  };
}

/** Worker output retains historical Uint8 bytes and all supplied auxiliary data. */
export function createChunkPacket(chunk, job) {
  return readPayload(generatorPacket(chunk, job), job);
}

/** All admissions, including synchronous generation, use this exact normalizer. */
export function normalizeChunkPacket(packet, job) {
  const clean = readPayload(packet, job);
  return {
    cx: clean.cx,
    cz: clean.cz,
    minY: clean.minY,
    maxY: clean.maxY,
    blocks:
      clean.blocks instanceof Uint16Array
        ? clean.blocks
        : new Uint16Array(clean.blocks),
    biomes: clean.biomes,
    sections: new Map(
      (clean.sections ?? []).map((section) => [section.sy, section])
    ),
    ...(clean.structures === undefined ? {} : { structures: clean.structures }),
  };
}

export function normalizeGeneratedChunk(chunk, job) {
  return normalizeChunkPacket(generatorPacket(chunk, job), job);
}

/** Deduplicate shared views; structures may also contain cloneable typed data. */
export function chunkTransferList(packet) {
  const buffers = new Set();
  const visited = new Set();
  const visit = (value) => {
    if (value === null || typeof value !== "object" || visited.has(value))
      return;
    visited.add(value);
    if (value instanceof ArrayBuffer) buffers.add(value);
    else if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    } else if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key);
        visit(entry);
      }
    } else if (value instanceof Set) {
      for (const entry of value) visit(entry);
    } else {
      for (const entry of Object.values(value)) visit(entry);
    }
  };
  visit(packet);
  return [...buffers];
}

export function readChunkCell(chunk, at) {
  const y = chunk.minY + Math.floor(at / COLUMN_LAYER);
  const sy = Math.floor(y / CHUNK_SIZE);
  const local = (y - sy * CHUNK_SIZE) * COLUMN_LAYER + (at % COLUMN_LAYER);
  const section = chunk.sections.get(sy);
  const id = chunk.blocks[at];
  return {
    id,
    state: section?.states?.[local] ?? 0,
    fluid: section?.fluids?.[local] ?? defaultFluidFor(id),
  };
}

/**
 * Allocate/copy only touched auxiliary sections before publication. Initializing
 * a fluid plane must synthesize every old source, not just the changed cell.
 * The caller supplies already-validated detached cells and unique indices.
 */
export function prepareChunkWrites(chunk, writes) {
  const grouped = new Map();
  for (const write of writes) {
    const y = chunk.minY + Math.floor(write.at / COLUMN_LAYER);
    const sy = Math.floor(y / CHUNK_SIZE);
    if (!grouped.has(sy)) grouped.set(sy, []);
    grouped.get(sy).push(write);
  }
  const sections = new Map();
  for (const [sy, changes] of grouped) {
    const start = (sy * CHUNK_SIZE - chunk.minY) * COLUMN_LAYER;
    const previous = chunk.sections.get(sy);
    let states = previous?.states?.slice();
    let fluids = previous?.fluids?.slice();
    if (!states && changes.some(({ cell }) => cell.state !== 0))
      states = new Uint16Array(SECTION_VOLUME);
    if (
      !fluids &&
      changes.some(({ cell }) => cell.fluid !== defaultFluidFor(cell.id))
    ) {
      fluids = new Uint8Array(SECTION_VOLUME);
      for (let local = 0; local < SECTION_VOLUME; local++)
        fluids[local] = defaultFluidFor(chunk.blocks[start + local]);
    }
    const ids = new Map();
    for (const { at, cell } of changes) {
      const local = at - start;
      ids.set(local, cell.id);
      if (states) states[local] = cell.state;
      if (fluids) fluids[local] = cell.fluid;
    }
    if (states && !states.some((state) => state !== 0)) states = undefined;
    if (
      fluids &&
      fluids.every(
        (fluid, local) =>
          fluid ===
          defaultFluidFor(ids.get(local) ?? chunk.blocks[start + local])
      )
    )
      fluids = undefined;
    sections.set(
      sy,
      states || fluids
        ? {
            sy,
            ...(states ? { states } : {}),
            ...(fluids ? { fluids } : {}),
          }
        : null
    );
  }
  return { writes, sections };
}

/** Installation only: no validation, allocation, observers or generation. */
export function publishChunkWrites(chunk, prepared) {
  for (const { at, cell } of prepared.writes) chunk.blocks[at] = cell.id;
  for (const [sy, section] of prepared.sections) {
    if (section) chunk.sections.set(sy, section);
    else chunk.sections.delete(sy);
  }
}

/** Detached terrain plus auxiliary planes, excluding streaming/mesh identities. */
export function cloneChunkData(chunk) {
  return {
    cx: chunk.cx,
    cz: chunk.cz,
    minY: chunk.minY,
    maxY: chunk.maxY,
    blocks: chunk.blocks.slice(),
    biomes: chunk.biomes.slice(),
    sections: new Map(
      [...chunk.sections].map(([sy, section]) => [
        sy,
        {
          sy,
          ...(section.states ? { states: section.states.slice() } : {}),
          ...(section.fluids ? { fluids: section.fluids.slice() } : {}),
        },
      ])
    ),
    ...(chunk.structures === undefined
      ? {}
      : { structures: structuredClone(chunk.structures) }),
  };
}
