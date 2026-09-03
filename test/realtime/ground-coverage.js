import * as THREE from "three";
import { CHUNK_SIZE, WATER_LEVEL, WORLD_HEIGHT } from "../../src/terrain.js";

const smoothstep = (near, far, value) => {
  const t = Math.max(0, Math.min(1, (value - near) / (far - near)));
  return t * t * (3 - 2 * t);
};

function visibleMeshes(group) {
  const meshes = [];
  if (group)
    group.traverseVisible((object) => {
      if (object.isMesh && object.material.visible !== false)
        meshes.push(object);
    });
  return meshes;
}

/** Actual indexed draw geometry, not a ready flag or a loaded voxel check. */
export function probeGroundColumn(graphics, x, z, expectedHeight, band) {
  const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
  const ray = new THREE.Raycaster(
    new THREE.Vector3(
      x,
      Math.max(WORLD_HEIGHT, graphics.camera.position.y) + 2,
      z
    ),
    new THREE.Vector3(0, -1, 0)
  );
  const detail = graphics.chunks.get(key);
  const near = detail?.parent === graphics.scene ? visibleMeshes(detail) : [];
  // Far canopies must not disguise a hole in the ground layer itself.
  const distant = graphics.distant;
  const far =
    distant?.group.visible && distant.group.parent === graphics.scene
      ? visibleMeshes(distant._active?.group)
      : [];
  const hits = ray.intersectObjects([...near, ...far], false);
  const hit = hits[0];
  const point = new THREE.Vector3(x, hit?.point.y ?? expectedHeight, z);
  const cameraPoint = point
    .clone()
    .applyMatrix4(graphics.camera.matrixWorldInverse);
  const projected = point.clone().project(graphics.camera);
  const horizontalDistance = Math.hypot(
    x - graphics.camera.position.x,
    z - graphics.camera.position.z
  );
  const fog = graphics.scene.fog;
  return {
    band,
    key,
    x,
    z,
    expectedHeight,
    renderedHeight: hit?.point.y ?? null,
    source: hit ? (near.includes(hit.object) ? "detail" : "distant") : null,
    inView:
      cameraPoint.z < 0 &&
      Math.abs(projected.x) <= 1 &&
      Math.abs(projected.y) <= 1 &&
      Math.abs(projected.z) <= 1,
    viewDepth: -cameraPoint.z,
    horizontalDistance,
    // Three's shipped shader uses -mvPosition.z, not Euclidean distance.
    fogByViewDepth: smoothstep(fog.near, fog.far, -cameraPoint.z),
    fogByHorizontalDistance: smoothstep(fog.near, fog.far, horizontalDistance),
  };
}

export function sampleGroundCoverage(game) {
  const { graphics, world } = game;
  const { x, z } = graphics.camera.position;
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const radius = graphics.renderRadius;
  const active = graphics.distant?._active?.data;
  const horizon =
    active?.request.horizon ??
    graphics.distant?._job?.request.horizon ??
    (radius + 2) * CHUNK_SIZE;
  const points = [{ x, z, band: "underfoot" }];
  for (const dz of [-radius, 0, radius])
    for (const dx of [-radius, 0, radius])
      if (dx || dz)
        points.push({
          x: (cx + dx + 0.5) * CHUNK_SIZE + 0.31,
          z: (cz + dz + 0.5) * CHUNK_SIZE + 0.31,
          band: "requested-detail",
        });
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    points.push({
      x: (cx + 0.5) * CHUNK_SIZE + dx * ((radius + 0.5) * CHUNK_SIZE + 4),
      z: (cz + 0.5) * CHUNK_SIZE + dz * ((radius + 0.5) * CHUNK_SIZE + 4),
      band: "detail-boundary",
    });
  }
  for (let direction = 0; direction < 8; direction++)
    points.push({
      x: x + Math.cos((direction * Math.PI) / 4) * horizon * 0.65,
      z: z + Math.sin((direction * Math.PI) / 4) * horizon * 0.65,
      band: "horizon",
    });
  const samples = [];
  for (const point of points) {
    const height = world.generator.terrainHeight(
      Math.floor(point.x),
      Math.floor(point.z)
    );
    // End void is intentional absence, never a streaming coverage failure.
    if (!Number.isFinite(height) || height < 0) continue;
    const expectedHeight =
      world.dimension === "overworld"
        ? Math.max(height + 1, WATER_LEVEL + 0.88)
        : height + 1;
    samples.push(
      probeGroundColumn(graphics, point.x, point.z, expectedHeight, point.band)
    );
  }
  const inView = samples.filter((sample) => sample.inView);
  const missing = samples.filter((sample) => sample.source === null);
  return {
    samples,
    expected: samples.length,
    drawn: samples.length - missing.length,
    missing: missing.length,
    missingDetail: missing.filter((sample) =>
      ["underfoot", "requested-detail"].includes(sample.band)
    ).length,
    inViewExpected: inView.length,
    inViewDrawn: inView.filter((sample) => sample.source !== null).length,
    inViewUnfogged: inView.filter(
      (sample) => sample.source !== null && sample.fogByViewDepth < 0.98
    ).length,
  };
}
