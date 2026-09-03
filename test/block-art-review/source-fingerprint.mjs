import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:js|mjs|css|html)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

/** Conservative invalidation: any production or harness code edit needs fresh evidence.
 * Review prose/decisions are excluded, so adding a review cannot invalidate itself.
 */
export async function sourceFingerprint(root = ROOT) {
  const paths = [
    ...await sources(resolve(root, "src")),
    ...await sources(resolve(root, "test/block-art-review")),
    resolve(root, "package.json"),
    resolve(root, "package-lock.json"),
  ].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function buildIdentity() {
  return {
    sourceFingerprint: await sourceFingerprint(),
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", [
      "status", "--porcelain", "--", "src", "test/block-art-review", "package.json", "package-lock.json",
    ], { cwd: ROOT, encoding: "utf8" }).trim()),
  };
}
