import * as THREE from "three";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";
import { createChunkMaterials } from "../src/renderer.js";
import { WaterFusionGPU } from "../src/water-fusion-gpu.js";
import { planWaterGeometry } from "../src/water-fusion-geometry.js";
import { waterFusionGLTrace, assertWaterGPUWork } from "./water-fusion-gl-trace.js";
import { BLOCK } from "../src/blocks.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const bytes = geometry => geometry.index.array.byteLength +
  Object.values(geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0);
const diff = (a, b) => a.reduce((n, x, i) => n + Number(x !== b[i]), 0);

function fixture(report, { columns = [[0, 0]], cells = [], cameraX = 8, limits = {}, control = false } = {}) {
  const world = authoredColumns(columns, cells), g = shapeRenderer(world);
  const oldMaterials = g.materials;
  const texture = new THREE.DataTexture(new Uint8Array([95, 155, 210, 255]), 1, 1);
  const emissiveTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  texture.needsUpdate = emissiveTexture.needsUpdate = true;
  g.atlas = { texture, emissiveTexture, uvFor: () => [0, 0, 1, 1] };
  g.materials = createChunkMaterials(g.atlas);
  Object.values(oldMaterials).forEach(m => m.dispose());
  g.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  g.renderer.setSize(64, 64); document.body.append(g.renderer.domElement);
  g.renderer.initTexture(texture); g.renderer.initTexture(emissiveTexture);
  g.camera.aspect = 1; g.camera.updateProjectionMatrix();
  g.camera.position.set(cameraX, 12, 12); g.camera.lookAt(cameraX, 8, 8);
  g.scene.background = new THREE.Color(0x152535);
  g.scene.add(new THREE.AmbientLight(0xffffff, 3));
  g.waterFusionEnabled = true; g.contextResourceOwners = new Set();
  g.meshLimits = { regionalPages: true, maxCopyBytesPerSlice: 32768, ...limits };
  const gl = g.renderer.getContext(), trace = waterFusionGLTrace(g.renderer);
  const controlHandles = new Set(), waterHandles = new Set();
  let cube;
  if (control) {
    cube = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0xef823a }));
    cube.position.set(7, 8.5, 8); g.scene.add(cube);
    g.renderer.render(g.scene, g.camera);
    for (const op of trace.operations) controlHandles.add(op.handle);
  }
  g.waterFusionBackendFactory = (renderer, changed) => {
    const gpu = new WaterFusionGPU(renderer, changed);
    for (const method of ["allocateTexture", "allocateBuffer", "uploadRows", "uploadBuffer"]) {
      const original = gpu[method].bind(gpu);
      gpu[method] = (...args) => {
        const before = trace.operations.length, previous = trace.state.scope;
        trace.state.scope = "water-step";
        try { return original(...args); } finally {
          trace.state.scope = previous;
          for (const op of trace.operations.slice(before)) waterHandles.add(op.handle);
        }
      };
    }
    return gpu;
  };
  const allocation = () => {
    let all = 0, water = 0;
    for (const [handle, value] of [...trace.buffers, ...trace.textures]) {
      if (controlHandles.has(handle)) continue;
      const n = typeof value === "number" ? value : value.bytes;
      all += n; if (waterHandles.has(handle)) water += n;
    }
    return { all, water };
  };
  const tick = () => {
    const before = trace.operations.length;
    g.rebuildDirty(2);
    const allowed = g.render();
    const operations = trace.operations.slice(before).filter(o => o.scope === "water-step");
    const debit = assertWaterGPUWork(g.meshStats.waterWork, operations);
    const h = g.sectionWater, own = h.owner.resources(), external = h.accounting.external(), actual = allocation();
    check(actual.water <= own.allocatedOwnedGpuBytes, "actual water allocation exceeds owned ledger");
    if (actual.all > own.reservedGpuBytes + external.gpuBytes) {
      const active = h.reclaim.active;
      report.failedAccounting = { actual, own, external,
        retirement: active && { key: active.key, region: active.region.userData.key,
          registered: g.sectionRegions.get(active.region.userData.key) === active.region,
          sections: active.region.userData.sections.size, pages: active.region.userData.pages.length,
          descriptors: active.region.userData.pageDescriptors.map(p => ({ sources: p.sources.length, bytes: p.bytes })) },
        work: g.meshStats.waterWork };
    }
    check(actual.all <= own.reservedGpuBytes + external.gpuBytes,
      `actual backing exceeds host + core reservation: ${actual.all} > ${own.reservedGpuBytes + external.gpuBytes}`);
    check(g.meshStats.lastSliceCopyBytes <= g.meshStats.limits.maxCopyBytesPerSlice, "shared copy cap");
    check(g.meshStats.lastSliceSteps <= g.meshStats.limits.maxStepsPerSlice, "shared operation cap");
    check(own.reservedDrawCalls + h.accounting.externalDraws + h.attachments.reserved <= h.owner.limits.maxDrawCalls,
      "attached + held draw reservations exceed cap");
    check(gl.getError() === gl.NO_ERROR, "GL error in pressure frame");
    report.frames.push({ bytes: g.meshStats.lastSliceCopyBytes, steps: g.meshStats.lastSliceSteps,
      work: g.meshStats.waterWork, debit, actual, reservedGpu: own.reservedGpuBytes + external.gpuBytes,
      reservedDraws: own.reservedDrawCalls + h.accounting.externalDraws + h.attachments.reserved, allowed });
  };
  const until = (predicate, label) => {
    for (let i = 0; i < 3000 && !predicate(); i++) tick();
    check(predicate(), `${label}: ${JSON.stringify({ stats: g.meshStats,
      jobs: [...g.sectionJobs].map(([key, j]) => [key, j.status]),
      pending: [...g.sectionWater.owner.pending].map(r => [r.phase, r.error]) })}`);
  };
  const settle = () => until(() => !!g.sectionWater && !g.sectionJobs.size &&
    !world.dirtySectionRevisions.size && !g.sectionWater.owner.pending.size &&
    !g.sectionWater.refreshPending, "initial/refresh settle");
  const hold = () => {
    const h = g.sectionWater, original = h.prepare;
    let job = null;
    h.prepare = j => { job = j; return false; };
    return { wait() { until(() => job?.status === "ready" && !!job.pagePlan, "completed preparation"); return job; },
      restore() { h.prepare = original; }, forget() { job = null; } };
  };
  const read = () => {
    const pixels = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    check(gl.getError() === gl.NO_ERROR, "pressure pixel read");
    return pixels;
  };
  return { g, world, trace, gl, tick, until, settle, hold, read, allocation,
    dispose() {
      disposeShapeRenderer(g); g.sectionWater?.dispose();
      cube?.geometry.dispose(); cube?.material.dispose();
      texture.dispose(); emissiveTexture.dispose(); g.renderer.dispose(); g.renderer.domElement.remove();
    } };
}

export function runWaterPressureProbe(control = "all") {
  check(["all", "reclaim", "fallback", "visibility"].includes(control), "unknown pressure control");
  const report = { frames: [], reclaim: null, fallback: null, visibility: [],
    scope: "Authored bounded pressure controls, actual WebGL; not native capacity/readiness" };
  globalThis.waterPressureProgress = report;
  if (control === "all" || control === "reclaim") {
    const f = fixture(report, { columns: [[-3, 0], [0, 0]], cameraX: -8,
      cells: [[-40, 8, 8, BLOCK.STONE], [8, 8, 8, BLOCK.WATER]] });
    try {
      f.settle();
      // Warm the retained opaque page through a real draw before it leaves
      // the view; reclaim must delete an actual allocation, not just a promise.
      f.g.camera.position.set(-40, 12, 12); f.g.camera.lookAt(-40, 8, 8);
      const warmStart = f.trace.operations.length;
      f.g.renderer.render(f.g.scene, f.g.camera);
      const retainedHandles = f.trace.operations.slice(warmStart)
        .filter(op => op.method === "bufferData").map(op => op.handle);
      check(retainedHandles.length > 0, "hidden page never acquired actual GPU backing");
      f.g.camera.position.set(8, 12, 12); f.g.camera.lookAt(8, 8, 8); f.tick();
      const hidden = f.g.chunks.get("-3,0"), old = f.g.chunks.get("0,0").userData.sections.get(0).group;
      check(!hidden.visible, "actual hidden retention");
      const reclaimable = hidden.userData.sectionRegion.userData.pages.reduce((n, m) => n + bytes(m.geometry), 0);
      const gate = f.hold(); f.world.put(8, 8, 8, BLOCK.WATER, 0, 2);
      let job = gate.wait();
      const mesh = job.waterGroup.children.find(m => m.userData.batch === "water");
      const p = planWaterGeometry(mesh, f.g.meshStats.limits.maxCopyBytesPerSlice);
      const peak = p.textureBytes + p.indexBytes + [...p.attributes, p.index].reduce((n, a) => n + a.array.byteLength, 0);
      const h = f.g.sectionWater, resident = h.owner.resources().reservedGpuBytes + h.accounting.external().gpuBytes;
      const cap = resident + peak - Math.floor(reclaimable / 2);
      f.g.meshLimits.maxGpuBytes = cap; gate.forget(); job = gate.wait(); gate.restore();
      const start = report.frames.length, ticket = f.world.dirtySectionRevisions.get("0,0,0");
      f.until(() => f.g.chunks.get("0,0").userData.sections.get(0).group !== old &&
        !f.world.dirtySectionRevisions.has("0,0,0"), "automatic GPU reclaim");
      check(!f.g.chunks.has("-3,0"), "reclaim did not retire hidden column");
      check(retainedHandles.every(handle => !f.trace.buffers.has(handle)), "retained GL buffers survived reclaim");
      const frames = report.frames.slice(start);
      check(frames.some(frame => frame.work.some(w => w.kind === "reclaim-page-payload-release")), "unmetered reclaim");
      check(frames.every(frame => frame.actual.all <= cap), "actual allocation exceeded pressure cap");
      report.reclaim = { cap, resident, peak, reclaimable, ticket, frames: frames.length,
        peakActual: Math.max(...frames.map(frame => frame.actual.all)), manualEviction: false,
        deletedActualBuffers: retainedHandles.length };
    } catch (error) {
      report.reclaimFailure = String(error.stack ?? error); throw error;
    } finally {
      try { f.dispose(); } catch (error) {
        report.reclaimCleanupFailure = String(error.stack ?? error);
        if (!report.reclaimFailure) throw error;
      }
    }
  }
  if (control === "all" || control === "fallback") {
    const f = fixture(report, { cells: [[8, 8, 8, BLOCK.WATER]], limits: { maxDrawCalls: 2 } });
    try {
      f.settle();
      const h = f.g.sectionWater, [a] = h.owner.records.keys(), r = h.owner.records.get(a);
      const gate = f.hold(); f.world.put(8, 24, 8, BLOCK.WATER);
      const job = gate.wait(), b = job.waterGroup.children.find(m => m.userData.batch === "water");
      // Prepare and finish B while holding host publication.
      const original = h.prepare; gate.restore(); h.prepare(job); h.prepare = original;
      f.until(() => h.owner.status(b)?.ready, "detached B");
      f.g.meshLimits.maxCopyBytesPerSlice = r.plan.vboBytes;
      a.castShadow = true; h.refresh();
      f.g.meshStats.lastSliceCopyBytes = 0; f.g.meshStats.waterWork = [];
      h.step({ ...f.g.meshStats.limits, maxCopyBytesPerSlice: 0 }, performance.now(), 0);
      check(r.target === "original" && !r.vbo, "fallback must be pending before VBO allocation");
      gate.restore();
      const start = report.frames.length;
      f.until(() => r.mode === "original" && !r.phase && h.canRender(), "pending fallback completes");
      check(b.parent?.parent == null, "B stole A's reserved fallback draw");
      const frames = report.frames.slice(start);
      check(frames.every(frame => frame.reservedDraws <= 2), "fallback overreservation");
      f.trace.draws.length = 0; f.g.render();
      const calls = f.trace.draws.filter(d => d.id === a.id).length;
      check(calls === 2, `original fallback must draw twice, got ${calls}`);
      report.fallback = { frames: frames.length, peakReserved: Math.max(...frames.map(x => x.reservedDraws)), calls,
        detachedB: b.parent?.parent == null, actual: f.allocation() };
    } finally { f.dispose(); }
  }
  if (control === "all" || control === "visibility") {
    const f = fixture(report, { cells: [[8, 8, 8, BLOCK.WATER]], control: true });
    try {
      f.settle();
      const h = f.g.sectionWater, [mesh] = h.owner.records.keys(), r = h.owner.records.get(mesh);
      mesh.visible = false; f.g.renderer.render(f.g.scene, f.g.camera);
      const control = f.read(); mesh.visible = true;
      check(new Set(control).size > 4, "opaque control must cover real pixels");
      for (const recovery of [false, true]) for (const exclusion of ["ancestor", "mesh", "material", "layer", "visible-control"]) {
        if (recovery) h.owner.resetGPU();
        else { f.g.materials.water.needsUpdate = true; h.refresh(); }
        if (exclusion === "ancestor") mesh.parent.visible = false;
        if (exclusion === "mesh") mesh.visible = false;
        if (exclusion === "material") mesh.material.visible = false;
        if (exclusion === "layer") mesh.layers.set(2);
        h.frame = { limits: f.g.meshStats.limits, started: performance.now() - 100, steps: 16 };
        f.g.meshStats.lastSliceCopyBytes = f.g.meshStats.limits.maxCopyBytesPerSlice;
        const start = f.trace.operations.length, expected = exclusion !== "visible-control";
        const allowed = f.g.render(), again = f.g.render();
        check(allowed === expected && again === expected, `visibility ${recovery}/${exclusion}`);
        const operations = f.trace.operations.slice(start);
        check(!operations.length, "expired render caused GPU allocation/upload work");
        const differingBytes = expected ? diff(control, f.read()) : null;
        check(!expected || differingBytes === 0, "excluded water changed opaque control pixels");
        if (recovery) check(mesh.geometry.drawRange.count === 0 && r.range.count > 0, "logical recovery control");
        report.visibility.push({ recovery, exclusion, allowed, again, differingBytes, operations: operations.length });
        mesh.parent.visible = mesh.visible = mesh.material.visible = true; mesh.layers.set(0);
        f.settle();
      }
    } finally { f.dispose(); }
  }
  return report;
}
