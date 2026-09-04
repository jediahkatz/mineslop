import { BLOCK, isSolid } from "../../src/blocks.js";
import { boatSeat } from "../../src/boat-definitions.js";
import {
  boatBox,
  boatPlacementPosition,
  boatRiderPathClear,
  boatWaterState,
  boatWaterTarget,
} from "../../src/boat-physics.js";
import { boxCollides } from "../../src/collision.js";
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH } from "../../src/player.js";
import { WATER_LEVEL } from "../../src/terrain.js";
import { WOOD_FAMILIES } from "../../src/wood-content.js";
import { raycast } from "../../src/world.js";

// These planners only query already admitted voxels. In particular, getSpawn,
// ensureArea, updateStreaming and generator.generateChunk are never called.
// A failed route is a test failure, not permission to replace the landscape.
export const PLAN_RADIUS = 64;
export const MAX_ROUTE_NODES = 512;
const half = PLAYER_WIDTH / 2;
const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const ground = new Set([
  BLOCK.GRASS, BLOCK.DIRT, BLOCK.PODZOL, BLOCK.MYCELIUM, BLOCK.MOSS,
  BLOCK.SAND, BLOCK.CLAY, BLOCK.STONE, BLOCK.SNOW, BLOCK.SNOW_BLOCK,
]);
const families = WOOD_FAMILIES.filter((wood) => wood.boat && wood.plankCount === 4);
const key = (x, z) => `${x},${z}`;
export const cellKey = ({ x, y, z }) => `${x},${y},${z}`;
export const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const center = ({ x, y, z }) => ({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });

function validate(world, origin, radius) {
  if (world.generatorVersion !== 3 || world.dimension !== "overworld")
    throw new Error("This acceptance route requires native default v3 Overworld");
  if (![origin?.x, origin?.y, origin?.z].every(Number.isFinite))
    throw new TypeError("Route origin must be the observed finite player pose");
  if (!Number.isInteger(radius) || radius < 2 || radius > PLAN_RADIUS)
    throw new RangeError(`Scan radius must be 2–${PLAN_RADIUS}`);
}

function air(world, x, y, z) {
  if (!world.isLoaded(x, z)) return false;
  const id = world.get(x, y, z);
  return !isSolid(id) && id !== BLOCK.WATER && id !== BLOCK.LAVA;
}

function columnNode(world, x, z) {
  if (!world.isLoaded(x, z)) return null;
  // The ground scan skips trunks/leaves but the subsequent body test does not.
  for (let y = world.maxY - 3; y >= Math.max(world.minY, WATER_LEVEL); y--) {
    if (!ground.has(world.get(x, y, z))) continue;
    if (!air(world, x, y + 1, z) || !air(world, x, y + 2, z)) return null;
    return { x: x + 0.5, y: y + 1, z: z + 0.5 };
  }
  return null;
}

function clearEdge(world, a, b) {
  if (Math.abs(a.y - b.y) > 1) return false;
  // Upward full-block transitions require a real Space jump. Reserve its
  // headroom here; flat/downhill edges never assume Minecraft-style auto-hop.
  const bottom = Math.max(a.y, b.y) + 0.002;
  const top = b.y > a.y ? a.y + PLAYER_HEIGHT + 1.35 : bottom + PLAYER_HEIGHT;
  return !boxCollides(world, [
    Math.min(a.x, b.x) - half, bottom, Math.min(a.z, b.z) - half,
    Math.max(a.x, b.x) + half, top, Math.max(a.z, b.z) + half,
  ]);
}

export function scanReachable(world, origin, { radius = PLAN_RADIUS } = {}) {
  validate(world, origin, radius);
  const nodes = new Map();
  const ox = Math.floor(origin.x), oz = Math.floor(origin.z);
  let loadedColumns = 0;
  for (let z = oz - radius; z <= oz + radius; z++) {
    for (let x = ox - radius; x <= ox + radius; x++) {
      if (!world.isLoaded(x, z)) continue;
      loadedColumns++;
      const node = columnNode(world, x, z);
      if (node) nodes.set(key(x, z), node);
    }
  }
  const startKey = key(ox, oz), start = nodes.get(startKey);
  if (!start || Math.abs(start.y - origin.y) > 0.12)
    throw new Error("Native player is not standing on a scanned dry ground cell");
  const visited = new Map([[startKey, { previous: null, distance: 0 }]]);
  const queue = [startKey];
  for (let index = 0; index < queue.length; index++) {
    const fromKey = queue[index], from = nodes.get(fromKey);
    for (const [dx, dz] of directions) {
      const toKey = key(Math.floor(from.x) + dx, Math.floor(from.z) + dz);
      if (visited.has(toKey)) continue;
      const to = nodes.get(toKey);
      if (!to || !clearEdge(world, from, to)) continue;
      visited.set(toKey, {
        previous: fromKey,
        distance: visited.get(fromKey).distance + 1,
      });
      queue.push(toKey);
    }
  }
  return { nodes, visited, startKey, loadedColumns, radius };
}

function pathTo(scan, destination) {
  let next = key(Math.floor(destination.x), Math.floor(destination.z));
  if (!scan.visited.has(next)) return null;
  const route = [];
  while (next !== null) {
    route.push({ ...scan.nodes.get(next) });
    next = scan.visited.get(next).previous;
    if (route.length > MAX_ROUTE_NODES)
      throw new Error(`Native walking route exceeds ${MAX_ROUTE_NODES} cells`);
  }
  return route.reverse();
}

function sight(world, eye, point, target) {
  const vector = { x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z };
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length > 4.4) return false;
  const hit = raycast(world, eye, vector, 4.5);
  return hit !== null && cellKey(hit) === cellKey(target);
}

function provenance(world, origin, scan) {
  return {
    seed: world.seed,
    generatorVersion: world.generatorVersion,
    dimension: world.dimension,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    source: "bounded read-only scan of the actual admitted World",
    radius: scan.radius,
    loadedColumns: scan.loadedColumns,
    reachableColumns: scan.visited.size,
    loadedChunks: world.chunks.size,
  };
}

export function planTreeRoute(world, origin, options) {
  if (world.edits.size !== 0)
    throw new Error("The acquisition route must begin in an unedited native world");
  const scan = scanReachable(world, origin, options);
  const candidates = [];
  for (const [approachKey, visit] of scan.visited) {
    const approach = scan.nodes.get(approachKey);
    const eye = { ...approach, y: approach.y + EYE_HEIGHT };
    for (const [dx, dz] of directions) {
      for (const distance of [2, 3]) {
        const x = Math.floor(approach.x) + dx * distance;
        const y = approach.y, z = Math.floor(approach.z) + dz * distance;
        if (!world.isLoaded(x, z) || !ground.has(world.get(x, y - 1, z))) continue;
        const family = families.find(({ source }) => source === world.get(x, y, z));
        if (!family) continue;
        const trunk = [2, 1, 0].map((dy) => ({ x, y: y + dy, z, id: family.source }));
        if (!trunk.every((cell) =>
          world.get(cell.x, cell.y, cell.z) === family.source &&
          sight(world, eye, center(cell), cell)
        )) continue;
        let corridor = true;
        for (let step = 1; step < distance; step++) {
          const cell = scan.nodes.get(key(
            Math.floor(approach.x) + dx * step,
            Math.floor(approach.z) + dz * step,
          ));
          if (!cell || cell.y !== y) corridor = false;
        }
        if (!corridor) continue;
        // Only the three cells the test will actually mine are discounted when
        // checking the last pickup step. This projection never touches World.
        const removed = new Set(trunk.map(cellKey));
        for (let py = y; py < y + PLAYER_HEIGHT; py++)
          if (!removed.has(`${x},${py},${z}`) && !air(world, x, py, z)) corridor = false;
        if (!corridor) continue;
        candidates.push({
          approach, trunk, family,
          pickup: { x: x + 0.5, y, z: z + 0.5 },
          distance: visit.distance,
        });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance ||
    horizontal(origin, a.pickup) - horizontal(origin, b.pickup));
  const chosen = candidates[0];
  if (!chosen) throw new Error("No reachable native three-matching-log trunk in the bounded scan");
  return {
    ...chosen,
    route: pathTo(scan, chosen.approach),
    provenance: provenance(world, origin, scan),
  };
}

function openWaterLane(world, boat, dx, dz) {
  // Room for a short forward/reverse/steering acceptance excursion, not an
  // assertion that an unobserved ocean beyond this finite lane is navigable.
  for (let forward = 0; forward <= 9; forward++) {
    for (let side = -2; side <= 2; side++) {
      const candidate = {
        x: boat.x + dx * forward + dz * side,
        y: boat.y,
        z: boat.z + dz * forward - dx * side,
      };
      const water = boatWaterState(world, candidate);
      if (!water || water.wet !== 1 || water.submerged ||
        Math.abs(water.surfaceY - (boat.y + 0.3)) > 0.02 ||
        boxCollides(world, boatBox(candidate, true))) return false;
    }
  }
  return true;
}

export function planShoreRoute(world, origin, options) {
  const scan = scanReachable(world, origin, options);
  const shoreNodes = [...scan.visited]
    .map(([nodeKey, visit]) => ({ node: scan.nodes.get(nodeKey), distance: visit.distance }))
    .filter(({ node }) => node.y <= WATER_LEVEL + 3)
    .sort((a, b) => a.distance - b.distance);
  for (const { node: approach } of shoreNodes) {
    const eye = { ...approach, y: approach.y + EYE_HEIGHT };
    for (const [dx, dz] of directions) {
      const waterAim = {
        x: approach.x + dx * 3.6, y: WATER_LEVEL + 0.92,
        z: approach.z + dz * 3.6,
      };
      const vector = {
        x: waterAim.x - eye.x, y: waterAim.y - eye.y, z: waterAim.z - eye.z,
      };
      const water = boatWaterTarget(world, eye, vector, 6);
      if (!water) continue;
      const boat = boatPlacementPosition(world, water.point);
      if (!boat || !openWaterLane(world, boat, dx, dz)) continue;
      const yaw = Math.atan2(-dx, -dz);
      if (!boatRiderPathClear(world, approach, boatSeat({ ...boat, yaw }))) continue;
      for (const [tx, tz] of [[dz, -dx], [-dz, dx], [-dx, -dz]]) {
        const x = Math.floor(approach.x) + tx * 2;
        const z = Math.floor(approach.z) + tz * 2;
        const standing = scan.nodes.get(key(x, z));
        if (!standing || Math.abs(standing.y - approach.y) > 1) continue;
        const support = { x, y: standing.y - 1, z, id: world.get(x, standing.y - 1, z) };
        const table = { x, y: standing.y, z, id: BLOCK.CRAFTING_TABLE };
        if (world.get(x, table.y, z) !== BLOCK.AIR) continue;
        const groundAim = { x: x + 0.5, y: standing.y - 0.02, z: z + 0.5 };
        if (!sight(world, eye, groundAim, support)) continue;
        return {
          approach, table, support, groundAim, waterAim,
          launch: { ...boat, yaw },
          direction: { x: dx, z: dz },
          route: pathTo(scan, approach),
          provenance: provenance(world, origin, scan),
        };
      }
    }
  }
  throw new Error("No reachable shore with table support and a clear native 9-block boating lane");
}

export function planWalkingRoute(world, origin, destination, options) {
  const scan = scanReachable(world, origin, options);
  const route = pathTo(scan, destination);
  if (!route) throw new Error("Destination is outside the bounded reachable native terrain");
  return { route, provenance: provenance(world, origin, scan) };
}
