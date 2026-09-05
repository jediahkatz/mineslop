import * as THREE from "three";
import { geometryWorldSpec } from "./geometry-world.js";
import { geometryBytes, selectEmitters } from "./mesh-palette.js";
import { disposeMeshPartitions } from "./mesh-partitions.js";
import { sectionYs } from "./mesh-snapshot.js";
import { createSectionMeshJob, SECTION_MESH_LIMITS } from "./section-mesh.js";
import { CHUNK_SIZE } from "./terrain.js";
import { MeshBudgetError } from "./mesh-geometry.js";
import { SectionPagePlan, sectionGeometryCovered, sectionSourceGroup } from "./section-pages.js";

export const DETAIL_MESH_LIMITS = Object.freeze({
  maxJobs: 2,
  maxGpuBytes: 128 * 1024 * 1024,
  maxDrawCalls: 1024,
  maxSliceMs: 8,
  maxStepsPerSlice: 16,
  maxCellsPerSlice: 8192,
  maxCopyBytesPerSlice: 1024 * 1024,
});

export function usesSectionMeshing(world) {
  const { minY, maxY } = geometryWorldSpec(world);
  return minY !== 0 || maxY > 96;
}

function state(renderer) {
  renderer.sectionJobs ??= new Map();
  renderer.sectionRejections ??= new Map();
  renderer.meshResourceRevision ??= 0;
  renderer.meshStats ??= {
    staleJobs: 0,
    budgetRejections: 0,
    lastSliceCells: 0,
    lastSliceMs: 0,
  };
  return { ...DETAIL_MESH_LIMITS, ...renderer.meshLimits };
}

export function cancelSectionColumn(renderer, key) {
  renderer.sectionQueueLayout = null;
  for (const [section, job] of renderer.sectionJobs ?? []) {
    if (!section.startsWith(`${key},`)) continue;
    job.dispose();
    renderer.sectionJobs.delete(section);
  }
  for (const section of renderer.sectionRejections?.keys() ?? [])
    if (section.startsWith(`${key},`))
      renderer.sectionRejections.delete(section);
}

export function clearSectionJobs(renderer) {
  for (const job of renderer.sectionJobs?.values() ?? []) job.dispose();
  renderer.sectionJobs?.clear();
  renderer.sectionRejections?.clear();
  renderer.sectionQueueLayout = null;
}

export function detailMeshResources(renderer, cached = false) {
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
          if (mesh.visible && mesh.parent?.visible && mesh.material.visible !== false &&
              mesh.geometry.drawRange.count > 0) visibleDrawCalls++;
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
          !mesh.userData.sectionSource &&
          mesh.material.visible !== false &&
          mesh.geometry.drawRange.count > 0
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

/** An empty completed section is coverage; a missing section never is. */
export function sectionColumnCovered(group) {
  const sections = group.userData.sections;
  if (!sections || !group.userData.meshed) return false;
  for (const sy of group.userData.requiredSections) {
    const section = sections.get(sy);
    if (!sectionGeometryCovered(group, section)) return false;
  }
  return true;
}

function queue(renderer, limits) {
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
  // dirty tickets. Cache this bounded layout; still read every current ticket
  // and incarnation below. Stationary native warmup must not re-sort thousands
  // of identical bounds every 8ms slice.
  const viewKey = [
    renderer.renderRadius, required.join(","),
    columns.map(({ key }) => key).join(";"),
    camera.projectionMatrix.elements.join(","),
    camera.matrixWorld.elements.join(","),
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
    slots.sort((a, b) =>
      Number(b.inView) - Number(a.inView) ||
      a.viewDistance - b.viewDistance ||
      a.distance - b.distance ||
      a.heightDistance - b.heightDistance);
    layout = renderer.sectionQueueLayout = { world, key: viewKey, slots, columns };
  }
  const missing = [], replacements = [];
  const budgetKey = [
    limits.maxGpuBytes, limits.maxDrawCalls,
    renderer.sectionMeshLimits?.maxVertices, renderer.sectionMeshLimits?.maxBytes,
    renderer.sectionMeshLimits?.maxTotalBytes, renderer.sectionMeshLimits?.maxDrawCalls,
  ].join(":");
  for (const record of layout.columns) {
    record.chunk = world.chunks.get(record.key);
    record.column = renderer.chunks.get(record.key);
  }
  for (const item of layout.slots) {
    const { chunk, column } = item.record;
    const old = column?.userData.sections?.get(item.sy);
    const ticket = world.dirtySectionRevisions?.get(item.key);
    if (old && column.userData.incarnation === chunk.incarnation && ticket === undefined)
      continue;
    const revision = chunk.sectionRevisions?.get(item.sy) ?? chunk.revision;
    if (item.incarnation !== chunk.incarnation || item.revision !== revision ||
        item.ticket !== ticket || item.resourceRevision !== renderer.meshResourceRevision ||
        item.budgetKey !== budgetKey) {
      Object.assign(item, { incarnation: chunk.incarnation, revision, ticket,
        resourceRevision: renderer.meshResourceRevision, budgetKey });
      item.token = [chunk.incarnation, revision, ticket,
        renderer.meshResourceRevision, budgetKey].join(":");
    }
    if (old) replacements.push(item);
    else missing.push(item);
  }
  return missing.concat(replacements);
}

function install(renderer, job, result) {
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
  if (column !== plan.column ||
      (column?.userData.pageRevision ?? 0) !== plan.revision) return false;
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
  plan.transferred = true;
  column.add(sectionGroup);
  column.userData.sections.set(sy, {
    group: sectionGroup,
    bytes: job.bytes,
    draws: job.draws,
    stamp: job.stamp,
    emitters,
  });
  if (old) {
    old.group.traverse((mesh) => mesh.geometry?.dispose());
    column.remove(old.group);
    if (old.bytes > job.bytes || old.draws > job.draws)
      renderer.meshResourceRevision++;
  }
  for (const mesh of oldPages) {
    if (column.userData.pages.includes(mesh)) continue;
    column.remove(mesh);
    mesh.geometry.dispose();
  }
  if (plan.bytes + plan.transparentBytes < job.oldColumnBytes ||
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
  const sectionLimits = {
    ...SECTION_MESH_LIMITS,
    ...renderer.sectionMeshLimits,
    // Bound staged parts by the whole renderer ceilings too. Final admission
    // accounts for other live sections and the buffers this result replaces.
    maxTotalBytes: Math.min(
      limits.maxGpuBytes,
      renderer.sectionMeshLimits?.maxTotalBytes ?? Infinity
    ),
    maxDrawCalls: Math.min(
      limits.maxDrawCalls,
      renderer.sectionMeshLimits?.maxDrawCalls ?? Infinity
    ),
  };
  const maximum =
    maxSections === Infinity
      ? Infinity
      : Math.max(0, Number.isFinite(maxSections) ? Math.floor(maxSections) : 2);
  const started = performance.now();
  renderer.meshStats.lastSliceCells = 0;
  renderer.meshStats.lastSliceCopyBytes = 0;
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
      ["maxVertices", "maxBytes", "maxTotalBytes", "maxDrawCalls"].some(
        (name) => job.limits[name] !== sectionLimits[name]
      )
    ) {
      job.dispose();
      renderer.sectionJobs.delete(key);
      renderer.meshStats.staleJobs++;
    }
  }
  let pending = queue(renderer, limits);
  let queueResourceRevision = renderer.meshResourceRevision;
  const resources = detailMeshResources(renderer, true);
  let completed = 0;
  const stepped = new Set();
  const blocked = new Set();
  let steps = 0;
  while (
    completed < maximum &&
    (maximum === Infinity ||
      (steps < limits.maxStepsPerSlice &&
        renderer.meshStats.lastSliceCells < limits.maxCellsPerSlice)) &&
    (maximum === Infinity || performance.now() - started < limits.maxSliceMs)
  ) {
    while (renderer.sectionJobs.size < limits.maxJobs) {
      const next = pending.find(
        (item) =>
          !renderer.sectionJobs.has(item.key) &&
          renderer.sectionRejections.get(item.key) !== item.token
      );
      if (!next) break;
      const job = createSectionMeshJob(
          renderer.world,
          next.cx,
          next.cz,
          next.sy,
          renderer.atlas,
          sectionLimits
        );
      const dispose = job.dispose.bind(job);
      job.dispose = () => {
        job.pagePlan?.dispose();
        dispose();
      };
      renderer.sectionJobs.set(next.key, job);
    }
    const entry = [...renderer.sectionJobs].find(
      ([key]) => maximum === Infinity || !blocked.has(key)
    );
    if (!entry) break;
    const [key, job] = entry;
    stepped.add(key);
    steps++;
    // Rotate across calls too: an expensive first job must not starve its peer.
    renderer.sectionJobs.delete(key);
    renderer.sectionJobs.set(key, job);
    const meshing = !job.done;
    if (meshing) job.step({
      maxCells: maximum === Infinity ? Infinity : Math.max(0,
        limits.maxCellsPerSlice - renderer.meshStats.lastSliceCells),
      budgetMs: Math.max(0, limits.maxSliceMs - (performance.now() - started)),
      flush: maximum === Infinity,
    });
    if (meshing) renderer.meshStats.lastSliceCells += job.lastSlice.cells;
    if (!job.done) {
      // A zero-progress job cannot spin even with a stopped/coarse clock.
      if (!job.lastSlice.cells) blocked.add(key);
      continue;
    }
    const item = pending.find((candidate) => candidate.key === key);
    if (job.status === "stale") renderer.meshStats.staleJobs++;
    const column = renderer.chunks.get(`${job.stamp.cx},${job.stamp.cz}`);
    if (job.pagePlan && (job.pagePlan.column !== column ||
        job.pagePlan.revision !== (column?.userData.pageRevision ?? 0))) {
      // A peer section can publish while this copy yields. Keep its immutable
      // meshing result, but repack against the newly installed column pages.
      job.pagePlan.dispose();
      job.pagePlan = null;
    }
    if (job.status === "ready" && !job.pagePlan) {
      try {
        const group = sectionSourceGroup(job.result, renderer.materials);
        job.pagePlan = new SectionPagePlan(column, job.stamp.sy, group, {
          minSection: sectionYs(renderer.world)[0],
          maxVertices: sectionLimits.maxVertices,
          maxBytes: sectionLimits.maxBytes,
          maxTotalBytes: limits.maxGpuBytes,
        });
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
    const sourceBytes = (group) => (group?.children ?? []).reduce(
      (sum, mesh) => sum + (mesh.userData.sectionSource ? geometryBytes(mesh.geometry) : 0), 0
    );
    const oldSourceBytes = sourceBytes(column?.userData.sections?.get(job.stamp.sy)?.group);
    const newSourceBytes = sourceBytes(plan?.group);
    job.sourceDelta = newSourceBytes - oldSourceBytes;
    const admitted =
      job.status === "ready" &&
      resources.sourceBytes - oldSourceBytes + newSourceBytes <= limits.maxGpuBytes &&
      resources.gpuBytes - oldColumnBytes + plan.bytes + plan.transparentBytes <=
        limits.maxGpuBytes &&
      resources.drawCalls - oldColumnDraws + plan.draws <=
        limits.maxDrawCalls;
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
        throw error;
      }
      if (!plan.done) {
        blocked.add(key);
        continue;
      }
      const result = job.takeResult();
      if (result) {
        try {
          if (install(renderer, job, result)) {
            renderer.sectionRejections.delete(key);
            resources.gpuBytes += plan.bytes + plan.transparentBytes - oldColumnBytes;
            resources.drawCalls += plan.draws - oldColumnDraws;
            resources.sourceBytes += newSourceBytes - oldSourceBytes;
            pending = pending.filter((candidate) => candidate.key !== key);
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
      renderer.meshStats.budgetRejections++;
      if (item) renderer.sectionRejections.set(key, item.token);
    }
    // Retry invalidated/rejected keys next call, not repeatedly in this slice.
    blocked.add(key);
    job.dispose();
    renderer.sectionJobs.delete(key);
    // Publication changes only this ticket and resource admission. Preserve the
    // sorted queue for the rest of this slice instead of rescanning/sorting the
    // entire native volume after every section. Freed capacity still retries
    // refusals in this slice; world edits are re-read at the next queue build.
    if (queueResourceRevision !== renderer.meshResourceRevision) {
      for (const candidate of pending) {
        const token = candidate.token.split(":");
        token[3] = renderer.meshResourceRevision;
        candidate.token = token.join(":");
      }
      queueResourceRevision = renderer.meshResourceRevision;
    }
  }
  Object.assign(renderer.meshStats, detailMeshResources(renderer, true), {
    pendingSections: pending.length,
    lastSliceMs: performance.now() - started,
    // CPU source backing and both job-owned staging pools are separate from
    // installed GPU capacity. Each job and page plan is capped at maxGpuBytes.
    memoryLimits: {
      sourceBytes: limits.maxGpuBytes,
      stagingSourceBytes: limits.maxJobs * limits.maxGpuBytes,
      stagingPageBytes: limits.maxJobs * limits.maxGpuBytes,
      stagingUnsealedVertices: limits.maxJobs * sectionLimits.maxVertices,
    },
    limits,
  });
  return completed;
}
