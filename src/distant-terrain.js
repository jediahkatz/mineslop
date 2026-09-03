import * as THREE from "three";
import { BIOME_PROFILES } from "./biomes.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import {
  distantGridCells,
  DISTANT_GRID_LIMITS,
  DISTANT_QUALITY,
} from "./distant-grid.js";
import {
  createDistantVegetationCache,
  createDistantVegetationJob,
} from "./distant-vegetation.js";
import { geometryEpoch, geometryWorldSpec } from "./geometry-world.js";
import { noise, seedHash } from "./noise.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "./terrain.js";

export const DISTANT_TERRAIN_LIMITS = Object.freeze({
  samplesPerUpdate: 128,
  workPerUpdate: 512,
  cachedSamples: 8192,
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
  layer.group.removeFromParent();
}

function geometry(positions, normals, colors, indices, bounds) {
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  result.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  result.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  result.setIndex(
    new THREE.BufferAttribute(new Uint16Array(indices), 1).setUsage(
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
  constructor(scene, world, { vegetationLimits } = {}) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = "Distant terrain";
    this.group.visible = false;
    scene.add(this.group);
    this._terrainMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });
    this._waterMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
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
  }

  get ready() {
    return !this._disposed && this.group.visible && this._active !== null;
  }

  get fogDistance() {
    return this.ready ? this._fogDistance : 0;
  }

  _sameIdentity(identity) {
    return (
      identity &&
      identity.generator === this.world.generator &&
      identity.seed === this.world.seed &&
      identity.version === this.world.generatorVersion &&
      identity.epoch === geometryEpoch(this.world) &&
      identity.worldDimension === this.world.dimension
    );
  }

  _clear() {
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

  _request(position, radius, quality, dimension, coverage) {
    const cx = Math.floor(position.x / CHUNK_SIZE);
    const cz = Math.floor(position.z / CHUNK_SIZE);
    const horizon = DISTANT_QUALITY[quality].horizon;
    const extent = horizon + REBUILD_MARGIN;
    return {
      cx,
      cz,
      radius,
      quality,
      dimension,
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
    return contains(data.bounds, request.hole);
  }

  _needsJob(previous, request) {
    return (
      !previous ||
      previous.quality !== request.quality ||
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
    // Keep interior vertices too: rows restore immediately using index changes,
    // even when generation or meshing is stalled and the player reverses.
    return {
      request,
      spec,
      waterSurface,
      originX,
      originZ,
      grid: distantGridCells(
        request.cx,
        request.cz,
        request.bounds,
        request.quality
      ),
      points: [],
      pointIds: new Map(),
      cells: [],
      unknownChunks: new Set(),
      indices: new Uint16Array(DISTANT_GRID_LIMITS.indices),
      indexCount: 0,
      count: 0,
      bounds: request.bounds,
      identity: this._identity,
      phase: "sample",
      cursor: 0,
      heights: new Float32Array(DISTANT_GRID_LIMITS.vertices),
      valid: new Uint8Array(DISTANT_GRID_LIMITS.vertices),
      positions: new Float32Array(DISTANT_GRID_LIMITS.vertices * 3),
      normals: new Float32Array(DISTANT_GRID_LIMITS.vertices * 3),
      colors: new Float32Array(DISTANT_GRID_LIMITS.vertices * 3),
      rockColors: new Float32Array(DISTANT_GRID_LIMITS.vertices * 3),
      waterPositions:
        waterSurface !== null
          ? new Float32Array(DISTANT_GRID_LIMITS.vertices * 3)
          : null,
      waterColors:
        waterSurface !== null
          ? new Float32Array(DISTANT_GRID_LIMITS.vertices * 3)
          : null,
    };
  }

  _cell(job, cell) {
    const point = ([x, z]) => {
      const key = `${x},${z}`;
      if (job.pointIds.has(key)) return job.pointIds.get(key);
      if (job.count >= DISTANT_GRID_LIMITS.vertices)
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
      job.cells.length >= DISTANT_GRID_LIMITS.cells ||
      job.indexCount + indices.length > DISTANT_GRID_LIMITS.indices
    )
      throw new RangeError("Distant terrain exceeded its topology budget");
    job.cells.push({
      key: `${cell.cx},${cell.cz}`,
      start: job.indexCount,
      count: indices.length,
      valid: false,
      wet: false,
    });
    job.indices.set(indices, job.indexCount);
    job.indexCount += indices.length;
  }

  _palette(biome) {
    const profile = BIOME_PROFILES[biome?.id];
    const surface = profile?.surface;
    const ground =
      surface === BLOCK.GRASS
        ? biome.grassColor
        : (BLOCKS[surface]?.color ?? biome?.color);
    const rock = BLOCKS[profile?.rock]?.color ?? ground;
    const key = `${ground}:${biome?.waterColor}:${rock}`;
    if (this._colors.has(key)) return this._colors.get(key);
    const palette = [
      ...color(ground, "#83ac52").toArray(),
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
      sample = {
        valid,
        height: valid
          ? Math.min(job.spec.maxY - 1, Math.floor(top)) + 1
          : job.spec.minY,
        palette: this._palette(generator.getBiome(worldX, worldZ)),
      };
      this._samples.set(key, sample);
      if (this._samples.size > DISTANT_TERRAIN_LIMITS.cachedSamples) {
        this._samples.delete(this._samples.keys().next().value);
      }
    }
    job.heights[at] = sample.height;
    job.valid[at] = Number(sample.valid);
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
    let lowest = Infinity;
    for (let i = cell.start; i < end; i++) {
      const vertex = job.indices[i];
      if (!job.valid[vertex]) {
        if (job.request.dimension === "overworld")
          job.unknownChunks.add(cell.key);
        return;
      }
      lowest = Math.min(lowest, job.heights[vertex]);
    }
    cell.valid = true;
    cell.wet = job.waterSurface !== null && lowest < job.waterSurface;
    // Area-weighted normals share the exact stitched topology. No extra native
    // queries are needed for slope shading or for coarse/fine boundary normals.
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
    if (job.request.dimension !== "overworld") return;
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
    for (const cell of data.cells) {
      // Only authoritative detail owns this ground. Ground outside an older
      // canopy's bounds remains useful during independent quality upgrades.
      if (!cell.valid || request.coverage.has(cell.key)) continue;
      for (let i = cell.start; i < cell.start + cell.count; i++) {
        terrainIndices[terrainCount++] = data.indices[i];
        if (waterIndices && cell.wet)
          waterIndices[waterCount++] = data.indices[i];
      }
    }
    layer.terrain.geometry.setDrawRange(0, terrainCount);
    layer.terrain.geometry.index.needsUpdate = true;
    layer.terrain.visible = terrainCount > 0;
    if (layer.water) {
      layer.water.geometry.setDrawRange(0, waterCount);
      layer.water.geometry.index.needsUpdate = true;
      layer.water.visible = waterCount > 0;
    }
    layer.viewKey = request.coverageKey;
    layer.group.userData.coveredChunks = request.coverage.size;
  }

  _publish(job, request) {
    if (this._job !== job || !this._sameIdentity(job.identity)) return;
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
        job.positions.subarray(0, attributes),
        job.normals.subarray(0, attributes),
        job.colors.subarray(0, attributes),
        job.indexCount,
        bounds
      ),
      this._terrainMaterial
    );
    terrain.name = "Distant terrain surface";
    const layerGroup = new THREE.Group();
    layerGroup.position.set(job.originX, 0, job.originZ);
    layerGroup.userData = {
      dimension: job.request.dimension,
      seed: job.identity.seed,
      horizon: job.request.horizon,
      sampleCount: job.count,
      cellCount: job.cells.length,
      indexCount: job.indexCount,
    };
    layerGroup.add(terrain);
    let water = null;
    if (job.waterPositions) {
      const normals = new Float32Array(job.count * 3);
      for (let i = 0; i < job.count; i++) normals[i * 3 + 1] = 1;
      const waterBounds = bounds.clone();
      waterBounds.min.y = waterBounds.max.y = Math.fround(job.waterSurface);
      water = new THREE.Mesh(
        geometry(
          job.waterPositions.subarray(0, attributes),
          normals,
          job.waterColors.subarray(0, attributes),
          job.indexCount,
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
    };
    this._cutout(layer, request);
    disposeLayer(this._active);
    this._active = layer;
    this.group.add(layerGroup);
    job.pointIds.clear();
    job.points.length = 0;
    job.grid = job.rockColors = job.heights = job.valid = null;
    this._job = null;
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
      (needsVegetation &&
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
    this._fogDistance = Math.max(
      0,
      Math.min(
        request.horizon,
        data.request.horizon,
        this._knownTerrainDistance(data, request, position),
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
      budgetMs = 2,
    } = {}
  ) {
    if (this._disposed) return false;
    this.lastWork = { units: 0, samples: 0 };
    const started = performance.now();
    const budget = Number.isFinite(budgetMs)
      ? Math.max(0, Math.min(DISTANT_TERRAIN_LIMITS.maxBudgetMs, budgetMs))
      : 2;
    const generator = this.world.generator;
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
        worldDimension: this.world.dimension,
        styleSeed: seedHash(String(this.world.seed ?? "")) ^ 0x735ca,
      };
    }
    const biome = generator.getBiome(
      Math.floor(position.x),
      Math.floor(position.z)
    );
    if (
      outdoors === false ||
      (outdoors !== true && biome?.category === "cave")
    ) {
      this._clear();
      return false;
    }
    // Samples belong to immutable world coordinates, not the player's current
    // biome. Crossing a forest boundary must not discard a nearly finished job.
    this._biomeId = biome?.id ?? null;
    const resolvedQuality = Object.hasOwn(DISTANT_QUALITY, quality)
      ? quality
      : "medium";
    const resolvedRadius = Number.isFinite(radius)
      ? Math.max(0, Math.min(8, Math.floor(radius)))
      : 2;
    const request = this._request(
      position,
      resolvedRadius,
      resolvedQuality,
      targetDimension,
      coverage
    );
    this._show(request, position);
    if (
      this._job &&
      (this._job.request.quality !== resolvedQuality ||
        this._job.request.radius !== resolvedRadius ||
        !this._canCover(this._job, request))
    )
      this._job = null;
    if (
      !this._job &&
      this._needsJob(this._active?.data.request, request) &&
      budget > 0
    ) {
      this._job = this._startJob(request);
    }
    let work = 0,
      samples = 0;
    const job = this._job;
    const terrainBudget =
      targetDimension === "overworld" &&
      typeof generator.getTrees === "function"
        ? budget * 0.5
        : budget;
    while (
      job &&
      work < DISTANT_TERRAIN_LIMITS.workPerUpdate &&
      performance.now() - started < terrainBudget
    ) {
      if (job.phase === "sample") {
        if (job.cursor < job.count) {
          if (samples >= DISTANT_TERRAIN_LIMITS.samplesPerUpdate) break;
          samples += this._sample(job);
          job.cursor++;
        } else {
          const next = job.grid.next();
          if (next.done) {
            job.cursor = 0;
            job.phase = "normal";
          } else this._cell(job, next.value);
        }
      } else if (job.phase === "normal") {
        this._normal(job);
        if (++job.cursor === job.cells.length) {
          job.cursor = 0;
          job.phase = "shade";
        }
      } else if (job.phase === "shade") {
        this._shade(job);
        if (++job.cursor === job.count) job.phase = "publish";
      } else {
        this._publish(job, request);
        break;
      }
      work++;
    }
    this.lastWork = { units: work, samples };
    this._updateVegetation(
      request,
      Math.max(0, budget - (performance.now() - started))
    );
    this._show(request, position);
    return this.ready;
  }

  dispose() {
    if (this._disposed) return;
    this._clear();
    this._terrainMaterial.dispose();
    this._waterMaterial.dispose();
    this.group.removeFromParent();
    this._disposed = true;
  }
}
