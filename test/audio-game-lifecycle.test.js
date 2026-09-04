import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

// Module mocks replace browser presentation, never Game/Player/audio lifecycle.
test("live Game audio lifecycle with headless browser transports", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, [
    "--experimental-test-module-mocks", "--test", "--test-reporter=tap",
    new URL("./audio-game-lifecycle.cases.mjs", import.meta.url).pathname,
  ], { encoding: "utf8", timeout: 45000, env });
  assert.match(output, /^# tests 5$/m, "all five real Game cases must execute");
  assert.match(output, /^# pass 5$/m);
  process.stdout.write(output);
});
