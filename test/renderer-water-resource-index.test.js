import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { hostReviewFixture, loadHostReviewModules } from "./renderer-water-review-fixture.js";
import { watchWaterHostField } from "../src/section-water-resources.js";

const modules = await loadHostReviewModules();

test("external census separates aliased CPU backing from independently allocated GPU attributes", t => {
  const f = hostReviewFixture(t, modules);
  f.publish(1);
  const backing = new ArrayBuffer(160), geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(backing, 0, 24), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(backing, 32, 24), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(backing, 128, 3), 1));
  const mesh = new THREE.Mesh(geometry, f.g.materials.glass);
  f.column.add(mesh); f.column.userData.transparentMeshes.push(mesh);
  for (const a of [...Object.values(geometry.attributes), geometry.index]) f.gpu.allocateExternal(a.array.byteLength);
  const external = f.owner.externalResources(), own = f.owner.resources();
  assert.equal(external.cpuBytes + own.reservedCpuBytes, f.cpuBackingBytes());
  assert.equal(external.cpuBytes, 160, "one backing, including unused bytes");
  assert.equal(external.gpuBytes, 198, "two independent 96-byte attributes and a 6-byte index");
  assert.equal(external.gpuBytes + own.reservedGpuBytes, f.gpu.bytes());
  assert.equal(modules.detailMeshResources(f.g).gpuBytes, f.gpu.bytes(), "final host admission uses the same physical GPU identities");
});

test("external census observes new attributes and restores shared geometry subscriptions on retirement", t => {
  const f = hostReviewFixture(t, modules);
  f.publish(1);
  const mesh = f.addExternal(), geometry = mesh.geometry;
  const before = f.owner.externalResources();
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(24), 3));
  assert.equal(f.owner.externalResources().gpuBytes, before.gpuBytes + 96);
  assert.equal(f.owner.externalResources().cpuBytes, before.cpuBytes + 96);
  geometry.deleteAttribute("normal");
  assert.deepEqual(f.owner.externalResources(), before);
  const position = geometry.attributes.position;
  f.g.removeChunk("0,0");
  assert.equal(Object.hasOwn(geometry, "setAttribute"), false);
  assert.equal(Object.getOwnPropertyDescriptor(position, "array").get, undefined);
  assert.equal(f.host.accounting.roots.size, 0);
  assert.equal(f.owner.externalResources().gpuBytes, 0);
});

test("host structural transaction refuses callback admission and restores admission after an exception", t => {
  const f = hostReviewFixture(t, modules);
  f.publish(1);
  assert.equal(f.owner.fits(), true);
  assert.throws(() => f.host.accounting.mutation(() => {
    assert.equal(f.owner.fits(), false);
    throw new Error("host-publication-callback");
  }), /host-publication-callback/);
  assert.equal(f.owner.fits(), true);
});

test("replacing an ownership map invalidates admission instead of reusing a cross-mutation snapshot", t => {
  const f = hostReviewFixture(t, modules);
  f.publish(1);
  const chunks = f.g.chunks;
  assert.equal(f.owner.fits(), true);
  try {
    f.g.chunks = new Map(chunks);
    assert.equal(f.owner.fits(), false);
  } finally { f.g.chunks = chunks; }
  assert.equal(f.owner.fits(), true);
});

test("retiring source stays core-owned until backend release even after membership removal", t => {
  const f = hostReviewFixture(t, modules), [mesh] = f.publish(1);
  let observed = false;
  const stop = watchWaterHostField(mesh, "material", () => {
    if (f.owner.contains(mesh)) return;
    observed = true;
    assert.equal(f.owner.externalResources().gpuBytes + f.owner.resources().reservedGpuBytes,
      f.gpu.bytes(), "retirement must not count the borrowed index as a second external VBO");
  });
  try { f.owner.release(mesh); } finally { stop(); }
  assert.equal(observed, true);
  assert.equal(f.host.accounting.sourceRecords.size, 0);
  assert.equal(f.host.accounting.core.size, 0);
});
