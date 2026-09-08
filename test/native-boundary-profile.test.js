import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { NativeBoundaryProfile } from "../src/native-boundary-profile.js";

function box(x, z) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(x, 8.5, z);
  geometry.computeBoundingSphere();
  return geometry;
}

test("single interior batches need no boundary scan or extra scheduler slice", () => {
  const opaque = box(8.5, 8.5), water = box(10.5, 8.5);
  try {
    opaque.index.getX = water.index.getX = () => assert.fail("interior index scan");
    const profile = new NativeBoundaryProfile([{ opaque, water }]);
    assert.equal(profile.done, true);
    assert.equal(profile.step(0, -Infinity), 0);
    assert.equal(profile.data.some(Number.isFinite), false);
  } finally { opaque.dispose(); water.dispose(); }
});

test("boundary-touching and uncertain parts retain metered triangle work", () => {
  for (const kind of ["boundary", "missing-sphere", "transformed", "multipart"]) {
    const opaque = box(kind === "boundary" ? 15.5 : 8.5, 8.5);
    if (kind === "missing-sphere") opaque.boundingSphere = null;
    const parts = [{ opaque }];
    if (kind === "transformed") parts[0].transform = new THREE.Matrix4().makeTranslation(7, 0, 0);
    if (kind === "multipart") parts.push({});
    try {
      const profile = new NativeBoundaryProfile(parts);
      assert.equal(profile.done, false, kind);
      assert.equal(profile.step(0, Infinity), 0);
      assert.equal(profile.index, 0);
      assert.equal(profile.step(1, -Infinity), 0);
      assert.equal(profile.step(1, Infinity), 1);
      assert.equal(profile.index, 3);
      while (!profile.done) assert.ok(profile.step(1, Infinity) <= 1);
      if (kind === "boundary" || kind === "transformed")
        assert.ok(profile.data.some(Number.isFinite), kind);
    } finally { opaque.dispose(); }
  }
});
