import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK as B, BLOCKS, isSolid } from "../src/blocks.js";
import { seedHash } from "../src/noise.js";
import { collidesWithWorld, MAX_LOOK_PITCH } from "../src/player.js";
import { restorePlayerSave } from "../src/player-save.js";
import { createGenerator, WATER_LEVEL, WORLD_HEIGHT } from "../src/terrain.js";
import { sampleCaveIntervals } from "../src/terrain-cave-field.js";
import { findSafeLanding } from "../src/world-interactions.js";

// The actual unedited v3 export, not a replacement cave chosen by the locator.
// Before the fix: 2304/2304 air columns, one 2044-cell level floor at y=14,
// 1656 air voxels filled by the entrance, and 47 full-cube ceiling lights.
const seed = "cedar-valley";
const pose = {
  x: 51.72456985726503,
  y: 14,
  z: 985.9955537517508,
  yaw: -408.7213600000016,
  pitch: 0.02042000000033284,
};
const size = 48;
const area = size * size;
const minX = 27;
const minZ = 961;
const vineIds = new Set([B.CAVE_VINE, B.GLOW_BERRIES]);
const passable = (id) =>
  id !== undefined && !isSolid(id) && id !== B.WATER && id !== B.LAVA;
const histogram = (values) => {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

let fixture;
function userScene() {
  if (fixture) return fixture;
  const generator = createGenerator(seed, "overworld", 3);
  const data = generator.generateRegion(minX, minZ, size, size);
  const contains = (x, z) =>
    x >= minX && x < minX + size && z >= minZ && z < minZ + size;
  const get = (x, y, z) =>
    y < 0 || y >= WORLD_HEIGHT || !contains(x, z)
      ? B.AIR
      : data.blocks[y * area + (z - minZ) * size + x - minX];
  const view = {
    get,
    getBiome: (x, z, y) => generator.getBiome(x, z, y),
    isLoaded: contains,
    isSolid: (x, y, z) => isSolid(get(x, y, z)),
    set() {
      throw new Error("Scene inspection must never build a landing platform");
    },
  };
  const columns = [];
  const floors = [];
  let openColumns = 0;
  let filledNativeAir = 0;
  const salt = seedHash(seed);
  for (let z = minZ; z < minZ + size; z++) {
    for (let x = minX; x < minX + size; x++) {
      const top = generator.terrainHeight(x, z);
      const caves = sampleCaveIntervals(x, z, top, salt, WATER_LEVEL);
      columns.push({ x, z, top, caves });
      let open = false;
      for (let y = 2; y <= top - 5; y++) {
        if (get(x, y, z) === B.AIR) open = true;
        if (
          isSolid(get(x, y, z)) &&
          caves.some(([low, high]) => y >= low && y <= high)
        )
          filledNativeAir++;
        if (
          !isSolid(get(x, y - 1, z)) ||
          !passable(get(x, y, z)) ||
          !passable(get(x, y + 1, z))
        )
          continue;
        let ceiling = y + 2;
        while (ceiling <= top && !isSolid(get(x, ceiling, z))) ceiling++;
        floors.push({
          x,
          y,
          z,
          ceiling,
          top,
          support: get(x, y - 1, z),
          roof: get(x, ceiling, z),
        });
      }
      if (open) openColumns++;
    }
  }
  const remaining = new Map(floors.map((p) => [`${p.x},${p.y},${p.z}`, p]));
  let largestFlat = 0;
  while (remaining.size) {
    const [key, start] = remaining.entries().next().value;
    remaining.delete(key);
    const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const here = queue[cursor];
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const key = `${here.x + dx},${here.y},${here.z + dz}`;
        const next = remaining.get(key);
        if (!next) continue;
        remaining.delete(key);
        queue.push(next);
      }
    }
    largestFlat = Math.max(largestFlat, queue.length);
  }
  const upper = floors.filter((p) => p.y > 12 && p.ceiling <= p.top - 3);
  fixture = {
    generator,
    data,
    view,
    get,
    columns,
    floors,
    upper,
    openColumns,
    filledNativeAir,
    largestFlat,
  };
  return fixture;
}

test("the exact reported cave has rock boundaries, uneven floors and varied intact roofs", (t) => {
  const scene = userScene();
  const {
    get,
    view,
    floors,
    upper,
    openColumns,
    filledNativeAir,
    largestFlat,
  } = scene;
  assert.ok(
    openColumns > area * 0.2,
    "retain substantial caves in the actual user region"
  );
  assert.ok(
    openColumns < area * 0.9,
    "real rock masses interrupt the old wall-to-wall air sheet"
  );
  assert.ok(
    upper.length > 400,
    "do not replace the reported cavern with solid ground"
  );
  assert.ok(
    largestFlat < area * 0.25,
    `largest connected level floor: ${largestFlat}`
  );
  const floorLevels = new Set(upper.map((p) => p.y));
  const roofLevels = new Set(upper.map((p) => p.ceiling));
  assert.ok(
    floorLevels.size >= 6 &&
      Math.max(...floorLevels) - Math.min(...floorLevels) >= 6
  );
  assert.ok(
    roofLevels.size >= 5,
    "the actual ceilings vary too, not just a noisy floor overlay"
  );
  assert.ok(new Set(upper.map((p) => p.ceiling - p.y)).size >= 4);
  assert.ok(upper.filter((p) => p.support === B.MOSS).length > 50);
  assert.ok(upper.filter((p) => p.support === B.STONE).length > 50);
  assert.ok(upper.filter((p) => p.roof === B.STONE).length > 50);
  assert.equal(
    filledNativeAir,
    0,
    "the entrance must not refill the original v3 cavity volume"
  );
  for (const { x, z } of scene.columns) assert.equal(get(x, 0, z), B.BEDROCK);

  const localFloors = upper.filter(
    (p) => p.x === Math.floor(pose.x) && p.z === Math.floor(pose.z)
  );
  assert.ok(
    localFloors.length,
    "the saved column still contains a real underground room"
  );
  const nearbyY = localFloors[0].y;
  let nearRock = 0;
  let nearAir = 0;
  for (let z = Math.floor(pose.z) - 8; z <= Math.floor(pose.z) + 8; z++)
    for (let x = Math.floor(pose.x) - 8; x <= Math.floor(pose.x) + 8; x++) {
      if (isSolid(get(x, nearbyY, z))) nearRock++;
      if (passable(get(x, nearbyY, z))) nearAir++;
    }
  assert.ok(
    nearRock > 8 && nearAir > 8,
    "boundaries are near the original camera, not only at the map edge"
  );

  const sameViewLanding = localFloors
    .map((p) => ({ x: pose.x, y: p.y + 0.01, z: pose.z }))
    .find((point) => !collidesWithWorld(view, point));
  const nearest = [...upper].sort(
    (a, b) =>
      Math.hypot(a.x + 0.5 - pose.x, a.y - pose.y, a.z + 0.5 - pose.z) -
      Math.hypot(b.x + 0.5 - pose.x, b.y - pose.y, b.z + 0.5 - pose.z)
  )[0];
  const cloneLanding = sameViewLanding ?? {
    x: nearest.x + 0.5,
    y: nearest.y + 0.01,
    z: nearest.z + 0.5,
  };
  assert.equal(collidesWithWorld(view, cloneLanding), false);
  t.diagnostic(
    JSON.stringify({
      seed,
      generatorVersion: 3,
      bounds: { minX, minZ, size },
      openColumns,
      largestFlat,
      filledNativeAir,
      floors: histogram(upper.map((p) => p.y)),
      roofs: histogram(upper.map((p) => p.ceiling)),
      originalPose: pose,
      originalPoseCollides: collidesWithWorld(view, pose),
      originalColumnFloors: floors.filter((p) => p.x === 51 && p.z === 985),
      normalImportLanding: findSafeLanding(view, pose),
      ownedCloneUndergroundLanding: {
        ...cloneLanding,
        yaw: pose.yaw,
        pitch: pose.pitch,
      },
      note: "Read-only suggestions; no browser, saved pose, inventory or world changed",
    })
  );
});

test("the original cave save restores to nearby underground support and keeps its exact view direction", () => {
  const { view, generator } = userScene();
  const landing = findSafeLanding(view, pose, {
    preferUnderground: true,
    allowFlying: true,
  });
  assert.ok(Math.hypot(landing.x - pose.x, landing.z - pose.z) < 1);
  assert.equal(
    generator.getBiome(landing.x, landing.z, landing.y).id,
    "lush_caves"
  );
  assert.equal(collidesWithWorld(view, landing), false);
  assert.ok(landing.y < generator.terrainHeight(landing.x, landing.z) - 3);
  const player = {
    position: { x: 0, y: 0, z: 0 },
    setPosition(point) {
      this.position = point;
    },
  };
  assert.equal(
    restorePlayerSave(
      player,
      view,
      { ...pose, flying: false },
      {
        fallbackPosition: landing,
      }
    ),
    true
  );
  assert.deepEqual(player.position, landing);
  assert.equal(player.yaw, pose.yaw);
  assert.equal(player.pitch, pose.pitch);
  assert.equal(player.flying, false);
  for (const pitch of [-Math.PI, Math.PI]) {
    const saved = { ...pose, pitch, flying: false };
    const before = { ...saved };
    assert.equal(
      restorePlayerSave(player, view, saved, { fallbackPosition: landing }),
      true
    );
    assert.deepEqual(player.position, landing);
    assert.equal(player.yaw, pose.yaw);
    assert.equal(player.pitch, Math.sign(pitch) * MAX_LOOK_PITCH);
    assert.equal(player.flying, false);
    assert.deepEqual(saved, before);
  }
});

test("the reported lush ceiling uses real rooted vine chains, not scattered glowstone cubes", (t) => {
  const { columns, get } = userScene();
  let vines = 0;
  let chains = 0;
  let berries = 0;
  let glowstone = 0;
  const lengths = new Set();
  for (const { x, z, top } of columns) {
    for (let y = 2; y <= top - 4; y++) {
      const id = get(x, y, z);
      if (id === B.GLOWSTONE) glowstone++;
      if (!vineIds.has(id)) continue;
      vines++;
      if (id === B.GLOW_BERRIES) {
        berries++;
        assert.equal(
          vineIds.has(get(x, y - 1, z)),
          false,
          "berries terminate the chain"
        );
      }
      let anchor = y + 1;
      while (vineIds.has(get(x, anchor, z))) anchor++;
      assert.ok(
        isSolid(get(x, anchor, z)),
        `missing roof at ${x},${anchor},${z}`
      );
      assert.ok(anchor < top - 3 && anchor - y <= 4);
      assert.equal(
        BLOCKS[id].shape,
        "cross",
        "real plant voxels are meshed, not an overlay"
      );
      if (!vineIds.has(get(x, y - 1, z))) {
        chains++;
        lengths.add(anchor - y);
      }
    }
  }
  assert.equal(glowstone, 0);
  assert.ok(
    vines > 10 && chains > 10,
    "the user region keeps natural anchored vegetation"
  );
  // The first structural fix still produced 34 bright tips here. Removing
  // glowstone alone must not recreate that ceiling-light grid as foliage.
  assert.ok(
    berries <= 8 && berries <= Math.ceil(chains / 8),
    `rare berry-bearing chains in the exact reported scene: ${berries}/${chains}`
  );
  assert.ok(
    lengths.size >= 2,
    "hanging chains do not all end on one uniform plane"
  );
  t.diagnostic(
    JSON.stringify({
      vines,
      chains,
      berries,
      glowstone,
      chainLengths: [...lengths].sort(),
    })
  );
});

test("other seeds, negative coordinates and distant caves also bound luminous tip density", (t) => {
  let totalChains = 0;
  let totalBerries = 0;
  for (const [sampleSeed, from] of [
    ["cedar-valley", { x: -1600, z: -2200 }],
    ["birch-river", { x: 0, z: 0 }],
    ["123", { x: 1600000, z: -1300000 }],
  ]) {
    const generator = createGenerator(sampleSeed, "overworld", 3);
    const point = generator.locateBiome("lush_caves", from);
    assert.ok(point, sampleSeed);
    const left = Math.floor(point.x) - 24;
    const back = Math.floor(point.z) - 24;
    const { blocks } = generator.generateRegion(left, back, size, size);
    const at = (x, y, z) => blocks[y * area + z * size + x];
    let chains = 0;
    let berries = 0;
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const top = generator.terrainHeight(left + x, back + z);
        for (let y = 2; y <= top - 4; y++) {
          const id = at(x, y, z);
          assert.notEqual(id, B.GLOWSTONE);
          if (!vineIds.has(id)) continue;
          if (!vineIds.has(at(x, y - 1, z))) chains++;
          if (id === B.GLOW_BERRIES) {
            berries++;
            assert.equal(vineIds.has(at(x, y - 1, z)), false);
          }
          let anchor = y + 1;
          while (vineIds.has(at(x, anchor, z))) anchor++;
          assert.ok(isSolid(at(x, anchor, z)) && anchor - y <= 4);
        }
      }
    }
    assert.ok(chains > 0, `${sampleSeed}: sample includes real vine chains`);
    assert.ok(
      berries <= 12 && berries <= Math.ceil(chains / 8),
      `${sampleSeed} at ${left},${back}: ${berries}/${chains} berry-bearing chains`
    );
    totalChains += chains;
    totalBerries += berries;
    t.diagnostic(
      JSON.stringify({
        seed: sampleSeed,
        minX: left,
        minZ: back,
        size,
        chains,
        berries,
      })
    );
  }
  assert.ok(totalChains > 30 && totalBerries > 0);
});

test("the exact cave and anchored plants match independent chunks in reverse generation order", () => {
  const { data } = userScene();
  const other = createGenerator(seed, "overworld", 3);
  other.getCaveEntrances(17000, -15000);
  for (
    let cz = Math.floor((minZ + size - 1) / 16);
    cz >= Math.floor(minZ / 16);
    cz--
  ) {
    for (
      let cx = Math.floor((minX + size - 1) / 16);
      cx >= Math.floor(minX / 16);
      cx--
    ) {
      const chunk = other.generateChunk(cx, cz);
      const left = Math.max(minX, cx * 16);
      const right = Math.min(minX + size, (cx + 1) * 16);
      for (
        let z = Math.max(minZ, cz * 16);
        z < Math.min(minZ + size, (cz + 1) * 16);
        z++
      ) {
        const source = (z - cz * 16) * 16 + left - cx * 16;
        const target = (z - minZ) * size + left - minX;
        assert.deepEqual(
          chunk.biomes.subarray(source, source + right - left),
          data.biomes.subarray(target, target + right - left)
        );
        for (let y = 0; y < WORLD_HEIGHT; y++)
          assert.deepEqual(
            chunk.blocks.subarray(
              y * 256 + source,
              y * 256 + source + right - left
            ),
            data.blocks.subarray(
              y * area + target,
              y * area + target + right - left
            )
          );
      }
    }
  }
});
