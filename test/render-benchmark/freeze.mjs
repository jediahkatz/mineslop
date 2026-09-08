// Freeze a test-only checkout outside the shared worktree. No branch/ref moves.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, sealManifest } from "./provenance.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dest = await mkdtemp("/tmp/mineslop-frozen-");
const ref = process.env.BENCH_SOURCE_REF;
if (!ref && process.env.BENCH_SOURCE_WORKTREE !== "1")
  throw new Error("Specify BENCH_SOURCE_REF or explicitly opt into all dirty inputs with BENCH_SOURCE_WORKTREE=1");
if (!ref && process.env.BENCH_SOURCE_PATCH)
  throw new Error("BENCH_SOURCE_PATCH requires an explicit BENCH_SOURCE_REF");
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 ** 2 });
const sha = git("rev-parse", ref ?? "HEAD").toString().trim();
const initialDiff = git("diff", "--binary", "HEAD", "--", "src", "public", "package.json", "package-lock.json").toString();
if (ref) {
  const archive = git("archive", sha, "src", "public", "package.json", "package-lock.json");
  execFileSync("tar", ["-x", "-C", dest], { input: archive });
  if (process.env.BENCH_SOURCE_PATCH)
    execFileSync("git", ["apply", resolve(process.env.BENCH_SOURCE_PATCH)], { cwd: dest });
} else {
  for (const name of ["src", "public", "package.json", "package-lock.json"])
    await cp(resolve(root, name), resolve(dest, name), { recursive: true });
}
await mkdir(`${dest}/test/realtime`, { recursive: true });
await cp(`${root}/test/render-benchmark`, `${dest}/test/render-benchmark`, { recursive: true });
await cp(`${root}/test/lighting-physical-geometry.js`, `${dest}/test/lighting-physical-geometry.js`);
for (const name of ["statistics.js", "config.mjs", "input.mjs"])
  await cp(`${root}/test/realtime/${name}`, `${dest}/test/realtime/${name}`);
await symlink(`${root}/node_modules`, `${dest}/node_modules`);
async function walk(path = "src") {
  const files = [];
  for (const entry of await readdir(`${dest}/${path}`, { withFileTypes: true }))
    if (entry.isDirectory()) files.push(...await walk(`${path}/${entry.name}`));
    else files.push(`${path}/${entry.name}`);
  return files;
}
const manifest = {
  sha, branch: `frozen-${ref ?? "worktree"}`, files: [
    ...await walk(), ...await walk("public"), "package.json", "package-lock.json", "test/lighting-physical-geometry.js",
    "test/realtime/statistics.js", "test/realtime/config.mjs", "test/realtime/input.mjs",
  ],
  dirtyDiff: ref ? (process.env.BENCH_SOURCE_PATCH ? await readFile(process.env.BENCH_SOURCE_PATCH, "utf8") : "") :
    initialDiff,
  status: "immutable test snapshot; dependencies symlinked, resolved versions recorded by runner",
};
if (!ref && (initialDiff !== git("diff", "--binary", "HEAD", "--", "src", "public", "package.json", "package-lock.json").toString() ||
    sha !== git("rev-parse", "HEAD").toString().trim()))
  throw new Error("Worktree changed while freezing; retry after its owner finishes");
await writeFile(`${dest}/.benchmark-source.json`, JSON.stringify(manifest, null, 2));
const sourceFiles = [...manifest.files, ...await walk("test/render-benchmark")].sort();
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name =>
  [name, digest(await readFile(`${dest}/${name}`))])));
if (!ref) {
  for (const name of manifest.files.filter(name => !name.startsWith("test/")))
    if (digest(await readFile(`${root}/${name}`)) !== hashes[name])
      throw new Error(`Worktree input changed while freezing: ${name}`);
  const baseFiles = new Set(git("ls-tree", "-r", "--name-only", sha, "--", "src", "public").toString().trim().split("\n"));
  manifest.extraFilesBase64 = Object.fromEntries(await Promise.all(
    manifest.files.filter(name => /^(src|public)\//.test(name) && !baseFiles.has(name))
      .map(async name => [name, (await readFile(`${dest}/${name}`)).toString("base64")])));
  await writeFile(`${dest}/.benchmark-source.json`, JSON.stringify(manifest, null, 2));
}
const sourceRef = sha, patchHash = digest(manifest.dirtyDiff);
const sourceIdentity = digest(JSON.stringify({
  sourceRef, patchHash, sourceHashes: Object.entries(hashes).filter(([name]) => !name.startsWith("test/")),
}));
// Build once, then serve immutable bytes. The independent URL cannot silently
// substitute another checkout's code for this manifest.
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build",
  "--config", "test/render-benchmark/vite.config.mjs"], { cwd: dest, stdio: "inherit" });
const assetNames = await walk("dist-render-benchmark");
const assets = Object.fromEntries(await Promise.all(assetNames.sort().map(async name =>
  [name.slice("dist-render-benchmark/".length), digest(await readFile(`${dest}/${name}`))])));
const bundle = sealManifest({
  schemaVersion: 3, sourceIdentity, sourceRef, patchHash,
  sourceMode: ref ? (process.env.BENCH_SOURCE_PATCH ? "explicit-ref-plus-patch" : "clean-ref") : "explicit-worktree-snapshot",
  sourceHash: digest(JSON.stringify(hashes)), hashes,
  harnessHash: digest(JSON.stringify(Object.entries(hashes).filter(([name]) => name.startsWith("test/")))),
  assets,
});
await writeFile(`${dest}/.benchmark-bundle.json`, JSON.stringify(bundle, null, 2));
console.log(dest);
console.log(`Serve: cd ${dest} && BENCH_PORT=6788 node test/render-benchmark/serve.mjs`);
console.log(`Run: cd ${dest} && VOXELCRAFT_TEST_URL=http://127.0.0.1:6788/mineslop/ node test/render-benchmark/run.mjs`);
