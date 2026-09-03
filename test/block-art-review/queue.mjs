import { parseArgs } from "node:util";
import { BLOCK_CATALOG } from "../../src/blocks.js";
import { CATALOG_GROUPS, casesFor, groupFor } from "./cases.js";
import { captureQueue, readSelection } from "./plan.js";

const { values } = parseArgs({
  options: {
    group: { type: "string" },
    ids: { type: "string" },
    seed: { type: "string" },
  },
});
const selection = readSelection(values);
const queue = captureQueue(selection);
console.log(JSON.stringify({
  catalogCount: BLOCK_CATALOG.length,
  reviewCaseCount: BLOCK_CATALOG.reduce((count, { id }) => count + casesFor(id).length, 0),
  groups: CATALOG_GROUPS.map((group) => ({
    group,
    ids: BLOCK_CATALOG.filter((block) => groupFor(block) === group).map(({ id }) => id),
  })),
  sheetCount: queue.length,
  // This command plans only; it never launches browsers or marks blocks reviewed.
  queue,
}, null, 2));
