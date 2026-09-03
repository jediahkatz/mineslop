import * as THREE from "three";
import { BIOME_PROFILES } from "./biomes.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import { createDistantVegetationJob } from "./distant-vegetation.js";
import { geometryEpoch, geometryWorldSpec } from "./geometry-world.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "./terrain.js";

const HORIZONS = { low: 160, medium: 256, high: 320 };
const MAX_SAMPLES_PER_UPDATE = 128;
const MAX_WORK_PER_UPDATE = 512;
const MAX_CACHED_SAMPLES = 8192;
const EDGE_MARGIN = 8;
const REBUILD_MARGIN = CHUNK_SIZE * 2;

function axis(origin, extent, fineExtent) {
  const start = Math.max(WORLD_MIN, origin - extent);
  const end = Math.min(WORLD_MAX, origin + CHUNK_SIZE + extent);
  const values = [start - origin];
  // Even coarse cells end at chunk borders. Any individual detail chunk can
  // take over (or disappear) without a proxy triangle crossing its boundary.
  for (let point = start; point < end; ) {
    const fine =
      point >= origin - fineExtent && point < origin + CHUNK_SIZE + fineExtent;
    point = Math.min(end, point + (fine ? 8 : CHUNK_SIZE));
    values.push(point - origin);
  }
  return values;
}

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

function geometry(positions, normals, colors, cells, bounds) {
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  result.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  result.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  result.setIndex(
    new THREE.BufferAttribute(new Uint16Array(cells * 6), 1).setUsage(
      THREE.DynamicDrawUsage
    )
  );
  result.setDrawRange(0, 0);
  result.boundingBox = bounds;
  result.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
  return result;
}

function quad(indices, at, a, b, c, d) {
  indices[at] = a;
  indices[at + 1] = d;
  indices[at + 2] = c;
  indices[at + 3] = a;
  indices[at + 4] = c;
  indices[at + 5] = b;
  return at + 6;
}

// Visual-only fallback, including underneath unfinished detail rows. It never
// loads chunks, applies edits, or supplies collision data. Only an authoritative
// visible chunk mesh (including a completely edited-away chunk) can cut it out.
export class DistantTerrain {
  constructor(scene, world) {
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
    this._identity = null;
    this._biomeId = null;
    this._samples = new Map();
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
    this._vegetation?.layer.dispose();
    this._vegetation = null;
    disposeLayer(this._active);
    this._active = null;
    this._samples.clear();
    this._colors.clear();
    this._biomeId = null;
    this._fogDistance = 0;
    this.group.visible = false;
  }

  _request(position, radius, quality, dimension, coverage) {
    const cx = Math.floor(position.x / CHUNK_SIZE);
    const cz = Math.floor(position.z / CHUNK_SIZE);
    const horizon = HORIZONS[quality];
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
    const extent = request.horizon + REBUILD_MARGIN;
    const fineExtent = Math.min(extent, (request.radius + 2) * CHUNK_SIZE);
    const xs = axis(originX, extent, fineExtent);
    const zs = axis(originZ, extent, fineExtent);
    const count = xs.length * zs.length;
    // Keep interior vertices too: rows restore immediately using index changes,
    // even when generation or meshing is stalled and the player reverses.
    return {
      request,
      spec,
      waterSurface,
      originX,
      originZ,
      xs,
      zs,
      count,
      bounds: request.bounds,
      identity: this._identity,
      phase: "sample",
      cursor: 0,
      heights: new Float32Array(count),
      valid: new Uint8Array(count),
      positions: new Float32Array(count * 3),
      normals: new Float32Array(count * 3),
      colors: new Float32Array(count * 3),
      waterPositions:
        waterSurface !== null ? new Float32Array(count * 3) : null,
      waterColors: waterSurface !== null ? new Float32Array(count * 3) : null,
    };
  }

  _palette(biome) {
    const surface = BIOME_PROFILES[biome?.id]?.surface;
    const ground =
      surface === BLOCK.GRASS
        ? biome.grassColor
        : (BLOCKS[surface]?.color ?? biome?.color);
    const key = `${ground}:${biome?.waterColor}`;
    if (this._colors.has(key)) return this._colors.get(key);
    const palette = [
      ...color(ground, "#83ac52").toArray(),
      ...color(biome?.waterColor, "#489fbb").toArray(),
    ];
    this._colors.set(key, palette);
    if (this._colors.size > 256)
      this._colors.delete(this._colors.keys().next().value);
    return palette;
  }

  _sample(job) {
    const at = job.cursor;
    const x = at % job.xs.length;
    const z = Math.floor(at / job.xs.length);
    const localX = job.xs[x],
      localZ = job.zs[z];
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
      if (this._samples.size > MAX_CACHED_SAMPLES) {
        this._samples.delete(this._samples.keys().next().value);
      }
    }
    job.heights[at] = sample.height;
    job.valid[at] = Number(sample.valid);
    job.positions.set([localX, sample.height, localZ], at * 3);
    job.colors.set(sample.palette.slice(0, 3), at * 3);
    if (job.waterPositions) {
      job.waterPositions.set([localX, job.waterSurface, localZ], at * 3);
      job.waterColors.set(sample.palette.slice(3, 6), at * 3);
    }
    return Number(uncached);
  }

  _normal(job) {
    const at = job.cursor,
      width = job.xs.length;
    const x = at % width,
      z = Math.floor(at / width);
    const left = x > 0 && job.valid[at - 1] ? x - 1 : x;
    const right = x + 1 < width && job.valid[at + 1] ? x + 1 : x;
    const back = z > 0 && job.valid[at - width] ? z - 1 : z;
    const front = z + 1 < job.zs.length && job.valid[at + width] ? z + 1 : z;
    const dx =
      (job.heights[z * width + right] - job.heights[z * width + left]) /
      Math.max(1, job.xs[right] - job.xs[left]);
    const dz =
      (job.heights[front * width + x] - job.heights[back * width + x]) /
      Math.max(1, job.zs[front] - job.zs[back]);
    const length = Math.hypot(dx, 1, dz);
    job.normals.set([-dx / length, 1 / length, -dz / length], at * 3);
  }

  _cutout(layer, request) {
    const data = layer.data;
    let terrainCount = 0,
      waterCount = 0;
    const terrainIndices = layer.terrain.geometry.index.array;
    const waterIndices = layer.water?.geometry.index.array;
    const width = data.xs.length;
    for (let z = 0; z < data.zs.length - 1; z++) {
      const z0 = data.originZ + data.zs[z];
      for (let x = 0; x < width - 1; x++) {
        const x0 = data.originX + data.xs[x];
        const key = `${Math.floor(x0 / CHUNK_SIZE)},${Math.floor(z0 / CHUNK_SIZE)}`;
        // Only authoritative detail owns this ground. An older canopy can have
        // smaller bounds during an upgrade; view-depth fog does not hide every
        // ground cell beyond them, so retain the usable surface.
        if (request.coverage.has(key)) continue;
        const a = z * width + x,
          b = a + 1,
          d = a + width,
          c = d + 1;
        if (
          !data.valid[a] ||
          !data.valid[b] ||
          !data.valid[c] ||
          !data.valid[d]
        )
          continue;
        terrainCount = quad(terrainIndices, terrainCount, a, b, c, d);
        if (
          waterIndices &&
          Math.min(
            data.heights[a],
            data.heights[b],
            data.heights[c],
            data.heights[d]
          ) < data.waterSurface
        ) {
          waterCount = quad(waterIndices, waterCount, a, b, c, d);
        }
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
    const cells = (job.xs.length - 1) * (job.zs.length - 1);
    const bounds = new THREE.Box3(
      new THREE.Vector3(job.xs[0], job.spec.minY, job.zs[0]),
      new THREE.Vector3(job.xs.at(-1), job.spec.maxY, job.zs.at(-1))
    );
    const terrain = new THREE.Mesh(
      geometry(job.positions, job.normals, job.colors, cells, bounds),
      this._terrainMaterial
    );
    terrain.name = "Distant terrain surface";
    const layerGroup = new THREE.Group();
    layerGroup.position.set(job.originX, 0, job.originZ);
    layerGroup.userData = {
      dimension: job.request.dimension,
      seed: job.identity.seed,
      horizon: job.request.horizon,
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
          job.waterPositions,
          normals,
          job.waterColors,
          cells,
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
        !contains(pending.bounds, request.hole))
    ) {
      pending.job.dispose();
      pending = this._vegetationJob = null;
    }
    if (
      !pending &&
      budgetMs > 0 &&
      this._needsJob(this._vegetation?.request, request)
    ) {
      pending = this._vegetationJob = {
        request,
        identity: this._identity,
        bounds: request.bounds,
        job: createDistantVegetationJob(this.world.generator, request.bounds, {
          spec: geometryWorldSpec(this.world, request.dimension),
        }),
      };
    }
    if (!pending || budgetMs <= 0) return;
    // Canopies have their own replaceable job so a slow forest never restarts
    // the much cheaper ground/refill work. One active + one pending mesh only.
    pending.job.step({ budgetMs, maxSamples: 64 });
    if (!pending.job.done || !this._sameIdentity(pending.identity)) return;
    const layer = pending.job.build(this._terrainMaterial);
    this._vegetation?.layer.dispose();
    this._vegetation = { ...pending, layer, viewKey: null, terrain: null };
    this.group.add(layer.group);
    this._vegetationJob = null;
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
    const started = performance.now();
    const budget = Number.isFinite(budgetMs)
      ? Math.max(0, Math.min(4, budgetMs))
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
    const resolvedQuality = Object.hasOwn(HORIZONS, quality)
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
      work < MAX_WORK_PER_UPDATE &&
      performance.now() - started < terrainBudget
    ) {
      if (job.phase === "sample") {
        if (samples >= MAX_SAMPLES_PER_UPDATE) break;
        samples += this._sample(job);
      } else if (job.phase === "normal") this._normal(job);
      else {
        this._publish(job, request);
        break;
      }
      work++;
      job.cursor++;
      if (job.cursor === job.count) {
        job.cursor = 0;
        job.phase = job.phase === "sample" ? "normal" : "publish";
      }
    }
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
