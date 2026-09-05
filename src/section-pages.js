import * as THREE from "three";
import { geometryBytes, MESH_BATCHES } from "./mesh-palette.js";
import { MESH_PART_LIMITS } from "./mesh-partitions.js";
import { MeshBudgetError } from "./mesh-geometry.js";

const TRANSPARENT = new Set(["water", "glass"]);
const COPY_QUANTUM = 16384;

function installPageCulling(mesh) {
  const frustum = new THREE.Frustum();
  const matrix = new THREE.Matrix4();
  const bounds = new THREE.Box3();
  let savedRange;
  const before = (camera) => {
    // Also recover if an interrupted render never reached its after hook.
    if (savedRange) mesh.geometry.setDrawRange(savedRange.start, savedRange.count);
    // A tall column sphere reaches far outside its actual 16-block footprint.
    // Refine Three's broad phase with the tight box for each camera/shadow pass.
    // Only the draw range changes: no attribute uploads or ownership mutation.
    frustum.setFromProjectionMatrix(matrix.multiplyMatrices(
      camera.projectionMatrix, camera.matrixWorldInverse));
    bounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    savedRange = null;
    if (!frustum.intersectsBox(bounds)) {
      savedRange = { ...mesh.geometry.drawRange };
      mesh.geometry.setDrawRange(0, 0);
    }
  };
  const after = () => {
    if (savedRange) mesh.geometry.setDrawRange(savedRange.start, savedRange.count);
    savedRange = null;
  };
  mesh.onBeforeRender = (_renderer, _scene, camera) => before(camera);
  mesh.onAfterRender = after;
  mesh.onBeforeShadow = (_renderer, _object, _camera, shadowCamera) => before(shadowCamera);
  mesh.onAfterShadow = after;
}

export function sectionSourceGroup(result, materials) {
  const group = new THREE.Group();
  for (const part of result.parts)
    for (const name of MESH_BATCHES) {
      const geometry = part[name];
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, materials[name]);
      mesh.castShadow = ["opaque", "foliage", "berryFoliage"].includes(name);
      mesh.receiveShadow = mesh.castShadow;
      mesh.renderOrder = name === "water" ? 2 : name === "glass" ? 1 : 0;
      mesh.userData.batch = name;
      mesh.userData.sectionSource = !TRANSPARENT.has(name);
      // Keep logical section records inspectable/disposable in the scene, but
      // never upload or submit these CPU-only meshes (including shadow passes).
      if (mesh.userData.sectionSource) mesh.layers.mask = 0;
      group.add(mesh);
    }
  return group;
}

function signature(mesh) {
  const geometry = mesh.geometry;
  if (!geometry.index || geometry.groups.length)
    throw new TypeError("Section pages require indexed, single-material geometry");
  return mesh.userData.batch + ":" + Object.keys(geometry.attributes).sort().map((name) => {
    const a = geometry.attributes[name];
    if (a.isInterleavedBufferAttribute) throw new TypeError("Interleaved section attribute");
    return `${name}/${a.array.constructor.name}/${a.itemSize}/${a.normalized}/${a.gpuType}`;
  }).join(";");
}

function pageBytes(vertices, indices, attributes, packedNormals) {
  return Object.entries(attributes).reduce(
    (sum, [name, a]) => sum + vertices * a.itemSize *
      (name === "normal" && packedNormals ? 1 : a.array.BYTES_PER_ELEMENT), 0
  ) + indices * (vertices > 65535 ? 4 : 2);
}

/** One column transaction. Sources stay CPU-only; exact-sized GPU pages own
 * copies. Planning allocates metadata only. Copying yields every 16 KiB and
 * calculates tight bounds during the bounded position copies.
 * maxBytes/maxVertices bound every page, maxTotalBytes the entire transaction.
 */
export class SectionPagePlan {
  constructor(column, sy, group, limits = {}) {
    this.column = column;
    this.revision = column?.userData.pageRevision ?? 0;
    this.group = group;
    this.pages = [];
    this.ranges = new Map();
    this.bytes = 0;
    this.allocatedBytes = 0;
    this.copiedBytes = 0;
    this.done = false;
    this.transferred = false;
    const cap = { ...MESH_PART_LIMITS, maxTotalBytes: Infinity, ...limits };
    group.userData.sy = sy;
    const minSection = limits.minSection ?? 0;
    const keyFor = (mesh) => {
      const data = mesh.userData, section = mesh.parent.userData.sy;
      if (data.pageKey && data.pageMin === minSection && data.pageSy === section) return data.pageKey;
      data.pageMin = minSection;
      data.pageSy = section;
      return data.pageKey = (data.sectionSignature ??= signature(mesh)) +
        (data.batch === "opaque" ? `/band:${Math.floor((section - minSection) / 8)}` : "");
    };
    const groups = new Map();
    const changed = new Set([
      ...(column?.userData.sections?.get(sy)?.group.children ?? []),
      ...group.children,
    ].filter((mesh) => mesh.userData.sectionSource).map(keyFor));
    for (const page of column?.userData.pageDescriptors ?? [])
      if (!changed.has(keyFor(page.sources[0]))) {
        this.pages.push({ ...page, reused: true });
        for (const source of page.sources)
          this.ranges.set(source, column.userData.sectionRanges.get(source));
      }
    const sources = [
      ...[...(column?.userData.sections ?? [])]
        .filter(([section]) => section !== sy).map(([, section]) => section.group),
      group,
    ];
    this.transparentDraws = 0;
    this.transparentBytes = 0;
    this.transparentMeshes = [];
    for (const source of sources)
      for (const mesh of source.children) {
        if (!mesh.userData.sectionSource) {
          this.transparentDraws++;
          this.transparentBytes += geometryBytes(mesh.geometry);
          this.transparentMeshes.push(mesh);
          continue;
        }
        const key = keyFor(mesh);
        if (!changed.has(key)) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(mesh);
      }
    for (const meshes of groups.values()) {
      let page;
      for (const mesh of meshes) {
        const geometry = mesh.geometry;
        const vertices = geometry.attributes.position.count;
        const indices = geometry.index.count;
        const axisNormals = geometry.userData.axisNormals === true;
        if (!page || page.vertices + vertices > cap.maxVertices ||
            pageBytes(page.vertices + vertices, page.indices + indices, geometry.attributes,
              page.packedNormals && axisNormals) > cap.maxBytes) {
          page = { sources: [], vertices: 0, indices: 0, bytes: 0, mesh: null, packedNormals: true };
          this.pages.push(page);
        }
        page.sources.push(mesh);
        page.vertices += vertices;
        page.indices += indices;
        page.packedNormals &&= axisNormals;
        page.bytes = pageBytes(page.vertices, page.indices, geometry.attributes, page.packedNormals);
        if (page.vertices > cap.maxVertices || page.bytes > cap.maxBytes)
          throw new MeshBudgetError();
      }
    }
    this.bytes = this.pages.reduce((sum, page) => sum + page.bytes, 0);
    this.stagingBytes = this.pages.reduce((sum, page) => sum + (page.reused ? 0 : page.bytes), 0);
    if (this.bytes + this.transparentBytes > cap.maxTotalBytes)
      throw new MeshBudgetError();
    this.draws = this.pages.length + this.transparentDraws;
    this.iterator = this.copy();
    // Empty sections and transparent-only edits need no copy work. Do not
    // spend another scheduling slice just to discover an empty iterator.
    this.done = this.stagingBytes === 0;
  }

  *copy() {
    for (const page of this.pages) {
      if (page.reused) continue;
      const source = page.sources[0];
      const geometry = new THREE.BufferGeometry();
      page.mesh = new THREE.Mesh(geometry, source.material);
      page.mesh.castShadow = source.castShadow;
      page.mesh.receiveShadow = source.receiveShadow;
      page.mesh.renderOrder = source.renderOrder;
      page.mesh.userData.sectionPage = true;
      installPageCulling(page.mesh);
      const attributes = source.geometry.attributes;
      for (const [name, a] of Object.entries(attributes)) {
        const packed = name === "normal" && page.packedNormals;
        const Type = packed ? Int8Array : a.array.constructor;
        const array = new Type(page.vertices * a.itemSize);
        const attribute = new THREE.BufferAttribute(array, a.itemSize, packed || a.normalized);
        attribute.gpuType = a.gpuType;
        geometry.setAttribute(name, attribute);
        this.allocatedBytes += array.byteLength;
        yield 0;
      }
      const indices = page.vertices > 65535
        ? new Uint32Array(page.indices) : new Uint16Array(page.indices);
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      this.allocatedBytes += indices.byteLength;
      yield 0;
      const bounds = new THREE.Box3();
      const point = new THREE.Vector3();
      let vertexOffset = 0, indexOffset = 0;
      for (const mesh of page.sources) {
        const original = mesh.geometry;
        for (const [name, a] of Object.entries(original.attributes)) {
          const destination = geometry.attributes[name].array;
          let input = a.array, alreadyPacked = false;
          if (name === "normal" && page.packedNormals) {
            const previous = this.column?.userData.sectionRanges?.get(mesh);
            const attribute = previous?.mesh.geometry.attributes.normal;
            if (attribute?.array instanceof Int8Array && attribute.normalized &&
                Number.isInteger(previous.vertexStart)) {
              input = attribute.array.subarray(previous.vertexStart * a.itemSize,
                (previous.vertexStart + a.count) * a.itemSize);
              alreadyPacked = true;
            }
          }
          const quantum = Math.floor(COPY_QUANTUM / input.BYTES_PER_ELEMENT / a.itemSize) * a.itemSize;
          for (let offset = 0; offset < input.length; offset += quantum) {
            const chunk = input.subarray(offset, offset + quantum);
            const target = vertexOffset * a.itemSize + offset;
            if (name === "normal" && page.packedNormals && !alreadyPacked) {
              // Mesher metadata proves these values are exactly -1/0/+1.
              // Signed normalized bytes decode to the identical shader input.
              for (let i = 0; i < chunk.length; i++) destination[target + i] = chunk[i] * 127;
            } else destination.set(chunk, target);
            if (name === "position")
              for (let i = 0; i < chunk.length; i += 3)
                bounds.expandByPoint(point.set(chunk[i], chunk[i + 1], chunk[i + 2]));
            yield chunk.byteLength;
          }
        }
        const quantum = COPY_QUANTUM / indices.BYTES_PER_ELEMENT;
        for (let offset = 0; offset < original.index.count; offset += quantum) {
          const end = Math.min(original.index.count, offset + quantum);
          for (let i = offset; i < end; i++)
            indices[indexOffset + i] = original.index.array[i] + vertexOffset;
          yield (end - offset) * indices.BYTES_PER_ELEMENT;
        }
        this.ranges.set(mesh, {
          mesh: page.mesh, start: indexOffset, count: original.index.count, vertexStart: vertexOffset,
        });
        vertexOffset += original.attributes.position.count;
        indexOffset += original.index.count;
      }
      geometry.boundingBox = bounds;
      geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    }
  }

  step(maxBytes, deadline) {
    if (this.done) return 0;
    let copied = 0;
    while (copied + COPY_QUANTUM <= maxBytes && performance.now() < deadline) {
      const next = this.iterator.next();
      if (next.done) { this.done = true; break; }
      copied += next.value;
    }
    this.copiedBytes += copied;
    return copied;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.iterator?.return();
    if (!this.transferred)
      for (const page of this.pages)
        if (!page.reused) page.mesh?.geometry.dispose();
    this.allocatedBytes = 0;
  }
}

function fullRange(mesh, start, count) {
  const geometry = mesh.geometry;
  const available = geometry?.index?.count ?? geometry?.attributes.position?.count ?? 0;
  return mesh.isMesh && mesh.visible && mesh.material.visible !== false &&
    count > 0 && start >= 0 && start + count <= available &&
    geometry.drawRange.start <= start &&
    geometry.drawRange.start + geometry.drawRange.count >= start + count;
}

/** Same authority for whole-column LOD and per-section End landmarks. */
export function sectionGeometryCovered(column, section) {
  const group = section?.group;
  if (!group?.visible || group.parent !== column ||
      group.children.length !== section.draws) return false;
  for (const source of group.children) {
    const count = source.geometry?.index?.count ??
      source.geometry?.attributes.position?.count ?? 0;
    if (!fullRange(source, 0, count)) return false;
    if (!source.userData.sectionSource) continue;
    const range = column.userData.sectionRanges?.get(source);
    if (!range || range.count !== count || range.mesh.parent !== column ||
        !range.mesh.layers.mask || !fullRange(range.mesh, range.start, range.count))
      return false;
  }
  return true;
}
