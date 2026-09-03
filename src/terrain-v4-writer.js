import { defaultFluidFor, isValidCell } from "./block-state.js";
import { BLOCK as B, BLOCKS } from "./blocks.js";
import { V4_MAX_XZ, V4_MIN_XZ, v4InBounds } from "./terrain-v4-config.js";

const soft = (id) =>
  id === B.AIR ||
  BLOCKS[id]?.shape === "cross" ||
  BLOCKS[id]?.texture === "leaves";

function replaceable(id, mode) {
  if (mode === "replace") return true;
  if (mode === "air") return id === B.AIR;
  if (mode === "water") return id === B.WATER || BLOCKS[id]?.aquatic === true;
  if (mode === "wet") return soft(id) || id === B.WATER;
  if (mode === "ice")
    return (
      soft(id) ||
      [B.WATER, B.ICE, B.PACKED_ICE, B.BLUE_ICE, B.SNOW_BLOCK].includes(id)
    );
  if (mode !== "soft")
    throw new RangeError(`Unknown terrain write mode: ${mode}`);
  return soft(id);
}

export function forEachV4Owner(bounds, spacing, reach, visit) {
  const minGX = Math.max(
    Math.floor(V4_MIN_XZ / spacing),
    Math.floor((bounds.minX - reach) / spacing)
  );
  const minGZ = Math.max(
    Math.floor(V4_MIN_XZ / spacing),
    Math.floor((bounds.minZ - reach) / spacing)
  );
  const maxGX = Math.min(
    Math.floor((V4_MAX_XZ - 1) / spacing),
    Math.floor((bounds.minX + bounds.width - 1 + reach) / spacing)
  );
  const maxGZ = Math.min(
    Math.floor((V4_MAX_XZ - 1) / spacing),
    Math.floor((bounds.minZ + bounds.depth - 1 + reach) / spacing)
  );
  // Relative order of overlapping owners is independent of the clipped region.
  for (let gz = minGZ; gz <= maxGZ; gz++)
    for (let gx = minGX; gx <= maxGX; gx++) visit(gx, gz);
}

/**
 * Regions and chunks share one clipped writer. Region auxiliary sections carry
 * cx/cz as well as sy; a 16x16 aligned chunk drops cx/cz from its section entries
 * when exported to the worker contract. Every auxiliary plane is 4096 cells.
 */
export function createV4Writer({ minX, minZ, width, depth, spec, counters }) {
  const layer = width * depth;
  const blocks = new Uint16Array(layer * (spec.maxY - spec.minY));
  const sections = new Map();
  const inside = (x, y, z) =>
    Number.isSafeInteger(x) &&
    Number.isSafeInteger(y) &&
    Number.isSafeInteger(z) &&
    x >= minX &&
    x < minX + width &&
    z >= minZ &&
    z < minZ + depth &&
    y >= spec.minY &&
    y < spec.maxY &&
    v4InBounds(x, z);
  const at = (x, y, z) =>
    (y - spec.minY) * layer + (z - minZ) * width + x - minX;

  function sectionDefault(cx, sy, cz, local) {
    const x = cx * 16 + (local % 16);
    const z = cz * 16 + (Math.floor(local / 16) % 16);
    const y = sy * 16 + Math.floor(local / 256);
    return inside(x, y, z) ? defaultFluidFor(blocks[at(x, y, z)]) : 0;
  }

  function set(x, y, z, id, state = 0, fluid = defaultFluidFor(id)) {
    if (!inside(x, y, z)) return false;
    if (!isValidCell({ id, state, fluid }))
      throw new RangeError(
        `Invalid v4 terrain cell ${id}/${state}/${fluid} at ${x},${y},${z}`
      );
    const index = at(x, y, z);
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const sy = Math.floor(y / 16);
    const key = `${cx},${cz},${sy}`;
    let section = sections.get(key);
    if (!section && (state !== 0 || fluid !== defaultFluidFor(id))) {
      section = { cx, cz, sy };
      sections.set(key, section);
    }
    if (section) {
      const local = (y - sy * 16) * 256 + (z - cz * 16) * 16 + x - cx * 16;
      if (!section.states && state !== 0)
        section.states = new Uint16Array(4096);
      if (!section.fluids && fluid !== defaultFluidFor(id)) {
        section.fluids = new Uint8Array(4096);
        // Initialize every existing source/aquatic cell before the first edit.
        for (let i = 0; i < 4096; i++)
          section.fluids[i] = sectionDefault(cx, sy, cz, i);
      }
      if (section.states) section.states[local] = state;
      if (section.fluids) section.fluids[local] = fluid;
    }
    blocks[index] = id;
    return true;
  }

  function put(
    x,
    y,
    z,
    id,
    { state = 0, fluid = defaultFluidFor(id), mode = "soft" } = {}
  ) {
    counters.featureWrites++;
    if (!inside(x, y, z) || !replaceable(blocks[at(x, y, z)], mode))
      return false;
    return set(x, y, z, id, state, fluid);
  }

  function finish(chunk = false) {
    const planes = [];
    for (const { cx, cz, sy, states, fluids } of sections.values()) {
      const keepStates = states?.some((state) => state !== 0);
      const keepFluids = fluids?.some(
        (fluid, local) => fluid !== sectionDefault(cx, sy, cz, local)
      );
      if (!keepStates && !keepFluids) continue;
      planes.push({
        ...(chunk ? {} : { cx, cz }),
        sy,
        ...(keepStates ? { states } : {}),
        ...(keepFluids ? { fluids } : {}),
      });
    }
    planes.sort(
      (a, b) =>
        a.sy - b.sy || (a.cz ?? 0) - (b.cz ?? 0) || (a.cx ?? 0) - (b.cx ?? 0)
    );
    return {
      blocks,
      minY: spec.minY,
      maxY: spec.maxY,
      encoding: "u16",
      ...(planes.length ? { sections: planes } : {}),
    };
  }

  return {
    blocks,
    layer,
    at,
    inside,
    set,
    put,
    finish,
    get: (x, y, z) => (inside(x, y, z) ? blocks[at(x, y, z)] : null),
  };
}

/** Diagnostic/test reader for the wider-region API; no chunk generation. */
export function readV4RegionCell(region, x, y, z) {
  if (
    ![x, y, z].every(Number.isSafeInteger) ||
    x < region.minX ||
    x >= region.minX + region.width ||
    z < region.minZ ||
    z >= region.minZ + region.depth ||
    y < region.minY ||
    y >= region.maxY
  )
    return null;
  const index =
    (y - region.minY) * region.width * region.depth +
    (z - region.minZ) * region.width +
    x -
    region.minX;
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const sy = Math.floor(y / 16);
  const local = (y - sy * 16) * 256 + (z - cz * 16) * 16 + x - cx * 16;
  const section = region.sections?.find(
    (entry) => entry.cx === cx && entry.cz === cz && entry.sy === sy
  );
  const id = region.blocks[index];
  return {
    id,
    state: section?.states?.[local] ?? 0,
    fluid: section?.fluids?.[local] ?? defaultFluidFor(id),
  };
}
