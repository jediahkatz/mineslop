import { readFile } from "node:fs/promises";
import { compareTrials } from "./comparison.js";
const args = process.argv.slice(2), split = args.indexOf("--");
if (split < 1 || split === args.length - 1)
  throw new Error("Usage: node test/render-benchmark/compare.mjs base1.json base2.json base3.json -- candidate1.json candidate2.json candidate3.json");
const load = paths => Promise.all(paths.map(async path => JSON.parse(await readFile(path, "utf8"))));
const result = compareTrials(await load(args.slice(0, split)), await load(args.slice(split + 1)));
console.log(JSON.stringify(result, null, 2));
if (!result.accepted) process.exitCode = 1;
