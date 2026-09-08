import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { correctnessFixture, performanceFixture, linkedFixture } from "./audit-fixtures.js";
import { evaluateRun, DEFAULT_CONSTRAINTS, sameConstraints } from "./oracles.js";
import { linkCaptures } from "./acceptance.js";
import { compareTrials } from "./comparison.js";
import { ownershipWitness } from "./ownership-witness.js";

const dense = source => {
  const performance = performanceFixture(source), correctness = correctnessFixture(source);
  for (const run of [performance, correctness]) {
    run.scene = "dense-river-v1"; run.measurementScope.route = "fixed-dense-river-route";
  }
  correctness.scenePrecondition = { passed: true };
  return { performance, correctness };
};

test("reviewer: 512 MiB GPU accepted under 1 GiB cannot link to timing claiming 256 MiB", () => {
  const performance = performanceFixture(), correctness = correctnessFixture();
  correctness.constraints.maxGpuBytes = 1024 ** 3;
  correctness.samples[0].resources.gpuBytes = 512 * 1024 ** 2;
  assert.equal(evaluateRun(correctness, correctness.constraints).hardStatus, "pass");
  const linked = linkCaptures(performance, correctness);
  assert.equal(linked.evaluation.hardStatus, "fail");
  assert.match(linked.captureLink.reasons.join("\n"), /constraints mismatch/);
  assert.equal(linked.validatedConstraints.maxGpuBytes, 256 * 1024 ** 2);
  assert.equal(linked.correctnessEvidence.constraints.maxGpuBytes, 1024 ** 3);
  performance.constraints.maxGpuBytes = 1024 ** 3;
  assert.equal(linked.constraints.maxGpuBytes, 256 * 1024 ** 2, "validated limits are copied, not borrowed");
  const rows = () => Array.from({ length: 3 }, () => linkedFixture());
  const a = rows(), b = rows();
  b[0].constraints = { ...b[0].constraints, maxGpuBytes: 1024 ** 3 };
  assert.equal(compareTrials(a, b).accepted, false);
  assert.equal(sameConstraints(DEFAULT_CONSTRAINTS,
    Object.fromEntries(Object.entries(DEFAULT_CONSTRAINTS).reverse())), true);
});

test("reviewer: 5000 ms clean candidate fails the 1000 ms deadline even versus 6000 ms baseline", () => {
  const before = Array.from({ length: 3 }, () => linkedFixture("baseline", 10));
  const after = Array.from({ length: 3 }, () => linkedFixture("candidate", 8));
  for (const run of before) run.edit.publicationMs = 6000;
  for (const run of after) run.edit.publicationMs = 5000;
  const result = compareTrials(before, after);
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join("\n"), /clean edit deadline/);
  const perf = performanceFixture(); perf.edit.publicationMs = 5000;
  assert.equal(linkCaptures(perf, correctnessFixture()).evaluation.hardStatus, "fail");
  perf.edit.publicationMs = 100; perf.edit.transactionMs = 5000;
  assert.equal(linkCaptures(perf, correctnessFixture()).evaluation.hardStatus, "fail");
});

test("reviewer: 100 ms clean edit passes with observer-heavy 1447 ms physical proof, but proof remains bounded", () => {
  const perf = performanceFixture(), proof = correctnessFixture();
  proof.edit.visibleMs = 1447;
  const linked = linkCaptures(perf, proof);
  assert.equal(linked.evaluation.hardStatus, "pass");
  assert.equal(linked.evaluation.hard.find(g => g.name === "clean paid edit publication ms").limit, 1000);
  assert.equal(linked.evaluation.hard.find(g => g.name === "paid edit physical fresh proof observation ms").limit, 10000);
  proof.edit.visibleMs = DEFAULT_CONSTRAINTS.correctnessProofMs + 1;
  assert.equal(linkCaptures(perf, proof).evaluation.hardStatus, "fail");
  proof.edit.visibleMs = null;
  assert.equal(linkCaptures(perf, proof).evaluation.hardStatus, "incomplete");
});

test("dense-river performance census is unavailable; only matching positive correctness can satisfy it", () => {
  const { performance, correctness } = dense("same");
  const gate = evaluateRun(performance).hard.find(g => g.name === "native water and foliage in camera region");
  assert.equal(gate.status, "unavailable");
  assert.equal(evaluateRun(performance).hardStatus, "incomplete");
  assert.equal(linkCaptures(performance, correctness).evaluation.hardStatus, "pass");
  delete correctness.scenePrecondition;
  assert.equal(linkCaptures(performance, correctness).evaluation.hardStatus, "incomplete");
  correctness.scenePrecondition = { passed: false };
  assert.equal(linkCaptures(performance, correctness).evaluation.hardStatus, "fail");
  correctness.scenePrecondition.passed = true; correctness.scene = "classic";
  assert.equal(linkCaptures(performance, correctness).captureLink.matched, false);
});

test("empty-publication witness preserves cache revision zero and does not claim a hole or repair the cache", () => {
  const cache = new Map([["0,0,0", 0]]);
  const renderer = { meshResourceRevision: 0, detailBatchCache: { key: "0:0,0:12:1:medium", value: cache } };
  const witness = ownershipWitness(renderer, { version: 7, texture: { value: { version: 8 } } }, "0,0,0", 15, 0);
  assert.equal(witness.meshResourceRevision, 0); assert.equal(witness.cacheRevision, 0);
  assert.equal(witness.freshBits, 15); assert.equal(witness.cachedBits, 0);
  assert.equal(witness.maskRevision, 7); assert.equal(witness.sectionKey, "0,0,0");
  assert.equal(witness.kind, "ownership-mask-mismatch"); assert.equal(cache.get("0,0,0"), 0);
  const run = correctnessFixture();
  run.samples[0].mask = { checks: 4, expectedSections: 1, mismatches: 4, witnesses: [witness] };
  assert.equal(evaluateRun(run).hardStatus, "fail");
  assert.equal(evaluateRun(run).hard.find(g => g.name === "sampled visible missing surfaces").actual, 0);
});

test("exact reviewer controls through real runner/link/compare CLIs, including dense-river split captures", async t => {
  const dir = await mkdtemp(join(tmpdir(), "benchmark-reviewer-controls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let sequence = 0;
  const save = async value => {
    const path = join(dir, `input-${sequence++}.json`);
    await writeFile(path, JSON.stringify(value)); return path;
  };
  const cli = (name, args) => spawnSync(process.execPath,
    [fileURLToPath(new URL(name, import.meta.url)), ...args], {
      encoding: "utf8", timeout: 15000, env: { ...process.env, BENCH_DIAGNOSTIC_ONLY: "0" },
    });
  const link = async (perf, proof, expected) => {
    const output = join(dir, `linked-${sequence++}`);
    const result = cli("link.mjs", [await save(perf), await save(proof), output]);
    assert.equal(result.status, expected, result.stderr);
    return JSON.parse(await readFile(join(output, "run.json"), "utf8"));
  };
  const { performance, correctness } = dense("baseline");
  let result = cli("run.mjs", ["--check-result", await save(performance)]);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).hardStatus, "incomplete");
  correctness.edit.visibleMs = 1447;
  result = cli("run.mjs", ["--check-result", await save(correctness)]);
  assert.equal(result.status, 0, result.stderr);
  const baseline = await link(performance, correctness, 0);
  delete correctness.scenePrecondition;
  await link(performance, correctness, 1);
  correctness.scenePrecondition = { passed: false };
  await link(performance, correctness, 1);
  correctness.scenePrecondition.passed = true;
  correctness.constraints.maxGpuBytes = 1024 ** 3;
  correctness.samples[0].resources.gpuBytes = 512 * 1024 ** 2;
  await link(performance, correctness, 1);

  const candidatePair = dense("candidate");
  candidatePair.performance.statistics.timings.mesh.p95 = 8;
  candidatePair.performance.timings.mesh = [8];
  candidatePair.correctness.edit.visibleMs = 1447;
  const candidate = await link(candidatePair.performance, candidatePair.correctness, 0);
  const compare = async (a, b, expected) => {
    const before = await Promise.all(Array.from({ length: 3 }, () => save(a)));
    const after = await Promise.all(Array.from({ length: 3 }, () => save(b)));
    const result = cli("compare.mjs", [...before, "--", ...after]);
    assert.equal(result.status, expected, result.stderr);
    assert.equal(JSON.parse(result.stdout).accepted, expected === 0);
  };
  await compare(baseline, candidate, 0);
  candidate.constraints = { ...candidate.constraints, maxGpuBytes: 1024 ** 3 };
  await compare(baseline, candidate, 1);
  candidate.constraints = { ...baseline.constraints };
  baseline.edit.publicationMs = 6000; candidate.edit.publicationMs = 5000;
  await compare(baseline, candidate, 1);
  candidatePair.performance.edit.publicationMs = 5000;
  await link(candidatePair.performance, candidatePair.correctness, 1);
});
