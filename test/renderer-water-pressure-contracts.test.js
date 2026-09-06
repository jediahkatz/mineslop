import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { waterFusionBudget } from "../src/water-fusion.js";
import { waterSectionVisible } from "../src/section-water-fusion.js";
import { pressureFixture } from "./renderer-water-pressure-fixture.js";
import { hostReviewFixture, loadHostReviewModules } from "./renderer-water-review-fixture.js";

const modules = await loadHostReviewModules();

function detachedB(f, y = 24) {
  const gate = f.holdPreparation();
  f.world.put(8, y, 8, BLOCK.WATER, 0, 2);
  const job = gate.wait();
  gate.restore();
  f.g.sectionWater.prepare(job);
  const mesh = job.waterGroup.children.find(m => m.userData.batch === "water");
  f.pumpDetached(mesh);
  return { job, mesh };
}

test("visibility generations and camera changes require no render-time population visits", t => {
  const f = hostReviewFixture(t, modules), meshes = f.publish(128);
  const group = meshes[0].parent;
  f.instrument();
  f.g.materials.water.needsUpdate = true; f.host.refresh();
  group.visible = false;
  f.host.frame = { limits: f.limits, started: 0, steps: f.limits.maxStepsPerSlice };
  f.g.meshStats.lastSliceCopyBytes = f.limits.maxCopyBytesPerSlice;
  f.resetVisits();
  for (let i = 0; i < 20; i++) assert.equal(f.g.render(), true);
  assert.equal(f.host.refreshPending, true);
  assert.deepEqual(f.visits, { censusCalls: 0, regionalMeshVisits: 0, ownedMeshVisits: 0, refreshEntryVisits: 0 });
  group.visible = true;
  assert.equal(f.g.render(), false, "becoming visible restores the generation barrier synchronously");
  f.g.camera.layers.set(2);
  assert.equal(f.g.render(), true);
  f.g.camera.layers.enable(0);
  assert.equal(f.g.render(), false);
  assert.equal(f.g.meshStats.lastSliceCopyBytes, f.limits.maxCopyBytesPerSlice);
});

test("logical range, exact scene, mesh layers and ancestor visibility gate recovery independently", t => {
  const f = hostReviewFixture(t, modules), [mesh] = f.publish(1), r = f.owner.records.get(mesh);
  f.owner.resetGPU();
  assert.equal(mesh.geometry.drawRange.count, 0);
  assert.equal(r.range.count, Infinity);
  assert.equal(f.host.canRender(), false);
  mesh.parent.layers.set(2);
  assert.equal(f.host.canRender(), false, "ancestor layers do not gate child meshes");
  mesh.layers.set(2);
  assert.equal(f.host.canRender(), true);
  f.g.camera.layers.enable(2);
  assert.equal(f.host.canRender(), false);
  mesh.material.visible = false;
  assert.equal(f.host.canRender(), true);
  mesh.material.visible = true;
  assert.equal(f.host.canRender(), false);
  r.range.count = 0;
  assert.equal(f.host.canRender(), true);
  r.range.count = Infinity;
  assert.equal(f.host.canRender(), false);
  const other = new THREE.Scene(); other.add(f.column);
  assert.equal(f.host.canRender(), true, "attachment to a different scene is not eligibility");
  f.g.scene.add(f.column);
  assert.equal(f.host.canRender(), false);
  f.drain();
  assert.equal(f.host.canRender(), true);
});

test("dirty coverage does not invalidate an intentionally retained renderable snapshot", t => {
  const f = hostReviewFixture(t, modules), [mesh] = f.publish(1);
  f.world.put(8, 8, 8, BLOCK.WATER, 0, 2);
  assert.equal(waterSectionVisible(mesh), false);
  assert.equal(f.host.canRender(), true);
  mesh.parent.visible = false;
  mesh.parent.visible = true;
  assert.equal(f.host.canRender(), true, "eligibility recomputation must not use coverage currentness");
});

test("ledger changes invalidate held attachment capacity before a pending fallback consumes it", t => {
  const f = pressureFixture(t, { cells: [[8, 8, 8, BLOCK.WATER]], limits: { maxDrawCalls: 2 } });
  f.settle();
  const h = f.g.sectionWater, [a] = h.owner.records.keys(), r = h.owner.records.get(a);
  const { job, mesh: b } = detachedB(f);
  assert.equal(h.attachments.reserve(job), true);
  assert.equal(h.attachments.reserved, 1);
  assert.equal(h.accounting.external().drawCalls, 1);
  assert.equal(h.attachments.valid(job), true);
  a.castShadow = true;
  assert.equal(h.attachments.valid(job), false);
  assert.equal(h.attachments.reserved, 0);
  f.g.meshStats.lastSliceCopyBytes = 0;
  h.step({ ...f.g.meshStats.limits, maxCopyBytesPerSlice: 0 }, f.clock.now, 0);
  assert.equal(r.target, "original");
  assert.equal(h.owner.ledger.drawsFor(r), 2);
  assert.equal(h.owner.ledger.drawsFor(h.owner.records.get(b), true), 1);
  assert.equal(h.owner.resources().reservedDrawCalls, 2);
  assert.equal(h.attachments.reserve(job), false);
  assert.equal(b.parent.parent, null);
});

test("attachment reservations expire on deadline, cancellation, cap changes and live external draw changes", t => {
  const f = pressureFixture(t, { cells: [[8, 8, 8, BLOCK.WATER]], limits: { maxDrawCalls: 4 } });
  f.settle();
  const h = f.g.sectionWater, { job } = detachedB(f);
  assert.equal(h.attachments.reserve(job), true);
  let entered = false;
  assert.equal(h.attachments.commit(job, () => { entered = true; return true; }, f.clock.now), false);
  assert.equal(entered, false);
  const external = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true }));
  t.after(() => { external.removeFromParent(); external.geometry.dispose(); external.material.dispose(); });
  f.g.chunks.get("0,0").add(external);
  assert.equal(h.attachments.valid(job), false);
  assert.equal(h.attachments.reserve(job), true);
  const previousMaterial = external.material;
  external.material = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide });
  previousMaterial.dispose();
  assert.equal(h.attachments.valid(job), false);
  assert.equal(h.accounting.externalDraws, 2);
  h.configure({ ...f.g.meshStats.limits, maxDrawCalls: 3 });
  assert.equal(h.attachments.reserve(job), false);
  external.removeFromParent();
  assert.equal(h.attachments.reserve(job), true);
  const originalJobs = f.g.sectionJobs;
  f.g.sectionJobs = new Map(originalJobs);
  assert.equal(h.attachments.valid(job), false, "replacement ownership maps invalidate host reservations too");
  assert.equal(h.attachments.reserve(job), false);
  f.g.sectionJobs = originalJobs;
  assert.equal(h.attachments.reserve(job), true);
  f.g.sectionJobs.delete("0,0,1");
  assert.equal(h.attachments.reserved, 0);
  assert.equal(h.attachments.valid(job), false);
  job.dispose();
});

test("atomic attachment never exposes old-plus-new draws and retains rollback payload until commit", t => {
  const f = pressureFixture(t, { cells: [[8, 8, 8, BLOCK.WATER]], limits: { maxDrawCalls: 1 } });
  f.settle();
  const h = f.g.sectionWater, [a] = h.owner.records.keys(), old = h.owner.records.get(a);
  const { job, mesh: b } = detachedB(f, 8);
  const bytes = h.owner.resources().allocatedOwnedGpuBytes, observations = [];
  job.waterGroup.addEventListener("added", () => {
    observations.push({
      reserved: h.owner.resources().reservedDrawCalls + h.accounting.externalDraws,
      render: f.g.render(), oldStorage: old.textureAllocated,
      bytes: h.owner.resources().allocatedOwnedGpuBytes,
      coreInstalled: h.owner.records.get(b).installed, attached: h.owner.records.get(b).attached,
      hostInstalled: h.entries.get(b).installed,
    });
  });
  assert.ok(f.until(() => f.g.chunks.get("0,0").userData.sections.get(0).group === job.waterGroup));
  assert.deepEqual(observations, [{ reserved: 1, render: false, oldStorage: true, bytes,
    coreInstalled: true, attached: true, hostInstalled: false }]);
  assert.equal(h.owner.contains(a), false);
  assert.equal(f.world.dirtySectionRevisions.has("0,0,0"), false);
});

test("failed attachment restores old geometry and dirty ticket without committing its reservation", t => {
  const f = pressureFixture(t, { cells: [[8, 8, 8, BLOCK.WATER]], limits: { maxDrawCalls: 1 } });
  f.settle();
  const h = f.g.sectionWater, [a] = h.owner.records.keys(), old = h.owner.records.get(a);
  const oldGroup = a.parent, { job } = detachedB(f, 8);
  const ticket = f.world.dirtySectionRevisions.get("0,0,0");
  const fail = () => { throw new Error("injected-attachment-failure"); };
  job.waterGroup.addEventListener("added", fail);
  assert.throws(() => f.tick(), /injected-attachment-failure/);
  job.waterGroup.removeEventListener("added", fail);
  assert.equal(f.g.chunks.get("0,0").userData.sections.get(0).group, oldGroup);
  assert.equal(oldGroup.parent, f.g.chunks.get("0,0"));
  assert.equal(old.textureAllocated, true);
  assert.equal(f.world.dirtySectionRevisions.get("0,0,0"), ticket);
  assert.equal(h.owner.resources().reservedDrawCalls, 1);
  assert.equal(h.attachments.reserved, 0);
  assert.equal(h.canRender(), true);
  assert.ok(f.until(() => !f.world.dirtySectionRevisions.has("0,0,0")));
});

test("one-operation reclaim retains shared page bytes, invalidates plans and protects the replacement snapshot", t => {
  const f = pressureFixture(t, { columns: [[0, 0], [3, 0]], cameraX: 24,
    limits: { maxCopyBytesPerSlice: 32768 },
    cells: [[8, 8, 8, BLOCK.WATER], [8, 8, 9, BLOCK.STONE],
      [56, 8, 8, BLOCK.STONE], [56, 80, 8, BLOCK.STONE]] });
  f.settle(); f.g.camera.position.x = 8; f.tick(0);
  const hidden = f.g.chunks.get("3,0"), region = hidden.userData.sectionRegion;
  const shared = region.userData.pageDescriptors.find(p => p.sources.length === 2);
  const exclusive = region.userData.pageDescriptors.find(p => p.sources.length === 1);
  assert.ok(shared && exclusive);
  const sharedIndex = shared.mesh.geometry.index, sharedAttributes = shared.mesh.geometry.attributes;
  const old = f.g.chunks.get("0,0").userData.sections.get(0).group;
  const gate = f.holdPreparation();
  f.world.put(8, 8, 8, BLOCK.WATER, 0, 2);
  const job = gate.wait(), plan = job.pagePlan, ticket = f.world.dirtySectionRevisions.get("0,0,0");
  const h = f.g.sectionWater;
  h.reclaim.capacity(job, 0, Math.floor(exclusive.bytes / 2), 0);
  const work = [];
  for (let i = 0; i < 512 && (h.reclaim.active || !h.reclaim.fits()); i++) {
    const b = waterFusionBudget({ bytes: 0, operations: 1, milliseconds: 8 });
    h.reclaim.step(b); work.push(...b.work);
    assert.ok(b.work.length <= 1);
    assert.equal(b.usedBytes, 0);
    assert.equal(f.g.chunks.get("0,0").userData.sections.get(0).group, old);
    assert.equal(f.world.dirtySectionRevisions.get("0,0,0"), ticket);
  }
  assert.equal(h.reclaim.active, null);
  assert.equal(f.g.chunks.has("3,0"), false);
  assert.equal(plan.disposed, true);
  assert.equal(job.pagePlan, null, "shared-region mutation requires a fresh page plan");
  assert.equal(job.current(), true);
  assert.equal(shared.mesh.geometry.index, sharedIndex);
  assert.equal(shared.mesh.geometry.attributes, sharedAttributes);
  assert.ok(shared.retainedDeadBytes > 0);
  assert.equal(shared.sources.length, 1);
  assert.ok(h.accounting.gpu.refs.has(sharedIndex), "shared allocation remains fully owned");
  assert.equal(exclusive.mesh.geometry.index, null);
  assert.ok(work.some(w => w.kind === "reclaim-payload-release"));
  assert.ok(work.some(w => w.kind === "reclaim-page-payload-release"));
  gate.restore();
  assert.ok(f.until(() => !f.world.dirtySectionRevisions.has("0,0,0")));
});

test("unload during yielded retirement releases parked water and invalidates the retirement cursor", t => {
  const f = pressureFixture(t, { columns: [[0, 0], [3, 0]], cameraX: 24,
    limits: { maxCopyBytesPerSlice: 32768 },
    cells: [[8, 8, 8, BLOCK.WATER], [56, 8, 8, BLOCK.WATER],
      [8, 8, 9, BLOCK.STONE], [56, 8, 9, BLOCK.STONE]] });
  f.settle(); f.g.camera.position.x = 8; f.tick(0);
  const h = f.g.sectionWater, hidden = f.g.chunks.get("3,0"), region = hidden.userData.sectionRegion;
  const hiddenMesh = [...h.owner.records.keys()].find(m => m.userData.sectionWater.stamp.cx === 3);
  const gate = f.holdPreparation();
  f.world.put(8, 8, 8, BLOCK.WATER, 0, 2);
  const job = gate.wait();
  h.reclaim.capacity(job, 0, 1, 0);
  for (let i = 0; i < 256 && !hidden.userData.waterRetiringGroups?.size; i++)
    h.reclaim.step(waterFusionBudget({ bytes: 0, operations: 1, milliseconds: 8 }));
  assert.equal(hidden.userData.waterRetiringGroups.size, 1);
  assert.equal(h.owner.contains(hiddenMesh), true);
  f.g.removeChunk("3,0");
  h.reclaim.step(waterFusionBudget({ bytes: 0, operations: 1, milliseconds: 8 }));
  assert.equal(h.reclaim.active, null);
  assert.equal(region.userData.waterRetirement, undefined);
  assert.equal(h.owner.contains(hiddenMesh), false);
  assert.ok([...h.entries.values()].every(e => e.stamp.cx !== 3));
  assert.ok(region.userData.pageDescriptors.every(p => p.sources.every(m => !m.userData.waterRetired)));
  assert.equal(job.current(), true);
});
