import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantDetailMask } from "../src/distant-detail-mask.js";
import { NativeTerrainSeams, NATIVE_SEAM_BYTES } from "../src/native-terrain-seams.js";
import { publishedNativeBoundaries } from "../src/native-boundary-profile.js";
import { DistantTerrain } from "../src/distant-terrain.js";

function profile(top) {
  const data = new Float32Array(128 * 3);
  for (let i = 0; i < 128; i++) data.set([top, top - 16, top], i * 3);
  return { data, bits: 9 };
}

test("seam staging yields under a fixed work allowance and publishes both batches atomically", t => {
  t.mock.method(performance, "now", () => 0);
  const mask = new DistantDetailMask(), seams = new NativeTerrainSeams(new THREE.Group(), mask);
  try {
    assert.equal(seams.allocatedBytes, NATIVE_SEAM_BYTES + 3072);
    const first = new Map([["0,0", [profile(32)]]]);
    seams.update(first);
    const before = seams.layers.map(l => l.edge.array.slice(0, 256));
    const next = new Map([["0,0", [profile(48), profile(64), profile(80)]]]);
    let calls = 0, bytes = 0;
    do {
      const work = seams.update(next, { maxUnits: 64, deadline: Infinity });
      assert.ok(work.units <= 64);
      bytes += work.copyBytes;
      if (work.pendingColumns)
        for (let b = 0; b < 2; b++) assert.deepEqual(seams.layers[b].edge.array.slice(0, 256), before[b]);
      assert.ok(++calls < 32);
    } while (seams.queue.size);
    assert.equal(bytes, 3072);
    assert.ok(calls > 1);
    assert.equal(seams.layers[0].edge.array[2], 80);
    assert.equal(seams.layers[1].edge.array[2], 80);
    t.diagnostic(JSON.stringify({ calls, copyBytes: bytes, reservedBackingBytes: seams.allocatedBytes }));
  } finally { seams.dispose(); mask.dispose(); }
});

test("stale staging cannot publish a replaced profile and removed slots are safe to reuse", t => {
  t.mock.method(performance, "now", () => 0);
  const mask = new DistantDetailMask(), seams = new NativeTerrainSeams(new THREE.Group(), mask);
  try {
    seams.update(new Map([["0,0", [profile(32)]]]), { maxUnits: 64 });
    seams.update(new Map([["0,0", [profile(80)]]]));
    assert.equal(seams.layers[0].edge.array[2], 80);
    seams.update(new Map());
    assert.equal(seams.layers[0].edge.array[2], -1e9);
    seams.update(new Map([["1,0", [profile(48)]]]));
    assert.equal(seams.columns.get("1,0").slot, 0);
    assert.equal(seams.layers[0].edge.array[2], 48);
    assert.equal(seams.layers[0].geometry.instanceCount, 64);
  } finally { seams.dispose(); mask.dispose(); }
});

test("empty publication and foliage-only changes preserve the immutable seam snapshot", () => {
  const data = profile(32).data;
  const chunks = new Map([["0,0", { userData: { sections: new Map([
    [1, { group: { userData: { nativeBoundary: data } } }],
    [2, { group: { userData: {} } }],
  ]) } }]]);
  const first = publishedNativeBoundaries(chunks, new Map([["0,0,1", 1]]));
  const next = publishedNativeBoundaries(chunks, new Map([["0,0,1", 7], ["0,0,2", 15]]), first);
  assert.equal(next, first);
  const water = publishedNativeBoundaries(chunks, new Map([["0,0,1", 9]]), next);
  assert.notEqual(water, next);
  assert.deepEqual([...water.changedKeys], ["0,0"]);
});

test("yielded seam replacements count retired native backing without double-counting current owners", t => {
  t.mock.method(performance, "now", () => 0);
  const lod = new DistantTerrain(new THREE.Scene(), {});
  const old = profile(32), fresh = profile(48);
  try {
    lod._seams = new NativeTerrainSeams(lod.group, lod.detailMask);
    lod._nativeBoundaries = new Map([["0,0", [old]]]);
    lod._nativeBoundaryOwners = new Set([old.data.buffer]);
    lod._seams.update(lod._nativeBoundaries);
    assert.equal(lod.resources().cpuBytes, NATIVE_SEAM_BYTES);
    lod._nativeBoundaries = new Map([["0,0", [fresh]]]);
    lod._nativeBoundaryOwners = new Set([fresh.data.buffer]);
    lod._seams.update(lod._nativeBoundaries, { maxUnits: 64 });
    assert.equal(lod.resources().cpuBytes, NATIVE_SEAM_BYTES + old.data.byteLength);
    assert.equal(lod.resources().stagingBytes, 3072);
    lod._seams.update(lod._nativeBoundaries);
    assert.equal(lod.resources().cpuBytes, NATIVE_SEAM_BYTES);
  } finally { lod.dispose(); }
  assert.equal(lod.resources().cpuBytes, 0);
});
