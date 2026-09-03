import assert from "node:assert/strict";
import { BLOCK_STATE as S, FLUID, normalizeCell } from "../src/block-state.js";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { resolveShape } from "../src/block-shapes.js";
import { seedHash } from "../src/noise.js";
import {
  describeStructure,
  emitStructureNamed,
} from "../src/structure-catalog.js";
import { rotateStructureXZ, structurePoint } from "../src/structure-layouts.js";
import { createStructureSite } from "../src/structure-placement.js";
import { V4_SPECS } from "../src/terrain-v4-config.js";

// AUTHORED fixtures only. These deliberately flat/mixed sample fields do not
// demonstrate natural discovery, native cave support, loot or NPC gameplay.
export function authoredColumn(kind, overrides = {}) {
  const base = {
    id: "plains",
    top: 72,
    landTop: 72,
    bottom: -64,
    surface: BLOCK.GRASS,
    soil: BLOCK.DIRT,
    depth: 0,
    waterLevel: null,
    temperature: 0.5,
    moisture: 0.5,
    continental: 0.7,
    frozen: false,
    openings: [],
    surfaceOpen: false,
    treeSafe: true,
  };
  if (["shipwreck", "ocean_ruin", "ocean_monument"].includes(kind))
    Object.assign(base, {
      id:
        kind === "ocean_monument"
          ? "deep_ocean"
          : kind === "ocean_ruin"
            ? "warm_ocean"
            : "ocean",
      top: kind === "ocean_monument" ? 24 : 38,
      landTop: kind === "ocean_monument" ? 24 : 38,
      depth: kind === "ocean_monument" ? 39 : 25,
      waterLevel: 63,
      temperature: kind === "ocean_ruin" ? 0.8 : 0.5,
      surface: BLOCK.GRAVEL,
      soil: BLOCK.GRAVEL,
      continental: 0.3,
    });
  if (kind === "buried_treasure")
    Object.assign(base, {
      id: "beach",
      top: 65,
      landTop: 65,
      surface: BLOCK.SAND,
      soil: BLOCK.SAND,
    });
  if (kind === "dungeon")
    Object.assign(base, { id: "forest", top: 84, landTop: 84 });
  if (kind === "nether_fortress" || kind === "bastion_remnant")
    Object.assign(base, {
      id: "nether_wastes",
      top: 47,
      landTop: 47,
      bottom: 0,
      roof: 111,
      lavaLevel: 31,
      surface: BLOCK.NETHERRACK,
      soil: BLOCK.NETHERRACK,
      temperature: 1,
    });
  return Object.freeze({ ...base, ...overrides });
}

export function authoredContext(kind, seed, column = authoredColumn(kind)) {
  const dimension = ["nether_fortress", "bastion_remnant"].includes(kind)
    ? "nether"
    : "overworld";
  const calls = { samples: 0 };
  const context = {
    seed,
    salt: seedHash(seed),
    dimension,
    spec: V4_SPECS[dimension],
    sampleColumn(x, z) {
      calls.samples++;
      return { ...column, x, z };
    },
  };
  return { context, calls, column };
}

export function structureFixture(
  kind,
  { gx = -2, gz = -3, column = authoredColumn(kind), matches = () => true } = {}
) {
  for (let index = 0; index < 512; index++) {
    const fixture = authoredContext(
      kind,
      `authored-structure-${index}`,
      column
    );
    const descriptor = describeStructure(kind, fixture.context, gx, gz);
    if (descriptor && matches(descriptor))
      return { ...fixture, descriptor, gx, gz };
  }
  assert.fail(`Authored fixture search did not select ${kind}`);
}

export function beachedStructureFixture(damage = "whole") {
  const beach = authoredColumn("buried_treasure");
  const shallow = authoredColumn("shipwreck", {
    top: 62,
    landTop: 62,
    depth: 1,
  });
  const gx = -3;
  const gz = -4;
  for (let i = 0; i < 512; i++) {
    const fixture = authoredContext(
      "shipwreck",
      `authored-beached-${i}`,
      beach
    );
    const site = createStructureSite(fixture.context, gx, gz);
    const context = {
      ...fixture.context,
      sampleColumn(x, z) {
        const [, localZ] = rotateStructureXZ(
          x - site.origin.x,
          z - site.origin.z,
          (4 - site.rotation) & 3
        );
        return localZ >= 5 ? shallow : beach;
      },
    };
    const descriptor = describeStructure("shipwreck", context, gx, gz);
    if (descriptor?.plan.damage === damage)
      return { ...fixture, context, descriptor, gx, gz };
  }
  assert.fail(`Authored coastal fixture did not select ${damage}`);
}

export const cellKey = (x, y, z) => `${x},${y},${z}`;
export const insideStructureBounds = (b, x, y, z) =>
  x >= b.minX &&
  x < b.maxX &&
  y >= b.minY &&
  y < b.maxY &&
  z >= b.minZ &&
  z < b.maxZ;

export function namedStructureCells(
  descriptor,
  bounds = descriptor.bounds,
  result = false
) {
  const cells = new Map();
  const writes = emitStructureNamed(descriptor, (x, y, z, block, options) => {
    if (insideStructureBounds(bounds, x, y, z))
      cells.set(cellKey(x, y, z), {
        x,
        y,
        z,
        block,
        state: options.state,
        fluid: options.fluid,
      });
    return result;
  });
  return { cells, writes };
}

export function localStructureCell(cells, descriptor, x, y, z) {
  const p = structurePoint(descriptor, x, y, z);
  return cells.get(cellKey(p.x, p.y, p.z));
}

export function registeredCell(value) {
  assert.ok(
    Number.isInteger(BLOCK[value.block]),
    `Parent must register ${value.block} before native-cell tests`
  );
  return normalizeCell({
    id: BLOCK[value.block],
    state: value.state,
    fluid: value.fluid,
  });
}

function naturalCell(context, x, y, z) {
  const column = context.sampleColumn(x, z);
  const block =
    y <= column.top
      ? context.dimension === "nether"
        ? "NETHERRACK"
        : "STONE"
      : Number.isInteger(column.waterLevel) && y <= column.waterLevel
        ? "WATER"
        : "AIR";
  return {
    x,
    y,
    z,
    block,
    state: 0,
    fluid: block === "WATER" ? FLUID.WATER_SOURCE : FLUID.NONE,
  };
}

/**
 * Authored geometry route check: a two-cell body, door/gate interaction allowed,
 * one-block horizontal steps, and vertical moves only in water/on real ladders.
 * Starts at one exterior-connected entry, never a union of disconnected entries.
 * This supplements, not replaces, parent physics/AI/manual integration tests.
 */
export function reachableStructureCells(fixture, cells) {
  const { descriptor: d, context } = fixture;
  const raw = (x, y, z) =>
    cells.get(cellKey(x, y, z)) ?? naturalCell(context, x, y, z);
  const shapeCache = new Map();
  const shapeAt = (x, y, z) => {
    const key = cellKey(x, y, z);
    if (shapeCache.has(key)) return shapeCache.get(key);
    const value = registeredCell(raw(x, y, z));
    const kind = BLOCKS[value.id].shape;
    if (["door", "fence_gate", "trapdoor"].includes(kind))
      value.state |= S.OPEN;
    const shape = resolveShape(value, (dx, dy, dz) =>
      registeredCell(raw(x + dx, y + dy, z + dz))
    );
    shapeCache.set(key, shape);
    return shape;
  };
  const intersectsBody = (box, height) =>
    box[0] < 0.8 &&
    box[3] > 0.2 &&
    box[2] < 0.8 &&
    box[5] > 0.2 &&
    box[1] < height &&
    box[4] > 0;
  const wetOrLadder = (x, y, z) => {
    const shape = shapeAt(x, y, z);
    return shape.fluid === FLUID.WATER_SOURCE || shape.climbable;
  };
  const standing = new Map();
  const canStand = (x, y, z, exterior = false) => {
    if (
      (!exterior &&
        (!insideStructureBounds(d.bounds, x, y, z) ||
          y + 1 >= d.bounds.maxY)) ||
      y < context.spec.minY ||
      y + 1 >= context.spec.maxY
    )
      return false;
    const key = cellKey(x, y, z);
    if (standing.has(key)) return standing.get(key);
    const below = shapeAt(x, y - 1, z);
    const floor = below.support.some(
      (box) => box[4] === 1 && intersectsBody(box, 1)
    );
    const clear =
      !shapeAt(x, y, z).collision.some((box) => intersectsBody(box, 1)) &&
      !shapeAt(x, y + 1, z).collision.some((box) => intersectsBody(box, 0.8));
    const valid = clear && (floor || wetOrLadder(x, y, z));
    standing.set(key, valid);
    return valid;
  };
  assert.ok(d.entries.length > 0, `${d.variant} declares an entry`);
  for (const entry of d.entries)
    assert.ok(
      canStand(entry.x, entry.y, entry.z),
      `${d.variant} entry ${cellKey(entry.x, entry.y, entry.z)} is usable`
    );
  const entry = d.entries[0];
  const [ex, ez] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ][entry.facing];
  assert.ok(
    [0, 1, -1].some((dy) =>
      canStand(entry.x - ex, entry.y + dy, entry.z - ez, true)
    ),
    `${d.variant} first entry connects to an exterior standing cell`
  );
  const seen = new Set([cellKey(entry.x, entry.y, entry.z)]);
  const queue = [[entry.x, entry.y, entry.z]];
  for (let index = 0; index < queue.length; index++) {
    const [x, y, z] = queue[index];
    const neighbors = [];
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      for (const dy of [0, 1, -1]) neighbors.push([x + dx, y + dy, z + dz]);
    if (wetOrLadder(x, y, z))
      for (const dy of [-1, 1]) neighbors.push([x, y + dy, z]);
    for (const [nx, ny, nz] of neighbors) {
      const key = cellKey(nx, ny, nz);
      if (!seen.has(key) && canStand(nx, ny, nz)) {
        seen.add(key);
        queue.push([nx, ny, nz]);
      }
    }
  }
  return seen;
}
