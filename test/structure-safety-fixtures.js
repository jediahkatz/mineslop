import assert from "node:assert/strict";
import { normalizeCell } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { resolveShape } from "../src/block-shapes.js";
import {
  bodyBox,
  boxCollides,
  hasBodySupport,
  moveBody,
} from "../src/collision.js";
import {
  createStructureDecorators,
  describeStructure,
  getStructureMarkers,
  STRUCTURE_LIMITS,
} from "../src/structure-catalog.js";
import { rotateStructureXZ, structurePoint } from "../src/structure-layouts.js";
import {
  cellKey,
  insideStructureBounds,
  namedStructureCells,
  reachableStructureCells,
} from "./structure-fixtures.js";

// Detached, authored terrain fields. Native selection, descriptors, emission,
// registry, shape resolution and collision remain unmodified. These fixtures
// do not demonstrate natural discovery, loaded World state or full gameplay.
export function resampleSafetyFixture(fixture, change = (column) => column) {
  const baseline = fixture.descriptor;
  const queried = new Set();
  let samples = 0;
  const columnAt = (x, z) => {
    const [lx, lz] = rotateStructureXZ(
      x - baseline.origin.x,
      z - baseline.origin.z,
      (4 - baseline.rotation) & 3
    );
    return change({ ...fixture.column, x, z }, lx, lz);
  };
  const context = {
    ...fixture.context,
    sampleColumn(x, z) {
      samples++;
      queried.add(cellKey(x, 0, z));
      return columnAt(x, z);
    },
  };
  const descriptor = describeStructure(
    baseline.kind,
    context,
    baseline.gx,
    baseline.gz
  );
  assert.ok(samples <= STRUCTURE_LIMITS.describeSamples);
  assert.equal(samples, queried.size, "native site caches exact columns");
  if (descriptor) {
    assert.equal(descriptor.id, baseline.id);
    assert.equal(descriptor.rotation, baseline.rotation);
    assert.equal(descriptor.variant, baseline.variant);
    assert.deepEqual(
      descriptor.markers.map((marker) => marker.id),
      baseline.markers.map((marker) => marker.id)
    );
  }
  return {
    ...fixture,
    baseline,
    descriptor,
    context,
    columnAt,
    samples,
    queried,
  };
}

export function nativeSafetyWorld(
  fixture,
  { bounds = fixture.descriptor.bounds, accepted = true } = {}
) {
  const { descriptor: d, context, columnAt } = fixture;
  const original = structuredClone(d);
  const [decorator] = createStructureDecorators({ kinds: [d.kind] });
  const cells = new Map();
  const writes = [];
  decorator.emit(d, (x, y, z, id, options) => {
    assert.ok(insideStructureBounds(d.bounds, x, y, z));
    writes.push({ x, y, z, id, ...options });
    if (insideStructureBounds(bounds, x, y, z))
      cells.set(
        cellKey(x, y, z),
        normalizeCell({ id, state: options.state, fluid: options.fluid })
      );
    return accepted;
  });
  assert.ok(writes.length <= decorator.maxWrites);
  assert.deepEqual(d, original, "emission never mutates the descriptor");
  const { spec, dimension } = context;
  const getCell = (x, y, z) => {
    if (
      ![x, y, z].every(Number.isSafeInteger) ||
      y < spec.minY ||
      y >= spec.maxY
    )
      return null;
    const emitted = cells.get(cellKey(x, y, z));
    if (emitted) return emitted;
    const column = columnAt(x, z);
    const id =
      y === column.top
        ? column.surface
        : y < column.top && y >= column.top - 3
          ? column.soil
          : y < column.top
            ? dimension === "nether"
              ? BLOCK.NETHERRACK
              : BLOCK.STONE
            : BLOCK.AIR;
    return normalizeCell({ id });
  };
  const world = { spec, dimension, generatorVersion: 4, getCell };
  const localCell = (x, y, z) => {
    const p = structurePoint(d, x, y, z);
    return getCell(p.x, p.y, p.z);
  };
  const localShape = (x, y, z) => {
    const p = structurePoint(d, x, y, z);
    return resolveShape(getCell(p.x, p.y, p.z), (dx, dy, dz) =>
      getCell(p.x + dx, p.y + dy, p.z + dz)
    );
  };
  return { world, cells, writes, localCell, localShape };
}

export function centeredStructurePoint(d, x, y, z) {
  const p = structurePoint(d, x, y, z);
  return { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
}

export function assertNativeStanding(world, position) {
  assert.equal(boxCollides(world, bodyBox(position)), false, "body is clear");
  assert.ok(hasBodySupport(world, position), "body has native support");
}

// A continuous grounded, no-jump check using the real auto-step limit. Each
// segment starts at the previous native result, never at a corrected height.
export function assertNativeWalk(world, start, targets) {
  assertNativeStanding(world, start);
  let position = start;
  for (const target of targets) {
    const moved = moveBody(world, position, {
      x: target.x - position.x,
      y: 0,
      z: target.z - position.z,
    });
    for (const axis of ["x", "y", "z"])
      assert.ok(
        Math.abs(moved.position[axis] - target[axis]) < 1e-6,
        `native ${axis} movement reaches ${target[axis]}, got ${moved.position[axis]}`
      );
    assert.equal(moved.blocked.x, false);
    assert.equal(moved.blocked.z, false);
    assertNativeStanding(world, moved.position);
    position = moved.position;
  }
  return position;
}

export function assertSafetyRoutes(fixture) {
  const { descriptor: d } = fixture;
  // This existing authored graph allows door/gate interactions and one-block
  // steps. Native collision/movement assertions are separate, not replaced.
  const reachable = reachableStructureCells(
    fixture,
    namedStructureCells(d).cells
  );
  for (const entry of d.entries)
    assert.ok(
      reachable.has(cellKey(entry.x, entry.y, entry.z)),
      "every entry belongs to the same exterior-connected component"
    );
  for (const marker of d.markers) {
    const { x, y, z } = marker.position;
    if (
      ["container", "job_site", "bed"].includes(marker.type) ||
      marker.mechanism === "spawner"
    )
      assert.ok(
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dz]) => reachable.has(cellKey(x + dx, y, z + dz))),
        `${d.variant} connects to ${marker.role}`
      );
    else
      assert.ok(
        reachable.has(cellKey(x, y, z)),
        `${d.variant} connects to ${marker.role}`
      );
  }
}

export function assertSafetyClipping(fixture, full) {
  const { descriptor: d } = fixture;
  const regions = [];
  for (
    let cz = Math.floor((d.bounds.maxZ - 1) / 16);
    cz >= Math.floor(d.bounds.minZ / 16);
    cz--
  )
    for (
      let cx = Math.floor((d.bounds.maxX - 1) / 16);
      cx >= Math.floor(d.bounds.minX / 16);
      cx--
    )
      regions.push({
        minX: cx * 16,
        minY: d.bounds.minY,
        minZ: cz * 16,
        maxX: (cx + 1) * 16,
        maxY: d.bounds.maxY,
        maxZ: (cz + 1) * 16,
      });
  const combined = new Map();
  const markerIds = [];
  for (const bounds of regions) {
    const clipped = nativeSafetyWorld(fixture, { bounds, accepted: false });
    assert.deepEqual(clipped.writes, full.writes);
    for (const [key, cell] of clipped.cells) {
      assert.equal(combined.has(key), false);
      combined.set(key, cell);
    }
    markerIds.push(...getStructureMarkers(d, { bounds }).map((m) => m.id));
  }
  assert.deepEqual(combined, full.cells);
  assert.deepEqual(markerIds.sort(), d.markers.map((m) => m.id).sort());
}
