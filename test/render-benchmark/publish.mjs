// Publish already-completed local captures; never append while measuring.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) throw new Error("Usage: node test/render-benchmark/publish.mjs LOCAL_CAPTURE NEW_ARTIFACT_DIRECTORY");
const source = resolve(sourceArg), destination = resolve(destinationArg);
await mkdir(destination);
const priority = ["summary.txt", "run.log", "run.json", "provenance-before.json", "provenance-after.json"];
const names = await readdir(source);
names.sort((a, b) => (priority.indexOf(a) < 0 ? 100 : priority.indexOf(a)) -
  (priority.indexOf(b) < 0 ? 100 : priority.indexOf(b)));
for (const name of names) {
  if (!/\.(json|jsonl|txt|log|patch|png)$/.test(name)) continue;
  const contents = await readFile(`${source}/${name}`);
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(`${destination}/${name}`, contents);
      break;
    } catch (error) {
      if (attempt >= 2 || !["EIO", "ECONNABORTED"].includes(error.code)) throw error;
      await delay(1000 * (attempt + 1));
    }
  }
}
console.log(destination);
