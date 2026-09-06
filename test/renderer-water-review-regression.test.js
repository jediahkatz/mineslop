import assert from "node:assert/strict";
import test from "node:test";
import { captureHostReviewSources, loadHostReviewModules, hostReviewFixture } from "./renderer-water-review-fixture.js";

const provenance = captureHostReviewSources();
const modules = await loadHostReviewModules();
provenance.unchanged();
const fixture = t => {
  provenance.unchanged();
  t.after(() => provenance.unchanged());
  return hostReviewFixture(t, modules);
};

test("host review: one-operation pending progress does not rescan the published population", t => {
  const observations = [];
  for (const population of [8, 128]) {
    const f = fixture(t), published = f.publish(population);
    assert.equal(published.length, population);
    assert.ok(published.every(mesh => f.owner.status(mesh).ready && mesh.userData.sectionWater.installed));
    f.instrument();
    const pending = f.makeJob(), mesh = pending.waterGroup.children[0];
    f.resetVisits();
    assert.equal(f.host.prepare(pending), false);
    const requestVisits = { ...f.visits }, record = f.owner.records.get(mesh);
    assert.ok(record && !record.data);
    f.resetVisits();
    const operations = f.step(f.limits.maxStepsPerSlice - 1);
    const stepVisits = { ...f.visits }, work = f.g.meshStats.waterWork.slice();
    const copiedBytes = f.g.meshStats.lastSliceCopyBytes;
    f.resetVisits();
    f.host.refresh();
    observations.push({
      population, requestVisits, stepVisits, refreshVisits: { ...f.visits },
      operations, copiedBytes, work, pendingProgress: !!record.data,
      corePublished: record.published, hostInstalled: mesh.userData.sectionWater.installed,
      expected: { maximumVisitsPerCategory: 4, operations: 1, pendingProgress: true },
    });
  }
  // Check useful pending work separately from the metadata boundedness claim.
  for (const o of observations) {
    assert.equal(o.operations, 1);
    assert.equal(o.work.length, 1);
    assert.equal(o.pendingProgress, true);
    assert.ok(o.copiedBytes > 0 && o.copiedBytes <= 1048576);
  }
  assert.ok(observations.every(o =>
    o.requestVisits.ownedMeshVisits <= 4 && o.stepVisits.ownedMeshVisits <= 4 &&
    o.stepVisits.regionalMeshVisits <= 4 && o.refreshVisits.refreshEntryVisits <= 4),
  `host metadata work scales with published population: ${JSON.stringify(observations)}`);
});

for (const [from, to] of [["fused", "original"], ["original", "fused"]])
  test(`host review: ${from}-to-${to} callback admission includes both live GPU allocations`, t => {
    const f = fixture(t), [mesh] = f.publish(1);
    f.addExternal();
    if (from === "original") {
      mesh.castShadow = true; f.host.refresh(); f.drain();
    }
    const record = f.owner.records.get(mesh);
    assert.equal(record.mode, from);
    const total = () => {
      const external = f.owner.externalResources(), owned = f.owner.resources();
      return { external, owned, reportedGpu: external.gpuBytes + owned.reservedGpuBytes,
        actualGpu: f.gpu.bytes(), waterAllocatedGpu: f.gpu.bytes("water"),
        externalAllocatedGpu: f.gpu.bytes("external"),
        reportedCpu: external.cpuBytes + owned.reservedCpuBytes, actualCpu: f.cpuBackingBytes() };
    };
    const before = total(), observations = [];
    assert.equal(before.reportedGpu, before.actualGpu, "steady-state allocation control");
    assert.equal(before.reportedCpu, before.actualCpu, "independent CPU backing control");
    const current = record.validate;
    let entered = false;
    record.validate = () => {
      const valid = current();
      // This is a real publication validator callback, not a fabricated record
      // phase. Both payloads must actually exist in the independent registry.
      if (valid && !entered && record.published && record.mode === to && record.target === to &&
          record.textureAllocated && record.vbo) {
        entered = true;
        const state = total(), limit = state.actualGpu - 1, oldLimit = f.owner.limits.maxGpuBytes;
        let admitted;
        try {
          // Read-only reentrant admission query under a LOWER ceiling. No new
          // resource is allocated and no configured production cap is raised.
          f.owner.limits.maxGpuBytes = limit;
          admitted = f.owner.fits();
        } finally { f.owner.limits.maxGpuBytes = oldLimit; }
        observations.push({ from, to, mode: record.mode, target: record.target,
          coreInstalled: record.installed, hostInstalled: mesh.userData.sectionWater.installed,
          textureLive: f.gpu.allocations.has(record.texture), vboLive: f.gpu.allocations.has(record.vbo),
          ...state, reentrantLimit: limit, admitted, expectedAdmitted: false,
          expectedReportedGpuAtLeast: state.actualGpu });
      }
      return valid;
    };
    mesh.castShadow = to === "original";
    f.host.refresh(); f.drain();
    const after = total();
    assert.equal(entered, true, "FIXTURE_CONTRACT_CHANGED: no real double-allocation callback was observed");
    assert.equal(record.mode, to);
    assert.equal(after.reportedGpu, after.actualGpu, "post-transition steady-state control");
    for (const o of observations) {
      assert.equal(o.textureLive && o.vboLive, true);
      assert.equal(o.owned.allocatedOwnedGpuBytes, o.waterAllocatedGpu, "new core ledger must match actual water allocation registry");
      assert.ok(o.owned.reservedGpuBytes >= o.waterAllocatedGpu, "core overlap repair prerequisite");
      assert.equal(o.reportedCpu, o.actualCpu, "CPU backing is independent of the GPU overlap defect");
      assert.ok(o.reportedGpu >= o.actualGpu && !o.admitted,
        `host subtraction loses still-live storage: ${JSON.stringify(o)}`);
    }
  });

for (const exchange of [true, false])
  test(`host review: cancelled ${exchange ? "exchanged shell cannot replace old section" : "untouched source remains a valid original fallback"}`, t => {
    const f = fixture(t), [old] = f.publish(1);
    const oldSection = f.column.userData.sections.get(0), oldGeometry = old.geometry;
    const job = f.generatedReplacement(), mesh = job.waterGroup.children.find(m => m.userData.batch === "water");
    assert.ok(mesh);
    const original = mesh.geometry;
    assert.equal(f.host.prepare(job), false);
    const record = f.owner.records.get(mesh);
    let during;
    if (exchange) {
      const listener = () => {
        during = { coreInstalled: record.installed, corePublished: record.published,
          coreReady: record.ready, hostInstalled: mesh.userData.sectionWater.installed,
          geometryExchanged: mesh.geometry !== original,
          oldSectionStillInstalled: f.column.userData.sections.get(0) === oldSection };
        f.owner.release(mesh);
      };
      original.addEventListener("dispose", listener);
      try { f.drain(); } finally { original.removeEventListener("dispose", listener); }
    } else {
      during = { coreInstalled: !!record.installed, corePublished: record.published,
        hostInstalled: mesh.userData.sectionWater.installed, geometryExchanged: mesh.geometry !== original };
      f.owner.cancel(mesh, "host-review-before-exchange");
    }
    const diagnostic = { ...f.owner.status(mesh) };
    const prepared = f.host.prepare(job);
    const beforeScheduler = {
      diagnostic, prepared, indexCount: mesh.geometry.index?.count ?? 0,
      attributeNames: Object.keys(mesh.geometry.attributes),
      oldSectionStillInstalled: f.column.userData.sections.get(0) === oldSection,
      hostInstalled: mesh.userData.sectionWater.installed,
    };
    // Invoke the real section scheduler, not a fixture's fake publication.
    f.g.rebuildDirty(1);
    const current = f.column.userData.sections.get(0);
    const afterScheduler = {
      oldSectionStillInstalled: current === oldSection,
      replacedWithCandidate: current?.group === job.waterGroup,
      oldIndexRetained: !!oldGeometry.index,
      candidateIndexCount: mesh.geometry.index?.count ?? 0,
      candidateHostInstalled: mesh.userData.sectionWater?.installed,
      dirtyTicketRetained: f.world.dirtySectionRevisions.has("0,0,0"),
      covered: modules.sectionGeometryCovered(f.column, current, f.g.camera),
      diagnostic: f.owner.status(mesh), jobStatus: job.status,
      rebuildQueued: f.g.sectionJobs.has("0,0,0"),
    };
    assert.equal(diagnostic.state, "cancelled");
    assert.equal(diagnostic.originalPathPreserved, !exchange,
      "FIXTURE_CONTRACT_CHANGED: diagnostic no longer matches this exchange boundary");
    assert.equal(during.hostInstalled, false, "detached host transaction is not published");
    if (exchange) {
      assert.equal(during.coreInstalled && during.geometryExchanged, true);
      assert.equal(during.corePublished, false);
      assert.ok(!prepared && !afterScheduler.replacedWithCandidate &&
        (afterScheduler.oldSectionStillInstalled || afterScheduler.dirtyTicketRetained || afterScheduler.rebuildQueued),
      `cancelled empty shell was admitted: ${JSON.stringify({ during, beforeScheduler, afterScheduler })}`);
    } else {
      assert.equal(prepared, true);
      assert.equal(mesh.geometry, original);
      assert.ok(afterScheduler.candidateIndexCount > 0);
      assert.equal(afterScheduler.replacedWithCandidate, true);
      assert.equal(afterScheduler.covered, true);
    }
  });

test("host review: expired quality allowance and repeated renders perform no population work", t => {
  const observations = [];
  for (const population of [8, 128]) {
    const f = fixture(t);
    f.publish(population); f.instrument();
    const values = Map.prototype.values;
    t.mock.method(f.host.entries, "values", function* () {
      for (const entry of values.call(this)) { f.visits.refreshEntryVisits++; yield entry; }
    });
    f.g.quality = "high"; f.g.atmosphere = {}; f.g.scene.fog = { near: 0, far: 1 };
    f.g.updateLightingMode = () => {}; f.g.resize = () => {};
    f.host.frame = { limits: f.limits, started: -f.limits.maxSliceMs, steps: f.limits.maxStepsPerSlice };
    const previousCopies = f.g.meshStats.lastSliceCopyBytes;
    const previousWork = f.g.meshStats.waterWork.slice();
    f.resetVisits();
    f.g.setQuality("low");
    for (let i = 0; i < 32; i++) assert.equal(f.g.render(), false);
    const expiredVisits = { ...f.visits };
    assert.equal(f.host.refreshPending, true);
    assert.equal(f.owner.pending.size, 0, "expired refresh cannot walk owners or schedule N publications");
    assert.equal(f.g.meshStats.lastSliceCopyBytes, previousCopies);
    assert.deepEqual(f.g.meshStats.waterWork, previousWork);
    assert.equal(f.host.frame.steps, f.limits.maxStepsPerSlice);
    f.resetVisits();
    const operations = f.step(f.limits.maxStepsPerSlice - 1);
    const boundedVisits = { ...f.visits }, work = f.g.meshStats.waterWork.slice();
    observations.push({ population, expiredVisits, boundedVisits, operations, work });
    assert.equal(operations, 1);
    assert.deepEqual(work, [{ kind: "host-refresh", bytes: 0 }]);
    assert.equal(boundedVisits.refreshEntryVisits, 1);
    assert.ok(Object.values(expiredVisits).every(n => n === 0), "expired render must not enumerate metadata");
    f.drain();
    assert.equal(f.host.canRender(), true);
  }
});

test("host review: reentrant admission sees newly attached external backing without a stale census", t => {
  const f = fixture(t), [mesh] = f.publish(1);
  f.addExternal();
  const r = f.owner.records.get(mesh), current = r.validate;
  // Warm every public census/read before the callback changes external state.
  modules.detailMeshResources(f.g); f.owner.externalResources();
  let observation;
  r.validate = () => {
    const valid = current();
    if (valid && !observation && r.published && r.mode === "original" && r.target === "original" &&
        r.textureAllocated && r.vbo) {
      observation = {};
      f.addExternal();
      const external = f.owner.externalResources(), own = f.owner.resources();
      const actualGpu = f.gpu.bytes(), actualCpu = f.cpuBackingBytes();
      const limit = f.owner.limits.maxGpuBytes;
      f.owner.limits.maxGpuBytes = actualGpu - 1;
      try {
        Object.assign(observation, { actualGpu, reportedGpu: external.gpuBytes + own.reservedGpuBytes,
          actualCpu, reportedCpu: external.cpuBytes + own.reservedCpuBytes, admitted: f.owner.fits() });
      } finally { f.owner.limits.maxGpuBytes = limit; }
    }
    return valid;
  };
  mesh.castShadow = true; f.host.refresh(); f.drain();
  assert.ok(observation);
  assert.equal(observation.reportedGpu, observation.actualGpu);
  assert.equal(observation.reportedCpu, observation.actualCpu);
  assert.equal(observation.admitted, false);
});
