import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DistantTerrain } from "../../src/distant-terrain.js";
import { detailMeshResources } from "../../src/section-renderer.js";
import { combinedBackingResources } from "./resources.js";
import { correctnessFixture } from "./audit-fixtures.js";
import { DEFAULT_CONSTRAINTS, evaluateRun } from "./oracles.js";

function mesh(bytes) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bytes / 4), 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

function fixture() {
  // No browser/GPU constructor is needed to exercise the actual owned-resource
  // methods. Both production methods below run unchanged on real Three buffers.
  const distant = Object.create(DistantTerrain.prototype);
  const terrain = mesh(600), canopy = mesh(600);
  Object.assign(distant, {
    _active: { terrain, data: { positions: terrain.geometry.attributes.position.array } },
    _vegetation: { layer: { mesh: canopy } },
    _job: { positions: new Float32Array(150) },
    detailMask: { resources: () => ({ cpuBytes: 0, gpuBytes: 0 }) },
  });
  return { distant, chunks: new Map(), sectionRegions: new Map(), sectionJobs: new Map(),
    meshLimits: { regionalPages: true }, materials: {}, meshStats: {} };
}

const totals = r => [r.combinedCpuBytes, r.gpuBytes, r.stagingBytes];
const evaluation = resources => {
  const run = correctnessFixture(); run.samples[0].resources = resources;
  return evaluateRun(run, { ...DEFAULT_CONSTRAINTS, maxCpuBytes: 2048 });
};

test("actual production distant + detail ledgers: 1800/1200/600 count once, pass 2048 CPU, then real overflow fails", () => {
  const renderer = fixture();
  const owned = renderer.distant.resources();
  assert.deepEqual([owned.cpuBytes + owned.stagingBytes, owned.gpuBytes, owned.stagingBytes], [1800, 1200, 600]);
  const ledger = detailMeshResources(renderer);
  assert.deepEqual(totals(ledger), [1800, 1200, 600]);
  const observed = combinedBackingResources(renderer, ledger);
  assert.deepEqual(totals(observed), [1800, 1200, 600]);
  assert.equal(evaluation(observed).hardStatus, "pass");
  renderer.distant._job.extraAllocation = new Uint8Array(300);
  const overflow = combinedBackingResources(renderer, detailMeshResources(renderer));
  assert.deepEqual(totals(overflow), [2100, 1200, 900]);
  assert.equal(evaluation(overflow).hard.find(g => g.name === "combined CPU bytes").status, "fail");
  console.log(JSON.stringify({ counterOrder: ["CPU", "GPU", "staging"], production: totals(ledger),
    benchmark: totals(observed), cpuCap: 2048, before: evaluation(observed).hardStatus,
    overflow: totals(overflow), after: evaluation(overflow).hardStatus }));
});

test("old native-only ledger stays compatible even when a distant resources method is available", () => {
  const renderer = fixture();
  const old = { combinedCpuBytes: 0, gpuBytes: 0, stagingBytes: 0, drawCalls: 0 };
  assert.deepEqual(totals(combinedBackingResources(renderer, old)), [1800, 1200, 600]);
  renderer.meshStats = { peakCombinedCpuBytes: 500, peakReservedGpuBytes: 500, peakStagingBytes: 100 };
  assert.deepEqual(totals(combinedBackingResources(renderer, old)), [2300, 1700, 700]);
  assert.equal(evaluation(combinedBackingResources(renderer, old)).hardStatus, "fail");
});

test("combined admission peaks include distant overlap once and preserve replacement reservations", () => {
  const renderer = fixture(), ledger = detailMeshResources(renderer);
  renderer.meshStats = { peakCombinedCpuBytes: 1800, peakReservedGpuBytes: 1200, peakStagingBytes: 600 };
  assert.deepEqual(totals(combinedBackingResources(renderer, ledger)), [1800, 1200, 600]);
  // Production recordRegionalPeak receives combined totals and adds GPU
  // replacement reservations. They must not be subtracted or discarded.
  renderer.meshStats = { peakCombinedCpuBytes: 2300, peakReservedGpuBytes: 1700, peakStagingBytes: 700 };
  assert.deepEqual(totals(combinedBackingResources(renderer, ledger)), [2300, 1700, 700]);
  assert.equal(evaluation(combinedBackingResources(renderer, ledger)).hardStatus, "fail");
  // Numeric canopy payload is outside the current production byte counters:
  // it still overlaps the admission peak, not merely current residency.
  renderer.distant._vegetationJob = { job: { _positions: Array(100).fill(0) } };
  const extended = combinedBackingResources(renderer, detailMeshResources(renderer));
  assert.deepEqual(totals(extended), [3100, 1700, 1500]);
});

test("partial, unavailable or inconsistent included terms never grant unsafe subtraction credits", () => {
  const renderer = fixture(), ledger = detailMeshResources(renderer);
  for (const incomplete of [
    { gpuBytes: 1200 }, // CPU credit requires both CPU and staging terms.
    { cpuBytes: 1200, stagingBytes: undefined, gpuBytes: 1200 },
    { cpuBytes: NaN, stagingBytes: 600, gpuBytes: Infinity },
    { cpuBytes: -1, stagingBytes: 600, gpuBytes: -1 },
    { cpuBytes: 99999, stagingBytes: 600, gpuBytes: 99999 },
  ]) {
    const result = combinedBackingResources(renderer, { ...ledger, distant: incomplete });
    assert.ok(result.combinedCpuBytes >= 1800);
    assert.ok(result.gpuBytes >= 1200);
    assert.ok(result.stagingBytes >= 600);
    assert.equal(result.ledgerReconciliation.cpu.includedDistantBytes, null);
  }
  const missingTotal = combinedBackingResources(renderer, { ...ledger, combinedCpuBytes: undefined });
  assert.equal(missingTotal.combinedCpuBytes, 1800);
  assert.equal(missingTotal.ledgerReconciliation.cpu.includedDistantBytes, null);
});
