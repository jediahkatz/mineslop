import { geometryEpoch } from "./geometry-world.js";
import { meshRevisionCurrent, sectionYs } from "./mesh-snapshot.js";
import { sectionGeometryCovered } from "./section-pages.js";
import { WORLD_MIN, WORLD_MAX } from "./terrain.js";

function arrivalColumns(position) {
  const cx = Math.floor(position.x / 16), cz = Math.floor(position.z / 16), columns = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const x = cx + dx, z = cz + dz;
    if (x * 16 >= WORLD_MIN && x * 16 < WORLD_MAX && z * 16 >= WORLD_MIN && z * 16 < WORLD_MAX)
      columns.push(`${x},${z}`);
  }
  return columns;
}

// Arrival owns nine columns, not the requested visual radius. Empty sections
// need a fresh publication too; a collision-ready column is not a drawn mesh.
export function arrivalMeshesReady(renderer, position) {
  const world = renderer.world, ys = sectionYs(world);
  const columns = arrivalColumns(position);
  return columns.length > 0 && columns.every(key => {
    const column = renderer.chunks.get(key);
    return world.chunks.has(key) && ys.every(sy => {
      const section = column?.userData.sections?.get(sy);
      return sectionGeometryCovered(column, section, renderer.camera) &&
        !world.dirtySectionRevisions.has(`${key},${sy}`) &&
        meshRevisionCurrent(world, { ...section.stamp, ticket: undefined });
    });
  });
}

export async function prepareArrivalMeshes(renderer, pose, {
  yieldFrame = () => new Promise(resolve => requestAnimationFrame(resolve)),
  validate = () => {},
} = {}) {
  const world = renderer.world, epoch = geometryEpoch(world);
  const current = () => {
    validate();
    if (renderer.world !== world || geometryEpoch(world) !== epoch || world._disposed)
      throw new Error("Arrival world changed before mesh publication");
    if (renderer.renderer?.getContext().isContextLost())
      throw new Error("Arrival GPU context is unavailable");
  };
  renderer.camera.position.copy(pose.position);
  renderer.camera.rotation.set(pose.pitch, pose.yaw, 0, "YXZ");
  renderer.camera.updateMatrixWorld(true);
  renderer.arrivalCenter = { x: Math.floor(pose.position.x / 16), z: Math.floor(pose.position.z / 16) };
  renderer.sectionQueueLayout = null;
  try {
    for (;;) {
      current();
      if (arrivalMeshesReady(renderer, pose.position)) return;
      for (const key of arrivalColumns(pose.position))
        if (!world.chunks.has(key)) throw new Error(`Arrival collision column is unavailable: ${key}`);
      // Exactly one normal bounded mesh slice per animation frame. No force
      // drain, inflated capacity, simulation tick, or fabricated fallback.
      await yieldFrame();
      current();
      renderer.rebuildDirty(2);
      if (renderer.meshStats?.blocked)
        throw new Error(`Arrival mesh budget refused: ${renderer.meshStats.blocked.reason}`);
    }
  } finally {
    delete renderer.arrivalCenter;
    renderer.sectionQueueLayout = null;
  }
}
