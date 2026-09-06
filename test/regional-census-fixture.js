import assert from "node:assert/strict";
import { detailMeshResources } from "../src/section-renderer.js";
import { addBuffers, bytes, mixedReservationOracle } from "./regional-regression-fixture.js";

// Every regional census calls palette.resources exactly once, after enumerating
// geometry. Observe that existing boundary; no production hooks or fake jobs.
export function observeRegionalCensuses(t, renderer) {
  const palette = renderer.geometryPalette;
  const original = palette.resources.bind(palette);
  const events = [];
  const identities = new WeakMap();
  let nextIdentity = 0;
  const identity = (value) => {
    if (!identities.has(value)) identities.set(value, ++nextIdentity);
    return identities.get(value);
  };
  const snapshot = (paletteStats) => {
    const physical = new Set(), staged = new Set();
    renderer.scene.traverse((mesh) => {
      if (mesh.isMesh && !mesh.userData.sectionSource) addBuffers(mesh.geometry, physical);
    });
    const jobs = [...renderer.sectionJobs].map(([key, job]) => {
      for (const part of job.result?.parts ?? job.mesher?.context.parts ?? [])
        for (const geometry of Object.values(part)) addBuffers(geometry, staged);
      return {
        key, id: identity(job), status: job.status, bytes: job.bytes,
        snapshotBytes: job.snapshotBytes,
        unsealed: job.mesher?.context.partVertices ?? 0,
        allocated: job.pagePlan?.allocatedBytes ?? 0,
        reserved: job.pagePlan?.stagingBytes ?? 0,
      };
    }).sort((a, b) => a.key.localeCompare(b.key));
    return {
      revision: renderer.meshResourceRevision,
      columns: [...renderer.chunks].map(([key, column]) => [key, column.visible]).sort(),
      regions: [...renderer.sectionRegions ?? []].map(([key, region]) =>
        [key, region.userData.pageRevision, region.userData.pages.length]).sort(),
      jobs, physicalBytes: bytes(physical),
      physicalBacking: [...physical].map(identity).sort((a, b) => a - b),
      stagedBacking: [...staged].map(identity).sort((a, b) => a - b),
      paletteReferences: paletteStats.references,
      paletteUpload: paletteStats.pendingUploadBytes,
    };
  };
  const mock = t.mock.method(palette, "resources", () => {
    const result = original();
    // Installed only around the measured rebuild; independent accounting
    // assertions run after stop(), so no stack-based caller filtering is needed.
    events.push({ state: snapshot(result) });
    return result;
  });
  return { events, stop: () => mock.mock.restore() };
}

export function assertCensusAccounting(renderer) {
  const stats = detailMeshResources(renderer);
  const expected = mixedReservationOracle(renderer);
  assert.ok(stats.stagingBytes >= expected.stagingMinimum);
  assert.ok(stats.combinedCpuBytes >= stats.canonicalBytes + expected.stagingMinimum);
  assert.ok(stats.stagingBytes <= renderer.meshStats.limits.maxStagingBytes);
  assert.ok(stats.combinedCpuBytes <= renderer.meshStats.limits.maxCpuBytes);
  assert.ok(stats.gpuBytes + stats.reservedPageBytes <= renderer.meshStats.limits.maxGpuBytes);
  return { stagingBytes: stats.stagingBytes, combinedCpuBytes: stats.combinedCpuBytes, expected };
}

export function stageReadyJob(renderer, requirePending = false) {
  for (let i = 0; i < 200; i++) {
    renderer.rebuildDirty(1);
    const jobs = [...renderer.sectionJobs.values()];
    const ready = jobs.find((job) => job.status === "ready" && job.bytes > 0 && job.pagePlan);
    if (ready && (!requirePending || jobs.some((job) => !job.done))) {
      // Make the next single-step slice visit this actual ready job.
      const entry = [...renderer.sectionJobs].find(([, job]) => job === ready);
      renderer.sectionJobs = new Map([entry, ...[...renderer.sectionJobs].filter(([, job]) => job !== ready)]);
      return ready;
    }
  }
  assert.fail("fixture must stage an actual ready mesher/page plan");
}
