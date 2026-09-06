import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { releaseLostContextResources } from "../src/context-resources.js";
import { createSectionMeshJob } from "../src/section-mesh.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { sectionSourceGroup } from "../src/section-pages.js";
import { refreshRegionalPaletteMaterials } from "../src/geometry-palette-material.js";
import { bufferBytes, geometryBuffers, meshSubmissionCount, regionalPagePlan, sectionRegionKey } from "../src/regional-section-pages.js";
import { authoredColumns, shapeAtlas, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";

function fixture(t, columns, entries) {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns(columns, entries);
  const renderer = shapeRenderer(world);
  renderer.renderDistanceOverride = 12;
  renderer.meshLimits = { regionalPages: true };
  t.after(() => disposeShapeRenderer(renderer));
  return { world, renderer };
}

test("regional canonical packing owns one allocation and preserves native section attributes and indices", (t) => {
  const columns = [[0, 0], [1, 0], [3, 3], [-1, 0], [-4, 0], [4, 0]];
  const entries = columns.flatMap(([x, z]) => [
    [x * 16 + 1, 0, z * 16 + 1, BLOCK.STONE],
    [x * 16 + 3, 0, z * 16 + 1, BLOCK.OAK_SLAB],
    [x * 16 + 5, 0, z * 16 + 1, BLOCK.OAK_FENCE],
    [x * 16 + 7, 0, z * 16 + 1, BLOCK.TALL_GRASS],
    [x * 16 + 9, 0, z * 16 + 1, BLOCK.WATER],
  ]);
  const { world, renderer } = fixture(t, columns, entries);
  const originals = new Map(columns.map(([cx, cz]) => {
    const job = createSectionMeshJob(world, cx, cz, 0, shapeAtlas);
    job.step({ flush: true });
    return [`${cx},${cz}`, job];
  }));
  t.after(() => { for (const job of originals.values()) job.dispose(); });
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().size, columns.length);
  const owned = new Set();
  for (const region of renderer.sectionRegions.values())
    for (const mesh of region.userData.pages) geometryBuffers(mesh.geometry, owned);
  for (const [key, column] of renderer.chunks) {
    const region = column.userData.sectionRegion;
    const reference = originals.get(key).result.parts[0];
    const [cx, cz] = key.split(",").map(Number);
    for (const mesh of column.userData.sections.get(0).group.children) {
      const original = reference[mesh.userData.batch];
      const range = column.userData.sectionRanges.get(mesh);
      if (!mesh.userData.sectionSource) {
        geometryBuffers(mesh.geometry, owned);
        assert.equal(range, undefined);
        continue;
      }
      assert.equal(range.mesh.parent, region);
      assert.ok(mesh.geometry.attributes.color.array instanceof Uint8Array);
      for (const [name, a] of Object.entries(mesh.geometry.attributes)) {
        assert.equal(a.array.buffer, range.mesh.geometry.attributes[name].array.buffer);
        const expected = original.attributes[name];
        for (let i = 0; i < a.count; i++)
          for (let c = 0; c < expected.itemSize; c++) {
            const offset = name === "position" ? (c === 0 ? cx * 16 - region.position.x :
              c === 2 ? cz * 16 - region.position.z : 0) : 0;
            const value = name === "color"
              ? renderer.geometryPalette.component(a.array[i], c) : a.getComponent(i, c);
            assert.equal(value, Math.fround(expected.getComponent(i, c) + offset));
          }
      }
      assert.equal(mesh.geometry.index.array.buffer, range.mesh.geometry.index.array.buffer);
      for (let i = 0; i < original.index.count; i++)
        assert.equal(mesh.geometry.index.array[i] - range.vertexStart, original.index.array[i]);
    }
  }
  const stats = detailMeshResources(renderer);
  assert.equal(stats.canonicalBytes, bufferBytes(owned) + stats.palette.cpuBytes);
  assert.equal(stats.gpuBytes, bufferBytes(owned) + stats.palette.gpuBytes);
  assert.equal(stats.sourceBytes, 0);
  assert.equal(stats.stagingBytes, stats.palette.pendingUploadBytes);
  assert.equal(stats.drawCalls, [...renderer.sectionRegions.values()].reduce(
    (n, r) => n + r.userData.pages.length, 0) + columns.length * 2);
  assert.equal(sectionRegionKey(-1, -1), "-1,-1");
  assert.equal(sectionRegionKey(-4, -4), "-1,-1");
  assert.equal(sectionRegionKey(-5, -5), "-2,-2");
});

test("regional publication, unload, reload, cancellation and context restore preserve neighbours", (t) => {
  const { renderer, world } = fixture(t, [[0, 0], [1, 0]], [
    [0, 0, 0, BLOCK.STONE], [16, 0, 0, BLOCK.STONE],
  ]);
  renderer.rebuildDirty(Infinity);
  const neighbor = renderer.chunks.get("1,0");
  const source = neighbor.userData.sections.get(0).group.children[0];
  let range = neighbor.userData.sectionRanges.get(source);
  assert.ok(source.geometry.attributes.position.array instanceof Int16Array);
  const indices = [...source.geometry.index.array];
  const canonical = source.geometry.attributes.position.array.buffer;
  renderer.removeChunk("0,0");
  assert.ok(detailMeshResources(renderer).retainedDeadBytes > 0);
  assert.equal(renderer.detailCoverage().has("1,0"), true);
  assert.deepEqual([...source.geometry.index.array], indices);
  assert.equal(source.geometry.attributes.position.array.buffer, canonical);
  assert.ok(range.mesh.parent);
  world.admit(0, 0);
  world.put(0, 0, 0, BLOCK.STONE);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().size, 2);
  assert.equal(detailMeshResources(renderer).retainedDeadBytes, 0);
  range = neighbor.userData.sectionRanges.get(source);
  assert.equal(source.geometry.attributes.position.array.buffer, range.mesh.geometry.attributes.position.array.buffer);
  renderer.meshLimits.maxCopyBytesPerSlice = 16384;
  for (let x = 0; x < 12; x++)
    for (let z = 0; z < 12; z++) world.put(x, 0, z, BLOCK.OAK_FENCE);
  let job;
  for (let i = 0; i < 100; i++) {
    renderer.rebuildDirty(1);
    job = renderer.sectionJobs.get("0,0,0");
    if (job?.pagePlan?.allocatedBytes) break;
  }
  assert.ok(job.pagePlan.allocatedBytes);
  const oldPage = range.mesh;
  assert.equal(neighbor.userData.sectionRanges.get(source).mesh, oldPage);
  assert.ok(detailMeshResources(renderer).combinedCpuBytes <= renderer.meshStats.limits.maxCpuBytes);
  world.put(0, 0, 0, BLOCK.STONE);
  renderer.rebuildDirty(0);
  assert.equal(neighbor.userData.sectionRanges.get(source).mesh, oldPage);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().size, 2);
  const arrays = [...renderer.sectionRegions.values()].flatMap((r) => r.userData.pages)
    .map((p) => p.geometry.attributes.position.array);
  releaseLostContextResources({ getContext: () => ({ isContextLost: () => true }) }, renderer.scene);
  assert.deepEqual([...renderer.sectionRegions.values()].flatMap((r) => r.userData.pages)
    .map((p) => p.geometry.attributes.position.array), arrays);
  renderer.removeChunk("0,0");
  renderer.removeChunk("1,0");
  assert.equal(renderer.sectionRegions.size, 0);
  assert.equal(detailMeshResources(renderer).combinedCpuBytes, 0);
});

test("explicit combined capacity refusal preserves dirty tickets and retries changed ceilings", (t) => {
  const { world, renderer } = fixture(t, [[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  renderer.meshLimits.maxCpuBytes = 1;
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.sectionJobs.size, 0);
  assert.equal(renderer.meshStats.blocked.reason, "palette-reservation");
  assert.equal(world.dirtySectionRevisions.size, 24);
  renderer.meshLimits.maxCpuBytes = 256 * 1024 * 1024;
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().size, 1);
  assert.equal(detailMeshResources(renderer).reservedPageBytes, 0);
});

test("transparent physical passes are counted without merging sorting objects", () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }));
  assert.equal(meshSubmissionCount(mesh), 2);
  mesh.material.forceSinglePass = true;
  assert.equal(meshSubmissionCount(mesh), 1);
  mesh.material.dispose();
  mesh.geometry.dispose();
});

test("regional coverage requires attached actual ranges, and regional bounds include distant member columns", (t) => {
  const { renderer } = fixture(t, [[0, 0], [3, 3]], [
    [0, 0, 0, BLOCK.STONE], [63, 0, 63, BLOCK.STONE],
  ]);
  renderer.rebuildDirty(Infinity);
  const column = renderer.chunks.get("3,3"), region = column.userData.sectionRegion;
  const source = column.userData.sections.get(0).group.children[0];
  const range = column.userData.sectionRanges.get(source), page = range.mesh;
  assert.equal(region.userData.pages.length, 1);
  assert.equal(page.geometry.boundingBox.min.x, 0);
  assert.equal(page.geometry.boundingBox.max.x, 64);
  assert.equal(page.geometry.boundingBox.max.z, 64);
  for (const [breakCoverage, restore] of [
    [() => page.geometry.setDrawRange(0, range.start + range.count - 1), () => page.geometry.setDrawRange(0, Infinity)],
    [() => region.remove(page), () => region.add(page)],
    [() => { region.visible = false; }, () => { region.visible = true; }],
    [() => { page.layers.mask = 0; }, () => { page.layers.mask = 1; }],
  ]) {
    breakCoverage();
    assert.equal(renderer.detailCoverage().has("3,3"), false);
    restore();
    assert.equal(renderer.detailCoverage().has("3,3"), true);
  }
});

test("failed canonical-view preparation rolls back without touching live arrays or dirty tickets", (t) => {
  const { renderer, world } = fixture(t, [[0, 0], [1, 0]], [
    [0, 0, 0, BLOCK.STONE], [16, 0, 0, BLOCK.STONE],
  ]);
  renderer.rebuildDirty(Infinity);
  const neighbor = renderer.chunks.get("1,0");
  const source = neighbor.userData.sections.get(0).group.children[0];
  const attributes = source.geometry.attributes, index = source.geometry.index;
  world.put(1, 0, 0, BLOCK.OAK_SLAB);
  const job = createSectionMeshJob(world, 0, 0, 0, shapeAtlas);
  job.step({ flush: true });
  const group = sectionSourceGroup(job.result, renderer.materials);
  const plan = regionalPagePlan(renderer, 0, 0, 0, group, { minSection: -4 });
  const ticket = world.dirtySectionRevisions.get("0,0,0");
  t.mock.method(plan, "prepareCanonicalRanges", () => { throw new Error("injected view allocation failure"); });
  assert.throws(() => plan.step(Infinity, Infinity), /injected view allocation/);
  assert.equal(source.geometry.attributes, attributes);
  assert.equal(source.geometry.index, index);
  assert.equal(world.dirtySectionRevisions.get("0,0,0"), ticket);
  assert.equal(renderer.detailCoverage().size, 2);
  plan.dispose();
  job.dispose();
  assert.equal(plan.allocatedBytes, 0);
  assert.equal(plan.pages.length, 0);
});

test("small camera motion reuses priority lattice and no out-of-view sections are omitted", (t) => {
  const { renderer } = fixture(t, [[0, 0], [1, 0]], [[16, 0, 0, BLOCK.STONE]]);
  renderer.rebuildDirty(1);
  const layout = renderer.sectionQueueLayout;
  renderer.camera.position.x += 0.01;
  renderer.camera.rotation.y += 0.01;
  renderer.rebuildDirty(1);
  assert.equal(renderer.sectionQueueLayout, layout);
  renderer.rebuildDirty(Infinity);
  assert.equal(detailMeshResources(renderer).sections, 48);
  assert.equal(renderer.detailCoverage().size, 2);
});

test("palette exhaustion preserves the dirty section and an explicit blocked reason without leaked leases", (t) => {
  const { renderer, world } = fixture(t, [[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  renderer.meshLimits.paletteCapacity = 2;
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.meshStats.blocked.reason, "palette-overflow");
  assert.equal(renderer.geometryPalette.references, 0);
  assert.equal(renderer.geometryPalette.entries, 0);
  assert.equal(renderer.detailCoverage().size, 0);
  assert.ok(world.dirtySectionRevisions.has("0,0,0"));
  const rejected = renderer.meshStats.budgetRejections;
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.meshStats.budgetRejections, rejected);
  world.put(0, 0, 0, BLOCK.AIR);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().size, 1);
});

test("proven empty sections need no mesher scratch reservation at the retained geometry ceiling", (t) => {
  const { renderer, world } = fixture(t, [[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  renderer.rebuildDirty(Infinity);
  const live = detailMeshResources(renderer);
  renderer.meshLimits.maxCpuBytes = live.combinedCpuBytes + 8 * 1024 * 1024 + 1024;
  world.admit(1, 0);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.detailCoverage().size, 2);
  assert.equal(detailMeshResources(renderer).gpuBytes, live.gpuBytes);
});

test("late original material hooks refresh every regional clone without changing canonical geometry", (t) => {
  const { renderer } = fixture(t, [[0, 0]], [[0, 0, 0, BLOCK.STONE]]);
  renderer.rebuildDirty(Infinity);
  const region = [...renderer.sectionRegions.values()][0], page = region.userData.pages[0];
  const geometry = page.geometry, old = page.material;
  renderer.materials.opaque.alphaTest = 0.25;
  renderer.materials.opaque.onBeforeCompile = (shader) => {
    shader.vertexShader = `// late-lighting\n${shader.vertexShader}`;
  };
  refreshRegionalPaletteMaterials(renderer);
  assert.equal(page.geometry, geometry);
  assert.notEqual(page.material, old);
  assert.equal(page.material.alphaTest, 0.25);
  const shader = { uniforms: {}, vertexShader: "#include <color_vertex>", fragmentShader: "" };
  page.material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /late-lighting/);
  assert.equal(shader.uniforms.uRegionalColors.value, renderer.geometryPalette.texture);
  assert.equal(renderer.detailCoverage().size, 1);
});
