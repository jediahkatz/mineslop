// Restored from the regional recovery measurement, bound to this checkout.
// CPU geometry capacity only: R12 requires 625 full-detail columns and R+2 inputs.
import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { detailMeshResources, REGIONAL_MESH_LIMITS, DETAIL_MESH_LIMITS } from "../src/section-renderer.js";
import { nativeGeometryFixture, requiredGeometryState, nativeDistribution,
  unloadNativeColumn, markNativeNeighbors, moveNativeGeometryEast } from "./regional-native-fixture.js";

const seed = process.env.NATIVE_SEED ?? "cedar-valley";
const radius = Number(process.env.NATIVE_RADIUS ?? 1);
if (!Number.isInteger(radius) || radius < 1 || radius > 12) throw new RangeError("Native radius must be 1..12");
const wallTimeSeconds = Number(process.env.NATIVE_WALL_SECONDS ?? 170);
if (!Number.isInteger(wallTimeSeconds) || wallTimeSeconds < 1 || wallTimeSeconds > 540)
  throw new RangeError("Native wall time must be an integer in 1..540 seconds");
const flush = process.env.NATIVE_FLUSH === "1";
const runStarted = performance.now();
const limits = { ...DETAIL_MESH_LIMITS, ...REGIONAL_MESH_LIMITS };
const record = {
  kind: "native-regional-cpu-geometry-capacity-not-release-qualification",
  seed, version: Number(process.env.NATIVE_VERSION ?? 7),
  dimension: process.env.NATIVE_DIMENSION ?? "overworld", radius,
  dependencyRadius: radius + 2, inputColumns: (radius * 2 + 5) ** 2,
  wallTimeSeconds, flush, sliceBudgetMs: 2, waterFusionEnabled: false,
  limits: { gpu: limits.maxGpuBytes, combinedCpu: limits.maxCpuBytes,
    staging: limits.maxStagingBytes, drawCalls: limits.maxDrawCalls,
    copyPerSlice: limits.maxCopyBytesPerSlice, sliceMs: limits.maxSliceMs },
  phases: [],
  caveat: "Native packets; exact full-detail/all-section freshness; fixture atlas and CPU host. No World streaming, full lighting, hardware GPU, FPS, throughput, or fused R12 acceptance. Flush only bypasses pacing, never admission.",
};
let fixture, currentPhase = "generation", generatedColumns = 0, observedDrawCallsPeak = 0;
const emit = (value) => console.error(JSON.stringify(value));
function checkDeadline() {
  if (performance.now() - runStarted >= wallTimeSeconds * 1000)
    throw new Error(`Internal deadline during ${currentPhase}`);
}
function peaks() {
  return { peakCpu: fixture?.renderer.meshStats?.peakCombinedCpuBytes ?? 0,
    peakStaging: fixture?.renderer.meshStats?.peakStagingBytes ?? 0,
    peakReservedGpuBytes: fixture?.renderer.meshStats?.peakReservedGpuBytes ?? 0,
    observedDrawCallsPeak };
}
function phase(name, paced = false) {
  currentPhase = name;
  const { world, renderer } = fixture;
  const started = performance.now();
  emit({ event: "native-phase-start", phase: name, elapsedMs: started - runStarted });
  let slices = 0, maxSliceMs = 0, maxCopyBytes = 0, maxRebuildCallMs = 0;
  let state, refusalKey, stopReason = "internal-deadline", unchangedRefusals = 0;
  let nextProgress = started + 5000;
  while (performance.now() - runStarted < wallTimeSeconds * 1000 && slices < 100000) {
    const callStarted = performance.now();
    renderer.rebuildDirty(!paced && flush ? Infinity : 2);
    maxRebuildCallMs = Math.max(maxRebuildCallMs, performance.now() - callStarted);
    slices++;
    maxSliceMs = Math.max(maxSliceMs, renderer.meshStats.lastSliceMs);
    maxCopyBytes = Math.max(maxCopyBytes, renderer.meshStats.lastSliceCopyBytes ?? 0);
    const resources = detailMeshResources(renderer);
    observedDrawCallsPeak = Math.max(observedDrawCallsPeak, resources.drawCalls);
    if ((renderer.meshStats.blocked || renderer.meshStats.compactionBlocked) &&
        !renderer.sectionJobs.size && !renderer.sectionCompaction &&
        renderer.meshStats.lastSliceCopyBytes === 0) {
      const key = [resources.gpuBytes, resources.retainedDeadBytes,
        world.dirtySectionRevisions.size, renderer.meshStats.compactions,
        renderer.meshStats.blocked?.reason, renderer.meshStats.compactionBlocked?.reason].join(":");
      unchangedRefusals = key === refusalKey ? unchangedRefusals + 1 : 0;
      refusalKey = key;
      if (unchangedRefusals >= 3) { stopReason = "unchanged-refusal-after-retries"; break; }
    } else unchangedRefusals = 0;
    // Deep revision validation is an observer, not game work.
    if (slices % 25 === 1 || performance.now() >= nextProgress) {
      state = requiredGeometryState(fixture);
      if (performance.now() >= nextProgress) {
        emit({ event: "native-progress", phase: name, elapsedMs: performance.now() - runStarted,
          ...state, drawCalls: resources.drawCalls, gpuBytes: resources.gpuBytes,
          combinedCpuBytes: resources.combinedCpuBytes, ...peaks(),
          blocked: renderer.meshStats.blocked, compactionBlocked: renderer.meshStats.compactionBlocked });
        nextProgress = performance.now() + 5000;
      }
      if (state.fresh === state.required && state.freshSections === state.requiredSections &&
          !renderer.sectionCompaction && resources.retainedDeadBytes === 0) {
        stopReason = "fresh-coverage-and-compaction-drained";
        break;
      }
    }
  }
  if (slices >= 100000) stopReason = "slice-bound";
  state = requiredGeometryState(fixture);
  const stats = detailMeshResources(renderer);
  const buffers = new Set();
  renderer.scene.traverse((mesh) => {
    if (!mesh.geometry) return;
    for (const attribute of [...Object.values(mesh.geometry.attributes), mesh.geometry.index])
      if (attribute) buffers.add(attribute.array.buffer);
  });
  // Count actual unique backing allocations, not live ranges or ledger totals.
  const independentGeometryBackingBytes = [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
  const canonicalAccountingMatches = independentGeometryBackingBytes === stats.canonicalBytes - stats.palette.cpuBytes &&
    independentGeometryBackingBytes === stats.gpuBytes - stats.palette.gpuBytes;
  const result = { name, center: [fixture.cx, fixture.cz], ...state, paced, stopReason,
    inputColumns: world.chunks.size, dependencyRadius: fixture.dependencyRadius,
    elapsedMs: performance.now() - started, slices, maxSliceMs, maxRebuildCallMs, maxCopyBytes,
    ...stats, requiredSectionsInstalled: state.sections, independentGeometryBackingBytes,
    canonicalAccountingMatches, ...peaks(),
    blocked: renderer.meshStats.blocked, compactionBlocked: renderer.meshStats.compactionBlocked,
    compactions: renderer.meshStats.compactions ?? 0 };
  record.phases.push(result);
  emit({ event: "native-phase-result", ...result });
  return stopReason === "fresh-coverage-and-compaction-drained" &&
    state.covered === state.required && state.fresh === state.required &&
    state.freshSections === state.requiredSections && state.sections === state.requiredSections &&
    world.chunks.size === fixture.inputColumns &&
    stats.combinedCpuBytes <= limits.maxCpuBytes && stats.gpuBytes <= limits.maxGpuBytes &&
    stats.stagingBytes <= limits.maxStagingBytes && stats.drawCalls <= limits.maxDrawCalls &&
    canonicalAccountingMatches && renderer.meshStats.peakCombinedCpuBytes <= limits.maxCpuBytes &&
    renderer.meshStats.peakStagingBytes <= limits.maxStagingBytes &&
    renderer.meshStats.peakReservedGpuBytes <= limits.maxGpuBytes &&
    ((!paced && flush) || maxCopyBytes <= limits.maxCopyBytesPerSlice);
}

emit({ event: "native-start", ...record, phase: currentPhase });
try {
  fixture = nativeGeometryFixture({
    seed, radius, version: record.version, dimension: record.dimension,
    cx: Number(process.env.NATIVE_CX ?? 0), cz: Number(process.env.NATIVE_CZ ?? 0),
    locate: process.env.NATIVE_BIOME,
    legacyAdapter: process.env.NATIVE_LEGACY_ADAPTER !== "0",
    onGenerationProgress: (state) => {
      generatedColumns = state.generatedColumns;
      if (generatedColumns % 25 === 0 || generatedColumns === state.inputColumns)
        emit({ event: "native-generation", phase: currentPhase,
          elapsedMs: performance.now() - runStarted, ...state });
      checkDeadline();
    },
  });
  const { world, renderer } = fixture;
  // Measurement-only tighter scheduling, unchanged capacity ceilings.
  renderer.meshLimits.maxSliceMs = 2;
  assert.notEqual(renderer.waterFusionEnabled, true, "baseline must leave water fusion off");
  Object.assign(record, {
    center: [fixture.cx, fixture.cz], locator: fixture.destination, spec: world.spec,
    heightBasedSectionEligibility: fixture.nativeRoute,
    testOnlyRegionalRoutingAdapter: fixture.legacyRoutingAdapter,
    generationMs: fixture.generationMs, distribution: nativeDistribution(fixture),
  });
  emit({ event: "native-inputs", ...record });
  if (process.env.NATIVE_PROGRESS === "1") {
    const acknowledge = world.acknowledgeSectionMesh;
    let installed = 0;
    world.acknowledgeSectionMesh = (...args) => {
      const result = acknowledge(...args);
      if (result && ++installed % 500 === 0) {
        // Publication can temporarily hold transferred descriptors in a private
        // job; report installed GPU and reserved peaks, not double-counted CPU.
        const resources = detailMeshResources(renderer);
        observedDrawCallsPeak = Math.max(observedDrawCallsPeak, resources.drawCalls);
        emit({ event: "native-install-progress", phase: currentPhase,
          elapsedMs: performance.now() - runStarted, ...requiredGeometryState(fixture),
          drawCalls: resources.drawCalls, installedGpuBytes: resources.gpuBytes, ...peaks() });
      }
      return result;
    };
  }
  let passed = phase("initial");
  if (passed && process.env.NATIVE_LIFECYCLE === "1") {
    currentPhase = "travel-input-generation";
    moveNativeGeometryEast(fixture, checkDeadline);
    passed = phase("one-chunk-east-travel", true);
    if (passed) {
      const key = `${fixture.cx},${fixture.cz}`;
      const oldIncarnation = world.chunks.get(key).incarnation;
      unloadNativeColumn(fixture, fixture.cx, fixture.cz);
      record.unloadCoverage = requiredGeometryState(fixture).covered;
      fixture.admit(fixture.cx, fixture.cz);
      markNativeNeighbors(fixture, fixture.cx, fixture.cz);
      record.reloadIncarnations = [oldIncarnation, world.chunks.get(key).incarnation];
      passed = phase("visible-column-unload-native-reload", true);
    }
    if (passed) {
      const x = fixture.cx * 16 + 8, z = fixture.cz * 16 + 8;
      let y = world.spec.maxY - 2;
      while (y > world.spec.minY && !world.get(x, y, z)) y--;
      y++;
      assert.ok(y < world.spec.maxY && y > world.spec.minY, "edit must be above actual native terrain");
      record.edit = { x, y, z, before: world.get(x, y, z), after: BLOCK.STONE };
      world.put(x, y, z, BLOCK.STONE);
      markNativeNeighbors(fixture, fixture.cx, fixture.cz, Math.floor(y / 16));
      passed = phase("ordinary-surface-block-edit", true);
    }
  }
  record.passed = passed;
  assert.equal(passed, true, "Native coverage/resource/lifecycle requirement failed; inspect JSON");
} catch (error) {
  record.passed = false;
  record.failure = { phase: currentPhase, generatedColumns, message: error.message,
    stack: error.stack, ...(fixture ? requiredGeometryState(fixture) : {}), ...peaks() };
  process.exitCode = 1;
} finally {
  record.totalMs = performance.now() - runStarted;
  console.log(JSON.stringify(record, null, 2));
  fixture?.dispose();
}
