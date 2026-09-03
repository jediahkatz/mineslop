import { getBiomeById } from "./biomes.js";
import { BLOCK as B } from "./blocks.js";
import { clamp, hash, mix, smooth } from "./noise.js";
import {
  mergeCaveIntervals,
  sampleCaveIntervals,
} from "./terrain-cave-field.js";

export const CAVE_CELL_SIZE = 112;
const CACHE_LIMIT = 512;
const EMPTY = Object.freeze([]);
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

// Choose a monotone, single-step descent whose support is already rock. A
// straight interpolated ramp can cross a cavern roof; filling everything below
// it creates a giant plinth. Instead, descend earlier/later where rock exists,
// or reject this candidate. The small height DP only runs during cached planning.
function fitRockRoute(path, sections, fromY, toY) {
  const length = path.length - 1;
  let costs = new Float64Array(fromY + 1).fill(Infinity);
  costs[fromY] = 0;
  const parents = path.map(() => new Int16Array(fromY + 1).fill(-1));
  for (let s = 1; s <= length; s++) {
    const next = new Float64Array(fromY + 1).fill(Infinity);
    const target = mix(fromY, toY, s / length);
    for (let y = toY; y <= fromY; y++) {
      const previous = costs[y] <= (costs[y + 1] ?? Infinity) ? y : y + 1;
      if (
        !Number.isFinite(costs[previous]) ||
        !sections[s].every(
          (col) =>
            col.top >= y - 1 &&
            (s <= length * 0.65 || col.top >= y + 7) &&
            col.caves.every(([low, high]) => y - 1 < low || y - 1 > high)
        )
      )
        continue;
      next[y] = costs[previous] + (y - target) ** 2;
      parents[s][y] = previous;
    }
    costs = next;
  }
  if (!Number.isFinite(costs[toY])) return false;
  let y = toY;
  for (let s = length; s > 0; s--) {
    path[s].low = y;
    y = parents[s][y];
  }
  path[0].low = fromY;
  return true;
}

// `surface` must sample only uncarved height/climate. Calling the full terrain
// column here would recurse while that column is still constructing its caves.
export function createCaveGenerator({ salt, surface, waterLevel, validXZ }) {
  const cells = new Map();
  const dry = (x, z) => {
    if (!validXZ(x, z)) return null;
    const col = surface(x, z);
    if (
      col.top < waterLevel + 4 ||
      col.sulfur ||
      ["ocean", "river", "shore", "swamp"].includes(
        getBiomeById(col.id).category
      )
    )
      return null;
    return col;
  };

  function plan(gx, gz) {
    if (hash(gx, gz, salt ^ 42737) > 0.78) return EMPTY;
    const midX =
      gx * CAVE_CELL_SIZE + 52 + Math.floor(hash(gx, gz, salt ^ 19379) * 9);
    const midZ =
      gz * CAVE_CELL_SIZE + 52 + Math.floor(hash(gx, gz, salt ^ 31397) * 9);
    const baseLength = 60 + Math.floor(hash(gx, gz, salt ^ 62861) * 8) * 2;
    const kind = hash(gx, gz, salt ^ 43573) < 0.17 ? "ravine" : "cave";
    const bend = (hash(gx, gz, salt ^ 38543) - 0.5) * 5;
    const radius =
      (kind === "ravine" ? 2.5 : 3.2) + hash(gx, gz, salt ^ 24379) * 0.7;
    const candidates = [];
    // Smaller v3 caverns need a few nearby endpoint samples, not the old
    // assumption that almost every column belongs to one upper chamber.
    for (const offset of [0, -8, 8, -16, 16]) {
      const length = baseLength + offset;
      for (const [dx, dz] of DIRECTIONS) {
        const x = midX - (dx * length) / 2;
        const z = midZ - (dz * length) / 2;
        const endX = x + dx * length;
        const endZ = z + dz * length;
        const mouth = dry(x, z);
        const end = dry(endX, endZ);
        if (!mouth || !end) continue;
        const chamber = sampleCaveIntervals(
          endX,
          endZ,
          end.top,
          salt,
          waterLevel
        ).findLast(([low, high]) => high - low >= 4 && high >= 16);
        if (!chamber) continue;
        const [low, high] = chamber;
        const drop = mouth.top + 1 - low;
        if (drop < 7 || drop > length * 0.65) continue;
        candidates.push({
          length,
          direction: { x: dx, z: dz },
          mouth: { x, y: mouth.top + 1, z },
          chamber: { low, high, x: endX, z: endZ },
          score:
            Math.min(14, end.top - mouth.top) * 2 -
            drop * 0.025 -
            Math.abs(offset) * 0.1,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const candidate of candidates) {
      const { mouth, chamber, direction, length } = candidate;
      const path = [];
      const sections = [];
      let safe = true;
      for (let s = 0; s <= length; s++) {
        const curve = Math.round(Math.sin((s / length) * Math.PI) * bend);
        const point = {
          x: mouth.x + direction.x * s - direction.z * curve,
          z: mouth.z + direction.z * s + direction.x * curve,
          radius: radius + Math.sin(s * 0.19 + bend) * 0.3,
        };
        const reach = Math.ceil(point.radius) + 2;
        for (let offset = -reach; offset <= reach; offset++) {
          const col = dry(
            point.x - direction.z * offset,
            point.z + direction.x * offset
          );
          // Full dry banks, including the apron, prevent one-block water leaks.
          if (!col) {
            safe = false;
            break;
          }
        }
        if (!safe) break;
        const support = [point];
        if (s) {
          const previous = path[s - 1];
          // At a bend, include the cardinal intermediate cell, so the real
          // player can turn the corner rather than jump diagonally over a pit.
          support.push({
            x: previous.x + direction.x,
            z: previous.z + direction.z,
          });
        }
        sections.push(
          support.map(({ x, z }) => {
            const col = surface(x, z);
            return {
              top: col.top,
              caves: sampleCaveIntervals(x, z, col.top, salt, waterLevel),
            };
          })
        );
        path.push(point);
      }
      if (!safe || !fitRockRoute(path, sections, mouth.y, chamber.low))
        continue;
      const bounds = {
        minX: Math.min(...path.map((p) => p.x - Math.ceil(p.radius))),
        maxX: Math.max(...path.map((p) => p.x + Math.ceil(p.radius))),
        minZ: Math.min(...path.map((p) => p.z - Math.ceil(p.radius))),
        maxZ: Math.max(...path.map((p) => p.z + Math.ceil(p.radius))),
      };
      // Features fit inside their owner cell with a solid margin. They cross
      // chunk and biome-region boundaries, but cannot intersect another entry's
      // ramp at an incompatible height or depend on generation order.
      return Object.freeze([
        Object.freeze({
          kind,
          length,
          mouth: Object.freeze(mouth),
          chamber: Object.freeze(chamber),
          direction: Object.freeze(direction),
          path: Object.freeze(path.map((point) => Object.freeze(point))),
          bounds: Object.freeze(bounds),
        }),
      ]);
    }
    return EMPTY;
  }

  function getFeatures(gx, gz) {
    if (!Number.isSafeInteger(gx) || !Number.isSafeInteger(gz)) return EMPTY;
    const key = `${gx},${gz}`;
    if (cells.has(key)) return cells.get(key);
    const features = plan(gx, gz);
    if (cells.size >= CACHE_LIMIT) cells.delete(cells.keys().next().value);
    cells.set(key, features);
    return features;
  }

  function column(col) {
    const feature = getFeatures(
      Math.floor(col.x / CAVE_CELL_SIZE),
      Math.floor(col.z / CAVE_CELL_SIZE)
    )[0];
    if (!feature) return null;
    const { mouth, direction, length } = feature;
    const s = (col.x - mouth.x) * direction.x + (col.z - mouth.z) * direction.z;
    const point = feature.path[s];
    if (!point) return null;
    const side =
      (col.z - point.z) * direction.x - (col.x - point.x) * direction.z;
    if (Math.abs(side) >= point.radius) return null;
    const low = point.low + Math.floor(Math.abs(side) * 0.45);
    let high =
      point.low + 2 + Math.floor(Math.sqrt(1 - (side / point.radius) ** 2) * 3);
    if (feature.kind === "ravine") {
      const closing = smooth(clamp((s - length * 0.62) / 9));
      high = Math.max(high, Math.round(mix(col.top, high, closing)));
    }
    return {
      entrance: { low, high },
      surfaceOpen: low <= col.top && high >= col.top,
      caveMouth: high >= col.top - 2,
      caves: mergeCaveIntervals([...col.caves, [low, high]]),
    };
  }

  return {
    column,
    getFeatures,
    get cacheSize() {
      return cells.size;
    },
  };
}

// Remove the topsoil cap and reserve walking clearance after decoration.
// Support comes from the route planner's existing rock, never from refilling.
export function carveEntrance(id, col, y) {
  const { low, high } = col.entrance;
  if (y >= low && y <= high) return B.AIR;
  return id;
}
