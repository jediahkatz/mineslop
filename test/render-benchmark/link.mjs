import { mkdir, readFile, writeFile } from "node:fs/promises";
import { linkCaptures, exitCodeFor } from "./acceptance.js";
const [timingFile, correctnessFile, output] = process.argv.slice(2);
if (!timingFile || !correctnessFile || !output)
  throw new Error("Usage: node test/render-benchmark/link.mjs PERFORMANCE.json CORRECTNESS.json NEW_OUTPUT_DIRECTORY");
const load = async path => JSON.parse(await readFile(path, "utf8"));
const linked = linkCaptures(await load(timingFile), await load(correctnessFile));
await mkdir(output);
await writeFile(`${output}/run.json`, JSON.stringify(linked, null, 2));
await writeFile(`${output}/summary.txt`, JSON.stringify({
  timingFile, correctnessFile, link: linked.captureLink, hardStatus: linked.evaluation.hardStatus,
  timingQualification: linked.timingQualification,
}, null, 2) + "\n");
console.log(`${output}: hardStatus=${linked.evaluation.hardStatus}; link=${linked.captureLink.matched}`);
process.exitCode = exitCodeFor(linked);
