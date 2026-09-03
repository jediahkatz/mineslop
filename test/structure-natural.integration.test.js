import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCK_STATE,
  defaultFluidFor,
  FLUID,
  isSourceWater,
  isValidCell,
} from "../src/block-state.js";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { coversFace, resolveShape } from "../src/block-shapes.js";
import { createChunkPacket } from "../src/chunk-data.js";
import {
  describeStructure,
  getStructureMarkers,
  locateStructure,
  structureTarget,
} from "../src/structure-catalog.js";
import { structurePoint } from "../src/structure-layouts.js";
import { createGenerator } from "../src/terrain.js";

// REAL NATURAL DISCOVERY, not the authored sample fields in structure-fixtures.
// No patched sampler, forced descriptor, fake ID, retry of invalid geometry, or
// success fallback. Missing registrations and undiscovered required sites FAIL.
//
// Per discovery case: <=3 seeds * 4 windows, <=625 owner cells and 12,288
// sampleColumn calls per locator, plus <=256 calls to describe its real target.
// Nine cases: <=67,500 owners and <=1,354,752 discovery column queries.
// Per found site: one <=48x48 real region and <=16 fresh real chunks, comparing
// every block/state/fluid cell over the full native height (<=884,736 cells).
// Native support/content inspection adds <=65 column queries per found site,
// with <=64 markers, <=64 declared piers and <=8 entry points inspected.
// End adds one 16x16 chunk and one 31x23 region. No spawn/biome locator is used:
// those may generate voxels and would obscure the discovery-only work budget.
// This is not player/AI navigation, loot, persistence, physics-loop or GUI proof.
const SEEDS = Object.freeze([
  "cedar-valley",
  "tidal-archive",
  "basalt-crossing",
]);
const SEARCH_ORIGINS = Object.freeze([
  Object.freeze({ x: -4096, z: -4096 }),
  Object.freeze({ x: 0, z: 0 }),
  Object.freeze({ x: 6144, z: 4096 }),
  Object.freeze({ x: -6144, z: 6144 }),
]);
const SEARCH = Object.freeze({ radius: 12, maxCells: 625, maxSamples: 12288 });
const MAX_DESCRIBE_SAMPLES = 256;
const MAX_WINDOW_SIDE = 48;
const MAX_CHUNKS = 16;
const MAX_COMPARED_CELLS = 884736;
const MAX_MARKERS = 64;
const MAX_PIERS = 64;
const MAX_ENTRIES = 8;
const NON_DISCOVERY_COUNTERS = [
  "chunkGenerations",
  "regionGenerations",
  "caveColumns",
  "oreCells",
  "voxelVisits",
  "featureWrites",
  "decoratorCells",
  "treeCells",
  "marineCells",
  "decoratorSamples",
  "decoratorDescriptors",
  "decoratorWrites",
  "spawnCandidates",
  "locatorSamples",
];

// These are required behavioral cases, not derived from a possibly shortened
// catalog: removing a kind or making either ruin climate undiscoverable fails.
const CASES = [
  {
    kind: "shipwreck",
    dimension: "overworld",
    materials: [
      ["PLANKS", 80],
      ["OAK_LOG", 12],
      ["LADDER", 2],
    ],
    piers: true,
  },
  {
    kind: "ocean_ruin",
    dimension: "overworld",
    climate: "warm",
    materials: [
      ["SANDSTONE", 80],
      ["TERRACOTTA", 12],
    ],
    piers: true,
  },
  {
    kind: "ocean_ruin",
    dimension: "overworld",
    climate: "cold",
    materials: [
      ["MOSSY_COBBLESTONE", 80],
      ["COBBLESTONE", 12],
    ],
    piers: true,
  },
  {
    kind: "ocean_monument",
    dimension: "overworld",
    materials: [
      ["PRISMARINE", 200],
      ["PRISMARINE_BRICKS", 200],
      ["WET_SPONGE", 4],
    ],
    piers: true,
  },
  {
    kind: "buried_treasure",
    dimension: "overworld",
    materials: [
      ["CHEST", 1],
      ["SAND", 3],
      ["SANDSTONE", 1],
    ],
  },
  {
    kind: "village",
    dimension: "overworld",
    materials: [
      ["PLANKS", 64],
      ["OAK_DOOR", 6],
      ["WHITE_BED", 8],
      ["WHEAT_CROP", 12],
    ],
    piers: true,
  },
  {
    kind: "nether_fortress",
    dimension: "nether",
    materials: [
      ["NETHER_BRICKS", 160],
      ["NETHER_BRICK_STAIRS", 6],
      ["NETHER_WART_CROP", 8],
      ["SPAWNER", 1],
    ],
    piers: true,
  },
  {
    kind: "bastion_remnant",
    dimension: "nether",
    materials: [
      ["BLACKSTONE", 200],
      ["BASALT", 8],
      ["NETHER_BRICK_STAIRS", 6],
      ["GOLD_BLOCK", 2],
    ],
    piers: true,
  },
  {
    kind: "dungeon",
    dimension: "overworld",
    materials: [
      ["COBBLESTONE", 80],
      ["MOSSY_COBBLESTONE", 24],
      ["LADDER", 6],
      ["SPAWNER", 1],
    ],
  },
];

const labelOf = (goal) =>
  `${goal.kind}${goal.climate ? `/${goal.climate}` : ""}`;
const keyOf = (x, z) => `${x},${z}`;
const nativeGenerator = (seed, dimension) =>
  createGenerator(seed, dimension, 4);
const queryContext = (generator) => ({
  seed: generator.seed,
  dimension: generator.dimension,
  spec: generator.spec,
  sampleColumn: generator.sampleColumn,
});

function assertDiscoveryOnly(before, after, expectedSamples) {
  for (const counter of NON_DISCOVERY_COUNTERS) {
    assert.ok(
      Number.isSafeInteger(before[counter]) &&
        Number.isSafeInteger(after[counter]),
      `missing native work counter: ${counter}`
    );
    assert.equal(
      after[counter],
      before[counter],
      `locator/describe must not perform ${counter}`
    );
  }
  assert.equal(after.surfaceQueries - before.surfaceQueries, expectedSamples);
}

function discoverNaturalSite(goal, t) {
  const attempts = [];
  let examinedCells = 0;
  let sampledColumns = 0;
  let descriptionSamples = 0;
  for (const seed of SEEDS) {
    const generator = nativeGenerator(seed, goal.dimension);
    const context = queryContext(generator);
    for (const from of SEARCH_ORIGINS) {
      const before = generator.counters;
      const located = locateStructure(goal.kind, context, from, SEARCH);
      const afterLocate = generator.counters;
      assertDiscoveryOnly(before, afterLocate, located.sampledColumns);
      assert.ok(located.examinedCells <= SEARCH.maxCells);
      assert.ok(located.sampledColumns <= SEARCH.maxSamples);
      assert.equal(located.complete, !located.exhausted);
      examinedCells += located.examinedCells;
      sampledColumns += located.sampledColumns;
      let descriptor = null;
      if (located.target) {
        descriptor = describeStructure(
          goal.kind,
          context,
          located.target.gx,
          located.target.gz
        );
        const used =
          generator.counters.surfaceQueries - afterLocate.surfaceQueries;
        assert.ok(used <= MAX_DESCRIBE_SAMPLES);
        assertDiscoveryOnly(afterLocate, generator.counters, used);
        descriptionSamples += used;
        assert.ok(
          descriptor,
          "a natural locator target must still describe the same site"
        );
        assert.deepEqual(structureTarget(descriptor), located.target);
      }
      const matched =
        descriptor &&
        (!goal.climate || descriptor.variant.startsWith(`${goal.climate}_`));
      attempts.push({
        seed: generator.seed,
        from,
        examinedCells: located.examinedCells,
        sampledColumns: located.sampledColumns,
        exhausted: located.exhausted,
        targetId: located.target?.id ?? null,
        variant: descriptor?.variant ?? null,
      });
      if (!matched) continue;
      // Once the required natural kind/climate is found, validate THAT site.
      // Bad geometry may not be discarded in favor of a later passing site.
      const discovery = {
        attempts,
        examinedCells,
        sampledColumns,
        descriptionSamples,
      };
      t.diagnostic(JSON.stringify({ discovery: labelOf(goal), ...discovery }));
      return { generator, descriptor, discovery };
    }
  }
  assert.fail(
    `Required natural ${labelOf(goal)} not found within ${SEEDS.length * SEARCH_ORIGINS.length} ` +
      `fixed searches; owners=${examinedCells}, locatorSamples=${sampledColumns}, ` +
      `descriptionSamples=${descriptionSamples}; attempts=${JSON.stringify(attempts)}`
  );
}

function crossesChunkBoundary(minimum, maximum) {
  return Math.floor(minimum / 16) !== Math.floor((maximum - 1) / 16);
}

function includeNearbySeam(minimum, maximum) {
  if (crossesChunkBoundary(minimum, maximum)) return [minimum, maximum];
  const low = Math.floor(minimum / 16) * 16;
  const high = low + 16;
  // Tiny buried caches may fit in one chunk. Include the nearest actual seam
  // and its neighboring native terrain; do not force the cache to another site.
  return minimum - low <= high - maximum
    ? [low - 1, maximum]
    : [minimum, high + 1];
}

function validationWindow(descriptor) {
  const b = descriptor.bounds;
  const [minX, maxX] = includeNearbySeam(b.minX - 2, b.maxX + 2);
  const [minZ, maxZ] = includeNearbySeam(b.minZ - 2, b.maxZ + 2);
  const area = { minX, minZ, width: maxX - minX, depth: maxZ - minZ };
  assert.ok(
    area.width <= MAX_WINDOW_SIDE && area.depth <= MAX_WINDOW_SIDE,
    "a larger layout requires an explicit integration-budget review"
  );
  assert.ok(
    crossesChunkBoundary(minX, maxX) && crossesChunkBoundary(minZ, maxZ)
  );
  return area;
}

/** Decode only real native packets; missing/outside cells remain unavailable. */
function packetReader(packet) {
  const chunk =
    Number.isSafeInteger(packet.cx) && Number.isSafeInteger(packet.cz);
  const minX = chunk ? packet.cx * 16 : packet.minX;
  const minZ = chunk ? packet.cz * 16 : packet.minZ;
  const width = chunk ? 16 : packet.width;
  const depth = chunk ? 16 : packet.depth;
  assert.equal(packet.encoding, "u16");
  assert.ok(packet.blocks instanceof Uint16Array);
  assert.equal(
    packet.blocks.length,
    width * depth * (packet.maxY - packet.minY)
  );
  assert.equal(packet.biomes.length, width * depth);
  const sections = new Map();
  for (const section of packet.sections ?? []) {
    const cx = chunk ? packet.cx : section.cx;
    const cz = chunk ? packet.cz : section.cz;
    assert.ok([cx, cz, section.sy].every(Number.isSafeInteger));
    const key = `${cx},${section.sy},${cz}`;
    assert.equal(
      sections.has(key),
      false,
      "duplicate native section coordinate"
    );
    for (const [plane, Type] of [
      ["states", Uint16Array],
      ["fluids", Uint8Array],
    ])
      if (section[plane]) {
        assert.ok(section[plane] instanceof Type);
        assert.equal(section[plane].length, 4096);
      }
    sections.set(key, section);
  }
  return (x, y, z) => {
    if (
      x < minX ||
      x >= minX + width ||
      z < minZ ||
      z >= minZ + depth ||
      y < packet.minY ||
      y >= packet.maxY
    )
      return null;
    const id =
      packet.blocks[
        (y - packet.minY) * width * depth + (z - minZ) * width + x - minX
      ];
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const sy = Math.floor(y / 16);
    const section = sections.get(`${cx},${sy},${cz}`);
    const local = (y - sy * 16) * 256 + (z - cz * 16) * 16 + x - cx * 16;
    return {
      id,
      state: section?.states?.[local] ?? 0,
      fluid: section?.fluids?.[local] ?? defaultFluidFor(id),
    };
  };
}

function horizontallyIntersects(area, bounds) {
  return (
    area.minX < bounds.maxX &&
    area.minX + area.width > bounds.minX &&
    area.minZ < bounds.maxZ &&
    area.minZ + area.depth > bounds.minZ
  );
}

function assertPacketDescriptor(packet, descriptor, area) {
  const found = (packet.structures ?? []).filter((d) => d.id === descriptor.id);
  assert.equal(
    found.length,
    Number(horizontallyIntersects(area, descriptor.bounds))
  );
  for (const actual of found) {
    assert.deepEqual(
      actual,
      {
        ...descriptor,
        owner: `structure:${descriptor.kind}:v${descriptor.layoutVersion}`,
      },
      "native chunks and regions must preserve the entire canonical descriptor"
    );
  }
  return found;
}

function generatedParity(generator, descriptor) {
  const area = validationWindow(descriptor);
  const height = generator.spec.maxY - generator.spec.minY;
  const comparisonCells = area.width * area.depth * height;
  assert.ok(comparisonCells <= MAX_COMPARED_CELLS);
  const before = generator.counters;
  const region = generator.generateRegion(
    area.minX,
    area.minZ,
    area.width,
    area.depth
  );
  assert.equal(
    generator.counters.regionGenerations - before.regionGenerations,
    1
  );
  assert.equal(region.minY, generator.spec.minY);
  assert.equal(region.maxY, generator.spec.maxY);
  assertPacketDescriptor(region, descriptor, area);
  const read = packetReader(region);

  // Fresh caches and reverse chunk request order, not a slice of region data.
  const independent = nativeGenerator(generator.seed, generator.dimension);
  const coordinates = [];
  for (
    let cz = Math.floor((area.minZ + area.depth - 1) / 16);
    cz >= Math.floor(area.minZ / 16);
    cz--
  )
    for (
      let cx = Math.floor((area.minX + area.width - 1) / 16);
      cx >= Math.floor(area.minX / 16);
      cx--
    )
      coordinates.push([cx, cz]);
  assert.ok(coordinates.length <= MAX_CHUNKS);
  const chunks = new Map();
  const ownedMarkers = [];
  for (const [cx, cz] of coordinates) {
    const packet = createChunkPacket(independent.generateChunk(cx, cz), {
      id: chunks.size,
      epoch: 0,
      seed: independent.seed,
      dimension: independent.dimension,
      generatorVersion: 4,
      cx,
      cz,
    });
    assert.equal(packet.minY, generator.spec.minY);
    assert.equal(packet.maxY, generator.spec.maxY);
    const bounds = {
      minX: cx * 16,
      minY: packet.minY,
      minZ: cz * 16,
      maxX: (cx + 1) * 16,
      maxY: packet.maxY,
      maxZ: (cz + 1) * 16,
    };
    const descriptions = assertPacketDescriptor(packet, descriptor, {
      minX: bounds.minX,
      minZ: bounds.minZ,
      width: 16,
      depth: 16,
    });
    for (const actual of descriptions)
      ownedMarkers.push(...getStructureMarkers(actual, { bounds }));
    chunks.set(keyOf(cx, cz), { packet, read: packetReader(packet) });
  }
  assert.equal(independent.counters.chunkGenerations, coordinates.length);
  assert.equal(independent.counters.regionGenerations, 0);
  const ids = descriptor.markers.map((marker) => marker.id).sort();
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    ownedMarkers.map((marker) => marker.id).sort(),
    ids,
    "native chunk clipping owns each canonical marker anchor exactly once"
  );

  const materials = new Map();
  let compared = 0;
  let nonDefaultStates = 0;
  let nonDefaultFluids = 0;
  const b = descriptor.bounds;
  for (let z = area.minZ; z < area.minZ + area.depth; z++)
    for (let x = area.minX; x < area.minX + area.width; x++) {
      const cx = Math.floor(x / 16);
      const cz = Math.floor(z / 16);
      const chunk = chunks.get(keyOf(cx, cz));
      const localColumn = (z - cz * 16) * 16 + x - cx * 16;
      assert.equal(
        chunk.packet.biomes[localColumn],
        region.biomes[(z - area.minZ) * area.width + x - area.minX]
      );
      for (let y = region.minY; y < region.maxY; y++) {
        const a = read(x, y, z);
        const other = chunk.read(x, y, z);
        if (
          a.id !== other.id ||
          a.state !== other.state ||
          a.fluid !== other.fluid
        )
          assert.fail(
            `Natural chunk/region mismatch at ${x},${y},${z}: ` +
              `region=${JSON.stringify(a)}, chunk=${JSON.stringify(other)}, structure=${descriptor.id}`
          );
        compared++;
        if (a.state !== 0) nonDefaultStates++;
        if (a.fluid !== defaultFluidFor(a.id)) nonDefaultFluids++;
        if (a.state !== 0 || a.fluid !== defaultFluidFor(a.id))
          assert.ok(
            isValidCell(a),
            `invalid native state/fluid at ${x},${y},${z}`
          );
        if (
          x >= b.minX &&
          x < b.maxX &&
          z >= b.minZ &&
          z < b.maxZ &&
          y >= b.minY &&
          y < b.maxY
        )
          materials.set(a.id, (materials.get(a.id) ?? 0) + 1);
      }
    }
  assert.equal(compared, comparisonCells);
  return {
    read,
    materials,
    work: {
      area,
      chunks: coordinates.length,
      regions: 1,
      compared,
      nonDefaultStates,
      nonDefaultFluids,
      regionGeneration: generator.lastGenerationWork,
      chunkGeneration: independent.counters,
    },
  };
}

function shapeAt(read, x, y, z) {
  const cell = read(x, y, z);
  assert.ok(
    cell && isValidCell(cell),
    `missing/invalid native cell at ${x},${y},${z}`
  );
  return resolveShape(cell, (dx, dy, dz) => read(x + dx, y + dy, z + dz));
}

const overlapsFootprint = (box) =>
  box[0] < 0.8 && box[3] > 0.2 && box[2] < 0.8 && box[5] > 0.2;

function assertNativeStandingSpace(read, position, label) {
  const { x, y, z } = position;
  for (const [dy, height] of [
    [0, 1],
    [1, 0.8],
  ]) {
    assert.equal(
      shapeAt(read, x, y + dy, z).collision.some(
        (box) => overlapsFootprint(box) && box[1] < height && box[4] > 0
      ),
      false,
      `${label} lacks native two-cell entry/body clearance`
    );
    assert.notEqual(
      read(x, y + dy, z).fluid,
      FLUID.LAVA_SOURCE,
      `${label} intersects native lava`
    );
  }
  const support = shapeAt(read, x, y - 1, z);
  assert.equal(
    support.collision.some((box) => overlapsFootprint(box) && box[4] > 1),
    false,
    `${label} stands inside protruding native support`
  );
  if (coversFace(support, "up")) return "grounded";
  // Surface swimming needs water at the feet, not a submerged head. Clearance
  // above is still checked against the real packet, including native ice.
  if (isSourceWater(read(x, y, z).fluid))
    return isSourceWater(read(x, y + 1, z).fluid)
      ? "swimming"
      : "surface-water";
  if (shapeAt(read, x, y, z).climbable) return "climbing";
  assert.fail(
    `${label} has neither native floor support, source-water depth nor an attached ladder`
  );
}

function assertNativeFloor(read, position, label) {
  assert.ok(
    coversFace(shapeAt(read, position.x, position.y - 1, position.z), "up"),
    `${label} has no full supporting face in generated terrain`
  );
}

function requireBlock(name) {
  assert.ok(
    Number.isInteger(BLOCK[name]) && BLOCKS[BLOCK[name]],
    `Missing registered natural-test content: ${name}`
  );
  return BLOCK[name];
}

function assertNativeMarkers(descriptor, read) {
  const markers = getStructureMarkers(descriptor);
  assert.ok(markers.length > 0 && markers.length <= MAX_MARKERS);
  const byId = new Map(markers.map((marker) => [marker.id, marker]));
  for (const marker of markers) {
    const p = marker.position;
    assert.ok([p.x, p.y, p.z].every(Number.isSafeInteger));
    assert.equal(marker.structureId, descriptor.id);
    assert.equal(marker.id, `${descriptor.id}/${marker.type}/${marker.key}`);
    assert.equal(marker.dimension, descriptor.dimension);
    for (const field of ["slots", "items", "inventory", "loot"])
      assert.equal(
        Object.hasOwn(marker, field),
        false,
        "generation supplies declarations, not rolled inventory"
      );
    if (marker.block) {
      assert.equal(
        read(p.x, p.y, p.z).id,
        requireBlock(marker.block),
        `${marker.id} disagrees with its native block`
      );
      assertNativeFloor(read, p, marker.id);
    }
    if (marker.type === "member") {
      assertNativeStandingSpace(read, p, marker.id);
      assert.equal(typeof marker.stockTable, "string");
      assert.equal(byId.get(marker.homeId)?.type, "home");
      assert.equal(byId.get(marker.bedId)?.memberId, marker.id);
      assert.equal(byId.get(marker.jobSiteId)?.profession, marker.profession);
    }
    if (marker.type === "encounter" && marker.mechanism !== "spawner")
      assertNativeStandingSpace(read, p, marker.id);
    if (marker.type === "bed") {
      const shape = shapeAt(read, p.x, p.y, p.z);
      assert.equal(shape.kind, "bed");
      assert.equal(
        shape.link.valid,
        true,
        `${marker.id} has a missing/misaligned native bed part`
      );
      assert.equal(shape.facing, marker.facing);
      assert.equal(
        read(p.x, p.y, p.z).state & BLOCK_STATE.FACING_MASK,
        marker.facing
      );
      assert.equal(read(p.x, p.y, p.z).state & BLOCK_STATE.PART, 0);
    }
    if (marker.type === "container")
      assert.ok(typeof marker.table === "string" && marker.table.length > 0);
    if (marker.type === "home") {
      assertNativeStandingSpace(read, p, marker.id);
      const e = marker.entry;
      assert.ok(e);
      const door = shapeAt(read, e.x, e.y, e.z);
      assert.equal(door.kind, "door");
      assert.equal(
        door.link.valid,
        true,
        `${marker.id} needs a complete native door`
      );
      assert.equal(door.facing, e.facing);
      // Do not change door state to pretend an interaction/navigation occurred.
    }
    if (marker.type === "crop_plot") {
      assert.equal(read(p.x, p.y, p.z).id, requireBlock(marker.crop));
      assert.equal(read(p.x, p.y - 1, p.z).id, requireBlock(marker.soil));
    }
    if (marker.mapTarget) {
      assert.equal(marker.mapTarget.sourceMarkerId, marker.id);
      assert.equal(marker.mapTarget.seed, descriptor.seed);
      assert.deepEqual(marker.mapTarget.from, marker.position);
    }
  }
  return markers;
}

function assertNativeFootings(generator, descriptor, read) {
  assert.ok(
    Array.isArray(descriptor.plan.supports) &&
      descriptor.plan.supports.length > 0
  );
  assert.ok(descriptor.plan.supports.length <= MAX_PIERS);
  let inspected = 0;
  for (const pier of descriptor.plan.supports) {
    const foot = structurePoint(descriptor, pier.x, pier.bottom, pier.z);
    const column = generator.sampleColumn(foot.x, foot.z);
    assert.ok(column && Number.isInteger(column.top));
    assert.ok(
      foot.y <= column.top,
      "the foundation must enter the real sampled terrain"
    );
    assert.ok(
      coversFace(shapeAt(read, foot.x, foot.y, foot.z), "up"),
      "missing generated foundation"
    );
    // Below the declared pier's first write, inspect actual generated terrain,
    // not only the cheap height field. Caves/fluids cannot count as rock support.
    assert.ok(
      coversFace(shapeAt(read, foot.x, foot.y - 1, foot.z), "up"),
      `${descriptor.id} has an unsupported native footing at ${foot.x},${foot.y},${foot.z}`
    );
    inspected++;
  }
  return inspected;
}

function assertNativeContent(
  goal,
  generator,
  descriptor,
  read,
  materials,
  markers
) {
  for (const [name, minimum] of goal.materials)
    assert.ok(
      (materials.get(requireBlock(name)) ?? 0) >= minimum,
      `${labelOf(goal)} lacks meaningful generated ${name}: ${materials.get(BLOCK[name]) ?? 0} < ${minimum}`
    );
  const chests = markers.filter((marker) => marker.type === "container");
  assert.equal(
    materials.get(BLOCK.CHEST) ?? 0,
    chests.length,
    "native chests and canonical container anchors must agree"
  );
  const column = generator.sampleColumn(
    descriptor.origin.x,
    descriptor.origin.z
  );
  assert.ok(column && Number.isInteger(column.top));
  if (goal.climate)
    assert.equal(column.temperature >= 0.67, goal.climate === "warm");
  if (goal.kind === "ocean_monument") {
    assert.ok(descriptor.bounds.maxY <= column.waterLevel);
    assert.equal(materials.get(requireBlock("GOLD_BLOCK")), 8);
    assert.equal(chests.length, 0);
    const elders = markers.filter((marker) => marker.type === "encounter");
    assert.equal(elders.length, 3);
    assert.ok(
      elders.every(
        (marker) => marker.entity === "elder_guardian" && marker.unique
      )
    );
    for (const { position: p } of elders)
      assert.ok(
        isSourceWater(read(p.x, p.y, p.z).fluid) &&
          isSourceWater(read(p.x, p.y + 1, p.z).fluid),
        "elder chambers must actually be flooded"
      );
  }
  if (goal.kind === "buried_treasure") {
    assert.equal(chests.length, 1);
    assert.deepEqual(chests[0].tableGuarantees, ["heart_of_sea"]);
    assert.equal(chests[0].table, "buried_treasure/heart_of_sea");
    const { x, y, z } = chests[0].position;
    assert.ok(y < column.top);
    for (let dy = 1; dy <= 3; dy++)
      assert.equal(
        read(x, y + dy, z).id,
        BLOCK.SAND,
        "the real cache must remain buried"
      );
  }
  if (goal.kind === "shipwreck") {
    assert.ok(chests.length > 0);
    assert.equal(
      new Set(chests.map((marker) => marker.table)).size,
      chests.length
    );
    assert.ok(
      chests.every((marker) =>
        ["supply", "treasure", "map"].includes(marker.role)
      )
    );
  }
  if (goal.kind === "village") {
    for (const profession of [
      "farmer",
      "librarian",
      "cartographer",
      "toolsmith",
    ])
      assert.ok(
        markers.some(
          (marker) =>
            marker.type === "member" && marker.profession === profession
        )
      );
    assert.ok(
      markers.some(
        (marker) => marker.type === "crop_plot" && marker.crop === "WHEAT_CROP"
      )
    );
  }
  if (goal.kind === "nether_fortress") {
    assert.ok(markers.some((marker) => marker.role === "wart_garden"));
    assert.ok(
      markers.some(
        (marker) => marker.entity === "blaze" && marker.mechanism === "spawner"
      )
    );
  }
  if (goal.kind === "bastion_remnant")
    assert.deepEqual(
      chests.find((marker) => marker.role === "treasure")?.tableGuarantees,
      ["netherite_upgrade_template"]
    );
  if (goal.kind === "dungeon")
    assert.ok(
      markers.some(
        (marker) =>
          marker.mechanism === "spawner" && marker.position.y < column.top
      )
    );
}

for (const goal of CASES) {
  test(`natural v4 ${labelOf(goal)}: bounded discovery, real packet seams, native anchors/support and materials`, (t) => {
    const { generator, descriptor } = discoverNaturalSite(goal, t);
    const { read, materials, work } = generatedParity(generator, descriptor);
    assert.ok(
      descriptor.entries.length > 0 && descriptor.entries.length <= MAX_ENTRIES
    );
    if (["shipwreck", "village", "dungeon"].includes(goal.kind))
      assert.ok(
        work.nonDefaultStates > 0,
        "this native layout must exercise real state planes"
      );
    if (goal.kind === "shipwreck" && !descriptor.plan.beached)
      assert.ok(
        work.nonDefaultFluids > 0,
        "sunken wrecks must exercise native waterlogged shape planes"
      );
    const entryModes = descriptor.entries.map((entry) =>
      assertNativeStandingSpace(read, entry, `${descriptor.id}/entry`)
    );
    const markers = assertNativeMarkers(descriptor, read);
    const footings = goal.piers
      ? assertNativeFootings(generator, descriptor, read)
      : 0;
    assertNativeContent(goal, generator, descriptor, read, materials, markers);
    t.diagnostic(
      JSON.stringify({
        validatedNaturalSite: labelOf(goal),
        seed: generator.seed,
        id: descriptor.id,
        variant: descriptor.variant,
        rotation: descriptor.rotation,
        gx: descriptor.gx,
        gz: descriptor.gz,
        bounds: descriptor.bounds,
        entryModes,
        footings,
        markerCount: markers.length,
        ...work,
      })
    );
  });
}

test("natural v4 End generation never invokes the overworld/Nether structure decorators", () => {
  const generator = nativeGenerator(SEEDS[0], "end");
  const chunk = generator.generateChunk(0, 0);
  const region = generator.generateRegion(-17, -9, 31, 23);
  assert.equal(generator.counters.chunkGenerations, 1);
  assert.equal(generator.counters.regionGenerations, 1);
  assert.equal(
    generator.counters.decoratorCells,
    0,
    "the real seam must filter dimension before describe/emit"
  );
  assert.deepEqual(chunk.structures ?? [], []);
  assert.deepEqual(region.structures ?? [], []);
  const before = generator.counters;
  for (const kind of new Set(CASES.map((goal) => goal.kind))) {
    const result = locateStructure(
      kind,
      queryContext(generator),
      { x: -1, z: -1 },
      SEARCH
    );
    assert.equal(result.target, null);
    assert.equal(result.examinedCells, 0);
    assert.equal(result.sampledColumns, 0);
  }
  assertDiscoveryOnly(before, generator.counters, 0);
});
