import * as THREE from "three";
import { geometryBytes, MESH_BATCHES } from "./mesh-palette.js";
import { MESH_PART_LIMITS } from "./mesh-partitions.js";
import { MeshBudgetError } from "./mesh-geometry.js";

const TRANSPARENT = new Set(["water", "glass"]);
const COPY_QUANTUM = 16384;

// Context recovery calls geometry.dispose() to drop GPU handles while retaining
// canonical CPU data. Palette leases release only on explicit owner retirement.
export function disposeSectionPage(geometry) {
  geometry.userData.releaseColorPalette?.();
  geometry.dispose();
  // Three render-list entries can retain a retired Mesh until the next draw.
  // Do not let those entries retain freed canonical arrays or palette leases.
  geometry.attributes = {};
  geometry.index = null;
  delete geometry.userData.releaseColorPalette;
  delete geometry.userData.colorPalette;
}

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

function pageBytes(vertices, indices, attributes, packedNormals, integralPositions = false, palette = false, narrowColors = false) {
  return Object.entries(attributes).reduce(
    (sum, [name, a]) => sum + (name === "color" && palette ? vertices * (narrowColors ? 1 : 2) : vertices * a.itemSize *
      (name === "normal" ? (packedNormals ? 1 : 4) :
        name === "position" ? (integralPositions ? 2 : 4) : a.array.BYTES_PER_ELEMENT)), 0
  ) + indices * (vertices > 65535 ? 4 : 2);
}

/** One column/region transaction. Legacy sources stay CPU-only; canonical
 * publication replaces sources with shared page views. Planning allocates
 * metadata only. Copying yields every 16 KiB and
 * calculates tight bounds during the bounded position copies.
 * maxBytes/maxVertices bound every page, maxTotalBytes the entire transaction.
 */
export class SectionPagePlan {
  constructor(column, sy, group, limits = {}) {
    this.column = column;
    this.sectionKey = limits.sectionKey ?? sy;
    this.canonical = limits.canonical === true;
    this.palette = limits.palette;
    this.revision = column?.userData.pageRevision ?? 0;
    this.group = group;
    this.pages = [];
    this.ranges = new Map();
    this.bindings = [];
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
        (data.batch === "opaque" || this.canonical
          ? `/band:${Math.floor((section - minSection) / 8)}` : "");
    };
    const groups = new Map();
    const compactSources = limits.compactPage ? new Set(limits.compactPage.sources) : null;
    const changed = new Set([
      ...(column?.userData.sections?.get(this.sectionKey)?.group.children ?? []),
      ...group.children,
    ].filter((mesh) => mesh.userData.sectionSource).map(keyFor));
    for (const page of column?.userData.pageDescriptors ?? [])
      if (limits.compactPage ? page !== limits.compactPage : !changed.has(keyFor(page.sources[0]))) {
        this.pages.push({ ...page, reused: true });
        for (const source of page.sources)
          this.ranges.set(source, column.userData.sectionRanges.get(source));
      }
    const sources = [
      ...[...(column?.userData.sections ?? [])]
        .filter(([section]) => section !== this.sectionKey).map(([, section]) => section.group),
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
        if (compactSources && !compactSources.has(mesh)) continue;
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
        const integralPositions = this.canonical && geometry.userData.integralPositions === true;
        const narrowColors = this.palette && geometry.userData.colorPalette === this.palette &&
          geometry.attributes.color?.array instanceof Uint8Array;
        if (!page || page.vertices + vertices > cap.maxVertices ||
            pageBytes(page.vertices + vertices, page.indices + indices, geometry.attributes,
              page.packedNormals && axisNormals, page.integralPositions && integralPositions,
              this.palette, page.narrowColors && narrowColors) > cap.maxBytes) {
          page = { sources: [], vertices: 0, indices: 0, bytes: 0, mesh: null,
            packedNormals: true, integralPositions, narrowColors };
          this.pages.push(page);
        }
        page.sources.push(mesh);
        page.vertices += vertices;
        page.indices += indices;
        page.packedNormals &&= axisNormals;
        page.integralPositions &&= integralPositions;
        page.narrowColors &&= narrowColors;
        page.bytes = pageBytes(page.vertices, page.indices, geometry.attributes,
          page.packedNormals, page.integralPositions, this.palette, page.narrowColors);
        page.compactionBytes = page.bytes + (this.palette && !page.narrowColors ? page.vertices : 0);
        if (page.vertices > cap.maxVertices || page.bytes > cap.maxBytes)
          throw new MeshBudgetError();
      }
    }
    this.bytes = this.pages.reduce((sum, page) => sum + page.bytes, 0);
    this.stagingBytes = this.pages.reduce((sum, page) => sum + (page.reused ? 0 : page.compactionBytes), 0);
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
      page.mesh.customDepthMaterial = source.customDepthMaterial;
      page.mesh.customDistanceMaterial = source.customDistanceMaterial;
      page.mesh.userData.sectionPage = true;
      installPageCulling(page.mesh);
      const attributes = source.geometry.attributes;
      for (const [name, a] of Object.entries(attributes)) {
        if (name === "color" && this.palette) {
          const colors = page.narrowColors ? new Uint8Array(page.vertices) : new Uint16Array(page.vertices);
          geometry.setAttribute("color", new THREE.BufferAttribute(colors, 1));
          geometry.userData.colorPalette = this.palette;
          page.maxColorSlot = 0;
          const lease = { colors, count: 0 };
          page.paletteLease = lease;
          const palette = this.palette;
          geometry.userData.releaseColorPalette = () => {
            for (let i = 0; i < lease.count; i++) palette.release(lease.colors[i]);
            lease.count = 0;
            lease.colors = null;
          };
          this.allocatedBytes += colors.byteLength;
          yield 0;
          continue;
        }
        const packed = name === "normal" && page.packedNormals;
        // A canonical integral source can share a Float32 page with a new
        // fractional shape; promotion must follow the whole page, not its first
        // source's already-compacted view type.
        const Type = packed ? Int8Array :
          name === "position" && this.canonical ? (page.integralPositions ? Int16Array : Float32Array) :
          name === "normal" && a.array instanceof Int8Array ? Float32Array : a.array.constructor;
        const array = new Type(page.vertices * a.itemSize);
        const attribute = new THREE.BufferAttribute(array, a.itemSize,
          name === "normal" ? packed : a.normalized);
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
          if (name === "color" && this.palette) {
            const previousPalette = original.userData.colorPalette;
            if (!previousPalette && (a.itemSize !== 3 || !(a.array instanceof Float32Array)))
              throw new TypeError("Exact palette requires Float32 RGB");
            const quantum = Math.floor(COPY_QUANTUM / 12);
            for (let offset = 0; offset < a.count; offset += quantum) {
              const end = Math.min(a.count, offset + quantum);
              for (let i = offset; i < end; i++) {
                const slot = previousPalette === this.palette
                  ? this.palette.retain(a.array[i])
                  : this.palette.acquire(a.array[i * 3], a.array[i * 3 + 1], a.array[i * 3 + 2]);
                destination[vertexOffset + i] = slot;
                page.maxColorSlot = Math.max(page.maxColorSlot, slot);
                page.paletteLease.count++;
              }
              yield (end - offset) * 12;
            }
            continue;
          }
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
            alreadyPacked ||= a.array instanceof Int8Array && a.normalized;
          }
          const elementBytes = Math.max(input.BYTES_PER_ELEMENT, destination.BYTES_PER_ELEMENT);
          const quantum = Math.floor(COPY_QUANTUM / elementBytes / a.itemSize) * a.itemSize;
          for (let offset = 0; offset < input.length; offset += quantum) {
            const chunk = input.subarray(offset, offset + quantum);
            const target = vertexOffset * a.itemSize + offset;
            if (name === "normal" && !page.packedNormals && a.normalized &&
                a.array instanceof Int8Array) {
              for (let i = 0; i < chunk.length; i++) destination[target + i] = chunk[i] / 127;
            } else if (name === "normal" && page.packedNormals && !alreadyPacked) {
              // Mesher metadata proves these values are exactly -1/0/+1.
              // Signed normalized bytes decode to the identical shader input.
              for (let i = 0; i < chunk.length; i++) destination[target + i] = chunk[i] * 127;
            } else destination.set(chunk, target);
            if (name === "position" && this.canonical && !mesh.userData.canonicalRange) {
              const [dx, dz] = mesh.parent.userData.pageOffset ?? [0, 0];
              for (let i = 0; i < chunk.length; i += 3) {
                destination[target + i] += dx;
                destination[target + i + 2] += dz;
              }
            }
            if (name === "position")
              for (let i = 0; i < chunk.length; i += 3)
                bounds.expandByPoint(point.set(destination[target + i],
                  destination[target + i + 1], destination[target + i + 2]));
            yield chunk.length * elementBytes;
          }
        }
        const quantum = COPY_QUANTUM / indices.BYTES_PER_ELEMENT;
        for (let offset = 0; offset < original.index.count; offset += quantum) {
          const end = Math.min(original.index.count, offset + quantum);
          for (let i = offset; i < end; i++)
            indices[indexOffset + i] = original.index.array[i] + vertexOffset -
              (mesh.userData.canonicalRange?.vertexStart ?? 0);
          yield (end - offset) * indices.BYTES_PER_ELEMENT;
        }
        this.ranges.set(mesh, {
          mesh: page.mesh, start: indexOffset, count: original.index.count, vertexStart: vertexOffset,
          vertexCount: original.attributes.position.count,
        });
        vertexOffset += original.attributes.position.count;
        indexOffset += original.index.count;
      }
      // Only exact integer-width narrowing; every RGB bit still lives in the
      // same RGBA32F slot. The wide + narrow overlap is reserved in staging.
      if (this.palette && !page.narrowColors && page.maxColorSlot <= 255) {
        const wide = geometry.attributes.color.array;
        const narrow = new Uint8Array(wide.length);
        this.allocatedBytes += narrow.byteLength;
        yield 0;
        for (let offset = 0; offset < wide.length; offset += COPY_QUANTUM / 2) {
          const chunk = wide.subarray(offset, offset + COPY_QUANTUM / 2);
          narrow.set(chunk, offset);
          yield chunk.byteLength;
        }
        geometry.setAttribute("color", new THREE.BufferAttribute(narrow, 1));
        page.paletteLease.colors = narrow;
        page.narrowColors = true;
        this.allocatedBytes -= wide.byteLength;
      }
      page.bytes = geometryBytes(geometry);
      page.compactionBytes = page.bytes + (this.palette && !page.narrowColors ? page.vertices : 0);
      geometry.boundingBox = bounds;
      geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    }
    this.bytes = this.pages.reduce((sum, page) => sum + page.bytes, 0);
    if (this.canonical) this.prepareCanonicalRanges();
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

  /** Publish only after revision/admission checks. CPU-only logical geometries
   * become range views of the one GPU-backed canonical allocation. Their index
   * values are page-relative, not section-relative; canonicalRange records the
   * base for future copies. Never render or raycast these metadata geometries.
   */
  bindCanonicalRanges() {
    if (!this.canonical || !this.done || this.disposed)
      throw new Error("Canonical ranges require a complete live plan");
    for (const { source, attributes, index, range } of this.bindings) {
      source.geometry.attributes = attributes;
      source.geometry.index = index;
      source.geometry.userData.colorPalette = this.palette;
      source.userData.canonicalRange = range;
    }
    this.bindings = [];
  }

  prepareCanonicalRanges() {
    for (const page of this.pages) {
      if (page.reused) continue;
      for (const source of page.sources) {
        const range = this.ranges.get(source);
        const target = page.mesh.geometry;
        const attributes = {};
        for (const [name, a] of Object.entries(target.attributes)) {
          const view = new THREE.BufferAttribute(a.array.subarray(
            range.vertexStart * a.itemSize,
            (range.vertexStart + range.vertexCount) * a.itemSize), a.itemSize, a.normalized);
          view.gpuType = a.gpuType;
          attributes[name] = view;
        }
        const index = new THREE.BufferAttribute(
          target.index.array.subarray(range.start, range.start + range.count), 1);
        this.bindings.push({ source, attributes, index, range });
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.iterator?.return();
    if (!this.transferred)
      for (const page of this.pages)
        if (!page.reused && page.mesh) disposeSectionPage(page.mesh.geometry);
    if (!this.transferred) {
      this.pages = [];
      this.ranges.clear();
    }
    this.bindings = [];
    this.iterator = null;
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

const defaultLayers = new THREE.Layers();

function attachedVisible(object, scene) {
  for (let owner = object; owner; owner = owner.parent) {
    if (!owner.visible) return false;
    if (scene ? owner === scene : owner.isScene) return true;
  }
  return false;
}

/** Physical color-pass eligibility, without frustum culling. Parent layers do
 * not gate children in Three, but parent visibility and scene attachment do. */
export function sectionMeshVisible(mesh, camera, scene) {
  const count = mesh.geometry?.index?.count ?? mesh.geometry?.attributes.position?.count ?? 0;
  return mesh.isMesh && !mesh.userData.sectionSource &&
    (!mesh.userData.sectionWater || mesh.userData.sectionWater.host.covered(mesh)) &&
    (camera?.layers ?? defaultLayers).test(mesh.layers) &&
    mesh.material.visible !== false && count > 0 &&
    mesh.geometry.drawRange.count > 0 && mesh.geometry.drawRange.start < count &&
    attachedVisible(mesh, scene);
}

/** Same authority for whole-column LOD and per-section End landmarks. */
export function sectionGeometryCovered(column, section, camera) {
  const group = section?.group;
  if (!group?.visible || group.parent !== column || !attachedVisible(column) ||
      group.children.length !== section.draws) return false;
  if (!group.children.length) return !section.bytes;
  for (const source of group.children) {
    const count = source.geometry?.index?.count ??
      source.geometry?.attributes.position?.count ?? 0;
    if (!fullRange(source, 0, count)) return false;
    if (!source.userData.sectionSource) {
      if (!sectionMeshVisible(source, camera)) return false;
      continue;
    }
    const range = column.userData.sectionRanges?.get(source);
    const owner = range?.mesh.parent;
    const regional = owner?.userData.sectionRegion === true &&
      owner.parent === column.parent && owner.visible &&
      owner.userData.sections.get(`${column.userData.cx},${column.userData.cz},${group.userData.sy}`)?.group === group;
    if (!range || range.count !== count || (owner !== column && !regional) ||
        !sectionMeshVisible(range.mesh, camera) || !fullRange(range.mesh, range.start, range.count))
      return false;
  }
  return true;
}
