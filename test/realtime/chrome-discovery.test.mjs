import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromeExecutable } from "./config.mjs";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "mineslop-browser-discovery-"));
  t.after(() => rm(root, { recursive: true }));
  return root;
}

test("executable shell launchers are refused before they can force a shared browser profile", async (t) => {
  const root = await directory(t), wrapper = join(root, "chrome-wrapper");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o700 });
  await assert.rejects(chromeExecutable(wrapper), /direct.*binary/);
  const alias = join(root, "chrome-alias");
  await symlink(wrapper, alias);
  await assert.rejects(chromeExecutable(alias), /direct.*binary/);
});

test("discovery resolves a native executable without launching it; runtime identity needs separate verification", async (t) => {
  const root = await directory(t), alias = join(root, "native-executable");
  await symlink(process.execPath, alias);
  assert.equal(await chromeExecutable(alias), await realpath(process.execPath));
});

test("missing paths, directories and text without a shebang are not native browser binaries", async (t) => {
  const root = await directory(t), text = join(root, "not-a-binary");
  await writeFile(text, "not executable machine code", { flag: "wx", mode: 0o700 });
  for (const path of [root, text, join(root, "missing")])
    await assert.rejects(chromeExecutable(path), /direct.*binary/);
});
