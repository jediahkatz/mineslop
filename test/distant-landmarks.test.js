import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import { DistantLandmarks, landmarkDetailSections } from "../src/distant-landmarks.js";

function fixture(version = 3, seed = "cedar-valley") {
  const generator = createGenerator(seed, "end", version);
  const world = {
    generator, generatorVersion: version, seed, dimension: "end",
    ...(generator.spec ? { spec: generator.spec } : {}),
    edits: new Map(), _editRevision: 0, chunks: new Map(),
    get() { assert.fail("visual landmarks must never load/read world voxels"); },
    ensureArea() { assert.fail("visual landmarks must never generate chunks"); },
  };
  const lod = new DistantLandmarks(new THREE.Group(), world);
  return { world, lod, generator };
}
function finish(lod) {
  for (let i = 0; i < 300 &&
      (!lod.group.children.length || lod.pendingRebuild || lod.job); i++) {
    lod.update({ budgetMs: 2 });
    assert.ok(lod.lastColumns <= 4);
  }
  assert.equal(lod.group.children.length, 2);
}
function voxels(lod) {
  const result = new Map();
  for (const child of lod.group.children) {
    const source = child.userData.landmarkSource;
    const p = child.geometry.attributes.position;
    for (const part of source.parts) {
      if (part.invalid) continue;
      const ids = source.indices.subarray(part.start, part.start + part.count);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const id of ids)
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], p.array[id * 3 + axis]);
          max[axis] = Math.max(max[axis], p.array[id * 3 + axis]);
        }
      for (let y = min[1]; y < max[1]; y++)
        for (let z = min[2]; z < max[2]; z++)
          for (let x = min[0]; x < max[0]; x++)
            result.set(`${x},${y},${z}`, part.nativeId);
    }
  }
  return result;
}

for (const version of [1, 2, 3]) {
  test(`v${version}: ten distant pillar footprints, caps and buried bases exactly match native voxels`, () => {
    const { lod, world, generator } = fixture(version);
    try {
      finish(lod);
      const actual = voxels(lod), expected = new Map();
      for (const pillar of generator.getEndPillars()) {
        const region = generator.generateRegion(pillar.x - 2, pillar.z - 2, 5, 5);
        for (let y = 0; y < 96; y++)
          for (let z = 0; z < 5; z++)
            for (let x = 0; x < 5; x++) {
              const id = region.blocks[y * 25 + z * 5 + x];
              if (id === BLOCK.OBSIDIAN || id === BLOCK.GLOWSTONE)
                expected.set(`${pillar.x - 2 + x},${y},${pillar.z - 2 + z}`, id);
            }
      }
      assert.deepEqual(actual, expected);
      assert.equal(lod.group.userData.renderablePillars, 10);
      assert.equal(world.chunks.size, 0);
    } finally { lod.dispose(); }
  });
}

for (const seed of ["cedar-valley", "mineslop-audit-2", ""]) {
  test(`v7 ${JSON.stringify(seed)}: authoritative masks match all native blocks above and below Y96`, () => {
    const { lod, generator, world } = fixture(7, seed);
    try {
      generator.terrainHeight = () => assert.fail("authoritative bodies do not need height queries");
      finish(lod);
      const expected = new Map();
      let bodyCount = 0;
      for (const pillar of generator.getEndPillars()) {
        bodyCount += pillar.body.blockCount;
        const region = generator.generateRegion(pillar.x - 2, pillar.z - 2, 5, 5);
        for (let y = world.spec.minY; y < world.spec.maxY; y++)
          for (let dz = 0; dz < 5; dz++)
            for (let dx = 0; dx < 5; dx++) {
              const id = region.blocks[(y - world.spec.minY) * 25 + dz * 5 + dx];
              if (id === BLOCK.OBSIDIAN || id === BLOCK.GLOWSTONE)
                expected.set(`${pillar.x - 2 + dx},${y},${pillar.z - 2 + dz}`, id);
            }
      }
      assert.deepEqual(voxels(lod), expected);
      assert.equal(expected.size, bodyCount + 10);
      assert.equal(lod.group.userData.renderablePillars, 10);
      assert.equal(lod.group.children[1].geometry.boundingBox.max.y,
        Math.max(...generator.getEndPillars().map((p) => p.cap.y)) + 1);
      assert.equal(world.chunks.size, 0);
      // A high native cap is cut only by its own visible section.
      const cap = generator.getEndPillars()[0].cap;
      const section = `${Math.floor(cap.x / 16)},${Math.floor(cap.z / 16)},${Math.floor(cap.y / 16)}`;
      lod.update({ detailSections: new Set([section]), budgetMs: 0 });
      assert.equal(lod.group.children[1].geometry.drawRange.count, 9 * 36);
      lod.update({ budgetMs: 0 });
      assert.equal(lod.group.children[1].geometry.drawRange.count, 10 * 36);
    } finally { lod.dispose(); }
  });
}

test("authoritative non-legacy mask, block IDs, independent cap and world-spec bounds are consumed", () => {
  const { lod, world } = fixture(7);
  world.spec = { minY: 120, maxY: 133 };
  world.generator.getEndPillars = () => [{
    id: 0, x: 0, z: 0, base: 0, top: 2,
    body: { block: BLOCK.STONE, minY: 130, maxY: 134, columns: [[2, 2]], columnMask: 1 << 24, blockCount: 4 },
    cap: { block: BLOCK.GLOWSTONE, x: 0, y: 132, z: 0 },
  }];
  world.generator.terrainHeight = () => assert.fail("no legacy re-derivation");
  try {
    finish(lod);
    assert.deepEqual(voxels(lod), new Map([
      ["2,130,2", BLOCK.STONE], ["2,131,2", BLOCK.STONE], ["2,132,2", BLOCK.STONE],
      ["0,132,0", BLOCK.GLOWSTONE],
    ]));
    world.spec = { minY: 120, maxY: 132 };
    lod.update({ budgetMs: 0 });
    finish(lod);
    assert.equal(voxels(lod).size, 2, "spec changes invalidate old upper geometry");
  } finally { lod.dispose(); }
});

test("fragmented v7 bodies and deletion of a Y132 cap remain bounded after eviction", () => {
  const { lod, world, generator } = fixture(7, "");
  try {
    finish(lod);
    const expected = voxels(lod);
    for (const [key, block] of expected) {
      const y = Number(key.split(",")[1]);
      if ((block === BLOCK.OBSIDIAN && y % 2) || (block === BLOCK.GLOWSTONE && y === 132)) {
        world.edits.set(`end:${key}`, { id: BLOCK.AIR });
        expected.delete(key);
      }
    }
    world._editRevision++;
    lod.update({ budgetMs: 0 });
    finish(lod);
    assert.deepEqual(voxels(lod), expected);
    assert.ok(generator.getEndPillars().some((p) => p.cap.y === 132));
    const body = lod.group.children[0].geometry;
    assert.ok(body.attributes.position.count <= 200000 && body.index.count <= 300000);
    assert.ok(body.attributes.position.array.every(Number.isFinite));
    assert.equal(world.chunks.size, 0);
  } finally { lod.dispose(); }
});

test("v4–v6 do not invent legacy pillars", () => {
  for (const version of [4, 5, 6]) {
    const { lod, generator } = fixture(version);
    assert.equal(generator.getEndPillars, undefined);
    for (let i = 0; i < 3; i++) lod.update({ budgetMs: 2 });
    assert.equal(lod.group.children.length, 0);
    lod.dispose();
  }
});

test("known deletions and replacements never resurrect pristine pillar voxels after eviction", () => {
  const { lod, world } = fixture();
  try {
    finish(lod);
    const expected = voxels(lod);
    let i = 0;
    for (const [key, id] of expected) {
      if (id === BLOCK.GLOWSTONE || i++ % 7 === 0) {
        world.edits.set(`end:${key}`, { id: i % 2 ? BLOCK.AIR : BLOCK.STONE });
        expected.delete(key);
      }
    }
    world._editRevision++;
    lod.update({ budgetMs: 0 });
    assert.ok(lod.pendingRebuild, "edited geometry is rebuilt while unaffected parts remain");
    finish(lod);
    assert.deepEqual(voxels(lod), expected);
    assert.equal(world.chunks.size, 0);
  } finally { lod.dispose(); }
});

test("partial column/section coverage clips only owned voxel volumes and restores without rebuilding", () => {
  const { lod } = fixture();
  try {
    finish(lod);
    const child = lod.group.children[0];
    const source = child.userData.landmarkSource;
    const parts = source.parts;
    const section = parts[0].section;
    const before = child.geometry.attributes.position;
    lod.update({ detailSections: new Set([section]), budgetMs: 0 });
    assert.equal(child.geometry.drawRange.count, parts.filter((p) => p.section !== section).reduce((sum, p) => sum + p.count, 0));
    const column = parts[0].column;
    lod.update({ coverage: new Set([column]), budgetMs: 0 });
    assert.equal(child.geometry.drawRange.count, parts.filter((p) => p.column !== column).reduce((sum, p) => sum + p.count, 0));
    lod.update({ budgetMs: 0 });
    assert.equal(child.geometry.drawRange.count, source.indices.length);
    assert.equal(child.geometry.attributes.position, before);
    assert.equal(lod.group.userData.renderablePillars, 10);
    assert.equal(lod.lastColumns, 0);
  } finally { lod.dispose(); }
});

test("deleting an entire unloaded pillar removes its body and glowstone cap", () => {
  const { lod, world, generator } = fixture();
  try {
    finish(lod);
    const pillar = generator.getEndPillars()[0];
    const expected = voxels(lod);
    for (const key of expected.keys()) {
      const [x, , z] = key.split(",").map(Number);
      if (Math.abs(x - pillar.x) <= 2 && Math.abs(z - pillar.z) <= 2) {
        world.edits.set(`end:${key}`, { id: BLOCK.AIR });
        expected.delete(key);
      }
    }
    world._editRevision++;
    lod.update({ budgetMs: 0 });
    assert.equal(lod.group.userData.renderablePillars, 9, "only the edited pillar disappears during rebuilding");
    finish(lod);
    assert.deepEqual(voxels(lod), expected);
    assert.equal(lod.group.userData.renderablePillars, 9);
    assert.equal(world.chunks.size, 0);
  } finally { lod.dispose(); }
});

test("section ownership includes completed empty sections, excludes hidden or pending ones", () => {
  const scene = new THREE.Scene(), column = new THREE.Group(), section = new THREE.Group();
  scene.add(column); column.add(section);
  column.userData.sections = new Map([[2, { group: section, draws: 0 }]]);
  assert.deepEqual([...landmarkDetailSections(new Map([["1,-2", column]]))], ["1,-2,2"]);
  section.visible = false;
  assert.equal(landmarkDetailSections(new Map([["1,-2", column]])).size, 0);
  section.visible = true;
  const pending = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  section.add(pending);
  column.userData.sections.get(2).draws = 1;
  assert.equal(landmarkDetailSections(new Map([["1,-2", column]])).size, 0,
    "a mesh with no addressable draw indices is not coverage");
  pending.geometry.dispose();
  pending.material.dispose();
});

test("buffer finalization stays detached, advances one attribute per update, and cancels cleanly", () => {
  const { lod, world } = fixture();
  try {
    for (let i = 0; i < 300 && !lod.job?.finalizer; i++) lod.update({ budgetMs: 2 });
    assert.ok(lod.job?.finalizer);
    assert.equal(lod.group.children.length, 0);
    const staged = lod.job.geometries[0];
    assert.deepEqual(Object.keys(staged.attributes), ["position"]);
    lod.update({ budgetMs: 2 });
    assert.deepEqual(Object.keys(staged.attributes), ["position", "normal"]);
    let disposed = 0;
    staged.addEventListener("dispose", () => disposed++);
    world._editRevision++;
    lod.update({ budgetMs: 0 });
    assert.equal(disposed, 1);
    assert.equal(lod.group.children.length, 0);
    finish(lod);
    assert.equal(lod.group.userData.renderablePillars, 10);
  } finally { lod.dispose(); }
});

test("unrelated End edits do not rebuild or blink any native pillar", () => {
  const { lod, world, generator } = fixture();
  try {
    finish(lod);
    const body = lod.group.children[0];
    world.edits.set("end:200,50,200", { id: BLOCK.STONE });
    world._editRevision++;
    lod.update({ budgetMs: 2 });
    assert.equal(lod.job, null);
    assert.equal(lod.pendingRebuild, false);
    assert.equal(lod.group.children[0], body);
    assert.equal(lod.group.userData.renderablePillars, 10);
    const pillar = generator.getEndPillars()[0];
    world.edits.set(`end:${pillar.x},${pillar.top + 1},${pillar.z}`, { id: BLOCK.AIR });
    world._editRevision++;
    lod.update({ budgetMs: 0 });
    assert.equal(lod.group.children[0], body, "all unedited bodies remain published during cap rebuild");
    assert.equal(lod.group.userData.renderablePillars, 10);
    assert.equal(lod.group.children[1].geometry.drawRange.count, 9 * 36);
    finish(lod);
    assert.equal(lod.group.userData.renderablePillars, 10);
    world.edits.delete(`end:${pillar.x},${pillar.top + 1},${pillar.z}`);
    world._editRevision++;
    lod.update({ budgetMs: 0 });
    finish(lod);
    assert.equal(lod.group.children[1].geometry.drawRange.count, 10 * 36);
  } finally { lod.dispose(); }
});
