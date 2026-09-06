import assert from "node:assert/strict";
import test from "node:test";
import { sectionYs, snapshotSection, getColumnLighting } from "../src/mesh-snapshot.js";
import { buildChunkGeometry } from "../src/chunk-mesh.js";
import { BLOCK } from "../src/blocks.js";
import { disposeBatches } from "../src/mesh-palette.js";
import { nativeGeometryFixture, requiredGeometryState, nativeDistribution,
  moveNativeGeometryEast } from "./regional-native-fixture.js";
import { shapeAtlas } from "./shape-fixture.js";

function triangles(geometry, palette, base = 0) {
  if (!geometry) return [];
  const result = [], floats = new Float32Array(33), bits = new Uint32Array(floats.buffer);
  const { position, normal, uv, color } = geometry.attributes;
  for (let i = 0; i < geometry.index.count; i += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = geometry.index.array[i + corner] - base;
      const slot = color.getX(vertex);
      floats.set([position.getX(vertex), position.getY(vertex), position.getZ(vertex),
        normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex),
        uv.getX(vertex), uv.getY(vertex),
        palette ? palette.component(slot, 0) : slot,
        palette ? palette.component(slot, 1) : color.getY(vertex),
        palette ? palette.component(slot, 2) : color.getZ(vertex)], corner * 11);
    }
    result.push(bits.join(","));
  }
  return result;
}

for (const [version, dimension, minY, maxY, count] of [
  [3, "overworld", 0, 96, 6], [7, "end", 0, 256, 16],
  [7, "nether", 0, 256, 16], [7, "overworld", -64, 320, 24],
]) test(`real native v${version} ${dimension} keeps its own height and section coverage`, () => {
  const fixture = nativeGeometryFixture({ version, dimension, radius: 0, legacyAdapter: false });
  try {
    assert.equal(fixture.dependencyRadius, 2);
    assert.equal(fixture.inputColumns, 25);
    assert.equal(fixture.world.chunks.size, 25);
    assert.equal(fixture.legacyRoutingAdapter, false);
    const packet = fixture.generator.generateChunk(0, 0);
    const chunk = fixture.world.chunks.get("0,0");
    // Transport normalization widens historical IDs; it must not change cells.
    assert.deepEqual(chunk.blocks, Uint16Array.from(packet.blocks));
    assert.deepEqual(chunk.biomes, packet.biomes);
    assert.deepEqual([...chunk.sections.values()], packet.sections ?? []);
    assert.equal(fixture.world.spec.minY, minY);
    assert.equal(fixture.world.spec.maxY, maxY);
    assert.equal(sectionYs(fixture.world).length, count);
    assert.ok(nativeDistribution(fixture).nonAirCells > 0);
    for (const chunk of fixture.world.chunks.values())
      assert.equal(chunk.blocks.length, (maxY - minY) * 256);
    const top = snapshotSection(fixture.world, 0, 0, maxY / 16 - 1);
    assert.equal(top.top, maxY);
    assert.equal(top.cellAt(0, maxY, 0), null);
    assert.throws(() => snapshotSection(fixture.world, 0, 0, maxY / 16), RangeError);
    assert.ok([...getColumnLighting(fixture.world, 0, 0).topOpaque]
      .every((height) => height >= minY - 1 && height < maxY));
    if (version === 3) assert.equal(fixture.nativeRoute, false);
    fixture.renderer.rebuildDirty(Infinity);
    assert.deepEqual(requiredGeometryState(fixture), {
      required: 1, requiredSections: count, covered: 1, fresh: 1,
      freshSections: count, sections: count, dirtySections: 0,
    });
    assert.ok(fixture.renderer.sectionRegions.size > 0);
  } finally { fixture.dispose(); }
});

test("travel retains the exact R+2 native input square and all-section oracle", () => {
  const progress = [];
  const fixture = nativeGeometryFixture({ version: 3, radius: 1, legacyAdapter: false,
    onGenerationProgress: (state) => progress.push(state) });
  try {
    assert.equal(fixture.dependencyRadius, 3);
    assert.equal(fixture.inputColumns, 49);
    assert.equal(progress[0].generatedColumns, 0);
    assert.equal(progress.at(-1).generatedColumns, 49);
    fixture.renderer.rebuildDirty(Infinity);
    assert.equal(requiredGeometryState(fixture).freshSections, 54);
    const retained = fixture.world.chunks.get("0,0");
    moveNativeGeometryEast(fixture);
    assert.equal(fixture.world.chunks.size, 49);
    assert.equal(fixture.world.chunks.get("0,0"), retained);
    for (let z = -3; z <= 3; z++) {
      assert.equal(fixture.world.chunks.has(`-3,${z}`), false);
      for (let x = -2; x <= 4; x++) assert.ok(fixture.world.chunks.has(`${x},${z}`));
    }
    fixture.renderer.rebuildDirty(Infinity);
    assert.equal(requiredGeometryState(fixture).fresh, 9);
    assert.equal(requiredGeometryState(fixture).freshSections, 54);
    fixture.world.dirty(1, 0, 5);
    assert.equal(requiredGeometryState(fixture).fresh, 8);
    assert.equal(requiredGeometryState(fixture).freshSections, 53,
      "even the empty top section needs a current acknowledged stamp");
    fixture.renderer.rebuildDirty(Infinity);
    const section = fixture.renderer.chunks.get("1,0").userData.sections.get(5);
    const stamp = section.stamp;
    section.stamp = { ...stamp, epoch: stamp.epoch + 1 };
    assert.equal(requiredGeometryState(fixture).freshSections, 53,
      "installed but stale sections must not count");
    section.stamp = stamp;
    assert.equal(requiredGeometryState(fixture).freshSections, 54);
  } finally { fixture.dispose(); }
});

test("v3 native regional triangles exactly match the existing 96-high column mesher", () => {
  const fixture = nativeGeometryFixture({ version: 3, radius: 0 });
  const original = buildChunkGeometry(fixture.world, 0, 0, shapeAtlas);
  try {
    fixture.renderer.rebuildDirty(Infinity);
    const expected = [], actual = [];
    for (const [batch, geometry] of Object.entries(original))
      expected.push(...triangles(geometry).map((value) => `${batch}:${value}`));
    for (const section of fixture.renderer.chunks.get("0,0").userData.sections.values())
      for (const mesh of section.group.children)
        actual.push(...triangles(mesh.geometry, mesh.geometry.userData.colorPalette,
          mesh.userData.canonicalRange?.vertexStart ?? 0).map((value) => `${mesh.userData.batch}:${value}`));
    assert.ok(expected.length > 0);
    assert.deepEqual(actual.sort(), expected.sort());
  } finally {
    disposeBatches(original);
    fixture.dispose();
  }
});

test("parent regional opt-in routes native v3 without the test-only adapter", () => {
  const fixture = nativeGeometryFixture({ version: 3, radius: 0, legacyAdapter: false });
  try {
    assert.equal(fixture.nativeRoute, false, "height heuristic must remain historical");
    assert.equal(fixture.legacyRoutingAdapter, false);
    fixture.renderer.rebuildDirty(Infinity);
    assert.ok(fixture.renderer.sectionRegions?.size > 0);
    assert.equal(requiredGeometryState(fixture).fresh, 1);
  } finally { fixture.dispose(); }
});

test("distribution includes the legacy unprefixed oak LEAVES identifier", () => {
  const fixture = nativeGeometryFixture({ version: 3, radius: 0 });
  try {
    const before = nativeDistribution(fixture);
    assert.equal(fixture.world.get(8, 95, 8), BLOCK.AIR);
    fixture.world.put(8, 95, 8, BLOCK.LEAVES);
    assert.equal(nativeDistribution(fixture).leafCells, before.leafCells + 1);
  } finally { fixture.dispose(); }
});
