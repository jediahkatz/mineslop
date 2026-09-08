import * as THREE from "three";
import { MAX_RESIDENT_CHUNKS } from "./render-distance.js";
import { NativeBoundaryProfile } from "./native-boundary-profile.js";

// Fixed, reusable instance slots. Publication changes at most the affected
// column's 64 edges per batch; it never recopies a regional geometry prefix.
const EDGES = 64;
export const NATIVE_SEAM_BYTES = MAX_RESIDENT_CHUNKS * EDGES * 6 * 4 * 2 + 216;
const sameProfiles = (a, b) => !!a && !!b && a.length === b.length &&
  a.every((p, i) => p.data === b[i].data && p.bits === b[i].bits);

// Native publication owns this small staging record. It holds no source
// profiles across yields; the native page revision validates each next step.
export class NativeBoundaryPacking {
  constructor(cx, cz) {
    this.cx = cx; this.cz = cz;
    this.chunk = new Float32Array(EDGES * 2 * 2);
    this.edge = new Float32Array(EDGES * 4 * 2);
    this.cursor = 0; this.profile = 0;
    this.top = -1e9; this.low = 1e9; this.high = -1e9;
  }
  get bytes() { return this.chunk.byteLength + this.edge.byteLength; }
  get done() { return this.cursor === EDGES * 2; }
  step(profiles, maxUnits, deadline) {
    let units = 0;
    while (!this.done && units < maxUnits && performance.now() < deadline) {
      if (this.profile < profiles.length) {
        const p = profiles[this.profile++], at = this.cursor * 3;
        if (p.bits & (this.cursor < EDGES ? 1 : 8)) {
          this.top = Math.max(this.top, p.data[at]);
          this.low = Math.min(this.low, p.data[at + 1]);
          this.high = Math.max(this.high, p.data[at + 2]);
        }
      } else {
        const i = this.cursor;
        this.chunk[i * 2] = this.cx; this.chunk[i * 2 + 1] = this.cz;
        this.edge[i * 4] = Math.floor((i % EDGES) / 16);
        this.edge[i * 4 + 1] = i % 16;
        this.edge[i * 4 + 2] = this.top;
        this.edge[i * 4 + 3] = this.high >= this.top - 1e-5 ? this.low : 1e9;
        this.cursor++; this.profile = 0;
        this.top = -1e9; this.low = 1e9; this.high = -1e9;
      }
      units++;
    }
    return units;
  }
}

export class NativeTerrainSeams {
  constructor(parent, mask) {
    this.mask = mask;
    this.group = new THREE.Group();
    this.group.name = "Native terrain boundary reconciliation";
    parent.add(this.group);
    this.columns = new Map();
    this.queue = new Map();
    this.pending = null;
    this.input = null;
    this.stageChunk = new Float32Array(EDGES * 2 * 2);
    this.stageEdge = new Float32Array(EDGES * 4 * 2);
    this.allocatedBytes = NATIVE_SEAM_BYTES + this.stageChunk.byteLength + this.stageEdge.byteLength;
    this.free = Array.from({ length: MAX_RESIDENT_CHUNKS }, (_, i) => MAX_RESIDENT_CHUNKS - 1 - i);
    this.origin = { value: new THREE.Vector2() };
    this.bounds = { value: new THREE.Vector4() };
    this.height = { value: null };
    this.water = { value: 0 };
    this.layers = [0, 3].map(batch => {
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      const chunk = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RESIDENT_CHUNKS * EDGES * 2), 2);
      const edge = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RESIDENT_CHUNKS * EDGES * 4), 4);
      // Slots enter instanceCount only after complete publication. Never scan
      // the entire reserved capacity merely to initialize unused instances.
      chunk.setUsage(THREE.DynamicDrawUsage); edge.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("seamChunk", chunk);
      geometry.setAttribute("seamEdge", edge);
      geometry.instanceCount = 0;
      const material = new THREE.MeshLambertMaterial({
        color: batch === 3 ? "#4e9cac" : "#8b8b82",
        side: THREE.DoubleSide, transparent: batch === 3, opacity: batch === 3 ? 0.72 : 1,
        depthWrite: batch !== 3, forceSinglePass: true,
      });
      mask.install(material, batch);
      const compile = material.onBeforeCompile;
      material.onBeforeCompile = (shader, renderer) => {
        compile(shader, renderer);
        Object.assign(shader.uniforms, {
          uSeamOrigin: this.origin, uSeamBounds: this.bounds,
          uSeamHeight: this.height, uSeamWater: this.water,
        });
        shader.vertexShader = `
          attribute vec2 seamChunk;
          attribute vec4 seamEdge;
          uniform vec2 uSeamOrigin;
          uniform vec4 uSeamBounds;
          uniform sampler2D uSeamHeight;
          uniform float uSeamWater;
          uniform sampler2D uLodDetailMask;
          uniform vec3 uLodDetailSize;
          varying float vSeamActive;
          ${shader.vertexShader}`;
        shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `
          #include <begin_vertex>
          bool xSide = seamEdge.x < 2.0;
          float direction = mod(seamEdge.x, 2.0) > 0.5 ? 1.0 : -1.0;
          vec3 seamNormal = xSide ? vec3(-direction,0.0,0.0) : vec3(0.0,0.0,-direction);
          vec2 base = (seamChunk - uSeamOrigin) * 16.0;
          vec2 edgeAt = xSide ? vec2(direction > 0.0 ? 16.0 : 0.0, seamEdge.y + 0.5)
                             : vec2(seamEdge.y + 0.5, direction > 0.0 ? 16.0 : 0.0);
          vec2 outside = base + edgeAt - seamNormal.xz * 0.01;
          vec2 uv = (outside - uSeamBounds.xy) / uSeamBounds.zw;
          float lodTop = ${batch === 3 ? "uSeamWater" : "texture2D(uSeamHeight, uv).r"};
          float low = min(lodTop, seamEdge.z);
          float high = lodTop >= seamEdge.z ? lodTop : min(seamEdge.z, seamEdge.w);
          vec3 owner = vec3(seamChunk.x - uLodDetailOrigin.x,
            floor((seamEdge.z - 0.001) / 16.0) - uLodDetailOrigin.y,
            seamChunk.y - uLodDetailOrigin.z);
          vec2 ownerUV = (vec2(owner.x, owner.y * uLodDetailSize.z + owner.z) + 0.5)
            / vec2(uLodDetailSize.x, uLodDetailSize.y * uLodDetailSize.z);
          vec4 owned = texture2D(uLodDetailMask, ownerUV);
          vSeamActive = float(seamEdge.z > -1e8 && high > low &&
            all(greaterThanEqual(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))) &&
            all(greaterThanEqual(owner, vec3(0.0))) && all(lessThan(owner, uLodDetailSize))) *
            ${batch === 3 ? "owned.a" : "owned.r"};
          vec2 at = base + (xSide ? vec2(edgeAt.x, seamEdge.y + position.x)
                                 : vec2(seamEdge.y + position.x, edgeAt.y));
          transformed = vec3(at.x, mix(low, high, position.y), at.y);
          if (vSeamActive < 0.5) transformed = vec3(0.0);
        `).replace("mat3(modelMatrix) * position + detailTranslation",
          "mat3(modelMatrix) * transformed + detailTranslation")
          .replace("mat3(modelMatrix) * normal;", "mat3(modelMatrix) * seamNormal;");
        shader.fragmentShader = `varying float vSeamActive;\n${shader.fragmentShader}`
          .replace("#include <clipping_planes_fragment>",
            "#include <clipping_planes_fragment>\nif (vSeamActive < 0.5) discard;");
      };
      const cache = material.customProgramCacheKey;
      material.customProgramCacheKey = () => `${cache()}/native-boundary-v1`;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      if (batch === 3) mesh.renderOrder = 2;
      this.group.add(mesh);
      return { mesh, geometry, material, chunk, edge };
    });
  }

  setSurface(data, texture) {
    this.group.position.set(data.originX, 0, data.originZ);
    this.origin.value.set(data.originX / 16, data.originZ / 16);
    this.bounds.value.set(data.bounds.minX - data.originX, data.bounds.minZ - data.originZ,
      data.bounds.maxX - data.bounds.minX, data.bounds.maxZ - data.bounds.minZ);
    this.height.value = texture;
    for (const layer of this.layers) layer.material.nativeBoundaryHeightTexture = texture;
    this.water.value = data.waterSurface ?? -1e9;
    this.group.updateWorldMatrix(true, true);
  }

  update(columns, { maxUnits = Infinity, deadline = Infinity } = {}) {
    if (maxUnits <= 0 || performance.now() >= deadline)
      return { units: 0, copyBytes: 0, pendingColumns: this.queue.size };
    let units = 0, copyBytes = 0, scanned = 0;
    if (columns !== this.input) {
      if (columns.size > MAX_RESIDENT_CHUNKS) throw new RangeError("Native boundary residency exceeds native chunk cap");
      for (const key of this.columns.keys()) {
        if (!columns.has(key)) this.queue.set(key, []);
        scanned++;
      }
      for (const [key, profiles] of columns) {
        if (profiles.length > 128) throw new RangeError("Native boundary column exceeds supported vertical residency");
        if (!sameProfiles(this.columns.get(key)?.profiles, profiles)) this.queue.set(key, profiles);
        else this.queue.delete(key);
        scanned += 1 + profiles.length;
      }
      for (const key of this.queue.keys())
        if (!columns.has(key) && !this.columns.has(key)) this.queue.delete(key);
      this.input = columns;
      // A metadata unit is a bounded block of 256 map/profile-reference checks.
      units += Math.ceil(scanned / 256);
      if (this.pending && !sameProfiles(this.pending.profiles, this.queue.get(this.pending.key)))
        this.pending = null;
    }
    while (this.queue.size && units < maxUnits && performance.now() < deadline) {
      if (!this.pending) {
        const [key, profiles] = this.queue.entries().next().value;
        const [cx, cz] = key.split(",").map(Number);
        this.pending = { key, profiles, cx, cz, edge: 0, profile: 0,
          top: -1e9, low: 1e9, high: -1e9 };
        units++;
        continue;
      }
      const p = this.pending;
      if (p.edge < EDGES * 2) {
        const batch = Math.floor(p.edge / EDGES), bit = batch ? 8 : 1;
        if (p.profile < p.profiles.length) {
          const profile = p.profiles[p.profile++], at = p.edge * 3;
          if (profile.bits & bit) {
            p.top = Math.max(p.top, profile.data[at]);
            p.low = Math.min(p.low, profile.data[at + 1]);
            p.high = Math.max(p.high, profile.data[at + 2]);
          }
        } else {
          const edge = p.edge % EDGES;
          this.stageChunk.set([p.cx, p.cz], p.edge * 2);
          this.stageEdge.set([Math.floor(edge / 16), edge % 16, p.top,
            p.high >= p.top - 1e-5 ? p.low : 1e9], p.edge * 4);
          p.edge++; p.profile = 0; p.top = -1e9; p.low = 1e9; p.high = -1e9;
        }
        units++;
        continue;
      }
      // One 3 KiB atomic upload publication; 64 copied bytes per work unit.
      // All profile reads/staging writes yield individually before this point.
      const bytes = this.stageChunk.byteLength + this.stageEdge.byteLength;
      const cost = bytes / 64;
      if (units + cost > maxUnits) break;
      const slot = this.columns.get(p.key)?.slot ?? this.free.pop();
      if (slot === undefined) throw new RangeError("Native boundary residency exceeds native chunk cap");
      for (let b = 0; b < 2; b++) {
        const layer = this.layers[b], start = slot * EDGES;
        layer.chunk.array.set(this.stageChunk.subarray(b * EDGES * 2, (b + 1) * EDGES * 2), start * 2);
        layer.edge.array.set(this.stageEdge.subarray(b * EDGES * 4, (b + 1) * EDGES * 4), start * 4);
        layer.geometry.instanceCount = Math.max(layer.geometry.instanceCount, (slot + 1) * EDGES);
        layer.chunk.addUpdateRange(start * 2, EDGES * 2);
        layer.edge.addUpdateRange(start * 4, EDGES * 4);
        layer.chunk.needsUpdate = layer.edge.needsUpdate = true;
      }
      if (p.profiles.length) this.columns.set(p.key, { slot, profiles: p.profiles });
      else { this.columns.delete(p.key); this.free.push(slot); }
      this.queue.delete(p.key);
      this.pending = null;
      units += cost;
      copyBytes += bytes;
    }
    return { units, copyBytes, pendingColumns: this.queue.size };
  }

  publishPacked(key, profiles, packing) {
    if (!packing.done) throw new Error("Native boundary publication requires a complete packing record");
    const slot = this.columns.get(key)?.slot ?? this.free.pop();
    if (slot === undefined) throw new RangeError("Native boundary residency exceeds native chunk cap");
    for (let b = 0; b < 2; b++) {
      const layer = this.layers[b], start = slot * EDGES;
      layer.chunk.array.set(packing.chunk.subarray(b * EDGES * 2, (b + 1) * EDGES * 2), start * 2);
      layer.edge.array.set(packing.edge.subarray(b * EDGES * 4, (b + 1) * EDGES * 4), start * 4);
      layer.geometry.instanceCount = Math.max(layer.geometry.instanceCount, (slot + 1) * EDGES);
      layer.chunk.addUpdateRange(start * 2, EDGES * 2);
      layer.edge.addUpdateRange(start * 4, EDGES * 4);
      layer.chunk.needsUpdate = layer.edge.needsUpdate = true;
    }
    if (profiles.length) this.columns.set(key, { slot, profiles });
    else { this.columns.delete(key); this.free.push(slot); }
    this.queue.delete(key);
    if (this.pending?.key === key) this.pending = null;
    return packing.bytes;
  }

  dispose() {
    for (const layer of this.layers) {
      this.mask.materials.delete(layer.material);
      delete layer.material.distantDetailMaskTexture;
      delete layer.material.nativeBoundaryHeightTexture;
      layer.geometry.dispose(); layer.material.dispose();
    }
    this.group.removeFromParent();
    this.columns.clear();
    this.queue.clear();
    this.pending = null;
    this.input = null;
    this.stageChunk = this.stageEdge = null;
    this.layers = [];
    this.height.value = null;
  }
}

// Direct renderer fixtures/legacy chunks have no precomputed section profile.
// Their mesh is inspected once, incrementally, before the first LOD publication.
export function* sceneBoundarySources(scene, exclude, coverage, state) {
  const columns = new Map(), stack = [scene];
  while (stack.length) {
    const mesh = stack.pop();
    if (mesh === exclude) continue;
    stack.push(...mesh.children);
    if (mesh.isMesh && mesh.geometry?.index) {
      mesh.updateWorldMatrix(true, false);
      const cx = Math.floor(mesh.matrixWorld.elements[12] / 16);
      const cz = Math.floor(mesh.matrixWorld.elements[14] / 16);
      const key = `${cx},${cz}`;
      if (coverage.has(key)) {
        const parts = columns.get(key) ?? [];
        const transform = new THREE.Matrix4().makeTranslation(-cx * 16, 0, -cz * 16).multiply(mesh.matrixWorld);
        parts.push({ [mesh.userData.batch === "water" ? "water" : "opaque"]: mesh.geometry, transform });
        columns.set(key, parts);
      }
    }
    yield { units: 1 };
  }
  for (const key of coverage) {
    const profile = state.profile = new NativeBoundaryProfile(columns.get(key) ?? []);
    while (!profile.done) { const units = profile.step(32, Infinity); yield { units }; }
    yield { key, profile: profile.data, units: 1 };
    state.profile = null;
  }
}
