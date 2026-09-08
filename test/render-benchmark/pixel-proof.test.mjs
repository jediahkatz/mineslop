import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { positivePixelControl } from "./recovery.js";
import { correctnessFixture, performanceFixture, linkedFixture, pixelFixture } from "./audit-fixtures.js";
import { evaluateRun } from "./oracles.js";
import { linkCaptures } from "./acceptance.js";
import { compareTrials } from "./comparison.js";

const pixelGate = run => evaluateRun(run).hard.find(g => g.name === "A/B/A native-hidden pixel control");

test("positive proof requires observed physical geometry, three renders/readbacks and camera restoration", () => {
  assert.equal(positivePixelControl(pixelFixture()), true);
  const run = correctnessFixture();
  assert.equal(pixelGate(run).status, "pass");
  delete run.pixelControl;
  assert.equal(pixelGate(run).status, "unavailable");
});

const faults = [
  ["false physical witness", p => { p.positiveSurface = false; }],
  ["legacy proof version", p => { p.proofVersion = 1; }],
  ["render refusal", p => { p.rendered.normal = false; }],
  ["hidden render refusal", p => { p.rendered.nativeHidden = false; }],
  ["restored render refusal", p => { p.rendered.restored = false; }],
  ["missing restored render", p => { delete p.rendered.restored; }],
  ["no draws", p => { p.draws = 0; }],
  ["no restored draws", p => { p.restoredDraws = 0; }],
  ["nonfinite draws", p => { p.draws = Infinity; }],
  ["empty pixels", p => { p.nonzeroChannels = 0; }],
  ["negative pixels", p => { p.changedChannels = -1; }],
  ["unchanged pixels", p => { p.changedChannels = 0; }],
  ["failed restoration", p => { p.restoredChannels = 1; }],
  ["GL error", p => { p.glError = 1282; }],
  ["hidden GL error despite claimed final zero", p => { p.glErrors[1] = 1282; }],
  ["missing third GL observation", p => { p.glErrors.pop(); }],
  ["runtime error", p => { p.errors.push("draw error"); }],
  ["empty pose", p => { p.poseKey = ""; }],
  ["missing pose restoration", p => { p.poseRestored = false; }],
  ["wrong restored pose", p => { p.restoredPoseKey = "different"; }],
  ["invalid pose kind", p => { p.poseKind = "undeclared"; }],
];
for (const field of Object.keys(pixelFixture()))
  faults.push([`absent ${field}`, p => { delete p[field]; }]);
for (const [name, mutate] of faults) test(`claimed-pass pixel evidence rejects ${name}`, () => {
  const run = correctnessFixture();
  mutate(run.pixelControl);
  assert.equal(positivePixelControl(run.pixelControl), false);
  assert.equal(pixelGate(run).status, "fail");
  const linked = linkCaptures(performanceFixture(), run);
  assert.equal(linked.evaluation.hardStatus, "fail");
});

test("old expanded-like proof is missing evidence, not a newly classified hole", () => {
  const run = correctnessFixture();
  run.pixelControl = { status: "pass", positiveSurface: false, changedChannels: 1147528,
    restoredChannels: 0, glError: 0, nonzeroChannels: 1104721, draws: 17, poseKey: "settled-route" };
  assert.equal(pixelGate(run).status, "fail");
  assert.equal(evaluateRun(run).hard.find(g => g.name === "sampled visible missing surfaces").actual, 0);
});

test("old prelinked records cannot bypass the proof schema in comparison", () => {
  const before = Array.from({ length: 3 }, () => linkedFixture("baseline", 10));
  const after = Array.from({ length: 3 }, () => linkedFixture("candidate", 8));
  assert.equal(compareTrials(before, after).accepted, true);
  delete after[0].correctnessEvidence.pixelControl;
  assert.equal(compareTrials(before, after).accepted, false);
});

test("runner and linker CLIs reject stale claimed-pass proof without rewriting its input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-proof-cli-"));
  const correctness = correctnessFixture(), performance = performanceFixture();
  correctness.pixelControl.positiveSurface = false;
  const encoded = JSON.stringify(correctness);
  await writeFile(join(root, "correctness.json"), encoded);
  await writeFile(join(root, "performance.json"), JSON.stringify(performance));
  const env = { ...process.env };
  delete env.BENCH_DIAGNOSTIC_ONLY;
  assert.throws(() => execFileSync(process.execPath, ["test/render-benchmark/run.mjs",
    "--check-result", join(root, "correctness.json")], { env, stdio: "pipe" }), error => error.status === 1);
  assert.throws(() => execFileSync(process.execPath, ["test/render-benchmark/link.mjs",
    join(root, "performance.json"), join(root, "correctness.json"), join(root, "linked")],
  { env, stdio: "pipe" }), error => error.status === 1);
  assert.equal(await readFile(join(root, "correctness.json"), "utf8"), encoded);
});
