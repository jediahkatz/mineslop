import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { correctnessFixture, performanceFixture, linkedFixture } from "./audit-fixtures.js";

const cli = (name, args, env = {}) => spawnSync(process.execPath,
  [fileURLToPath(new URL(name, import.meta.url)), ...args], {
    encoding: "utf8", timeout: 15000, maxBuffer: 1024 ** 2,
    env: { ...process.env, BENCH_DIAGNOSTIC_ONLY: "0", ...env },
  });

test("actual runner CLI is fail-closed for failed/incomplete gates; opt-in diagnostic success is explicit", async t => {
  const dir = await mkdtemp(join(tmpdir(), "benchmark-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "record.json");
  const check = async run => {
    await writeFile(path, JSON.stringify(run));
    return cli("run.mjs", ["--check-result", path]);
  };
  let output = await check(correctnessFixture());
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).hardStatus, "pass");
  const incomplete = correctnessFixture(); incomplete.samples[0].mask.checks = 0;
  output = await check(incomplete);
  assert.equal(output.status, 1, output.stderr);
  assert.equal(JSON.parse(output.stdout).hardStatus, "incomplete");
  const failed = correctnessFixture(); failed.samples[0].resources.gpuBytes = 2 ** 30;
  output = await check(failed);
  assert.equal(output.status, 1, output.stderr);
  assert.equal(JSON.parse(output.stdout).hardStatus, "fail");
  assert.equal(cli("run.mjs", ["--check-result", path], { BENCH_DIAGNOSTIC_ONLY: "1" }).status, 0);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), failed, "validation preserves the original capture");
});

test("actual compare CLI parses and accepts valid controls, rejects mixed sources and legacy timings", async t => {
  const dir = await mkdtemp(join(tmpdir(), "benchmark-compare-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = [], after = [];
  for (const [group, paths, mesh] of [["baseline", before, 10], ["candidate", after, 8]])
    for (let i = 0; i < 3; i++) {
      const path = join(dir, `${group}-${i}.json`);
      paths.push(path); await writeFile(path, JSON.stringify(linkedFixture(group, mesh)));
    }
  let output = cli("compare.mjs", [...before, "--", ...after]);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).accepted, true);
  for (let i = 0; i < 3; i++)
    await writeFile(after[i], JSON.stringify(linkedFixture(`mixed-${i}`, 8)));
  output = cli("compare.mjs", [...before, "--", ...after]);
  assert.equal(output.status, 1, output.stderr);
  assert.match(JSON.parse(output.stdout).reasons.join("\n"), /mixed/);
  for (const path of after) {
    const legacy = linkedFixture("candidate", 8); delete legacy.measurementVersion;
    await writeFile(path, JSON.stringify(legacy));
  }
  output = cli("compare.mjs", [...before, "--", ...after]);
  assert.equal(output.status, 1, output.stderr);
  assert.match(JSON.parse(output.stdout).reasons.join("\n"), /legacy/);
});

test("link CLI preserves a failed capture as an artifact and refuses overwrite", async t => {
  const dir = await mkdtemp(join(tmpdir(), "benchmark-link-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const perf = join(dir, "performance.json"), correctness = join(dir, "correctness.json"), output = join(dir, "linked");
  await writeFile(perf, JSON.stringify(performanceFixture()));
  const failed = correctnessFixture(); failed.controlErrors.push("deliberate lifecycle error");
  await writeFile(correctness, JSON.stringify(failed));
  assert.equal(cli("link.mjs", [perf, correctness, output]).status, 1);
  assert.equal(JSON.parse(await readFile(join(output, "run.json"), "utf8")).evaluation.hardStatus, "fail");
  assert.match(cli("link.mjs", [perf, correctness, output]).stderr, /EEXIST/);
});
