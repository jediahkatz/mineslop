import assert from "node:assert/strict";
import test from "node:test";
import { containsPoint } from "../src/aabb.js";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { resolveShape } from "../src/block-shapes.js";
import { buildChunkGeometry } from "../src/chunk-mesh.js";
import { shapeAt } from "../src/geometry-world.js";
import { disposeBatches } from "../src/mesh-palette.js";
import { snapshotSection } from "../src/mesh-snapshot.js";
import { createRangeMesher } from "../src/resolved-mesh.js";
import { FACES, finishMeshData } from "../src/mesh-geometry.js";
import { faceTexture } from "../src/shape-mesh.js";
import {
  authoredColumns,
  cell,
  shapeAtlas,
  shapeWorld,
} from "./shape-fixture.js";

function faceArea(geometry, matches = () => true) {
  if (!geometry) return 0;
  const points = geometry.getAttribute("position"),
    normals = geometry.getAttribute("normal");
  let area = 0;
  for (let i = 0; i < geometry.index.count; i += 3) {
    const indices = [0, 1, 2].map((offset) => geometry.index.getX(i + offset));
    const vertices = indices.map((index) => [
      points.getX(index),
      points.getY(index),
      points.getZ(index),
    ]);
    const n = [
      normals.getX(indices[0]),
      normals.getY(indices[0]),
      normals.getZ(indices[0]),
    ];
    if (!matches(vertices, n)) continue;
    const a = vertices[1].map((value, axis) => value - vertices[0][axis]);
    const b = vertices[2].map((value, axis) => value - vertices[0][axis]);
    area +=
      Math.hypot(
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
      ) / 2;
  }
  return area;
}

test("full-cube/legacy plant/liquid geometry matches the old fast path attribute-for-attribute", () => {
  const entries = [
    [1, 2, 3, BLOCK.GRASS],
    [2, 2, 3, BLOCK.STONE],
    [4, 3, 5, BLOCK.GLASS],
    [5, 3, 5, BLOCK.GLASS],
    [8, 2, 2, BLOCK.RED_FLOWER],
    [8, 2, 4, BLOCK.WATER],
    [8, 3, 6, BLOCK.TORCH],
    [13, 4, 12, BLOCK.LEAVES],
    [14, 5, 12, BLOCK.STONE],
    [3, 5, 10, BLOCK.PACKED_ICE],
    [5, 5, 10, BLOCK.BLUE_ICE],
    [7, 5, 10, BLOCK.GLOW_BERRIES],
    [9, 5, 10, BLOCK.COPPER_BLOCK],
    [11, 5, 10, BLOCK.LAVA],
    [13, 5, 10, BLOCK.LILY_PAD],
  ];
  const cells = new Map(entries.map(([x, y, z, id]) => [`${x},${y},${z}`, id]));
  const legacy = { get: (x, y, z) => cells.get(`${x},${y},${z}`) ?? 0 };
  const resolved = shapeWorld(entries, { generatorVersion: 3 });
  const a = buildChunkGeometry(legacy, 0, 0, shapeAtlas);
  const b = buildChunkGeometry(resolved, 0, 0, shapeAtlas);
  try {
    for (const name of Object.keys(a)) {
      assert.equal(!!a[name], !!b[name], name);
      if (!a[name]) continue;
      for (const attribute of ["position", "normal", "uv", "color"])
        assert.deepEqual(
          a[name].getAttribute(attribute).array,
          b[name].getAttribute(attribute).array,
          `${name}/${attribute}`
        );
      assert.deepEqual(
        a[name].index.array,
        b[name].index.array,
        `${name}/indices`
      );
      assert.deepEqual(a[name].userData.emitters, b[name].userData.emitters);
    }
  } finally {
    disposeBatches(a);
    disposeBatches(b);
  }
});

test("resident historical columns keep cube batching while real high IDs and auxiliary states survive", () => {
  const blocks = new Uint16Array(96 * 256);
  blocks[256] = BLOCK.COPPER_BLOCK;
  const chunk = { minY: 0, maxY: 96, blocks, sections: new Map() };
  const world = {
    generatorVersion: 3,
    chunks: new Map([["0,0", chunk]]),
    getCell: () =>
      assert.fail(
        "resident meshing decodes detached buffers without world cell reads"
      ),
  };
  const seen = new Set();
  const atlas = {
    uvFor(id) {
      seen.add(id);
      return [0, 0, 1, 1];
    },
  };
  const cube = buildChunkGeometry(world, 0, 0, atlas);
  try {
    assert.equal(cube.opaque.index.count, 36);
    assert.ok(seen.has(BLOCK.COPPER_BLOCK));
  } finally {
    disposeBatches(cube);
  }
  blocks[256] = BLOCK.OAK_SLAB;
  const states = new Uint16Array(4096);
  states[256] = S.TOP;
  chunk.sections.set(0, { sy: 0, states });
  const slab = buildChunkGeometry(world, 0, 0, atlas);
  try {
    const p = slab.opaque.getAttribute("position");
    assert.equal(
      Math.min(...Array.from({ length: p.count }, (_, i) => p.getY(i))),
      1.5
    );
    assert.equal(
      Math.max(...Array.from({ length: p.count }, (_, i) => p.getY(i))),
      2
    );
    assert.ok(seen.has(BLOCK.OAK_SLAB));
  } finally {
    disposeBatches(slab);
  }
});

test("partial face coverage removes only the covered slab half, leaving no holes", () => {
  const geometry = buildChunkGeometry(
    shapeWorld([
      [0, 0, 0, BLOCK.STONE],
      [1, 0, 0, BLOCK.OAK_SLAB],
    ]),
    0,
    0,
    shapeAtlas
  );
  try {
    assert.equal(faceArea(geometry.opaque), 9);
    assert.equal(
      faceArea(
        geometry.opaque,
        (vertices, n) => n[0] === 1 && vertices.every((point) => point[0] === 1)
      ),
      0.5
    );
    assert.equal(
      faceArea(
        geometry.opaque,
        (vertices, n) =>
          n[0] === -1 && vertices.every((point) => point[0] === 1)
      ),
      0
    );
  } finally {
    disposeBatches(geometry);
  }
});

test("fence occlusion follows visible rails, never its invisible 1.5-high collider", () => {
  const geometry = buildChunkGeometry(
    shapeWorld([
      [0, 0, 0, BLOCK.OAK_FENCE],
      [1, 0, 0, BLOCK.STONE],
      [0, 1, 0, BLOCK.STONE],
    ]),
    0,
    0,
    shapeAtlas
  );
  try {
    const side = faceArea(
      geometry.opaque,
      (vertices, n) =>
        n[0] === -1 &&
        vertices.every((point) => point[0] === 1 && point[1] <= 1)
    );
    assert.equal(side, 1 - 2 * (3 / 16) * (2 / 16));
    const underside = faceArea(
      geometry.opaque,
      (vertices, n) =>
        n[1] === -1 &&
        vertices.every((point) => point[1] === 1 && point[0] <= 1)
    );
    assert.equal(underside, 1 - (4 / 16) ** 2);
  } finally {
    disposeBatches(geometry);
  }
});

test("rotated partial shapes emit outward winding, valid atlas UVs and no internal union faces", () => {
  const variants = [
    ...[0, S.TOP, S.DOUBLE].map((state) => [BLOCK.OAK_SLAB, state]),
    ...[0, 1, 2, 3].flatMap((facing) => [
      [BLOCK.OAK_STAIRS, facing],
      [BLOCK.OAK_STAIRS, facing | S.TOP],
      [BLOCK.OAK_DOOR, facing | S.OPEN | S.HINGE_RIGHT],
      [BLOCK.OAK_TRAPDOOR, facing | S.OPEN],
      [BLOCK.OAK_FENCE_GATE, facing],
      [BLOCK.OAK_FENCE_GATE, facing | S.OPEN],
      [BLOCK.LADDER, facing],
      [BLOCK.WHITE_BED, facing],
    ]),
    [BLOCK.OAK_FENCE, 0],
  ];
  for (const [id, state] of variants) {
    const world = shapeWorld([[2, -2, 2, id, state]]);
    const batches = buildChunkGeometry(world, 0, 0, shapeAtlas);
    try {
      for (const geometry of Object.values(batches).filter(Boolean)) {
        const p = geometry.getAttribute("position"),
          n = geometry.getAttribute("normal");
        assert.ok(
          [...geometry.getAttribute("uv").array].every(
            (value) => value >= 0 && value <= 1
          )
        );
        for (let i = 0; i < geometry.index.count; i += 3) {
          const indices = [0, 1, 2].map((offset) =>
            geometry.index.getX(i + offset)
          );
          const points = indices.map((at) => [
            p.getX(at),
            p.getY(at),
            p.getZ(at),
          ]);
          const normal = [
            n.getX(indices[0]),
            n.getY(indices[0]),
            n.getZ(indices[0]),
          ];
          const a = points[1].map((value, axis) => value - points[0][axis]);
          const b = points[2].map((value, axis) => value - points[0][axis]);
          const cross = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
          ];
          assert.ok(
            cross.reduce((sum, value, axis) => sum + value * normal[axis], 0) >
              0
          );
          const center = [0, 1, 2].map(
            (axis) => points.reduce((sum, point) => sum + point[axis], 0) / 3
          );
          const outside = center.map(
            (value, axis) => value + normal[axis] * 0.0001
          );
          const inside = center.map(
            (value, axis) => value - normal[axis] * 0.0001
          );
          const shape = shapeAt(world, 2, -2, 2).shape;
          const local = (point) => [point[0] - 2, point[1] + 2, point[2] - 2];
          assert.equal(
            shape.render.some((box) => containsPoint(box, local(outside))),
            false,
            `${id}/${state}: exterior`
          );
          assert.equal(
            shape.render.some((box) => containsPoint(box, local(inside))),
            true,
            `${id}/${state}: interior`
          );
        }
      }
    } finally {
      disposeBatches(batches);
    }
  }
});

test("AO samples the occupied part of a neighbor instead of its coarse solid flag", () => {
  const colorAtCorner = (state) => {
    const geometry = buildChunkGeometry(
      shapeWorld([
        [0, 0, 0, BLOCK.STONE],
        [1, 1, 0, BLOCK.OAK_SLAB, state],
      ]),
      0,
      0,
      shapeAtlas
    );
    try {
      const p = geometry.opaque.getAttribute("position"),
        n = geometry.opaque.getAttribute("normal");
      const index = Array.from({ length: p.count }, (_, i) => i).find(
        (i) =>
          p.getX(i) === 1 &&
          p.getY(i) === 1 &&
          p.getZ(i) === 1 &&
          n.getY(i) === 1
      );
      return geometry.opaque.getAttribute("color").getX(index);
    } finally {
      disposeBatches(geometry);
    }
  };
  assert.ok(colorAtCorner(0) < colorAtCorner(S.TOP));
});

test("declared horizontal log axes put end grain on the matching normals and rotate side grain", () => {
  for (const [state, axis] of [
    [S.AXIS_X, 0],
    [S.AXIS_Z, 2],
  ]) {
    const shape = resolveShape(cell(BLOCK.OAK_LOG, state));
    for (const face of FACES) {
      const texture = faceTexture(shape, face);
      assert.equal(
        texture.tile,
        face.n[axis] ? (face.n[axis] > 0 ? "top" : "bottom") : "side"
      );
      assert.equal(texture.rotate, !face.n[axis] && !!face.u[axis]);
    }
  }
});

test("section snapshots preserve real high IDs, state planes and signed section-local indexing", () => {
  const world = authoredColumns(
    [[0, 0]],
    [
      [1, -17, 1, BLOCK.COPPER_BLOCK],
      [2, -17, 1, BLOCK.OAK_SLAB, S.TOP, FLUID.WATER_SOURCE],
    ]
  );
  const snapshot = snapshotSection(world, 0, 0, -2);
  assert.ok(snapshot.ids instanceof Uint16Array);
  assert.equal(snapshot.cellAt(1, -17, 1).id, BLOCK.COPPER_BLOCK);
  assert.deepEqual(snapshot.cellAt(2, -17, 1), {
    id: BLOCK.OAK_SLAB,
    state: S.TOP,
    fluid: FLUID.WATER_SOURCE,
  });
  const seen = new Set();
  const mesher = createRangeMesher(
    snapshot,
    {
      uvFor(id) {
        seen.add(id);
        return [0, 0, 1, 1];
      },
    },
    world
  );
  mesher.stepCells(Infinity);
  const geometry = finishMeshData(mesher.context);
  try {
    assert.ok(seen.has(BLOCK.COPPER_BLOCK));
    assert.ok(seen.has(BLOCK.OAK_SLAB));
    assert.ok(seen.has(BLOCK.WATER));
    assert.ok(geometry.opaque);
    assert.ok(geometry.water);
    assert.ok(
      [...geometry.opaque.getAttribute("position").array].every(Number.isFinite)
    );
  } finally {
    disposeBatches(geometry);
  }
});
