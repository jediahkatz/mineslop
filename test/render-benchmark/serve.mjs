import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname, extname } from "node:path";
import { digest, verifyManifest } from "./provenance.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(await readFile(`${root}/.benchmark-bundle.json`, "utf8"));
verifyManifest(manifest);
const assets = new Map();
for (const [name, hash] of Object.entries(manifest.assets)) {
  const bytes = await readFile(`${root}/dist-render-benchmark/${name}`);
  if (digest(bytes) !== hash) throw new Error(`Frozen file changed: ${name}`);
  assets.set(`/mineslop/${name}`, bytes);
}
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const bytes = path === "/mineslop/__benchmark_manifest.json" ? Buffer.from(JSON.stringify(manifest)) : assets.get(path);
  if (!bytes) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Cache-Control": "no-store", "X-Benchmark-Manifest": manifest.manifestHash });
  res.end(bytes);
}).listen(Number(process.env.BENCH_PORT ?? 6788), "127.0.0.1", () => {
  console.log(`Frozen benchmark ${manifest.manifestHash} on port ${process.env.BENCH_PORT ?? 6788}`);
});
