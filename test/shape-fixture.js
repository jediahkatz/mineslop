import * as THREE from "three";
import { normalizeCell, defaultFluidFor } from "../src/block-state.js";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { readChunkCell } from "../src/chunk-data.js";
import { createChunkMaterials, GameRenderer } from "../src/renderer.js";
import { getWorldSpec } from "../src/world-spec.js";

export const shapeAtlas = {
  texture: new THREE.Texture(),
  emissiveTexture: new THREE.Texture(),
  uvFor: () => [0, 0, 1, 1],
};
const key = (x, y, z) => `${x},${y},${z}`;
export const cell = (id, state = 0, fluid = defaultFluidFor(id)) =>
  normalizeCell({ id, state, fluid });

// Authored geometry fixtures, not a v4 generator or a production preview.
export function shapeWorld(
  entries = [],
  { generatorVersion = 4, dimension = "overworld", loaded = () => true } = {}
) {
  const cells = new Map(
    entries.map(([x, y, z, id, state = 0, fluid]) => [
      key(x, y, z),
      cell(id, state, fluid),
    ])
  );
  const spec = getWorldSpec(generatorVersion, dimension);
  return {
    generatorVersion,
    dimension,
    spec,
    cells,
    epoch: 1,
    isLoaded: loaded,
    getCell(x, y, z) {
      if (y < spec.minY || y >= spec.maxY || !loaded(x, z)) return null;
      return { ...(cells.get(key(x, y, z)) ?? cell(BLOCK.AIR)) };
    },
    get(x, y, z) {
      return this.getCell(x, y, z)?.id ?? BLOCK.AIR;
    },
    getBlockState(x, y, z) {
      return this.getCell(x, y, z)?.state ?? 0;
    },
    getFluid(x, y, z) {
      return this.getCell(x, y, z)?.fluid ?? 0;
    },
    isSolid(x, y, z) {
      return !!BLOCKS[this.get(x, y, z)]?.solid;
    },
    put(x, y, z, id, state = 0, fluid) {
      cells.set(key(x, y, z), cell(id, state, fluid));
    },
    surfaceYAt(x, z) {
      for (let y = spec.maxY - 1; y >= spec.minY; y--)
        if (BLOCKS[cells.get(key(x, y, z))?.id]?.solid) return y;
      return null;
    },
  };
}

export function authoredColumns(columns = [[0, 0]], entries = []) {
  const world = {
    generatorVersion: 4,
    dimension: "overworld",
    epoch: 1,
    spec: getWorldSpec(4, "overworld"),
    chunks: new Map(),
    dirtyChunks: new Set(),
    removedChunks: new Set(),
    dirtySectionRevisions: new Map(),
    acknowledgments: [],
  };
  let nextIncarnation = 0,
    nextTicket = 0;
  world.admit = (cx, cz) => {
    const chunk = {
      cx,
      cz,
      minY: world.spec.minY,
      maxY: world.spec.maxY,
      incarnation: ++nextIncarnation,
      revision: 1,
      blocks: new Uint16Array((world.spec.maxY - world.spec.minY) * 256),
      biomes: new Uint8Array(256),
      sections: new Map(),
      sectionRevisions: new Map(),
    };
    world.chunks.set(`${cx},${cz}`, chunk);
    world.dirtyChunks.add(`${cx},${cz}`);
    for (let sy = Math.floor(chunk.minY / 16); sy < chunk.maxY / 16; sy++) {
      chunk.sectionRevisions.set(sy, 1);
      world.dirtySectionRevisions.set(`${cx},${cz},${sy}`, ++nextTicket);
    }
    return chunk;
  };
  const chunkAt = (x, z) =>
    world.chunks.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
  const at = (x, y, z) =>
    (y - world.spec.minY) * 256 +
    (((z % 16) + 16) % 16) * 16 +
    (((x % 16) + 16) % 16);
  world.isLoaded = (x, z) => !!chunkAt(x, z);
  world.getCell = (x, y, z) => {
    const chunk = chunkAt(x, z);
    return !chunk || y < world.spec.minY || y >= world.spec.maxY
      ? null
      : readChunkCell(chunk, at(x, y, z));
  };
  world.get = (x, y, z) => world.getCell(x, y, z)?.id ?? 0;
  world.getBlockState = (x, y, z) => world.getCell(x, y, z)?.state ?? 0;
  world.getFluid = (x, y, z) => world.getCell(x, y, z)?.fluid ?? 0;
  world.dirty = (cx, cz, sy) => {
    const ticket = ++nextTicket;
    world.dirtySectionRevisions.set(`${cx},${cz},${sy}`, ticket);
    world.dirtyChunks.add(`${cx},${cz}`);
    return ticket;
  };
  world.put = (x, y, z, id, state = 0, fluid) => {
    const value = cell(id, state, fluid);
    const chunk = chunkAt(x, z);
    const index = at(x, y, z);
    const sy = Math.floor(y / 16);
    const local = (y - sy * 16) * 256 + (index % 256);
    let section = chunk.sections.get(sy);
    if (!section) {
      section = {
        sy,
        states: new Uint16Array(4096),
        fluids: new Uint8Array(4096),
      };
      const start = (sy * 16 - chunk.minY) * 256;
      for (let i = 0; i < 4096; i++)
        section.fluids[i] = defaultFluidFor(chunk.blocks[start + i]);
      chunk.sections.set(sy, section);
    }
    chunk.blocks[index] = id;
    section.states[local] = value.state;
    section.fluids[local] = value.fluid;
    chunk.revision++;
    chunk.sectionRevisions.set(sy, (chunk.sectionRevisions.get(sy) ?? 0) + 1);
    world.dirty(chunk.cx, chunk.cz, sy);
  };
  world.acknowledgeSectionMesh = (cx, cz, sy, ticket) => {
    const key = `${cx},${cz},${sy}`;
    if (world.dirtySectionRevisions.get(key) !== ticket) return false;
    world.dirtySectionRevisions.delete(key);
    world.acknowledgments.push({ cx, cz, sy, ticket });
    return true;
  };
  for (const [cx, cz] of columns) world.admit(cx, cz);
  for (const entry of entries) world.put(...entry);
  return world;
}

export function shapeRenderer(world) {
  const renderer = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    world,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    atlas: shapeAtlas,
    chunks: new Map(),
    quality: "low",
    viewCenter: null,
    dimension: world.dimension,
    chunkEpoch: world.epoch,
    chunkGenerator: world.generator,
    materials: createChunkMaterials(shapeAtlas),
  });
  return renderer;
}

export function disposeShapeRenderer(renderer) {
  for (const key of renderer.chunks.keys()) renderer.removeChunk(key);
  for (const job of renderer.sectionJobs?.values() ?? []) job.dispose();
  for (const material of Object.values(renderer.materials)) material.dispose();
}
