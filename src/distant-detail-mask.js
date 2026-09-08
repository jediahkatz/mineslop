import * as THREE from "three";
import { MAX_RENDER_RADIUS } from "./render-distance.js";
import { sectionGeometryCovered } from "./section-pages.js";

export const DETAIL_BATCHES = ["opaque", "foliage", "berryFoliage", "water"];
const TILES = MAX_RENDER_RADIUS * 2 + 1;

// Read only published physical ownership. A pending replacement (including an
// edit) does not revoke the old draw; detachment/replacement does. Missing and
// CPU-only staging sections must never claim space. An empty published batch
// owns its volume, including intentional absence after a removal.
export function distantDetailBatches(chunks, camera) {
  const result = new Map();
  for (const [key, column] of chunks) {
    for (const [sy, section] of column.userData.sections ?? []) {
      let bits = 0;
      for (let b = 0; b < DETAIL_BATCHES.length; b++)
        if (sectionGeometryCovered(column, section, camera, DETAIL_BATCHES[b]))
          bits |= 1 << b;
      if (bits) result.set(`${key},${sy}`, bits);
    }
  }
  return result;
}

// One bounded RGBA8 texel per section, not per voxel or per draw. Red is
// terrain/trunks, green foliage, blue berry foliage and alpha water. The CPU
// image is retained for context recovery; no GPU readback or extra staging.
export class DistantDetailMask {
  constructor() {
    this.texture = { value: null };
    this.origin = { value: new THREE.Vector3() };
    this.size = { value: new THREE.Vector3(TILES, 1, TILES) };
    this.materials = new Set();
    this.version = 0;
    this.uploads = 0;
    this.uploadedBytes = 0;
    this.coveredSections = 0;
  }

  update(position, spec, sections = new Map()) {
    const low = Math.floor(spec.minY / 16), high = Math.ceil(spec.maxY / 16);
    const height = high - low;
    if (!Number.isSafeInteger(height) || height < 1 || TILES * height > 2048)
      throw new RangeError("Distant detail mask exceeds supported world height");
    const origin = new THREE.Vector3(
      Math.floor(position.x / 16) - MAX_RENDER_RADIUS, low,
      Math.floor(position.z / 16) - MAX_RENDER_RADIUS);
    let changed = !origin.equals(this.origin.value);
    this.origin.value.copy(origin);
    if (!this.data || this.size.value.y !== height) {
      this.texture.value?.dispose();
      this.data = new Uint8Array(TILES * TILES * height * 4);
      const texture = new THREE.DataTexture(this.data, TILES, TILES * height);
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.onUpdate = () => { this.uploads++; this.uploadedBytes += this.data.byteLength; };
      this.texture.value = texture;
      for (const material of this.materials) material.distantDetailMaskTexture = texture;
      this.size.value.y = height;
      changed = true;
    }
    // Compare only published slots. Equal cardinality and values also prove
    // that no old slot was removed, avoiding a full-volume scan every frame.
    const offset = (key) => {
      const [cx, cz, sy] = key.split(",").map(Number);
      const x = cx - origin.x, z = cz - origin.z, y = sy - low;
      return x < 0 || x >= TILES || z < 0 || z >= TILES || y < 0 || y >= height
        ? -1 : ((y * TILES + z) * TILES + x) * 4;
    };
    let covered = 0;
    for (const [key, bits] of sections) {
      const at = offset(key);
      if (at < 0 || !bits) continue;
      covered++;
      for (let b = 0; b < 4; b++)
        changed ||= this.data[at + b] !== (bits & (1 << b) ? 255 : 0);
    }
    changed ||= covered !== this.coveredSections;
    if (changed) {
      this.data.fill(0);
      for (const [key, bits] of sections) {
        const at = offset(key);
        if (at < 0) continue;
        for (let b = 0; b < 4; b++) this.data[at + b] = bits & (1 << b) ? 255 : 0;
      }
      this.texture.value.needsUpdate = true;
      this.version++;
    }
    this.coveredSections = covered;
  }

  // CPU oracle mirrors the shader's owning side of a face, including negative
  // coordinates and upper/lower or cross-column canopy boundaries.
  owns(point, normal, batch = 0) {
    if (!this.data) return false;
    const p = point.clone().addScaledVector(this.origin.value, -16)
      .addScaledVector(normal, -0.001).divideScalar(16).floor();
    const size = this.size.value;
    if (p.x < 0 || p.y < 0 || p.z < 0 || p.x >= size.x || p.y >= size.y || p.z >= size.z)
      return false;
    return this.data[((p.y * TILES + p.z) * TILES + p.x) * 4 + batch] > 0;
  }

  install(material, defaultBatch = 0) {
    const compile = material.onBeforeCompile, cacheKey = material.customProgramCacheKey();
    const viewport = { value: new THREE.Vector4() };
    const render = material.onBeforeRender;
    material.onBeforeRender = function (renderer, ...args) {
      render?.call(this, renderer, ...args);
      renderer.getCurrentViewport(viewport.value);
    };
    this.materials.add(material);
    material.distantDetailMaskTexture = this.texture.value;
    material.defaultAttributeValues = { ...material.defaultAttributeValues,
      lodDetailBatch: [defaultBatch], lodDetailChunk: [1e9, 1e9] };
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer);
      Object.assign(shader.uniforms, {
        uLodDetailMask: this.texture, uLodDetailOrigin: this.origin, uLodDetailSize: this.size,
        uDetailViewport: viewport,
        uDetailSubpixels: { value: renderer
          ? 2 ** renderer.getContext().getParameter(renderer.getContext().SUBPIXEL_BITS) : 16 },
      });
      shader.vertexShader = `
        uniform vec3 uLodDetailOrigin;
        attribute float lodDetailBatch;
        attribute vec2 lodDetailChunk;
        flat varying vec2 vDetailChunk;
        flat varying mat3x4 vDetailProjection;
        varying float vDetailBatch;
        varying vec3 vDetailPosition;
        varying vec3 vDetailNormal;
        ${shader.vertexShader}`.replace("#include <begin_vertex>", `
          #include <begin_vertex>
          // LOD objects have chunk-aligned translations. Subtract the equally
          // aligned mask origin before adding local vertices: a large world
          // position would already have lost sub-block and inward-face offsets.
          vec3 detailTranslation = modelMatrix[3].xyz - uLodDetailOrigin * 16.0;
          vDetailPosition = mat3(modelMatrix) * position + detailTranslation;
          vDetailNormal = mat3(modelMatrix) * normal;
          vDetailBatch = lodDetailBatch;
          vDetailChunk = (modelMatrix[3].xz - uLodDetailOrigin.xz * 16.0) / 16.0 + lodDetailChunk;
          mat4 detailProjection = projectionMatrix * modelViewMatrix;
          vec4 detailBase = detailProjection[3] - detailProjection * vec4(detailTranslation, 0.0);
          vDetailProjection = mat3x4(detailProjection[0], detailProjection[2],
            detailBase + detailProjection[1] * vDetailPosition.y);
        `);
      shader.fragmentShader = `
        uniform sampler2D uLodDetailMask;
        uniform vec3 uLodDetailSize;
        uniform vec4 uDetailViewport;
        uniform float uDetailSubpixels;
        varying float vDetailBatch;
        flat varying vec2 vDetailChunk;
        flat varying mat3x4 vDetailProjection;
        varying vec3 vDetailPosition;
        varying vec3 vDetailNormal;
        vec2 detailPixel(vec3 p) {
          vec4 clip = vDetailProjection * vec3(p.x, p.z, 1.0);
          vec2 pixel = uDetailViewport.xy + (clip.xy / clip.w + 1.0) * 0.5 * uDetailViewport.zw;
          return floor(pixel * uDetailSubpixels + 0.5) / uDetailSubpixels;
        }
        float detailEdge(vec2 a, vec2 b, vec2 p) {
          return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        }
        float detailRasterSide(vec3 p, bool xAxis) {
          float boundary = floor((xAxis ? p.x : p.z) / 16.0 + 0.5) * 16.0;
          float along = floor((xAxis ? p.z : p.x) / 16.0) * 16.0;
          vec3 unit = xAxis ? vec3(0.0,0.0,1.0) : vec3(1.0,0.0,0.0);
          vec3 a = xAxis ? vec3(boundary, p.y, along) : vec3(along, p.y, boundary);
          vec3 b = a + unit * 16.0;
          vec2 pa = detailPixel(a), pb = detailPixel(b);
          bool majorX = abs(pb.x - pa.x) > abs(pb.y - pa.y);
          float direction = sign(majorX ? pb.x - pa.x : pb.y - pa.y);
          // Find the unit segment in raster space, including collapsed
          // subpixel segments at grazing angles, in four bounded bisections.
          for (int i = 0; i < 4; i++) {
            vec3 mid = (a + b) * 0.5;
            vec2 pm = detailPixel(mid);
            float delta = majorX ? gl_FragCoord.x - pm.x : gl_FragCoord.y - pm.y;
            if (delta * direction >= 0.0) { a = mid; pa = pm; }
            else { b = mid; pb = pm; }
          }
          vec3 inside = (a + b) * 0.5 + (xAxis ? vec3(1.0,0.0,0.0) : vec3(0.0,0.0,1.0));
          float side = detailEdge(pa, pb, gl_FragCoord.xy);
          float positive = detailEdge(pa, pb, detailPixel(inside));
          vec2 oriented = positive > 0.0 ? pb - pa : pa - pb;
          bool inclusive = oriented.y < 0.0 || (oriented.y == 0.0 && oriented.x > 0.0);
          bool ownsPositive = side * positive > 0.0 || (side == 0.0 && inclusive);
          return boundary / 16.0 - float(!ownsPositive);
        }
        ${shader.fragmentShader}`.replace("#include <clipping_planes_fragment>", `
          #include <clipping_planes_fragment>
          vec3 detailCell = floor((vDetailPosition - normalize(vDetailNormal) * 0.001) / 16.0);
          // Chunk-contained terrain primitives have an exact discrete owner.
          // Do not derive it again from perspective-interpolated edge pixels.
          if (vDetailChunk.x < 1e8) detailCell.xz = vDetailChunk;
          // Native caps use unit edges. Their fixed-point raster footprint can
          // differ from a long coarse edge at a pixel center, even when the
          // ideal world-space edge is identical. Match that footprint without
          // adding geometry or losing relative-coordinate ownership precision.
          if (vDetailChunk.x < 1e8 && vDetailNormal.y > 0.5) {
            vec2 boundary = floor(vDetailPosition.xz / 16.0 + 0.5) * 16.0;
            vec2 close = abs(vDetailPosition.xz - boundary);
            vec2 threshold = max(fwidth(vDetailPosition.xz) / uDetailSubpixels * 2.0, vec2(0.001));
            if (close.x < threshold.x) detailCell.x = detailRasterSide(vDetailPosition, true);
            if (close.y < threshold.y) detailCell.z = detailRasterSide(vDetailPosition, false);
          }
          if (all(greaterThanEqual(detailCell, vec3(0.0))) && all(lessThan(detailCell, uLodDetailSize))) {
            vec2 detailUV = (vec2(detailCell.x, detailCell.y * uLodDetailSize.z + detailCell.z) + 0.5)
              / vec2(uLodDetailSize.x, uLodDetailSize.y * uLodDetailSize.z);
            vec4 detail = texture2D(uLodDetailMask, detailUV);
            float owned = vDetailBatch < 0.5 ? detail.r : vDetailBatch < 1.5 ? detail.g :
              vDetailBatch < 2.5 ? detail.b : detail.a;
            if (owned > 0.5) discard;
          }
        `);
    };
    material.customProgramCacheKey = () => `${cacheKey}/detail-volume-v4/${defaultBatch}`;
  }

  resources() {
    return { cpuBytes: this.data?.byteLength ?? 0, gpuBytes: this.data?.byteLength ?? 0,
      coveredSections: this.coveredSections, version: this.version,
      uploads: this.uploads, uploadedBytes: this.uploadedBytes };
  }

  dispose() {
    this.texture.value?.dispose();
    for (const material of this.materials) delete material.distantDetailMaskTexture;
    this.materials.clear();
    this.texture.value = null;
    this.data = null;
  }
}
