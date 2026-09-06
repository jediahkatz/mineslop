import { GameRenderer } from "../src/renderer.js";
import { BLOCK } from "../src/blocks.js";
import { authoredColumns } from "./shape-fixture.js";
import { lightingFullyReady } from "./light-renderer-fixture.js";
import { clearSectionJobs, detailMeshResources } from "../src/section-renderer.js";
import {
  beginExperimentalColdTailEpoch, experimentalColdTailEpoch,
  experimentalTailOwners, experimentalTailHeadroom,
} from "../src/experimental-tail-sealing.js";

const check = (value, message) => { if (!value) throw new Error(message); };
const difference = (a, b) => a.reduce((n, value, i) => n + Number(value !== b[i]), 0);
const RESERVE = 8 * 1024 * 1024;

/** Constrained authored full-detail input; all geometry comes from the real
 * section mesher. One host, atlas, camera and frozen lighting for both layouts.
 */
export async function runExperimentalTailGPUProbe() {
  const start = performance.now();
  const report = { phases: [], pairs: [], scope: "Authored representation GPU control; no native R4/FPS claim" };
  globalThis.experimentalTailGPUProgress = report;
  const deadline = () => check(performance.now() - start < 120000, "120s probe deadline");
  const world = authoredColumns([]);
  world.spec = { ...world.spec, minY: 0, maxY: 64 };
  for (let z = -4; z <= 8; z++) for (let x = -4; x <= 8; x++) world.admit(x, z);
  for (let y = 0; y < 64; y++) for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++)
    if ((x + y + z) % 2 === 0) world.put(x, y, z, BLOCK.STONE);
  world.getBiome = () => ({ id: "plains", category: "grassland", dimension: "overworld", fogColor: "#b4d1ce" });
  world.generate = world.ensureArea = () => { throw new Error("Authored GPU probe cannot generate"); };
  const container = document.createElement("div");
  container.style.cssText = "width:128px;height:128px";
  document.body.append(container);
  const g = new GameRenderer(container, world);
  const gl = g.renderer.getContext(), backingHandles = new WeakMap(), deletedBuffers = new Set(), deletedTextures = new Set();
  const wrappedPages = new WeakSet(), draws = [];
  let currentPage = null, drawPhase = null, disposed = false, inspectSamplers = false;
  for (const name of ["bufferData", "deleteBuffer", "deleteTexture", "drawElements", "drawArrays",
    "drawElementsInstanced", "drawArraysInstanced"]) {
    const original = gl[name].bind(gl);
    gl[name] = (...args) => {
      const result = original(...args);
      if (name === "bufferData" && ArrayBuffer.isView(args[1])) {
        const handle = gl.getParameter(args[0] === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING);
        const backing = args[1].buffer;
        if (!backingHandles.has(backing)) backingHandles.set(backing, new Set());
        backingHandles.get(backing).add(handle);
      }
      if (name === "deleteBuffer") deletedBuffers.add(args[0]);
      if (name === "deleteTexture") deletedTextures.add(args[0]);
      if (name.startsWith("draw") && currentPage) {
        const count = args[name.startsWith("drawElements") ? 1 : 2];
        if (count > 0) draws.push({ page: currentPage.id, phase: drawPhase, count, operation: name,
          indexType: name.startsWith("drawElements") ? args[2] : null,
          samplers: inspectSamplers && drawPhase === "color"
            ? globalThis.__glCallTrace.samplers(gl).samplers.map((s) => s.name) : null });
      }
      return result;
    };
  }
  const pages = () => [...(g.sectionRegions?.values() ?? [])].flatMap((r) => r.userData.pageDescriptors);
  const wrapPages = () => {
    for (const { mesh } of pages()) {
      if (wrappedPages.has(mesh)) continue;
      wrappedPages.add(mesh);
      for (const [before, after, phase] of [
        ["onBeforeRender", "onAfterRender", "color"], ["onBeforeShadow", "onAfterShadow", "shadow"],
      ]) {
        const oldBefore = mesh[before], oldAfter = mesh[after];
        mesh[before] = function(...args) { currentPage = this; drawPhase = phase; oldBefore.apply(this, args); };
        mesh[after] = function(...args) { oldAfter.apply(this, args); currentPage = null; drawPhase = null; };
      }
    }
  };
  const capCheck = () => {
    const r = detailMeshResources(g);
    check(r.combinedCpuBytes <= 256 * 1024 * 1024, "CPU ceiling");
    check(r.gpuBytes + r.reservedPageBytes <= 256 * 1024 * 1024, "GPU ceiling");
    check(r.stagingBytes <= 16 * 1024 * 1024 && r.drawCalls <= 1024, "staging/draw ceilings");
    if (experimentalTailOwners(g)) check(experimentalTailHeadroom(g) === RESERVE, "sealed physical lease lost its reserve");
    return r;
  };
  const render = () => {
    g.update(0, 10, g.camera.position);
    check(g.render() !== false, "unexpected rendering barrier");
    currentPage = null;
    check(gl.getError() === gl.NO_ERROR, "GL error after render");
  };
  const settle = (label, observe = () => {}) => {
    report.stage = label;
    for (let frame = 0; frame < 1500; frame++) {
      deadline();
      g.rebuildDirty(2);
      wrapPages();
      observe();
      capCheck();
      render();
      check((g.meshStats.lastSliceCopyBytes ?? 0) <= 1048576 &&
        g.meshStats.lastSliceCells <= 8192 && g.meshStats.lastSliceSteps <= 16, "scheduler ceilings");
      if (g.chunks.size === 81 && [...g.chunks.values()].every((column) =>
        column.userData.sections?.size === 4 && column.userData.requiredSections.every((sy) =>
          !world.dirtySectionRevisions.has(`${column.userData.cx},${column.userData.cz},${sy}`))) &&
          !g.sectionJobs.size && lightingFullyReady(g) && g.geometryPalette.pendingUploadBytes === 0) {
        report.phases.push({ label, frames: frame + 1, resources: capCheck() });
        return;
      }
    }
    throw new Error(`${label}: 1500-frame bound`);
  };
  const capture = () => {
    draws.length = 0;
    g.shadowDirty = true;
    g.lastShadowTime = -Infinity; // Same complete frozen-time shadow refresh for every comparison.
    inspectSamplers = true;
    try { render(); } finally { inspectSamplers = false; }
    const pixels = new Uint8Array(128 * 128 * 4);
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    check(gl.getError() === gl.NO_ERROR, "readPixels error");
    const color = draws.filter((d) => d.phase === "color");
    check(new Set(color.map((d) => d.page)).size === pages().length, "every physical page must actually draw");
    check(color.every((d) => d.samplers.includes("uRegionalColors") && d.samplers.includes("uBlockLightPalette")),
      "every actual page draw must sample the real geometry and block-light palettes");
    return { pixels, colorCalls: color.length, colorIndices: color.reduce((n, d) => n + d.count, 0),
      indexTypes: [...new Set(color.map((d) => d.indexType))],
      shadowCalls: draws.filter((d) => d.phase === "shadow").length };
  };
  const owned = () => {
    const geometries = pages().map((p) => p.mesh.geometry);
    const buffers = new Set();
    for (const geometry of geometries)
      for (const a of [...Object.values(geometry.attributes), geometry.index]) {
        const handles = [...(backingHandles.get(a.array.buffer) ?? [])].filter((h) => gl.isBuffer(h));
        check(handles.length > 0, "canonical attribute/index must have a real GPU buffer");
        handles.forEach((h) => buffers.add(h));
      }
    const palette = g.geometryPalette;
    const texture = g.renderer.properties.get(palette.texture).__webglTexture;
    check(gl.isTexture(texture), "real palette GPU texture required");
    check(palette.references === pages().reduce((n, p) => n + p.vertices, 0), "exact physical palette reference count");
    return { geometries, buffers, palette, texture };
  };
  const retired = (saved) => {
    check(saved.geometries.every((geometry) => geometry.index === null && !Object.keys(geometry.attributes).length),
      "retired physical CPU backing remains");
    check([...saved.buffers].every((handle) => deletedBuffers.has(handle) && !gl.isBuffer(handle)),
      "retired physical GPU buffers remain");
  };
  const retireAll = () => {
    const saved = owned();
    clearSectionJobs(g);
    for (const key of [...g.chunks.keys()]) { capCheck(); g.removeChunk(key); }
    clearSectionJobs(g);
    retired(saved);
    check(saved.palette.references === 0 && saved.palette.disposed, "palette references/disposal");
    check(deletedTextures.has(saved.texture) && !gl.isTexture(saved.texture), "palette GPU texture not deleted");
    check(experimentalTailOwners(g) === 0 && experimentalTailHeadroom(g) === 0, "retired sealed reserve remains");
    return { buffersDeleted: saved.buffers.size, paletteReferences: saved.palette.references, headroom: 0 };
  };
  const waitEvent = (name) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: 10s timeout`)), 10000);
    g.renderer.domElement.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  try {
    g.meshLimits = { regionalPages: true };
    g.setQuality("high");
    g.setRenderDistanceOverride(4);
    g.setTime(0.4);
    g.renderer.setPixelRatio(1); g.renderer.setSize(128, 128);
    g.camera.aspect = 1; g.camera.fov = 90;
    g.camera.position.set(38, 38, 38); g.camera.lookAt(6, 32, 6); g.camera.updateProjectionMatrix();
    for (const material of Object.values(g.materials)) material.fog = false;
    g.rebuildDirty(0);
    render(); // Install the production lighting/material hooks before arming.
    settle("baseline");
    const baseline = capture();
    check(pages().length === 1 && pages()[0].vertices === 110592 &&
      pages()[0].mesh.geometry.index.array instanceof Uint32Array, "nonvacuous dense baseline layout");
    report.baseline = { pages: pages().length, vertices: pages()[0].vertices,
      colorCalls: baseline.colorCalls, colorIndices: baseline.colorIndices, shadowCalls: baseline.shadowCalls,
      indexTypes: baseline.indexTypes };
    report.baselineRetirement = retireAll();
    g.meshLimits.experimentalColdTailSealing = true;
    check(beginExperimentalColdTailEpoch(g), "real host must arm experimental cold epoch");
    let sealed, sealedBackings, sealedHandles, sealedRevision, reuseObserved = false, capturedSections;
    settle("actual-candidate", () => {
      const page = pages().find((p) => p.experimentalSealed);
      if (page && !sealed) {
        sealed = page.mesh;
        sealedBackings = [...Object.values(sealed.geometry.attributes), sealed.geometry.index].map((a) => a.array.buffer);
        sealedHandles = sealedBackings.flatMap((backing) =>
          [...(backingHandles.get(backing) ?? [])].filter((handle) => gl.isBuffer(handle)));
        check(sealedHandles.length === sealedBackings.length, "sealed page must already own all five GPU buffers");
        sealedRevision = sealed.parent.userData.pageRevision;
        capturedSections = g.chunks.get("0,0").userData.sections.size;
      } else if (sealed && sealed.parent?.userData.pageRevision > sealedRevision &&
          g.chunks.get("0,0").userData.sections.size > capturedSections) {
        const current = [...Object.values(sealed.geometry.attributes), sealed.geometry.index].map((a) => a.array.buffer);
        check(page?.mesh === sealed && current.every((backing, i) => backing === sealedBackings[i]) &&
          sealedHandles.every((handle) => gl.isBuffer(handle) && !deletedBuffers.has(handle)),
          "sealed GPU owner/backing was recopied or replaced");
        reuseObserved = true;
      }
    });
    check(experimentalColdTailEpoch(g), "candidate was not active during actual host rendering");
    check(reuseObserved && capturedSections === 3 && experimentalTailOwners(g) === 1, "actual sealing and later source reuse required");
    check(pages().length === 2 && pages().every((p) => p.vertices === 55296 &&
      p.vertices <= 65532 && p.mesh.geometry.index.array instanceof Uint16Array), "candidate threshold layout");
    const candidate = capture();
    check(candidate.colorCalls === 2 && baseline.colorCalls === 1 &&
      candidate.colorIndices === baseline.colorIndices, "actual GL draw layout/index coverage");
    check(baseline.indexTypes.length === 1 && baseline.indexTypes[0] === gl.UNSIGNED_INT &&
      candidate.indexTypes.length === 1 && candidate.indexTypes[0] === gl.UNSIGNED_SHORT, "actual GL index type promotion");
    check(difference(baseline.pixels, candidate.pixels) === 0, "baseline/candidate RGBA differs");
    report.candidateImage = g.renderer.domElement.toDataURL("image/png");
    report.pairs.push({ label: "baseline-candidate", differingBytes: 0 });
    report.candidate = { pages: 2, vertices: pages().map((p) => p.vertices), sealedOwners: experimentalTailOwners(g),
      reuseObserved, colorCalls: candidate.colorCalls, colorIndices: candidate.colorIndices, shadowCalls: candidate.shadowCalls,
      indexTypes: candidate.indexTypes, actualDrawsSampleBothPalettes: true, retainedGpuBuffers: sealedHandles.length };
    const visible = [...g.sectionRegions.values()].map((r) => [r, r.visible]);
    for (const [r] of visible) r.visible = false;
    render();
    const hidden = new Uint8Array(candidate.pixels.length);
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, hidden);
    for (const [r, v] of visible) r.visible = v;
    report.visibleGeometryDifference = difference(hidden, candidate.pixels);
    check(report.visibleGeometryDifference > 32, "nonvacuity: geometry must contribute visible pixels");
    const beforeLoss = capture(), beforeOwners = experimentalTailOwners(g), palette = g.geometryPalette;
    const arrays = pages().map((p) => p.mesh.geometry.attributes.position.array);
    const references = palette.references, uploads = palette.uploadCalls, extension = gl.getExtension("WEBGL_lose_context");
    check(extension, "context loss extension required");
    let event = waitEvent("webglcontextlost"); extension.loseContext(); await event;
    check(experimentalTailOwners(g) === beforeOwners && experimentalTailHeadroom(g) === RESERVE &&
      palette.references === references, "context loss released physical/palette leases");
    await new Promise((resolve) => setTimeout(resolve, 50));
    event = waitEvent("webglcontextrestored"); extension.restoreContext(); await event;
    settle("context-restored");
    check(pages().every((p, i) => p.mesh.geometry.attributes.position.array === arrays[i]) &&
      experimentalTailOwners(g) === beforeOwners && palette.references === references, "restoration replaced canonical ownership");
    const restored = capture();
    check(difference(beforeLoss.pixels, restored.pixels) === 0 && palette.uploadCalls > uploads &&
      palette.pendingUploadBytes === 0, "exact restoration / actual palette reupload");
    report.context = { retainedPageArrays: arrays.length, retainedSealedOwners: beforeOwners,
      paletteReferences: palette.references, paletteReuploads: palette.uploadCalls - uploads,
      headroomAfterRestore: experimentalTailHeadroom(g) };
    report.pairs.push({ label: "context-restore", differingBytes: 0 });
    const saved = owned();
    check(experimentalColdTailEpoch(g), "edit must start with a live experimental epoch");
    world.put(0, 40, 0, BLOCK.AIR);
    for (const sy of [1, 3]) world.dirty(0, 0, sy);
    check(!experimentalColdTailEpoch(g) && experimentalTailHeadroom(g) === RESERVE, "edit invalidation/reserve");
    g.meshLimits.experimentalColdTailSealing = false;
    g.rebuildDirty(0);
    check(world.dirtySectionRevisions.has("0,0,2") && experimentalTailOwners(g) === 1, "premature edit acknowledgement/retirement");
    let pendingFrames = 0;
    settle("edited-dense-fallback", () => {
      if (experimentalTailOwners(g)) {
        pendingFrames++;
        check(experimentalTailHeadroom(g) === RESERVE && saved.geometries.every((geo) => geo.index),
          "pending fallback lost live backing/reserve");
      }
    });
    check(pendingFrames > 0 && pages().length === 1 && experimentalTailOwners(g) === 0 &&
      experimentalTailHeadroom(g) === 0, "dense fallback must retire sealed ownership");
    retired(saved);
    const edited = capture();
    report.edit = { pendingFrames, densePages: pages().length, retiredSealedLayoutBuffers: saved.buffers.size,
      headroomAfterRetirement: experimentalTailHeadroom(g) };
    report.candidateRetirement = retireAll();
    delete g.meshLimits.experimentalColdTailSealing;
    settle("edited-baseline");
    const editedBaseline = capture();
    check(difference(edited.pixels, editedBaseline.pixels) === 0, "edited fallback/reference pixels differ");
    report.pairs.push({ label: "edited-fallback-baseline", differingBytes: 0 });
    report.finalRetirement = retireAll();
    g.dispose(); disposed = true;
    report.afterDisposal = { geometries: g.renderer.info.memory.geometries, textures: g.renderer.info.memory.textures,
      paletteReferences: saved.palette.references, sealedOwners: experimentalTailOwners(g), headroom: experimentalTailHeadroom(g) };
    check(report.afterDisposal.geometries === 0 && report.afterDisposal.textures === 0, "host GPU allocation disposal");
    check(gl.getError() === gl.NO_ERROR, "GL disposal error");
    report.glErrors = globalThis.__glCallTrace.reports.flatMap((r) => r.firstErrors);
    check(report.glErrors.length === 0, "traced GL errors");
    report.elapsedMs = performance.now() - start;
    report.passed = true;
    return report;
  } finally {
    if (!disposed) g.dispose();
    container.remove();
  }
}
