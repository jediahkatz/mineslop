import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("actual Game weather staging, lifecycle, rendering and shared rain audio", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, [
    "--experimental-test-module-mocks", "--test", "--test-reporter=tap",
    new URL("./weather-game.cases.mjs", import.meta.url).pathname,
  ], { encoding: "utf8", timeout: 120000, env });
  assert.match(output, /^# tests 13$/m);
  assert.match(output, /^# pass 13$/m);
  process.stdout.write(output);
});
