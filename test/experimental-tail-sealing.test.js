import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { MeshBudgetError } from "../src/mesh-geometry.js";
import {
  beginExperimentalColdTailEpoch, experimentalColdTailEpoch, experimentalTailHeadroom,
  experimentalTailOwners, EXPERIMENTAL_FALLBACK_BYTES,
} from "../src/experimental-tail-sealing.js";
import { regionalPaletteMaterials } from "../src/geometry-palette-material.js";
import { releaseLostContextResources } from "../src/context-resources.js";
import { regionalPagePlan, publishRegionalPages } from "../src/regional-section-pages.js";
import { sectionSourceGroup } from "../src/section-pages.js";
import { clearSectionJobs, detailMeshResources } from "../src/section-renderer.js";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";

function fixture(t, enabled = true, overrides = {}) {
  const world = authoredColumns([[0, 0], [1, 0]]);
  const renderer = shapeRenderer(world);
  renderer.renderDistanceOverride = 4;
  renderer.meshLimits = { regionalPages: true, ...overrides,
    ...(enabled ? { experimentalColdTailSealing: true } : {}) };
  if (enabled) assert.equal(beginExperimentalColdTailEpoch(renderer), true);
  else renderer.rebuildDirty(0);
  t.after(() => {
    clearSectionJobs(renderer);
    disposeShapeRenderer(renderer);
    assert.equal(experimentalTailOwners(renderer), 0);
  });
  return renderer;
}

function source(vertices, { fractionalPosition = false, fractionalNormal = false, colors = 3 } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.userData.axisNormals = !fractionalNormal;
  geometry.userData.integralPositions = !fractionalPosition;
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2), color = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) {
    position.set([i % 2 + (fractionalPosition ? 0.25 : 0), (i >> 2) % 16, (i >> 1) % 2], i * 3);
    normal.set(fractionalNormal ? [Math.SQRT1_2, Math.SQRT1_2, 0] : [0, 1, 0], i * 3);
    uv.set([i % 2, (i >> 1) % 2], i * 2);
    color.set([(i % colors) / colors, 0.25, 0.75], i * 3);
  }
  for (const [name, array, size] of [
    ["position", position, 3], ["normal", normal, 3], ["uv", uv, 2], ["color", color, 3],
  ]) geometry.setAttribute(name, new THREE.BufferAttribute(array, size));
  const indices = vertices > 65535 ? new Uint32Array(vertices / 4 * 6) : new Uint16Array(vertices / 4 * 6);
  for (let v = 0, i = 0; v < vertices; v += 4, i += 6) indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

// Compare every decoded indexed triangle component, not representation hashes.
function decoded(geometry, base = 0, offsetX = 0) {
  const result = new Float64Array(geometry.index.count * 11);
  let out = 0;
  for (const index of geometry.index.array) {
    const vertex = index - base;
    for (const name of ["position", "normal", "uv", "color"]) {
      const a = geometry.attributes[name], palette = geometry.userData.colorPalette;
      for (let c = 0; c < (name === "uv" ? 2 : 3); c++)
        result[out++] = name === "color" && palette
          ? palette.component(a.array[vertex], c)
          : Math.fround(a.getComponent(vertex, c) + (name === "position" && c === 0 ? offsetX : 0));
    }
  }
  return result;
}

function prepare(renderer, sy, vertices, options = {}, cx = 0) {
  const geometry = source(vertices, options);
  const expected = decoded(geometry, 0, cx * 16);
  const group = sectionSourceGroup({ parts: [{ opaque: geometry }] }, regionalPaletteMaterials(renderer));
  const plan = regionalPagePlan(renderer, cx, 0, sy, group, { minSection: -4 });
  return { plan, expected, geometry, group, cx, sy };
}

function publish(renderer, item) {
  const { plan, cx, sy, group } = item, key = `${cx},0`;
  plan.step(Infinity, Infinity);
  let column = renderer.chunks.get(key);
  if (!column) {
    column = new THREE.Group();
    column.userData = { cx, cz: 0, incarnation: renderer.world.chunks.get(key).incarnation,
      sections: new Map(), requiredSections: [], emitters: [] };
    renderer.chunks.set(key, column);
    renderer.scene.add(column);
  }
  const old = column.userData.sections.get(sy)?.group;
  assert.equal(publishRegionalPages(renderer, column, sy, plan), true);
  column.add(group);
  column.userData.sections.set(sy, { group, emitters: [] });
  column.userData.transparentMeshes = [...column.userData.sections.values()]
    .flatMap(({ group }) => group.children).filter((mesh) => !mesh.userData.sectionSource);
  if (old) { column.remove(old); old.traverse((mesh) => mesh.geometry?.dispose()); }
  plan.dispose();
  return item;
}

function verify(renderer, items) {
  for (const item of items) {
    const mesh = item.group.children[0], range = mesh.userData.canonicalRange;
    assert.deepEqual(decoded(mesh.geometry, range.vertexStart), item.expected);
    assert.equal(mesh.geometry.index.array.buffer, range.mesh.geometry.index.array.buffer);
    for (const [name, a] of Object.entries(mesh.geometry.attributes))
      assert.equal(a.array.buffer, range.mesh.geometry.attributes[name].array.buffer);
  }
  const unique = new Set();
  renderer.scene.traverse((mesh) => {
    if (!mesh.geometry) return;
    for (const a of [...Object.values(mesh.geometry.attributes), mesh.geometry.index])
      if (a) unique.add(a.array.buffer);
  });
  const bytes = [...unique].reduce((n, b) => n + b.byteLength, 0);
  const stats = detailMeshResources(renderer);
  assert.equal(stats.canonicalBytes - stats.palette.cpuBytes, bytes);
  assert.equal(stats.gpuBytes - stats.palette.gpuBytes, bytes);
  const pages = [...renderer.sectionRegions.values()].flatMap((r) => r.userData.pageDescriptors);
  assert.equal(renderer.geometryPalette.references, pages.reduce((n, page) => n + page.vertices, 0));
  assert.equal(experimentalTailOwners(renderer), pages.filter((p) => p.experimentalSealed).length);
  assert.equal(stats.reservedPageBytes, 0);
}

test("whole-source 65532 boundary seals exact-sized pages without recopying sealed owners", (t) => {
  const renderer = fixture(t), items = [];
  items.push(publish(renderer, prepare(renderer, 0, 40000)));
  items.push(publish(renderer, prepare(renderer, 1, 25532)));
  const first = items[0].group.children[0].userData.canonicalRange.mesh;
  const next = prepare(renderer, 2, 4);
  assert.equal(next.plan.pages[0].mesh, first);
  assert.equal(next.plan.pages[0].reused, true);
  assert.equal(next.plan.pages[0].experimentalSealed, true);
  assert.equal(next.plan.stagingBytes, 4 * 23);
  items.push(publish(renderer, next));
  items.push(publish(renderer, prepare(renderer, 3, 40000)));
  items.push(publish(renderer, prepare(renderer, 3, 30000, {}, 1)));
  const pages = [...renderer.sectionRegions.values()][0].userData.pageDescriptors;
  assert.deepEqual(pages.map((p) => p.vertices), [65532, 40004, 30000]);
  assert.equal(pages[0].mesh, first);
  for (const page of pages) {
    assert.equal(page.mesh.geometry.attributes.position.array.length, page.vertices * 3);
    assert.equal(page.mesh.geometry.index.array.length, page.indices);
    assert.ok(page.mesh.geometry.index.array instanceof Uint16Array);
  }
  verify(renderer, items);
});

for (const options of [
  {}, { fractionalPosition: true }, { fractionalNormal: true },
  { fractionalPosition: true, fractionalNormal: true, colors: 257 },
]) test(`exact triangle/normal/UV/RGB decoding across format promotion ${JSON.stringify(options)}`, (t) => {
  const renderer = fixture(t), items = [];
  items.push(publish(renderer, prepare(renderer, 0, 20000)));
  items.push(publish(renderer, prepare(renderer, 1, 20000, options)));
  items.push(publish(renderer, prepare(renderer, 2, 30000, options)));
  items.push(publish(renderer, prepare(renderer, 3, 30000, options)));
  verify(renderer, items);
  const promoted = items[0].group.children[0].userData.canonicalRange.mesh.geometry.attributes;
  assert.equal(promoted.position.array instanceof Float32Array, !!options.fractionalPosition);
  assert.equal(promoted.normal.array instanceof Float32Array, !!options.fractionalNormal);
  if (options.colors === 257) assert.ok(promoted.color.array instanceof Uint16Array);
});

test("oversized sources use the old physical limit and Uint32 index promotion", (t) => {
  const renderer = fixture(t);
  const first = publish(renderer, prepare(renderer, 0, 40000));
  const oversized = prepare(renderer, 1, 80000);
  assert.equal(oversized.plan.experimentalEpoch, undefined);
  assert.equal(experimentalColdTailEpoch(renderer), null);
  publish(renderer, oversized);
  assert.ok(oversized.plan.pages[0].mesh.geometry.index.array instanceof Uint32Array);
  verify(renderer, [first, oversized]);
  assert.throws(() => prepare(renderer, 2, 140000), MeshBudgetError);
  verify(renderer, [first, oversized]);
});

test("unarmed/default-off planner stays dense, including >65535 vertex promotion", (t) => {
  for (const flag of [undefined, false, true]) {
    const renderer = fixture(t, false);
    if (flag !== undefined) renderer.meshLimits.experimentalColdTailSealing = flag;
    const a = publish(renderer, prepare(renderer, 0, 40000));
    const b = publish(renderer, prepare(renderer, 1, 40000));
    assert.equal(b.plan.pages.length, 1);
    assert.equal(b.plan.experimentalEpoch, undefined);
    assert.ok(b.plan.pages[0].mesh.geometry.index.array instanceof Uint32Array);
    assert.equal(experimentalTailHeadroom(renderer), 0);
    verify(renderer, [a, b]);
  }
});

test("flag-off and private cancellation keep the reserve until the last sealed owner retires", (t) => {
  const renderer = fixture(t);
  const items = [publish(renderer, prepare(renderer, 0, 40000)),
    publish(renderer, prepare(renderer, 1, 40000))];
  const plan = prepare(renderer, 2, 30000).plan;
  plan.step(16384, Infinity);
  renderer.meshLimits.experimentalColdTailSealing = false;
  assert.equal(experimentalColdTailEpoch(renderer), null);
  plan.dispose();
  assert.equal(experimentalTailHeadroom(renderer), EXPERIMENTAL_FALLBACK_BYTES);
  assert.equal(beginExperimentalColdTailEpoch(renderer), false);
  verify(renderer, items);
  renderer.removeChunk("0,0");
  assert.equal(experimentalTailOwners(renderer), 0);
  assert.equal(experimentalTailHeadroom(renderer), 0);
});

for (const change of ["edit", "aba", "world", "view", "flag", "material", "fusion", "clear"]) {
  test(`cold epoch invalidates conservatively on ${change}, never rearms from missing keys`, (t) => {
    const renderer = fixture(t);
    const first = publish(renderer, prepare(renderer, 0, 40000));
    const plan = prepare(renderer, 1, 40000).plan;
    plan.step(Infinity, Infinity);
    const column = renderer.chunks.get("0,0"), oldPage = column.userData.pages[0];
    if (change === "edit") renderer.world.put(0, 0, 0, BLOCK.STONE);
    if (change === "aba") renderer.world.admit(0, 0);
    if (change === "world") renderer.world = authoredColumns([[0, 0], [1, 0]]);
    if (change === "view") renderer.camera.position.x += 16;
    if (change === "flag") renderer.meshLimits.experimentalColdTailSealing = false;
    if (change === "material") renderer.materials.opaque.needsUpdate = true;
    if (change === "fusion") renderer.waterFusionEnabled = true;
    if (change === "clear") clearSectionJobs(renderer);
    assert.equal(experimentalColdTailEpoch(renderer), null);
    assert.equal(plan.experimentalEpoch.world, undefined);
    assert.deepEqual(plan.experimentalEpoch.chunks, []);
    assert.equal(publishRegionalPages(renderer, column, 1, plan), false);
    assert.equal(column.userData.pages[0], oldPage);
    plan.dispose();
    assert.deepEqual(decoded(first.geometry, first.group.children[0].userData.canonicalRange.vertexStart), first.expected);
    assert.equal(renderer.world.acknowledgments.length, 0);
    assert.equal(experimentalColdTailEpoch(renderer), null);
  });
}

for (const stage of ["allocation", "copy", "palette", "ranges", "precommit"]) {
  test(`failure at ${stage} preserves old backing, leases and dirty tickets`, (t) => {
    const renderer = fixture(t);
    const first = publish(renderer, prepare(renderer, 0, 40000));
    const second = publish(renderer, prepare(renderer, 1, 40000));
    const references = renderer.geometryPalette.references;
    const tickets = new Map(renderer.world.dirtySectionRevisions);
    const item = prepare(renderer, 2, 20000);
    if (stage === "allocation") {
      const set = THREE.BufferGeometry.prototype.setAttribute;
      const mock = t.mock.method(THREE.BufferGeometry.prototype, "setAttribute", function(name, attribute) {
        if (name === "normal") throw new Error("injected allocation failure");
        return set.call(this, name, attribute);
      });
      assert.throws(() => item.plan.step(Infinity, Infinity), /injected/);
      mock.mock.restore();
    } else if (stage === "copy") {
      item.plan.step(16384, Infinity);
      assert.ok(item.plan.allocatedBytes > 0);
    } else if (stage === "palette") {
      const acquire = renderer.geometryPalette.acquire.bind(renderer.geometryPalette);
      let count = 0;
      const mock = t.mock.method(renderer.geometryPalette, "acquire", (...args) => {
        if (++count === 10) throw new Error("injected palette failure");
        return acquire(...args);
      });
      assert.throws(() => item.plan.step(Infinity, Infinity), /injected/);
      mock.mock.restore();
    } else if (stage === "ranges") {
      t.mock.method(item.plan, "prepareCanonicalRanges", () => { throw new Error("injected range failure"); });
      assert.throws(() => item.plan.step(Infinity, Infinity), /injected/);
    } else {
      item.plan.step(Infinity, Infinity);
      const region = item.plan.column, add = region.add;
      const mock = t.mock.method(region, "add", function(mesh) {
        add.call(this, mesh);
        renderer.meshLimits.experimentalColdTailSealing = false;
        return this;
      });
      assert.equal(publishRegionalPages(renderer, renderer.chunks.get("0,0"), 2, item.plan), false);
      mock.mock.restore();
      assert.ok(item.plan.pages.filter((p) => !p.reused).every((p) => p.mesh.parent === null));
    }
    item.plan.dispose();
    assert.equal(renderer.geometryPalette.references, references);
    assert.deepEqual(renderer.world.dirtySectionRevisions, tickets);
    verify(renderer, [first, second]);
  });
}

test("GPU context disposal preserves CPU backing and sealed leases; explicit retirement releases both", (t) => {
  const renderer = fixture(t);
  const a = publish(renderer, prepare(renderer, 0, 40000));
  const b = publish(renderer, prepare(renderer, 1, 40000));
  const owners = experimentalTailOwners(renderer);
  releaseLostContextResources({ getContext: () => ({ isContextLost: () => true }) }, renderer.scene);
  assert.equal(experimentalTailOwners(renderer), owners);
  verify(renderer, [a, b]);
  renderer.meshLimits.experimentalColdTailSealing = false;
  experimentalColdTailEpoch(renderer);
  const region = b.plan.column, replacement = prepare(renderer, 2, 4), retired = [];
  replacement.plan.step(Infinity, Infinity);
  const column = renderer.chunks.get("0,0");
  // Water transactions detach old owners, publish all new views, then retire.
  for (const mesh of region.userData.pages) region.remove(mesh);
  assert.equal(publishRegionalPages(renderer, column, 2, replacement.plan, {
    validate: () => true, deferRetire: (callback) => retired.push(callback),
  }), true);
  column.add(replacement.group);
  column.userData.sections.set(2, { group: replacement.group });
  replacement.plan.dispose();
  assert.equal(experimentalTailHeadroom(renderer), EXPERIMENTAL_FALLBACK_BYTES);
  for (const retire of retired) retire();
  assert.equal(experimentalTailHeadroom(renderer), 0);
  verify(renderer, [a, b, replacement]);
});

test("private sealed allocations hold their own reserve through cancellation before first publication", (t) => {
  const renderer = fixture(t);
  const group = sectionSourceGroup({ parts: [{ opaque: source(40000) }, { opaque: source(40000) }] },
    regionalPaletteMaterials(renderer));
  const plan = regionalPagePlan(renderer, 0, 0, 0, group, { minSection: -4 });
  plan.step(16384, Infinity);
  assert.equal(experimentalTailOwners(renderer), 1);
  renderer.meshLimits.experimentalColdTailSealing = false;
  experimentalColdTailEpoch(renderer);
  assert.equal(experimentalTailHeadroom(renderer), EXPERIMENTAL_FALLBACK_BYTES);
  plan.dispose();
  assert.equal(experimentalTailOwners(renderer), 0);
  assert.equal(experimentalTailHeadroom(renderer), 0);
  assert.equal(renderer.geometryPalette.references, 0);
});

test("real palette exhaustion releases only private leases and retains sealed owners", (t) => {
  const renderer = fixture(t, true, { paletteCapacity: 2 });
  const a = publish(renderer, prepare(renderer, 0, 40000, { colors: 2 }));
  const b = publish(renderer, prepare(renderer, 1, 40000, { colors: 2 }));
  const item = prepare(renderer, 2, 30000, { colors: 3 });
  assert.throws(() => item.plan.step(Infinity, Infinity), /budget/);
  item.plan.dispose();
  assert.equal(renderer.geometryPalette.entries, 2);
  assert.equal(renderer.geometryPalette.references, 80000);
  assert.equal(experimentalTailOwners(renderer), 1);
  verify(renderer, [a, b]);
});

test("unversioned input and R12 cannot arm the experiment", (t) => {
  const renderer = fixture(t, false);
  renderer.meshLimits.experimentalColdTailSealing = true;
  renderer.renderDistanceOverride = 12;
  assert.equal(beginExperimentalColdTailEpoch(renderer), false);
  renderer.renderDistanceOverride = 4;
  renderer.world = { ...renderer.world }; // No mutation clock.
  assert.equal(beginExperimentalColdTailEpoch(renderer), false);
  assert.equal(experimentalTailHeadroom(renderer), 0);
});

test("unfused transparency keeps its original object, RGB and physical two-pass submission count", (t) => {
  const renderer = fixture(t, false);
  renderer.materials.water.side = THREE.DoubleSide;
  renderer.materials.water.forceSinglePass = false;
  renderer.meshLimits.experimentalColdTailSealing = true;
  assert.equal(beginExperimentalColdTailEpoch(renderer), true);
  const first = publish(renderer, prepare(renderer, 0, 40000));
  const opaque = source(40000), water = source(4), expectedWater = decoded(water);
  const group = sectionSourceGroup({ parts: [{ opaque, water }] }, regionalPaletteMaterials(renderer));
  const plan = regionalPagePlan(renderer, 0, 0, 1, group, { minSection: -4 });
  const second = { plan, group, cx: 0, sy: 1, expected: decoded(opaque) };
  assert.ok(plan.experimentalEpoch);
  publish(renderer, second);
  assert.equal(plan.draws, 4);
  assert.equal(detailMeshResources(renderer).drawCalls, 4);
  assert.equal(group.children[1].geometry, water);
  assert.deepEqual(decoded(water), expectedWater);
  assert.ok(experimentalColdTailEpoch(renderer));
  verify(renderer, [first, second]);
});

test("incompatible source formats fall back without changing existing owners", (t) => {
  const renderer = fixture(t);
  const first = publish(renderer, prepare(renderer, 0, 40000));
  const geometry = source(40000);
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float64Array(geometry.attributes.uv.array), 2));
  const group = sectionSourceGroup({ parts: [{ opaque: geometry }] }, regionalPaletteMaterials(renderer));
  const plan = regionalPagePlan(renderer, 0, 0, 1, group, { minSection: -4 });
  assert.equal(plan.experimentalEpoch, undefined);
  assert.equal(experimentalColdTailEpoch(renderer), null);
  const second = { plan, group, cx: 0, sy: 1, expected: decoded(geometry) };
  publish(renderer, second);
  verify(renderer, [first, second]);
});

test("dense fallback, pressure retry, larger headroom, retained owners and compaction stay live", (t) => {
  t.mock.method(performance, "now", () => 0);
  const renderer = fixture(t, false), world = renderer.world;
  for (let cx = 0; cx < 2; cx++)
    for (let y = cx ? 64 : 0; y < 192; y++)
      for (let z = 0; z < 12; z++)
        for (let x = 0; x < 12; x++)
          if ((x + y + z) % 2 === 0) world.put(cx * 16 + x, y, z, BLOCK.STONE);
  renderer.meshLimits.experimentalColdTailSealing = true;
  assert.equal(beginExperimentalColdTailEpoch(renderer), true);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().size, 2);
  assert.equal(detailMeshResources(renderer).sections, 48);
  assert.equal(experimentalColdTailEpoch(renderer), null, "dense copy exceeds fixed experimental reserve");
  assert.ok(experimentalTailOwners(renderer) > 0, "other bands retain sealed physical ownership");
  const column = renderer.chunks.get("0,0");
  const sourceMesh = column.userData.sections.get(4).group.children[0];
  const oldBuffer = sourceMesh.geometry.attributes.position.array.buffer;
  const stats = detailMeshResources(renderer);
  renderer.meshLimits.compactionHeadroomBytes = 12 * 1024 * 1024;
  renderer.meshLimits.maxCpuBytes = stats.combinedCpuBytes + 1024 * 1024;
  renderer.meshLimits.maxGpuBytes = stats.gpuBytes + 1024 * 1024;
  world.put(0, 64, 0, BLOCK.AIR);
  const ticket = world.dirtySectionRevisions.get("0,0,4");
  renderer.rebuildDirty(Infinity);
  assert.equal(world.dirtySectionRevisions.get("0,0,4"), ticket);
  assert.equal(sourceMesh.geometry.attributes.position.array.buffer, oldBuffer);
  assert.equal(detailMeshResources(renderer).reservedCompactionHeadroomBytes, 12 * 1024 * 1024);
  renderer.meshLimits.maxCpuBytes = renderer.meshLimits.maxGpuBytes = 256 * 1024 * 1024;
  renderer.meshLimits.experimentalColdTailSealing = false;
  renderer.rebuildDirty(Infinity);
  assert.equal(world.dirtySectionRevisions.has("0,0,4"), false);
  assert.equal(renderer.detailCoverage().size, 2);
  assert.ok(experimentalTailOwners(renderer) > 0);
  assert.equal(detailMeshResources(renderer).reservedCompactionHeadroomBytes, 12 * 1024 * 1024);
  assert.ok(renderer.meshStats.peakCombinedCpuBytes <= renderer.meshLimits.maxCpuBytes);
  assert.ok(renderer.meshStats.peakStagingBytes <= 16 * 1024 * 1024);
  world.chunks.delete("0,0");
  renderer.removeChunk("0,0");
  assert.ok(detailMeshResources(renderer).retainedDeadBytes > 0);
  renderer.rebuildDirty(Infinity);
  assert.equal(detailMeshResources(renderer).retainedDeadBytes, 0);
  assert.equal(experimentalTailOwners(renderer), 0);
  assert.equal(renderer.detailCoverage().size, 1);
});

test("candidate admission must preserve larger configured headroom for the dense representation too", (t) => {
  t.mock.method(performance, "now", () => 0);
  // This ceiling admits the sealed projection plus 12MiB, but not the
  // three-section dense projection plus that same configured headroom.
  const renderer = fixture(t, false, {
    compactionHeadroomBytes: 12 * 1024 * 1024, maxGpuBytes: 14700000,
  });
  for (let y = 0; y < 48; y++)
    for (let z = 0; z < 12; z++)
      for (let x = 0; x < 12; x++)
        if ((x + y + z) % 2 === 0) renderer.world.put(x, y, z, BLOCK.STONE);
  renderer.meshLimits.experimentalColdTailSealing = true;
  assert.equal(beginExperimentalColdTailEpoch(renderer), true);
  renderer.rebuildDirty(Infinity);
  assert.equal(!!experimentalColdTailEpoch(renderer), false);
  assert.equal(experimentalTailOwners(renderer), 0);
  assert.equal(renderer.world.dirtySectionRevisions.has("0,0,2"), true);
  assert.ok(renderer.chunks.get("0,0").userData.sections.has(0));
  assert.equal(detailMeshResources(renderer).reservedCompactionHeadroomBytes, 12 * 1024 * 1024);
  renderer.meshLimits.maxGpuBytes = 256 * 1024 * 1024;
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.world.dirtySectionRevisions.has("0,0,2"), false);
  assert.equal(renderer.detailCoverage().size, 2);
});
