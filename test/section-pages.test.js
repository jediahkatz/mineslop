import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { releaseLostContextResources } from "../src/context-resources.js";
import { landmarkDetailSections } from "../src/distant-landmarks.js";
import { geometryBytes } from "../src/mesh-palette.js";
import { SectionPagePlan, sectionSourceGroup } from "../src/section-pages.js";
import { detailMeshResources, DETAIL_MESH_LIMITS } from "../src/section-renderer.js";
import { createSectionMeshJob } from "../src/section-mesh.js";
import { authoredColumns, shapeAtlas, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";

function fixture(t, entries) {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([[0, 0]], entries);
  const renderer = shapeRenderer(world);
  t.after(() => disposeShapeRenderer(renderer));
  return { world, renderer };
}

test("24 logical sections consolidate to three bounded vertical pages with exact accounting", (t) => {
  const { renderer } = fixture(t, Array.from({ length: 24 }, (_, i) =>
    [0, -64 + i * 16, 0, BLOCK.STONE]));
  renderer.meshLimits = { maxDrawCalls: 3 };
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const stats = detailMeshResources(renderer);
  assert.equal(column.userData.sections.size, 24);
  assert.equal(stats.drawCalls, 3);
  assert.equal(stats.visibleDrawCalls, 3);
  assert.equal(stats.gpuBytes, 24 * (24 * 35 + 36 * 2));
  assert.equal(stats.sourceBytes, 24 * (24 * 44 + 36 * 2));
  assert.equal(stats.stagingPageBytes, 0);
  assert.equal(stats.stagingSourceBytes, 0);
  assert.equal(renderer.detailCoverage().size, 1);
  assert.equal(landmarkDetailSections(renderer.chunks).size, 24);
  assert.equal(renderer.meshStats.budgetRejections, 0);
  for (const section of column.userData.sections.values())
    for (const mesh of section.group.children) {
      assert.equal(mesh.layers.mask, 0);
      const range = column.userData.sectionRanges.get(mesh);
      const normal = range.mesh.geometry.attributes.normal;
      const base = range.mesh.geometry.index.getX(range.start) - mesh.geometry.index.getX(0);
      assert.ok(normal.array instanceof Int8Array);
      assert.equal(normal.normalized, true);
      for (let i = 0; i < mesh.geometry.attributes.normal.count; i++)
        for (let component = 0; component < 3; component++)
          assert.equal(normal.getComponent(base + i, component),
            mesh.geometry.attributes.normal.getComponent(i, component));
    }
  const pages = column.userData.pages;
  const box = new THREE.Box3();
  for (const page of pages) {
    box.union(page.geometry.boundingBox);
    assert.ok(page.geometry.boundingBox.max.y - page.geometry.boundingBox.min.y <= 128);
  }
  assert.ok(box.min.y <= -64 && box.max.y >= 305);
  const ray = new THREE.Raycaster(new THREE.Vector3(0.5, 400, 0.5), new THREE.Vector3(0, -1, 0));
  column.updateMatrixWorld(true);
  const hits = ray.intersectObject(column, true);
  assert.ok(hits.length);
  assert.ok(hits.every((hit) => pages.includes(hit.object)), "CPU records are not raycast twice");
});

test("both LOD authorities reject missing, hidden or partially drawn page ownership", (t) => {
  const { renderer } = fixture(t, [[0, 0, 0, BLOCK.STONE], [0, 16, 0, BLOCK.STONE]]);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const source = column.userData.sections.get(1).group.children[0];
  const range = column.userData.sectionRanges.get(source);
  const page = range.mesh;
  const check = (covered) => {
    assert.equal(renderer.detailCoverage().has("0,0"), covered);
    assert.equal(landmarkDetailSections(renderer.chunks).has("0,0,1"), covered);
  };
  check(true);
  for (const [alter, restore] of [
    [() => column.remove(page), () => column.add(page)],
    [() => { page.visible = false; }, () => { page.visible = true; }],
    [() => { source.visible = false; }, () => { source.visible = true; }],
    [() => { page.material.visible = false; }, () => { page.material.visible = true; }],
    [() => page.geometry.setDrawRange(0, range.start + range.count - 1),
      () => page.geometry.setDrawRange(0, Infinity)],
    [() => page.geometry.setDrawRange(range.start + 1, Infinity),
      () => page.geometry.setDrawRange(0, Infinity)],
    [() => column.userData.sectionRanges.delete(source),
      () => column.userData.sectionRanges.set(source, range)],
  ]) {
    alter(); check(false); restore(); check(true);
  }
});

function geometry(vertices, alpha = false) {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of [["position", 3], ["normal", 3], ["uv", 2], ["color", alpha ? 4 : 3], ["lodBlocks", 3]]) {
    const array = new Float32Array(vertices * size);
    for (let i = 0; i < array.length; i++) array[i] = (i % 37) / 37;
    g.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  g.setIndex(new THREE.BufferAttribute(Uint16Array.from({ length: vertices }, (_, i) => i), 1));
  g.computeBoundingSphere();
  return g;
}

test("packing preserves every attribute and rebases promoted indices; incompatible alpha stays separate", () => {
  const inputs = [geometry(33000), geometry(33000), geometry(3, true)];
  const material = new THREE.MeshLambertMaterial();
  const group = sectionSourceGroup({ parts: inputs.map((opaque) => ({ opaque })) }, { opaque: material });
  const plan = new SectionPagePlan(null, 0, group);
  try {
    let calls = 0;
    while (!plan.done) {
      assert.ok(plan.step(32768, Infinity) <= 32768);
      assert.ok(plan.allocatedBytes <= plan.stagingBytes);
      calls++;
    }
    assert.ok(calls > 20);
    assert.equal(plan.pages.length, 2);
    const target = plan.pages[0].mesh.geometry;
    assert.ok(target.index.array instanceof Uint32Array);
    assert.equal(target.index.array[33000], 33000);
    for (const [name, attribute] of Object.entries(inputs[0].attributes)) {
      const output = target.attributes[name];
      assert.equal(output.itemSize, attribute.itemSize);
      assert.deepEqual(output.array.subarray(0, attribute.array.length), attribute.array);
      assert.deepEqual(output.array.subarray(attribute.array.length), inputs[1].attributes[name].array);
    }
    assert.equal(plan.pages[1].mesh.geometry.attributes.color.itemSize, 4);
    assert.equal(plan.bytes, plan.pages.reduce((sum, p) => sum + geometryBytes(p.mesh.geometry), 0));
    const overflow = new SectionPagePlan(null, 0, group, { maxVertices: 40000 });
    assert.equal(overflow.pages.length, 3);
    overflow.dispose();
  } finally {
    plan.dispose();
    for (const g of inputs) g.dispose();
    material.dispose();
  }
});

test("copy work yields atomically, stale tickets release staging, and context recovery retains CPU data", (t) => {
  const { world, renderer } = fixture(t, [[0, 0, 0, BLOCK.STONE]]);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const old = column.userData.sections.get(0);
  for (let x = 0; x < 16; x++)
    for (let z = 0; z < 16; z++) world.put(x, 1, z, BLOCK.OAK_FENCE);
  renderer.meshLimits = { maxCopyBytesPerSlice: 16384 };
  let job;
  for (let i = 0; i < 100; i++) {
    renderer.rebuildDirty(1);
    assert.ok(renderer.meshStats.lastSliceCopyBytes <= 16384);
    job = renderer.sectionJobs.get("0,0,0");
    if (job?.pagePlan?.allocatedBytes) break;
  }
  assert.ok(job.pagePlan.allocatedBytes > 0);
  assert.equal(column.userData.sections.get(0), old);
  assert.equal(renderer.detailCoverage().size, 1);
  const staged = job.pagePlan.pages.filter((p) => p.mesh && !p.reused);
  let disposed = 0;
  for (const page of staged) page.mesh.geometry.addEventListener("dispose", () => disposed++);
  world.put(0, 1, 0, BLOCK.STONE);
  renderer.rebuildDirty(0);
  assert.equal(disposed, staged.length);
  assert.equal(column.userData.sections.get(0), old);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().size, 1);
  assert.equal(world.dirtySectionRevisions.size, 0);
  const pages = column.userData.pages;
  const arrays = pages.map((p) => p.geometry.attributes.position.array);
  releaseLostContextResources({ getContext: () => ({ isContextLost: () => true }) }, renderer.scene);
  assert.equal(renderer.detailCoverage().size, 1);
  for (let i = 0; i < pages.length; i++)
    assert.equal(pages[i].geometry.attributes.position.array, arrays[i]);
  assert.ok(detailMeshResources(renderer).gpuBytes <= DETAIL_MESH_LIMITS.maxGpuBytes);
});

test("water and glass retain independent section draws and sorting metadata", (t) => {
  const { renderer } = fixture(t, [
    [0, 0, 0, BLOCK.WATER], [0, 16, 0, BLOCK.WATER],
    [3, 0, 0, BLOCK.GLASS], [3, 16, 0, BLOCK.GLASS],
  ]);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  assert.equal(column.userData.pages.length, 0);
  assert.equal(detailMeshResources(renderer).drawCalls, 4);
  for (const sy of [0, 1]) {
    const meshes = column.userData.sections.get(sy).group.children;
    assert.deepEqual(meshes.map((m) => m.renderOrder), [2, 1]);
    assert.ok(meshes.every((m) => m.layers.mask === 1 && !m.userData.sectionSource));
  }
});

test("non-axis plant normals retain their exact Float32 representation", (t) => {
  const { renderer } = fixture(t, [[0, 0, 0, BLOCK.TALL_GRASS]]);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("0,0");
  const source = column.userData.sections.get(0).group.children[0];
  assert.equal(source.geometry.userData.axisNormals, false);
  const page = column.userData.sectionRanges.get(source).mesh;
  assert.ok(page.geometry.attributes.normal.array instanceof Float32Array);
  assert.deepEqual(page.geometry.attributes.normal.array, source.geometry.attributes.normal.array);
  assert.equal(page.geometry.attributes.normal.normalized, false);
});

test("allocation-free snapshot IDs preserve exact shape, AO, fluid and boundary geometry", (t) => {
  const world = authoredColumns([[0, 0], [-1, 0]], [
    [-1, 0, 0, BLOCK.STONE], [0, 0, 0, BLOCK.STONE],
    [1, 0, 0, BLOCK.OAK_SLAB], [2, 0, 0, BLOCK.OAK_FENCE],
    [0, 1, 1, BLOCK.WATER], [15, 15, 15, BLOCK.GLASS],
    [0, 16, 0, BLOCK.STONE], [3, 0, 1, BLOCK.TALL_GRASS],
  ]);
  for (let x = 6; x < 10; x++)
    for (let y = 0; y < 4; y++)
      for (let z = 6; z < 10; z++) world.put(x, y, z, BLOCK.STONE);
  world.put(8, 1, 8, BLOCK.GLOWSTONE);
  const fast = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  const reference = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  t.after(() => { fast.dispose(); reference.dispose(); });
  for (const [x, y, z] of [[0, 0, 0], [-1, 0, 0], [0, 16, 0], [16, 0, 0], [-3, 0, 0], [0, -65, 0]])
    assert.equal(fast.snapshot.idAt(x, y, z), fast.snapshot.cellAt(x, y, z)?.id ?? null);
  delete reference.snapshot.idAt;
  let fastShapes = 0, referenceShapes = 0;
  const fastShape = fast.snapshot.shapeAt, referenceShape = reference.snapshot.shapeAt;
  t.mock.method(fast.snapshot, "shapeAt", (...args) => { fastShapes++; return fastShape(...args); });
  t.mock.method(reference.snapshot, "shapeAt", (...args) => { referenceShapes++; return referenceShape(...args); });
  fast.step({ flush: true });
  reference.step({ flush: true });
  assert.equal(fast.status, "ready");
  assert.equal(reference.status, "ready");
  assert.equal(fast.bytes, reference.bytes);
  assert.equal(fast.draws, reference.draws);
  assert.ok(fastShapes < referenceShapes, "buried full cubes bypass shape setup");
  for (let i = 0; i < fast.result.parts.length; i++)
    for (const [name, geometry] of Object.entries(fast.result.parts[i])) {
      const other = reference.result.parts[i][name];
      if (!geometry) { assert.equal(other, null); continue; }
      assert.deepEqual(geometry.userData.emitters, other.userData.emitters);
      assert.deepEqual(geometry.index.array, other.index.array);
      for (const key of Object.keys(geometry.attributes))
        assert.deepEqual(geometry.attributes[key].array, other.attributes[key].array);
    }
});

test("tight page-box culling restores draw ranges after camera and shadow passes", (t) => {
  const { renderer } = fixture(t, [[0, -64, 0, BLOCK.STONE], [0, 304, 0, BLOCK.STONE]]);
  renderer.rebuildDirty(Infinity);
  const page = renderer.chunks.get("0,0").userData.pages[0];
  renderer.scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(10000, 100, 10000);
  camera.updateMatrixWorld();
  page.onBeforeRender(null, renderer.scene, camera);
  assert.equal(page.geometry.drawRange.count, 0);
  page.onBeforeRender(null, renderer.scene, camera);
  page.onAfterRender();
  assert.equal(page.geometry.drawRange.count, Infinity);
  assert.equal(renderer.detailCoverage().size, 1);
  page.onBeforeShadow(null, page, renderer.camera, camera);
  assert.equal(page.geometry.drawRange.count, 0);
  page.onAfterShadow();
  assert.equal(page.geometry.drawRange.count, Infinity);
  assert.equal(renderer.detailCoverage().size, 1);
});

test("interleaved section publications repack stale page plans without losing peer geometry", (t) => {
  const { renderer, world } = fixture(t, []);
  renderer.rebuildDirty(Infinity);
  for (const y of [0, 16])
    for (let x = 0; x < 12; x++)
      for (let z = 0; z < 12; z++) world.put(x, y, z, BLOCK.OAK_FENCE);
  renderer.meshLimits = { maxCopyBytesPerSlice: 16384 };
  let slices = 0;
  while (world.dirtySectionRevisions.size && slices++ < 1000) {
    renderer.rebuildDirty(2);
    assert.deepEqual(detailMeshResources(renderer, true), detailMeshResources(renderer));
    assert.ok(renderer.meshStats.lastSliceCopyBytes <= 16384);
    assert.ok(renderer.sectionJobs.size <= 2);
  }
  assert.ok(slices > 10 && slices < 1000);
  assert.equal(world.dirtySectionRevisions.size, 0);
  const column = renderer.chunks.get("0,0");
  assert.equal(renderer.detailCoverage().size, 1);
  const sourceIndices = [...column.userData.sections.values()].flatMap((s) => s.group.children)
    .reduce((n, m) => n + m.geometry.index.count, 0);
  const pageIndices = column.userData.pages.reduce((n, m) => n + m.geometry.index.count, 0);
  assert.equal(sourceIndices, pageIndices);
});
