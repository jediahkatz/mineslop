import * as THREE from "three";
import { BIOMES } from "./biomes.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import { geometryWorldSpec } from "./geometry-world.js";
import {
  blockBatch as categories,
  getBiomeTint,
  leafBlock as leaves,
  opaqueBlock as opaque,
} from "./mesh-palette.js";
import { buildResolvedColumnGeometry } from "./resolved-mesh.js";
import { CHUNK_SIZE, WORLD_HEIGHT } from "./terrain.js";

export { getBiomeTint } from "./mesh-palette.js";

const PADDED_SIZE = CHUNK_SIZE + 2;
const PADDED_LAYER = PADDED_SIZE * PADDED_SIZE;
const LAYER = CHUNK_SIZE * CHUNK_SIZE;
const FACES = [
  {
    n: [1, 0, 0],
    o: [1, 0, 1],
    u: [0, 0, -1],
    v: [0, 1, 0],
    shade: 0.86,
    tile: "side",
  },
  {
    n: [-1, 0, 0],
    o: [0, 0, 0],
    u: [0, 0, 1],
    v: [0, 1, 0],
    shade: 0.77,
    tile: "side",
  },
  {
    n: [0, 1, 0],
    o: [0, 1, 1],
    u: [1, 0, 0],
    v: [0, 0, -1],
    shade: 1,
    tile: "top",
  },
  {
    n: [0, -1, 0],
    o: [0, 0, 0],
    u: [1, 0, 0],
    v: [0, 0, 1],
    shade: 0.58,
    tile: "bottom",
  },
  {
    n: [0, 0, 1],
    o: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    shade: 0.9,
    tile: "side",
  },
  {
    n: [0, 0, -1],
    o: [1, 0, 0],
    u: [-1, 0, 0],
    v: [0, 1, 0],
    shade: 0.73,
    tile: "side",
  },
].map((face) => ({
  ...face,
  normalOffset: face.n[0] + face.n[1] * PADDED_LAYER + face.n[2] * PADDED_SIZE,
  uOffset: face.u[0] + face.u[1] * PADDED_LAYER + face.u[2] * PADDED_SIZE,
  vOffset: face.v[0] + face.v[1] * PADDED_LAYER + face.v[2] * PADDED_SIZE,
}));
const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
const AO = [1, 0.83, 0.67, 0.52];
const makeData = () => ({
  positions: [],
  normals: [],
  uvs: [],
  colors: [],
  indices: [],
  emitters: [],
});
const emptyBatches = () => ({
  opaque: null,
  foliage: null,
  berryFoliage: null,
  water: null,
  glass: null,
  emissive: null,
});

function makeGeometry(data) {
  if (!data.positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(data.positions, 3)
  );
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(data.normals, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(data.uvs, 2));
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(data.colors, 3)
  );
  geometry.setIndex(data.indices);
  geometry.userData.emitters = data.emitters;
  geometry.computeBoundingSphere();
  return geometry;
}

// A one-voxel apron includes diagonal AO samples. Real streaming chunks are read
// directly, avoiding hundreds of thousands of map/string lookups per mesh.
function snapshot(world, cx, cz) {
  const result = new Uint16Array(PADDED_LAYER * (WORLD_HEIGHT + 2));
  const neighbors = new Map();
  if (world.chunks) {
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        neighbors.set(
          `${dx},${dz}`,
          world.chunks.get(`${cx + dx},${cz + dz}`)?.blocks
        );
      }
  }
  for (let z = -1; z <= CHUNK_SIZE; z++)
    for (let x = -1; x <= CHUNK_SIZE; x++) {
      const column = (z + 1) * PADDED_SIZE + x + 1;
      if (world.chunks) {
        const dx = Math.floor(x / CHUNK_SIZE),
          dz = Math.floor(z / CHUNK_SIZE);
        const source = neighbors.get(`${dx},${dz}`);
        if (!source) continue;
        const local = (z - dz * CHUNK_SIZE) * CHUNK_SIZE + x - dx * CHUNK_SIZE;
        for (let y = 0; y < WORLD_HEIGHT; y++)
          result[(y + 1) * PADDED_LAYER + column] = source[y * LAYER + local];
      } else {
        for (let y = 0; y < WORLD_HEIGHT; y++)
          result[(y + 1) * PADDED_LAYER + column] = world.get(
            cx * CHUNK_SIZE + x,
            y,
            cz * CHUNK_SIZE + z
          );
      }
    }
  return result;
}

function addPlant(data, x, y, z, id, atlas, tint) {
  const [u0, v0, u1, v1] = atlas.uvFor(id);
  const flat = id === BLOCK.LILY_PAD;
  const height =
    id === BLOCK.DEAD_BUSH ? 0.72 : id === BLOCK.PINK_PETALS ? 0.35 : 1;
  for (let plane = 0; plane < (flat ? 1 : 2); plane++) {
    const base = data.positions.length / 3;
    const points = flat
      ? [
          [0.02, 0.06, 0.02],
          [0.02, 0.06, 0.98],
          [0.98, 0.06, 0.98],
          [0.98, 0.06, 0.02],
        ]
      : plane === 0
        ? [
            [0.08, 0, 0.08],
            [0.92, 0, 0.92],
            [0.92, height, 0.92],
            [0.08, height, 0.08],
          ]
        : [
            [0.92, 0, 0.08],
            [0.08, 0, 0.92],
            [0.08, height, 0.92],
            [0.92, height, 0.08],
          ];
    for (const point of points) {
      data.positions.push(x + point[0], y + point[1], z + point[2]);
      data.normals.push(
        ...(flat
          ? [0, 1, 0]
          : [-Math.SQRT1_2, 0, plane === 0 ? Math.SQRT1_2 : -Math.SQRT1_2])
      );
      data.colors.push(...tint);
    }
    data.uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    data.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function hasAuxiliaryPlanes(world, cx, cz) {
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      for (const section of world.chunks
        .get(`${cx + dx},${cz + dz}`)
        ?.sections?.values() ?? [])
        if (section.states || section.fluids) return true;
  return false;
}

// Geometry stays chunk-local, preserving sub-block precision at distant world
// coordinates. The renderer places its group at (cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE).
export function buildChunkGeometry(world, cx, cz, atlas) {
  const key = `${cx},${cz}`;
  if (world.chunks && !world.chunks.has(key)) return emptyBatches();
  const spec = geometryWorldSpec(world);
  if (
    spec.minY !== 0 ||
    spec.maxY !== WORLD_HEIGHT ||
    (world.chunks
      ? hasAuxiliaryPlanes(world, cx, cz)
      : world.getCell || world.getBlockState || world.getFluid)
  )
    return buildResolvedColumnGeometry(world, cx, cz, atlas);
  const batches = Object.fromEntries(
    Object.keys(emptyBatches()).map((name) => [name, makeData()])
  );
  const emitters = [];
  const voxels = snapshot(world, cx, cz);
  if (
    voxels.some(
      (id) =>
        id &&
        BLOCKS[id] &&
        (!["cube", "cross"].includes(BLOCKS[id].shape) || BLOCKS[id].aquatic)
    )
  )
    return buildResolvedColumnGeometry(world, cx, cz, atlas);
  const biomeIndices = world.chunks?.get(key)?.biomes;
  const tintCache = new Map();
  const tintFor = (id, face, biome) => {
    let colors = tintCache.get(biome);
    if (!colors) {
      colors = new Map();
      tintCache.set(biome, colors);
    }
    const key = `${id}:${face}`;
    if (!colors.has(key)) colors.set(key, getBiomeTint(id, face, biome));
    return colors.get(key);
  };
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      let biome;
      let biomeRead = false;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const at = (y + 1) * PADDED_LAYER + (z + 1) * PADDED_SIZE + x + 1;
        const id = voxels[at];
        if (!id || !BLOCKS[id]) continue;
        if (!biomeRead) {
          biome = biomeIndices
            ? BIOMES[biomeIndices[z * CHUNK_SIZE + x]]
            : world.getBiome?.(cx * CHUNK_SIZE + x, cz * CHUNK_SIZE + z);
          biomeRead = true;
        }
        const block = BLOCKS[id];
        const batch = categories[id];
        const data = batches[batch];
        if (
          block.emissive &&
          (id === BLOCK.TORCH ||
            id === BLOCK.GLOW_BERRIES ||
            (x % 8 === 0 && z % 8 === 0 && voxels[at + PADDED_LAYER] !== id))
        ) {
          const emitter = {
            x: cx * CHUNK_SIZE + x + 0.5,
            y: y + (id === BLOCK.GLOW_BERRIES ? 0.3 : 0.7),
            z: cz * CHUNK_SIZE + z + 0.5,
            id,
          };
          if (emitters.length < 12) emitters.push(emitter);
          else if (id === BLOCK.TORCH) {
            const ambient = emitters.findIndex(
              (source) => source.id !== BLOCK.TORCH
            );
            if (ambient !== -1) emitters[ambient] = emitter;
          }
        }
        if (block.shape === "cross" || id === BLOCK.LILY_PAD) {
          addPlant(data, x, y, z, id, atlas, tintFor(id, "side", biome));
          continue;
        }
        const liquid = id === BLOCK.WATER || id === BLOCK.LAVA;
        const loweredLiquid = liquid && voxels[at + PADDED_LAYER] !== id;
        let waterBiome;
        for (const face of FACES) {
          const { n, o, u, v, normalOffset, uOffset, vOffset } = face;
          const neighbor = voxels[at + normalOffset];
          if (opaque[neighbor]) continue;
          if (
            neighbor === id &&
            (block.transparent || liquid || batch === "glass")
          )
            continue;
          if (leaves[id] && leaves[neighbor]) continue;
          const [u0, v0, u1, v1] = atlas.uvFor(id, face.tile);
          if (id === BLOCK.WATER && waterBiome === undefined) {
            waterBiome =
              world.getBiome?.(cx * CHUNK_SIZE + x, cz * CHUNK_SIZE + z, y) ??
              biome;
          }
          const tint = tintFor(id, face.tile, waterBiome ?? biome);
          const base = data.positions.length / 3;
          const ao = [];
          for (const [a, b] of CORNERS) {
            const px = o[0] + u[0] * a + v[0] * b;
            let py = o[1] + u[1] * a + v[1] * b;
            const pz = o[2] + u[2] * a + v[2] * b;
            if (loweredLiquid && py === 1) py = 0.88;
            data.positions.push(x + px, y + py, z + pz);
            data.normals.push(...n);
            let occlusion = 0;
            if (!liquid && batch !== "glass" && !block.emissive) {
              const sideA = Number(
                opaque[voxels[at + normalOffset + uOffset * (a ? 1 : -1)]]
              );
              const sideB = Number(
                opaque[voxels[at + normalOffset + vOffset * (b ? 1 : -1)]]
              );
              const corner = Number(
                opaque[
                  voxels[
                    at +
                      normalOffset +
                      uOffset * (a ? 1 : -1) +
                      vOffset * (b ? 1 : -1)
                  ]
                ]
              );
              occlusion = sideA && sideB ? 3 : sideA + sideB + corner;
            }
            const shade = block.emissive
              ? 0.86 + face.shade * 0.14
              : face.shade * AO[occlusion];
            ao.push(shade);
            data.colors.push(tint[0] * shade, tint[1] * shade, tint[2] * shade);
          }
          data.uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
          if (ao[0] + ao[2] > ao[1] + ao[3]) {
            data.indices.push(
              base,
              base + 1,
              base + 3,
              base + 1,
              base + 2,
              base + 3
            );
          } else {
            data.indices.push(
              base,
              base + 1,
              base + 2,
              base,
              base + 2,
              base + 3
            );
          }
        }
      }
    }
  }
  // One shared source budget, even when only the masked berry batch is drawn.
  for (const emitter of emitters)
    batches[categories[emitter.id]].emitters.push(emitter);
  return Object.fromEntries(
    Object.entries(batches).map(([name, data]) => [name, makeGeometry(data)])
  );
}
