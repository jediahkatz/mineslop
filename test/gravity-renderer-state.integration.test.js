import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("real Game frames publish coherent gravity, daylight and indexed LOD coverage", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, [
    "--experimental-test-module-mocks", "--test", "--test-reporter=tap",
    new URL("./gravity-renderer-state.cases.mjs", import.meta.url).pathname,
  ], { encoding: "utf8", timeout: 120000, env });
  assert.match(output, /^# tests 3$/m);
  assert.match(output, /^# pass 3$/m);
  process.stdout.write(output);
});
