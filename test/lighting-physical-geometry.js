// Test-only physical submission collector. Do not use logical coverage gates
// or column.userData.pages: several columns can reference one regional page.
import * as THREE from "three";

function attachedVisible(object, scene) {
  for (let node = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === scene) return true;
  }
  return false;
}

function triangleExists(geometry, start) {
  const position = geometry.attributes.position, index = geometry.index;
  const a = index ? index.getX(start) : start;
  const b = index ? index.getX(start + 1) : start + 1;
  const c = index ? index.getX(start + 2) : start + 2;
  if (![a, b, c].every((v) => Number.isInteger(v) && v >= 0 && v < position.count) ||
    a === b || a === c || b === c) return false;
  const ax = position.getX(b) - position.getX(a), ay = position.getY(b) - position.getY(a),
    az = position.getZ(b) - position.getZ(a);
  const bx = position.getX(c) - position.getX(a), by = position.getY(c) - position.getY(a),
    bz = position.getZ(c) - position.getZ(a);
  return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) > 0;
}

export function physicalDrawRanges(mesh) {
  const geometry = mesh.geometry;
  if (!geometry?.attributes.position || !mesh.material ||
    (mesh.isInstancedMesh && mesh.count <= 0)) return [];
  const total = geometry.index?.count ?? geometry.attributes.position.count;
  const start = Math.max(0, geometry.drawRange.start);
  const end = Math.min(total, geometry.drawRange.start + geometry.drawRange.count);
  const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count: total, materialIndex: 0 }];
  const ranges = [];
  for (const group of groups) {
    const material = Array.isArray(mesh.material) ? mesh.material[group.materialIndex] : mesh.material;
    if (!material || material.visible === false) continue;
    const from = Math.max(start, group.start), to = Math.min(end, group.start + group.count);
    if (!Number.isInteger(from) || to - from < 3) continue;
    for (let i = from; i + 2 < to; i += 3) if (triangleExists(geometry, i)) {
      ranges.push({ start: from, end: to, materialIndex: group.materialIndex });
      break;
    }
  }
  return ranges;
}

export function collectPhysicalLightMeshes(graphics, camera = graphics.camera, roots) {
  graphics.scene.updateMatrixWorld(true);
  const meshes = new Set();
  roots ??= [...(graphics.chunks?.values() ?? []), ...(graphics.sectionRegions?.values() ?? [])];
  for (const root of new Set(roots)) root?.traverse((mesh) => {
    if (!mesh.isMesh || mesh.userData.sectionSource || !mesh.layers.test(camera.layers) ||
      !attachedVisible(mesh, graphics.scene) || !physicalDrawRanges(mesh).length) return;
    meshes.add(mesh);
  });
  return [...meshes];
}

export function intersectPhysicalLightMeshes(graphics, ray, camera = graphics.camera, roots) {
  ray.layers.mask = camera.layers.mask;
  const meshes = collectPhysicalLightMeshes(graphics, camera, roots);
  return ray.intersectObjects(meshes, false).filter((hit) => {
    return physicalDrawRanges(hit.object).some((range) => {
      const offset = range.start + (hit.faceIndex - Math.floor(range.start / 3)) * 3;
      return offset >= range.start && offset + 3 <= range.end &&
        (!Array.isArray(hit.object.material) || hit.face.materialIndex === range.materialIndex);
    });
  });
}

export function physicalColorComponent(geometry, vertex, channel) {
  const color = geometry.attributes.color;
  if (!color) return 1;
  if (color.itemSize === 1) {
    const palette = geometry.userData.colorPalette;
    if (!palette) throw new Error("Indexed physical color requires its exact palette");
    return palette.component(color.array[vertex], channel);
  }
  if (color.itemSize !== 3 && color.itemSize !== 4) throw new Error("Unsupported physical color attribute");
  return channel < color.itemSize ? color.getComponent(vertex, channel) : 1;
}

export function physicalHitColor(hit) {
  const geometry = hit.object.geometry, position = geometry.attributes.position;
  const matrix = hit.object.matrixWorld.clone();
  if (hit.object.isInstancedMesh && hit.instanceId !== undefined) {
    const instance = new THREE.Matrix4();
    hit.object.getMatrixAt(hit.instanceId, instance);
    matrix.multiply(instance);
  }
  const triangle = [hit.face.a, hit.face.b, hit.face.c].map((index) =>
    new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(matrix));
  const weights = THREE.Triangle.getBarycoord(hit.point, ...triangle, new THREE.Vector3()).toArray();
  return [0, 1, 2].map((channel) => [hit.face.a, hit.face.b, hit.face.c].reduce(
    (sum, vertex, i) => sum + weights[i] * physicalColorComponent(geometry, vertex, channel), 0));
}

const bufferIds = new WeakMap();
let nextBuffer = 0;
export function physicalLightGeometryFingerprint(graphics, camera = graphics.camera) {
  const meshes = collectPhysicalLightMeshes(graphics, camera);
  const geometries = new Set(meshes.map((mesh) => mesh.geometry)), buffers = new Set();
  for (const geometry of geometries)
    for (const attribute of [...Object.values(geometry.attributes), geometry.index]) {
      const array = attribute?.array ?? attribute?.data?.array;
      if (array) buffers.add(array.buffer);
    }
  return {
    meshes: meshes.map((mesh) => ({
      id: mesh.uuid, geometry: mesh.geometry.uuid, matrix: mesh.matrixWorld.toArray(),
      ranges: physicalDrawRanges(mesh),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    geometries: [...geometries].map((geometry) => geometry.uuid).sort(),
    buffers: [...buffers].map((buffer) => {
      if (!bufferIds.has(buffer)) bufferIds.set(buffer, ++nextBuffer);
      return { id: bufferIds.get(buffer), bytes: buffer.byteLength };
    }).sort((a, b) => a.id - b.id),
  };
}
