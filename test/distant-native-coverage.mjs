import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { geometryWorldSpec } from "../src/geometry-world.js";

const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]];

// Independent of the consumer's parts/visibility counters. V7 expectations
// come from the native bit mask, not the LOD's reconstructed mesh metadata.
export function expectedPillarBoxes(world) {
  const spec = geometryWorldSpec(world), boxes = [];
  for (const pillar of world.generator.getEndPillars?.() ?? []) {
    for (let bit = 0; bit < 25; bit++) {
      const dx = bit % 5 - 2, dz = Math.floor(bit / 5) - 2;
      if (pillar.body ? !(pillar.body.columnMask & (1 << bit)) : dx * dx + dz * dz > 5) continue;
      const x = pillar.x + dx, z = pillar.z + dz;
      const low = Math.max(spec.minY, pillar.body?.minY ??
        Math.max(1, pillar.base, world.generator.terrainHeight(x, z) + 1));
      const high = Math.min(spec.maxY, pillar.body?.maxY ?? pillar.top + 1);
      const block = pillar.body?.block ?? BLOCK.OBSIDIAN;
      let start = null;
      for (let y = low; y <= high; y++) {
        const edit = world.edits?.get(`end:${x},${y},${z}`);
        const present = y < high && (!edit || edit.id === block);
        if (!present && start !== null) {
          boxes.push({ id: pillar.id, kind: "body", box: new THREE.Box3(
            new THREE.Vector3(x, start, z), new THREE.Vector3(x + 1, y, z + 1)) });
          start = null;
        }
        if (present && start === null) start = y;
      }
    }
    const cap = pillar.cap ?? { x: pillar.x, y: pillar.top + 1, z: pillar.z };
    const capEdit = world.edits?.get(`end:${cap.x},${cap.y},${cap.z}`);
    if (cap.y >= spec.minY && cap.y < spec.maxY &&
        (!capEdit || capEdit.id === (cap.block ?? BLOCK.GLOWSTONE)))
      boxes.push({ id: pillar.id, kind: "cap", box: new THREE.Box3(
        new THREE.Vector3(cap.x, cap.y, cap.z), new THREE.Vector3(cap.x + 1, cap.y + 1, cap.z + 1)) });
  }
  return boxes;
}

function attachedVisible(object, scene) {
  for (let at = object; at; at = at.parent) {
    if (!at.visible) return false;
    if (at === scene) return true;
  }
  return false;
}

export function fogTransmission(camera, fog, point) {
  if (!fog) return 1;
  const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
  if (fog.isFogExp2) return Math.exp(-(fog.density ** 2) * depth ** 2);
  const t = THREE.MathUtils.clamp((depth - fog.near) / (fog.far - fog.near), 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

/** Actual indexed draw intersections, not group names, source counts, or bounds.
 * Native terrain/pillars determine occlusion independently; a wrong coarse
 * wall in the rendered scene cannot exempt a missing expected pillar.
 */
export function auditPillarDraws(graphics, { range = 512, minTransmission = 0.15 } = {}) {
  const { world, scene, camera } = graphics;
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const native = expectedPillarBoxes(world);
  const rows = new Map((world.generator.getEndPillars?.() ?? []).map((p) =>
    [p.id, { id: p.id, expected: 0, matched: 0, missing: 0, duplicate: 0,
      fogHidden: 0, body: 0, cap: 0, owners: [], witnesses: [], minimumTransmission: 1 }]));
  const meshes = [], owners = new Map();
  const collect = (root, owner) => {
    if (!root || !attachedVisible(root, scene)) return;
    root.traverseVisible((object) => {
      if (!object.isMesh || !camera.layers.test(object.layers)) return;
      meshes.push(object); owners.set(object, owner);
    });
  };
  for (const root of graphics.chunks.values()) collect(root, "detail");
  collect(graphics.distant?.group, "proxy");
  const raycaster = new THREE.Raycaster(), intersection = new THREE.Vector3();
  const terrain = new Map();
  const blockedByTerrain = (ray, distance) => {
    // Half-voxel spacing with memoized native columns; no chunk or voxel reads.
    for (let t = 0.5; t < distance - 0.75; t += 0.5) {
      const p = ray.at(t, intersection), x = Math.floor(p.x), z = Math.floor(p.z);
      const key = `${x},${z}`;
      if (!terrain.has(key)) {
        if (terrain.size >= 100000) throw new Error("Native occlusion query bound exceeded");
        const col = world.generator.sampleColumn?.(x, z);
        terrain.set(key, { top: col ? col.top : world.generator.terrainHeight(x, z),
          bottom: col?.bottom ?? geometryWorldSpec(world).minY });
      }
      const { top, bottom } = terrain.get(key);
      if (Number.isFinite(top) && p.y >= bottom && p.y < top + 1) return true;
    }
    return false;
  };
  for (const expected of native) {
    const { min, max } = expected.box;
    const ys = new Set([min.y + 0.5, max.y - 0.5]);
    for (let sy = Math.floor(min.y / 16); sy <= Math.floor((max.y - 1) / 16); sy++) {
      ys.add(Math.max(min.y, sy * 16) + 0.5);
      ys.add(Math.min(max.y, (sy + 1) * 16) - 0.5);
    }
    for (const normal of directions) {
      const heights = normal[1] ? [max.y] : ys;
      for (const y of heights) {
        const p = new THREE.Vector3(
          normal[0] ? (normal[0] > 0 ? max.x : min.x) : (min.x + max.x) / 2,
          y, normal[2] ? (normal[2] > 0 ? max.z : min.z) : (min.z + max.z) / 2);
        if (camera.position.clone().sub(p).dot(new THREE.Vector3(...normal)) <= 0) continue;
        const projected = p.clone().project(camera);
        const depth = -p.clone().applyMatrix4(camera.matrixWorldInverse).z;
        const distance = p.distanceTo(camera.position);
        if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1 ||
            depth <= camera.near || distance > range) continue;
        raycaster.set(camera.position, p.clone().sub(camera.position).normalize());
        if (native.some((other) => {
          const hit = raycaster.ray.intersectBox(other.box, intersection);
          return hit && hit.distanceTo(camera.position) < distance - 0.025;
        }) || blockedByTerrain(raycaster.ray, distance)) continue;
        const row = rows.get(expected.id);
        row.expected++; row[expected.kind]++;
        const transmission = fogTransmission(camera, scene.fog, p);
        row.minimumTransmission = Math.min(row.minimumTransmission, transmission);
        if (transmission < minTransmission) row.fogHidden++;
        raycaster.far = distance + 0.025;
        const hits = raycaster.intersectObjects(meshes, false).filter((hit) => {
          const material = Array.isArray(hit.object.material)
            ? hit.object.material[hit.face.materialIndex] : hit.object.material;
          return material.visible !== false;
        });
        const atSurface = hits.filter((hit) => Math.abs(hit.distance - distance) <= 0.025);
        // Two triangles of the same quad are one surface. Two separate meshes
        // (detail + proxy) at the same native surface are a duplicate handoff.
        const objects = new Set(atSurface.map((hit) => hit.object));
        if (!objects.size || (hits[0] && hits[0].distance < distance - 0.025)) {
          row.missing++;
          if (row.witnesses.length < 3) row.witnesses.push({
            point: p.toArray(), expectedDistance: distance,
            actualDistance: hits[0]?.distance ?? null, mesh: hits[0]?.object.name ?? null,
          });
        }
        else row.matched++;
        if (objects.size > 1) row.duplicate++;
        for (const object of objects) {
          const owner = owners.get(object);
          if (!row.owners.includes(owner)) row.owners.push(owner);
        }
      }
    }
  }
  const pillars = [...rows.values()];
  return {
    pillars, nativeColumnsQueried: terrain.size,
    expectedPillars: pillars.filter((p) => p.expected).length,
    mixedOwnershipPillars: pillars.filter((p) => p.owners.length > 1).map((p) => p.id),
    errors: pillars.flatMap((p) => [
      ...(p.missing ? [`pillar ${p.id}: ${p.missing}/${p.expected} expected draw intersections missing/obstructed`] : []),
      ...(p.duplicate ? [`pillar ${p.id}: ${p.duplicate} duplicate detail/proxy surfaces`] : []),
      ...(p.fogHidden ? [`pillar ${p.id}: ${p.fogHidden}/${p.expected} probes below ${minTransmission} fog transmission`] : []),
    ]),
  };
}
