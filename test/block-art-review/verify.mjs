import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseManifest, reviewAudit } from "./coverage.js";
import { ROOT, sourceFingerprint } from "./source-fingerprint.mjs";

const { values } = parseArgs({
  options: { "require-complete": { type: "boolean", default: false } },
});
const rows = parseManifest(await readFile(resolve(ROOT, "docs/block-art-review.md"), "utf8"));
const decisions = JSON.parse(await readFile(resolve(ROOT, "test/block-art-review/reviews.json"), "utf8"));
const captures = new Map();
const errors = [];
const paths = new Set((decisions.records ?? []).flatMap((record) => record.captures ?? []));
if (paths.size > 4096) throw new Error("Capture reference budget exceeded");
for (const path of paths) {
  try {
    if (!isAbsolute(path)) throw new Error("Capture reference must be an absolute artifact path");
    if ((await stat(path)).size > 2_000_000) throw new Error("Capture receipt exceeds 2 MB");
    const capture = JSON.parse(await readFile(path, "utf8"));
    if (capture.artifact?.path !== "sheet.png") throw new Error("Unexpected artifact filename");
    const pngPath = resolve(dirname(path), capture.artifact.path);
    if ((await stat(pngPath)).size > 20_000_000) throw new Error("Sheet exceeds 20 MB");
    const png = await readFile(pngPath);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("Artifact is not a PNG");
    if (createHash("sha256").update(png).digest("hex") !== capture.artifact.sha256)
      throw new Error("Artifact hash mismatch");
    if (
      png.readUInt32BE(16) !== capture.artifact.width ||
      png.readUInt32BE(20) !== capture.artifact.height ||
      capture.artifact.width !== 1472 || capture.artifact.height < 500
    ) throw new Error("Artifact dimensions differ from the full-size plate");
    captures.set(path, { ...capture, verifiedArtifact: true });
  } catch (error) {
    errors.push(`${path}: ${error.message}`);
  }
}
const result = reviewAudit(rows, decisions, captures, await sourceFingerprint());
result.errors.push(...errors);
result.complete &&= result.errors.length === 0;
result.outstandingIds = rows.filter(({ status }) => status !== "approved").map(({ id }) => id);
console.log(JSON.stringify(result, null, 2));
if (result.errors.length || (values["require-complete"] && !result.complete))
  process.exitCode = 1;
