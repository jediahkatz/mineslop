import * as THREE from "three";

export const WATER_FIELDS = [["position", 3, 0], ["normal", 3, 3], ["uv", 2, 6], ["color", 3, 8]];

/** Constant-size inspection only. Attribute/index validation occurs in slices. */
export function planWaterGeometry(mesh, maxAllocationBytes) {
  const geometry = mesh.geometry;
  if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh ||
      mesh.raycast !== THREE.Mesh.prototype.raycast ||
      mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender ||
      mesh.onAfterRender !== THREE.Object3D.prototype.onAfterRender) return { unsupported: "mesh-or-render-hook-kind" };
  if (!geometry?.index || geometry.groups.length || Object.keys(geometry.morphAttributes).length)
    return { unsupported: "indexed-single-material-required" };
  if (Object.keys(geometry.attributes).sort().join() !== "color,normal,position,uv")
    return { unsupported: "attribute-layout" };
  const vertices = geometry.attributes.position.count;
  if (!vertices || !geometry.index.count) return { unsupported: "empty-source" };
  for (const [name, size] of WATER_FIELDS) {
    const a = geometry.attributes[name];
    if (a.isInterleavedBufferAttribute || !(a.array instanceof Float32Array) ||
        a.itemSize !== size || a.count !== vertices || a.normalized)
      return { unsupported: `${name}-format` };
  }
  if (geometry.index.itemSize !== 1 || geometry.index.normalized ||
      !(geometry.index.array instanceof Uint16Array || geometry.index.array instanceof Uint32Array))
    return { unsupported: "index-format" };
  // Backing growth has no observable mutation event. An incremental ledger
  // cannot honestly reserve it; keep these sources on the conventional path.
  if ([...WATER_FIELDS.map(([name]) => geometry.attributes[name]), geometry.index]
    .some(a => a.array.buffer.resizable || a.array.buffer.growable))
    return { unsupported: "resizable-source-buffer" };
  const width = Math.min(256, vertices * 3), height = Math.ceil(vertices * 3 / width);
  const textureBytes = width * height * 16, indexBytes = geometry.index.array.byteLength;
  if (height > 2048 || textureBytes > maxAllocationBytes || indexBytes > maxAllocationBytes)
    return { unsupported: "single-allocation-limit" };
  return { vertices, width, height, textureBytes, indexBytes,
    vboBytes: vertices * 48, metadataBytes: 64, geometry,
    providedBox: !!geometry.boundingBox, providedSphere: !!geometry.boundingSphere,
    attributes: WATER_FIELDS.map(([name]) => geometry.attributes[name]),
    bits: WATER_FIELDS.map(([name]) => {
      const a = geometry.attributes[name].array;
      return new Uint32Array(a.buffer, a.byteOffset, a.length);
    }),
    versions: WATER_FIELDS.map(([name]) => geometry.attributes[name].version),
    index: geometry.index, indexVersion: geometry.index.version };
}

export function waterInputCurrent(record) {
  const p = record.plan;
  return record.mesh.geometry === p.geometry && record.mesh.material === record.sourceMaterial &&
    p.geometry.index === p.index && p.index.version === p.indexVersion &&
    WATER_FIELDS.every(([name], i) => p.geometry.attributes[name] === p.attributes[i] &&
      p.attributes[i].version === p.versions[i]);
}

/** Borrowed, non-rendering canonical view: no attribute or index copies. */
export function createWaterDecoder(record) {
  const geometry = new THREE.BufferGeometry();
  const data = new THREE.InterleavedBuffer(record.data.subarray(0, record.plan.vertices * 12), 12);
  for (const [name, size, offset] of WATER_FIELDS)
    geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(data, size, offset));
  geometry.setIndex(new THREE.BufferAttribute(record.indices, 1));
  geometry.boundingBox = record.box;
  geometry.boundingSphere = record.sphere;
  geometry.drawRange = record.range;
  const proxy = new THREE.Mesh(geometry, record.sourceMaterial);
  const raycast = (raycaster, intersections) => {
    if (!record.current()) return;
    proxy.material = record.sourceMaterial;
    proxy.matrixWorld.copy(record.mesh.matrixWorld);
    const start = intersections.length;
    THREE.Mesh.prototype.raycast.call(proxy, raycaster, intersections);
    for (let i = start; i < intersections.length; i++) intersections[i].object = record.mesh;
  };
  return { geometry, raycast };
}

/** The CPU array is a borrowed alias of exactly the GPU index allocation. */
function externalIndex(record, gl) {
  const index = new THREE.GLBufferAttribute(record.indexBuffer,
    record.indices.BYTES_PER_ELEMENT === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
    1, record.indices.BYTES_PER_ELEMENT, record.indices.length);
  index.array = record.indices;
  return index;
}

export function createWaterDrawGeometry(record, gl, mode) {
  const geometry = mode === "fused" ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
  if (mode === "fused") {
    geometry.instanceCount = 2;
    for (const [name, size] of WATER_FIELDS)
      geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(0), size));
  } else {
    // A conventional, honestly two-pass fallback over the SAME canonical CPU
    // backing. Its VBO is built/uploaded before replacing the fused texture.
    const data = new THREE.InterleavedBuffer(record.data.subarray(0, record.plan.vertices * 12), 12);
    Object.assign(data, { isGLBufferAttribute: true, buffer: record.vbo,
      type: gl.FLOAT, elementSize: 4 });
    for (const [name, size, offset] of WATER_FIELDS)
      geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(data, size, offset));
  }
  geometry.setIndex(externalIndex(record, gl));
  geometry.boundingBox = record.box;
  geometry.boundingSphere = record.sphere;
  geometry.drawRange = record.range;
  // During GPU recovery, keep the logical range separate from the zero physical
  // range. Subsequent user setDrawRange() calls still update BOTH instances.
  geometry.setDrawRange = (start, count) => {
    record.range.start = start; record.range.count = count;
    if (record.ready) geometry.drawRange = record.range;
    return geometry;
  };
  return geometry;
}

export function waterFusionDecoder(mesh) {
  const record = mesh.userData.waterFusion;
  // CPU inspection survives GPU recovery, but not a stale incarnation/identity.
  return record?.current() ? record.decoder?.geometry ?? null : null;
}

export function waterFusionCovered(mesh) {
  const r = mesh.userData.waterFusion;
  if (!r) return true;
  const count = Math.min(r.indices.length, r.range.start + r.range.count) - Math.max(0, r.range.start);
  return r.isReady() && count >= 3;
}
