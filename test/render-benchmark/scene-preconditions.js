import * as THREE from "three";
import { BLOCK } from "../../src/blocks.js";
import { raycast } from "../../src/raycast.js";
import { cameraRegionGate } from "./scenes.js";

const leaves = new Set(Object.entries(BLOCK).filter(([name]) =>
  name === "LEAVES" || name.endsWith("_LEAVES")).map(([, id]) => id));

// Native INPUT scene qualification, independent of renderer readiness. Counts
// exposed cell candidates inside the actual camera frustum, not loaded totals.
export function cameraRegionProfile(world, camera, limits) {
  const started = performance.now(), origin = camera.position;
  camera.updateMatrixWorld(true);
  const buckets = Object.fromEntries(["water", "foliage"].map(name => [name, {
    cameraSurfaceCells: 0, columnKeys: new Set(), candidates: [], lineOfSightWitnesses: [],
  }]));
  let neighborUnknownColumns = 0;
  for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
    const cx = Math.floor(origin.x / 16) + dx, cz = Math.floor(origin.z / 16) + dz;
    if (!world.chunks.has(`${cx},${cz}`)) neighborUnknownColumns++;
  }
  for (const [key, chunk] of world.chunks) {
    const [cx, cz] = key.split(",").map(Number);
    if (!chunk.blocks || Math.abs(cx * 16 + 8 - origin.x) > limits.maxDistance + 16 ||
        Math.abs(cz * 16 + 8 - origin.z) > limits.maxDistance + 16) continue;
    for (let i = 0; i < chunk.blocks.length; i++) {
      const id = chunk.blocks[i], type = id === BLOCK.WATER ? "water" : leaves.has(id) ? "foliage" : null;
      if (!type) continue;
      const x = cx * 16 + i % 16, z = cz * 16 + Math.floor(i / 16) % 16;
      const y = world.spec.minY + Math.floor(i / 256);
      if (type === "water" ? world.get(x, y + 1, z) !== BLOCK.AIR :
          ![[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(
            ([dx, dy, dz]) => world.get(x + dx, y + dy, z + dz) === BLOCK.AIR)) continue;
      const point = new THREE.Vector3(x + 0.5, y + (type === "water" ? 0.88 : 0.5), z + 0.5);
      const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const ndc = point.clone().project(camera), distance = point.distanceTo(origin);
      if (depth < limits.minDepth || distance > limits.maxDistance ||
          Math.abs(ndc.x) > 0.95 || Math.abs(ndc.y) > 0.95 || Math.abs(ndc.z) > 1) continue;
      const b = buckets[type]; b.cameraSurfaceCells++; b.columnKeys.add(key);
      b.candidates.push({ cell: [x, y, z], point: point.toArray(), distance });
    }
  }
  for (const bucket of Object.values(buckets)) {
    // Deterministic finite visibility audit: up to 48 spatially distributed
    // candidates. Opaque native occluders are independent of LOD geometry.
    const candidates = bucket.candidates;
    for (let i = 0; i < Math.min(48, candidates.length); i++) {
      const c = candidates[Math.floor(i * candidates.length / Math.min(48, candidates.length))];
      const point = new THREE.Vector3(...c.point), direction = point.clone().sub(origin).normalize();
      let known = true;
      for (let d = 0; d < c.distance; d += 0.5) {
        const p = origin.clone().addScaledVector(direction, d);
        if (!world.isLoaded(p.x, p.z)) { known = false; break; }
      }
      if (!known) continue;
      const hit = raycast(world, origin, direction, Math.max(0, c.distance - 0.8), { channel: "occlusion" });
      if (!hit) bucket.lineOfSightWitnesses.push(c);
      if (bucket.lineOfSightWitnesses.length >= 4) break;
    }
    bucket.columns = bucket.columnKeys.size;
    bucket.columnKeys = [...bucket.columnKeys].sort();
    delete bucket.candidates;
  }
  const profile = { ...buckets, camera: { position: origin.toArray(), matrixWorld: camera.matrixWorld.toArray(),
    projection: camera.projectionMatrix.toArray() }, neighborUnknownColumns,
    limits, observerMs: performance.now() - started,
    scope: "exposed native cells in camera frustum plus known opaque-terrain LOS witnesses; not final pixel visibility/alpha qualification" };
  profile.passed = cameraRegionGate(profile, limits);
  return profile;
}
