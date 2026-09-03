import { BLOCK_CATALOG, BLOCKS } from "../../src/blocks.js";
import {
  casesFor,
  CATALOG_GROUPS,
  groupFor,
  LIGHTS,
  PAGE_SIZE,
} from "./cases.js";

export const DEFAULT_SEED = "mineslop-block-art-v1";
const option = (value, allowed, name) => {
  if (!allowed.includes(value)) throw new RangeError(`Invalid ${name}: ${value}`);
  return value;
};

export function readSelection(input = {}) {
  const group = input.group ?? "all";
  option(group, ["all", ...CATALOG_GROUPS], "group");
  const set = option(input.set ?? "catalog", ["catalog", "states"], "set");
  const labels = option(input.labels ?? "labeled", ["labeled", "blind"], "labels");
  const light = option(input.light ?? "day", LIGHTS, "light");
  const page = Number(input.page ?? 0);
  if (!Number.isSafeInteger(page) || page < 0) throw new RangeError("Invalid page");
  const seed = input.seed ?? DEFAULT_SEED;
  if (typeof seed !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(seed))
    throw new RangeError("Seed must have 1–64 letters, digits, underscores or hyphens");
  let ids = null;
  if (input.ids !== undefined && input.ids !== null) {
    const raw = Array.isArray(input.ids) ? input.ids : String(input.ids).split(",");
    ids = raw.map((id) => typeof id === "number" ? id : /^\d+$/.test(id) ? Number(id) : NaN);
    if (
      ids.length === 0 || ids.length > PAGE_SIZE ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isSafeInteger(id) || !BLOCKS[id])
    ) throw new RangeError(`ids must contain 1–${PAGE_SIZE} distinct catalog IDs`);
    if (group !== "all") throw new RangeError("Use group or ids, not both");
  }
  return { group, set, labels, light, page, seed, ids };
}

function shuffle(entries, seed) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  const result = [...entries];
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function selectedCases(selection) {
  const blocks = BLOCK_CATALOG.filter((block) =>
    selection.ids ? selection.ids.includes(block.id) :
      selection.group === "all" || groupFor(block) === selection.group);
  return blocks.flatMap(({ id }) => {
    const cases = casesFor(id);
    return selection.set === "catalog" ? cases.slice(0, 1) : cases.slice(1);
  });
}

export function sheetPlan(input = {}) {
  const selection = readSelection(input);
  // Both label modes use the same seeded permutation. Blind images never contain
  // IDs, material names, case names, group names or ID-derived sample tokens.
  const all = shuffle(selectedCases(selection), selection.seed);
  const pages = Math.ceil(all.length / PAGE_SIZE);
  if (selection.page >= pages)
    throw new RangeError(`Page ${selection.page} outside ${pages} available pages`);
  const cases = all.slice(selection.page * PAGE_SIZE, (selection.page + 1) * PAGE_SIZE);
  return {
    selection,
    pages,
    totalCases: all.length,
    cases: cases.map((reviewCase, index) => ({
      ...reviewCase,
      token: `Sample ${String.fromCharCode(65 + index)}`,
    })),
  };
}

export function pageCounts(input = {}) {
  const selection = readSelection(input);
  return Math.ceil(selectedCases(selection).length / PAGE_SIZE);
}

export function captureQueue({ group = "all", ids = null, seed = DEFAULT_SEED } = {}) {
  const result = [];
  for (let page = 0; page < pageCounts({ group, ids }); page++)
    result.push({ group, ids, seed, set: "catalog", labels: "blind", light: "day", page });
  for (const light of LIGHTS)
    for (let page = 0; page < pageCounts({ group, ids }); page++)
      result.push({ group, ids, seed, set: "catalog", labels: "labeled", light, page });
  for (let page = 0; page < pageCounts({ group, ids, set: "states" }); page++)
    result.push({ group, ids, seed, set: "states", labels: "labeled", light: "day", page });
  return result;
}
