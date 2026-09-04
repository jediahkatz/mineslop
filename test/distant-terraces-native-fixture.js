import assert from "node:assert/strict";
import { WORLD_MAX } from "../src/terrain.js";

const edgeKey = (a, b) => [a.join(","), b.join(",")].sort().join("|");

// Inspect the actual draw index, not source arrays or unreferenced vertices.
// Expected cap/riser levels come from independent native anchor queries.
export function assertRenderedNativeTerraces(lod, nativeHeight) {
  const { data, terrain } = lod._active;
  const geometry = terrain.geometry;
  const points = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const capTriangles = new Map();
  const edges = new Map();
  const caps = new Map();
  const point = (id) => [data.positions[id * 3], data.positions[id * 3 + 2]];
  for (const cell of data.cells) {
    for (let i = 0; i < cell.ring.length; i++) {
      const key = edgeKey(point(cell.ring[i]), point(cell.ring[(i + 1) % cell.ring.length]));
      const cells = edges.get(key) ?? [];
      cells.push(cell);
      edges.set(key, cells);
    }
    if (!cell.valid) continue;
    const [x, z] = point(cell.anchor ?? cell.ring[0]);
    const height = nativeHeight(
      Math.min(WORLD_MAX - 1, x + data.originX),
      Math.min(WORLD_MAX - 1, z + data.originZ)
    );
    const cap = Math.min(data.spec.maxY - 1, Math.floor(height)) + 1;
    caps.set(cell, cap);
    for (let i = cell.terraceStart; i < cell.terraceStart + cell.count; i += 3)
      capTriangles.set([...data.terraces.indices.subarray(i, i + 3)].join(","), cap);
  }
  let renderedCaps = 0, renderedRisers = 0;
  const referenced = new Set();
  for (let i = 0; i < geometry.drawRange.count; i += 3) {
    const ids = [...geometry.index.array.subarray(i, i + 3)];
    for (const id of ids) referenced.add(id);
    const ys = ids.map((id) => points.getY(id));
    if (normal.getY(ids[0]) === 1) {
      const expected = capTriangles.get(ids.join(","));
      assert.notEqual(expected, undefined, "indexed cap belongs to a native-anchored cell");
      assert.deepEqual(ys, [expected, expected, expected]);
      for (const id of ids) assert.equal(normal.getY(id), 1);
      renderedCaps++;
    } else {
      const endpoints = [...new Map(ids.map((id) => {
        const p = [points.getX(id), points.getZ(id)];
        return [p.join(","), p];
      })).values()];
      assert.equal(endpoints.length, 2, "riser lies on one axis-aligned cell boundary");
      const neighbors = edges.get(edgeKey(...endpoints));
      assert.equal(neighbors?.length, 2, "riser joins two native terrain cells");
      // The existing End void-side policy terminates at the world floor.
      // This is a bounded-skirt check, not native underside visual acceptance.
      const levels = neighbors.map((cell) => !cell.valid && data.request.dimension === "end"
        ? data.spec.minY : caps.get(cell)).sort((a, b) => a - b);
      assert.ok(levels[0] < levels[1]);
      assert.deepEqual([...new Set(ys)].sort((a, b) => a - b), levels);
      for (const id of ids) assert.ok(normal.getY(id) === 0);
      renderedRisers++;
    }
  }
  assert.ok(renderedCaps > 0, "native-height assertions exercised rendered caps");
  return { renderedCaps, renderedRisers, referenced: referenced.size };
}
