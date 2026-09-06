import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { waterFusionBudget } from "../src/water-fusion.js";
import { waterFusionDecoder, waterFusionCovered } from "../src/water-fusion-geometry.js";
import { reviewFixture, ownershipState, assertReviewAccounting, drainWithReviewOracle } from "./water-fusion-review-fixture.js";

// Separate follow-up gates, not claimed by these CPU cases: mirrored visible
// pixel controls; GPU-only allocation/upload debit trace; renderer rebind; and
// live-shadow fallback while a replacement is pending. No native/FPS proof.

test("water fusion review: one-operation work and request do not scan all published records", (t) => {
  const observations = [];
  for (const count of [8, 128]) {
    const f = reviewFixture(t);
    for (let i = 0; i < count; i++) f.publish(f.source());
    const mesh = f.source();
    let visits = 0;
    const values = Map.prototype.values;
    const mock = t.mock.method(f.owner.records, "values", function* () {
      for (const record of values.call(this)) { visits++; yield record; }
    });
    const requested = f.request(mesh), requestVisits = visits;
    visits = 0;
    const record = f.owner.records.get(mesh), before = record.data;
    const budget = waterFusionBudget({ operations: 1, bytes: 1024 });
    f.owner.step(f.renderer, budget);
    const stepVisits = visits;
    mock.mock.restore();
    const resources = f.owner.resources();
    observations.push({
      publishedSources: count, requestVisits, stepVisits, requested,
      beforeAllocated: !!before, afterAllocated: !!record.data,
      work: budget.work, usedBytes: budget.usedBytes, remainingOperations: budget.remainingOperations,
      sources: resources.sources, reservedCpuBytes: resources.reservedCpuBytes,
      reservedGpuBytes: resources.reservedGpuBytes,
    });
    assert.equal(requested.state, "pending");
    assert.equal(before, null);
    assert.ok(record.data, "single allowed operation must actually advance allocation");
    assert.equal(budget.work.length, 1);
    assert.ok(budget.usedBytes <= 1024);
    assert.ok(resources.reservedCpuBytes <= f.owner.limits.maxCpuBytes);
    assert.ok(resources.reservedGpuBytes <= f.owner.limits.maxGpuBytes);
  }
  for (const observation of observations) {
    assert.ok(observation.requestVisits <= 4, `request scans published metadata: ${JSON.stringify(observation)}`);
    assert.ok(observation.stepVisits <= 4, `one-operation step scans published metadata: ${JSON.stringify(observation)}`);
  }
});

for (const behavior of ["release", "throw"])
  test(`water fusion review: initial source disposal can reenter with ${behavior} safely`, (t) => {
    const f = reviewFixture(t), mesh = f.source(), original = mesh.geometry;
    assert.equal(f.request(mesh).state, "pending");
    const record = f.owner.records.get(mesh);
    const sentinel = new Error("review-original-dispose-listener");
    let entered = 0, during, heldDecoder, heldGeometry, exception;
    const listener = () => {
      entered++;
      heldDecoder = waterFusionDecoder(mesh);
      heldGeometry = mesh.geometry;
      during = {
        owned: f.owner.contains(mesh), published: record.published, ready: record.ready,
        phase: record.phase, pending: f.owner.pending.size, decoderInstalled: !!heldDecoder,
      };
      if (behavior === "release") f.owner.release(mesh);
      else throw sentinel;
    };
    original.addEventListener("dispose", listener);
    try { f.pump(); } catch (error) { exception = error; }
    finally { original.removeEventListener("dispose", listener); }
    const after = ownershipState(f, mesh, record);
    const observed = {
      behavior, entered, during, after,
      exception: exception ? { name: exception.name, message: exception.message, isOriginal: exception === sentinel } : null,
      heldDecoderAttributes: Object.keys(heldDecoder?.attributes ?? {}).length,
      heldDecoderIndex: !!heldDecoder?.index,
      heldGeometryAttributes: Object.keys(heldGeometry?.attributes ?? {}).length,
      heldGeometryIndex: !!heldGeometry?.index,
    };
    assert.equal(entered, 1);
    assert.ok(!exception || exception === sentinel, `must not replace listener failure with secondary error: ${JSON.stringify(observed)}`);
    if (behavior === "throw" && after.owned) {
      // Either finish a coherent transaction or retire it. Never leave a
      // half-published owner with pending work removed and no valid draw.
      assert.equal(after.published, true);
      assert.equal(after.ready, true);
      assert.equal(after.publications, 1);
      assert.equal(after.resources.allocatedOwnedGpuBytes, after.backendBytes);
    } else {
      assert.equal(after.owned, false);
      assert.equal(after.userDataRetained, false, JSON.stringify(observed));
      assert.equal(waterFusionDecoder(mesh), null);
      assert.equal(heldDecoder.index, null);
      assert.deepEqual(heldDecoder.attributes, {});
      assert.equal(heldGeometry.index, null);
      assert.deepEqual(heldGeometry.attributes, {});
      assert.equal(after.resources.reservedCpuBytes, 0);
      assert.equal(after.resources.reservedGpuBytes, 0);
      assert.equal(after.backendBytes, 0);
      assert.equal(after.publications, 0, "no phantom successful publication after cancellation");
    }
    assert.equal(after.pending, 0);
  });

test("water fusion review: conventional peer version bumps do not churn a fused shared-material source", (t) => {
  const f = reviewFixture(t), fusedMesh = f.source(), conventionalMesh = f.source();
  f.publish(fusedMesh); f.publish(conventionalMesh);
  // Required positive control: a genuine explicit version-only refresh must
  // still publish a new immutable compiled key.
  const first = fusedMesh.material, firstKey = first.customProgramCacheKey();
  f.material.needsUpdate = true;
  f.owner.refresh(fusedMesh); f.pump();
  assert.notEqual(fusedMesh.material, first);
  assert.notEqual(fusedMesh.material.customProgramCacheKey(), firstKey);
  conventionalMesh.castShadow = true;
  f.owner.refresh(conventionalMesh); f.pump();
  assert.equal(f.owner.records.get(conventionalMesh).mode, "original");
  assert.equal(conventionalMesh.material, f.material);
  assert.equal(f.owner.records.get(fusedMesh).mode, "fused");
  const baseline = { publications: f.owner.stats.publications, key: fusedMesh.material.customProgramCacheKey() };
  const stableMaterial = fusedMesh.material, frames = [];
  for (let frame = 0; frame < 3; frame++) {
    const old = fusedMesh.material, beforeVersion = f.material.version;
    // Exact material mutations in Three WebGLRenderer.renderObject; CPU-only,
    // not a claim that a GPU draw or shader compile happened in this fixture.
    f.material.side = THREE.BackSide; f.material.needsUpdate = true;
    f.material.side = THREE.FrontSide; f.material.needsUpdate = true;
    f.material.side = THREE.DoubleSide;
    f.owner.refresh(fusedMesh);
    const pending = f.owner.pending.size;
    f.pump();
    frames.push({
      frame, beforeVersion, afterVersion: f.material.version, pending,
      cloneChanged: fusedMesh.material !== old,
      programKey: fusedMesh.material.customProgramCacheKey(), publications: f.owner.stats.publications,
    });
  }
  assert.equal(fusedMesh.material, stableMaterial,
    `renderer-owned two-pass bumps must not clone per frame: ${JSON.stringify({ baseline, frames })}`);
  assert.equal(f.owner.stats.publications, baseline.publications, JSON.stringify(frames));
});

test("water fusion review: accepted constant blend color and alpha refresh the fused snapshot", (t) => {
  const f = reviewFixture(t), mesh = f.source();
  Object.assign(f.material, {
    blending: THREE.CustomBlending, blendSrc: THREE.ConstantColorFactor,
    blendDst: THREE.OneMinusConstantColorFactor, blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ConstantAlphaFactor, blendDstAlpha: THREE.OneMinusConstantAlphaFactor,
    blendEquationAlpha: THREE.AddEquation, blendAlpha: 0.25,
  });
  f.material.blendColor.setRGB(0.2, 0.3, 0.4);
  f.publish(mesh);
  const initial = mesh.material, version = f.material.version;
  assert.deepEqual(initial.blendColor.toArray(), f.material.blendColor.toArray());
  assert.equal(initial.blendAlpha, 0.25);
  f.material.blendColor.setRGB(0.7, 0.6, 0.5);
  f.material.blendAlpha = 0.75;
  f.owner.refresh(mesh);
  const pending = f.owner.pending.size;
  f.pump();
  const observed = {
    acceptedMode: f.owner.records.get(mesh).mode, versionBefore: version, versionAfter: f.material.version,
    expectedColor: f.material.blendColor.toArray(), actualColor: mesh.material.blendColor.toArray(),
    expectedAlpha: f.material.blendAlpha, actualAlpha: mesh.material.blendAlpha,
    cloneChanged: mesh.material !== initial, pending,
  };
  assert.equal(f.material.version, version);
  assert.deepEqual(mesh.material.blendColor.toArray(), f.material.blendColor.toArray(), JSON.stringify(observed));
  assert.equal(mesh.material.blendAlpha, f.material.blendAlpha);
});

test("water fusion review: stale decoder lookup fails before step but valid recovery retains CPU access", (t) => {
  const f = reviewFixture(t), mesh = f.source();
  f.publish(mesh);
  const decoder = waterFusionDecoder(mesh), record = f.owner.records.get(mesh);
  const pixels = record.data, indices = record.indices;
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0.2, 0.2, 1), new THREE.Vector3(0, 0, -1));
  assert.ok(ray.intersectObject(mesh).length > 0);
  f.owner.resetGPU();
  assert.equal(waterFusionCovered(mesh), false);
  assert.equal(waterFusionDecoder(mesh), decoder, "valid recovery must retain CPU lookup");
  assert.equal(record.data, pixels); assert.equal(record.indices, indices);
  f.pump();
  assert.equal(waterFusionDecoder(mesh), decoder);
  assert.equal(waterFusionCovered(mesh), true);
  f.context.incarnation++;
  const lookup = waterFusionDecoder(mesh), rayHits = ray.intersectObject(mesh).length;
  const observed = {
    current: record.current(), ready: f.owner.status(mesh).ready, pending: f.owner.pending.size,
    lookupRetained: !!lookup, lookupIsOldDecoder: lookup === decoder,
    indexedVertices: lookup?.index?.count ?? 0, rayHits,
    validRecoveryKeptArrays: record.data === pixels && record.indices === indices,
  };
  assert.equal(rayHits, 0, "raycast already applies the live validator");
  assert.equal(lookup, null, `direct decoder lookup must apply the same validator: ${JSON.stringify(observed)}`);
});

test("water fusion ledger: shared views, phases, attachments, fallback, recovery and cancellation match an independent census", (t) => {
  const external = { cpuBytes: 0, gpuBytes: 0 };
  const f = reviewFixture(t, { drawsWhenAttached: true, externalResources: () => external });
  const first = f.source(), second = f.source();
  for (const [name, a] of Object.entries(first.geometry.attributes))
    second.geometry.setAttribute(name, name === "position"
      ? new THREE.BufferAttribute(new Float32Array(a.array.buffer), a.itemSize) : a);
  const indices = new Uint16Array(new SharedArrayBuffer(6));
  indices.set([0, 1, 2]);
  first.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  second.geometry.setIndex(new THREE.BufferAttribute(indices.subarray(), 1));
  f.request(first); drainWithReviewOracle(f);
  f.request(second); drainWithReviewOracle(f);
  const group = new THREE.Group();
  group.add(first, second);
  assert.equal(assertReviewAccounting(f).reservedDrawCalls, 0);
  f.scene.add(group);
  assert.equal(assertReviewAccounting(f).reservedDrawCalls, 2);
  first.geometry.setDrawRange(0, 0);
  assert.equal(assertReviewAccounting(f).reservedDrawCalls, 1);
  first.geometry.drawRange.count = Infinity;
  assert.equal(assertReviewAccounting(f).reservedDrawCalls, 2);
  const old = f.owner.resources();
  external.gpuBytes = f.owner.limits.maxGpuBytes - old.reservedGpuBytes;
  first.castShadow = true;
  f.owner.refresh(first);
  assert.equal(f.owner.pending.size, 0);
  assert.match(f.owner.status(first).error, /reservation-blocked/);
  assertReviewAccounting(f);
  external.gpuBytes = 0;
  f.owner.refresh(first); drainWithReviewOracle(f);
  assert.equal(f.owner.records.get(first).mode, "original");
  first.castShadow = false;
  f.owner.refresh(first); drainWithReviewOracle(f);
  f.owner.resetGPU();
  assertReviewAccounting(f);
  drainWithReviewOracle(f);
  const pending = f.source();
  f.request(pending);
  f.owner.step(f.renderer, waterFusionBudget({ operations: 1 }));
  assertReviewAccounting(f);
  f.owner.cancel(pending);
  assertReviewAccounting(f);
  f.context.required = false;
  for (let i = 0; i < 5 && f.owner.records.size; i++) f.owner.step(f.renderer);
  assert.equal(assertReviewAccounting(f).sources, 0);
  assert.equal(f.gpu.bytes(), 0);
  assert.equal(f.owner.ledger.cpu.size, 0);
  assert.equal(f.owner.ledger.input.size, 0);
});

for (const action of ["replacement", "context-reset", "world-change"])
  test(`water fusion transaction: original disposal callback ${action} preserves ownership generations`, (t) => {
    const f = reviewFixture(t), mesh = f.source(), original = mesh.geometry;
    const replacement = f.source();
    f.scene.remove(replacement);
    f.request(mesh);
    const old = f.owner.records.get(mesh);
    let calls = 0;
    const listener = () => {
      calls++;
      if (action === "replacement") {
        f.owner.release(mesh);
        mesh.geometry = replacement.geometry;
        assert.equal(f.request(mesh).state, "pending");
      } else if (action === "context-reset") f.owner.resetGPU();
      else f.owner.setContext({});
    };
    original.addEventListener("dispose", listener);
    try { f.pump(); } finally { original.removeEventListener("dispose", listener); }
    assert.equal(calls, 1);
    assertReviewAccounting(f);
    if (action === "world-change") {
      assert.equal(f.owner.records.size, 0);
      assert.equal(waterFusionDecoder(mesh), null);
      assert.equal(f.owner.stats.publications, 0);
    } else {
      assert.equal(f.owner.status(mesh).ready, true);
      assert.equal(f.owner.stats.publications, 1);
      assert.ok(waterFusionDecoder(mesh));
      if (action === "replacement") {
        assert.notEqual(f.owner.records.get(mesh), old);
        assert.equal(old.data, null);
        assert.equal(old.decoder, null);
      }
    }
  });

test("water fusion transaction: disposing an old draw during replacement may release the owner", (t) => {
  const f = reviewFixture(t), mesh = f.source();
  f.publish(mesh);
  const geometry = mesh.geometry, decoder = waterFusionDecoder(mesh);
  let calls = 0;
  const listener = () => { calls++; f.owner.release(mesh); };
  geometry.addEventListener("dispose", listener);
  f.material.needsUpdate = true;
  f.owner.refresh(mesh);
  try { f.pump(); } finally { geometry.removeEventListener("dispose", listener); }
  assert.equal(calls, 1);
  assert.equal(f.owner.stats.publications, 1);
  assert.equal(mesh.userData.waterFusion, undefined);
  assert.equal(decoder.index, null);
  assertReviewAccounting(f);
  assert.equal(f.gpu.bytes(), 0);
});

test("water fusion semantic versions: two explicit updates are not mistaken for a renderer cycle", (t) => {
  const f = reviewFixture(t), mesh = f.source();
  f.publish(mesh);
  const first = mesh.material, key = first.customProgramCacheKey();
  f.material.needsUpdate = true;
  f.material.needsUpdate = true;
  f.owner.refresh(mesh); f.pump();
  assert.notEqual(mesh.material, first);
  assert.notEqual(mesh.material.customProgramCacheKey(), key);
  f.owner.release(mesh);
  assert.equal(Object.getOwnPropertyDescriptor(f.material, "side").get, undefined);
  assert.equal(Object.hasOwn(f.material, "needsUpdate"), false);
});

test("water fusion ledger: callback-time publication overlap reserves every still-live allocation", (t) => {
  const f = reviewFixture(t), mesh = f.source(), observations = [];
  f.owner.request(mesh, { exclusiveGeometry: true, current: () => {
    const r = f.owner.records.get(mesh);
    if (r?.published) observations.push({ mode: r.mode, target: r.target,
      reserved: f.owner.resources().reservedGpuBytes, allocated: f.gpu.bytes() });
    return true;
  } });
  f.pump();
  mesh.castShadow = true;
  f.owner.refresh(mesh); f.pump();
  mesh.castShadow = false;
  f.owner.refresh(mesh); f.pump();
  assert.ok(observations.every(o => o.reserved >= o.allocated), JSON.stringify(observations.filter(o => o.reserved < o.allocated)));
});

test("water fusion transaction: texture retirement context callback also retires the previous material", (t) => {
  const f = reviewFixture(t), mesh = f.source();
  f.publish(mesh);
  const r = f.owner.records.get(mesh), material = r.material, texture = r.texture;
  let disposals = 0;
  material.addEventListener("dispose", () => disposals++);
  const listener = () => {
    texture.removeEventListener("dispose", listener);
    f.owner.resetGPU();
  };
  texture.addEventListener("dispose", listener);
  mesh.castShadow = true;
  f.owner.refresh(mesh); f.pump();
  assert.equal(disposals, 1, JSON.stringify({
    disposals, publications: f.owner.stats.publications, ready: f.owner.status(mesh).ready,
  }));
  assert.equal(f.owner.status(mesh).ready, true);
  assert.equal(f.owner.stats.publications, 2, "interrupted publication is not counted");
  assertReviewAccounting(f);
});

for (const boundary of ["material-key", "external-resources"])
  test(`water fusion transaction: refresh ${boundary} callback cannot resurrect a released record`, (t) => {
    let reenter = false, mesh;
    const f = reviewFixture(t, { externalResources: () => {
      if (reenter && boundary === "external-resources") f.owner.release(mesh);
      return {};
    } });
    mesh = f.source();
    f.material.customProgramCacheKey = () => {
      if (reenter && boundary === "material-key") f.owner.release(mesh);
      return "review-refresh-key";
    };
    f.publish(mesh);
    reenter = true;
    f.material.needsUpdate = true;
    f.owner.refresh(mesh);
    reenter = false;
    assert.equal(f.owner.pending.size, 0, JSON.stringify({
      boundary, pending: f.owner.pending.size, sources: f.owner.records.size,
    }));
    assert.equal(f.owner.records.size, 0);
    assertReviewAccounting(f);
  });

test("water fusion ledger: invalidated attribute replacement releases its original charged byte size", (t) => {
  const f = reviewFixture(t), mesh = f.source();
  f.request(mesh);
  const attribute = mesh.geometry.attributes.position;
  attribute.array = new Float32Array(90);
  attribute.needsUpdate = true;
  f.owner.step(f.renderer);
  const resources = f.owner.resources();
  assert.equal(resources.sources, 0, JSON.stringify(resources));
  assert.equal(resources.reservedGpuBytes, 0, JSON.stringify(resources));
  assert.equal(resources.retainedInputGpuBytes, 0, JSON.stringify(resources));
  assertReviewAccounting(f);
});

test("water fusion ledger: unobservable backing growth keeps the conventional source untouched", (t) => {
  for (const buffer of [
    new ArrayBuffer(36, { maxByteLength: 72 }),
    new SharedArrayBuffer(36, { maxByteLength: 72 }),
  ]) {
    const f = reviewFixture(t), mesh = f.source(), geometry = mesh.geometry;
    mesh.geometry.attributes.position.array = new Float32Array(buffer);
    const result = f.request(mesh);
    assert.equal(result.state, "unsupported", JSON.stringify(result));
    assert.equal(result.reason, "resizable-source-buffer");
    assert.equal(mesh.geometry, geometry);
    assert.equal(f.owner.records.size, 0);
  }
});
