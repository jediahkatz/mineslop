import * as THREE from "three";
import { BIOME_PROFILES } from "./biomes.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import {
  distantGridCells,
  DISTANT_GRID_LIMITS,
  DISTANT_NATIVE_GRID_LIMITS,
  landmarkGridRefinement,
  DISTANT_QUALITY,
} from "./distant-grid.js";
import {
  createDistantVegetationCache,
  createDistantVegetationJob,
} from "./distant-vegetation.js";
import { DistantTerraces } from "./distant-terraces.js";
import { DistantLandmarks } from "./distant-landmarks.js";
import { DistantDetailMask } from "./distant-detail-mask.js";
import { installDistantSurface } from "./distant-surface-material.js";
import { visualHorizon } from "./end-visual-policy.js";
import { geometryEpoch, geometryWorldSpec } from "./geometry-world.js";
import { noise, seedHash } from "./noise.js";
import { getBiomeTint } from "./mesh-palette.js";
import { MAX_RENDER_RADIUS } from "./render-distance.js";
import { certifySurfaceRegion, surfaceIdentity, SurfaceRegionValidation } from "./surface-availability.js";
import { NativeBoundaryPacking, NativeTerrainSeams, NATIVE_SEAM_BYTES, sceneBoundarySources } from "./native-terrain-seams.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "./terrain.js";

export const DISTANT_TERRAIN_LIMITS = Object.freeze({
  samplesPerUpdate: 128,
  workPerUpdate: 512,
  cachedSamples: 8192,
  nativeCachedSamples: 16384,
  maxBudgetMs: 4,
});
const EDGE_MARGIN = 8;
const REBUILD_MARGIN = CHUNK_SIZE * 2;

function contains(bounds, area) {
  return (
    bounds.minX <= Math.max(WORLD_MIN, area.minX) &&
    bounds.maxX >= Math.min(WORLD_MAX, area.maxX) &&
    bounds.minZ <= Math.max(WORLD_MIN, area.minZ) &&
    bounds.maxZ >= Math.min(WORLD_MAX, area.maxZ)
  );
}

function edgeDistance(bounds, position) {
  // The real world edge is intentional empty space, not a missing streamed
  // row. It must not black out the entire inland view when standing beside it.
  return Math.min(
    bounds.minX === WORLD_MIN
      ? Infinity
      : position.x - bounds.minX - EDGE_MARGIN,
    bounds.maxX === WORLD_MAX
      ? Infinity
      : bounds.maxX - position.x - EDGE_MARGIN,
    bounds.minZ === WORLD_MIN
      ? Infinity
      : position.z - bounds.minZ - EDGE_MARGIN,
    bounds.maxZ === WORLD_MAX
      ? Infinity
      : bounds.maxZ - position.z - EDGE_MARGIN
  );
}

function color(value, fallback) {
  return new THREE.Color(
    typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback
  );
}

function disposeLayer(layer) {
  if (!layer) return;
  layer.terrain.geometry.dispose();
  layer.water?.geometry.dispose();
  layer.heightTexture?.dispose();
  layer.group.removeFromParent();
}

function geometry(positions, normals, colors, indices, bounds) {
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  result.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  result.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const Index = positions.length / 3 > 65536 ? Uint32Array : Uint16Array;
  result.setIndex(
    new THREE.BufferAttribute(ArrayBuffer.isView(indices) ? indices : new Index(indices), 1).setUsage(
      THREE.DynamicDrawUsage
    )
  );
  result.setDrawRange(0, 0);
  result.boundingBox = bounds;
  result.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
  return result;
}

// Visual-only fallback, including underneath unfinished detail rows. It never
// loads chunks, applies edits, or supplies collision data. Only an authoritative
// visible chunk mesh (including a completely edited-away chunk) can cut it out.
export class DistantTerrain {
  constructor(scene, world, { vegetationLimits, atlas } = {}) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = "Distant terrain";
    this.group.visible = false;
    scene.add(this.group);
    this._terrainMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });
    this._atlas = atlas;
    this._surfaceVersion = installDistantSurface(this._terrainMaterial, atlas);
    this._waterMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    this.detailMask = new DistantDetailMask();
    this.detailMask.install(this._terrainMaterial);
    this.detailMask.install(this._waterMaterial, 3);
    this._active = null;
    this._job = null;
    this._vegetation = null;
    this._vegetationJob = null;
    this._vegetationRejected = null;
    this._vegetationLimits = vegetationLimits;
    this.vegetationRejections = 0;
    this.lastWork = { units: 0, samples: 0 };
    this._identity = null;
    this._biomeId = null;
    this._samples = new Map();
    this._treeSamples = createDistantVegetationCache();
    this._colors = new Map();
    this._fogDistance = 0;
    this._disposed = false;
    this.publication = { state: "empty", reason: null, request: null };
    this._availabilityCache = new Map();
    this._sceneRevision = 0;
    this._sceneChanged = event => { if (event.child !== this.group) this._sceneRevision++; };
    scene.addEventListener("childadded", this._sceneChanged);
    scene.addEventListener("childremoved", this._sceneChanged);
    this._beforeSceneRender = scene.onBeforeRender;
    this._sceneRender = (...args) => {
      this._beforeSceneRender.apply(scene, args);
      if (this.group.visible && this._active && this._lastRequest && this._nativeBoundaries === undefined) {
        const work = this._updateNativeSeams(this._lastRequest,
          performance.now() + DISTANT_TERRAIN_LIMITS.maxBudgetMs,
          DISTANT_TERRAIN_LIMITS.workPerUpdate - this.lastWork.units);
        this.lastWork.units += work.units;
        this.lastWork.copyBytes = (this.lastWork.copyBytes ?? 0) + work.copyBytes;
      }
    };
    scene.onBeforeRender = this._sceneRender;
  }

  get ready() {
    return !this._disposed && this.group.visible && this._active !== null;
  }

  get fogDistance() {
    return this.ready ? this._fogDistance : 0;
  }

  get terrainCoverageComplete() {
    return this.ready && this._terrainCoverageComplete === true;
  }

  setDaylight(lighting) {
    lighting.install(this._terrainMaterial, true);
    lighting.install(this._waterMaterial, true);
    // Vegetation uses the same terrain material, including future LOD jobs.
  }

  resources() {
    const cpu = new Set(), gpu = new Set(), staging = new Set();
    const retain = (target, value) => { if (ArrayBuffer.isView(value)) target.add(value.buffer); };
    const fields = (target, object) => Object.values(object ?? {}).forEach(value => retain(target, value));
    const mesh = object => {
      if (!object?.geometry) return;
      for (const attribute of Object.values(object.geometry.attributes)) {
        retain(cpu, attribute.array); retain(gpu, attribute.array);
      }
      retain(cpu, object.geometry.index?.array); retain(gpu, object.geometry.index?.array);
    };
    fields(cpu, this._active?.data);
    fields(cpu, this._active?.data.terraces);
    mesh(this._active?.terrain); mesh(this._active?.water);
    retain(gpu, this._active?.data.seamHeights);
    mesh(this._vegetation?.layer.mesh);
    retain(cpu, this._vegetation?.layer._sourceIndices);
    for (const layer of this._seams?.layers ?? []) mesh(layer.mesh);
    retain(staging, this._seams?.stageChunk);
    retain(staging, this._seams?.stageEdge);
    const nativeOwners = this._nativeBoundaryOwners ?? new Set(
      [...(this._nativeBoundaries?.values() ?? [])].flatMap(profiles => profiles.map(p => p.data.buffer)));
    // A yielded replacement can retain an old immutable profile after native
    // publication retired it. Count that backing here, but never count a
    // currently native-owned buffer twice (including hidden native sections).
    for (const profiles of [
      ...[...(this._seams?.columns.values() ?? [])].map(column => column.profiles),
      ...(this._seams?.queue.values() ?? []),
      ...(this._seams?.input?.values() ?? []),
    ])
      for (const profile of profiles)
        if (!nativeOwners.has(profile.data.buffer)) retain(cpu, profile.data);
    if (this._nativeBoundaries === undefined)
      for (const profiles of this._legacyBoundaryColumns?.values() ?? [])
        for (const profile of profiles) retain(cpu, profile.data);
    retain(staging, this._legacyBoundaryState?.profile?.data);
    fields(staging, this._job);
    fields(staging, this._job?.terraces);
    fields(staging, this._job?.terraceBuilder);
    for (const buffer of cpu) staging.delete(buffer);
    const bytes = buffers => [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
    return { cpuBytes: bytes(cpu), gpuBytes: bytes(gpu), stagingBytes: bytes(staging),
      // JS array capacity is engine-owned; this is a logical element count,
      // deliberately separate from exact typed backing capacities.
      pendingCanopyElements: ["_positions", "_normals", "_colors", "_detailBatches", "_indices"]
        .reduce((sum, key) => sum + (this._vegetationJob?.job[key]?.length ?? 0), 0) };
  }

  _sameIdentity(identity) {
    return (
      identity &&
      identity.generator === this.world.generator &&
      identity.seed === this.world.seed &&
      identity.version === this.world.generatorVersion &&
      identity.epoch === geometryEpoch(this.world) &&
      identity.surface === surfaceIdentity(this.world) &&
      identity.heightSource === this.world.generator.terrainHeight &&
      identity.biomeSource === this.world.generator.getBiome &&
      identity.columnSource === this.world.generator.sampleColumn &&
      identity.landmarkSource === this.world.generator.getEndPillars &&
      identity.worldDimension === this.world.dimension
    );
  }

  _clear() {
    this._seams?.dispose();
    this._seams = null;
    this._legacyBoundaryJob = null;
    this._legacyBoundaryState = null;
    this._legacyBoundaryColumns = null;
    this._nativeBoundaries = null;
    this._nativeBoundaryOwners = null;
    this._nativePreparation = null;
    this._seamBlocked = null;
    this._legacyBoundaryKey = null;
    this._lastRequest = null;
    this._availabilityCache.clear();
    this.publication = { state: "empty", reason: null, request: null };
    this._landmarks?.dispose();
    this._landmarks = null;
    this._job = null;
    this._vegetationJob?.job.dispose();
    this._vegetationJob = null;
    this._vegetationRejected = null;
    this._vegetation?.layer.dispose();
    this._vegetation = null;
    disposeLayer(this._active);
    this._active = null;
    this._samples.clear();
    this._treeSamples.clear();
    this._colors.clear();
    this._biomeId = null;
    this._fogDistance = 0;
    this.group.visible = false;
  }

  _request(position, radius, quality, dimension, coverage, bootstrap = false) {
    const cx = Math.floor(position.x / CHUNK_SIZE);
    const cz = Math.floor(position.z / CHUNK_SIZE);
    const fullHorizon = dimension === "overworld"
      ? Math.max(visualHorizon(dimension, quality), radius * CHUNK_SIZE)
      : visualHorizon(dimension, quality);
    const horizon = bootstrap ? Math.min(192, fullHorizon) : fullHorizon;
    const extent = horizon + REBUILD_MARGIN;
    return {
      cx,
      cz,
      radius,
      quality,
      dimension,
      bootstrap,
      horizon,
      key: `${cx},${cz}:${radius}:${quality}`,
      coverage,
      coverageKey: [...coverage].sort().join(";"),
      bounds: {
        minX: Math.max(WORLD_MIN, cx * CHUNK_SIZE - extent),
        maxX: Math.min(WORLD_MAX, (cx + 1) * CHUNK_SIZE + extent),
        minZ: Math.max(WORLD_MIN, cz * CHUNK_SIZE - extent),
        maxZ: Math.min(WORLD_MAX, (cz + 1) * CHUNK_SIZE + extent),
      },
      hole: {
        minX: (cx - radius) * CHUNK_SIZE,
        maxX: (cx + radius + 1) * CHUNK_SIZE,
        minZ: (cz - radius) * CHUNK_SIZE,
        maxZ: (cz + radius + 1) * CHUNK_SIZE,
      },
    };
  }

  _canCover(data, request) {
    // A startup surface may be smaller than the requested detail square after
    // movement. Retain it while the camera is inside; edgeDistance still caps
    // fog to the actually drawn bounds, without inventing any outside coverage.
    if (data.request.bootstrap)
      return contains(data.bounds, {
        minX: request.cx * CHUNK_SIZE, maxX: (request.cx + 1) * CHUNK_SIZE,
        minZ: request.cz * CHUNK_SIZE, maxZ: (request.cz + 1) * CHUNK_SIZE,
      });
    return contains(data.bounds, request.hole);
  }

  _needsJob(previous, request) {
    return (
      !previous ||
      (previous.bootstrap && !request.bootstrap) ||
      previous.quality !== request.quality ||
      previous.horizon !== request.horizon ||
      previous.radius !== request.radius ||
      Math.max(
        Math.abs(previous.cx - request.cx),
        Math.abs(previous.cz - request.cz)
      ) >= 2
    );
  }

  _startJob(request) {
    const spec = geometryWorldSpec(this.world, request.dimension);
    const waterSurface =
      request.dimension === "overworld" && Number.isFinite(spec.seaLevel)
        ? spec.seaLevel + 0.88
        : null;
    const originX = request.cx * CHUNK_SIZE;
    const originZ = request.cz * CHUNK_SIZE;
    const native = !request.bootstrap && request.dimension === "overworld" &&
      (typeof this.world.generator.getEndPillars === "function" ||
       typeof this.world.generator.sampleColumn === "function");
    const pillars = request.dimension === "end"
      ? (this.world.generator.getEndPillars?.() ?? []).filter((p) =>
        p.x + 2 >= request.bounds.minX && p.x - 2 < request.bounds.maxX &&
        p.z + 2 >= request.bounds.minZ && p.z - 2 < request.bounds.maxZ)
      : [];
    const limits = native || pillars.length ? DISTANT_NATIVE_GRID_LIMITS : DISTANT_GRID_LIMITS;
    const refinement = new Map();
    const certificate = request.dimension === "overworld" && request.radius > 8
      ? certifySurfaceRegion(this.world, request.bounds) : null;
    const validation = request.dimension === "overworld" && request.radius > 8 && !certificate
      ? new SurfaceRegionValidation(this.world, request.bounds, request, spec.minY, this._availabilityCache)
      : null;
    // Keep interior vertices too: rows restore immediately using index changes,
    // even when generation or meshing is stalled and the player reverses.
    return {
      request,
      spec,
      waterSurface,
      originX,
      originZ,
      limits,
      refinement,
      certificate,
      validation,
      chunkOwnership: request.dimension === "overworld" && request.radius > 8,
      planCursor: 0,
      landmarkPlan: landmarkGridRefinement(pillars),
      landmarkReachSquared: pillars.length
        ? (Math.max(...pillars.map((p) => Math.hypot(p.x, p.z))) + 3 * CHUNK_SIZE) ** 2 : 0,
      grid: distantGridCells(
        request.cx,
        request.cz,
        request.bounds,
        request.quality,
        refinement,
        request.bootstrap
      ),
      points: [],
      pointIds: new Map(),
      cells: [],
      wetCells: 0,
      wet: [],
      unknownChunks: validation?.unknown ?? new Set(),
      geometryUnknown: new Set(),
      indices: new Uint16Array(limits.indices),
      indexCount: 0,
      count: 0,
      bounds: request.bounds,
      identity: this._identity,
      phase: pillars.length ? "landmark-plan" : native ? "plan" : "sample",
      cursor: 0,
      minHeight: Infinity,
      maxHeight: -Infinity,
      allValid: true,
      heights: new Float32Array(limits.vertices),
      valid: new Uint8Array(limits.vertices),
      badlands: new Uint8Array(limits.vertices),
      surfaceData: new Float32Array(limits.vertices * 3),
      blockData: this._atlas ? new Uint16Array(limits.vertices * 3) : null,
      positions: new Float32Array(limits.vertices * 3),
      normals: new Float32Array(limits.vertices * 3),
      colors: new Float32Array(limits.vertices * 3),
      rockColors: new Float32Array(limits.vertices * 3),
      waterPositions:
        waterSurface !== null
          ? new Float32Array(limits.vertices * 3)
          : null,
      waterColors:
        waterSurface !== null
          ? new Float32Array(limits.vertices * 3)
          : null,
    };
  }

  _cell(job, cell) {
    const point = ([x, z]) => {
      const key = `${x},${z}`;
      if (job.pointIds.has(key)) return job.pointIds.get(key);
      if (job.count >= job.limits.vertices)
        throw new RangeError("Distant terrain exceeded its vertex budget");
      const index = job.count++;
      job.pointIds.set(key, index);
      job.points.push([x - job.originX, z - job.originZ]);
      return index;
    };
    const ring = cell.boundary.map(point);
    const indices = cell.center
      ? ring.flatMap((vertex, i) => [
          point(cell.center),
          vertex,
          ring[(i + 1) % ring.length],
        ])
      : [ring[0], ring[1], ring[2], ring[0], ring[2], ring[3]];
    if (
      job.cells.length >= job.limits.cells ||
      job.indexCount + indices.length > job.limits.indices
    )
      throw new RangeError("Distant terrain exceeded its topology budget");
    job.cells.push({
      key: `${cell.cx},${cell.cz}`,
      ring,
      step: Math.max(...cell.boundary.map(([x]) => x)) - cell.boundary[0][0],
      start: job.indexCount,
      count: indices.length,
      valid: false,
      wet: false,
    });
    job.indices.set(indices, job.indexCount);
    job.indexCount += indices.length;
    job.minCellStep = Math.min(job.minCellStep ?? Infinity, job.cells.at(-1).step);
  }

  _palette(biome, surfaceId) {
    const profile = BIOME_PROFILES[biome?.id];
    const surface = surfaceId ?? profile?.surface;
    const ground =
      surface === BLOCK.GRASS
        ? biome.grassColor
        : (BLOCKS[surface]?.color ?? biome?.color);
    const rock = BLOCKS[profile?.rock]?.color ?? ground;
    const key = `${surface}:${ground}:${biome?.waterColor}:${rock}`;
    if (this._colors.has(key)) return this._colors.get(key);
    const palette = [
      ...(this._atlas ? getBiomeTint(surface, "top", biome) : color(ground, "#83ac52").toArray()),
      ...color(biome?.waterColor, "#489fbb").toArray(),
      ...color(rock, "#8b8b82").toArray(),
    ];
    this._colors.set(key, palette);
    if (this._colors.size > 256)
      this._colors.delete(this._colors.keys().next().value);
    return palette;
  }

  _sample(job) {
    const at = job.cursor;
    const [localX, localZ] = job.points[at];
    const worldX = Math.min(WORLD_MAX - 1, job.originX + localX);
    const worldZ = Math.min(WORLD_MAX - 1, job.originZ + localZ);
    const key = `${worldX},${worldZ}`;
    let sample = this._samples.get(key);
    const uncached = !sample;
    if (!sample) {
      const generator = job.identity.generator;
      const top = generator.terrainHeight(worldX, worldZ);
      const valid = Number.isFinite(top) && top >= job.spec.minY;
      const biome = generator.getBiome(worldX, worldZ);
      const nativeColumn = this._atlas || biome?.category === "badlands"
        ? generator.sampleColumn?.(worldX, worldZ) : null;
      const profile = BIOME_PROFILES[biome?.id];
      const surface = nativeColumn?.surface ?? profile?.surface ?? BLOCK.STONE;
      sample = {
        valid,
        height: valid
          ? Math.min(job.spec.maxY - 1, Math.floor(top)) + 1
          : job.spec.minY,
        palette: this._palette(biome, this._atlas ? surface : undefined),
        blocks: this._atlas
          ? [surface, nativeColumn?.soil ?? profile?.soil ?? surface,
            job.request.dimension === "overworld" && job.identity.version >= 4
              ? BLOCK.STONE : profile?.rock ?? surface]
          : null,
        badlands: biome?.category === "badlands",
        strataOffset: biome?.category === "badlands" ? (nativeColumn?.strataOffset ??
          Math.floor(noise(worldX / 180, worldZ / 180, seedHash(String(job.identity.seed).slice(0, 80)) ^ 1811) * 3)) : 0,
        landTop: nativeColumn?.landTop ?? top,
      };
      this._samples.set(key, sample);
      const cacheLimit = job.refinement.size
        ? DISTANT_TERRAIN_LIMITS.nativeCachedSamples
        : DISTANT_TERRAIN_LIMITS.cachedSamples;
      if (this._samples.size > cacheLimit) {
        this._samples.delete(this._samples.keys().next().value);
      }
    }
    job.heights[at] = sample.height;
    job.valid[at] = Number(sample.valid);
    job.badlands[at] = Number(sample.badlands);
    job.surfaceData.set([sample.strataOffset, Number.isFinite(sample.landTop) ? sample.landTop : job.spec.minY, Number(sample.badlands)], at * 3);
    if (job.blockData) job.blockData.set(sample.blocks, at * 3);
    job.minHeight = Math.min(job.minHeight, sample.height);
    job.maxHeight = Math.max(job.maxHeight, sample.height);
    job.allValid &&= sample.valid;
    job.positions.set([localX, sample.height, localZ], at * 3);
    job.colors.set(sample.palette.slice(0, 3), at * 3);
    job.rockColors.set(sample.palette.slice(6, 9), at * 3);
    if (job.waterPositions) {
      job.waterPositions.set([localX, job.waterSurface, localZ], at * 3);
      job.waterColors.set(sample.palette.slice(3, 6), at * 3);
    }
    return Number(uncached);
  }

  _normal(job) {
    const cell = job.cells[job.cursor];
    const end = cell.start + cell.count;
    for (let i = cell.start; i < end; i++) {
      const vertex = job.indices[i];
      if (!job.valid[vertex]) {
        if (job.request.dimension === "overworld") {
          job.unknownChunks.add(cell.key);
          job.geometryUnknown.add(cell.key);
        }
        return;
      }
    }
    cell.valid = true;
    cell.anchor = cell.ring[0];
    const centerX = job.originX + job.positions[cell.anchor * 3] + cell.step / 2;
    const centerZ = job.originZ + job.positions[cell.anchor * 3 + 2] + cell.step / 2;
    if (cell.step >= 2 && centerX * centerX + centerZ * centerZ < job.landmarkReachSquared) {
      // Even a two-block foundation cell can straddle a native height change.
      // Keep its lowest sampled cap so an inflated terrace/riser cannot bury
      // the adjacent pillar base. This does not change the native pillar body.
      for (const vertex of cell.ring)
        if (job.heights[vertex] < job.heights[cell.anchor]) cell.anchor = vertex;
    }
    if (cell.step >= 8 && job.badlands[cell.anchor]) {
      const sorted = cell.ring.toSorted((a, b) => job.heights[a] - job.heights[b]);
      cell.anchor = sorted[Math.floor((sorted.length - 1) / 2)];
    }
    cell.height = job.heights[cell.anchor];
    cell.x = job.positions[cell.ring[0] * 3];
    cell.z = job.positions[cell.ring[0] * 3 + 2];
    cell.wet =
      job.waterSurface !== null &&
      job.heights[cell.anchor] < job.waterSurface;
    if (cell.wet) {
      job.wetCells++;
      job.wet.push(cell);
    }
    // Native sample slopes only select the rock/grass palette. The rendered
    // terraces replace these with hard, axis-aligned top and riser normals.
    const p = job.positions;
    for (let i = cell.start; i < end; i += 3) {
      const a = job.indices[i] * 3;
      const b = job.indices[i + 1] * 3;
      const c = job.indices[i + 2] * 3;
      const ux = p[b] - p[a],
        uy = p[b + 1] - p[a + 1],
        uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a],
        vy = p[c + 1] - p[a + 1],
        vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const offset of [a, b, c]) {
        job.normals[offset] += nx;
        job.normals[offset + 1] += ny;
        job.normals[offset + 2] += nz;
      }
    }
  }

  _shade(job) {
    const offset = job.cursor * 3;
    const n = job.normals;
    const length = Math.hypot(n[offset], n[offset + 1], n[offset + 2]);
    if (length > 0) {
      n[offset] /= length;
      n[offset + 1] /= length;
      n[offset + 2] /= length;
    } else n[offset + 1] = 1;
    // Atlas colors are native tint ratios, not albedo. A hard cap must not
    // acquire a rock blend from a slope that is absent from its geometry.
    if (this._atlas || job.request.dimension !== "overworld") return;
    const [x, z] = job.points[job.cursor];
    const variation =
      0.94 +
      noise(
        (x + job.originX) / 31,
        (z + job.originZ) / 31,
        job.identity.styleSeed
      ) * 0.12;
    const exposedRock = Math.min(0.7, Math.max(0, (1 - n[offset + 1] - 0.08) * 2));
    for (let i = offset; i < offset + 3; i++)
      job.colors[i] =
        THREE.MathUtils.lerp(job.colors[i], job.rockColors[i], exposedRock) *
        variation;
  }

  _cutout(layer, request) {
    const data = layer.data;
    let terrainCount = 0,
      waterCount = 0;
    const terrainIndices = layer.terrain.geometry.index.array;
    const waterIndices = layer.water?.geometry.index.array;
    // Cell refinement must not multiply coverage/publication work. Emission
    // keeps each chunk's terrain indices contiguous, so copy whole ranges.
    if (data.chunkOwnership) {
      // The shader resolves unit-edge raster ownership, including fragments
      // crossing the ideal coarse boundary. Borrow the immutable source index
      // buffer; coverage changes must not recopy a full terrain prefix.
      terrainCount = data.terraces.ranges.every(range => request.coverage.has(range.key))
        ? 0 : data.terraces.indices.length;
    } else for (const range of data.terraces.ranges) {
      if (request.coverage.has(range.key)) continue;
      terrainIndices.set(data.terraces.indices.subarray(range.start, range.start + range.count), terrainCount);
      terrainCount += range.count;
    }
    if (waterIndices) {
      for (const cell of data.wet) {
        if (request.coverage.has(cell.key)) continue;
        for (let i = cell.start; i < cell.start + cell.count; i++)
          waterIndices[waterCount++] = data.indices[i];
      }
    }
    layer.terrain.geometry.setDrawRange(0, terrainCount);
    if (!data.chunkOwnership) layer.terrain.geometry.index.needsUpdate = true;
    layer.terrain.visible = terrainCount > 0;
    if (layer.water) {
      layer.water.geometry.setDrawRange(0, waterCount);
      layer.water.geometry.index.needsUpdate = true;
      layer.water.visible = waterCount > 0;
    }
    layer.viewKey = request.coverageKey;
    layer.group.userData.coveredChunks = request.coverage.size;
    this._workCopyBytes = (this._workCopyBytes ?? 0) +
      (data.chunkOwnership ? 0 : terrainCount * terrainIndices.BYTES_PER_ELEMENT) +
      waterCount * (waterIndices?.BYTES_PER_ELEMENT ?? 0);
  }

  _publish(job, request) {
    if (this._job !== job || !this._sameIdentity(job.identity)) return;
    if (job.request.bootstrap && job.validation && !job.validation.done &&
        !job.validation.invalid.size) return;
    // Keep the drawn coarse surface until the refined surface can satisfy the
    // normal canopy gate. Never replace it with an invisible layer.
    if (this._active?.data.request.bootstrap && !job.request.bootstrap &&
        request.dimension === "overworld" &&
        typeof this.world.generator.getTrees === "function" &&
        (!this._vegetation || !contains(this._vegetation.bounds, request.hole)))
      return;
    const attributes = job.count * 3;
    const bounds = new THREE.Box3(
      new THREE.Vector3(
        job.bounds.minX - job.originX,
        job.spec.minY,
        job.bounds.minZ - job.originZ
      ),
      new THREE.Vector3(
        job.bounds.maxX - job.originX,
        job.spec.maxY,
        job.bounds.maxZ - job.originZ
      )
    );
    const terrain = new THREE.Mesh(
      geometry(
        job.terraces.positions,
        job.terraces.normals,
        job.terraces.colors,
        job.chunkOwnership ? job.terraces.indices : job.terraces.indices.length,
        bounds
      ),
      this._terrainMaterial
    );
    terrain.name = "Distant terrain surface";
    terrain.geometry.setAttribute("lodSurface", new THREE.BufferAttribute(job.terraces.surfaceData, 3));
    if (job.terraces.chunkData)
      terrain.geometry.setAttribute("lodDetailChunk", new THREE.BufferAttribute(job.terraces.chunkData, 2));
    if (job.terraces.blockData)
      terrain.geometry.setAttribute("lodBlocks", new THREE.BufferAttribute(job.terraces.blockData, 3));
    const layerGroup = new THREE.Group();
    layerGroup.position.set(job.originX, 0, job.originZ);
    layerGroup.userData = {
      dimension: job.request.dimension,
      seed: job.identity.seed,
      horizon: job.request.horizon,
      sampleCount: job.count,
      cellCount: job.cells.length,
      indexCount: job.terraces.indices.length,
      vertexCount: job.terraces.positions.length / 3,
    };
    layerGroup.add(terrain);
    let water = null;
    if (job.waterPositions) {
      const waterAttributes = job.wetCells > 0 ? attributes : 0;
      const normals = new Float32Array(waterAttributes);
      for (let i = 1; i < waterAttributes; i += 3) normals[i] = 1;
      const waterBounds = bounds.clone();
      waterBounds.min.y = waterBounds.max.y = Math.fround(job.waterSurface);
      water = new THREE.Mesh(
        geometry(
          waterAttributes > 0
            ? job.waterPositions.subarray(0, waterAttributes)
            : new Float32Array(0),
          normals,
          waterAttributes > 0
            ? job.waterColors.subarray(0, waterAttributes)
            : new Float32Array(0),
          waterAttributes > 0 ? job.indexCount : 0,
          waterBounds
        ),
        this._waterMaterial
      );
      water.name = "Distant water";
      water.renderOrder = 2;
      layerGroup.add(water);
    }
    const layer = {
      group: layerGroup,
      terrain,
      water,
      data: job,
      viewKey: null,
      heightTexture: new THREE.DataTexture(job.seamHeights, job.seamWidth, job.seamHeight,
        THREE.RedFormat, THREE.FloatType),
    };
    layer.heightTexture.needsUpdate = true;
    this._cutout(layer, request);
    disposeLayer(this._active);
    this._active = layer;
    this._seams?.setSurface(job, layer.heightTexture);
    this.group.add(layerGroup);
    job.pointIds.clear();
    job.points.length = 0;
    job.grid = job.rockColors = job.heights = job.valid = null;
    job.terraceBuilder = null;
    job.waterPositions = job.waterColors = null;
    this._job = null;
    const rejected = this._vegetationRejected && !this._needsJob(this._vegetationRejected, request);
    this.publication = job.request.bootstrap && rejected
      ? { state: "degraded", reason: "vegetation-budget", request }
      : { state: job.request.bootstrap ? "coarse" : job.validation?.unknown.size ? "validating" : "complete",
        reason: null, request };
  }

  _updateNativeSeams(request, deadline, maxUnits = DISTANT_TERRAIN_LIMITS.workPerUpdate) {
    const result = { units: 0, copyBytes: 0, allocatedBytes: 0, reservedBytes: 0 };
    if (!this._seams && (this._nativeBoundaries ? !this._nativeBoundaries.size : !request.coverage.size))
      return result;
    if (maxUnits < 32 || performance.now() >= deadline) {
      if (this._nativeBoundaries && this._nativeBoundaries !== this._seams?.input)
        this._seamBlocked = this._nativeBoundaries.changedKeys ?? this._nativeBoundaries;
      return result;
    }
    let columns = this._nativeBoundaries;
    if (columns === undefined) {
      const key = `${this._sceneRevision}:${[...request.coverage].sort().join("|")}`;
      if (key !== this._legacyBoundaryKey) {
        this._legacyBoundaryKey = key;
        this._legacyBoundaryColumns = new Map();
        this._legacyBoundaryState = { profile: null };
        this._legacyBoundaryJob = request.coverage.size
          ? sceneBoundarySources(this.scene, this.group, request.coverage, this._legacyBoundaryState) : null;
      }
      while (this._legacyBoundaryJob && result.units + 32 <= maxUnits && performance.now() < deadline) {
        const next = this._legacyBoundaryJob.next();
        if (next.done) this._legacyBoundaryJob = null;
        else {
          result.units += next.value?.units ?? 1;
          if (next.value?.profile?.some(Number.isFinite))
            this._legacyBoundaryColumns = new Map(this._legacyBoundaryColumns)
              .set(next.value.key, [{ data: next.value.profile, bits: 15 }]);
        }
      }
      columns = this._legacyBoundaryColumns;
    }
    if (!columns?.size && !this._seams) return result;
    // Snapshot admission has its own bounded metadata pass. Defer it intact
    // if legacy profiling already spent this update's work allowance.
    const snapshotUnits = Math.ceil(((columns?.size ?? 0) * 129 +
      (this._seams?.columns.size ?? 0)) / 256);
    const allocationUnits = this._seams ? 0 : Math.ceil((NATIVE_SEAM_BYTES + 3072) / 65536);
    if (columns !== this._seams?.input &&
        result.units + snapshotUnits + allocationUnits > maxUnits) {
      this._seamBlocked = columns.changedKeys ?? columns;
      return result;
    }
    if (!this._seams) {
      const reservation = NATIVE_SEAM_BYTES + 3072;
      result.reservedBytes = reservation;
      if (this._allocationBudget && (reservation > this._allocationBudget.cpu ||
          NATIVE_SEAM_BYTES > this._allocationBudget.gpu)) {
        this._seamBlocked = columns;
        return result;
      }
      this._seams = new NativeTerrainSeams(this.group, this.detailMask);
      this._seamBlocked = null;
      result.allocatedBytes = this._seams.allocatedBytes;
      result.units += Math.ceil(result.allocatedBytes / 65536);
    }
    const packed = this._seams.update(columns ?? new Map(),
      { maxUnits: maxUnits - result.units, deadline });
    this._seamBlocked = this._seams.input === columns ? null : (columns?.changedKeys ?? columns);
    result.units += packed.units;
    result.copyBytes += packed.copyBytes;
    if (this._active) this._seams.setSurface(this._active.data, this._active.heightTexture);
    this._seams.group.visible = !!this._active;
    return result;
  }

  prepareNativePublication(job, column, { deadline, maxUnits, copyBudget, cpuBudget, gpuBudget, stagingBudget, snapshotReserve = 0, force = false }) {
    const nothing = { ready: true, units: 0, copyBytes: 0 };
    if (!this._active || this._lastRequest?.dimension !== "overworld" || column?.visible === false) return nothing;
    const key = `${job.stamp.cx},${job.stamp.cz}`, profiles = [];
    for (const [sy, data] of column?.userData.nativeBoundarySources ?? [])
      if (sy !== job.stamp.sy) profiles.push({ data, bits: 9 });
    if (job.result?.nativeBoundary) profiles.push({ data: job.result.nativeBoundary, bits: 9 });
    const oldProfiles = this._seams?.columns.get(key)?.profiles ?? [];
    const noSeam = list => list.every(p => p.data.minimumTop === Infinity ||
      (this._active.data.minHeight === this._active.data.maxHeight &&
        p.data.minimumTop === this._active.data.minHeight && p.data.maximumTop === this._active.data.maxHeight));
    if (noSeam(profiles) && noSeam(oldProfiles)) return nothing;
    const ledger = this._nativePreparation ??= {
      units: 0, copyBytes: 0, allocatedBytes: 0, reservedBytes: 0, elapsedMs: 0,
    };
    const allowance = Math.min(maxUnits, force ? Infinity :
      DISTANT_TERRAIN_LIMITS.workPerUpdate - ledger.units - snapshotReserve);
    if (allowance < 64 || copyBudget < 3072) return { ready: false, units: 0, copyBytes: 0 };
    const started = performance.now();
    deadline = Math.min(deadline, force ? Infinity : started + (this._lastRequest?.quality === "high" ? 2 : 1));
    if (started >= deadline) return { ready: false, units: 0, copyBytes: 0 };
    let units = 1;
    const reservation = (this._seams ? 0 : NATIVE_SEAM_BYTES + 3072) + (job.nativeSeamPlan ? 0 : 3072);
    ledger.reservedBytes = Math.max(ledger.reservedBytes, reservation);
    const capacity = {
      cpuBytes: reservation,
      gpuBytes: this._seams ? 0 : NATIVE_SEAM_BYTES,
      stagingBytes: job.nativeSeamPlan ? 0 : 3072,
    };
    const refuse = (slots = false) => {
      ledger.units += units;
      ledger.elapsedMs += performance.now() - started;
      return { ready: false, units, copyBytes: 0, capacity: { ...capacity, slots } };
    };
    if (capacity.cpuBytes > cpuBudget || capacity.gpuBytes > gpuBudget ||
        capacity.stagingBytes > stagingBudget)
      return refuse();
    if (!this._seams) {
      this._seams = new NativeTerrainSeams(this.group, this.detailMask);
      this._seams.setSurface(this._active.data, this._active.heightTexture);
      ledger.allocatedBytes += this._seams.allocatedBytes;
      units += Math.ceil(this._seams.allocatedBytes / 65536);
    }
    if (!this._seams.columns.has(key) && !this._seams.free.length)
      return refuse(true);
    if (!job.nativeSeamPlan || job.nativeSeamPlan.revision !== job.pagePlan.revision ||
        job.nativeSeamPlan.column !== job.pagePlan.column) {
      job.nativeSeamPlan = new NativeBoundaryPacking(job.stamp.cx, job.stamp.cz);
      job.nativeSeamPlan.revision = job.pagePlan.revision;
      job.nativeSeamPlan.column = job.pagePlan.column;
      ledger.allocatedBytes += job.nativeSeamPlan.bytes;
      units++;
    }
    const packing = job.nativeSeamPlan;
    units += packing.step(profiles, Math.max(0, allowance - units - 48), deadline);
    const ready = packing.done && units + 48 <= allowance;
    if (ready) units += 48;
    ledger.units += units;
    ledger.elapsedMs += performance.now() - started;
    return { ready, units, copyBytes: 0, key, profiles, oldProfiles, packing, ledger };
  }

  commitNativePublication(prepared, column) {
    if (!prepared?.packing) return 0;
    const before = performance.now();
    const bytes = this._seams.publishPacked(prepared.key, prepared.profiles, prepared.packing);
    prepared.ledger.copyBytes += bytes;
    prepared.ledger.elapsedMs += performance.now() - before;
    // Native install and this 3 KiB publication are one synchronous commit.
    // Keep the ownership census exact even before the next renderer update.
    for (const p of prepared.oldProfiles)
      if (!column.userData.nativeBoundaryOwners?.has(p.data.buffer))
        this._nativeBoundaryOwners?.delete(p.data.buffer);
    for (const buffer of column.userData.nativeBoundaryOwners ?? [])
      this._nativeBoundaryOwners?.add(buffer);
    return bytes;
  }

  _updateVegetation(request, budgetMs) {
    if (
      request.dimension !== "overworld" ||
      typeof this.world.generator.getTrees !== "function"
    )
      return;
    let pending = this._vegetationJob;
    if (
      pending &&
      (pending.request.quality !== request.quality ||
        pending.request.radius !== request.radius ||
        !contains(pending.bounds, request.hole))
    ) {
      pending.job.dispose();
      pending = this._vegetationJob = null;
    }
    if (
      !pending &&
      budgetMs > 0 &&
      this._needsJob(this._vegetation?.request, request) &&
      this._needsJob(this._vegetationRejected, request)
    ) {
      pending = this._vegetationJob = {
        request,
        identity: this._identity,
        bounds: request.bounds,
        job: createDistantVegetationJob(this.world.generator, request.bounds, {
          spec: geometryWorldSpec(this.world, request.dimension),
          cache: this._treeSamples,
          limits: this._vegetationLimits,
          center: {
            x: (request.cx + 0.5) * CHUNK_SIZE,
            z: (request.cz + 0.5) * CHUNK_SIZE,
          },
        }),
      };
    }
    if (!pending || budgetMs <= 0) return;
    // Canopies have their own replaceable job so a slow forest never restarts
    // the much cheaper ground/refill work. One active + one pending mesh only.
    pending.job.step({ budgetMs, maxSamples: 64 });
    if (!pending.job.done || !this._sameIdentity(pending.identity)) return;
    if (pending.job.status === "budget") {
      // Never publish a partial forest as coverage or discard the valid old
      // layer. Retry only for a different view/quality, not every idle frame.
      this._vegetationRejected = pending.request;
      this.vegetationRejections++;
      pending.job.dispose();
      this._vegetationJob = null;
      // Rejection is a terminal state for this view, not a publish-phase wait.
      // Keep the installed horizon, release refinement, and retry only for a
      // changed view/quality/identity.
      if (this._active?.data.request.bootstrap && !this._job?.request.bootstrap) {
        this._job = null;
        this.publication = { state: "degraded", reason: "vegetation-budget", request: pending.request };
      }
      return;
    }
    const layer = pending.job.build(this._terrainMaterial);
    this._vegetation?.layer.dispose();
    this._vegetation = { ...pending, layer, viewKey: null, terrain: null };
    this.group.add(layer.group);
    this._vegetationJob = null;
    this._vegetationRejected = null;
  }

  _knownTerrainDistance(data, request, position) {
    let distance = Infinity;
    // Invalid Overworld samples are unknown frontiers, not End-style void.
    // Only actual drawn detail can supply coverage for an unknown LOD chunk.
    for (const key of data.geometryUnknown) data.unknownChunks.add(key);
    for (const key of data.unknownChunks) {
      if (request.coverage.has(key)) continue;
      const [cx, cz] = key.split(",").map(Number);
      const dx = Math.max(
        cx * CHUNK_SIZE - position.x,
        0,
        position.x - (cx + 1) * CHUNK_SIZE
      );
      const dz = Math.max(
        cz * CHUNK_SIZE - position.z,
        0,
        position.z - (cz + 1) * CHUNK_SIZE
      );
      distance = Math.min(distance, Math.hypot(dx, dz) - EDGE_MARGIN);
    }
    // Pending boundary publications are not drawable certificates. Only their
    // near frontier contracts; already reconciled distant regions stay intact.
    for (const pending of [this._seamBlocked, this._seams?.queue])
      for (const key of pending?.keys() ?? []) {
        const profiles = this._seams?.queue.get(key) ??
          (this._nativeBoundaries ?? this._legacyBoundaryColumns)?.get(key);
        const packed = this._seams?.columns.get(key)?.profiles ?? [];
        const actual = (this._nativeBoundaries ?? this._legacyBoundaryColumns)?.get(key) ?? [];
        if (packed.length === actual.length &&
            packed.every((p, i) => p.data === actual[i].data && p.bits === actual[i].bits))
          continue;
        // A proven coplanar boundary needs no vertical reconciliation. Its
        // actual profile already proves safety while the upload is staged.
        const noSeam = list => list.every(p => p.data.minimumTop === Infinity ||
          (data.minHeight === data.maxHeight &&
            p.data.minimumTop === data.minHeight && p.data.maximumTop === data.maxHeight));
        if (noSeam(profiles ?? []) && noSeam(packed))
          continue;
        const [cx, cz] = key.split(",").map(Number);
        const dx = Math.max(cx * 16 - position.x, 0, position.x - (cx + 1) * 16);
        const dz = Math.max(cz * 16 - position.z, 0, position.z - (cz + 1) * 16);
        distance = Math.min(distance, Math.hypot(dx, dz) - EDGE_MARGIN);
      }
    return distance;
  }

  _show(request, position) {
    const layer = this._active;
    const vegetation = this._vegetation;
    const needsVegetation =
      request.dimension === "overworld" &&
      typeof this.world.generator.getTrees === "function";
    if (
      !layer ||
      !this._canCover(layer.data, request) ||
      (needsVegetation && !layer.data.request.bootstrap &&
        (!vegetation || !contains(vegetation.bounds, request.hole)))
    ) {
      this.group.visible = false;
      this._fogDistance = 0;
      return;
    }
    if (layer.viewKey !== request.coverageKey) this._cutout(layer, request);
    if (
      vegetation &&
      (vegetation.viewKey !== request.coverageKey ||
        vegetation.terrain !== layer)
    ) {
      vegetation.layer.cutout(
        (cx, cz) =>
          request.coverage.has(`${cx},${cz}`) ||
          !contains(layer.data.bounds, {
            minX: cx * CHUNK_SIZE,
            maxX: (cx + 1) * CHUNK_SIZE,
            minZ: cz * CHUNK_SIZE,
            maxZ: (cz + 1) * CHUNK_SIZE,
          })
      );
      vegetation.viewKey = request.coverageKey;
      vegetation.terrain = layer;
    }
    const data = layer.data;
    const knownDistance = this._knownTerrainDistance(data, request, position);
    this._terrainCoverageComplete = knownDistance === Infinity;
    if (this.publication.state === "validating" && this._terrainCoverageComplete)
      this.publication = { state: "complete", reason: null, request };
    this._fogDistance = Math.max(
      0,
      Math.min(
        request.horizon,
        data.request.horizon,
        knownDistance,
        edgeDistance(data.bounds, position),
        vegetation
          ? Math.min(
              vegetation.request.horizon,
              edgeDistance(vegetation.bounds, position)
            )
          : Infinity
      )
    );
    this.group.visible = this._fogDistance > 0;
  }

  update(
    position,
    {
      radius = 2,
      quality = "medium",
      dimension,
      outdoors,
      coverage = new Set(),
      detailSections = new Set(),
      detailBatches = new Map(),
      nativeBoundaries,
      nativeBoundaryOwners,
      nativeBoundaryWork = { units: 0, elapsedMs: 0 },
      allocationBudget,
      budgetMs = 2,
    } = {}
  ) {
    if (this._disposed) return false;
    this.lastWork = { units: 0, samples: 0 };
    this._workCopyBytes = 0;
    this._workAllocatedBytes = 0;
    const prepared = this._nativePreparation ?? { units: 0, copyBytes: 0, allocatedBytes: 0, reservedBytes: 0, elapsedMs: 0 };
    this._nativePreparation = null;
    nativeBoundaryWork = { units: nativeBoundaryWork.units + prepared.units,
      elapsedMs: nativeBoundaryWork.elapsedMs + prepared.elapsedMs };
    if (prepared.units) Object.assign(this.lastWork, {
      units: prepared.units, copyBytes: prepared.copyBytes,
      allocatedBytes: prepared.allocatedBytes, reservedBytes: prepared.reservedBytes,
    });
    const started = performance.now() - nativeBoundaryWork.elapsedMs;
    const budget = Number.isFinite(budgetMs)
      ? Math.max(0, Math.min(DISTANT_TERRAIN_LIMITS.maxBudgetMs, budgetMs))
      : 2;
    const generator = this.world.generator;
    this._allocationBudget = allocationBudget;
    this._surfaceVersion.value = this.world.generatorVersion ?? 3;
    const targetDimension = dimension ?? this.world.dimension ?? "overworld";
    if (
      !position ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.z) ||
      position.x < WORLD_MIN ||
      position.x >= WORLD_MAX ||
      position.z < WORLD_MIN ||
      position.z >= WORLD_MAX ||
      !["overworld", "end"].includes(targetDimension) ||
      typeof generator?.terrainHeight !== "function" ||
      typeof generator?.getBiome !== "function"
    ) {
      this._clear();
      return false;
    }
    this.detailMask.update(position, geometryWorldSpec(this.world, targetDimension), detailBatches);
    if (
      !this._sameIdentity(this._identity) ||
      this._identity.dimension !== targetDimension
    ) {
      this._clear();
      this._identity = {
        generator,
        dimension: targetDimension,
        seed: this.world.seed,
        version: this.world.generatorVersion,
        epoch: geometryEpoch(this.world),
        surface: surfaceIdentity(this.world),
        heightSource: generator.terrainHeight,
        biomeSource: generator.getBiome,
        columnSource: generator.sampleColumn,
        landmarkSource: generator.getEndPillars,
        worldDimension: this.world.dimension,
        styleSeed: seedHash(String(this.world.seed ?? "")) ^ 0x735ca,
      };
    }
    this._nativeBoundaries = nativeBoundaries;
    this._nativeBoundaryOwners = nativeBoundaryOwners;
    const biome = generator.getBiome(
      Math.floor(position.x),
      Math.floor(position.z)
    );
    if (
      outdoors === false ||
      (outdoors !== true && biome?.category === "cave")
    ) {
      // Occlusion changes visibility, not world identity. Keep the bounded
      // layers, caches and pending jobs dormant so a visible cave mouth can
      // reuse them without waiting for another ground/canopy build. Identity
      // checks above and request/coverage checks below still reject stale data.
      this.group.visible = false;
      this._fogDistance = 0;
      return false;
    }
    // Samples belong to immutable world coordinates, not the player's current
    // biome. Crossing a forest boundary must not discard a nearly finished job.
    this._biomeId = biome?.id ?? null;
    const resolvedQuality = Object.hasOwn(DISTANT_QUALITY, quality)
      ? quality
      : "medium";
    const resolvedRadius = Number.isFinite(radius)
      ? Math.max(0, Math.min(MAX_RENDER_RADIUS, Math.floor(radius)))
      : 2;
    const request = this._request(
      position,
      resolvedRadius,
      resolvedQuality,
      targetDimension,
      coverage
    );
    this._lastRequest = request;
    this._lastPosition = position;
    if (nativeBoundaries === undefined && coverage.size) {
      const mask = new Map(detailBatches);
      const spec = geometryWorldSpec(this.world, targetDimension);
      for (const key of coverage)
        for (let sy = Math.floor(spec.minY / 16); sy < Math.ceil(spec.maxY / 16); sy++)
          mask.set(`${key},${sy}`, 15);
      this.detailMask.update(position, spec, mask);
    }
    const seamWork = this._updateNativeSeams(request, started + budget,
      Math.max(0, DISTANT_TERRAIN_LIMITS.workPerUpdate - nativeBoundaryWork.units));
    this._show(request, position);
    if (
      this._job &&
      (this._job.request.quality !== resolvedQuality ||
        this._job.request.radius !== resolvedRadius ||
        !this._canCover(this._job, request))
    )
      this._job = null;
    const refreshCoarse = this._active?.data.request.bootstrap &&
      (!this._canCover(this._active.data, request) ||
        edgeDistance(this._active.data.bounds, position) < Math.min(192, request.horizon) * 0.75);
    if (
      !this._job &&
      this._needsJob(this._active?.data.request, request) &&
      (refreshCoarse || this.publication.state !== "degraded" || this._needsJob(this.publication.request, request)) &&
      budget > 0
    ) {
      // Large-distance startup must not wait for thousands of fine-grid
      // samples and every canopy. Publish a complete, chunk-aligned coarse
      // surface first, then refine with the same one-active/one-pending budget.
      const firstSurface = (!this._active || refreshCoarse) && resolvedRadius > 8 &&
        targetDimension === "overworld";
      this._job = this._startJob(firstSurface
        ? this._request(position, resolvedRadius, resolvedQuality, targetDimension, coverage, true)
        : request);
      for (const value of Object.values(this._job))
        if (ArrayBuffer.isView(value)) this._workAllocatedBytes += value.byteLength;
      this.publication = { state: this._active ? "refining" : "building", reason: null, request };
    }
    let work = seamWork.units + nativeBoundaryWork.units,
      samples = 0;
    const job = this._job;
    // Share the existing sample/work budget with interior validation. Active
    // coverage progresses first; cached validated chunks feed later refinement.
    const validationLimit = job?.phase === "publish" || !job ? 128 : 64;
    for (const data of [this._active?.data, job]) {
      if (!data?.validation || data.validation.done || samples >= validationLimit) continue;
      const n = data.validation.step(Math.min(validationLimit - samples,
        DISTANT_TERRAIN_LIMITS.workPerUpdate - work), started + budget * 0.25);
      samples += n;
      work += n;
    }
    const terrainBudget =
      targetDimension === "overworld" &&
      typeof generator.getTrees === "function" && !job?.request.bootstrap
        ? budget * 0.5
        : budget;
    while (
      job &&
      work < DISTANT_TERRAIN_LIMITS.workPerUpdate &&
      performance.now() - started < terrainBudget
    ) {
      if (job.phase === "landmark-plan") {
        const next = job.landmarkPlan.next();
        if (next.done) job.phase = "sample";
        else job.refinement.set(next.value.key,
          Math.min(job.refinement.get(next.value.key) ?? 16, next.value.step));
      } else if (job.phase === "plan") {
        if (job.planCursor === 289) job.phase = "sample";
        else {
          if (samples >= DISTANT_TERRAIN_LIMITS.samplesPerUpdate) break;
          const dx = job.planCursor % 17 - 8;
          const dz = Math.floor(job.planCursor / 17) - 8;
          const cx = job.request.cx + dx, cz = job.request.cz + dz;
          const x = cx * CHUNK_SIZE + 8, z = cz * CHUNK_SIZE + 8;
          if (x >= WORLD_MIN && x < WORLD_MAX && z >= WORLD_MIN && z < WORLD_MAX) {
            const biome = job.identity.generator.getBiome(x, z);
            samples++;
            if (biome?.category === "badlands")
              job.refinement.set(`${cx},${cz}`, Math.max(Math.abs(dx), Math.abs(dz)) <= 4 ? 2 : 4);
          }
          job.planCursor++;
        }
      } else if (job.phase === "sample") {
        if (job.cursor < job.count) {
          if (samples >= DISTANT_TERRAIN_LIMITS.samplesPerUpdate) break;
          samples += this._sample(job);
          job.cursor++;
        } else {
          const next = job.grid.next();
          if (next.done) {
            job.cursor = 0;
            job.terraceBuilder = new DistantTerraces(job);
            job.phase = "normal";
          } else this._cell(job, next.value);
        }
      } else if (job.phase === "normal") {
        this._normal(job);
        job.terraceBuilder.link(job.cells[job.cursor]);
        if (++job.cursor === job.cells.length) {
          job.cursor = 0;
          job.phase = "shade";
        }
      } else if (job.phase === "shade") {
        this._shade(job);
        if (++job.cursor === job.count) {
          job.terraceAllocation = job.terraceBuilder.allocate();
          job.phase = "terrace-allocate";
        }
      } else if (job.phase === "terrace-allocate") {
        const allocation = job.terraceAllocation.next();
        if (!allocation.done) this._workAllocatedBytes += allocation.value;
        else {
          job.terraceAllocation = null;
          job.cursor = 0;
          if (job.terraceBuilder.flat) {
            job.terraces = job.terraceBuilder.finish();
            job.phase = "height-map";
          } else job.phase = "terrace";
        }
      } else if (job.phase === "terrace") {
        job.terraceBuilder.emit(job.cells[job.cursor]);
        if (++job.cursor === job.cells.length) {
          job.phase = "terrace-finalize";
        }
      } else if (job.phase === "terrace-finalize") {
        job.terraces = job.terraceBuilder.finish();
        if (job.terraces) job.phase = "height-map";
      } else if (job.phase === "height-map") {
        if (!job.seamHeights) {
          job.seamStep = job.minCellStep;
          job.seamWidth = (job.bounds.maxX - job.bounds.minX) / job.seamStep;
          job.seamHeight = (job.bounds.maxZ - job.bounds.minZ) / job.seamStep;
          job.seamHeights = new Float32Array(job.seamWidth * job.seamHeight);
          this._workAllocatedBytes += job.seamHeights.byteLength;
          job.cursor = 0;
        }
        const cell = job.cells[job.cursor++];
        {
          const x = (cell.x + job.originX - job.bounds.minX) / job.seamStep;
          const z = (cell.z + job.originZ - job.bounds.minZ) / job.seamStep;
          const span = cell.step / job.seamStep;
          for (let row = z; row < z + span; row++)
            job.seamHeights.fill(cell.valid ? cell.height : NaN,
              row * job.seamWidth + x, row * job.seamWidth + x + span);
        }
        if (job.cursor === job.cells.length) job.phase = "publish";
      } else {
        this._publish(job, request);
        break;
      }
      work++;
    }
    this.lastWork = { units: work, samples, copyBytes: prepared.copyBytes + seamWork.copyBytes + this._workCopyBytes,
      allocatedBytes: prepared.allocatedBytes + seamWork.allocatedBytes + this._workAllocatedBytes,
      reservedBytes: Math.max(prepared.reservedBytes, seamWork.reservedBytes),
      pendingSeamColumns: this._seams?.queue.size ?? 0 };
    this._updateVegetation(
      request,
      Math.max(0, budget - (performance.now() - started))
    );
    if (targetDimension === "end" && typeof generator.getEndPillars === "function") {
      this._landmarks ??= new DistantLandmarks(this.group, this.world, this._terrainMaterial);
      this._landmarks.update({
        coverage, detailSections,
        budgetMs: Math.max(0, budget - (performance.now() - started)),
      });
    }
    this._show(request, position);
    this.lastWork.copyBytes = prepared.copyBytes + seamWork.copyBytes + this._workCopyBytes;
    return this.ready;
  }

  dispose() {
    if (this._disposed) return;
    this._clear();
    this._terrainMaterial.dispose();
    this._waterMaterial.dispose();
    this.detailMask.dispose();
    this.scene.removeEventListener("childadded", this._sceneChanged);
    this.scene.removeEventListener("childremoved", this._sceneChanged);
    if (this.scene.onBeforeRender === this._sceneRender) this.scene.onBeforeRender = this._beforeSceneRender;
    this.group.removeFromParent();
    this._disposed = true;
  }
}
