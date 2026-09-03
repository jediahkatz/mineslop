import { FLUID, isSourceWater, isWaterFluid } from "./block-state.js";
import { resolveShape } from "./block-shapes.js";
import { BLOCK } from "./blocks.js";
import { fluidAtPoint } from "./collision.js";
import {
  FLUID_DIRECTIONS,
  HORIZONTAL_FLUID_DIRECTIONS,
} from "./fluid-constants.js";
import {
  canReceiveWater,
  FluidReadLimitError,
  FluidReadScope,
  isBubble,
  openFluidConnection,
  validFluidPosition,
  waterCell,
} from "./fluid-read.js";
import { columnLoaded, shapeAt } from "./geometry-world.js";

export const MAX_FLUID_SAMPLE_HEIGHT = 8;
export const MAX_FLUID_SAMPLE_RADIUS = 2;
export const MAX_FLUID_SAMPLE_CELLS = 225; // 5 x 9 x 5, including boundary cells.

const volumeHeight = (shape) => {
  let height = 0;
  for (const bounds of shape?.fluidVolume ?? [])
    height = Math.max(height, bounds[4]);
  return height;
};
const validPoint = (point) =>
  !!point &&
  [point.x, point.y, point.z].every(
    (value) => Number.isFinite(value) && Number.isSafeInteger(Math.floor(value))
  );
const bubbleName = (fluid) =>
  fluid === FLUID.BUBBLE_UP
    ? "up"
    : fluid === FLUID.BUBBLE_DOWN
      ? "down"
      : null;
const knownPoint = (world, point) => {
  const x = Math.floor(point.x),
    y = Math.floor(point.y),
    z = Math.floor(point.z);
  return !validFluidPosition(world, x, y, z) || columnLoaded(world, x, z);
};

function clear(out) {
  out.current ??= { x: 0, y: 0, z: 0 };
  out.current.x = out.current.y = out.current.z = 0;
  out.fluid = FLUID.NONE;
  out.kind = "none";
  out.immersion = out.waterImmersion = out.lavaImmersion = 0;
  out.height = out.depth = 0;
  out.surfaceY = null;
  out.bubble = null;
  out.eyeFluid = FLUID.NONE;
  out.eyeSubmerged = out.restoresAir = false;
  out.canBreathe = false;
  out.loaded = out.eyeLoaded = true;
  out.sampledCells = 0;
  out.valid = true;
  return out;
}

export function createFluidSample() {
  return clear({});
}

function hydraulicHeight(scope, x, y, z) {
  const cell = scope.get(x, y, z);
  if (!cell || !isWaterFluid(cell.fluid)) return 0;
  if (cell.id === BLOCK.WATER) return volumeHeight(scope.shape(x, y, z));
  // Clipping a source around a top slab reduces occupied water volume, not its
  // source strength. Use the shared water shape for head, real host openings
  // for connectivity, and real clipped volumes for immersion.
  return volumeHeight(
    resolveShape(waterCell(cell.fluid), (dx, dy, dz) =>
      scope.get(x + dx, y + dy, z + dz)
    )
  );
}

/** Unitless, bounded flow direction, not an entity velocity. Geometry openings
 * and resolved fluid heights supply the gradient; dry waterloggable hosts are
 * barriers, not implicit sources. Consumers supply acceleration and damping.
 */
export function fluidCurrent(world, x, y, z, out = { x: 0, y: 0, z: 0 }) {
  out.x = out.y = out.z = 0;
  if (!validFluidPosition(world, x, y, z)) return out;
  const scope = new FluidReadScope(world);
  try {
    const cell = scope.get(x, y, z);
    if (!cell || !isWaterFluid(cell.fluid)) return out;
    if (isBubble(cell.fluid)) {
      out.y = cell.fluid === FLUID.BUBBLE_UP ? 1 : -1;
      return out;
    }
    const below = scope.get(x, y - 1, z);
    if (
      canReceiveWater(below) &&
      !isSourceWater(below.fluid) &&
      openFluidConnection(scope, x, y, z, FLUID_DIRECTIONS[0])
    ) {
      out.y = -1;
      return out;
    }
    const height = hydraulicHeight(scope, x, y, z);
    for (const direction of HORIZONTAL_FLUID_DIRECTIONS) {
      const nx = x + direction.x,
        nz = z + direction.z;
      const neighbor = scope.get(nx, y, nz);
      if (
        !neighbor ||
        (!isWaterFluid(neighbor.fluid) && !canReceiveWater(neighbor))
      )
        continue;
      if (!openFluidConnection(scope, x, y, z, direction)) continue;
      let neighborHeight = hydraulicHeight(scope, nx, y, nz);
      if (!isWaterFluid(neighbor.fluid)) {
        const below = scope.get(nx, y - 1, nz);
        if (
          below &&
          isWaterFluid(below.fluid) &&
          openFluidConnection(scope, nx, y, nz, FLUID_DIRECTIONS[0])
        )
          neighborHeight = hydraulicHeight(scope, nx, y - 1, nz) - 1;
      }
      const gradient = height - neighborHeight;
      out.x += direction.x * gradient;
      out.z += direction.z * gradient;
    }
    if (cell.fluid === FLUID.WATER_FALLING) out.y = -1;
    const length = Math.hypot(out.x, out.y, out.z);
    if (length) {
      out.x /= length;
      out.y /= length;
      out.z /= length;
    }
  } catch (error) {
    if (!(error instanceof FluidReadLimitError)) throw error;
    out.x = out.y = out.z = 0;
  }
  return out;
}

function eyeInformation(out, fluid, loaded) {
  out.eyeFluid = fluid;
  out.eyeLoaded = loaded;
  out.eyeSubmerged = fluid !== FLUID.NONE;
  out.restoresAir = loaded && isBubble(fluid);
  out.canBreathe = loaded && (fluid === FLUID.NONE || out.restoresAir);
}

/** Exact point membership delegates to collision.fluidAtPoint. `height` is the
 * local surface height [0,1], `surfaceY` its world-space ordinate, and `depth`
 * the distance below that surface. A point's immersion is either zero or one.
 * Reusing `out` also reuses its current vector; all neighbor work is bounded.
 */
export function sampleFluidAtPoint(world, point, out = createFluidSample()) {
  clear(out);
  if (!validPoint(point)) {
    out.valid = false;
    return out;
  }
  const fluid = fluidAtPoint(world, point);
  out.sampledCells = 1;
  out.loaded = knownPoint(world, point);
  eyeInformation(out, fluid, out.loaded);
  if (fluid === FLUID.NONE) return out;
  const x = Math.floor(point.x),
    y = Math.floor(point.y),
    z = Math.floor(point.z);
  const resolved = shapeAt(world, x, y, z);
  const lx = point.x - x,
    ly = point.y - y,
    lz = point.z - z;
  for (const bounds of resolved.shape.fluidVolume)
    if (
      lx >= bounds[0] &&
      lx <= bounds[3] &&
      ly >= bounds[1] &&
      ly <= bounds[4] &&
      lz >= bounds[2] &&
      lz <= bounds[5]
    )
      out.height = Math.max(out.height, bounds[4]);
  out.surfaceY = y + out.height;
  out.depth = Math.max(0, out.surfaceY - point.y);
  out.fluid = fluid;
  out.kind = isWaterFluid(fluid) ? "water" : "lava";
  out.immersion = 1;
  out.waterImmersion = out.kind === "water" ? 1 : 0;
  out.lavaImmersion = out.kind === "lava" ? 1 : 0;
  out.bubble = bubbleName(fluid);
  if (out.kind === "water") fluidCurrent(world, x, y, z, out.current);
  return out;
}

/** Exact body-volume immersion from the SAME disjoint fluidVolume AABBs used
 * by collision/rendering, with a separate exact eye point for breathing.
 *
 * `position` is feet center. Queries are limited to height<=8 and radius<=2:
 * <=225 resolved cells, one eye point and one bounded current query. No chunk
 * generation, full-world iteration, growing frame cache or array of contacts.
 * `out.bubble` describes body contact; `restoresAir` requires the EYE to be in
 * either bubble direction. `height` is local to the dominant wet cell.
 * `loaded=false` marks partial/unknown coverage; unknown eye cells never grant
 * air. Callers can freeze motion until the required footprint is admitted.
 */
export function sampleFluid(
  world,
  position,
  { height = 1.8, radius = 0.3, eyeHeight = Math.min(height, 1.62) } = {},
  out = createFluidSample()
) {
  clear(out);
  const bodyVolume = 4 * radius * radius * height;
  if (
    !validPoint(position) ||
    ![height, radius, eyeHeight, bodyVolume].every(Number.isFinite) ||
    height <= 0 ||
    height > MAX_FLUID_SAMPLE_HEIGHT ||
    radius <= 0 ||
    radius > MAX_FLUID_SAMPLE_RADIUS ||
    eyeHeight < 0 ||
    eyeHeight > height ||
    bodyVolume <= 0 ||
    ![
      position.x - radius,
      position.x + radius,
      position.z - radius,
      position.z + radius,
      position.y + height,
    ].every((value) => Number.isSafeInteger(Math.floor(value)))
  ) {
    out.valid = false;
    return out;
  }
  const x0 = position.x - radius,
    x1 = position.x + radius;
  const z0 = position.z - radius,
    z1 = position.z + radius;
  const y0 = position.y,
    y1 = y0 + height;
  let water = 0,
    lava = 0,
    up = 0,
    down = 0;
  let waterTop = -Infinity,
    lavaTop = -Infinity;
  const wettestWater = { volume: 0 },
    wettestLava = { volume: 0 };
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
    for (let z = Math.floor(z0); z < Math.ceil(z1); z++)
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        out.sampledCells++;
        const resolved = shapeAt(world, x, y, z);
        if (!resolved && validFluidPosition(world, x, y, z)) out.loaded = false;
        if (!resolved || resolved.shape.fluid === FLUID.NONE) continue;
        const { shape } = resolved;
        const waterKind = isWaterFluid(shape.fluid);
        let volume = 0,
          surface = -Infinity;
        for (const bounds of shape.fluidVolume) {
          const width = Math.max(
            0,
            Math.min(x1, x + bounds[3]) - Math.max(x0, x + bounds[0])
          );
          const depth = Math.max(
            0,
            Math.min(z1, z + bounds[5]) - Math.max(z0, z + bounds[2])
          );
          const height = Math.max(
            0,
            Math.min(y1, y + bounds[4]) - Math.max(y0, y + bounds[1])
          );
          const overlap = width * depth * height;
          if (!overlap) continue;
          volume += overlap;
          surface = Math.max(surface, y + bounds[4]);
        }
        if (!volume) continue;
        if (waterKind) {
          water += volume;
          waterTop = Math.max(waterTop, surface);
        } else {
          lava += volume;
          lavaTop = Math.max(lavaTop, surface);
        }
        if (shape.fluid === FLUID.BUBBLE_UP) up += volume;
        if (shape.fluid === FLUID.BUBBLE_DOWN) down += volume;
        const best = waterKind ? wettestWater : wettestLava;
        if (volume > best.volume)
          Object.assign(best, {
            x,
            y,
            z,
            volume,
            fluid: shape.fluid,
            height: volumeHeight(shape),
          });
      }
  const eye = {
    x: position.x,
    y: position.y + eyeHeight,
    z: position.z,
  };
  eyeInformation(out, fluidAtPoint(world, eye), knownPoint(world, eye));
  out.waterImmersion = Math.min(1, water / bodyVolume);
  out.lavaImmersion = Math.min(1, lava / bodyVolume);
  out.immersion = Math.min(1, (water + lava) / bodyVolume);
  if (!water && !lava) return out;
  out.kind = water >= lava ? "water" : "lava";
  const best = out.kind === "water" ? wettestWater : wettestLava;
  out.fluid = best.fluid;
  out.height = best.height;
  out.surfaceY = out.kind === "water" ? waterTop : lavaTop;
  out.depth = Math.max(0, out.surfaceY - position.y);
  out.bubble = up || down ? (up >= down ? "up" : "down") : null;
  if (out.kind === "water") {
    fluidCurrent(world, best.x, best.y, best.z, out.current);
    if (out.bubble) {
      out.current.x = out.current.z = 0;
      out.current.y = out.bubble === "up" ? 1 : -1;
    }
  }
  return out;
}
