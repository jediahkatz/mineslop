import { intersectRayBox, UNIT_BOX } from "../../src/aabb.js";
import { defaultFluidFor, FLUID } from "../../src/block-state.js";
import { resolveShape } from "../../src/block-shapes.js";
import { BLOCK, BLOCKS } from "../../src/blocks.js";
import { geometryWorldSpec, inHorizontalBounds } from "../../src/geometry-world.js";
import { SECTION_HEIGHT } from "../../src/mesh-snapshot.js";
import { raycast } from "../../src/raycast.js";
import { sectionGeometryCovered } from "../../src/section-pages.js";
import { CHUNK_SIZE } from "../../src/terrain.js";

export const VIEW_DIAGNOSTIC_LIMITS = Object.freeze({
  observations: 128,
  rayDistance: 64,
  cellReads: 4096,
  meshNodes: 256,
  parentDepth: 32,
  coverageRadius: 4,
});
const LABEL = "generated-terrain-traversal";
const OFFSETS = [[0, 0], [-0.25, -0.3], [0.25, -0.3]];
const FULL_VOXEL = Object.freeze({ render: [UNIT_BOX] });
const EMPTY_VOXEL = Object.freeze({ render: [] });
const copy = ({ x, y, z }) => ({ x, y, z });
const array = ({ x, y, z }) => [x, y, z];
const normalize = (v) => {
  const length = Math.hypot(v.x, v.y, v.z);
  return length > 0 && Number.isFinite(length)
    ? { x: v.x / length, y: v.y / length, z: v.z / length }
    : null;
};

/** CPU point depths, not pixels, occlusion, opacity, or projected screen area. */
export function pointDepths(origin, point, forward, viewMatrix = null) {
  const dx = point.x - origin.x, dy = point.y - origin.y, dz = point.z - origin.z;
  const unit = forward && normalize(forward);
  return {
    radial: Math.hypot(dx, dy, dz),
    cameraForward: viewMatrix
      ? -(viewMatrix[2] * point.x + viewMatrix[6] * point.y +
          viewMatrix[10] * point.z + viewMatrix[14])
      : unit ? dx * unit.x + dy * unit.y + dz * unit.z : null,
  };
}

export function fogBand(depth, fog) {
  if (!Number.isFinite(depth) || !Number.isFinite(fog?.near) ||
      !Number.isFinite(fog?.far) || fog.far <= fog.near) return "unknown";
  if (depth < 0) return "behind-camera";
  if (depth >= fog.far) return "at-or-beyond-far";
  return depth <= fog.near ? "before-near" : "inside-ramp";
}

/** Explain exclusion of this first CPU voxel, without sampling the world again. */
export function legacyVoxelSampling(ray, legacy, direction = ray.direction) {
  const limit = Math.min(100, legacy.fogFar);
  const lastStep = Number.isFinite(limit) && limit >= 0.5
    ? 0.5 + Math.floor((limit - 0.5) / 0.75) * 0.75 : null;
  const result = { limit, lastStep, entry: null, exit: null, sampledStep: null,
    reason: "no-known-voxel", firstCandidateOnly: true };
  const hit = ray.firstVoxelHit;
  if (!hit) return result;
  // Intersect only this already-known unit voxel. A cell entered just before
  // the diagnostic cap can still contain a later legacy grid point.
  const interval = intersectRayBox(array(ray.origin), array(direction),
    [hit.x, hit.y, hit.z, hit.x + 1, hit.y + 1, hit.z + 1], 100);
  if (!interval || !Number.isFinite(limit)) return { ...result, reason: "unknown" };
  result.entry = interval.distance;
  result.exit = interval.far;
  // At most 133 arithmetic checks. Keep the original raw direction and exact
  // floor semantics, including grid points on a negative-direction voxel face.
  for (let step = 0.5; step <= limit; step += 0.75) {
    if (["x", "y", "z"].every((axis) =>
      Math.floor(ray.origin[axis] + direction[axis] * step) === hit[axis])) {
      result.sampledStep = step;
      break;
    }
  }
  result.reason = hit.id === BLOCK.AIR ? "legacy-ignores-fluid-only-cell"
    : result.sampledStep !== null ? "candidate-on-grid"
      : interval.distance > limit ? "beyond-radial-limit"
        : lastStep === null ? "no-grid-samples"
          : interval.distance > lastStep ? "after-last-grid-sample" : "between-grid-samples";
  return result;
}

/** Independent facts; none of these categories establish a rendering defect. */
export function categorizeViewRay(ray, fog, legacyLimit) {
  const { firstVoxelHit: voxel, firstShapeHit: shape, firstUnknown } = ray;
  const categories = [];
  if (ray.truncated) categories.push("cell-read-cap");
  if (ray.crossesWorldBounds) categories.push("world-boundary-within-cap");
  if (ray.unknownCellsRead) categories.push("unknown-neighborhood-sampled");
  if (firstUnknown && (!shape || firstUnknown.depth.radial <= shape.depth.radial))
    categories.push("unknown-source-before-shape-candidate");
  if (!voxel && !ray.truncated)
    categories.push(firstUnknown ? "no-known-voxel-hit" : "no-voxel-hit-within-cap");
  if (voxel && !shape && !ray.truncated) categories.push("voxel-without-shape-hit");
  if (voxel && shape && shape.depth.radial > voxel.depth.radial + 1e-7)
    categories.push("shape-hit-after-voxel-entry");
  if (voxel?.depth.radial > legacyLimit) categories.push("voxel-beyond-legacy-limit");
  if (shape) {
    const band = fogBand(shape.depth.cameraForward, fog);
    categories.push(`shape-fog:${band}`);
    if (shape.depth.radial > legacyLimit &&
        ["before-near", "inside-ramp"].includes(band))
      categories.push("radial-limit-excludes-forward-fog-candidate");
    if (shape.availability?.covered === false) categories.push("renderer-mask-uncovered");
    if (shape.availability?.groupPresent === false) categories.push("missing-detail-group");
    else if (shape.availability?.groupVisible === false) categories.push("hidden-detail-group");
    else if (shape.availability?.groupAttached === false) categories.push("detached-detail-group");
    const mesh = shape.availability?.mesh;
    if (mesh?.complete && !mesh.eligibilityUnknown && mesh.drawableCandidates === 0)
      categories.push("no-drawable-detail-candidate");
  }
  return categories;
}

class ReadCap extends Error {
  constructor() {
    super("View diagnostic cell-read cap reached");
  }
}

export function createViewDiagnosticReader(world) {
  const spec = geometryWorldSpec(world);
  const cells = new Map();
  return {
    spec,
    get reads() { return cells.size; },
    read(x, y, z) {
      const key = `${x},${y},${z}`;
      if (cells.has(key)) return cells.get(key);
      if (cells.size >= VIEW_DIAGNOSTIC_LIMITS.cellReads) throw new ReadCap();
      let result;
      if (!inHorizontalBounds(x, z) || y < spec.minY || y >= spec.maxY) {
        result = { cell: null, status: "outside-world" };
      } else if (!world.isLoaded(x, z)) {
        result = { cell: null, status: "unloaded" };
      } else {
        const value = world.getCell(x, y, z);
        result = value ? {
          cell: { id: value.id, state: value.state ?? 0,
            fluid: value.fluid ?? defaultFluidFor(value.id) },
          status: "loaded",
        } : { cell: null, status: "missing-cell-in-loaded-column" };
      }
      cells.set(key, result);
      return result;
    },
  };
}

function attachedVisible(node, scene) {
  for (let depth = 0; node && depth < VIEW_DIAGNOSTIC_LIMITS.parentDepth; depth++, node = node.parent) {
    if (node.visible === false) return false;
    if (node === scene) return true;
  }
  return false;
}

function meshCandidate(mesh, graphics, range) {
  if (!mesh?.isMesh || mesh.userData?.sectionSource ||
      !attachedVisible(mesh, graphics.scene)) return false;
  const cameraMask = graphics.camera.layers?.mask ?? 1;
  if (!(cameraMask & (mesh.layers?.mask ?? 1))) return false;
  // Material arrays and hosted water need more than this bounded metadata check.
  if (Array.isArray(mesh.material) || mesh.userData?.sectionWater) return null;
  if (!mesh.material || mesh.material.visible === false) return false;
  const geometry = mesh.geometry;
  const count = geometry?.index?.count ?? geometry?.attributes?.position?.count ?? 0;
  const draw = geometry?.drawRange;
  if (!draw || draw.count <= 0 || draw.start >= count || count <= 0) return false;
  return !range || (range.count > 0 && draw.start <= range.start &&
    range.start + range.count <= Math.min(count, draw.start + draw.count));
}

function inspectMeshes(group, graphics, budget) {
  const result = { nodes: 0, sourceMeshes: 0, packedRanges: 0,
    drawableCandidates: 0, eligibilityUnknown: false, complete: true };
  // Iterator frames avoid copying/pushing arbitrarily wide child arrays.
  const stack = group ? [{ node: group, index: -1 }] : [];
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.index === -1) {
      if (budget.nodes >= VIEW_DIAGNOSTIC_LIMITS.meshNodes) {
        result.complete = false;
        break;
      }
      budget.nodes++;
      result.nodes++;
      const node = frame.node;
      if (node.isMesh) {
        let candidate;
        if (node.userData?.sectionSource) {
          result.sourceMeshes++;
          const range = group.userData?.sectionRanges?.get(node);
          if (range) {
            result.packedRanges++;
            candidate = meshCandidate(range.mesh, graphics, range);
          }
        } else candidate = meshCandidate(node, graphics);
        result.drawableCandidates += Number(candidate === true);
        result.eligibilityUnknown ||= candidate === null;
      }
      frame.index = 0;
    }
    const children = frame.node.children ?? [];
    if (frame.index < children.length) stack.push({ node: children[frame.index++], index: -1 });
    else stack.pop();
  }
  return result;
}

function availabilityReader(game, coverage, budget) {
  const { world, graphics } = game;
  const cache = new Map();
  return (x, z, inspect = false) => {
    const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    const group = graphics.chunks.get(key);
    if (!cache.has(key)) cache.set(key, {
      key,
      sourceResident: world.chunks.has(key),
      requested: world._requests?.has(key) ?? null,
      dirty: world.dirtyChunks?.has(key) ?? null,
      covered: coverage ? coverage.has(key) : null,
      groupPresent: !!group,
      groupVisible: group ? group.visible === true : null,
      groupAttached: group ? group.parent === graphics.scene : null,
      groupMeshed: group ? group.userData?.meshed === true : null,
      sections: group?.userData?.sections?.size ?? null,
      requiredSections: group?.userData?.requiredSections?.length ?? null,
    });
    const value = cache.get(key);
    if (inspect && !value.mesh) value.mesh = inspectMeshes(group, graphics, budget);
    return value;
  };
}

function hitSectionReader(game, budget) {
  const { graphics, world } = game;
  const cache = new Map();
  const count = (mesh) => mesh?.geometry?.index?.count ?? mesh?.geometry?.attributes?.position?.count ?? 0;
  const boundedParents = (node) => {
    let depth = 0;
    while (node && depth++ < VIEW_DIAGNOSTIC_LIMITS.parentDepth - 2) node = node.parent;
    return !node;
  };
  return (hit) => {
    const key = `${Math.floor(hit.x / CHUNK_SIZE)},${Math.floor(hit.z / CHUNK_SIZE)}`;
    // The owning voxel, not the surface point: a block at y=63 has a face at 64.
    const sy = Math.floor(hit.y / SECTION_HEIGHT), sectionKey = `${key},${sy}`;
    if (cache.has(sectionKey)) return cache.get(sectionKey);
    const column = graphics.chunks.get(key), sections = column?.userData?.sections;
    const section = sections?.get(sy);
    const source = world.chunks.get(key);
    const result = {
      key: sectionKey, index: sy, sectioned: !!sections, present: !!section,
      geometryCovered: null, sources: [], unknownReason: null,
      dirty: world.dirtySectionRevisions?.has(sectionKey) ?? null,
      sourceIncarnationMatches: source?.incarnation !== undefined && column?.userData?.incarnation !== undefined
        ? source.incarnation === column.userData.incarnation : null,
    };
    cache.set(sectionKey, result);
    if (!sections) {
      result.unknownReason = "non-sectioned-or-missing-column";
      return result;
    }
    if (!section) {
      result.geometryCovered = false;
      return result;
    }
    const children = section.group?.children ?? [];
    // Reserve both the metadata pass and the production predicate's source/page
    // pass from the existing shared node cap; never walk the whole column again.
    const work = 2 + 4 * children.length;
    if (budget.nodes + work > VIEW_DIAGNOSTIC_LIMITS.meshNodes) {
      result.unknownReason = "mesh-node-cap";
      return result;
    }
    budget.nodes += work;
    if (!boundedParents(column)) {
      result.unknownReason = "parent-depth-cap";
      return result;
    }
    result.empty = children.length === 0;
    result.storedDraws = section.draws;
    result.groupVisible = section.group?.visible ?? null;
    result.groupAttached = section.group?.parent === column;
    for (const child of children) {
      const cpuOnly = child.userData?.sectionSource === true;
      const range = cpuOnly ? column.userData.sectionRanges?.get(child) : null;
      const physical = cpuOnly ? range?.mesh : child;
      const candidate = physical ? meshCandidate(physical, graphics, range) : false;
      const physicalOwner = physical?.parent;
      result.sources.push({
        batch: child.userData?.batch ?? null, cpuOnly, sourceCount: count(child),
        mapped: cpuOnly ? !!range : null, rangeStart: range?.start ?? null,
        rangeCount: range?.count ?? null, physicalCount: count(physical),
        physicalDrawStart: physical?.geometry?.drawRange?.start ?? null,
        physicalDrawCount: physical?.geometry?.drawRange?.count === Infinity
          ? "all" : physical?.geometry?.drawRange?.count ?? null,
        physicalCandidate: candidate,
        ownerKind: physicalOwner === column ? "column"
          : physicalOwner?.userData?.sectionRegion ? "regional" : "other",
        regionalSectionMatches: physicalOwner?.userData?.sectionRegion
          ? physicalOwner.userData.sections?.get(sectionKey)?.group === section.group : null,
      });
      if (!boundedParents(child) || !boundedParents(physical))
        result.unknownReason = "parent-depth-cap";
      if (candidate === null || Array.isArray(child.material) || Array.isArray(physical?.material) ||
          child.userData?.sectionWater || physical?.userData?.sectionWater)
        result.unknownReason = "specialized-material-or-water";
    }
    if (!result.unknownReason)
      result.geometryCovered = column.parent === graphics.scene &&
        sectionGeometryCovered(column, section, graphics.camera);
    return result;
  };
}

function traceRay(source, origin, direction, forward, availability, viewMatrix, hitSection) {
  direction = normalize(direction);
  if (!direction) throw new Error("Invalid diagnostic ray direction");
  const maxDistance = VIEW_DIAGNOSTIC_LIMITS.rayDistance;
  const start = array(origin), vector = array(direction);
  const unknown = new Set();
  const end = { x: origin.x + direction.x * maxDistance,
    y: origin.y + direction.y * maxDistance, z: origin.z + direction.z * maxDistance };
  const inBounds = (point) => inHorizontalBounds(point.x, point.z) &&
    point.y >= source.spec.minY && point.y < source.spec.maxY;
  const result = {
    origin: copy(origin), direction, maxDistance, firstVoxelHit: null,
    firstShapeHit: null, firstUnknown: null, unknownCellsRead: 0,
    crossesWorldBounds: !inBounds(origin) || !inBounds(end), truncated: false,
  };
  const proxy = {
    spec: source.spec,
    getCell(x, y, z) {
      const value = source.read(x, y, z);
      if (value.status !== "loaded" && value.status !== "outside-world") {
        unknown.add(`${x},${y},${z}`);
        const hit = intersectRayBox(start, vector, [x, y, z, x + 1, y + 1, z + 1], maxDistance);
        if (hit && (!result.firstUnknown || hit.distance < result.firstUnknown.depth.radial)) {
          const point = { x: origin.x + direction.x * hit.distance,
            y: origin.y + direction.y * hit.distance, z: origin.z + direction.z * hit.distance };
          result.firstUnknown = { x, y, z, status: value.status,
            point, depth: pointDepths(origin, point, forward, viewMatrix), availability: availability(x, z) };
        }
      }
      return value.cell;
    },
  };
  const describe = (hit) => hit && ({
    x: hit.x, y: hit.y, z: hit.z, id: hit.id, state: hit.state, fluid: hit.fluid,
    kind: BLOCKS[hit.id]?.shape ?? "unknown",
    transparent: BLOCKS[hit.id]?.transparent ?? null,
    point: copy(hit.point), depth: pointDepths(origin, hit.point, forward, viewMatrix),
    availability: availability(hit.x, hit.z, true),
    hitSection: hitSection(hit),
  });
  try {
    result.firstVoxelHit = describe(raycast(proxy, origin, direction, maxDistance, {
      channel: "render",
      resolve: (cell) => cell.id !== BLOCK.AIR || cell.fluid !== FLUID.NONE ? FULL_VOXEL : EMPTY_VOXEL,
    }));
    result.firstShapeHit = describe(raycast(proxy, origin, direction, maxDistance, {
      channel: "render",
      resolve: (cell, neighbors) => {
        const shape = resolveShape(cell, neighbors);
        // Include waterlogged fluid as well as render boxes; selection ignores water.
        return { render: shape.render === shape.fluidVolume
          ? shape.render : [...shape.render, ...shape.fluidVolume] };
      },
    }));
  } catch (error) {
    if (!(error instanceof ReadCap)) throw error;
    result.truncated = true;
  }
  result.unknownCellsRead = unknown.size;
  return result;
}

/** Detached, loaded-data-only snapshot. Never generates, requests, or mutates terrain. */
export function captureViewMiss(game, legacy, coverage = null) {
  const { player, graphics } = game;
  const camera = graphics.camera;
  const origin = copy(camera.position); // Same origin and directions as the unchanged legacy probe.
  const matrix = camera.matrixWorldInverse?.elements;
  // -view-space Z from the actual rendered camera, without updating its matrices.
  const forward = matrix ? { x: -matrix[2], y: -matrix[6], z: -matrix[10] } : null;
  const fog = { near: graphics.scene.fog?.near ?? null, far: graphics.scene.fog?.far ?? null };
  const source = createViewDiagnosticReader(game.world);
  const meshBudget = { nodes: 0 };
  const availability = availabilityReader(game, coverage, meshBudget);
  const hitSection = hitSectionReader(game, meshBudget);
  const rays = OFFSETS.map(([yawOffset, pitchOffset]) => {
    const yaw = player.yaw + yawOffset, pitch = player.pitch + pitchOffset;
    const direction = {
      x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch),
      z: -Math.cos(yaw) * Math.cos(pitch),
    };
    const ray = traceRay(source, origin, direction, forward, availability, matrix, hitSection);
    return { yawOffset, pitchOffset, ...ray,
      legacySampling: legacyVoxelSampling(ray, legacy, direction),
      categories: categorizeViewRay(ray, fog, Math.min(100, legacy.fogFar)) };
  });
  const down = traceRay(source, origin, { x: 0, y: -1, z: 0 }, forward, availability, matrix, hitSection);
  const surface = down.firstShapeHit;
  const radius = Math.min(VIEW_DIAGNOSTIC_LIMITS.coverageRadius, graphics.renderRadius);
  const cx = Math.floor(origin.x / CHUNK_SIZE), cz = Math.floor(origin.z / CHUNK_SIZE);
  const columns = [];
  for (let z = cz - radius; z <= cz + radius; z++)
    for (let x = cx - radius; x <= cx + radius; x++)
      columns.push(availability(x * CHUNK_SIZE, z * CHUNK_SIZE));
  return {
    player: { position: copy(player.position), velocity: copy(player.velocity),
      yaw: player.yaw, pitch: player.pitch, flying: player.flying, grounded: player.grounded },
    camera: { position: origin, forward, viewMatrix: matrix ? Array.from(matrix) : null,
      near: camera.near, far: camera.far,
      fov: camera.fov, aspect: camera.aspect },
    fog,
    legacy: { ...legacy, radialLimit: Math.min(100, legacy.fogFar), firstStep: 0.5, stepSize: 0.75 },
    surface: {
      definition: "First known render-box/fluid candidate below the camera, not a generated roof or collision guarantee",
      eyeClearance: surface ? origin.y - surface.point.y : null,
      feetClearance: surface ? player.position.y - surface.point.y : null,
      ray: down,
    },
    coverage: {
      definition: "Exact detailCoverage return from this frame; local source/group metadata, not rasterized coverage",
      available: coverage !== null, coveredColumns: coverage?.size ?? null,
      localRadius: radius, requestedRadius: graphics.renderRadius,
      localFootprintTruncated: graphics.renderRadius > radius, columns,
    },
    distant: { present: !!graphics.distant, ready: graphics.distant?.ready ?? false,
      groupVisible: graphics.distant?.group?.visible ?? false,
      terrainCoverageComplete: graphics.distant?.terrainCoverageComplete ?? false },
    rays,
    work: { cellReads: source.reads, meshNodes: meshBudget.nodes },
  };
}

export class ViewDiagnostics {
  constructor(game, { clock = () => performance.now(), sample = captureViewMiss } = {}) {
    this.game = game;
    this.clock = clock;
    this.sample = sample;
    this.wrapped = new WeakMap();
    this.reset(null);
  }

  attachCoverage(graphics) {
    if (typeof graphics?.detailCoverage !== "function" ||
        this.wrapped.get(graphics) === graphics.detailCoverage) return;
    const original = graphics.detailCoverage, diagnostics = this;
    const wrapped = function (...args) {
      const value = original.apply(this, args);
      if (diagnostics.collecting && diagnostics.observations.length < VIEW_DIAGNOSTIC_LIMITS.observations)
        diagnostics.coverage = { graphics: this, value };
      return value;
    };
    graphics.detailCoverage = wrapped;
    this.wrapped.set(graphics, wrapped);
  }

  reset(label) {
    this.enabled = label === LABEL;
    this.collecting = this.enabled;
    this.observations = [];
    this.misses = 0;
    this.dropped = 0;
    this.cpuMs = 0;
    this.coverage = null;
  }

  beginFrame() {
    this.coverage = null; // Never silently reuse a previous frame's renderer mask.
  }

  stop() {
    this.collecting = false;
    this.coverage = null;
  }

  record(legacy, context) {
    if (!this.collecting || legacy.terrainRaysHit !== 0) return;
    this.misses++;
    if (this.observations.length >= VIEW_DIAGNOSTIC_LIMITS.observations) {
      this.dropped++;
      return;
    }
    const started = this.clock();
    let observation;
    try {
      const coverage = this.coverage && this.coverage.graphics === this.game.graphics
        ? this.coverage.value : null;
      observation = this.sample(this.game, legacy, coverage);
    } catch (error) {
      observation = { legacy: { ...legacy }, error: { name: error.name, message: error.message } };
    }
    const cpuMs = this.clock() - started;
    this.cpuMs += cpuMs;
    this.observations.push({ ...context, ...observation, cpuMs });
  }

  results() {
    return {
      version: 2, enabledForMeasurement: this.enabled,
      definition: "Opt-in zero-of-three legacy misses only; CPU occupancy, shape boxes and scene metadata, never GPU pixels or visible-screen area. Cutout alpha, animation, frustum/occlusion and distant geometry are not ray-tested.",
      limits: { ...VIEW_DIAGNOSTIC_LIMITS }, misses: this.misses, dropped: this.dropped,
      cpuMs: this.cpuMs, observations: this.observations.slice(),
    };
  }
}
