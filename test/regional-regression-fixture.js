import * as THREE from "three";
import { getWorldSpec } from "../src/world-spec.js";
import { clearSectionJobs, detailMeshResources } from "../src/section-renderer.js";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";

export function regionalRegressionFixture(t, entries, columns = [[0, 0], [1, 0]]) {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([]);
  world.generatorVersion = 3;
  world.spec = getWorldSpec(3, "overworld");
  for (const [cx, cz] of columns) world.admit(cx, cz);
  for (const entry of entries) world.put(...entry);
  const renderer = shapeRenderer(world);
  renderer.renderDistanceOverride = 2;
  renderer.camera.position.set(15.5, 8, 8);
  renderer.camera.lookAt(24, 8, 8);
  renderer.meshLimits = { regionalPages: true };
  t.after(() => {
    clearSectionJobs(renderer);
    disposeShapeRenderer(renderer);
  });
  return { world, renderer };
}

// Independent oracle: enumerate backing identities, not scheduler totals or
// geometry byte lengths (logical ranges are subarrays of physical owners).
export function addBuffers(geometry, buffers) {
  for (const a of [...Object.values(geometry?.attributes ?? {}), geometry?.index])
    if (a?.array?.buffer) buffers.add(a.array.buffer);
}

export function bytes(buffers) {
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

export function physicalState(renderer) {
  const physical = new Set();
  let visibleSubmissions = 0;
  renderer.scene.traverse((mesh) => {
    if (mesh.isMesh && !mesh.userData.sectionSource) addBuffers(mesh.geometry, physical);
  });
  renderer.scene.traverseVisible((mesh) => {
    if (!mesh.isMesh || mesh.userData.sectionSource ||
        !renderer.camera.layers.test(mesh.layers) || mesh.material.visible === false ||
        mesh.geometry.drawRange.count <= 0) return;
    visibleSubmissions += mesh.material.transparent && mesh.material.side === THREE.DoubleSide &&
      !mesh.material.forceSinglePass ? 2 : 1;
  });
  const stats = detailMeshResources(renderer);
  return {
    packingMode: renderer.sectionPackingMode,
    regions: renderer.sectionRegions?.size ?? 0,
    paletteRetained: !!renderer.geometryPalette,
    physicalGeometryBytes: bytes(physical),
    reportedGpuBytes: stats.gpuBytes,
    reportedVisibleSubmissions: stats.visibleDrawCalls,
    visibleSubmissions,
    coverage: [...renderer.detailCoverage()],
    jobs: renderer.sectionJobs?.size ?? 0,
    compaction: !!renderer.sectionCompaction,
  };
}

export function mixedReservationOracle(renderer) {
  const installed = new Set(), ready = new Set(), pending = new Set();
  renderer.scene.traverse((mesh) => {
    if (mesh.isMesh && !mesh.userData.sectionSource) addBuffers(mesh.geometry, installed);
  });
  let pendingReserve = 0, readySnapshots = 0, pages = 0;
  for (const job of renderer.sectionJobs.values()) {
    for (const part of job.result?.parts ?? job.mesher?.context.parts ?? [])
      for (const geometry of Object.values(part)) addBuffers(geometry, job.done ? ready : pending);
    if (job.done) readySnapshots += job.snapshotBytes;
    else pendingReserve += 2 * job.limits.maxTotalBytes + 256 * 1024 + job.snapshotBytes;
    pages += job.pagePlan?.stagingBytes ?? 0;
  }
  for (const buffer of installed) ready.delete(buffer);
  for (const buffer of pending) ready.delete(buffer);
  pages += renderer.sectionCompaction?.plan.stagingBytes ?? 0;
  const palette = renderer.geometryPalette.resources();
  const paletteUpload = Math.max(palette.pendingUploadBytes,
    [...renderer.sectionJobs.values()].some((job) => !job.done || job.bytes > 0) ? palette.gpuBytes : 0);
  return {
    readyBytes: bytes(ready),
    pendingReserve,
    reservedPages: pages,
    paletteUpload,
    stagingMinimum: bytes(ready) + readySnapshots + pendingReserve + pages + paletteUpload,
  };
}
