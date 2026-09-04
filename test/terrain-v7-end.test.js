import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK as B } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import { createNativeTerrainV7 } from "../src/terrain-v7.js";
import { readV4RegionCell } from "../src/terrain-v4-writer.js";
import { centralOutline, hollowSpill } from "./terrain-v7-profiles.js";

for (const seed of ["cedar-valley", "mineslop-audit-2", ""]) {
  test(`v7 enclosed hollows, solid floors, traversable spawn and pillar foundations ${JSON.stringify(seed)}`, () => {
    const gen = createNativeTerrainV7(seed, "end");
    const { bowls } = gen.getEndTerrainPlan();
    const profiles = [];
    for (const bowl of bowls) {
      const cx = Math.round(bowl.x), cz = Math.round(bowl.z);
      const center = gen.sampleColumn(cx, cz);
      const rim = Array.from({ length: 72 }, (_, i) => {
        const a = i * Math.PI / 36;
        return gen.sampleColumn(Math.round(bowl.x + Math.cos(a) * bowl.radius),
          Math.round(bowl.z + Math.sin(a) * bowl.radius));
      });
      const enclosedDepth = Math.min(...rim.map((col) => col.top)) - center.top;
      assert.ok(enclosedDepth >= 10, `enclosed depth ${enclosedDepth}`);
      const spill = hollowSpill(gen, bowl);
      assert.ok(spill.depth >= 10, `lowest escape path rises ${spill.depth}`);
      const region = gen.generateRegion(cx - 16, cz - 16, 32, 32);
      let minimumThickness = Infinity;
      for (let z = cz - 16; z < cz + 16; z++) for (let x = cx - 16; x < cx + 16; x++) {
        const col = gen.sampleColumn(x, z);
        minimumThickness = Math.min(minimumThickness, col.top - col.bottom + 1);
        assert.ok(col.top - col.bottom >= 15, "no breached hollow floor");
        for (let y = col.bottom; y <= col.top; y++)
          assert.equal(readV4RegionCell(region, x, y, z).id, B.END_STONE);
        assert.equal(readV4RegionCell(region, x, col.bottom - 1, z).id, B.AIR);
      }
      const transect = [];
      for (let dx = -Math.ceil(bowl.radius * 1.6); dx <= bowl.radius * 1.6; dx += 4)
        transect.push([cx + dx, cz, gen.surfaceYAt(cx + dx, cz)]);
      profiles.push({ center: [cx, center.top, cz], radius: bowl.radius,
        enclosedDepth, spill, minimumThickness, transect });
    }
    const spawn = gen.getSpawn();
    assert.deepEqual([spawn.x, spawn.z], [0.5, 0.5]);
    const pad = gen.generateRegion(-8, -8, 16, 16);
    const spawnY = Math.floor(spawn.y);
    for (let z = -5; z <= 5; z++) for (let x = -5; x <= 5; x++) {
      assert.equal(readV4RegionCell(pad, x, spawnY - 1, z).id, B.END_STONE);
      assert.equal(readV4RegionCell(pad, x, spawnY, z).id, B.AIR);
      assert.equal(readV4RegionCell(pad, x, spawnY + 1, z).id, B.AIR);
    }
    const outline = centralOutline(gen);
    assert.ok(Math.max(...outline) - Math.min(...outline) >= 20);
    console.log(JSON.stringify({ seed, spawn, profiles, outline }));
  });

  test(`v7 ten real native pillars and caps exactly match authoritative masks ${JSON.stringify(seed)}`, () => {
    const gen = createNativeTerrainV7(seed, "end");
    const pillars = gen.getEndPillars();
    assert.equal(pillars.length, 10);
    assert.equal(gen.counters.voxelVisits, 0, "pure descriptor queries");
    assert.equal(gen.counters.chunkGenerations, 0);
    let totalObsidian = 0;
    for (const pillar of pillars) {
      assert.equal(pillar.generatorVersion, 7);
      const region = gen.generateRegion(pillar.x - 4, pillar.z - 4, 9, 9);
      let obsidian = 0, caps = 0, mask = 0;
      for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
        const x = pillar.x + dx, z = pillar.z + dz;
        assert.equal(gen.surfaceYAt(x, z), pillar.base, "flat anchored plinth");
        assert.equal(readV4RegionCell(region, x, pillar.base, z).id, B.END_STONE);
        let hasBody = false;
        for (let y = 0; y < 256; y++) {
          const actual = readV4RegionCell(region, x, y, z).id;
          if (actual === B.OBSIDIAN) { obsidian++; hasBody = true; }
          if (actual === B.GLOWSTONE) caps++;
          const member = pillar.body.columns.some(([px, pz]) => px === dx && pz === dz);
          if (y > pillar.base)
            assert.equal(actual, member && y <= pillar.top ? B.OBSIDIAN :
              dx === 0 && dz === 0 && y === pillar.top + 1 ? B.GLOWSTONE : B.AIR);
        }
        if (hasBody) mask |= 1 << ((dz + 2) * 5 + dx + 2);
      }
      assert.equal(mask, pillar.body.columnMask);
      assert.equal(obsidian, pillar.body.blockCount);
      assert.equal(caps, 1);
      assert.equal(pillar.cap.y, pillar.top + 1);
      totalObsidian += obsidian;
    }
    console.log(JSON.stringify({ seed, totalObsidian, caps: pillars.length,
      pillars: pillars.map(({ id, x, z, base, top }) => ({ id, x, z, base, top })) }));
  });

  test(`v7 one-block-step routes from spawn to bowl floors and every pillar approach ${JSON.stringify(seed)}`, () => {
    const gen = createNativeTerrainV7(seed, "end"), side = 257, half = 128;
    const at = (x, z) => (z + half) * side + x + half;
    const heights = new Int16Array(side * side), parents = new Int32Array(side * side).fill(-1);
    const pillars = gen.getEndPillars();
    for (let z = -half; z <= half; z++) for (let x = -half; x <= half; x++)
      heights[at(x, z)] = gen.surfaceYAt(x, z) ?? -1000;
    for (const pillar of pillars)
      for (const [dx, dz] of pillar.body.columns) heights[at(pillar.x + dx, pillar.z + dz)] = -1000;
    const queue = [at(0, 0)];
    parents[queue[0]] = queue[0];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i], x = current % side - half, z = Math.floor(current / side) - half;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (Math.abs(nx) > half || Math.abs(nz) > half) continue;
        const next = at(nx, nz);
        if (parents[next] !== -1 || heights[next] < 0 || Math.abs(heights[next] - heights[current]) > 1) continue;
        parents[next] = current; queue.push(next);
      }
    }
    const targets = [...gen.getEndTerrainPlan().bowls.map(({ x, z }) => [x, z]),
      ...pillars.map(({ x, z }) => [x + 4, z])];
    const routes = [];
    for (const [x, z] of targets) {
      let cursor = at(x, z), steps = 0;
      assert.notEqual(parents[cursor], -1, `no walking route to ${x},${z}`);
      while (cursor !== at(0, 0)) {
        const px = cursor % side - half, pz = Math.floor(cursor / side) - half, y = heights[cursor];
        assert.equal(gen.getNaturalBlock(px, y, pz), B.END_STONE);
        assert.equal(gen.getNaturalBlock(px, y + 1, pz), B.AIR);
        assert.equal(gen.getNaturalBlock(px, y + 2, pz), B.AIR);
        cursor = parents[cursor]; steps++;
      }
      routes.push({ x, z, steps });
    }
    console.log(JSON.stringify({ seed, reachableCoreColumns: queue.length, routes }));
  });
}

test("v7 retains v6 outer End cells and legacy4–6 do not acquire phantom pillars", () => {
  const gen = createNativeTerrainV7("cedar-valley", "end");
  for (const version of [4, 5, 6]) {
    const old = createGenerator("cedar-valley", "end", version);
    assert.deepEqual(old.getEndPillars?.() ?? [], []);
  }
  const old = createGenerator("cedar-valley", "end", 6);
  for (const [x, z] of [[-592, -784], [-128, -816], [512, 0], [1600, -2048]]) {
    assert.deepEqual(gen.sampleColumn(x, z), old.sampleColumn(x, z));
    assert.deepEqual(gen.generateRegion(x, z, 16, 16), old.generateRegion(x, z, 16, 16));
  }
});

test("v7 seed-varied foundations cannot be shaved by an asymmetric coastline", () => {
  for (let i = 0; i < 32; i++) {
    const gen = createNativeTerrainV7(`v7-foundation-${i}`, "end");
    for (const p of gen.getEndPillars()) {
      assert.ok(p.cap.y < gen.maxY);
      for (const [dx, dz] of p.body.columns)
        assert.equal(gen.surfaceYAt(p.x + dx, p.z + dz), p.base);
    }
    for (const bowl of gen.getEndTerrainPlan().bowls) {
      const col = gen.sampleColumn(bowl.x, bowl.z);
      assert.ok(col.top - col.bottom >= 16);
    }
  }
});
