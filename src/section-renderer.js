import * as THREE from "three";
import { geometryWorldSpec } from "./geometry-world.js";
import { geometryBytes, selectEmitters } from "./mesh-palette.js";
import { disposeMeshPartitions } from "./mesh-partitions.js";
import { sectionYs } from "./mesh-snapshot.js";
import { createSectionMeshJob, SECTION_MESH_LIMITS } from "./section-mesh.js";
import { CHUNK_SIZE } from "./terrain.js";
import { MeshBudgetError } from "./mesh-geometry.js";
import { SectionPagePlan, sectionGeometryCovered, sectionMeshVisible, sectionSourceGroup } from "./section-pages.js";
import { GeometryColorPalette, GeometryPaletteError } from "./geometry-color-palette.js";
import { regionalPaletteMaterials, disposeRegionalPaletteMaterials } from "./geometry-palette-material.js";
import { hasRegionalDeadRanges, stepSectionCompaction } from "./section-compaction.js";
import { emptySectionJob } from "./empty-section-job.js";
import { SectionWaterFusion } from "./section-water-fusion.js";
import {
  bufferBytes, geometryBuffers, meshSubmissionCount, publishRegionalPages, pruneEmptySectionRegions,
  regionalPagePlan, releaseRegionalColumn, sectionRegion,
} from "./regional-section-pages.js";

export const DETAIL_MESH_LIMITS = Object.freeze({
  maxJobs: 2,
  maxGpuBytes: 128 * 1024 * 1024,
  maxDrawCalls: 1024,
  maxSliceMs: 8,
  maxStepsPerSlice: 16,
  maxCellsPerSlice: 8192,
  maxCopyBytesPerSlice: 1024 * 1024,
});

// Opt-in while the parent measures native acceptance and finalizes policy.
// This is a representation switch, not a larger ceiling on the old layout.
export const REGIONAL_MESH_LIMITS = Object.freeze({
  maxJobs: 1, maxGpuBytes: 256 * 1024 * 1024,
  maxCpuBytes: 256 * 1024 * 1024, maxStagingBytes: 16 * 1024 * 1024,
  maxJobBytes: 2 * 1024 * 1024,
  paletteCapacity: 16384,
  // Zero means automatic: reserve the largest installed/replacement page,
  // not an arbitrary fixed chunk of otherwise usable canonical capacity.
  compactionHeadroomBytes: 0,
});

const regional = (renderer) => renderer.meshLimits?.regionalPages === true;

export function usesSectionMeshing(world) {
  const { minY, maxY } = geometryWorldSpec(world);
  return minY !== 0 || maxY > 96;
}

/** Must run before selecting legacy versus section meshing: legacy-height
 * worlds can leave the section scheduler entirely when regional packing ends. */
export function reconcileSectionPackingMode(renderer) {
  const packingMode = regional(renderer) ? "regional" : "column";
  if ((renderer.sectionPackingMode ?? "column") !== packingMode) {
    clearSectionJobs(renderer);
    for (const key of renderer.chunks.keys()) renderer.removeChunk(key);
    renderer.sectionWater?.dispose();
    renderer.sectionWater = null;
    // Removed columns may have acknowledged every dirty ticket. Force visible
    // columns back into the legacy queue even when the camera did not move.
    renderer.viewCenter = null;
  }
  renderer.sectionPackingMode = packingMode;
}

function state(renderer) {
  reconcileSectionPackingMode(renderer);
  renderer.sectionJobs ??= new Map();
  renderer.sectionRejections ??= new Map();
  renderer.sectionRejectionDetails ??= new Map();
  renderer.meshResourceRevision ??= 0;
  renderer.meshStats ??= {
    staleJobs: 0,
    budgetRejections: 0,
    lastSliceCells: 0,
    lastSliceMs: 0,
  };
  const limits = { ...DETAIL_MESH_LIMITS,
    ...(regional(renderer) ? REGIONAL_MESH_LIMITS : {}), ...renderer.meshLimits };
  if (regional(renderer) && !renderer.geometryPalette) {
    const allocation = GeometryColorPalette.allocation(limits.paletteCapacity);
    if (allocation.cpuBytes + allocation.gpuBytes <= limits.maxCpuBytes &&
        allocation.gpuBytes <= limits.maxGpuBytes && allocation.gpuBytes <= limits.maxStagingBytes)
      renderer.geometryPalette = new GeometryColorPalette(limits.paletteCapacity);
  }
  if (regional(renderer) && renderer.waterFusionEnabled === true) {
    // Enabling fusion does not expand the existing frame or capacity ceilings.
    for (const [key, cap] of Object.entries({ ...DETAIL_MESH_LIMITS, ...REGIONAL_MESH_LIMITS }))
      if (typeof cap === "number" && key in limits && !["compactionHeadroomBytes"].includes(key))
        limits[key] = Math.min(limits[key], cap);
    renderer.sectionWater ??= new SectionWaterFusion(renderer, limits);
    renderer.sectionWater.configure(limits);
  }
  return limits;
}

function disposeIdlePalette(renderer) {
  if (renderer.sectionRegions?.size || renderer.sectionJobs?.size || renderer.sectionCompaction) return;
  if (!renderer.geometryPalette) return;
  disposeRegionalPaletteMaterials(renderer);
  renderer.geometryPalette.dispose();
  renderer.geometryPalette = null;
}

function recordRegionalPeak(renderer, stats, replacementGpuBytes = 0) {
  const peak = renderer.meshStats;
  peak.peakCombinedCpuBytes = Math.max(peak.peakCombinedCpuBytes ?? 0, stats.combinedCpuBytes);
  peak.peakStagingBytes = Math.max(peak.peakStagingBytes ?? 0, stats.stagingBytes);
  peak.peakReservedGpuBytes = Math.max(peak.peakReservedGpuBytes ?? 0, stats.gpuBytes + replacementGpuBytes);
}

export function cancelSectionColumn(renderer, key) {
  const column = renderer.chunks.get(key);
  for (const section of column?.userData.sections?.values() ?? [])
    renderer.sectionWater?.release(section.group);
  for (const group of column?.userData.waterRetiringGroups ?? [])
    renderer.sectionWater?.release(group);
  const region = column?.userData.sectionRegion;
  const wasRegional = !!region;
  releaseRegionalColumn(renderer, key);
  if (wasRegional) {
    // The regional owner retires GPU allocations. Logical sources only borrow
    // their arrays; drop those views without disposing physical geometry twice.
    column.traverse((mesh) => {
      if (!mesh.userData.sectionSource) return;
      region.userData.sectionRanges.delete(mesh);
      mesh.geometry.attributes = {};
      mesh.geometry.index = null;
      delete mesh.geometry.userData.colorPalette;
      delete mesh.userData.canonicalRange;
    });
    delete column.userData.sectionRanges;
  }
  renderer.sectionQueueLayout = null;
  for (const [section, job] of renderer.sectionJobs ?? []) {
    if (!section.startsWith(`${key},`)) continue;
    job.dispose();
    renderer.sectionJobs.delete(section);
  }
  for (const section of renderer.sectionRejections?.keys() ?? [])
    if (section.startsWith(`${key},`)) {
      renderer.sectionRejections.delete(section);
      renderer.sectionRejectionDetails?.delete(section);
    }
  disposeIdlePalette(renderer);
}

export function clearSectionJobs(renderer) {
  renderer.sectionCompaction?.plan.dispose();
  renderer.sectionCompaction = null;
  if (renderer.meshStats) renderer.meshStats.compactionBlocked = null;
  for (const job of renderer.sectionJobs?.values() ?? []) job.dispose();
  renderer.sectionJobs?.clear();
  renderer.sectionRejections?.clear();
  renderer.sectionRejectionDetails?.clear();
  renderer.sectionQueueLayout = null;
  pruneEmptySectionRegions(renderer);
  disposeIdlePalette(renderer);
}

export function detailMeshResources(renderer, cached = false) {
  if (regional(renderer)) return regionalResources(renderer);
  let gpuBytes = 0,
    sourceBytes = 0,
    drawCalls = 0,
    visibleDrawCalls = 0,
    sections = 0,
    emitters = 0;
  for (const group of renderer.chunks.values()) {
    sections += group.userData.sections?.size ?? 1;
    emitters += group.userData.emitters?.length ?? 0;
    const totals = cached && group.userData.meshResources;
    if (totals) {
      gpuBytes += totals.gpuBytes;
      sourceBytes += totals.sourceBytes;
      drawCalls += totals.drawCalls;
      if (group.visible)
        for (const mesh of [...group.userData.pages, ...group.userData.transparentMeshes])
          if (sectionMeshVisible(mesh, renderer.camera, renderer.scene)) visibleDrawCalls++;
      continue;
    }
    group.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.geometry) return;
      if (mesh.userData.sectionSource) {
        sourceBytes += geometryBytes(mesh.geometry);
        return;
      }
      gpuBytes += geometryBytes(mesh.geometry);
      drawCalls++;
    });
    if (group.visible)
      group.traverseVisible((mesh) => {
        if (
          mesh.isMesh &&
          sectionMeshVisible(mesh, renderer.camera, renderer.scene)
        )
          visibleDrawCalls++;
      });
  }
  return {
    gpuBytes,
    sourceBytes,
    stagingSourceBytes: [...(renderer.sectionJobs?.values() ?? [])].reduce(
      (sum, job) => sum + (job.result?.parts ?? job.mesher?.context.parts ?? []).reduce(
        (bytes, part) => bytes + Object.values(part).reduce(
          (n, geometry) => n + geometryBytes(geometry), 0), 0), 0
    ),
    stagingUnsealedVertices: [...(renderer.sectionJobs?.values() ?? [])].reduce(
      (sum, job) => sum + (job.mesher?.context.partVertices ?? 0), 0
    ),
    stagingPageBytes: [...(renderer.sectionJobs?.values() ?? [])].reduce(
      (sum, job) => sum + (job.pagePlan?.allocatedBytes ?? 0), 0
    ),
    reservedPageBytes: [...(renderer.sectionJobs?.values() ?? [])].reduce(
      (sum, job) => sum + (job.pagePlan?.stagingBytes ?? 0), 0
    ),
    drawCalls,
    visibleDrawCalls,
    sections,
    emitters,
    materials: Object.keys(renderer.materials ?? {}).length,
    activeJobs: renderer.sectionJobs?.size ?? 0,
    snapshotBytes: [...(renderer.sectionJobs?.values() ?? [])].reduce(
      (sum, job) => sum + job.snapshotBytes,
      0
    ),
  };
}

function regionalResources(renderer) {
  const cpu = new Set(), gpu = new Set(), staging = new Set();
  const readyBuffers = new Set(), pendingBuffers = new Set();
  let drawCalls = 0, visibleDrawCalls = 0, shadowDrawCalls = 0, sections = 0, emitters = 0;
  let retainedDeadBytes = 0;
  let maxPageBytes = 0;
  let maxCompactionBytes = 0;
  const count = (mesh) => {
    if (!renderer.sectionWater?.owner.contains(mesh)) {
      geometryBuffers(mesh.geometry, cpu);
      geometryBuffers(mesh.geometry, gpu);
    }
    const draws = meshSubmissionCount(mesh);
    drawCalls += draws;
    if (sectionMeshVisible(mesh, renderer.camera, renderer.scene)) visibleDrawCalls += draws;
    if (mesh.castShadow) shadowDrawCalls++;
  };
  for (const region of renderer.sectionRegions?.values() ?? [])
    for (const page of region.userData.pageDescriptors) {
      const mesh = page.mesh;
      count(mesh);
      retainedDeadBytes += page.retainedDeadBytes ?? 0;
      maxPageBytes = Math.max(maxPageBytes, page.bytes);
      maxCompactionBytes = Math.max(maxCompactionBytes, page.compactionBytes ?? page.bytes);
    }
  for (const column of renderer.chunks.values()) {
    sections += column.userData.sections?.size ?? 0;
    emitters += column.userData.emitters?.length ?? 0;
    // Logical opaque views alias the region allocations by construction.
    // Walking all 15,000 section groups per admission would add quadratic
    // warm-up work; enumerate physical owners and column transparency only.
    for (const mesh of column.userData.transparentMeshes ?? [])
      count(mesh);
  }
  let stagingPageBytes = 0, reservedPageBytes = 0, snapshotBytes = 0, unsealed = 0;
  let jobReservations = 0, readySnapshotBytes = 0, pendingSnapshotBytes = 0;
  for (const job of renderer.sectionJobs?.values() ?? []) {
    snapshotBytes += job.snapshotBytes;
    if (job.done) readySnapshotBytes += job.snapshotBytes;
    else pendingSnapshotBytes += job.snapshotBytes;
    for (const part of job.result?.parts ?? job.mesher?.context.parts ?? [])
      for (const geometry of Object.values(part))
        geometryBuffers(geometry, job.done ? readyBuffers : pendingBuffers);
    unsealed += job.mesher?.context.partVertices ?? 0;
    // Regional jobs use 4 KiB typed blocks. Twice the result ceiling plus
    // 256 KiB covers scratch/sealing overlap and all partial blocks/metadata.
    if (!job.done) jobReservations += job.limits.maxTotalBytes * 2 + 256 * 1024 + job.snapshotBytes;
    stagingPageBytes += job.pagePlan?.allocatedBytes ?? 0;
    reservedPageBytes += job.pagePlan?.stagingBytes ?? 0;
  }
  const water = renderer.sectionWater?.resources(cpu, readyBuffers);
  for (const buffer of cpu) {
    readyBuffers.delete(buffer);
    pendingBuffers.delete(buffer);
  }
  for (const buffer of pendingBuffers) {
    staging.add(buffer);
    readyBuffers.delete(buffer);
  }
  for (const buffer of readyBuffers) staging.add(buffer);
  stagingPageBytes += renderer.sectionCompaction?.plan.allocatedBytes ?? 0;
  reservedPageBytes += renderer.sectionCompaction?.plan.stagingBytes ?? 0;
  const stagingSourceBytes = bufferBytes(staging);
  const palette = renderer.geometryPalette?.resources();
  const canonicalBytes = bufferBytes(cpu) + (palette?.cpuBytes ?? 0);
  const mayWritePalette = [...(renderer.sectionJobs?.values() ?? [])]
    .some((job) => !job.done || job.bytes > 0);
  const paletteUploadStagingBytes = Math.max(palette?.pendingUploadBytes ?? 0,
    mayWritePalette ? palette?.gpuBytes ?? 0 : 0);
  // Pending scratch reservations cannot cover independently owned ready
  // results. Count backing identities once, including shared/subarray views.
  const stagingBytes = bufferBytes(readyBuffers) + readySnapshotBytes +
    Math.max(bufferBytes(pendingBuffers) + pendingSnapshotBytes, jobReservations) +
    reservedPageBytes + paletteUploadStagingBytes + (water?.unallocatedCpu ?? 0);
  return {
    gpuBytes: (water?.externalGpu ?? bufferBytes(gpu)) + (palette?.gpuBytes ?? 0) + (water?.liveGpu ?? 0),
    sourceBytes: 0, canonicalBytes,
    waterStagingGpuBytes: water?.stagingGpu ?? 0,
    waterAllocatedGpuBytes: water?.allocatedGpu ?? 0,
    palette, paletteUploadStagingBytes,
    maxPageBytes, maxCompactionBytes,
    reservedCompactionHeadroomBytes: Math.max(renderer.meshLimits?.compactionHeadroomBytes ?? 0, maxCompactionBytes),
    retainedCpuBytes: canonicalBytes, retainedDeadBytes, combinedCpuBytes: canonicalBytes + stagingBytes,
    stagingBytes, stagingSourceBytes, stagingUnsealedVertices: unsealed,
    stagingPageBytes, reservedPageBytes, snapshotBytes,
    drawCalls, visibleDrawCalls, shadowDrawCalls,
    activeCompactions: Number(!!renderer.sectionCompaction),
    // Upper bound for one color pass plus one shadow camera. Actual multi-light
    // renderer submissions must still be read from renderer.info.render.calls.
    colorAndOneShadowDrawCalls: drawCalls + shadowDrawCalls,
    sections, emitters, activeJobs: renderer.sectionJobs?.size ?? 0,
    materials: Object.keys(renderer.materials ?? {}).length,
  };
}

// Reuse only within this synchronous decision. Every removal changes physical
// ownership and may cancel staging, so refresh before testing the next fit.
function evictHiddenRegionalRetention(renderer, fits, stats = detailMeshResources(renderer)) {
  if (fits(stats)) return stats;
  for (const [key, column] of renderer.chunks) {
    if (column.visible) continue;
    renderer.removeChunk(key);
    stats = detailMeshResources(renderer);
    if (fits(stats)) break;
  }
  return stats;
}

/** An empty completed section is coverage; a missing section never is. */
export function sectionColumnCovered(group, camera) {
  const sections = group.userData.sections;
  if (!sections || !group.userData.meshed) return false;
  for (const sy of group.userData.requiredSections) {
    const section = sections.get(sy);
    if (!sectionGeometryCovered(group, section, camera)) return false;
  }
  return true;
}

function queue(renderer) {
  const world = renderer.world;
  const camera = renderer.camera;
  const xs = Math.floor(camera.position.x / CHUNK_SIZE);
  const zs = Math.floor(camera.position.z / CHUNK_SIZE);
  const ys = Math.floor(camera.position.y / 16);
  camera.updateMatrixWorld();
  const required = sectionYs(world);
  const columns = [];
  for (const key of world.chunks.keys()) {
    const [cx, cz] = key.split(",").map(Number);
    if (Math.max(Math.abs(cx - xs), Math.abs(cz - zs)) > renderer.renderRadius)
      continue;
    columns.push({ key, cx, cz });
  }
  // Priority geometry depends on the view and native column coordinates, not
  // dirty tickets. Retain the priority lattice, not a snapshot of pending work.
  // Admission reads live tickets; an existing job must not wait behind a scan
  // of every section on every slice.
  const viewKey = [
    renderer.renderRadius, required.join(","),
    columns.map(({ key }) => key).join(";"),
    camera.projectionMatrix.elements.join(","),
    // Priority only, never coverage/culling. Reuse the section lattice through
    // sub-section translations and small head motion.
    xs, ys, zs,
    ...[camera.rotation.x, camera.rotation.y, camera.rotation.z].map((v) => Math.round(v / 0.15)),
  ].join("/");
  let layout = renderer.sectionQueueLayout;
  if (!layout || layout.world !== world || layout.key !== viewKey) {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const bounds = new THREE.Box3();
    const slots = [];
    for (const record of columns) {
      const { key, cx, cz } = record;
      for (const sy of required) {
        bounds.min.set(cx * CHUNK_SIZE - 2, sy * 16 - 2, cz * CHUNK_SIZE - 2);
        bounds.max.set((cx + 1) * CHUNK_SIZE + 2, (sy + 1) * 16 + 2, (cz + 1) * CHUNK_SIZE + 2);
        slots.push({
          key: `${key},${sy}`, columnKey: key, cx, cz, sy, record,
          inView: frustum.intersectsBox(bounds),
          viewDistance: bounds.distanceToPoint(camera.position),
          distance: (cx - xs) ** 2 + (cz - zs) ** 2,
          heightDistance: Math.abs(sy - ys),
        });
      }
    }
    // Bucket by section-sized distance bands. This keeps every out-of-frustum
    // section in the queue without an O(sections log sections) matrix-motion
    // sort. Only the small list of occupied bands is sorted.
    const buckets = new Map();
    for (const slot of slots) {
      const priority = (slot.inView ? 0 : 1000000) + Math.floor(slot.viewDistance / 16);
      if (!buckets.has(priority)) buckets.set(priority, []);
      buckets.get(priority).push(slot);
    }
    const ordered = [...buckets.keys()].sort((a, b) => a - b).flatMap((key) => buckets.get(key));
    layout = renderer.sectionQueueLayout = { world, key: viewKey, slots: ordered, columns };
  }
  return layout.slots;
}

function sectionQueueBudgetKey(renderer, limits) {
  return [
    limits.maxGpuBytes, limits.maxDrawCalls,
    limits.maxCpuBytes, limits.maxStagingBytes, limits.maxJobBytes,
    limits.paletteCapacity, renderer.geometryPalette?.freeCount,
    renderer.sectionMeshLimits?.maxVertices, renderer.sectionMeshLimits?.maxBytes,
    renderer.sectionMeshLimits?.maxTotalBytes, renderer.sectionMeshLimits?.maxDrawCalls,
  ].join(":");
}

function refreshSectionQueueItem(renderer, item, budgetKey) {
  const chunk = renderer.world.chunks.get(item.columnKey);
  if (!chunk) return null;
  const column = renderer.chunks.get(item.columnKey);
  const old = column?.userData.incarnation === chunk.incarnation &&
    column.userData.sections?.get(item.sy);
  const ticket = renderer.world.dirtySectionRevisions?.get(item.key);
  if (old && ticket === undefined) return null;
  const revision = chunk.sectionRevisions?.get(item.sy) ?? chunk.revision;
  Object.assign(item, { incarnation: chunk.incarnation, revision, ticket, missing: !old,
    resourceRevision: renderer.meshResourceRevision, budgetKey });
  item.token = [chunk.incarnation, revision, ticket,
    renderer.meshResourceRevision, budgetKey].join(":");
  return item;
}

function nextSection(renderer, limits) {
  // Admission may have evicted a hidden column since this slice began.
  if (!renderer.sectionQueueLayout) queue(renderer);
  const layout = renderer.sectionQueueLayout;
  const budgetKey = sectionQueueBudgetKey(renderer, limits);
  const eligible = (item) => !renderer.sectionJobs.has(item.key) &&
    refreshSectionQueueItem(renderer, item, budgetKey) &&
    renderer.sectionRejections.get(item.key) !== item.token;
  // Selection may consume the remaining deadline. Keep just that candidate
  // for the next slice, revalidating its live source/ticket/admission token.
  // A view/layout change or column cancellation discards it with the lattice.
  if (layout.candidate && eligible(layout.candidate)) return layout.candidate;
  layout.candidate = null;
  let replacement;
  for (const item of layout.slots) {
    if (!eligible(item)) continue;
    if (item.missing) return layout.candidate = item;
    replacement ??= item;
  }
  return layout.candidate = replacement;
}

function install(renderer, job, result, deadline = Infinity) {
  if (renderer.sectionWater)
    return renderer.sectionWater.attachments.commit(job, () => installTransaction(renderer, job, result), deadline);
  return installTransaction(renderer, job, result);
}

function installTransaction(renderer, job, result) {
  const { cx, cz, sy } = job.stamp;
  const key = `${cx},${cz}`;
  const plan = job.pagePlan;
  const sectionGroup = plan.group;
  const emitters = [];
  for (const mesh of sectionGroup.children)
    emitters.push(...(mesh.geometry.userData.emitters ?? []));
  // Assemble every part while detached. A stale or failed assembly must not
  // disturb the previous section or acknowledge any of its dirty work.
  if (job.world !== renderer.world || !job.current()) return false;
  const source = renderer.world.chunks.get(key);
  let column = renderer.chunks.get(key);
  const owner = regional(renderer) ? sectionRegion(renderer, cx, cz) : column;
  if (owner !== plan.column ||
      (owner?.userData.pageRevision ?? 0) !== plan.revision) return false;
  if (column && column.userData.incarnation !== source.incarnation) {
    renderer.removeChunk(key);
    column = null;
  }
  if (!column) {
    column = new THREE.Group();
    column.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    column.userData = {
      cx,
      cz,
      incarnation: source.incarnation,
      meshed: false,
      sections: new Map(),
      requiredSections: sectionYs(renderer.world),
      emitters: [],
    };
    renderer.chunks.set(key, column);
    renderer.scene.add(column);
  }
  const old = column.userData.sections.get(sy);
  const oldPages = column.userData.pages ?? [];
  // Every destination and range is complete before any old ownership changes.
  if (regional(renderer)) {
    if (!publishRegionalPages(renderer, column, sy, plan, job.waterCommit)) return false;
  } else {
    for (const page of plan.pages) column.add(page.mesh);
    column.userData.pages = plan.pages.map((page) => page.mesh);
    column.userData.pageDescriptors = plan.pages;
    column.userData.transparentMeshes = plan.transparentMeshes;
    column.userData.sectionRanges = plan.ranges;
    column.userData.pageRevision = plan.revision + 1;
    column.userData.meshResources = {
      gpuBytes: plan.bytes + plan.transparentBytes,
      sourceBytes: (column.userData.meshResources?.sourceBytes ?? 0) + job.sourceDelta,
      drawCalls: plan.draws,
    };
  }
  plan.transferred = true;
  column.add(sectionGroup);
  column.userData.sections.set(sy, {
    group: sectionGroup,
    bytes: job.bytes,
    draws: job.draws,
    stamp: job.stamp,
    emitters,
  });
  renderer.sectionWater?.install(sectionGroup);
  if (regional(renderer))
    column.userData.transparentMeshes = [...column.userData.sections.values()]
      .flatMap((section) => section.group.children).filter((mesh) => !mesh.userData.sectionSource);
  if (old) {
    const retire = () => {
      renderer.sectionWater?.release(old.group);
      old.group.traverse((mesh) => mesh.geometry?.dispose());
      column.remove(old.group);
    };
    if (job.waterCommit) job.waterCommit.deferRetire(retire); else retire();
    if (old.bytes > job.bytes || old.draws > job.draws)
      renderer.meshResourceRevision++;
  }
  for (const mesh of oldPages) {
    if (regional(renderer)) break;
    if (column.userData.pages.includes(mesh)) continue;
    column.remove(mesh);
    mesh.geometry.dispose();
  }
  // Opaque-to-transparent edits can free CPU source capacity while increasing
  // GPU bytes and draws. Refusals must retry when either admission pool shrinks.
  if ((regional(renderer) && job.bytes > 0) || job.sourceDelta < 0 ||
      plan.bytes + plan.transparentBytes < job.oldColumnBytes ||
      plan.draws < job.oldColumnDraws)
    renderer.meshResourceRevision++;
  column.userData.meshed = column.userData.requiredSections.every((section) =>
    column.userData.sections.has(section)
  );
  column.userData.emitters = selectEmitters(
    [...column.userData.sections.values()].flatMap(
      (section) => section.emitters
    )
  );
  // Publication succeeded. No other section's dirty ticket is acknowledged.
  job.acknowledge();
  if (
    column.userData.meshed &&
    column.userData.requiredSections.every(
      (section) =>
        !renderer.world.dirtySectionRevisions?.has(`${key},${section}`)
    )
  )
    renderer.world.dirtyChunks?.delete(key);
  renderer.shadowDirty = true;
  renderer.lastLightTime = -Infinity;
  return true;
}

export function rebuildSectionMeshes(renderer, maxSections = 2) {
  const limits = state(renderer);
  for (const [key, column] of renderer.chunks) {
    const source = renderer.world.chunks.get(key);
    if (!source || column.userData.incarnation !== source.incarnation)
      renderer.removeChunk(key);
  }
  for (const region of renderer.sectionRegions?.values() ?? [])
    region.visible = [...region.userData.sections.values()].some(({ group }) => group.parent?.visible);
  const sectionLimits = {
    ...SECTION_MESH_LIMITS,
    ...renderer.sectionMeshLimits,
    ...(regional(renderer) ? { typedScratch: true } : {}),
    // Bound staged parts by the whole renderer ceilings too. Final admission
    // accounts for other live sections and the buffers this result replaces.
    maxTotalBytes: Math.min(
      limits.maxGpuBytes,
      limits.maxJobBytes ?? Infinity,
      renderer.sectionMeshLimits?.maxTotalBytes ?? Infinity
    ),
    maxDrawCalls: Math.min(
      limits.maxDrawCalls,
      renderer.sectionMeshLimits?.maxDrawCalls ?? Infinity
    ),
  };
  const maximum =
    maxSections === Infinity && !renderer.sectionWater
      ? Infinity
      : Math.max(0, Number.isFinite(maxSections) ? Math.floor(maxSections) : 2);
  const started = performance.now();
  renderer.meshStats.lastSliceCells = 0;
  renderer.meshStats.lastSliceCopyBytes = 0;
  renderer.meshStats.lastSliceSteps = 0;
  renderer.meshStats.waterWork = [];
  if (renderer.sectionWater) renderer.sectionWater.frame = null;
  const admissionKey = [limits.maxCpuBytes, limits.maxGpuBytes, limits.maxStagingBytes].join(":");
  for (const [key, job] of renderer.sectionJobs) {
    const distance = Math.max(
      Math.abs(
        job.stamp.cx - Math.floor(renderer.camera.position.x / CHUNK_SIZE)
      ),
      Math.abs(
        job.stamp.cz - Math.floor(renderer.camera.position.z / CHUNK_SIZE)
      )
    );
    // A refusal computed under old ceilings cannot be cached under new ones.
    if (
      job.world !== renderer.world ||
      !job.current() ||
      distance > renderer.renderRadius ||
      (regional(renderer) && job.admissionKey !== admissionKey) ||
      ["maxVertices", "maxBytes", "maxTotalBytes", "maxDrawCalls"].some(
        (name) => name === "maxTotalBytes" && regional(renderer)
          ? job.limits[name] > sectionLimits[name] : job.limits[name] !== sectionLimits[name]
      )
    ) {
      job.dispose();
      renderer.sectionJobs.delete(key);
      renderer.meshStats.staleJobs++;
    }
  }
  if (regional(renderer) && maximum > 0 && !renderer.sectionWater?.reclaim.active) {
    while (stepSectionCompaction(renderer, limits, () => {
      const stats = detailMeshResources(renderer);
      if (stats.combinedCpuBytes <= limits.maxCpuBytes &&
          stats.stagingBytes <= limits.maxStagingBytes &&
          stats.gpuBytes + (renderer.sectionCompaction?.plan.stagingBytes ?? 0) <= limits.maxGpuBytes)
        recordRegionalPeak(renderer, stats, renderer.sectionCompaction?.plan.stagingBytes ?? 0);
      return stats;
    },
      maximum === Infinity ? Infinity : started + limits.maxSliceMs,
      maximum === Infinity ? Infinity : limits.maxCopyBytesPerSlice - renderer.meshStats.lastSliceCopyBytes)) {
      if (maximum !== Infinity || renderer.sectionCompaction || renderer.meshStats.compactionBlocked) {
        Object.assign(renderer.meshStats, detailMeshResources(renderer), {
          lastSliceMs: performance.now() - started, limits,
        });
        return 0;
      }
    }
  }
  const pending = queue(renderer);
  const resources = detailMeshResources(renderer, true);
  let completed = 0;
  const stepped = new Set();
  const blocked = new Set();
  let steps = 0;
  if (renderer.sectionWater && maximum > 0) {
    renderer.sectionWater.refresh();
    steps += renderer.sectionWater.step(limits, started, steps);
  }
  while (
    completed < maximum &&
    (maximum === Infinity ||
      (steps < limits.maxStepsPerSlice &&
        renderer.meshStats.lastSliceCells < limits.maxCellsPerSlice)) &&
    (maximum === Infinity || performance.now() - started < limits.maxSliceMs)
  ) {
    // Advance every retained job before spending this slice on admission
    // metadata. This also matters when maxJobs has a vacant slot.
    const mayAdmit = [...renderer.sectionJobs.keys()].every((key) => stepped.has(key));
    while (mayAdmit && renderer.sectionJobs.size < limits.maxJobs) {
      const next = nextSection(renderer, limits);
      if (!next) break;
      if (maximum !== Infinity && performance.now() - started >= limits.maxSliceMs) break;
      const empty = regional(renderer) &&
        emptySectionJob(renderer.world, next.cx, next.cz, next.sy, sectionLimits);
      let jobLimits = sectionLimits;
      if (regional(renderer)) {
        if (!renderer.geometryPalette) {
          renderer.meshStats.blocked = { reason: "palette-reservation",
            allocation: GeometryColorPalette.allocation(limits.paletteCapacity) };
          break;
        }
        let now = detailMeshResources(renderer);
        const uploadReserve = empty ? 0 : Math.max(0, now.palette.gpuBytes - now.paletteUploadStagingBytes);
        const jobBytes = Math.min(sectionLimits.maxTotalBytes, Math.floor((
          Math.min(limits.maxCpuBytes - now.combinedCpuBytes, limits.maxStagingBytes - now.stagingBytes) -
          384 * 1024 - uploadReserve) / 2));
        if (!empty) jobLimits = { ...sectionLimits, maxTotalBytes: Math.max(0, jobBytes) };
        const reserve = empty ? 0 : jobLimits.maxTotalBytes * 2 + 384 * 1024 + uploadReserve;
        now = evictHiddenRegionalRetention(renderer, (stats) =>
          stats.combinedCpuBytes + reserve <= limits.maxCpuBytes, now);
        if ((!empty && jobBytes < 188) || now.combinedCpuBytes + reserve > limits.maxCpuBytes ||
            now.stagingBytes + reserve > limits.maxStagingBytes) {
          renderer.meshStats.blocked = { reason: "job-reservation", ...now };
          renderer.sectionRejections.set(next.key, next.token);
          renderer.sectionRejectionDetails.set(next.key, { reason: "job-reservation", key: next.key });
          renderer.meshStats.budgetRejections++;
          steps++;
          if (maximum !== Infinity && (steps >= limits.maxStepsPerSlice ||
              performance.now() - started >= limits.maxSliceMs)) break;
          continue;
        }
      }
      const job = empty || createSectionMeshJob(
          renderer.world,
          next.cx,
          next.cz,
          next.sy,
          renderer.atlas,
          jobLimits
        );
      const dispose = job.dispose.bind(job);
      job.dispose = () => {
        if (!job.waterGroup?.parent) renderer.sectionWater?.release(job.waterGroup);
        job.pagePlan?.dispose();
        dispose();
      };
      renderer.sectionJobs.set(next.key, job);
      job.queueItem = next;
      if (renderer.sectionQueueLayout) renderer.sectionQueueLayout.candidate = null;
      job.admissionKey = admissionKey;
      if (regional(renderer)) recordRegionalPeak(renderer, detailMeshResources(renderer));
    }
    if (maximum !== Infinity && performance.now() - started >= limits.maxSliceMs) break;
    const entry = [...renderer.sectionJobs].find(
      ([key]) => maximum === Infinity || !blocked.has(key)
    );
    if (!entry) break;
    const [key, job] = entry;
    stepped.add(key);
    steps++;
    // Rotate across calls too: an expensive first job must not starve its peer.
    if (renderer.sectionWater) renderer.sectionWater.accounting.rotateJob(key, job);
    else { renderer.sectionJobs.delete(key); renderer.sectionJobs.set(key, job); }
    const meshing = !job.done;
    if (meshing) job.step({
      maxCells: maximum === Infinity ? Infinity : Math.max(0,
        limits.maxCellsPerSlice - renderer.meshStats.lastSliceCells),
      budgetMs: Math.max(0, limits.maxSliceMs - (performance.now() - started)),
      flush: maximum === Infinity,
    });
    if (meshing) renderer.meshStats.lastSliceCells += job.lastSlice.cells;
    renderer.sectionWater?.accounting.syncJob(job);
    if (!job.done) {
      // A zero-progress job cannot spin even with a stopped/coarse clock.
      if (!job.lastSlice.cells) blocked.add(key);
      continue;
    }
    const item = job.queueItem &&
      refreshSectionQueueItem(renderer, job.queueItem, sectionQueueBudgetKey(renderer, limits));
    if (job.status === "stale") renderer.meshStats.staleJobs++;
    const column = regional(renderer)
      ? sectionRegion(renderer, job.stamp.cx, job.stamp.cz)
      : renderer.chunks.get(`${job.stamp.cx},${job.stamp.cz}`);
    if (column?.userData.waterRetirement) { blocked.add(key); continue; }
    if (job.pagePlan && (job.pagePlan.column !== column ||
        job.pagePlan.revision !== (column?.userData.pageRevision ?? 0))) {
      // A peer section can publish while this copy yields. Keep its immutable
      // meshing result, but repack against the newly installed column pages.
      job.pagePlan.dispose();
      job.pagePlan = null;
    }
    if (job.status === "ready" && !job.pagePlan) {
      try {
        const group = job.waterGroup ?? sectionSourceGroup(job.result, regional(renderer)
          ? regionalPaletteMaterials(renderer) : renderer.materials);
        if (renderer.sectionWater) job.waterGroup = group;
        const pageLimits = {
          minSection: sectionYs(renderer.world)[0],
          maxVertices: sectionLimits.maxVertices,
          maxBytes: sectionLimits.maxBytes,
          maxTotalBytes: limits.maxGpuBytes,
        };
        job.pagePlan = regional(renderer)
          ? regionalPagePlan(renderer, job.stamp.cx, job.stamp.cz, job.stamp.sy, group, pageLimits)
          : new SectionPagePlan(column, job.stamp.sy, group, pageLimits);
      } catch (error) {
        job.dispose();
        renderer.sectionJobs.delete(key);
        if (!(error instanceof MeshBudgetError)) throw error;
        job.status = "budget";
      }
    }
    let oldColumnBytes = 0, oldColumnDraws = 0;
    if (column?.userData.meshResources) {
      oldColumnBytes = column.userData.meshResources.gpuBytes;
      oldColumnDraws = column.userData.meshResources.drawCalls;
    } else column?.traverse((mesh) => {
        if (!mesh.isMesh || mesh.userData.sectionSource) return;
        oldColumnBytes += geometryBytes(mesh.geometry);
        oldColumnDraws++;
      });
    job.oldColumnBytes = oldColumnBytes;
    job.oldColumnDraws = oldColumnDraws;
    const plan = job.pagePlan;
    if (renderer.sectionWater && job.status === "ready") {
      renderer.sectionWater.prepare(job);
      steps += renderer.sectionWater.step(limits, started, steps);
      if (job.pagePlan !== plan || column?.userData.waterRetirement ||
          !job.current() || renderer.sectionJobs.get(key) !== job) {
        blocked.add(key); continue;
      }
      if (!renderer.sectionWater.prepare(job)) {
        if (job.waterInvalid) {
          // An exchanged shell has no original payload to fall back to. Keep
          // the installed snapshot and dirty ticket; rebuild on a later slice.
          job.dispose();
          renderer.sectionJobs.delete(key);
          break;
        }
        blocked.add(key); continue;
      }
      plan.transparentBytes = plan.transparentMeshes.reduce((n, mesh) =>
        n + (renderer.sectionWater.meshBytes(mesh) ?? geometryBytes(mesh.geometry)), 0);
      plan.draws = plan.pages.length + plan.transparentMeshes.reduce((n, mesh) => n + meshSubmissionCount(mesh), 0);
    }
    const sourceBytes = (group) => (group?.children ?? []).reduce(
      (sum, mesh) => sum + (mesh.userData.sectionSource ? geometryBytes(mesh.geometry) : 0), 0
    );
    const oldSourceBytes = sourceBytes(column?.userData.sections?.get(job.stamp.sy)?.group);
    const newSourceBytes = sourceBytes(plan?.group);
    job.sourceDelta = newSourceBytes - oldSourceBytes;
    let admitted =
      job.status === "ready" &&
      resources.sourceBytes - oldSourceBytes + newSourceBytes <= limits.maxGpuBytes &&
      resources.gpuBytes - oldColumnBytes + plan.bytes + plan.transparentBytes <=
        limits.maxGpuBytes &&
      resources.drawCalls - oldColumnDraws + plan.draws <=
        limits.maxDrawCalls;
    if (regional(renderer) && job.status === "ready") {
      const meshBytes = mesh => renderer.sectionWater?.meshBytes(mesh) ?? geometryBytes(mesh.geometry);
      const newTransparentBytes = plan.group.children.reduce((sum, mesh) =>
        sum + (mesh.userData.sectionSource || renderer.sectionWater?.owner.contains(mesh) ? 0 : geometryBytes(mesh.geometry)), 0);
      const oldGpu = (column?.userData.pages ?? []).reduce((n, m) => n + geometryBytes(m.geometry), 0);
      const oldTransparent = [...column.userData.sections.values()].flatMap((s) => s.group.children)
        .filter((m) => !m.userData.sectionSource);
      oldColumnBytes = oldGpu + oldTransparent.reduce((n, m) => n + meshBytes(m), 0);
      oldColumnDraws = column.userData.pages.length +
        oldTransparent.reduce((n, m) => n + meshSubmissionCount(m), 0);
      job.oldColumnBytes = oldColumnBytes;
      job.oldColumnDraws = oldColumnDraws;
      const plannedHeadroom = Math.max(limits.compactionHeadroomBytes,
        ...plan.pages.map((page) => page.compactionBytes ?? page.bytes));
      const finalBytes = plan.bytes + plan.transparentBytes;
      const fits = (stats) => {
        const headroom = Math.max(plannedHeadroom, stats.maxCompactionBytes);
        return stats.combinedCpuBytes <= limits.maxCpuBytes &&
          stats.stagingBytes <= limits.maxStagingBytes &&
          stats.gpuBytes + stats.waterStagingGpuBytes + plan.stagingBytes + newTransparentBytes <= limits.maxGpuBytes &&
          stats.gpuBytes - oldColumnBytes + finalBytes + headroom <= limits.maxGpuBytes &&
          stats.canonicalBytes - oldColumnBytes + finalBytes + stats.paletteUploadStagingBytes + headroom <= limits.maxCpuBytes &&
          (renderer.sectionWater ? renderer.sectionWater.attachments.reserve(job) :
            stats.drawCalls - oldColumnDraws + plan.draws <= limits.maxDrawCalls);
      };
      const now = renderer.sectionWater ? detailMeshResources(renderer) : evictHiddenRegionalRetention(renderer, fits);
      admitted = fits(now);
      if (admitted) recordRegionalPeak(renderer, now, plan.stagingBytes + newTransparentBytes);
      if (!admitted) renderer.meshStats.blocked = {
        reason: "regional-publication", key, ...now,
        replacementGpuBytes: plan.stagingBytes + newTransparentBytes,
        projectedDrawCalls: now.drawCalls - oldColumnDraws + plan.draws,
      };
      else renderer.meshStats.blocked = null;
      if (!admitted && renderer.sectionWater) {
        const headroom = Math.max(plannedHeadroom, now.maxCompactionBytes);
        renderer.sectionWater.reclaim.capacity(job,
          Math.max(now.combinedCpuBytes - limits.maxCpuBytes,
            now.canonicalBytes - oldColumnBytes + finalBytes + now.paletteUploadStagingBytes + headroom - limits.maxCpuBytes),
          Math.max(now.gpuBytes + now.waterStagingGpuBytes + plan.stagingBytes + newTransparentBytes - limits.maxGpuBytes,
            now.gpuBytes - oldColumnBytes + finalBytes + headroom - limits.maxGpuBytes),
          now.stagingBytes - limits.maxStagingBytes);
        blocked.add(key);
        continue;
      }
    }
    if (admitted) {
      if (job.world !== renderer.world || !job.current() ||
          column !== plan.column || (column?.userData.pageRevision ?? 0) !== plan.revision) {
        job.dispose();
        renderer.sectionJobs.delete(key);
        renderer.meshStats.staleJobs++;
        blocked.add(key);
        continue;
      }
      const copyBudget = maximum === Infinity ? Infinity :
        Math.max(0, limits.maxCopyBytesPerSlice - renderer.meshStats.lastSliceCopyBytes);
      try {
        renderer.meshStats.lastSliceCopyBytes += plan.step(copyBudget,
          maximum === Infinity ? Infinity : started + limits.maxSliceMs);
      } catch (error) {
        job.dispose();
        renderer.sectionJobs.delete(key);
        if (error instanceof GeometryPaletteError) {
          renderer.meshStats.blocked = { reason: error.reason, key, ...detailMeshResources(renderer) };
          renderer.sectionRejectionDetails.set(key, { reason: error.reason, key });
          renderer.meshStats.budgetRejections++;
          if (item) renderer.sectionRejections.set(key, item.token);
          blocked.add(key);
          continue;
        }
        throw error;
      }
      if (!plan.done) {
        blocked.add(key);
        continue;
      }
      if (renderer.sectionWater && (!renderer.sectionWater.attachments.valid(job) ||
          performance.now() >= started + limits.maxSliceMs)) {
        blocked.add(key); continue;
      }
      const result = job.takeResult();
      if (result) {
        try {
          if (install(renderer, job, result, renderer.sectionWater ? started + limits.maxSliceMs : Infinity)) {
            renderer.sectionRejections.delete(key);
            renderer.sectionRejectionDetails.delete(key);
            resources.gpuBytes += plan.bytes + plan.transparentBytes - oldColumnBytes;
            resources.drawCalls += plan.draws - oldColumnDraws;
            resources.sourceBytes += newSourceBytes - oldSourceBytes;
            completed++;
          } else {
            disposeMeshPartitions(result);
            renderer.meshStats.staleJobs++;
          }
        } catch (error) {
          disposeMeshPartitions(result);
          job.dispose();
          renderer.sectionJobs.delete(key);
          throw error;
        }
      } else renderer.meshStats.staleJobs++;
    } else if (job.status !== "stale") {
      if (regional(renderer) && job.status !== "ready")
        renderer.meshStats.blocked = { reason: "section-mesher-budget", key,
          sectionLimits, ...detailMeshResources(renderer) };
      renderer.meshStats.budgetRejections++;
      renderer.sectionRejectionDetails.set(key, {
        reason: renderer.meshStats.blocked?.reason ?? "mesh-budget", key,
      });
      if (item) renderer.sectionRejections.set(key, item.token);
    }
    // Retry invalidated/rejected keys next call, not repeatedly in this slice.
    blocked.add(key);
    job.dispose();
    renderer.sectionJobs.delete(key);
    if (regional(renderer) && !renderer.sectionJobs.size && hasRegionalDeadRanges(renderer)) break;
    // Admission refreshes a candidate's token on demand, so a publication need
    // not rewrite every remaining section's token to retry freed capacity.
  }
  pruneEmptySectionRegions(renderer);
  if (!renderer.world.chunks.size) disposeIdlePalette(renderer);
  if (renderer.sectionRejectionDetails.size)
    renderer.meshStats.blocked = { ...renderer.sectionRejectionDetails.values().next().value,
      rejectedSections: renderer.sectionRejectionDetails.size };
  Object.assign(renderer.meshStats, detailMeshResources(renderer, true), {
    queueSlots: pending.length,
    lastSliceSteps: steps,
    lastSliceMs: performance.now() - started,
    // CPU source backing and both job-owned staging pools are separate from
    // installed GPU capacity. Each job and page plan is capped at maxGpuBytes.
    memoryLimits: {
      sourceBytes: limits.maxCpuBytes ?? limits.maxGpuBytes,
      stagingSourceBytes: limits.maxStagingBytes ?? limits.maxJobs * limits.maxGpuBytes,
      stagingPageBytes: limits.maxStagingBytes ?? limits.maxJobs * limits.maxGpuBytes,
      stagingUnsealedVertices: limits.maxJobs * sectionLimits.maxVertices,
    },
    limits,
  });
  if (renderer.sectionWater && maximum > 0) renderer.sectionWater.frame = { limits, started, steps };
  return completed;
}
