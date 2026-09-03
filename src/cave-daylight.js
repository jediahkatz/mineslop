import { MathUtils } from "three";
import {
  columnLoaded,
  geometryEpoch,
  readGeometryCell,
  SOLID_CELL,
} from "./geometry-world.js";
import { raycast } from "./raycast.js";

export const CAVE_DAYLIGHT_LIMITS = Object.freeze({
  lightRadius: 16,
  sightRadius: 96,
  sources: 4,
  directions: 24,
  step: 2,
  refinement: 4,
});

const DIRECTIONS = [];
for (const slope of [0, 0.3, 0.6])
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    DIRECTIONS.push({ x: Math.cos(angle), y: slope, z: Math.sin(angle) });
  }
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const finitePoint = (point) =>
  point && [point.x, point.y, point.z].every(Number.isFinite);

export function entranceLightWeight(value) {
  return Number.isFinite(value)
    ? 1 - MathUtils.smoothstep(value, 0, CAVE_DAYLIGHT_LIMITS.lightRadius)
    : 0;
}

/**
 * Daylight and an outdoor view have different ranges. A distant visible mouth
 * may keep its sky/terrain without lighting the room around the camera.
 * Retained points are world-space observations, revalidated every frame, not
 * a time-based grace period or a remembered biome/category.
 */
export class CaveDaylight {
  constructor(columns) {
    this.columns = columns;
    this.anchors = [];
  }

  sample(world, position, forward) {
    const identityChanged =
      this.world !== world ||
      this.epoch !== geometryEpoch(world) ||
      this.dimension !== world.dimension ||
      this.generator !== world.generator;
    if (identityChanged) this.anchors = [];
    this.world = world;
    this.epoch = geometryEpoch(world);
    this.dimension = world.dimension;
    this.generator = world.generator;
    const result = {
      known: false,
      directSky: false,
      exposure: 0,
      skyVisible: false,
      apertureDistance: null,
      sources: [],
      rays: 0,
    };
    if (world.dimension !== "overworld" || !finitePoint(position)) return result;
    const { minY, maxY } = this.columns.spec;
    result.known =
      columnLoaded(world, position.x, position.z) &&
      position.y >= minY &&
      (position.y >= maxY ||
        readGeometryCell(world, Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)) !== null);
    if (!result.known) {
      this.anchors = [];
      return result;
    }

    // Occlusion rays normally skip null cells. Here an unknown cell must stop
    // a daylight path, even if its far endpoint is in another loaded column.
    const query = {
      spec: this.columns.spec,
      isLoaded: () => true,
      getCell: (x, y, z) => readGeometryCell(world, x, y, z) ?? SOLID_CELL,
    };
    const hitAt = (direction, length) => {
      result.rays++;
      return raycast(query, position, direction, length, { channel: "occlusion" });
    };
    const valid = (point) => {
      const length = distance(position, point);
      if (length > CAVE_DAYLIGHT_LIMITS.sightRadius || !this.columns.open(point))
        return false;
      return length < 0.001 || !hitAt(
        { x: point.x - position.x, y: point.y - position.y, z: point.z - position.z },
        length
      );
    };
    const candidates = this.anchors.filter(valid);
    result.directSky = this.columns.open(position);
    if (result.directSky) {
      candidates.unshift({ x: position.x, y: position.y, z: position.z });
    } else {
      const search = (direction, limit) => {
        if (!finitePoint(direction)) return;
        const length = Math.hypot(direction.x, direction.y, direction.z);
        if (!length) return;
        const unit = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
        const hit = hitAt(unit, limit);
        const end = Math.min(limit, hit ? Math.max(0, hit.distance - 0.001) : limit);
        const pointAt = (along) => ({
          x: position.x + unit.x * along,
          y: position.y + unit.y * along,
          z: position.z + unit.z * along,
        });
        let previous = 0;
        for (let step = CAVE_DAYLIGHT_LIMITS.step; previous < end; step += CAVE_DAYLIGHT_LIMITS.step) {
          const along = Math.min(step, end);
          if (this.columns.open(pointAt(along))) {
            // Spatial refinement keeps the fade tied to the actual opening,
            // not to the coarse search stations or the HUD refresh cadence.
            let low = previous, high = along;
            for (let i = 0; i < CAVE_DAYLIGHT_LIMITS.refinement; i++) {
              const middle = (low + high) / 2;
              if (this.columns.open(pointAt(middle))) high = middle;
              else low = middle;
            }
            candidates.push(pointAt(high));
            return;
          }
          previous = along;
        }
      };
      // Reuse a proved aperture for long sight lines; still look for nearer
      // light when another opening approaches. Cold starts also search outward.
      const range = candidates.length
        ? CAVE_DAYLIGHT_LIMITS.lightRadius
        : CAVE_DAYLIGHT_LIMITS.sightRadius;
      for (const direction of DIRECTIONS) search(direction, range);
      if (!candidates.length) search(forward, CAVE_DAYLIGHT_LIMITS.sightRadius);
    }
    candidates.sort((a, b) => distance(position, a) - distance(position, b));
    this.anchors = [];
    for (const point of candidates) {
      if (this.anchors.some((old) => distance(old, point) < 0.5)) continue;
      this.anchors.push(point);
      if (this.anchors.length === CAVE_DAYLIGHT_LIMITS.sources) break;
    }
    if (this.anchors.length) {
      result.skyVisible = true;
      result.apertureDistance = distance(position, this.anchors[0]);
      result.exposure = result.directSky ? 1 : entranceLightWeight(result.apertureDistance);
      result.sources = this.anchors.filter(
        (point) => distance(position, point) < CAVE_DAYLIGHT_LIMITS.lightRadius
      );
    }
    return result;
  }
}
