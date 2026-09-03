import assert from "node:assert/strict";
import test from "node:test";
import {
  distantGridCells,
  DISTANT_GRID_LIMITS,
  DISTANT_QUALITY,
} from "../src/distant-grid.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "../src/terrain.js";

function viewBounds(cx, cz, quality) {
  const extent = DISTANT_QUALITY[quality].horizon + 2 * CHUNK_SIZE;
  return {
    minX: Math.max(WORLD_MIN, cx * CHUNK_SIZE - extent),
    maxX: Math.min(WORLD_MAX, (cx + 1) * CHUNK_SIZE + extent),
    minZ: Math.max(WORLD_MIN, cz * CHUNK_SIZE - extent),
    maxZ: Math.min(WORLD_MAX, (cz + 1) * CHUNK_SIZE + extent),
  };
}

function inspectGrid(cx, cz, quality) {
  const bounds = viewBounds(cx, cz, quality);
  const points = new Set();
  const edges = new Map();
  let cells = 0,
    indices = 0,
    area = 0,
    stitched = 0;
  for (const cell of distantGridCells(cx, cz, bounds, quality)) {
    cells++;
    if (cell.center) stitched++;
    for (const [x, z] of cell.boundary) {
      assert.ok(Number.isInteger(x) && Number.isInteger(z));
      assert.ok(x >= cell.cx * CHUNK_SIZE && x <= (cell.cx + 1) * CHUNK_SIZE);
      assert.ok(z >= cell.cz * CHUNK_SIZE && z <= (cell.cz + 1) * CHUNK_SIZE);
    }
    const ring = cell.boundary;
    const triangles = cell.center
      ? ring.map((point, i) => [
          cell.center,
          point,
          ring[(i + 1) % ring.length],
        ])
      : [[ring[0], ring[1], ring[2]], [ring[0], ring[2], ring[3]]];
    for (const triangle of triangles) {
      indices += 3;
      const [a, b, c] = triangle;
      const twiceArea =
        (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
      assert.ok(twiceArea > 0, "every triangle has upward winding");
      area += twiceArea / 2;
      for (let i = 0; i < 3; i++) {
        const a = triangle[i],
          b = triangle[(i + 1) % 3];
        const from = a.join(","),
          to = b.join(",");
        points.add(from);
        const key = from < to ? `${from}|${to}` : `${to}|${from}`;
        const edge = edges.get(key) ?? { a, b, count: 0, winding: 0 };
        edge.count++;
        edge.winding += from < to ? 1 : -1;
        edges.set(key, edge);
      }
    }
  }
  for (const { a, b, count, winding } of edges.values()) {
    if (count === 1) {
      assert.ok(
        (a[0] === b[0] && [bounds.minX, bounds.maxX].includes(a[0])) ||
          (a[1] === b[1] && [bounds.minZ, bounds.maxZ].includes(a[1])),
        "a one-sided interior edge would expose a coarse/fine T-junction"
      );
    } else {
      assert.equal(count, 2, "interior faces meet once, without overlap");
      assert.equal(winding, 0, "shared edges have opposite winding");
    }
  }
  assert.equal(area, (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ));
  assert.ok(points.size <= DISTANT_GRID_LIMITS.vertices);
  assert.ok(cells <= DISTANT_GRID_LIMITS.cells);
  assert.ok(indices <= DISTANT_GRID_LIMITS.indices);
  return { vertices: points.size, cells, indices, stitched };
}

for (const quality of Object.keys(DISTANT_QUALITY)) {
  test(`${quality}: all density boundaries stitch exactly at signed and clipped world coordinates`, () => {
    for (const [cx, cz] of [
      [0, 0],
      [-2, -1],
      [WORLD_MIN / CHUNK_SIZE, WORLD_MAX / CHUNK_SIZE - 1],
      [WORLD_MAX / CHUNK_SIZE - 1, WORLD_MIN / CHUNK_SIZE],
    ]) {
      const result = inspectGrid(cx, cz, quality);
      assert.ok(result.stitched > 0);
    }
  });
}

test("the farther horizons have exact bounded topology, without increasing detail radii", (t) => {
  const expected = {
    low: { horizon: 160, vertices: 1933, cells: 1720, indices: 11292 },
    medium: { horizon: 320, vertices: 4393, cells: 4080, indices: 25812 },
    high: { horizon: 448, vertices: 7453, cells: 7048, indices: 43980 },
  };
  for (const [quality, budget] of Object.entries(expected)) {
    const result = inspectGrid(0, 0, quality);
    assert.equal(DISTANT_QUALITY[quality].horizon, budget.horizon);
    for (const key of ["vertices", "cells", "indices"])
      assert.equal(result[key], budget[key], `${quality}: ${key}`);
    t.diagnostic(JSON.stringify({ quality, horizon: budget.horizon, ...result }));
  }
});

test("invalid or oversized grid requests fail before yielding topology", () => {
  const bounds = viewBounds(0, 0, "high");
  for (const bad of [
    null,
    { ...bounds, minX: NaN },
    { ...bounds, maxX: bounds.minX },
    { ...bounds, minX: bounds.minX + 1 },
    { ...bounds, maxX: bounds.maxX + CHUNK_SIZE },
  ])
    assert.throws(() => distantGridCells(0, 0, bad).next(), RangeError);
  assert.throws(() => distantGridCells(NaN, 0, bounds).next(), RangeError);
  assert.deepEqual(
    [...distantGridCells(0, 0, bounds, "constructor")],
    [...distantGridCells(0, 0, bounds, "medium")]
  );
});
