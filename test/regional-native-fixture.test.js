import assert from "node:assert/strict";
import test from "node:test";
import { sectionYs, snapshotSection, getColumnLighting } from "../src/mesh-snapshot.js";
import { buildChunkGeometry } from "../src/chunk-mesh.js";
import { BLOCK } from "../src/blocks.js";
import { disposeBatches } from "../src/mesh-palette.js";
import { nativeGeometryFixture, requiredGeometryState, nativeDistribution } from "./regional-native-fixture.js";
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
  [3, "overworld", 0, 96, 6], [7, "end", 0, 256, 16], [7, "overworld", -64, 320, 24],
]) test(`real native v${version} ${dimension} keeps its own height and section coverage`, () => {
  const fixture = nativeGeometryFixture({ version, dimension, radius: 0 });
  try {
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
      required: 1, requiredSections: count, covered: 1, fresh: 1, sections: count, dirtySections: 0,
    });
    assert.ok(fixture.renderer.sectionRegions.size > 0);
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
