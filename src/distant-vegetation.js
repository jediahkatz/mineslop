import * as THREE from "three";
import { BLOCKS } from "./blocks.js";
import { geometryWorldSpec } from "./geometry-world.js";
import { getBiomeTint, leafBlock } from "./mesh-palette.js";
import { hash } from "./noise.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { TREE_REACH, TREE_SPACING } from "./terrain-trees.js";

export const DISTANT_VEGETATION_LIMITS = Object.freeze({
  samplesPerStep: 64,
  jobSamples: 16384,
  cachedSamples: 16384,
  cachedPrimitives: 65536,
  treesPerCell: 8,
  partsPerTree: 128,
  cellsPerStep: 256,
  primitivesPerStep: 96,
  clipColumnsPerHull: 16,
  vertices: 524288,
  indices: 1048576,
});
const DETAILED_CANOPY_DISTANCE = 192;
const FACES = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 4, 0],
];

function limit(value, maximum) {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.floor(value)))
    : maximum;
}

function crownHull(crowns) {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;
  for (const crown of crowns) {
    minX = Math.min(minX, crown.x - crown.radius);
    maxX = Math.max(maxX, crown.x + crown.radius + 1);
    minZ = Math.min(minZ, crown.z - crown.radius);
    maxZ = Math.max(maxZ, crown.z + crown.radius + 1);
    minY = Math.min(
      minY,
      crown.y + (crown.flat ? 0 : crown.kind === "legacy-crown" ? -2 : -1)
    );
    maxY = Math.max(maxY, crown.y + 2);
  }
  let topMinX = Infinity,
    topMaxX = -Infinity,
    topMinZ = Infinity,
    topMaxZ = -Infinity;
  for (const crown of crowns) {
    if (crown.y + 2 !== maxY) continue;
    const radius = Math.max(1, crown.radius - 1);
    topMinX = Math.min(topMinX, crown.x - radius);
    topMaxX = Math.max(topMaxX, crown.x + radius + 1);
    topMinZ = Math.min(topMinZ, crown.z - radius);
    topMaxZ = Math.max(topMaxZ, crown.z + radius + 1);
  }
  const radiusX = (maxX - minX) / 2,
    radiusZ = (maxZ - minZ) / 2;
  const topRadiusX = (topMaxX - topMinX) / 2,
    topRadiusZ = (topMaxZ - topMinZ) / 2;
  return {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
    topX: (topMinX + topMaxX) / 2,
    topZ: (topMinZ + topMaxZ) / 2,
    minY,
    maxY,
    radiusX,
    radiusZ,
    topRadiusX,
    topRadiusZ,
    radius: Math.max(radiusX, radiusZ),
    topRadius: Math.max(topRadiusX, topRadiusZ),
    block: crowns[0].block,
  };
}

function crownGroups(crowns, limit) {
  if (!crowns.length) return [];
  const groups = [crowns];
  // Spatial median splits retain off-center lobes and vertical tiers without
  // making one primitive per leaf layer. No clustering state crosses trees.
  while (groups.length < limit) {
    let selected = 0;
    for (let i = 1; i < groups.length; i++)
      if (groups[i].length > groups[selected].length) selected = i;
    const group = groups[selected];
    if (group.length <= 1) break;
    let axis = "y",
      span = -1;
    for (const candidate of ["y", "x", "z"]) {
      const values = group.map((crown) => crown[candidate]);
      const distance = Math.max(...values) - Math.min(...values);
      if (distance > span) {
        axis = candidate;
        span = distance;
      }
    }
    const sorted = [...group].sort((a, b) => a[axis] - b[axis]);
    const middle = Math.floor(sorted.length / 2);
    groups.splice(selected, 1, sorted.slice(0, middle), sorted.slice(middle));
  }
  return groups;
}

// A crown primitive is a coarse hull of native crown writes, never a new tree.
// Centered conifers keep up to three tiers; asymmetric crowns keep up to six
// spatial lobes. Their actual offsets, height, taper and unequal X/Z extents are
// retained, including v3 shapes. At most seven hulls include the main trunk.
export function treePrimitives(tree, { maxCrowns = 6 } = {}) {
  const result = [];
  const trunk = tree.parts.find((part) => part.kind === "trunk");
  if (trunk) {
    result.push({
      x: trunk.x + trunk.width / 2,
      z: trunk.z + trunk.width / 2,
      minY: trunk.y + 1,
      maxY: trunk.y + trunk.height + 1,
      radius: trunk.width / 2,
      topRadius: trunk.width / 2,
      block: trunk.block,
    });
  }
  const crowns = tree.parts.filter(
    (part) => part.kind === "crown" || part.kind === "legacy-crown"
  );
  const centeredConifer =
    ["spruce", "pine", "giant_spruce"].includes(tree.type) &&
    crowns.every((crown) => crown.x === crowns[0].x && crown.z === crowns[0].z);
  const groupLimit = Math.max(1, Math.min(6, Math.floor(maxCrowns) || 6));
  for (const group of crownGroups(
    crowns,
    Math.min(centeredConifer ? 3 : 6, groupLimit)
  ))
    result.push(crownHull(group));
  return result;
}

// Cache reduced, renderer-owned hulls, not voxel chunks or mutable native tree
// parts. Identity/epoch changes clear this from DistantTerrain; a different
// generator also invalidates it here for callers using this helper directly.
export function createDistantVegetationCache({
  maxSamples,
  maxPrimitives,
} = {}) {
  const samples = new Map();
  const populated = new Set();
  const sampleLimit = limit(maxSamples, DISTANT_VEGETATION_LIMITS.cachedSamples);
  const primitiveLimit = limit(
    maxPrimitives,
    DISTANT_VEGETATION_LIMITS.cachedPrimitives
  );
  let primitiveCount = 0;
  let owner = null;
  return {
    get size() {
      return samples.size;
    },
    get primitiveCount() {
      return primitiveCount;
    },
    clear() {
      samples.clear();
      populated.clear();
      primitiveCount = 0;
      owner = null;
    },
    read(generator, gx, gz) {
      if (owner !== generator) {
        samples.clear();
        populated.clear();
        primitiveCount = 0;
        owner = generator;
      }
      const key = `${gx},${gz}`;
      if (samples.has(key)) {
        const entry = samples.get(key);
        samples.delete(key);
        samples.set(key, entry);
        if (entry.count) {
          populated.delete(key);
          populated.add(key);
        }
        return { trees: entry.trees, fresh: false };
      }
      const native = generator.getTrees(gx, gz);
      if (
        native.length > DISTANT_VEGETATION_LIMITS.treesPerCell ||
        native.some(
          (tree) =>
            tree.parts.length > DISTANT_VEGETATION_LIMITS.partsPerTree
        )
      )
        return { trees: [], fresh: true, overflow: true };
      const trees = native.map((tree) => {
        const root = tree.parts.find((part) => part.kind === "trunk");
        const x = tree.x ?? root?.x ?? gx * TREE_SPACING;
        const z = tree.z ?? root?.z ?? gz * TREE_SPACING;
        const biome = generator.getBiome?.(x, z);
        const palette = new Map();
        const variation = 0.94 + hash(x, z, 0x5729) * 0.12;
        const tint = (primitive) => {
          if (!palette.has(primitive.block)) {
            const base = new THREE.Color(
              BLOCKS[primitive.block]?.color ?? "#578a3d"
            );
            const biomeTint = getBiomeTint(primitive.block, "side", biome);
            palette.set(
              primitive.block,
              base
                .toArray()
                .map((channel, i) => channel * biomeTint[i] * variation)
            );
          }
          return { ...primitive, color: palette.get(primitive.block) };
        };
        return {
          x,
          z,
          exclude: tree.exclude ? { ...tree.exclude } : undefined,
          fine: treePrimitives(tree).map(tint),
          coarse: treePrimitives(tree, { maxCrowns: 2 }).map(tint),
        };
      });
      const count = trees.reduce(
        (sum, tree) => sum + tree.fine.length + tree.coarse.length,
        0
      );
      if (sampleLimit > 0 && count <= primitiveLimit) {
        while (
          samples.size >= sampleLimit ||
          primitiveCount + count > primitiveLimit
        ) {
          // A forest admission must not walk thousands of cached empty cells
          // just to free a few hulls. Both eviction queues retain LRU order.
          const oldest =
            primitiveCount + count > primitiveLimit
              ? populated.values().next().value
              : samples.keys().next().value;
          primitiveCount -= samples.get(oldest).count;
          samples.delete(oldest);
          populated.delete(oldest);
        }
        samples.set(key, { trees, count });
        if (count) populated.add(key);
        primitiveCount += count;
      }
      return { trees, fresh: true };
    },
  };
}

function canopyBands(primitive, coarse) {
  const { x, z, minY, maxY, radius, topRadius } = primitive;
  const radiusX = primitive.radiusX ?? radius;
  const radiusZ = primitive.radiusZ ?? radius;
  const topX = primitive.topX ?? x;
  const topZ = primitive.topZ ?? z;
  const topRadiusX = primitive.topRadiusX ?? topRadius;
  const topRadiusZ = primitive.topRadiusZ ?? topRadius;
  const box = (px, pz, rx, rz, low, high) => ({
    ...primitive,
    x: px,
    z: pz,
    topX: px,
    topZ: pz,
    radiusX: rx,
    radiusZ: rz,
    topRadiusX: rx,
    topRadiusZ: rz,
    minY: low,
    maxY: high,
  });
  // The distant tier still uses native, asymmetric crown groups, but one box
  // per group. Nearer crowns have a one-block cap, never a smooth pyramid.
  if (
    coarse ||
    (x === topX && z === topZ && radiusX === topRadiusX && radiusZ === topRadiusZ)
  )
    return [box(x, z, radiusX, radiusZ, minY, maxY)];
  const cap = Math.max(minY, maxY - 1);
  const bands = [];
  if (cap > minY) bands.push(box(x, z, radiusX, radiusZ, minY, cap));
  bands.push(box(topX, topZ, topRadiusX, topRadiusZ, cap, maxY));
  return bands;
}

function clip(polygon, axis, boundary, lower) {
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const insideA = lower ? a[axis] >= boundary : a[axis] <= boundary;
    const insideB = lower ? b[axis] >= boundary : b[axis] <= boundary;
    if (insideA) result.push(a);
    if (insideA !== insideB) {
      const t = (boundary - a[axis]) / (b[axis] - a[axis]);
      const point = a.map((value, n) => value + (b[n] - value) * t);
      point[axis] = boundary;
      result.push(point);
    }
  }
  return result;
}

function normal(a, b, c) {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const x = uy * vz - uz * vy,
    y = uz * vx - ux * vz,
    z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z);
  return length > 1e-8 ? [x / length, y / length, z / length] : null;
}

function coveredByRectangle(cx, cz, rectangle) {
  return (
    cx * CHUNK_SIZE < rectangle.maxX &&
    (cx + 1) * CHUNK_SIZE > rectangle.minX &&
    cz * CHUNK_SIZE < rectangle.maxZ &&
    (cz + 1) * CHUNK_SIZE > rectangle.minZ
  );
}

class VegetationLayer {
  constructor(job, material) {
    this.group = new THREE.Group();
    this.group.name = "Distant vegetation";
    this.group.position.set(job.originX, 0, job.originZ);
    this._ownsMaterial = !material;
    this._disposed = false;
    this._buckets = [];
    const geometry = new THREE.BufferGeometry();
    for (const [name, values] of [
      ["position", job._positions],
      ["normal", job._normals],
      ["color", job._colors],
    ])
      geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, 3));
    const vertexCount = geometry.getAttribute("position").count;
    const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
    this._sourceIndices = new IndexArray(job._indices.length);
    let cursor = 0;
    // Compact once by owning chunk. Every later edit/streaming cutout is a
    // typed-array copy per visible chunk, not a JavaScript walk per triangle.
    for (const { cx, cz, ranges } of job._buckets.values()) {
      const start = cursor;
      for (let r = 0; r < ranges.length; r += 2)
        for (let i = ranges[r]; i < ranges[r] + ranges[r + 1]; i++)
          this._sourceIndices[cursor++] = job._indices[i];
      this._buckets.push({ cx, cz, start, count: cursor - start });
    }
    const indices = new IndexArray(job._indices.length);
    geometry.setIndex(
      new THREE.BufferAttribute(indices, 1).setUsage(THREE.DynamicDrawUsage)
    );
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(
        job.bounds.minX - job.originX,
        job.minY,
        job.bounds.minZ - job.originZ
      ),
      new THREE.Vector3(
        job.bounds.maxX - job.originX,
        job.maxY,
        job.bounds.maxZ - job.originZ
      )
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
      new THREE.Sphere()
    );
    this.mesh = new THREE.Mesh(
      geometry,
      material ?? new THREE.MeshLambertMaterial({ vertexColors: true })
    );
    this.mesh.name = "Distant tree canopies";
    this.group.add(this.mesh);
    this.treeCount = job.treeCount;
    this.sampleCount = job.sampleCount;
    this.nativeSamples = job.nativeSamples;
    this.primitiveCount = job.primitiveCount;
    this.resourceBytes =
      vertexCount * 9 * Float32Array.BYTES_PER_ELEMENT + indices.byteLength;
    this.cutout();
  }

  // A coverage predicate receives CHUNK coordinates and is true only for chunks
  // whose authoritative meshes currently own the view (including edited chunks).
  // Rectangle(s) are also accepted; non-aligned edges conservatively hide a chunk.
  // Faces were clipped at chunk borders while sampling, so partial trees survive
  // outside coverage with no proxy triangle crossing a full-detail chunk.
  cutout(coverage = () => false) {
    if (this._disposed) return false;
    const rectangles = Array.isArray(coverage) ? coverage : [coverage];
    const covered =
      typeof coverage === "function"
        ? coverage
        : (cx, cz) =>
            rectangles.some((rectangle) =>
              coveredByRectangle(cx, cz, rectangle)
            );
    const geometry = this.mesh.geometry;
    const indices = geometry.index.array;
    let count = 0;
    for (const { cx, cz, start, count: length } of this._buckets) {
      if (covered(cx, cz)) continue;
      indices.set(this._sourceIndices.subarray(start, start + length), count);
      count += length;
    }
    geometry.setDrawRange(0, count);
    geometry.index.needsUpdate = true;
    this.mesh.visible = count > 0;
    return this.mesh.visible;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.mesh.geometry.dispose();
    if (this._ownsMaterial) this.mesh.material.dispose();
    this.group.removeFromParent();
    this._buckets.length = 0;
    this._sourceIndices = null;
  }
}

class VegetationJob {
  constructor(generator, bounds, { spec, cache, center, limits = {} } = {}) {
    if (typeof generator?.getTrees !== "function")
      throw new TypeError(
        "Distant vegetation requires native getTrees(gx, gz)"
      );
    if (
      !bounds ||
      !["minX", "maxX", "minZ", "maxZ"].every((key) =>
        Number.isFinite(bounds[key])
      ) ||
      bounds.maxX <= bounds.minX ||
      bounds.maxZ <= bounds.minZ
    )
      throw new RangeError(
        "Distant vegetation requires finite, positive bounds"
      );
    this.bounds = {
      minX: Math.max(WORLD_MIN, bounds.minX),
      maxX: Math.min(WORLD_MAX, bounds.maxX),
      minZ: Math.max(WORLD_MIN, bounds.minZ),
      maxZ: Math.min(WORLD_MAX, bounds.maxZ),
    };
    const worldSpec = geometryWorldSpec(spec ?? generator);
    this.minY =
      worldSpec.minY === 0 && worldSpec.maxY === 96 ? 1 : worldSpec.minY;
    this.maxY = worldSpec.maxY;
    if (
      this.bounds.minX >= this.bounds.maxX ||
      this.bounds.minZ >= this.bounds.maxZ
    )
      throw new RangeError(
        "Distant vegetation bounds must intersect the world"
      );
    this.originX =
      Math.floor((this.bounds.minX + this.bounds.maxX) / (2 * CHUNK_SIZE)) *
      CHUNK_SIZE;
    this.originZ =
      Math.floor((this.bounds.minZ + this.bounds.maxZ) / (2 * CHUNK_SIZE)) *
      CHUNK_SIZE;
    this._minGX = Math.max(
      WORLD_MIN / TREE_SPACING,
      Math.floor((this.bounds.minX - TREE_REACH) / TREE_SPACING)
    );
    this._minGZ = Math.max(
      WORLD_MIN / TREE_SPACING,
      Math.floor((this.bounds.minZ - TREE_REACH) / TREE_SPACING)
    );
    const maxGX = Math.min(
      WORLD_MAX / TREE_SPACING - 1,
      Math.ceil((this.bounds.maxX + TREE_REACH) / TREE_SPACING) - 1
    );
    const maxGZ = Math.min(
      WORLD_MAX / TREE_SPACING - 1,
      Math.ceil((this.bounds.maxZ + TREE_REACH) / TREE_SPACING) - 1
    );
    this._width = Math.max(0, maxGX - this._minGX + 1);
    this.totalSamples = this._width * Math.max(0, maxGZ - this._minGZ + 1);
    if (this.totalSamples > DISTANT_VEGETATION_LIMITS.jobSamples)
      throw new RangeError(
        "Distant vegetation jobs are limited to 16384 feature cells; tile larger views"
      );
    this._generator = generator;
    this._cache = cache ?? createDistantVegetationCache();
    this._ownsCache = !cache;
    this._center = center;
    this.limits = {
      vertices: limit(limits.vertices, DISTANT_VEGETATION_LIMITS.vertices),
      indices: limit(limits.indices, DISTANT_VEGETATION_LIMITS.indices),
    };
    this.status = "building";
    this.lastStep = { samples: 0, cells: 0, primitives: 0 };
    this._pending = [];
    this._pendingCursor = 0;
    this.sampleCount = 0;
    this.nativeSamples = 0;
    this.treeCount = 0;
    this.primitiveCount = 0;
    this._positions = [];
    this._normals = [];
    this._colors = [];
    this._indices = [];
    this._palette = new Map();
    this._buckets = new Map();
    this._disposed = false;
    this._built = false;
  }

  get done() {
    return (
      this.status === "budget" ||
      (this.sampleCount === this.totalSamples &&
        this._pendingCursor === this._pending.length)
    );
  }

  _emit(polygon, facing, color, cx, cz, primitive) {
    const start = this._indices.length;
    const first = this._positions.length / 3;
    if (
      first + polygon.length > this.limits.vertices ||
      start + (polygon.length - 2) * 3 > this.limits.indices
    ) {
      this.status = "budget";
      return false;
    }
    for (let i = 1; i < polygon.length - 1; i++) {
      const vertices = [polygon[0], polygon[i], polygon[i + 1]];
      if (!normal(...vertices)) continue;
      this._indices.push(first, first + i, first + i + 1);
    }
    const count = this._indices.length - start;
    if (!count) return true;
    // Vertices are shared within each clipped face. Hard normals remain voxel-
    // sharp without storing six attribute triples for every rectangular face.
    for (const [x, y, z] of polygon) {
      this._positions.push(x - this.originX, y, z - this.originZ);
      this._normals.push(...facing);
      const height = THREE.MathUtils.clamp(
        (y - primitive.minY) / (primitive.maxY - primitive.minY),
        0,
        1
      );
      const shade = leafBlock[primitive.block]
        ? (0.78 + height * 0.22) * (facing[1] < -0.5 ? 0.8 : 1)
        : 0.88 + height * 0.12;
      this._colors.push(color[0] * shade, color[1] * shade, color[2] * shade);
    }
    const key = `${cx},${cz}`;
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = { cx, cz, ranges: [] };
      this._buckets.set(key, bucket);
    }
    const ranges = bucket.ranges,
      last = ranges.length - 2;
    if (last >= 0 && ranges[last] + ranges[last + 1] === start)
      ranges[last + 1] += count;
    else ranges.push(start, count);
    return true;
  }

  _append(primitive, exclude, coarse) {
    for (const band of canopyBands(primitive, coarse)) {
      this._appendHull(band, exclude);
      if (this.status === "budget") return;
    }
  }

  _appendHull(primitive, exclude) {
    const { x, z, minY, maxY, radius, topRadius, block } = primitive;
    const radiusX = primitive.radiusX ?? radius,
      radiusZ = primitive.radiusZ ?? radius;
    const topRadiusX = primitive.topRadiusX ?? topRadius,
      topRadiusZ = primitive.topRadiusZ ?? topRadius;
    const topX = primitive.topX ?? x,
      topZ = primitive.topZ ?? z;
    if (
      ![
        x,
        z,
        topX,
        topZ,
        minY,
        maxY,
        radiusX,
        radiusZ,
        topRadiusX,
        topRadiusZ,
      ].every(Number.isFinite) ||
      radiusX <= 0 ||
      radiusZ <= 0 ||
      topRadiusX < 0 ||
      topRadiusZ < 0 ||
      maxY <= minY
    )
      return;
    const minX = Math.max(
      this.bounds.minX,
      Math.min(x - radiusX, topX - topRadiusX)
    );
    const maxX = Math.min(
      this.bounds.maxX,
      Math.max(x + radiusX, topX + topRadiusX)
    );
    const minZ = Math.max(
      this.bounds.minZ,
      Math.min(z - radiusZ, topZ - topRadiusZ)
    );
    const maxZ = Math.min(
      this.bounds.maxZ,
      Math.max(z + radiusZ, topZ + topRadiusZ)
    );
    if (minX >= maxX || minZ >= maxZ || minY >= this.maxY || maxY <= this.minY)
      return;
    const columns =
      (Math.ceil(maxX / CHUNK_SIZE) - Math.floor(minX / CHUNK_SIZE)) *
      (Math.ceil(maxZ / CHUNK_SIZE) - Math.floor(minZ / CHUNK_SIZE));
    if (columns > DISTANT_VEGETATION_LIMITS.clipColumnsPerHull) {
      this.status = "budget";
      return;
    }
    const points = [
      [x - radiusX, minY, z - radiusZ],
      [x + radiusX, minY, z - radiusZ],
      [x + radiusX, minY, z + radiusZ],
      [x - radiusX, minY, z + radiusZ],
      [topX - topRadiusX, maxY, topZ - topRadiusZ],
      [topX + topRadiusX, maxY, topZ - topRadiusZ],
      [topX + topRadiusX, maxY, topZ + topRadiusZ],
      [topX - topRadiusX, maxY, topZ + topRadiusZ],
    ];
    let color = primitive.color ?? this._palette.get(block);
    if (!color) {
      color = new THREE.Color(BLOCKS[block]?.color ?? "#578a3d").toArray();
      this._palette.set(block, color);
    }
    for (const face of FACES) {
      const vertices = face.map((index) => points[index]);
      const facing = normal(...vertices.slice(0, 3));
      if (!facing) continue;
      for (
        let cz = Math.floor(minZ / CHUNK_SIZE);
        cz < Math.ceil(maxZ / CHUNK_SIZE);
        cz++
      ) {
        for (
          let cx = Math.floor(minX / CHUNK_SIZE);
          cx < Math.ceil(maxX / CHUNK_SIZE);
          cx++
        ) {
          if (exclude && coveredByRectangle(cx, cz, exclude)) continue;
          let polygon = vertices;
          for (const [axis, boundary, lower] of [
            [0, Math.max(minX, cx * CHUNK_SIZE), true],
            [0, Math.min(maxX, (cx + 1) * CHUNK_SIZE), false],
            [2, Math.max(minZ, cz * CHUNK_SIZE), true],
            [2, Math.min(maxZ, (cz + 1) * CHUNK_SIZE), false],
            [1, this.minY, true],
            [1, this.maxY, false],
          ]) {
            polygon = clip(polygon, axis, boundary, lower);
            if (polygon.length < 3) break;
          }
          if (
            polygon.length >= 3 &&
            !this._emit(polygon, facing, color, cx, cz, primitive)
          )
            return;
        }
      }
    }
  }

  // No timers, chunk loading, world edits, or collision access. The caller spends
  // its remaining frame budget here and may cancel the job on any world change.
  step({
    budgetMs = 1,
    maxSamples = DISTANT_VEGETATION_LIMITS.samplesPerStep,
  } = {}) {
    this.lastStep = { samples: 0, cells: 0, primitives: 0 };
    if (this._disposed || this._built) return this.done;
    const budget = Number.isFinite(budgetMs)
      ? Math.max(0, Math.min(4, budgetMs))
      : 1;
    const sampleLimit = limit(
      maxSamples,
      DISTANT_VEGETATION_LIMITS.samplesPerStep
    );
    if (!sampleLimit || !budget) return this.done;
    const started = performance.now();
    let samples = 0,
      cells = 0,
      primitives = 0;
    while (!this.done && performance.now() - started < budget) {
      if (this._pendingCursor < this._pending.length) {
        if (primitives >= DISTANT_VEGETATION_LIMITS.primitivesPerStep) break;
        const { primitive, exclude, coarse } =
          this._pending[this._pendingCursor++];
        this._append(primitive, exclude, coarse);
        primitives++;
        this.primitiveCount++;
        continue;
      }
      if (
        samples >= sampleLimit ||
        cells >= DISTANT_VEGETATION_LIMITS.cellsPerStep
      )
        break;
      const gx = this._minGX + (this.sampleCount % this._width);
      const gz = this._minGZ + Math.floor(this.sampleCount / this._width);
      const { trees, fresh, overflow } = this._cache.read(
        this._generator,
        gx,
        gz
      );
      this._pending = [];
      this._pendingCursor = 0;
      for (const tree of trees) {
        const coarse =
          this._center &&
          Math.max(
            Math.abs(tree.x - this._center.x),
            Math.abs(tree.z - this._center.z)
          ) > DETAILED_CANOPY_DISTANCE;
        for (const primitive of coarse ? tree.coarse : tree.fine)
          this._pending.push({ primitive, exclude: tree.exclude, coarse });
      }
      this.treeCount += trees.length;
      this.nativeSamples += Number(fresh);
      samples += Number(fresh);
      this.sampleCount++;
      cells++;
      if (overflow) this.status = "budget";
    }
    this.lastStep = { samples, cells, primitives };
    if (this.done && this.status === "building") this.status = "ready";
    return this.done;
  }

  build(material) {
    if (this._disposed || this._built || !this.done || this.status === "budget")
      throw new Error("Build a completed, admitted vegetation job exactly once");
    const layer = new VegetationLayer(this, material);
    this._built = true;
    this.dispose();
    return layer;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._positions.length = this._normals.length = this._colors.length = 0;
    this._indices.length = 0;
    this._pending.length = 0;
    this._pendingCursor = 0;
    this._buckets.clear();
    this._palette.clear();
    if (this._ownsCache) this._cache.clear();
    this._generator = null;
  }
}

// Bounds are world coordinates, [minX,maxX) × [minZ,maxZ). Geometry uses a
// chunk-aligned local origin, including near ±30,000,000. Larger horizons can
// schedule multiple adjacent jobs; the padded root scan clips crowns exactly
// to each job's bounds, so neighboring jobs have neither gaps nor overlap.
export function createDistantVegetationJob(generator, bounds, options) {
  return new VegetationJob(generator, bounds, options);
}
