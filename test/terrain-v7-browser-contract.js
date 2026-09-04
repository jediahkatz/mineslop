import { readChunkCell } from "../src/chunk-data.js";
import { createGenerator } from "../src/terrain.js";
import { describeV7Structure } from "../src/terrain-v7-manifest.js";

export function check(condition, message) {
  if (!condition) throw new Error(message);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function sameJSON(actual, expected, label) {
  check(JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)), label);
}
export function samePlane(actual, expected, label) {
  check(actual?.constructor === expected?.constructor && actual?.length === expected?.length, `${label} encoding/length`);
  if (!actual) return;
  for (let i = 0; i < actual.length; i++)
    check(actual[i] === expected[i], `${label} cell ${i}`);
}
export function sameNativeChunk(actual, expected) {
  for (const key of ["cx", "cz", "minY", "maxY"])
    check(actual[key] === expected[key], `chunk ${key}`);
  samePlane(actual.blocks, expected.blocks, "blocks");
  samePlane(actual.biomes, expected.biomes, "biomes");
  check(actual.sections.size === expected.sections.size, "section sparsity");
  for (const [sy, section] of expected.sections) {
    const got = actual.sections.get(sy);
    check(got?.sy === sy, "section coordinate");
    samePlane(got.states, section.states, `${sy}/states`);
    samePlane(got.fluids, section.fluids, `${sy}/fluids`);
  }
  for (let i = 0; i < actual.blocks.length; i++) {
    const a = readChunkCell(actual, i), b = readChunkCell(expected, i);
    check(a.id === b.id && a.state === b.state && a.fluid === b.fluid, `effective cell ${i}`);
  }
  sameJSON(actual.structures, expected.structures, "full declarations and markers");
}
export const browserJob = (seed, dimension, version, cx, cz, id, epoch = 17) => ({
  type: "generate", schemaVersion: 2, id, epoch, seed, dimension,
  generatorVersion: version, cx, cz,
  minY: dimension === "overworld" && version >= 4 ? -64 : 0,
  maxY: version >= 4 ? (dimension === "overworld" ? 320 : 256) : 96,
});

// Exactly five native cases, derived only from the compiled production factory.
// Fixed owner coordinates avoid unbounded locator scans or runtime golden capture.
export function v7BrowserCases() {
  const seed = "cedar-valley", end = createGenerator(seed, "end", 7);
  const cases = [0, 5].map((id) => {
    const pillar = end.getEndPillars()[id];
    return { label: `pillar${id}`, seed, dimension: "end", x: pillar.x, z: pillar.z, pillar };
  });
  const bowl = end.getEndTerrainPlan().bowls[0];
  cases.push({ label: "bowl", seed, dimension: "end", x: bowl.x, z: bowl.z });
  for (const [dimension, kind, gx, gz] of [
    ["overworld", "shipwreck", -19, -22],
    ["nether", "nether_fortress", -22, -24],
  ]) {
    const gen = createGenerator(seed, dimension, 7);
    const descriptor = describeV7Structure(kind, {
      seed, dimension, generatorVersion: 7, spec: gen.spec, sampleColumn: gen.sampleColumn,
    }, gx, gz);
    check(descriptor, `missing native ${kind}`);
    const marker = descriptor.markers.find((entry) => entry.type === "container");
    check(marker, `missing native ${kind} marker`);
    cases.push({ label: kind, seed, dimension, x: marker.position.x, z: marker.position.z,
      structureId: descriptor.id, marker });
  }
  return cases.map((entry) => ({ ...entry, cx: Math.floor(entry.x / 16), cz: Math.floor(entry.z / 16) }));
}
