import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { releaseLostContextResources } from "../src/context-resources.js";
import { landmarkDetailSections } from "../src/distant-landmarks.js";
import { createSectionMeshJob } from "../src/section-mesh.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { sectionGeometryCovered } from "../src/section-pages.js";
import { shapeAtlas } from "./shape-fixture.js";
import { addBuffers, bytes, regionalRegressionFixture, physicalState, mixedReservationOracle } from "./regional-regression-fixture.js";

test("regional regression: v3 enable-disable-reenable retires old physical owners", (t) => {
  const { renderer } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE],
  ]);
  renderer.rebuildDirty(Infinity);
  const enabled = physicalState(renderer);
  const oldRegions = [...renderer.sectionRegions.values()];
  const oldPages = oldRegions.flatMap((region) => region.userData.pages);
  const oldPalette = renderer.geometryPalette;
  const disposals = new Map(oldPages.map((page) => [page, 0]));
  for (const page of oldPages)
    page.geometry.addEventListener("dispose", () => disposals.set(page, disposals.get(page) + 1));
  renderer.meshLimits.regionalPages = false;
  renderer.rebuildDirty(Infinity);
  const disabled = physicalState(renderer);
  const retired = oldPages.map((page) => ({
    attached: !!page.parent, disposeCount: disposals.get(page),
    attributes: Object.keys(page.geometry.attributes).length,
  }));
  renderer.meshLimits.regionalPages = true;
  renderer.rebuildDirty(Infinity);
  const reenabled = physicalState(renderer);
  assert.equal(enabled.coverage.length, 2);
  assert.equal(disabled.packingMode, "column");
  assert.equal(disabled.regions, 0);
  assert.equal(disabled.paletteRetained, false);
  assert.equal(disabled.reportedGpuBytes, disabled.physicalGeometryBytes);
  assert.equal(disabled.coverage.length, 2);
  assert.ok(retired.every((page) => !page.attached && page.disposeCount === 1 && page.attributes === 0));
  assert.equal(reenabled.coverage.length, 2);
  assert.notEqual(renderer.geometryPalette, oldPalette);
});

for (const dense of [false, true])
  test(`regional regression: maxJobs=2 adds ready bytes to pending reservation (${dense ? "fences" : "stone"})`, (t) => {
    const entries = dense
      ? Array.from({ length: 144 }, (_, i) => [i % 12, 0, Math.floor(i / 12), BLOCK.OAK_FENCE])
      : [[1, 0, 1, BLOCK.STONE]];
    const { renderer } = regionalRegressionFixture(t, [...entries, [17, 0, 1, BLOCK.STONE]]);
    Object.assign(renderer.meshLimits, { maxJobs: 2, maxStepsPerSlice: 1, maxCopyBytesPerSlice: 0 });
    let mixed = false;
    for (let i = 0; i < 200; i++) {
      renderer.rebuildDirty(1);
      const jobs = [...renderer.sectionJobs.values()];
      mixed = jobs.some((job) => job.status === "ready" && job.bytes > 0) &&
        jobs.some((job) => !job.done);
      if (mixed) break;
    }
    const stats = detailMeshResources(renderer), expected = mixedReservationOracle(renderer);
    const jobs = [...renderer.sectionJobs.values()].map((job) => ({
      className: job.constructor.name, status: job.status, bytes: job.bytes,
      snapshotBytes: job.snapshotBytes, limit: job.limits.maxTotalBytes,
      pageReservation: job.pagePlan?.stagingBytes ?? 0,
    }));
    assert.ok(mixed, `fixture must exercise actual ready and pending SectionMeshJobs: ${JSON.stringify(jobs)}`);
    assert.ok(expected.readyBytes > 0);
    assert.ok(stats.stagingBytes >= expected.stagingMinimum,
      `reported staging ${stats.stagingBytes} must cover ${JSON.stringify(expected)}`);
    assert.ok(stats.combinedCpuBytes >= stats.canonicalBytes + expected.stagingMinimum);
  });

for (const operation of ["disable", "world", "radius"])
  test(`regional regression: ${operation} cancels allocated replacement after context loss`, (t) => {
    const { world, renderer } = regionalRegressionFixture(t, [
      [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE],
    ]);
    renderer.rebuildDirty(Infinity);
    const oldColumns = [...renderer.chunks.values()];
    const oldSources = oldColumns.flatMap((column) => [...column.userData.sections.values()])
      .flatMap((section) => section.group.children);
    const oldPage = oldColumns[0].userData.pages[0];
    const oldArrays = oldPage.geometry.attributes;
    const palette = renderer.geometryPalette, references = palette.references;
    releaseLostContextResources({ getContext: () => ({ isContextLost: () => true }) }, renderer.scene);
    palette.restoreGPU();
    assert.equal(oldPage.geometry.attributes, oldArrays);
    assert.equal(palette.references, references);
    assert.equal(renderer.detailCoverage().size, 2);
    for (let i = 0; i < 100; i++) world.put(i % 10, 0, Math.floor(i / 10), BLOCK.OAK_FENCE);
    renderer.meshLimits.maxCopyBytesPerSlice = 16384;
    let job;
    for (let i = 0; i < 200; i++) {
      renderer.rebuildDirty(1);
      job = [...renderer.sectionJobs.values()].find((candidate) => candidate.pagePlan?.allocatedBytes > 0);
      if (job) break;
    }
    assert.ok(job, "real replacement plan must have allocated backing");
    const plan = job.pagePlan;
    const stagedPages = plan.pages.filter((page) => !page.reused && page.mesh).map((page) => page.mesh);
    const counts = new Map([oldPage, ...stagedPages].map((page) => [page, 0]));
    for (const page of counts.keys())
      page.geometry.addEventListener("dispose", () => counts.set(page, counts.get(page) + 1));
    if (operation === "world") {
      const next = regionalRegressionFixture(t, [[1, 0, 1, BLOCK.STONE]], [[0, 0]]).world;
      next.epoch = world.epoch + 1;
      renderer.world = next;
    } else if (operation === "radius") {
      renderer.renderDistanceOverride = 0;
      renderer.camera.position.x = 160;
    } else renderer.meshLimits.regionalPages = false;
    renderer.rebuildDirty(0);
    assert.equal(renderer.sectionJobs.size, 0);
    assert.equal(renderer.sectionCompaction, null);
    assert.equal(plan.disposed, true);
    assert.equal(plan.allocatedBytes, 0);
    assert.equal(palette.references, 0);
    assert.equal(palette.disposed, true);
    for (const [page, count] of counts) {
      assert.equal(count, 1, "retirement, separate from the prior context disposal");
      assert.equal(page.parent, null);
      assert.deepEqual(page.geometry.attributes, {});
    }
    for (const source of oldSources) {
      assert.deepEqual(source.geometry.attributes, {});
      assert.equal(source.geometry.index, null);
      assert.equal(source.userData.canonicalRange, undefined);
    }
    if (operation === "disable") {
      assert.equal(renderer.geometryPalette, null);
      renderer.meshLimits.regionalPages = true;
    } else if (operation === "radius") {
      renderer.renderDistanceOverride = 2;
      renderer.camera.position.x = 15.5;
    }
    renderer.rebuildDirty(Infinity);
    assert.equal(renderer.detailCoverage().size, operation === "world" ? 1 : 2);
  });

test("regional regression: disabling cancels in-flight compaction and frees its leases", (t) => {
  const entries = [0, 1].flatMap((cx) => Array.from({ length: 100 },
    (_, i) => [cx * 16 + i % 10, 0, Math.floor(i / 10), BLOCK.OAK_FENCE]));
  const { world, renderer } = regionalRegressionFixture(t, entries);
  renderer.rebuildDirty(Infinity);
  const palette = renderer.geometryPalette;
  world.chunks.delete("0,0");
  renderer.removeChunk("0,0");
  renderer.meshLimits.maxCopyBytesPerSlice = 16384;
  renderer.rebuildDirty(1);
  const plan = renderer.sectionCompaction?.plan;
  assert.ok(plan?.allocatedBytes > 0);
  const before = detailMeshResources(renderer);
  assert.ok(before.reservedPageBytes >= plan.allocatedBytes);
  assert.ok(before.combinedCpuBytes <= renderer.meshStats.limits.maxCpuBytes);
  assert.ok(before.gpuBytes + before.reservedPageBytes <= renderer.meshStats.limits.maxGpuBytes);
  renderer.meshLimits.regionalPages = false;
  renderer.rebuildDirty(Infinity);
  assert.equal(plan.disposed, true);
  assert.equal(plan.allocatedBytes, 0);
  assert.equal(palette.references, 0);
  assert.equal(palette.disposed, true);
  assert.equal(renderer.sectionCompaction, null);
  assert.equal(renderer.sectionRegions.size, 0);
  assert.equal(renderer.geometryPalette, null);
  assert.deepEqual([...renderer.detailCoverage()], ["1,0"]);
});

test("regional regression: two real ready jobs deduplicate shared and installed backing identities", (t) => {
  const { world, renderer } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE],
  ]);
  renderer.rebuildDirty(Infinity);
  renderer.meshLimits.maxJobs = 2;
  const jobs = [0, 1].map((cx) => {
    const job = createSectionMeshJob(world, cx, 0, 0, shapeAtlas, { typedScratch: true });
    job.step({ flush: true });
    assert.equal(job.status, "ready");
    renderer.sectionJobs.set(`${cx},0,0`, job);
    return job;
  });
  const first = jobs[0].result.parts[0].opaque;
  const second = jobs[1].result.parts[0].opaque;
  const color = first.attributes.color;
  const shared = new SharedArrayBuffer(color.array.byteLength);
  new Float32Array(shared).set(color.array);
  first.setAttribute("color", new THREE.BufferAttribute(new Float32Array(shared), color.itemSize));
  second.setAttribute("color", new THREE.BufferAttribute(new Float32Array(shared), color.itemSize));
  const installed = renderer.chunks.get("0,0").userData.sections.get(0).group.children[0].geometry;
  first.setAttribute("position", installed.attributes.position);
  second.setAttribute("position", installed.attributes.position);
  const backing = new Set();
  for (const job of jobs)
    for (const part of job.result.parts)
      for (const geometry of Object.values(part)) addBuffers(geometry, backing);
  const installedBacking = new Set();
  renderer.scene.traverse((mesh) => { if (mesh.isMesh) addBuffers(mesh.geometry, installedBacking); });
  for (const buffer of installedBacking) backing.delete(buffer);
  const stats = detailMeshResources(renderer);
  assert.equal(stats.stagingSourceBytes, bytes(backing));
  assert.equal(stats.stagingBytes, bytes(backing) + stats.paletteUploadStagingBytes);
});

test("regional regression: replacement and scratch stay within reduced combined/staging caps", (t) => {
  const { world, renderer } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE],
  ]);
  renderer.rebuildDirty(Infinity);
  Object.assign(renderer.meshLimits, {
    maxJobs: 2, maxCopyBytesPerSlice: 16384,
    maxStagingBytes: 6 * 1024 * 1024, maxCpuBytes: 10 * 1024 * 1024, maxGpuBytes: 8 * 1024 * 1024,
  });
  for (let i = 0; i < 144; i++) world.put(i % 12, 0, Math.floor(i / 12), BLOCK.OAK_FENCE);
  world.put(17, 0, 1, BLOCK.OAK_FENCE);
  let copying = false;
  for (let i = 0; i < 1000; i++) {
    renderer.rebuildDirty(1);
    const stats = detailMeshResources(renderer);
    const expected = mixedReservationOracle(renderer);
    copying ||= stats.stagingPageBytes > 0;
    assert.ok(stats.stagingBytes >= expected.stagingMinimum);
    assert.ok(stats.stagingBytes <= renderer.meshLimits.maxStagingBytes);
    assert.ok(stats.combinedCpuBytes <= renderer.meshLimits.maxCpuBytes);
    assert.ok(stats.gpuBytes + stats.reservedPageBytes <= renderer.meshLimits.maxGpuBytes);
    assert.ok(renderer.meshStats.lastSliceCopyBytes <= 16384);
    if (!world.dirtySectionRevisions.size && !renderer.sectionJobs.size) break;
  }
  assert.equal(copying, true);
  assert.equal(world.dirtySectionRevisions.size, 0);
  assert.equal(renderer.sectionJobs.size, 0);
  assert.equal(renderer.detailCoverage().size, 2);
});

test("regional regression: shared physical owners, logical emptiness and End coverage agree", (t) => {
  const { renderer } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE], [2, 0, 2, BLOCK.WATER],
  ]);
  renderer.rebuildDirty(Infinity);
  const first = renderer.chunks.get("0,0"), peer = renderer.chunks.get("1,0");
  const region = first.userData.sectionRegion, page = region.userData.pages[0];
  const section = first.userData.sections.get(0);
  const source = section.group.children.find((mesh) => mesh.userData.sectionSource);
  const water = section.group.children.find((mesh) => !mesh.userData.sectionSource);
  const check = (key, expected) => {
    assert.equal(renderer.detailCoverage().has(key), expected);
    assert.equal(landmarkDetailSections(renderer.chunks, renderer.camera).has(`${key},0`), expected);
    const stats = detailMeshResources(renderer), physical = physicalState(renderer);
    assert.equal(stats.visibleDrawCalls, physical.visibleSubmissions);
  };
  assert.equal(source.layers.mask, 0);
  check("0,0", true); check("1,0", true);
  renderer.camera.layers.set(1);
  page.layers.set(1); water.layers.set(1);
  check("0,0", true);
  assert.equal(sectionGeometryCovered(first, section), false, "no-camera API defaults to layer zero");
  assert.equal(landmarkDetailSections(renderer.chunks).has("0,0,0"), false);
  // Ancestor layers do not suppress child draws in Three.
  region.layers.mask = 0; first.layers.mask = 0; section.group.layers.mask = 0;
  check("0,0", true);
  first.visible = false;
  check("0,0", false); check("1,0", true);
  first.visible = true;
  for (const [breakOwner, restore] of [
    [() => region.remove(page), () => region.add(page)],
    [() => renderer.scene.remove(region), () => renderer.scene.add(region)],
    [() => { region.visible = false; }, () => { region.visible = true; }],
    [() => { page.layers.mask = 0; }, () => page.layers.set(1)],
  ]) {
    breakOwner(); check("0,0", false); check("1,0", false);
    restore(); check("0,0", true); check("1,0", true);
  }
  section.group.remove(water);
  check("0,0", false); check("1,0", true);
  section.group.add(water);
  renderer.scene.remove(peer);
  check("1,0", false); check("0,0", true);
  renderer.scene.add(peer);
  // A source must never impersonate a physical page, even if its layer changes.
  source.layers.set(1);
  const range = first.userData.sectionRanges.get(source);
  first.userData.sectionRanges.set(source, { ...range, mesh: source });
  check("0,0", false);
  first.userData.sectionRanges.set(source, range);
  source.layers.mask = 0;
  const empty = first.userData.sections.get(1);
  assert.equal(sectionGeometryCovered(first, empty, renderer.camera), true);
  empty.bytes = 1;
  assert.equal(sectionGeometryCovered(first, empty, renderer.camera), false);
  empty.bytes = 0;
});

for (const batch of ["opaque", "water"])
  test(`regional regression: ${batch} physical layers match the camera`, (t) => {
    const id = batch === "water" ? BLOCK.WATER : BLOCK.STONE;
    const { renderer } = regionalRegressionFixture(t, [[1, 0, 1, id]], [[0, 0]]);
    renderer.rebuildDirty(Infinity);
    const column = renderer.chunks.get("0,0");
    const source = column.userData.sections.get(0).group.children.find((mesh) => mesh.userData.batch === batch);
    const physical = source.userData.sectionSource ? column.userData.sectionRanges.get(source).mesh : source;
    const cases = [];
    for (const [cameraMask, physicalMask] of [[1, 1], [1, 0], [1, 2], [2, 1], [2, 2]]) {
      renderer.camera.layers.mask = cameraMask;
      physical.layers.mask = physicalMask;
      cases.push({ cameraMask, physicalMask, logicalMask: source.layers.mask,
        expectedCovered: !!(cameraMask & physicalMask), ...physicalState(renderer) });
    }
    for (const sample of cases) {
      assert.equal(sample.coverage.includes("0,0"), sample.expectedCovered,
        `${batch}: camera=${sample.cameraMask} physical=${sample.physicalMask}`);
      assert.equal(sample.reportedVisibleSubmissions, sample.visibleSubmissions,
        `${batch}: camera=${sample.cameraMask} physical=${sample.physicalMask} submissions`);
    }
  });
