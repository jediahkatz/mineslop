import * as THREE from "three";
import { BLOCK } from "./blocks.js";
import { MESH_BATCHES, blockBatch, selectEmitters } from "./mesh-palette.js";

export const FACES = Object.freeze(
  [
    {
      name: "east",
      n: [1, 0, 0],
      o: [1, 0, 1],
      u: [0, 0, -1],
      v: [0, 1, 0],
      shade: 0.86,
      tile: "side",
    },
    {
      name: "west",
      n: [-1, 0, 0],
      o: [0, 0, 0],
      u: [0, 0, 1],
      v: [0, 1, 0],
      shade: 0.77,
      tile: "side",
    },
    {
      name: "up",
      n: [0, 1, 0],
      o: [0, 1, 1],
      u: [1, 0, 0],
      v: [0, 0, -1],
      shade: 1,
      tile: "top",
    },
    {
      name: "down",
      n: [0, -1, 0],
      o: [0, 0, 0],
      u: [1, 0, 0],
      v: [0, 0, 1],
      shade: 0.58,
      tile: "bottom",
    },
    {
      name: "south",
      n: [0, 0, 1],
      o: [0, 0, 1],
      u: [1, 0, 0],
      v: [0, 1, 0],
      shade: 0.9,
      tile: "side",
    },
    {
      name: "north",
      n: [0, 0, -1],
      o: [1, 0, 0],
      u: [-1, 0, 0],
      v: [0, 1, 0],
      shade: 0.73,
      tile: "side",
    },
  ].map((face) =>
    Object.freeze({
      ...face,
      n: Object.freeze(face.n),
      o: Object.freeze(face.o),
      u: Object.freeze(face.u),
      v: Object.freeze(face.v),
      axis: face.n.findIndex(Boolean),
      uAxis: face.u.findIndex(Boolean),
      vAxis: face.v.findIndex(Boolean),
    })
  )
);
export const CORNERS = Object.freeze([
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]);
export const AO = Object.freeze([1, 0.83, 0.67, 0.52]);
export const MAX_SECTION_VERTICES = 131072;

export class MeshBudgetError extends Error {
  constructor() {
    super("Mesh geometry exceeds its bounded buffer budget");
    this.name = "MeshBudgetError";
  }
}

export function createMeshData(maxVertices = Infinity) {
  return {
    batches: Object.fromEntries(
      MESH_BATCHES.map((name) => [
        name,
        {
          positions: [],
          normals: [],
          axisNormals: true,
          uvs: [],
          colors: [],
          indices: [],
          emitters: [],
        },
      ])
    ),
    emitters: [],
    vertices: 0,
    maxVertices,
  };
}

export function appendQuad(
  context,
  batch,
  points,
  normal,
  uv,
  colors,
  shades = [1, 1, 1, 1]
) {
  if (context.reserveQuad) context.reserveQuad(batch);
  else if (context.vertices + 4 > context.maxVertices)
    throw new MeshBudgetError();
  context.vertices += 4;
  const data = context.batches[batch];
  data.axisNormals &&= normal.every((value) => value === -1 || value === 0 || value === 1);
  const base = data.positions.length / 3;
  for (let i = 0; i < 4; i++) {
    data.positions.push(...points[i]);
    data.normals.push(...normal);
    data.uvs.push(...uv[i]);
    data.colors.push(...colors[i]);
  }
  if (shades[0] + shades[2] > shades[1] + shades[3])
    data.indices.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
  else data.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

export function appendPlant(context, x, y, z, id, atlas, tint) {
  const [u0, v0, u1, v1] = atlas.uvFor(id);
  const flat = id === BLOCK.LILY_PAD;
  const height =
    id === BLOCK.DEAD_BUSH ? 0.72 : id === BLOCK.PINK_PETALS ? 0.35 : 1;
  for (let plane = 0; plane < (flat ? 1 : 2); plane++) {
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
    appendQuad(
      context,
      blockBatch[id],
      points.map(([px, py, pz]) => [x + px, y + py, z + pz]),
      flat
        ? [0, 1, 0]
        : [-Math.SQRT1_2, 0, plane === 0 ? Math.SQRT1_2 : -Math.SQRT1_2],
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
      [tint, tint, tint, tint]
    );
  }
}

function makeGeometry(data) {
  if (!data.positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  for (const [name, key, size] of [
    ["position", "positions", 3],
    ["normal", "normals", 3],
    ["uv", "uvs", 2],
    ["color", "colors", 3],
  ])
    geometry.setAttribute(
      name,
      new THREE.Float32BufferAttribute(data[key], size)
    );
  geometry.setIndex(data.indices);
  geometry.userData.emitters = data.emitters;
  geometry.userData.axisNormals = data.axisNormals;
  geometry.computeBoundingSphere();
  return geometry;
}

export function finishMeshData(context) {
  for (const emitter of selectEmitters(context.emitters))
    context.batches[blockBatch[emitter.id]].emitters.push(emitter);
  return Object.fromEntries(
    Object.entries(context.batches).map(([name, data]) => [
      name,
      makeGeometry(data),
    ])
  );
}
