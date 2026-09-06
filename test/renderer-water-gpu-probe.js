import * as THREE from "three";
import { GameRenderer } from "../src/renderer.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { WaterFusionGPU } from "../src/water-fusion-gpu.js";
import { sectionInspectionGeometry } from "../src/section-water-fusion.js";
import { waterFusionGLTrace, assertWaterGPUWork } from "./water-fusion-gl-trace.js";
import { nativeGeometryFixture, markNativeNeighbors } from "./regional-native-fixture.js";
import { BLOCK } from "../src/blocks.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const difference = (a, b) => a.reduce((n, v, i) => n + Number(v !== b[i]), 0);

export async function runRendererWaterProbe() {
  const fixture = nativeGeometryFixture({ seed: "cedar-valley", version: 7, radius: 2, cx: -66, cz: 85 });
  const world = fixture.world, required = new Set();
  for (let z = 84; z <= 87; z++) for (let x = -68; x <= -65; x++) required.add(`${x},${z}`);
  // Restrict receiver enumeration to the established 16-column native control.
  // All 49 generated packets remain available through get/has/entries for the
  // native mesher and lighting apron. No geometry or generator data is altered.
  world.chunks.keys = function* () { for (const key of Map.prototype.keys.call(this)) if (required.has(key)) yield key; };
  const container = document.createElement("div");
  container.style.cssText = "width:96px;height:96px"; document.body.append(container);
  const g = new GameRenderer(container, world, { waterFusion: true });
  g.meshLimits = { regionalPages: true };
  g.setRenderDistanceOverride(2);
  g.setQuality("high");
  g.renderer.setPixelRatio(1); g.renderer.setSize(96, 96);
  g.camera.aspect = 1; g.camera.updateProjectionMatrix();
  g.camera.position.set(-66 * 16 + 8, 68, 85 * 16 + 8);
  g.camera.lookAt(-66 * 16 + 8, 60, 85 * 16);
  const gl = g.renderer.getContext(), trace = waterFusionGLTrace(g.renderer);
  trace.state.failNextRows = true;
  const report = { frames: [], pairs: [], lifecycle: [], scope: "Native 16 receivers / 49 generated packets; no R12 acceptance" };
  globalThis.rendererWaterProgress = report;
  g.waterFusionBackendFactory = (renderer, changed) => {
    const backend = new WaterFusionGPU(renderer, changed);
    for (const name of ["allocateTexture", "allocateBuffer", "uploadBuffer", "uploadRows"]) {
      const original = backend[name].bind(backend);
      backend[name] = (...args) => {
        const scope = trace.state.scope; trace.state.scope = "water-step";
        try { return original(...args); } finally { trace.state.scope = scope; }
      };
    }
    return backend;
  };
  const water = () => [...g.sectionWater.owner.records.keys()].filter(m => m.userData.sectionWater.installed);
  const resources = () => detailMeshResources(g);
  const read = () => {
    const pixels = new Uint8Array(96 * 96 * 4);
    gl.readPixels(0, 0, 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    check(gl.getError() === gl.NO_ERROR, "host GL error");
    return pixels;
  };
  const tick = (draw = true) => {
    const start = trace.operations.length;
    g.rebuildDirty(2);
    g.update(0, 10, g.camera.position);
    const drawn = draw ? g.render() : null;
    const waterOperations = trace.operations.slice(start).filter(o => o.scope === "water-step");
    const actualWaterWork = waterOperations.reduce((n, o) => n + o.workBytes, 0);
    const gpuDebit = assertWaterGPUWork(g.meshStats.waterWork, waterOperations);
    const stats = resources();
    const frame = { bytes: g.meshStats.lastSliceCopyBytes, cells: g.meshStats.lastSliceCells,
      steps: g.meshStats.lastSliceSteps, waterWork: g.meshStats.waterWork,
      actualWaterWork, gpuDebit, drawn, waterPending: g.sectionWater.owner.pending.size,
      gpuBytes: stats.gpuBytes, stagingGpuBytes: stats.waterStagingGpuBytes,
      combinedCpuBytes: stats.combinedCpuBytes, stagingBytes: stats.stagingBytes,
      drawCalls: stats.drawCalls };
    check(frame.bytes <= 1048576 && frame.steps <= 16 && frame.cells <= 8192, "one shared scheduler ceiling");
    check(actualWaterWork <= frame.bytes, "actual water GL work must be charged in the shared copy budget");
    check(frame.drawCalls <= 1024, "never attach an over-cap scene");
    check(stats.gpuBytes + stats.waterStagingGpuBytes + stats.reservedPageBytes <= 256 * 1024 * 1024, "GPU reservations");
    check(stats.combinedCpuBytes <= 256 * 1024 * 1024 && stats.stagingBytes <= 16 * 1024 * 1024, "CPU/staging reservations");
    report.frames.push(frame);
  };
  const complete = () => {
    for (const key of required) {
      if (!world.chunks.has(key)) continue;
      const column = g.chunks.get(key);
      if (!column?.userData.meshed) return false;
      for (const sy of column.userData.requiredSections)
        if (world.dirtySectionRevisions.has(`${key},${sy}`)) return false;
    }
    return !g.sectionJobs.size && !g.sectionWater.owner.pending.size && g.sectionWater.canRender();
  };
  const settle = label => {
    const started = performance.now(), before = report.frames.length;
    do {
      tick((report.frames.length - before) % 8 === 0);
      if (complete()) { tick(); report.lifecycle.push({ label, frames: report.frames.length - before }); return; }
    } while (report.frames.length - before < 6000 && performance.now() - started < 90000);
    throw new Error(`${label} incomplete: ${JSON.stringify({ stats: g.meshStats,
      water: [...g.sectionWater.owner.records.values()].map(r => [r.phase, r.error]),
      jobs: [...g.sectionJobs.values()].map(j => [j.stamp.cx, j.stamp.cz, j.stamp.sy, j.status]) })}`);
  };
  const capture = reference => {
    const saved = water().map(mesh => {
      const r = g.sectionWater.owner.records.get(mesh);
      const state = { mesh, r, geometry: mesh.geometry, material: mesh.material, before: mesh.onBeforeRender };
      if (reference) {
        mesh.geometry = sectionInspectionGeometry(mesh);
        mesh.material = g.materials.water; mesh.onBeforeRender = r.sourceBefore;
      }
      return state;
    });
    trace.draws.length = 0;
    try {
      g.renderer.render(g.scene, g.camera);
      return { pixels: read(), calls: trace.draws.slice() };
    } finally {
      for (const state of saved) {
        if (reference) state.mesh.geometry.dispose(); // Test-only conventional GPU copies, never retained through loss.
        Object.assign(state.mesh, { geometry: state.geometry, material: state.material, onBeforeRender: state.before });
      }
    }
  };
  const pair = label => {
    const a = capture(true), b = capture(false), ids = new Set(water().map(m => m.id));
    const diff = difference(a.pixels, b.pixels);
    const expanded = b.calls.flatMap(c => ids.has(c.id) ? [c.id, c.id] : [c.id]);
    if (JSON.stringify(expanded) !== JSON.stringify(a.calls.map(c => c.id))) report.orderFailure = {
      label, camera: g.camera.position.toArray(), reference: a.calls, fused: b.calls,
      water: water().map(mesh => ({ id: mesh.id, current: g.sectionWater.owner.records.get(mesh).current(),
        visible: mesh.visible, range: mesh.geometry.drawRange, column: [mesh.userData.sectionWater.stamp.cx, mesh.userData.sectionWater.stamp.cz] })),
    };
    check(JSON.stringify(expanded) === JSON.stringify(a.calls.map(c => c.id)), `${label}: source order`);
    check(diff === 0, `${label}: ${diff} differing RGBA bytes`);
    report.pairs.push({ label, differingBytes: diff, referenceCalls: a.calls.length, fusedCalls: b.calls.length,
      referenceWaterCalls: a.calls.filter(c => ids.has(c.id)).length,
      fusedWaterCalls: b.calls.filter(c => ids.has(c.id)).length });
    return b.pixels;
  };
  const waitEvent = name => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timeout`)), 10000);
    g.renderer.domElement.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  try {
    settle("initial-native");
    check(g.sectionWater.owner.stats.failures === 1, "initial real GL transfer failure retried");
    check(g.chunks.size === 16 && water().length === 33, `expected 16 columns/33 sources: ${g.chunks.size}/${water().length}`);
    check(g.contextResourceOwners.has(g.sectionWater), "actual GameRenderer collector registration");
    const canonical = g.sectionWater.owner.resources();
    report.initial = { resources: resources(), canonical, columns: g.chunks.size,
      sections: [...g.chunks.values()].reduce((n, c) => n + c.userData.sections.size, 0) };
    check(canonical.allocatedCpuBytes === 1169080 && canonical.allocatedOwnedGpuBytes === 1166968, "native canonical payload matches core proof");
    water().forEach(m => m.frustumCulled = false);
    pair("all-native-water-census");
    water().forEach(m => m.frustumCulled = true);
    for (const [label, offset] of [["above", [8, 22, 14]], ["below", [9, -12, 14]], ["grazing", [-15, 0.3, 3]]]) {
      const center = new THREE.Vector3(-66 * 16 + 8, 60, 85 * 16 + 8);
      // Keep all 16 sources inside the host's retained radius. The standalone
      // core suite owns arbitrary camera views without host radius invalidation.
      g.camera.position.copy(center).add(new THREE.Vector3(...offset)); g.camera.lookAt(center);
      pair(label);
    }
    g.camera.position.set(-66 * 16 + 8, 68, 85 * 16 + 8);
    g.camera.lookAt(-66 * 16 + 8, 60, 85 * 16);
    g.setQuality("low"); g.setRenderDistanceOverride(2); settle("quality-low"); pair("quality-low");
    g.setQuality("high"); g.setRenderDistanceOverride(2); settle("quality-high"); pair("quality-high");
    const candidate = water()[0], entry = candidate.userData.sectionWater;
    const oldData = g.sectionWater.owner.records.get(candidate).data;
    const { cx, cz, sy } = entry.stamp, chunk = world.chunks.get(`${cx},${cz}`);
    let cell = -1;
    for (let i = Math.max(0, (sy * 16 - world.spec.minY) * 256);
      i < Math.min(chunk.blocks.length, (sy * 16 + 16 - world.spec.minY) * 256); i++)
      if (chunk.blocks[i] === BLOCK.WATER) { cell = i; break; }
    check(cell >= 0, "native editable water cell");
    world.put(cx * 16 + cell % 16, world.spec.minY + Math.floor(cell / 256), cz * 16 + Math.floor(cell % 256 / 16), BLOCK.STONE);
    markNativeNeighbors(fixture, cx, cz, sy);
    trace.state.failNextRows = true;
    g.sectionMeshLimits = { maxCellsPerSlice: 32 };
    tick(false);
    check(g.sectionWater.owner.records.get(candidate)?.data === oldData && candidate.parent === entry.group,
      "old native water remains until detached replacement commits");
    const oldGeometry = candidate.geometry;
    g.sectionMeshLimits = {};
    for (let i = 0; i < 1000 && trace.state.failNextRows; i++) tick(false);
    check(!trace.state.failNextRows && g.sectionWater.owner.records.get(candidate)?.data === oldData,
      "failed replacement transfer leaves the old native source owned and attached");
    settle("native-edit");
    check(oldGeometry.index === null, "retired native source releases index backing");
    pair("after-edit");
    const unloadKey = `${cx},${cz}`;
    world.chunks.delete(unloadKey); world.removedChunks.add(unloadKey);
    markNativeNeighbors(fixture, cx, cz);
    settle("unload");
    check(!g.chunks.has(unloadKey), "unloaded column removed");
    fixture.admit(cx, cz); markNativeNeighbors(fixture, cx, cz);
    settle("reload"); pair("after-reload");
    // Warm once with fixed view/time before loss. Lighting is flushed only by
    // GameRenderer.render; this test makes no complete native-light readiness claim.
    tick(); const before = pair("before-context-loss");
    const arrays = new Map(water().map(mesh => [mesh, g.sectionWater.owner.records.get(mesh).data]));
    const extension = gl.getExtension("WEBGL_lose_context"), lost = waitEvent("webglcontextlost");
    extension.loseContext(); await lost;
    check(!g.sectionWater.canRender(), "lost context is not drawable");
    await new Promise(resolve => setTimeout(resolve, 50));
    const restored = waitEvent("webglcontextrestored"); extension.restoreContext(); await restored;
    settle("context-restored");
    check(water().every(mesh => g.sectionWater.owner.records.get(mesh).data === arrays.get(mesh)), "actual host recovery retains canonical CPU arrays");
    const after = pair("after-context-restore");
    report.contextPixelDifference = difference(before, after);
    report.transferFailures = g.sectionWater.owner.stats.failures;
    report.lighting = { uploadStats: g.daylightMaterial.uploadStats, nativeFullyReadyClaim: false };
    const retired = water().map(m => m.geometry);
    g.world = { ...world, epoch: world.epoch + 1 };
    g.rebuildDirty(0);
    check(g.sectionWater.owner.records.size === 0 && retired.every(geometry => geometry.index === null), "world swap releases every old water owner");
    report.lifecycle.push({ label: "world-swap", owners: 0 });
    return report;
  } finally { g.dispose(); fixture.dispose(); }
}
