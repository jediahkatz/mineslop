// CPU-only host reproductions. No production method implementation is replaced:
// the optional preparation gate only holds a completed real section transaction.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";
import { SectionWaterMemoryGPU } from "./section-water-fixture.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { planWaterGeometry } from "../src/water-fusion-geometry.js";

const paths = ["src/section-water-fusion.js", "src/section-renderer.js", "src/section-pages.js",
  "src/section-water-resources.js", "src/section-water-visibility.js",
  "src/section-water-attachments.js", "src/section-water-reclaim.js", "src/regional-section-pages.js",
  "src/renderer.js", "src/water-fusion.js", "src/water-fusion-ledger.js",
  "src/water-fusion-gpu.js", "src/water-fusion-geometry.js", "src/water-fusion-material.js",
  "test/renderer-water-pressure-fixture.js", "test/renderer-water-pressure-regression.test.js",
  "test/renderer-water-pressure-contracts.test.js"];
const hashes = () => Object.fromEntries(paths.map(path => [path,
  createHash("sha256").update(readFileSync(new URL(`../${path}`, import.meta.url))).digest("hex")]));

export function pressureLog(t) {
  const before = hashes();
  const log = (event, data = {}) => {
    if (process.env.WATER_PRESSURE_LOG) appendFileSync(process.env.WATER_PRESSURE_LOG,
      JSON.stringify({ test: t.name, event, ...data },
        (_key, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value) + "\n");
  };
  log("start", { sourceHashes: before, gpu: "CPU memory backend; no GL/pixel claim" });
  t.after(() => {
    const after = hashes();
    log("end", { sourceHashes: after, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after) });
    assert.deepEqual(after, before, "Fixture/source revisions changed during reproduction; rerun before attributing failure");
  });
  return log;
}

export function pressureFixture(t, { columns = [[0, 0]], cells = [], limits = {}, cameraX = 8 } = {}) {
  const clock = { now: 0 };
  t.mock.method(performance, "now", () => clock.now);
  const world = authoredColumns(columns, cells), g = shapeRenderer(world), gpu = new SectionWaterMemoryGPU();
  let renders = 0;
  Object.assign(g, { waterFusionEnabled: true, contextResourceOwners: new Set(),
    renderer: { getContext: () => gpu.gl, render() { renders++; } },
    waterFusionBackendFactory: () => gpu,
    meshLimits: { regionalPages: true, maxCopyBytesPerSlice: 2048, ...limits } });
  g.camera.position.set(cameraX, 12, 12); g.camera.lookAt(cameraX, 8, 8);
  const frames = [];
  const tick = (maximum = 2) => {
    const before = gpu.operations.length;
    g.rebuildDirty(maximum);
    const frame = { cells: g.meshStats.lastSliceCells, copyBytes: g.meshStats.lastSliceCopyBytes,
      steps: g.meshStats.lastSliceSteps, memoryGpuBytes: gpu.operations.slice(before).reduce((a, b) => a + b, 0) };
    frames.push(frame);
    assert.ok(frame.copyBytes <= g.meshStats.limits.maxCopyBytesPerSlice, "fixture exceeded shared copy quota");
    assert.ok((frame.steps ?? 0) <= g.meshStats.limits.maxStepsPerSlice, "fixture exceeded shared operation quota");
    return frame;
  };
  const until = (predicate, limit = 160) => {
    for (let i = 0; i < limit && !predicate(); i++) tick();
    return predicate();
  };
  const settle = () => {
    assert.ok(until(() => {
      for (const [key] of world.dirtySectionRevisions) {
        const [x, z] = key.split(",").map(Number);
        if (Math.max(Math.abs(x - Math.floor(g.camera.position.x / 16)),
          Math.abs(z - Math.floor(g.camera.position.z / 16))) <= g.renderRadius) return false;
      }
      return !!g.sectionWater && !g.sectionJobs.size && !g.sectionWater.owner.pending.size;
    }), `Fixture failed initial settling: ${JSON.stringify(pressureState({ g, world }))}`);
  };
  const holdPreparation = () => {
    const host = g.sectionWater, original = host.prepare;
    let held = true, last = null;
    host.prepare = function(job) {
      last = job;
      return held ? false : original.call(this, job);
    };
    const restore = () => { held = false; host.prepare = original; };
    t.after(restore);
    return { get job() { return last; }, restore,
      wait() {
        assert.ok(until(() => last?.status === "ready" && !!last.waterGroup && !!last.pagePlan),
          "No completed real water job reached preparation gate");
        return last;
      },
      forget() { last = null; } };
  };
  const pumpDetached = mesh => {
    for (let i = 0; i < 128 && !g.sectionWater.owner.status(mesh)?.ready; i++) {
      g.meshStats.lastSliceCopyBytes = 0; g.meshStats.waterWork = [];
      g.sectionWater.step(g.meshStats.limits, clock.now, 0);
      assert.ok(g.meshStats.lastSliceCopyBytes <= g.meshStats.limits.maxCopyBytesPerSlice);
    }
    assert.equal(g.sectionWater.owner.status(mesh)?.ready, true, "Detached conversion failed fixture setup");
  };
  const expire = () => {
    g.sectionWater.frame = { started: 0, limits: g.meshStats.limits, steps: g.meshStats.limits.maxStepsPerSlice };
    g.meshStats.lastSliceCopyBytes = g.meshStats.limits.maxCopyBytesPerSlice;
    clock.now = 100;
  };
  t.after(() => { disposeShapeRenderer(g); g.sectionWater?.dispose(); });
  return { g, world, gpu, clock, frames, tick, until, settle, holdPreparation, pumpDetached, expire,
    get renders() { return renders; } };
}

function attached(mesh) {
  for (let p = mesh; p; p = p.parent) if (p.isScene) return true;
  return false;
}

function payloadHash(mesh, host) {
  const r = host?.owner.records.get(mesh);
  const arrays = r?.data ? [r.data, r.indices, r.metadata] :
    [...Object.values(mesh.geometry.attributes).map(a => a.array), mesh.geometry.index?.array];
  const hash = createHash("sha256");
  for (const array of arrays) if (array)
    hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest("hex");
}

export function pressureState(f) {
  const { g, world } = f, host = g.sectionWater;
  // Independently count prospective color submissions from attached geometry.
  let actual = 0, reserved = 0;
  g.scene.traverse(mesh => {
    if (!mesh.isMesh || mesh.userData.sectionSource) return;
    const r = host?.owner.records.get(mesh);
    const range = r?.range ?? mesh.geometry.drawRange;
    const count = r?.indices?.length ?? mesh.geometry.index?.count ?? 0;
    if (Math.min(count, range.start + range.count) - range.start < 3) return;
    actual += mesh.material.transparent && mesh.material.side === THREE.DoubleSide && !mesh.material.forceSinglePass ? 2 : 1;
    reserved += r ? (r.mode === "original" || r.target === "original" ? 2 : 1) :
      mesh.material.transparent && mesh.material.side === THREE.DoubleSide && !mesh.material.forceSinglePass ? 2 : 1;
  });
  return { resources: detailMeshResources(g), ledger: host?.owner.resources(), actualAttachedCalls: actual,
    independentlyReservedCalls: reserved, canRender: host?.canRender(),
    dirty: [...world.dirtySectionRevisions],
    columns: [...g.chunks].map(([key, c]) => ({ key, visible: c.visible })),
    jobs: [...g.sectionJobs ?? []].map(([key, j]) => ({ key, status: j.status, current: j.current(),
      water: j.waterGroup?.children.filter(m => m.userData.batch === "water").map(m => ({
        id: m.id, payloadSha256: payloadHash(m, host),
        owner: host?.owner.status(m), fallback: m.userData.sectionWater?.fallback })) })),
    sources: [...host?.owner.records ?? []].map(([mesh, r]) => ({
      id: mesh.id, key: mesh.userData.sectionWater?.stamp &&
        `${mesh.userData.sectionWater.stamp.cx},${mesh.userData.sectionWater.stamp.cz},${mesh.userData.sectionWater.stamp.sy}`,
      installed: mesh.userData.sectionWater?.installed, attached: attached(mesh),
      payloadSha256: payloadHash(mesh, host),
      ready: host.owner.status(mesh).ready, current: r.current(), mode: r.mode, target: r.target,
      phase: r.phase, error: r.error, index: !!r.indexBuffer, vbo: !!r.vbo,
      physicalRange: mesh.geometry.drawRange, logicalRange: { ...r.range } })) };
}

export function candidateReservation(mesh, copyCap) {
  const p = planWaterGeometry(mesh, copyCap);
  assert.equal(p.unsupported, undefined, `Fixture source cannot fuse: ${p.unsupported}`);
  const inputGpu = [...p.attributes, p.index].reduce((n, a) => n + a.array.byteLength, 0);
  return { inputGpu, ownedGpu: p.textureBytes + p.indexBytes,
    peakGpu: inputGpu + p.textureBytes + p.indexBytes };
}

export function visibleOpaqueControl(t, f) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  mesh.position.set(8, 5, 8); f.g.scene.add(mesh);
  t.after(() => { f.g.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); });
  return mesh;
}
