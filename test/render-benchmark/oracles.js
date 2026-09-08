import { summarize } from "../realtime/statistics.js";
import { fixedRasterEvidence } from "./raster.js";
import { positivePixelControl } from "./recovery.js";

export const DEFAULT_CONSTRAINTS = Object.freeze({
  radius: 12, frameP95Ms: 16.7, editMs: 1000, usefulMs: 5000,
  minVisibility: 0.02, maxGpuBytes: 256 * 1024 ** 2,
  maxCpuBytes: 256 * 1024 ** 2, maxStagingBytes: 16 * 1024 ** 2,
  maxDrawCalls: 1024, maxCopyBytesPerSlice: 1024 ** 2,
  maxEditObserverMs: 1, maxTelemetryObserverMs: 1,
  correctnessProofMs: 10000,
});

// Full, canonical snapshots: omitted/unknown limits cannot disappear in a link.
export function validatedConstraints(value) {
  const keys = Object.keys(DEFAULT_CONSTRAINTS).sort();
  if (!value || Object.keys(value).length !== keys.length ||
      keys.some(key => !Number.isFinite(value[key]) || value[key] <= 0) ||
      !Number.isInteger(value.radius) || value.radius > 12 || value.minVisibility > 1)
    return null;
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}

export function sameConstraints(a, b) {
  const left = validatedConstraints(a), right = validatedConstraints(b);
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}

// Three's linear Fog uses smoothstep of forward view depth, not radial distance.
export function visibilityAt(near, far, depth) {
  if (![near, far, depth].every(Number.isFinite) || far <= near) return null;
  const t = Math.max(0, Math.min(1, (depth - near) / (far - near)));
  return 1 - t * t * (3 - 2 * t);
}

export function bufferUploadBytes(data, offset = 0, length = 0) {
  if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) return 0;
  const width = data.BYTES_PER_ELEMENT ?? 1;
  const available = Math.max(0, data.byteLength - offset * width);
  return length ? Math.min(available, length * width) : available;
}

export function ringCensus(columns, radius) {
  const rings = Array.from({ length: radius + 1 }, (_, ring) => ({
    ring, required: ring ? ring * 8 : 1, physical: 0, fullFresh: 0,
  }));
  const seen = new Set();
  for (const column of columns) {
    if (seen.has(column.key)) throw new Error("Duplicate column census");
    seen.add(column.key);
    if (!Number.isInteger(column.ring) || column.ring < 0 || column.ring > radius) continue;
    rings[column.ring].physical += Number(column.physical === true);
    rings[column.ring].fullFresh += Number(column.fullFresh === true);
  }
  let fullRadius = -1;
  for (const ring of rings) {
    if (ring.fullFresh !== ring.required) break;
    fullRadius = ring.ring;
  }
  return { rings, fullRadius, fullDetailBlocks: Math.max(0, fullRadius * 16) };
}

const gate = (name, actual, limit, predicate = (a, b) => a <= b) => ({
  name, actual: actual ?? null, limit,
  status: !Number.isFinite(actual) ? "unavailable" : predicate(actual, limit) ? "pass" : "fail",
});

export function cleanEditGates(run, constraints) {
  const transaction = run.edit?.transactionMs, publication = run.edit?.publicationMs;
  return [
    gate("clean paid edit transaction ms", transaction, constraints.editMs, (a, b) => a >= 0 && a <= b),
    gate("clean paid edit publication ms", publication, constraints.editMs, (a, b) => a >= 0 && a <= b),
    { name: "clean edit transaction precedes publication",
      status: !Number.isFinite(transaction) || !Number.isFinite(publication) ? "unavailable" :
        publication >= transaction ? "pass" : "fail" },
  ];
}

export function evaluateRun(run, constraints = DEFAULT_CONSTRAINTS) {
  const samples = run.samples ?? [];
  const resourceObserved = samples.some(s => s.resources?.includesDistantBacking === true);
  const peak = (field) => {
    if (!resourceObserved) return null;
    const values = [...samples.map(s => s.resources?.[field]), run.peaks?.[field]].filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };
  const masks = samples.filter(s => s.mask?.checks > 0)
    .map(s => s.mask.mismatches).filter(Number.isFinite);
  const positiveMaskEvidence = samples.some(s => s.mask?.checks > 0 && s.mask?.expectedSections > 0);
  const surfaces = samples.flatMap(s => s.surfaces ?? []);
  const checkedSurfaces = surfaces.filter(s => ["native-match", "fallback-approximation", "missing-surface", "duplicate-ownership"].includes(s.status));
  const nonempty = samples.some(s => s.native?.rings?.some(r => r.physical > 0));
  const nativeObserved = samples.some(s => s.native?.available !== false && s.native?.rings?.length);
  const hard = [
    gate("nonempty physical native evidence", run.capture === "performance" && !nativeObserved ? null : nonempty ? 1 : 0, 1, (a, b) => a >= b),
    gate("published native/LOD ownership mask mismatches",
      masks.some(value => value > 0) || positiveMaskEvidence ? Math.max(...masks) : null, 0),
    gate("canonical GPU bytes", peak("gpuBytes"), constraints.maxGpuBytes),
    gate("combined CPU bytes", peak("combinedCpuBytes"), constraints.maxCpuBytes),
    gate("staging bytes", peak("stagingBytes"), constraints.maxStagingBytes),
    gate("terrain draw submissions", peak("drawCalls"), constraints.maxDrawCalls),
    gate("copy bytes per mesh slice", run.copy?.maxBytes, constraints.maxCopyBytesPerSlice),
    gate("paid edit physical fresh proof observation ms",
      run.capture === "performance" ? null : run.edit?.visibleMs, constraints.correctnessProofMs,
      (a, b) => a >= 0 && a <= b),
    { name: "paid edit while far geometry loads", status: run.edit?.farStillLoading === true ? "pass" : "fail" },
    gate("runtime errors", run.errors?.length, 0),
    gate("post-timing control errors", run.controlErrors?.length, 0),
    gate("sampled visible missing surfaces", checkedSurfaces.length ? surfaces.filter(s => s.status === "missing-surface").length : null, 0),
    gate("sampled duplicate native/LOD surfaces", checkedSurfaces.length ? surfaces.filter(s => s.status === "duplicate-ownership").length : null, 0),
    { name: "A/B/A native-hidden pixel control",
      status: !run.pixelControl || run.pixelControl.status === "unavailable" ? "unavailable" :
        positivePixelControl(run.pixelControl) ? "pass" : "fail" },
    { name: "context loss/recovery and disposal", status: run.lifecycle?.status ?? "unavailable" },
    { name: "immutable source provenance", status: run.provenanceStable === true ? "pass" : "fail" },
    { name: "verified fetched frozen modules", status: run.provenance?.servedVerified === true ? "pass" : "fail" },
    { name: "positive mask evidence", status: positiveMaskEvidence ? "pass" : "unavailable" },
    { name: "native plus live/pending LOD/vegetation backing accounting",
      status: resourceObserved ? "pass" : "unavailable" },
    gate("hidden document events", Array.isArray(run.visibilityEvents)
      ? run.visibilityEvents.length + samples.filter(s => s.hidden === true).length : null, 0),
    gate("unexpected context losses", Array.isArray(run.contextLossEvents)
      ? run.contextLossEvents.length + samples.filter(s => s.contextLost === true).length : null, 0),
  ];
  if (run.capture === "performance") {
    hard.push(...cleanEditGates(run, constraints));
    hard.push(gate("benchmark heavy observers in performance capture", run.heavyObserverCalls, 0));
    hard.push(gate("benchmark timed readbacks", run.pixelReadsWhileRecording, 0));
    hard.push(gate("resource scans in performance capture", run.resourceObserverCalls, 0));
    hard.push(gate("edit rays in performance capture", run.editRayCalls, 0));
    hard.push(gate("timed screenshots", run.timedScreenshots, 0));
    hard.push(gate("edit observation maximum ms", summarize(run.timings?.editObserver ?? []).max, constraints.maxEditObserverMs));
    hard.push(gate("scalar telemetry maximum ms", summarize(run.timings?.observer ?? []).max, constraints.maxTelemetryObserverMs));
  }
  if (run.scene === "river") {
    hard.push(gate("river scene R2 native water-cell evidence",
      run.capture === "performance" ? null : run.profile?.waterCells, 1000, (a, b) => a >= b));
    hard.push(gate("dense foliage scene R2 native leaf-cell evidence",
      run.capture === "performance" ? null : run.profile?.leafCells, 1000, (a, b) => a >= b));
  }
  if (run.scene === "dense-river-v1")
    hard.push({ name: "native water and foliage in camera region", status: run.capture === "performance" ||
      run.scenePrecondition?.passed === undefined ? "unavailable" : run.scenePrecondition.passed === true ? "pass" : "fail" });
  if (run.configurationLabel)
    hard.push({ name: "explicit default-off/candidate page-local configuration",
      status: (run.settings?.limits?.experimentalPageLocalUpdates === true) ===
        (run.configurationLabel === "page-local-candidate") ? "pass" : "fail" });
  if (run.capture)
    hard.push({ name: "fixed rendering dimensions", status: fixedRasterEvidence(run) ? "pass" : "fail" });
  const first = (predicate) => samples.find(predicate)?.ms ?? null;
  const thresholds = [64, 128, 192].map(blocks => ({
    blocks,
    fullNativeMs: first(s => s.native?.fullDetailBlocks >= blocks),
    // Geometry sampled at distance AND fog visibility; never radius flags.
    sampledFallbackMs: first(s => s.rays?.filter(r => r.blocks === blocks).length >= 4 &&
      s.rays.filter(r => r.blocks === blocks).every(r => r.fallback &&
        visibilityAt(s.fog.near, s.fog.far, blocks) >= constraints.minVisibility)),
    visibleFallbackCandidateMs: first(s => s.rays?.some(r => r.blocks === blocks && r.fallback &&
      r.inView && r.terrainOccluded === false && r.viewTransmission >= constraints.minVisibility)),
    fogVisibilityMs: first(s => visibilityAt(s.fog.near, s.fog.far, blocks) >= constraints.minVisibility),
  }));
  const usefulMs = first(s => s.native?.fullRadius >= 1 && s.native.rings[0].physical > 0);
  const targetMs = first(s => s.native?.fullRadius >= constraints.radius);
  return {
    nativeEvidenceStatus: nativeObserved ? "observed" : "unavailable",
    hard, hardStatus: hard.some(g => g.status === "fail") ? "fail" :
      hard.every(g => g.status === "pass") ? "pass" : "incomplete",
    thresholds, usefulMs, targetMs,
    targets: [
      gate("first useful fresh R1 neighborhood ms", usefulMs, constraints.usefulMs),
      gate("p95 frame interval ms", summarize(run.frameIntervals ?? []).p95, constraints.frameP95Ms),
      { name: `full native R${constraints.radius} (${constraints.radius * 16} blocks)`, status: !nativeObserved ? "unavailable" : targetMs === null ? "unreached" : "reached" },
    ],
    hardwareQualification: run.machine?.softwareRenderer === false ? "hardware-unqualified-without-repeated-trials" : "software-or-unknown-GPU-diagnostic-only",
  };
}
