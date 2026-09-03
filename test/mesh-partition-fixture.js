import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { geometryBytes, MESH_BATCHES } from "../src/mesh-palette.js";
import { authoredColumns } from "./shape-fixture.js";

export function partitionGeometries(result) {
  return result.parts.flatMap((part) => Object.values(part).filter(Boolean));
}

export function partitionTotals(result) {
  return partitionGeometries(result).reduce(
    (total, geometry) => ({
      vertices: total.vertices + geometry.getAttribute("position").count,
      indices: total.indices + geometry.index.count,
      bytes: total.bytes + geometryBytes(geometry),
      draws: total.draws + 1,
    }),
    { vertices: 0, indices: 0, bytes: 0, draws: 0 }
  );
}

export function assertPartLimits(result, limits) {
  for (const part of result.parts) {
    const { vertices, bytes, draws } = partitionTotals({ parts: [part] });
    assert.ok(draws > 0, "no empty work units");
    assert.ok(vertices <= limits.maxVertices, "per-part vertex cap");
    assert.ok(bytes <= limits.maxBytes, "per-part byte cap");
  }
}

/** Compare every emitted attribute and index after undoing only local rebasing.
 * Counts alone cannot detect a missing face replaced by a duplicated one.
 */
export function assertPartitionGeometryEqual(result, expected) {
  for (const name of MESH_BATCHES) {
    const geometries = result.parts.map((part) => part[name]).filter(Boolean);
    assert.equal(geometries.length > 0, !!expected[name], name);
    if (!expected[name]) continue;
    let vertices = 0,
      indices = 0;
    for (const geometry of geometries) {
      const count = geometry.getAttribute("position").count;
      for (const attribute of ["position", "normal", "uv", "color"]) {
        const actual = geometry.getAttribute(attribute);
        assert.deepEqual(
          actual.array,
          expected[name]
            .getAttribute(attribute)
            .array.subarray(
              vertices * actual.itemSize,
              (vertices + count) * actual.itemSize
            ),
          `${name}/${attribute}`
        );
      }
      for (let i = 0; i < geometry.index.count; i++)
        assert.equal(
          geometry.index.getX(i) + vertices,
          expected[name].index.getX(indices + i),
          `${name}/index ${indices + i}`
        );
      vertices += count;
      indices += geometry.index.count;
    }
    assert.equal(vertices, expected[name].getAttribute("position").count);
    assert.equal(indices, expected[name].index.count);
  }
}

// Same authored, dry 4096-fence section as the isolated P1 reproduction. No
// terrain generation, world loading, or saved data participates in this fixture.
export function denseFenceColumn() {
  const world = authoredColumns();
  world.chunks
    .get("0,0")
    .blocks.fill(
      BLOCK.OAK_FENCE,
      -world.spec.minY * 256,
      (16 - world.spec.minY) * 256
    );
  return world;
}
