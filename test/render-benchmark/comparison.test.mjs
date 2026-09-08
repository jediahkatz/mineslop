import test from "node:test";
import assert from "node:assert/strict";
import { compareTrials } from "./comparison.js";
import { linkedFixture } from "./audit-fixtures.js";

function runs(mesh = 10) {
  return Array.from({ length: 3 }, () => linkedFixture("fixture-source", mesh));
}
test("paired acceptance requires repeated improvement with no correctness tradeoff", () => {
  assert.equal(compareTrials(runs(), runs(8)).accepted, true);
  assert.equal(compareTrials(runs(), runs()).accepted, false);
  assert.equal(compareTrials(runs().slice(0, 1), runs(8).slice(0, 1)).accepted, false);
  for (const mutate of [
    r => { r.evaluation.hardStatus = "fail"; },
    r => { r.evaluation.hardStatus = "incomplete"; },
    r => { r.statistics.frames.p95 = 30; },
    r => { r.edit.publicationMs = 500; },
    r => { r.machine.softwareRenderer = false; },
    r => { r.provenance.harnessHash = "changed"; },
    r => { r.samples[0].position[0] = 4; },
    r => { r.provenanceStable = false; },
  ]) {
    const candidate = runs(8); mutate(candidate[1]);
    assert.equal(compareTrials(runs(), candidate).accepted, false, mutate.toString());
  }
});
