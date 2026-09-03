import assert from "node:assert/strict";
import test from "node:test";
import { BIOME_PROFILES } from "../src/biomes.js";
import { BLOCK as B, isSolid } from "../src/blocks.js";
import { seedHash, squareSpiral } from "../src/noise.js";
import { collidesWithWorld } from "../src/player.js";
import {
  createGenerator,
  WATER_LEVEL,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
} from "../src/terrain.js";
import { sampleCaveIntervals } from "../src/terrain-cave-field.js";
import {
  CAVE_CELL_SIZE,
  carveEntrance,
  createCaveGenerator,
} from "../src/terrain-caves.js";

const seeds = ["cedar-valley", "birch-river", "123", ""];
const validXZ = (x, z) =>
  x >= WORLD_MIN && x < WORLD_MAX && z >= WORLD_MIN && z < WORLD_MAX;

function findFeature(generator, from, accept = () => true, rings = 3) {
  const gx = Math.floor(from.x / CAVE_CELL_SIZE);
  const gz = Math.floor(from.z / CAVE_CELL_SIZE);
  for (const [dx, dz] of squareSpiral(rings))
    for (const feature of generator.getCaveEntrances(gx + dx, gz + dz))
      if (accept(feature)) return { feature, gx: gx + dx, gz: gz + dz };
  return null;
}

function terrainView(generator, feature) {
  const chunks = new Map();
  const bounds = {
    minX: feature.bounds.minX - 12,
    maxX: feature.bounds.maxX + 12,
    minZ: feature.bounds.minZ - 12,
    maxZ: feature.bounds.maxZ + 12,
  };
  const contains = (x, z) =>
    x >= bounds.minX &&
    x <= bounds.maxX &&
    z >= bounds.minZ &&
    z <= bounds.maxZ;
  const get = (x, y, z) => {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR;
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const key = `${cx},${cz}`;
    if (!chunks.has(key)) chunks.set(key, generator.generateChunk(cx, cz));
    return chunks.get(key).blocks[y * 256 + (z - cz * 16) * 16 + x - cx * 16];
  };
  return {
    get,
    chunks,
    contains,
    isSolid: (x, y, z) => isSolid(get(x, y, z)),
    isLoaded: contains,
  };
}

// A supported, two-air-cell navigation graph. Edges allow only single-block
// steps, with clearance at the raised body position on both sides of a step.
// This cannot pass a disconnected pit, a one-high slit or a vertical shaft.
function walkingRoute(view, start, goal) {
  const key = ({ x, y, z }) => `${x},${y},${z}`;
  const bodyClear = (x, y, z) =>
    view.get(x, y, z) === B.AIR && view.get(x, y + 1, z) === B.AIR;
  const supported = (x, y, z) =>
    view.contains(x, z) &&
    y > 0 &&
    y < WORLD_HEIGHT - 2 &&
    view.isSolid(x, y - 1, z) &&
    bodyClear(x, y, z);
  assert.ok(supported(start.x, start.y, start.z), "outside mouth is walkable");
  const queue = [{ ...start, parent: -1 }];
  const visited = new Set([key(start)]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const here = queue[cursor];
    if (goal(here)) {
      const route = [];
      for (let i = cursor; i !== -1; i = queue[i].parent) route.push(queue[i]);
      return route.reverse();
    }
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      for (const dy of [0, -1, 1]) {
        const next = { x: here.x + dx, y: here.y + dy, z: here.z + dz };
        const id = key(next);
        if (visited.has(id) || !supported(next.x, next.y, next.z)) continue;
        const raised = Math.max(here.y, next.y);
        if (
          !bodyClear(here.x, raised, here.z) ||
          !bodyClear(next.x, raised, next.z)
        )
          continue;
        visited.add(id);
        queue.push({ ...next, parent: cursor });
      }
    }
  }
  return null;
}

function nativeCaves(generator, salt, x, z) {
  return sampleCaveIntervals(
    x,
    z,
    generator.terrainHeight(x, z),
    salt,
    WATER_LEVEL
  );
}

for (const seed of seeds) {
  test(`v3 has visible, supported entrances into existing chambers near spawn: ${JSON.stringify(seed)}`, (t) => {
    const generator = createGenerator(seed);
    const spawn = generator.getSpawn();
    const found = findFeature(
      generator,
      spawn,
      (entry) =>
        entry.kind === "cave" &&
        Math.hypot(entry.mouth.x - spawn.x, entry.mouth.z - spawn.z) <= 320
    );
    assert.ok(found, "a normal exploration radius must contain a real cave");
    const { feature } = found;
    const view = terrainView(generator, feature);
    const salt = seedHash(seed);
    let exposedTopsoil = 0;
    for (const point of feature.path) {
      assert.ok(view.isSolid(point.x, point.low - 1, point.z), "ramp support");
      assert.ok(
        nativeCaves(generator, salt, point.x, point.z).every(
          ([low, high]) => point.low - 1 < low || point.low - 1 > high
        ),
        "support must be original rock, not a ramp refilled through cavern air"
      );
      for (let dy = 0; dy < 3; dy++)
        assert.equal(
          view.get(point.x, point.low + dy, point.z),
          B.AIR,
          `body/jump clearance at ${point.x},${point.low + dy},${point.z}`
        );
      const top = generator.terrainHeight(point.x, point.z);
      if (view.get(point.x, top, point.z) === B.AIR) exposedTopsoil++;
      assert.equal(view.get(point.x, 0, point.z), B.BEDROCK);
    }
    assert.ok(
      exposedTopsoil >= 2,
      "the actual topsoil is open, not just metadata"
    );
    assert.ok(
      exposedTopsoil < feature.length * 0.65,
      "a hillside cave must become roofed underground"
    );
    const { chamber, direction, mouth } = feature;
    assert.ok(
      nativeCaves(generator, salt, chamber.x, chamber.z).some(
        ([low, high]) => low === chamber.low && high === chamber.high
      ),
      "v3 endpoint metadata must describe the shared natural cave field"
    );
    const route = walkingRoute(view, mouth, ({ x, y, z }) => {
      return (
        x === chamber.x &&
        z === chamber.z &&
        y === chamber.low &&
        y <= generator.terrainHeight(x, z) - 8 &&
        y <= mouth.y - 7
      );
    });
    assert.ok(
      route,
      "walk from outside, through the mouth, onto an actual v3 cave floor"
    );
    assert.ok(
      route.length >= feature.length,
      "the test must traverse the tunnel to its natural chamber"
    );
    const onward = walkingRoute(
      view,
      { x: chamber.x, y: chamber.low, z: chamber.z },
      ({ x, y, z }) => {
        if (Math.hypot(x - chamber.x, z - chamber.z) < 4) return false;
        const s = (x - mouth.x) * direction.x + (z - mouth.z) * direction.z;
        const point = feature.path[s];
        if (
          point &&
          Math.abs((z - point.z) * direction.x - (x - point.x) * direction.z) <
            point.radius + 1
        )
          return false;
        return nativeCaves(generator, salt, x, z).some(
          ([low, high]) => y >= low && y + 1 <= high
        );
      }
    );
    assert.ok(
      onward,
      "the room continues into native cave air outside the entrance cut"
    );
    for (let i = 1; i < route.length; i++) {
      const previous = route[i - 1];
      const point = route[i];
      assert.ok(Math.abs(point.y - previous.y) <= 1);
      assert.ok(view.isSolid(point.x, point.y - 1, point.z));
      // Sweep the real 0.6 × 1.8 player body through each transition, including
      // the shared face between columns rather than just their center points.
      for (const fraction of [0, 0.25, 0.5, 0.75, 1])
        assert.equal(
          collidesWithWorld(view, {
            x: previous.x + (point.x - previous.x) * fraction + 0.5,
            y: Math.max(previous.y, point.y) + 0.01,
            z: previous.z + (point.z - previous.z) * fraction + 0.5,
          }),
          false
        );
    }
    for (const chunk of view.chunks.values())
      assert.ok(chunk.blocks.subarray(0, 256).every((id) => id === B.BEDROCK));
    t.diagnostic(
      JSON.stringify({
        seed,
        spawn,
        caveMouth: { x: mouth.x + 0.5, y: mouth.y + 0.01, z: mouth.z + 0.5 },
        inward: direction,
        chamber: {
          x: chamber.x + 0.5,
          y: chamber.low + 0.01,
          z: chamber.z + 0.5,
        },
        walkingSteps: route.length - 1,
        nativeCaveSteps: onward.length - 1,
      })
    );
  });
}

test("the reported cedar-valley entrance cell retains a supported route without a refilled plinth", (t) => {
  const generator = createGenerator("cedar-valley", "overworld", 3);
  const feature = generator.getCaveEntrances(0, 8)[0];
  assert.ok(
    feature,
    "keep an actual entrance in the reported cell, not only near another spawn"
  );
  const view = terrainView(generator, feature);
  const salt = seedHash("cedar-valley");
  for (const point of feature.path) {
    assert.ok(view.isSolid(point.x, point.low - 1, point.z));
    assert.ok(
      nativeCaves(generator, salt, point.x, point.z).every(
        ([low, high]) => point.low - 1 < low || point.low - 1 > high
      ),
      "no part of the route stands on rock refilled into native air"
    );
    for (let dy = 0; dy < 3; dy++)
      assert.equal(view.get(point.x, point.low + dy, point.z), B.AIR);
  }
  const route = walkingRoute(
    view,
    feature.mouth,
    ({ x, y, z }) =>
      x === feature.chamber.x &&
      z === feature.chamber.z &&
      y === feature.chamber.low
  );
  assert.ok(route);
  t.diagnostic(
    JSON.stringify({
      seed: "cedar-valley",
      cell: [0, 8],
      mouth: feature.mouth,
      chamber: feature.chamber,
      inward: feature.direction,
      walkingSteps: route.length - 1,
      note: "v3 entrance endpoints are sampled from the corrected field and may move",
    })
  );
});

test("occasional narrow ravines have open banks and a supported way into caves", (t) => {
  const generator = createGenerator("birch-river");
  const found = findFeature(
    generator,
    generator.getSpawn(),
    (feature) => feature.kind === "ravine",
    6
  );
  assert.ok(found, "seeded ravines must really generate");
  const { feature } = found;
  const view = terrainView(generator, feature);
  let open = 0;
  let deep = 0;
  for (const point of feature.path) {
    const top = generator.terrainHeight(point.x, point.z);
    assert.ok(view.isSolid(point.x, point.low - 1, point.z));
    for (let dy = 0; dy < 3; dy++)
      assert.equal(view.get(point.x, point.low + dy, point.z), B.AIR);
    if (view.get(point.x, top, point.z) === B.AIR) {
      open++;
      if (top - point.low >= 6) deep++;
      for (const offset of [-1, 1])
        assert.equal(
          view.get(
            point.x - feature.direction.z * offset,
            point.low + 1,
            point.z + feature.direction.x * offset
          ),
          B.AIR,
          "the ravine is wider than a one-voxel crack"
        );
    }
  }
  assert.ok(open > feature.length * 0.45 && open < feature.length * 0.8);
  assert.ok(deep >= 8, "an open cut, not a decorative shallow stripe");
  const route = walkingRoute(
    view,
    feature.mouth,
    ({ x, y, z }) =>
      x === feature.chamber.x &&
      z === feature.chamber.z &&
      y === feature.chamber.low
  );
  assert.ok(route, "the ravine must have a walkable exit into its chamber");
  t.diagnostic(
    JSON.stringify({
      seed: "birch-river",
      ravineMouth: feature.mouth,
      inward: feature.direction,
      chamber: feature.chamber,
    })
  );
});

test("the entrance voxel pass only excavates and never manufactures support or a ceiling", () => {
  const col = {
    top: 36,
    entrance: { low: 22, high: 27 },
    profile: BIOME_PROFILES.forest,
  };
  for (const id of [B.AIR, B.STONE, B.MOSS, B.WATER, B.SCULK]) {
    for (let y = 1; y <= col.top; y++)
      assert.equal(
        carveEntrance(id, col, y),
        y >= col.entrance.low && y <= col.entrance.high ? B.AIR : id
      );
  }
});

test("real cave voxels agree across negative chunk seams and wide-region generation", () => {
  const generator = createGenerator("123");
  const found = findFeature(
    generator,
    generator.getSpawn(),
    (feature) => feature.mouth.x < 0 && feature.mouth.z < 0
  );
  assert.ok(found);
  const { feature } = found;
  const seam = feature.path.find(
    (point, i) =>
      i > 8 &&
      i < feature.length - 8 &&
      (feature.direction.x ? point.x % 16 === 0 : point.z % 16 === 0)
  );
  assert.ok(seam, "use an actual passage crossing a negative chunk boundary");
  const cx = Math.floor(seam.x / 16);
  const cz = Math.floor(seam.z / 16);
  const minX = (cx - 1) * 16;
  const minZ = (cz - 1) * 16;
  const whole = generator.generateRegion(minX, minZ, 32, 32);
  const at = seam.low * 1024 + (seam.z - minZ) * 32 + seam.x - minX;
  assert.equal(whole.blocks[at], B.AIR);
  assert.ok(isSolid(whole.blocks[at - 1024]));
  for (const [dx, dz] of [
    [1, 1],
    [0, 0],
    [1, 0],
    [0, 1],
  ]) {
    const other = createGenerator("123");
    other.getCaveEntrances(20000, -16000);
    const chunk = other.generateChunk(cx - 1 + dx, cz - 1 + dz);
    for (let y = 0; y < WORLD_HEIGHT; y++)
      for (let z = 0; z < 16; z++) {
        const source = y * 256 + z * 16;
        const target = y * 1024 + (z + dz * 16) * 32 + dx * 16;
        assert.deepEqual(
          chunk.blocks.subarray(source, source + 16),
          whole.blocks.subarray(target, target + 16)
        );
      }
    for (let z = 0; z < 16; z++)
      assert.deepEqual(
        chunk.biomes.subarray(z * 16, z * 16 + 16),
        whole.biomes.subarray(
          (z + dz * 16) * 32 + dx * 16,
          (z + dz * 16) * 32 + dx * 16 + 16
        )
      );
  }
});

test("entrance planning rejects river cuts, oceans and underground sulfur pools", () => {
  const salt = seedHash("dry-cave-banks");
  const surface = (x, z) => ({
    x,
    z,
    top: 44,
    id: "forest",
    profile: BIOME_PROFILES.forest,
  });
  const make = (sample) =>
    createCaveGenerator({
      salt,
      surface: sample,
      waterLevel: WATER_LEVEL,
      validXZ,
    });
  const planner = make(surface);
  const found = findFeature(
    { getCaveEntrances: planner.getFeatures },
    { x: 0, z: 0 }
  );
  assert.ok(found);
  const { gx, gz, feature } = found;
  const midX = (feature.mouth.x + feature.chamber.x) / 2;
  const wet = make((x, z) => ({
    ...surface(x, z),
    ...(Math.abs(x - midX) <= 4 ? { top: WATER_LEVEL - 2, id: "river" } : {}),
  }));
  assert.deepEqual(
    wet.getFeatures(gx, gz),
    [],
    "even a narrow river crossing blocks the full feature"
  );
  for (const patch of [
    { id: "ocean", top: WATER_LEVEL - 8 },
    { id: "frozen_river", top: WATER_LEVEL - 2 },
    { sulfur: { open: true, pool: true } },
  ])
    assert.deepEqual(
      make((x, z) => ({ ...surface(x, z), ...patch })).getFeatures(gx, gz),
      []
    );
});

test("generated river and ocean beds, water surfaces and bedrock remain intact", () => {
  const generator = createGenerator("cedar-valley");
  for (const id of ["river", "ocean", "frozen_river"]) {
    const point = generator.locateBiome(id);
    assert.ok(point, id);
    const chunk = generator.generateChunk(
      Math.floor(point.x / 16),
      Math.floor(point.z / 16)
    );
    let wetColumns = 0;
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) {
        const index = z * 16 + x;
        const top = generator.terrainHeight(
          chunk.cx * 16 + x,
          chunk.cz * 16 + z
        );
        assert.equal(chunk.blocks[index], B.BEDROCK);
        if (top >= WATER_LEVEL) continue;
        wetColumns++;
        assert.ok(
          isSolid(chunk.blocks[top * 256 + index]),
          "solid submerged bed"
        );
        assert.ok(
          [B.WATER, B.ICE].includes(chunk.blocks[WATER_LEVEL * 256 + index])
        );
      }
    assert.ok(wetColumns > 0, id);
  }
});

test("far-coordinate cave plans survive cache eviction without order-dependent geometry", () => {
  const salt = seedHash("distant-cave-order");
  const surface = (x, z) => ({
    x,
    z,
    top: 44,
    id: "forest",
    profile: BIOME_PROFILES.forest,
  });
  const make = () =>
    createCaveGenerator({
      salt,
      surface,
      waterLevel: WATER_LEVEL,
      validXZ,
    });
  const first = make();
  const found = findFeature(
    { getCaveEntrances: first.getFeatures },
    { x: -1700000, z: 1300000 }
  );
  assert.ok(found);
  const { gx, gz, feature } = found;
  assert.ok(feature.mouth.x < -1000000 && feature.mouth.z > 1000000);
  const point = feature.path[Math.floor(feature.length / 2)];
  const col = {
    ...surface(point.x, point.z),
    caves: [
      [8, 13],
      [17, 31],
    ],
  };
  const expected = first.column(col);
  assert.ok(expected.entrance);
  const second = make();
  for (let i = 0; i < 600; i++) {
    first.getFeatures(gx + i + 10, gz + 20);
    second.getFeatures(gx + 609 - i, gz + 20);
  }
  assert.ok(first.cacheSize <= 512 && second.cacheSize <= 512);
  assert.deepEqual(first.getFeatures(gx, gz), [feature]);
  assert.deepEqual(first.column(col), expected);
  assert.deepEqual(second.column(col), expected);
});

test("new surface cave features never run for saved v1/v2 terrain or other dimensions", () => {
  for (const [version, dimension] of [
    [1, "overworld"],
    [2, "overworld"],
    [3, "nether"],
    [3, "end"],
  ]) {
    const generator = createGenerator("cedar-valley", dimension, version);
    for (const [gx, gz] of [
      [0, 0],
      [-2, -3],
      [16000, -18000],
    ])
      assert.deepEqual(generator.getCaveEntrances(gx, gz), []);
  }
});
