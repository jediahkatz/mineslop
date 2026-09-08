import { summarize } from "../realtime/statistics.js";
import { fixedSourceGroups } from "./provenance.mjs";
import { fixedRasterEvidence } from "./raster.js";
import { cleanEditGates, sameConstraints, validatedConstraints } from "./oracles.js";
import { timingQualified } from "./acceptance.js";
import { positivePixelControl } from "./recovery.js";

const metric = (run, key) => ({
  frameP95: run.statistics?.frames.p95,
  editMs: run.edit?.publicationMs,
  meshP95: run.statistics?.timings.mesh.p95,
})[key];

export function compareTrials(before, after, { minimumPairs = 3, improvementFraction = 0.05, regressionFraction = 0.05 } = {}) {
  const reasons = [];
  const limits = validatedConstraints(before[0]?.constraints);
  for (const row of [...before, ...after])
    if (!sameConstraints(limits, row.constraints) ||
        !sameConstraints(row.constraints, row.validatedConstraints) ||
        !sameConstraints(row.constraints, row.correctnessEvidence?.constraints))
      reasons.push("Constraint sets differ across trials or from validated correctness limits");
  const fixed = fixedSourceGroups(before, after);
  if (!fixed.passed) reasons.push(fixed.reason);
  for (const [label, rows] of [["baseline", before], ["candidate", after]])
    if (new Set(rows.map(r => r.configurationLabel)).size !== 1)
      reasons.push(`${label}: configuration changed across trials`);
  for (const row of [...before, ...after])
    if (!positivePixelControl(row.correctnessEvidence?.pixelControl))
      reasons.push("Missing current positive physical/pixel proof in linked correctness evidence");
  if (before.length !== after.length || before.length < minimumPairs)
    reasons.push(`Need at least ${minimumPairs} alternating paired trials with equal counts`);
  const environment = r => JSON.stringify({
    scene: r.scene, machine: r.machine, host: r.host,
    dependencies: r.provenance?.dependencies, harnessHash: r.provenance?.harnessHash,
    durationSeconds: r.measurementScope?.durationSeconds,
    route: r.measurementScope?.route,
  });
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i], b = after[i];
    if (!a.provenance?.harnessHash || !b.provenance?.harnessHash || environment(a) !== environment(b))
      reasons.push(`Pair ${i + 1}: environment/configuration/harness mismatch or missing provenance`);
    if (b.evaluation?.hardStatus !== "pass")
      reasons.push(`Pair ${i + 1}: candidate hard constraints did not pass`);
    if (!limits || cleanEditGates(b, limits).some(g => g.status !== "pass"))
      reasons.push(`Pair ${i + 1}: candidate exceeds clean edit deadline or lacks clean latency evidence`);
    for (const r of [a, b])
      if (r.provenanceStable !== true || !r.samples?.length)
        reasons.push(`Pair ${i + 1}: provenance or nonempty evidence did not pass`);
    for (const r of [a, b]) {
      if (!r.performanceQualified || !limits || !timingQualified(r, limits) ||
          r.measurementVersion !== 3 || r.capture !== "performance")
        reasons.push(`Pair ${i + 1}: contaminated/legacy/non-performance timing capture`);
      if (!fixedRasterEvidence(r))
        reasons.push(`Pair ${i + 1}: raster dimensions were not fixed`);
      if (r.provenance?.servedVerified !== true || !r.provenance?.sourceRef || !r.provenance?.patchHash)
        reasons.push(`Pair ${i + 1}: fetched source/ref/patch evidence missing`);
      if (r.captureLink?.matched !== true)
        reasons.push(`Pair ${i + 1}: missing matched independent correctness capture`);
    }
    const ap = a.samples?.at(-1)?.position, bp = b.samples?.at(-1)?.position;
    if (!ap || !bp || Math.hypot(ap[0] - bp[0], ap[2] - bp[2]) > 2)
      reasons.push(`Pair ${i + 1}: measured camera route diverged by >2 blocks or is unavailable`);
  }
  const deltas = {};
  for (const key of ["frameP95", "editMs", "meshP95"]) {
    const changes = [];
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      const a = metric(before[i], key), b = metric(after[i], key);
      if (Number.isFinite(a) && Number.isFinite(b) && a > 0) changes.push((b - a) / a);
    }
    const stats = summarize(changes);
    deltas[key] = { pairedRelativeChange: stats,
      standardDeviation: changes.length > 1 ? Math.sqrt(changes.reduce((n, x) => n + (x - stats.mean) ** 2, 0) / (changes.length - 1)) : null };
  }
  for (const key of ["frameP95", "editMs"])
    if (deltas[key].pairedRelativeChange.samples !== before.length ||
        deltas[key].pairedRelativeChange.max > regressionFraction)
      reasons.push(`${key}: missing paired evidence or a regression beyond ${regressionFraction * 100}%`);
  const improved = ["meshP95"].filter(key =>
    deltas[key].pairedRelativeChange.samples === before.length &&
    deltas[key].pairedRelativeChange.p50 !== null &&
    deltas[key].pairedRelativeChange.p50 <= -improvementFraction &&
    deltas[key].pairedRelativeChange.max < 0);
  if (!improved.length) reasons.push("No repeatable clean meshing improvement; correctness census timings are not comparison metrics");
  return {
    accepted: reasons.length === 0, reasons, improved, deltas,
    scope: "Paired optimization acceptance only, not R12/hardware release qualification; correctness cannot be traded for speed.",
  };
}
