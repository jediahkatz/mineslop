import { fixedRasterEvidence } from "./raster.js";
import { evaluateRun, cleanEditGates, validatedConstraints, sameConstraints } from "./oracles.js";

export function exitCodeFor(run, { diagnosticOnly = false } = {}) {
  if (diagnosticOnly) return run.infrastructureFailure ? 1 : 0;
  return run.evaluation?.hardStatus === "pass" ? 0 : 1;
}

export function timingQualified(run, limits) {
  const boundedObserver = key => {
    const values = run.timings?.[key];
    return Array.isArray(values) && values.length > 0 && values.every(value =>
      Number.isFinite(value) && value >= 0 &&
      value <= (key === "editObserver" ? limits.maxEditObserverMs : limits.maxTelemetryObserverMs));
  };
  return run.measurementVersion === 3 && run.capture === "performance" &&
    fixedRasterEvidence(run) &&
    run.provenance?.servedVerified === true && run.provenanceStable === true &&
    run.frameIntervals?.length > 0 && run.frameIntervals.every(value => Number.isFinite(value) && value > 0) &&
    run.heavyObserverCalls === 0 && run.pixelReadsWhileRecording === 0 &&
    run.resourceObserverCalls === 0 && run.editRayCalls === 0 &&
    run.timedScreenshots === 0 && boundedObserver("observer") && boundedObserver("editObserver") &&
    run.errors?.length === 0 && run.visibilityEvents?.length === 0 && run.contextLossEvents?.length === 0 &&
    run.samples?.length > 0 && run.samples.every(s => s.hidden === false && s.contextLost === false) &&
    run.edit?.farStillLoading === true && Number.isFinite(run.edit.publicationMs);
}

export function linkCaptures(performance, correctness) {
  const reasons = [];
  const limits = validatedConstraints(performance.constraints);
  const proofLimits = validatedConstraints(correctness.constraints);
  if (!sameConstraints(limits, proofLimits)) reasons.push("constraints mismatch or invalid/missing limits");
  const performanceEvaluation = limits ? evaluateRun(performance, limits) : null;
  const correctnessEvaluation = proofLimits ? evaluateRun(correctness, proofLimits) : null;
  const latencyGates = limits ? cleanEditGates(performance, limits) : [];
  if (!limits || latencyGates.some(g => g.status !== "pass"))
    reasons.push("Clean edit deadline/evidence did not pass");
  for (const [key, a, b] of [
    ["source", performance.provenance?.sourceIdentity, correctness.provenance?.sourceIdentity],
    ["bundle", performance.provenance?.manifestHash, correctness.provenance?.manifestHash],
    ["scene", performance.scene, correctness.scene],
    ["route", performance.measurementScope?.route, correctness.measurementScope?.route],
    ["duration", performance.measurementScope?.durationSeconds, correctness.measurementScope?.durationSeconds],
    ["configuration", performance.configurationLabel, correctness.configurationLabel],
    ["machine", JSON.stringify(performance.machine), JSON.stringify(correctness.machine)],
    ["host", JSON.stringify(performance.host), JSON.stringify(correctness.host)],
  ]) if (a === undefined || a !== b) reasons.push(`${key} mismatch`);
  if (performance.capture !== "performance" || correctness.capture !== "correctness")
    reasons.push("Need separate performance and correctness captures");
  if (!performance.performanceQualified || !limits || !timingQualified(performance, limits))
    reasons.push("Performance measurement is contaminated or unqualified");
  if (!fixedRasterEvidence(performance) || !fixedRasterEvidence(correctness))
    reasons.push("Rendering dimensions were not fixed in both captures");
  if (performance.provenance?.servedVerified !== true || correctness.provenance?.servedVerified !== true)
    reasons.push("Served assets were not verified");
  const perfFailures = performanceEvaluation?.hard?.filter(g => g.status === "fail" &&
    !latencyGates.some(editGate => editGate.name === g.name)) ?? [];
  if (perfFailures.length) reasons.push("Performance capture has hard failures");
  const a = performance.samples?.at(-1), b = correctness.samples?.at(-1);
  if (!a?.position || !b?.position || Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) > 2 ||
      !Number.isFinite(a.yaw) || !Number.isFinite(b.yaw) || Math.abs(a.yaw - b.yaw) > 0.05)
    reasons.push("Independent routes diverged or lack pose evidence");
  return {
    ...performance, constraints: limits, validatedConstraints: limits,
    correctnessEvidence: {
      sourceIdentity: correctness.provenance?.sourceIdentity,
      constraints: proofLimits,
      pixelControl: correctness.pixelControl,
      hardStatus: correctnessEvaluation?.hardStatus,
      evaluation: correctnessEvaluation,
    },
    evaluation: {
      ...performanceEvaluation,
      hard: [...(correctnessEvaluation?.hard ?? []), ...latencyGates, ...perfFailures],
      hardStatus: reasons.length ? "fail" : correctnessEvaluation?.hardStatus ?? "incomplete",
    },
    captureLink: { matched: reasons.length === 0, reasons },
  };
}
