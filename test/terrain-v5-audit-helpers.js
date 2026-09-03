import assert from "node:assert/strict";
import { BIOMES } from "../src/biomes.js";
import { BLOCK as B, isSolid } from "../src/blocks.js";
import { squareSpiral } from "../src/noise.js";

export const AUDIT_SEEDS = Object.freeze([
  "cedar-valley", "mineslop-audit-1", "mineslop-audit-2",
  "mineslop-audit-3", "0", "-2147483648",
]);
export const AUDIT_POINTS = Object.freeze([
  [0, 0], [-512, -512], [512, 512], [1792, -2048],
  [-3584, 3328], [8192, -9216], [131072, -65536], [-196608, 262144],
]);
export const ORE_NAMES = Object.freeze([
  "coal", "iron", "copper", "gold", "diamond", "redstone", "emerald", "lapis",
  "nether_quartz", "nether_gold", "ancient_debris",
]);
const mineral = new Map(), host = new Map([
  [B.STONE, "stone"], [B.DEEPSLATE, "deepslate"],
  [B.NETHERRACK, "nether_rock"], [B.BLACKSTONE, "nether_rock"],
]);
for (const [i, name] of ORE_NAMES.entries()) {
  const key = name === "ancient_debris" ? "ANCIENT_DEBRIS" : `${name.toUpperCase()}_ORE`;
  mineral.set(B[key], name);
  host.set(B[key], i < 8 ? "stone" : "nether_rock");
  if (i < 8) {
    mineral.set(B[`DEEPSLATE_${key}`], name);
    host.set(B[`DEEPSLATE_${key}`], "deepslate");
  }
}
const count = (map, key, n = 1) => { map[key] = (map[key] ?? 0) + n; };
const emptyRow = () => ({ host: 0, ores: Object.fromEntries(ORE_NAMES.map((name) => [name, 0])) });
const row = (map, key, ore) => {
  const result = map[key] ??= emptyRow();
  result.host++;
  if (ore) result.ores[ore]++;
};

export function findAuditTargets(generator, { radius = 64, spacing = 96 } = {}) {
  assert.ok(radius <= 64 && spacing >= 32);
  const found = new Map();
  const expected = generator.dimension === "nether"
    ? ["nether_wastes", "soul_sand_valley", "crimson_forest", "warped_forest", "basalt_deltas"]
    : ["ordinary", "mountain", "badlands", "dripstone", "lush", "deep_ocean"];
  let samples = 0;
  for (const [dx, dz] of squareSpiral(radius)) {
    samples++;
    const x = dx * spacing + 7, z = dz * spacing + 11;
    const col = generator.sampleColumn(x, z), biome = generator.getBiome(x, z);
    const ordinary = ["forest", "grassland", "taiga"].includes(biome.category);
    const targets = generator.dimension === "nether" ? [col.id] : [
      ordinary && col.top >= 80 && col.mountain < 0.4 && "ordinary",
      col.top >= 145 && col.mountain > 0.45 && col.surface === B.STONE && "mountain",
      biome.category === "badlands" && col.top >= 85 && "badlands",
      ordinary && col.top >= 80 && col.mountain < 0.4 &&
        generator.getBiome(x, z, 48).id === "dripstone_caves" && "dripstone",
      ordinary && col.top >= 80 && col.mountain < 0.4 &&
        generator.getBiome(x, z, 48).id === "lush_caves" && "lush",
      biome.category === "ocean" && col.top <= 0 && "deep_ocean",
    ];
    for (const target of targets)
      if (target && !found.has(target)) found.set(target, {
        label: target, x: Math.floor(x / 16) * 16, z: Math.floor(z / 16) * 16,
      });
    if (expected.every((target) => found.has(target))) break;
  }
  return {
    points: [...found.values()], samples,
    missing: expected.filter((target) => !found.has(target)),
  };
}

/**
 * Four REAL generated chunks, plus four one-cell actual-region halo strips.
 * No substituted ore probabilities, fake stone slabs, player edits, or loot.
 * Complete connected components exclude the x/z boundary; censored components
 * are counted separately. Exposure is cardinal air/fluid, not reachability.
 */
export function auditOrePatch(generator, { x: minX, z: minZ }) {
  const { minY, maxY } = generator, height = maxY - minY, side = 34, layer = side ** 2;
  const blocks = new Uint16Array(layer * height), skyline = new Int16Array(layer).fill(minY - 1);
  const biomes = new Uint8Array(layer);
  const at = (x, y, z) => (y - minY) * layer + z * side + x;
  const paste = (part, x, z, width, depth) => {
    assert.equal(part.blocks.length, width * depth * height);
    for (let y = 0; y < height; y++) for (let dz = 0; dz < depth; dz++) {
      const start = y * width * depth + dz * width;
      blocks.set(part.blocks.subarray(start, start + width), y * layer + (z + dz) * side + x);
    }
  };
  const result = {
    chunks: 4, volume: 0, solid: 0, ...emptyRow(),
    perChunk: [], byBand: {}, byBiomeBand: {}, byCaveBand: {}, byHost: {},
    byExposure: {}, byExposureBand: {}, byDepth: {}, byNetherDomain: {}, biomeColumns: {},
    groups: Object.fromEntries(ORE_NAMES.map((name) => [name, { complete: {}, censored: {} }])),
    actualHostMismatches: 0, naturalAirDebris: 0, naturalChecks: 0,
  };
  for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
    const chunk = generator.generateChunk(minX / 16 + dx, minZ / 16 + dz);
    paste(chunk, dx * 16 + 1, dz * 16 + 1, 16, 16);
    const counts = Object.fromEntries(ORE_NAMES.map((name) => [name, 0]));
    for (const id of chunk.blocks) if (mineral.has(id)) counts[mineral.get(id)]++;
    result.perChunk.push(counts);
  }
  paste(generator.generateRegion(minX - 1, minZ - 1, 34, 1), 0, 0, 34, 1);
  paste(generator.generateRegion(minX - 1, minZ + 32, 34, 1), 0, 33, 34, 1);
  paste(generator.generateRegion(minX - 1, minZ, 1, 32), 0, 1, 1, 32);
  paste(generator.generateRegion(minX + 32, minZ, 1, 32), 33, 1, 1, 32);
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    biomes[z * side + x] = BIOMES.indexOf(generator.getBiome(minX + x - 1, minZ + z - 1));
    for (let y = maxY - 1; y >= minY; y--) if (isSolid(blocks[at(x, y, z)])) {
      skyline[z * side + x] = y;
      break;
    }
  }
  const oreCells = [];
  for (let z = 1; z <= 32; z++) for (let x = 1; x <= 32; x++) {
    const wx = minX + x - 1, wz = minZ + z - 1, ci = z * side + x;
    const biome = BIOMES[biomes[ci]].id, col = generator.sampleColumn(wx, wz), top = col.top;
    count(result.biomeColumns, biome);
    for (let y = minY; y < maxY; y++) {
      const index = at(x, y, z), id = blocks[index], ore = mineral.get(id);
      result.volume++;
      result.solid += Number(isSolid(id));
      if (!host.has(id)) continue;
      result.host++;
      if (ore) {
        result.ores[ore]++;
        oreCells.push(index);
        if (generator.getNaturalBlock) {
          const natural = generator.getNaturalBlock(wx, y, wz);
          result.naturalChecks++;
          if (host.get(natural) !== host.get(id) || mineral.has(natural))
            result.actualHostMismatches++;
          if (ore === "ancient_debris" && [
            [wx - 1, y, wz], [wx + 1, y, wz], [wx, y - 1, wz],
            [wx, y + 1, wz], [wx, y, wz - 1], [wx, y, wz + 1],
          ].some((point) => generator.getNaturalBlock(...point) === B.AIR))
            result.naturalAirDebris++;
        }
      }
      let exposure = "buried";
      for (const [ni, ny, nc] of [
        [index - 1, y, ci - 1], [index + 1, y, ci + 1],
        [index - side, y, ci - side], [index + side, y, ci + side],
        [index - layer, y - 1, ci], [index + layer, y + 1, ci],
      ]) {
        const near = ny < minY || ny >= maxY ? B.AIR : blocks[ni];
        if (near === B.AIR) {
          if (ny > skyline[nc]) { exposure = "surface_air"; break; }
          exposure = "cave_air";
        } else if ((near === B.WATER || near === B.LAVA) && exposure === "buried")
          exposure = "fluid";
      }
      const band = Math.floor(y / 16) * 16;
      const depth = top - y, depthBand = depth < 0 ? "above_surface"
        : depth <= 3 ? "0..3" : depth <= 15 ? "4..15" : depth <= 63 ? "16..63" : "64+";
      row(result.byBand, band, ore);
      row(result.byBiomeBand, `${biome}:${band}`, ore);
      row(result.byCaveBand, `${generator.getBiome(wx, wz, y).id}:${band}`, ore);
      row(result.byHost, host.get(id), ore);
      row(result.byExposure, exposure, ore);
      row(result.byExposureBand, `${exposure}:${band}`, ore);
      row(result.byDepth, depthBand, ore);
      if (generator.dimension === "nether")
        row(result.byNetherDomain, y > top && y >= 61 && y <= 77 ? "shelf"
          : y > top && y >= 84 ? "ceiling" : "floor", ore);
    }
  }
  const visited = new Uint8Array(blocks.length), queue = new Int32Array(blocks.length);
  for (const first of oreCells) {
    if (visited[first]) continue;
    const ore = mineral.get(blocks[first]);
    let tail = 1, head = 0, edge = false;
    queue[0] = first; visited[first] = 1;
    while (head < tail) {
      const index = queue[head++], ci = index % layer;
      const x = ci % side, z = Math.floor(ci / side), y = Math.floor(index / layer) + minY;
      edge ||= x === 1 || x === 32 || z === 1 || z === 32;
      for (const ni of [
        x > 1 ? index - 1 : -1, x < 32 ? index + 1 : -1,
        z > 1 ? index - side : -1, z < 32 ? index + side : -1,
        y > minY ? index - layer : -1, y < maxY - 1 ? index + layer : -1,
      ]) if (ni >= 0 && !visited[ni] && mineral.get(blocks[ni]) === ore) {
        visited[ni] = 1; queue[tail++] = ni;
      }
    }
    count(result.groups[ore][edge ? "censored" : "complete"], tail);
  }
  assert.equal(result.volume, 1024 * height);
  for (const ore of ORE_NAMES) {
    assert.equal(result.perChunk.reduce((n, counts) => n + counts[ore], 0), result.ores[ore]);
    const groups = result.groups[ore];
    assert.equal(
      [...Object.entries(groups.complete), ...Object.entries(groups.censored)]
        .reduce((n, [size, count]) => n + Number(size) * count, 0),
      result.ores[ore]
    );
  }
  return result;
}

export function sumAuditRows(rows) {
  const result = emptyRow();
  for (const entry of rows) {
    if (!entry) continue;
    result.host += entry.host;
    for (const ore of ORE_NAMES) result.ores[ore] += entry.ores[ore] ?? 0;
  }
  return result;
}
export const oreRate = (row, ore) => row?.host ? row.ores[ore] / row.host : 0;
