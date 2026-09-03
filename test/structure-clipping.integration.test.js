import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  createStructureDecorators,
  getStructureMarkers,
  STRUCTURE_KINDS,
} from "../src/structure-catalog.js";
import { newV4Counters } from "../src/terrain-v4-config.js";
import { createV4Decorators } from "../src/terrain-v4-decorators.js";
import { createV4Writer, readV4RegionCell } from "../src/terrain-v4-writer.js";
import {
  insideStructureBounds,
  namedStructureCells,
  structureFixture,
} from "./structure-fixtures.js";

function authoredPacket(fixture, area, decorators) {
  const { context, descriptor: d } = fixture;
  const counters = newV4Counters();
  const writer = createV4Writer({ ...area, spec: context.spec, counters });
  // Only the band around the authored layout is populated. This exercises the
  // real seam/writer/state planes, not natural terrain discovery or generation.
  for (let z = area.minZ; z < area.minZ + area.depth; z++)
    for (let x = area.minX; x < area.minX + area.width; x++) {
      const column = context.sampleColumn(x, z);
      for (let y = d.bounds.minY - 1; y <= d.bounds.maxY; y++) {
        const block =
          y <= column.top
            ? BLOCK.STONE
            : Number.isInteger(column.waterLevel) && y <= column.waterLevel
              ? BLOCK.WATER
              : BLOCK.AIR;
        writer.set(x, y, z, block);
      }
    }
  const structures = createV4Decorators(
    decorators,
    context,
    counters
  )(area, writer);
  return { ...area, ...writer.finish(), structures, counters };
}

for (const kind of STRUCTURE_KINDS) {
  test(`authored ${kind} produces identical canonical cells through full, reversed chunk and independent region emission`, () => {
    const fixture = structureFixture(kind);
    const { descriptor: d, context } = fixture;
    const { bounds: b } = d;
    const decorators = createStructureDecorators({ kinds: [kind] });
    const area = {
      minX: b.minX,
      minZ: b.minZ,
      width: b.maxX - b.minX,
      depth: b.maxZ - b.minZ,
    };
    const full = authoredPacket(fixture, area, decorators);
    assert.equal(full.structures.length, 1);
    assert.equal(full.structures[0].id, d.id);

    const chunks = new Map();
    const ownerMarkers = [];
    for (
      let cz = Math.floor((b.maxZ - 1) / 16);
      cz >= Math.floor(b.minZ / 16);
      cz--
    )
      for (
        let cx = Math.floor((b.maxX - 1) / 16);
        cx >= Math.floor(b.minX / 16);
        cx--
      ) {
        const packet = authoredPacket(
          fixture,
          { minX: cx * 16, minZ: cz * 16, width: 16, depth: 16 },
          decorators
        );
        chunks.set(`${cx},${cz}`, packet);
        for (const descriptor of packet.structures) {
          assert.deepEqual(descriptor.markers, d.markers);
          ownerMarkers.push(
            ...getStructureMarkers(descriptor, {
              bounds: {
                minX: cx * 16,
                minY: context.spec.minY,
                minZ: cz * 16,
                maxX: (cx + 1) * 16,
                maxY: context.spec.maxY,
                maxZ: (cz + 1) * 16,
              },
            })
          );
        }
      }
    const cutX = b.minX + Math.floor(area.width / 2);
    const cutZ = b.minZ + Math.floor(area.depth / 2);
    const regions = [];
    for (const [z0, z1] of [
      [cutZ, b.maxZ],
      [b.minZ, cutZ],
    ])
      for (const [x0, x1] of [
        [cutX, b.maxX],
        [b.minX, cutX],
      ])
        regions.push(
          authoredPacket(
            fixture,
            {
              minX: x0,
              minZ: z0,
              width: x1 - x0,
              depth: z1 - z0,
            },
            decorators
          )
        );
    for (let z = b.minZ; z < b.maxZ; z++)
      for (let x = b.minX; x < b.maxX; x++) {
        const chunk = chunks.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
        const region = regions.find(
          (r) =>
            x >= r.minX &&
            x < r.minX + r.width &&
            z >= r.minZ &&
            z < r.minZ + r.depth
        );
        for (let y = b.minY; y < b.maxY; y++) {
          const expected = readV4RegionCell(full, x, y, z);
          assert.deepEqual(
            readV4RegionCell(chunk, x, y, z),
            expected,
            `chunk ${x},${y},${z}`
          );
          assert.deepEqual(
            readV4RegionCell(region, x, y, z),
            expected,
            `region ${x},${y},${z}`
          );
        }
      }
    assert.deepEqual(
      ownerMarkers.map((m) => m.id).sort(),
      d.markers.map((m) => m.id).sort()
    );
    assert.equal(
      new Set([...ownerMarkers, ...ownerMarkers].map((m) => m.id)).size,
      d.markers.length
    );
    assert.ok(full.counters.featureWrites <= decorators[0].maxWrites);
  });
}

test("authored symbolic clipped writes never change the following writes or return new marker identities", () => {
  for (const kind of STRUCTURE_KINDS) {
    const { descriptor: d } = structureFixture(kind);
    const full = namedStructureCells(d, d.bounds, true);
    const half = {
      ...d.bounds,
      maxX: Math.floor((d.bounds.minX + d.bounds.maxX) / 2),
    };
    const clipped = namedStructureCells(d, half, false);
    assert.equal(clipped.writes, full.writes);
    assert.deepEqual(
      clipped.cells,
      new Map(
        [...full.cells].filter(([, cell]) =>
          insideStructureBounds(half, cell.x, cell.y, cell.z)
        )
      )
    );
    assert.deepEqual(
      getStructureMarkers(structuredClone(d)),
      getStructureMarkers(d)
    );
  }
});
