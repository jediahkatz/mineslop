// Bound the whole child process, including module imports and native generation.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const hardSeconds = Number(process.env.NATIVE_HARD_SECONDS ?? 230);
const internalSeconds = Number(process.env.NATIVE_WALL_SECONDS ?? 170);
if (!Number.isInteger(hardSeconds) || hardSeconds < 1 || hardSeconds > 600 ||
    !Number.isInteger(internalSeconds) || internalSeconds < 1 || internalSeconds >= hardSeconds)
  throw new RangeError("Require 1 <= internal deadline < hard deadline <= 600 seconds");
const prefix = process.env.NATIVE_PROVENANCE ??
  `/opt/cursor/artifacts/native_geometry_${Date.now()}`;
await mkdir(dirname(prefix), { recursive: true });
async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (/\.[cm]?js$/.test(entry.name)) result.push(path);
  }
  return result;
}
const paths = [...await sources(join(root, "src")),
  ...["regional-native-geometry.run.mjs", "regional-native-geometry.measure.mjs",
    "regional-native-fixture.js", "shape-fixture.js"].map((name) => join(root, "test", name))].sort();
async function hashes() {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => {
    const bytes = await readFile(path);
    return [relative(root, path), {
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
    }];
  })));
}
const start = await hashes();
const metadata = { startedAt: new Date().toISOString(), node: process.version,
  root, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  hardSeconds, internalSeconds,
  nativeEnvironment: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("NATIVE_"))),
  caveat: "Start/end hashes detect concurrent disk edits; these are not an ESM loaded-source trace. Timings are shared-host CPU capacity observations.",
};
await writeFile(`${prefix}_start.json`, JSON.stringify({ ...metadata, files: start }, null, 2));
console.error(JSON.stringify({ event: "native-provenance", path: `${prefix}_start.json`, ...metadata }));
const child = spawn(process.execPath, [join(root, "test/regional-native-geometry.measure.mjs")],
  { cwd: root, env: process.env, stdio: "inherit" });
let timedOut = false, killTimer;
const deadline = setTimeout(() => {
  timedOut = true;
  console.error(JSON.stringify({ event: "native-hard-deadline", hardSeconds, pid: child.pid,
    cause: "Whole-process deadline (imports, generation and measurement); last child progress is authoritative" }));
  child.kill("SIGTERM");
  killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
}, hardSeconds * 1000);
const outcome = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ error: error.message }));
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(deadline);
clearTimeout(killTimer);
const end = await hashes();
const changedOnDisk = Object.keys(start).filter((path) => start[path].sha256 !== end[path]?.sha256);
const result = { ...metadata, endedAt: new Date().toISOString(), ...outcome, timedOut, changedOnDisk };
await writeFile(`${prefix}_end.json`, JSON.stringify({ ...result, files: end }, null, 2));
console.error(JSON.stringify({ event: "native-process-result", ...result, path: `${prefix}_end.json` }));
process.exitCode = timedOut ? 124 : outcome.code ?? 1;
