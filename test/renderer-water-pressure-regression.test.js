import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { pressureFixture, pressureLog, pressureState, candidateReservation,
  visibleOpaqueControl } from "./renderer-water-pressure-fixture.js";

test("P1 reclaimable hidden GPU retention must not strand a completed water replacement", t => {
  const log = pressureLog(t);
  const f = pressureFixture(t, { columns: [[-3, 0], [0, 0]], cameraX: -8,
    limits: { maxCopyBytesPerSlice: 32768 },
    cells: [[-40, 8, 8, BLOCK.STONE], [8, 8, 8, BLOCK.WATER]] });
  f.settle();
  f.g.camera.position.x = 8; f.tick(0);
  const hidden = f.g.chunks.get("-3,0"), old = f.g.chunks.get("0,0").userData.sections.get(0).group;
  assert.equal(hidden.visible, false, "Fixture must retain an actual opaque hidden-ring column");
  const hiddenRegion = hidden.userData.sectionRegion;
  assert.ok([...hiddenRegion.userData.sections.keys()].every(key => key.startsWith("-3,0,")),
    "Hidden page must not be shared with a visible receiver");
  const reclaimable = hiddenRegion.userData.pages.reduce((n, mesh) => n + mesh.geometry.index.array.byteLength +
    Object.values(mesh.geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, 0), 0);
  assert.ok(reclaimable > 0);
  const gate = f.holdPreparation();
  f.world.put(8, 8, 8, BLOCK.WATER, 0, 2);
  let job = gate.wait();
  let candidate = job.waterGroup.children.find(m => m.userData.batch === "water");
  const reservation = candidateReservation(candidate, f.g.meshStats.limits.maxCopyBytesPerSlice);
  const resident = pressureState(f).resources.gpuBytes;
  const cap = resident + reservation.peakGpu - Math.max(1, Math.floor(reclaimable / 2));
  assert.ok(cap >= resident, "Fixture must fit existing live payload before conversion");
  assert.ok(resident + reservation.peakGpu > cap);
  assert.ok(resident - reclaimable + reservation.peakGpu <= cap, "Eviction must make conversion affordable");
  f.g.meshLimits.maxGpuBytes = cap;
  // Let the real scheduler replace its old-limit job; do not forge its ticket,
  // admission key or mesher limits.
  gate.forget();
  job = gate.wait();
  candidate = job.waterGroup.children.find(m => m.userData.batch === "water");
  assert.deepEqual(candidateReservation(candidate, f.g.meshStats.limits.maxCopyBytesPerSlice), reservation);
  assert.ok(f.g.meshStats.limits.maxCpuBytes > 10 * pressureState(f).resources.combinedCpuBytes);
  assert.ok(f.g.meshStats.limits.maxStagingBytes > 10 * pressureState(f).resources.stagingBytes);
  const ticket = f.world.dirtySectionRevisions.get("0,0,0");
  const observations = [];
  gate.restore();
  const delegate = f.g.sectionWater.prepare;
  f.g.sectionWater.prepare = function(j) {
    const ready = delegate.call(this, j);
    if (j.stamp.cx === 0 && j.stamp.sy === 0) observations.push({
      ready, status: this.owner.status(j.waterGroup.children.find(m => m.userData.batch === "water")) });
    return ready;
  };
  t.after(() => { f.g.sectionWater.prepare = delegate; });
  log("reclaimable-pressure/setup", { cap, resident, reclaimable, reservation, ticket, state: pressureState(f) });
  for (let i = 0; i < 24; i++) f.tick();
  const automatic = f.g.chunks.get("0,0").userData.sections.get(0).group !== old;
  const stalled = pressureState(f);
  log("reclaimable-pressure/after-24-slices", {
    automatic, sameOldGroup: f.g.chunks.get("0,0").userData.sections.get(0).group === old,
    sameDirtyTicket: f.world.dirtySectionRevisions.get("0,0,0") === ticket,
    observations, state: stalled });
  if (!automatic) {
    assert.ok(observations.some(o => o.status?.state === "blocked"), "Expected reservation blockage, not a harness failure");
    f.g.removeChunk("-3,0");
    const progressed = f.until(() => f.g.chunks.get("0,0").userData.sections.get(0).group !== old &&
      !f.world.dirtySectionRevisions.has("0,0,0"));
    log("reclaimable-pressure/manual-reclaim-positive-control", { progressed, state: pressureState(f) });
    assert.ok(progressed, "Manual reclaim must prove the exact same cap/geometry can finish");
  }
  assert.ok(automatic, "Completed water job must reach bounded reclaim/progress without manual hidden-column eviction");
});

test("P2 attaching B must respect A's pending two-call fallback reservation", t => {
  const log = pressureLog(t), f = pressureFixture(t, {
    cells: [[8, 8, 8, BLOCK.WATER]], limits: { maxDrawCalls: 2 } });
  f.settle();
  const a = [...f.g.sectionWater.owner.records.keys()][0];
  const aRecord = f.g.sectionWater.owner.records.get(a);
  const gate = f.holdPreparation();
  f.world.put(8, 24, 8, BLOCK.WATER);
  const job = gate.wait(), b = job.waterGroup.children.find(m => m.userData.batch === "water");
  gate.restore();
  f.g.sectionWater.prepare(job);
  f.pumpDetached(b);
  assert.equal(b.parent.parent, null, "B must be canonical/ready but detached before its admission");
  assert.equal(pressureState(f).independentlyReservedCalls, 1);
  // A real unsupported per-mesh state selects the conventional fallback.
  // One narrowed slice pays exactly its VBO allocation, leaving its upload
  // pending; no core method or record phase is forged to create the overlap.
  f.g.meshLimits.maxCopyBytesPerSlice = aRecord.plan.vboBytes;
  a.castShadow = true;
  f.g.sectionWater.refresh();
  // Resolve queued host metadata without allocating/uploading any payload.
  f.g.meshStats.lastSliceCopyBytes = 0; f.g.meshStats.waterWork = [];
  f.g.sectionWater.step({ ...f.g.meshStats.limits, maxCopyBytesPerSlice: 0 }, f.clock.now, 0);
  assert.equal(f.g.meshStats.lastSliceCopyBytes, 0);
  assert.equal(aRecord.vbo, undefined);
  assert.equal(aRecord.target, "original");
  const before = pressureState(f);
  assert.equal(before.actualAttachedCalls, 1);
  assert.equal(before.independentlyReservedCalls, 2);
  log("fallback-reservation/setup", { copyCap: aRecord.plan.vboBytes, a: a.id, b: b.id, state: before });
  f.tick();
  const after = pressureState(f);
  const overreserved = after.independentlyReservedCalls > 2;
  log("fallback-reservation/after-admission-slice", { overreserved, state: after });
  const recovery = [];
  for (let i = 0; i < 12; i++) {
    f.tick();
    recovery.push({ frame: i, actual: pressureState(f).actualAttachedCalls,
      reserved: pressureState(f).independentlyReservedCalls, mode: aRecord.mode,
      phase: aRecord.phase, error: aRecord.error, canRender: f.g.sectionWater.canRender() });
  }
  log("fallback-reservation/after-12-unheld-slices", { recovery, state: pressureState(f) });
  assert.ok(!overreserved, "Final host admission must include A's already-reserved fallback draw");
  assert.equal(f.g.sectionWater.canRender(), true, "An unattached/refused B must not permanently strand A's fallback");
});

test("P2 only visible eligible water may block render; visible recovery still blocks with a zero physical range", t => {
  const log = pressureLog(t), outcomes = [];
  for (const recovery of [false, true]) {
    for (const exclusion of ["ancestor", "mesh", "material", "layer", "visible-control"]) {
      const f = pressureFixture(t, { cells: [[8, 8, 8, BLOCK.WATER]] });
      f.settle();
      const mesh = [...f.g.sectionWater.owner.records.keys()][0];
      const r = f.g.sectionWater.owner.records.get(mesh);
      const visible = visibleOpaqueControl(t, f);
      if (recovery) f.g.sectionWater.owner.resetGPU();
      else {
        f.g.materials.water.needsUpdate = true;
        f.g.sectionWater.refresh();
      }
      if (exclusion === "ancestor") mesh.parent.visible = false;
      if (exclusion === "mesh") mesh.visible = false;
      if (exclusion === "material") mesh.material.visible = false;
      if (exclusion === "layer") mesh.layers.set(2);
      f.expire();
      const before = f.renders, allowed = f.g.render(), again = f.g.render();
      const outcome = { recovery, exclusion, allowed, again, expected: exclusion !== "visible-control",
        rendererInvocations: f.renders - before, visibleOpaqueAttached: visible.parent === f.g.scene,
        visibleOpaqueLayer: f.g.camera.layers.test(visible.layers),
        physicalCount: mesh.geometry.drawRange.count, logicalCount: r.range.count,
        bytes: f.g.meshStats.lastSliceCopyBytes, stepLimit: f.g.sectionWater.frame.steps,
        ready: f.g.sectionWater.owner.status(mesh).ready, phase: r.phase, error: r.error };
      outcomes.push(outcome);
      log("render-eligibility/expired-frame", outcome);
      if (recovery) assert.equal(outcome.physicalCount, 0, "Recovery control must exercise the zero GPU range");
      if (exclusion === "visible-control") {
        assert.equal(allowed, false, "Visible unready source MUST block");
        assert.equal(again, false);
      }
    }
  }
  assert.deepEqual(outcomes.map(o => ({ recovery: o.recovery, exclusion: o.exclusion, allowed: o.allowed, again: o.again })),
    outcomes.map(o => ({ recovery: o.recovery, exclusion: o.exclusion, allowed: o.expected, again: o.expected })),
    "Hidden, material-hidden and wrong-layer water must not freeze an otherwise visible scene");
});
