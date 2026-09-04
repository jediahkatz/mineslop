import * as THREE from "three";
import { geometryWorldSpec } from "./geometry-world.js";
import { geometryBytes, MESH_BATCHES, selectEmitters } from "./mesh-palette.js";
import { disposeMeshPartitions } from "./mesh-partitions.js";
import { sectionYs } from "./mesh-snapshot.js";
import { createSectionMeshJob, SECTION_MESH_LIMITS } from "./section-mesh.js";
import { CHUNK_SIZE } from "./terrain.js";

export const DETAIL_MESH_LIMITS = Object.freeze({
  maxJobs: 2,
  maxGpuBytes: 128 * 1024 * 1024,
  maxDrawCalls: 1024,
  maxSliceMs: 8,
  maxStepsPerSlice: 16,
  maxCellsPerSlice: 8192,
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
}

export function detailMeshResources(renderer) {
  let gpuBytes = 0,
    drawCalls = 0,
    visibleDrawCalls = 0,
    sections = 0,
    emitters = 0;
  for (const group of renderer.chunks.values()) {
    sections += group.userData.sections?.size ?? 1;
    emitters += group.userData.emitters?.length ?? 0;
    group.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.geometry) return;
      gpuBytes += geometryBytes(mesh.geometry);
      drawCalls++;
    });
    if (group.visible)
      group.traverseVisible((mesh) => {
        if (
          mesh.isMesh &&
          mesh.material.visible !== false &&
          mesh.geometry.drawRange.count > 0
        )
          visibleDrawCalls++;
      });
  }
  return {
    gpuBytes,
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
    if (
      !section ||
      section.group.parent !== group ||
      !section.group.visible ||
      section.group.children.length !== section.draws
    )
      return false;
    for (const mesh of section.group.children) {
      const count =
        mesh.geometry.index?.count ??
        mesh.geometry.getAttribute("position")?.count ??
        0;
      if (
        !mesh.visible ||
        mesh.material.visible === false ||
        mesh.geometry.drawRange.count <= 0 ||
        mesh.geometry.drawRange.start >= count
      )
        return false;
    }
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
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  );
  const bounds = new THREE.Box3();
  const required = sectionYs(world);
  const pending = [];
  for (const [key, chunk] of world.chunks) {
    const [cx, cz] = key.split(",").map(Number);
    if (Math.max(Math.abs(cx - xs), Math.abs(cz - zs)) > renderer.renderRadius)
      continue;
    const column = renderer.chunks.get(key);
    for (const sy of required) {
      const sectionKey = `${key},${sy}`;
      const ticket = world.dirtySectionRevisions?.get(sectionKey);
      const old = column?.userData.sections?.get(sy);
      if (
        old &&
        column.userData.incarnation === chunk.incarnation &&
        ticket === undefined
      )
        continue;
      // Column-first ordering can spend the whole budget on a 384-block
      // vertical stack while an adjacent, visible surface has no geometry.
      // Include the shape apron in this priority bound; this does not cull
      // geometry, discard pending work or change any per-frame mesh limit.
      bounds.min.set(cx * CHUNK_SIZE - 2, sy * 16 - 2, cz * CHUNK_SIZE - 2);
      bounds.max.set((cx + 1) * CHUNK_SIZE + 2, (sy + 1) * 16 + 2, (cz + 1) * CHUNK_SIZE + 2);
      pending.push({
        key: sectionKey,
        columnKey: key,
        cx,
        cz,
        sy,
        missing: !old,
        inView: frustum.intersectsBox(bounds),
        viewDistance: bounds.distanceToPoint(camera.position),
        distance: (cx - xs) ** 2 + (cz - zs) ** 2,
        heightDistance: Math.abs(sy - ys),
        token: [
          chunk.incarnation,
          chunk.sectionRevisions?.get(sy) ?? chunk.revision,
          ticket,
          renderer.meshResourceRevision,
          limits.maxGpuBytes,
          limits.maxDrawCalls,
          renderer.sectionMeshLimits?.maxVertices,
          renderer.sectionMeshLimits?.maxBytes,
          renderer.sectionMeshLimits?.maxTotalBytes,
          renderer.sectionMeshLimits?.maxDrawCalls,
        ].join(":"),
      });
    }
  }
  return pending.sort(
    (a, b) =>
      Number(b.missing) - Number(a.missing) ||
      Number(b.inView) - Number(a.inView) ||
      a.viewDistance - b.viewDistance ||
      a.distance - b.distance ||
      a.heightDistance - b.heightDistance
  );
}

function install(renderer, job, result) {
  const { cx, cz, sy } = job.stamp;
  const key = `${cx},${cz}`;
  const sectionGroup = new THREE.Group();
  const emitters = [];
  for (const part of result.parts) {
    for (const name of MESH_BATCHES) {
      const geometry = part[name];
      if (!geometry) continue;
      emitters.push(...(geometry.userData.emitters ?? []));
      const mesh = new THREE.Mesh(geometry, renderer.materials[name]);
      mesh.castShadow = ["opaque", "foliage", "berryFoliage"].includes(name);
      mesh.receiveShadow = mesh.castShadow;
      mesh.renderOrder = name === "water" ? 2 : name === "glass" ? 1 : 0;
      sectionGroup.add(mesh);
    }
  }
  // Assemble every part while detached. A stale or failed assembly must not
  // disturb the previous section or acknowledge any of its dirty work.
  if (job.world !== renderer.world || !job.current()) return false;
  const source = renderer.world.chunks.get(key);
  let column = renderer.chunks.get(key);
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
      renderer.sectionJobs.set(
        next.key,
        createSectionMeshJob(
          renderer.world,
          next.cx,
          next.cz,
          next.sy,
          renderer.atlas,
          sectionLimits
        )
      );
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
    job.step({
      maxCells: maximum === Infinity ? Infinity : Math.max(0,
        limits.maxCellsPerSlice - renderer.meshStats.lastSliceCells),
      budgetMs: Math.max(0, limits.maxSliceMs - (performance.now() - started)),
      flush: maximum === Infinity,
    });
    renderer.meshStats.lastSliceCells += job.lastSlice.cells;
    if (!job.done) {
      // A zero-progress job cannot spin even with a stopped/coarse clock.
      if (!job.lastSlice.cells) blocked.add(key);
      continue;
    }
    // Retry invalidated/rejected keys next call, not repeatedly in this slice.
    blocked.add(key);
    const item = pending.find((candidate) => candidate.key === key);
    if (job.status === "stale") renderer.meshStats.staleJobs++;
    const old = renderer.chunks
      .get(`${job.stamp.cx},${job.stamp.cz}`)
      ?.userData.sections?.get(job.stamp.sy);
    const resources = detailMeshResources(renderer);
    const admitted =
      job.status === "ready" &&
      resources.gpuBytes - (old?.bytes ?? 0) + job.bytes <=
        limits.maxGpuBytes &&
      resources.drawCalls - (old?.draws ?? 0) + job.draws <=
        limits.maxDrawCalls;
    if (admitted) {
      const result = job.takeResult();
      if (result) {
        try {
          if (install(renderer, job, result)) {
            renderer.sectionRejections.delete(key);
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
    job.dispose();
    renderer.sectionJobs.delete(key);
    pending = queue(renderer, limits);
  }
  Object.assign(renderer.meshStats, detailMeshResources(renderer), {
    pendingSections: pending.length,
    lastSliceMs: performance.now() - started,
    limits,
  });
  return completed;
}
