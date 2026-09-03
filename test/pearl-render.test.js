import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  MAX_PEARL_RENDER_INSTANCES,
  PearlRenderer,
  PEARL_TRAIL_POINTS,
  PEARL_TRAIL_SECONDS,
} from "../src/pearl-render.js";
import { freezePearlRecord, MAX_PLAYER_PEARLS } from "../src/pearl-save.js";
import { pearlRecord } from "./pearl-fixtures.js";

// Resource/adapter tests, not WebGL shader compilation or natural-play evidence.
test("pearl visuals use two instanced draws and fixed shared resources at capacity", (t) => {
  const scene = new THREE.Scene();
  const view = new PearlRenderer(scene);
  t.after(() => view.dispose());
  const geometry = view.geometry;
  const materials = [view.pearlMaterial, view.trailMaterial];
  assert.equal(scene.children.length, 2);
  assert.equal(view.pearls.geometry, geometry);
  assert.equal(view.trails.geometry, geometry);
  assert.equal(view.pearls.instanceMatrix.count, MAX_PLAYER_PEARLS);
  assert.equal(
    view.trails.instanceMatrix.count,
    MAX_PLAYER_PEARLS * PEARL_TRAIL_POINTS
  );
  for (let frame = 0; frame < 100; frame++) {
    const records = Object.freeze(
      Array.from({ length: MAX_PLAYER_PEARLS }, (_, index) =>
        freezePearlRecord(
          pearlRecord({
            id: index + 1,
            spin: index + 1,
            age: frame * 0.05,
            position: { x: 4 + frame * 0.1, y: 20 + index, z: 4 },
          })
        )
      )
    );
    const before = JSON.stringify(records);
    assert.equal(
      view.update(records, { dimension: "overworld", elapsed: frame * 0.05 }),
      true
    );
    assert.equal(JSON.stringify(records), before);
    assert.equal(view.pearls.count, MAX_PLAYER_PEARLS);
    assert.ok(
      view.pearls.count + view.trails.count <= MAX_PEARL_RENDER_INSTANCES
    );
    assert.ok(view._history.size <= MAX_PLAYER_PEARLS);
    assert.ok(
      [...view._history.values()].every(
        (history) => history.length <= PEARL_TRAIL_POINTS
      )
    );
    assert.equal(view.geometry, geometry);
    assert.deepEqual([view.pearlMaterial, view.trailMaterial], materials);
    assert.equal(scene.children.length, 2);
  }
  assert.ok(view.trails.count > 0);
  const matrix = new THREE.Matrix4();
  view.pearls.getMatrixAt(0, matrix);
  assert.ok(matrix.elements.every(Number.isFinite));
});

test("trails fade while frozen, drop removed records and clear on dimension/reload changes", (t) => {
  const scene = new THREE.Scene();
  const view = new PearlRenderer(scene);
  t.after(() => view.dispose());
  const initial = pearlRecord();
  view.update([initial], { dimension: "overworld" });
  const moved = pearlRecord({ age: 0.05, position: { x: 5, y: 20, z: 4.5 } });
  view.update([moved], { dimension: "overworld" });
  assert.ok(view.trails.count > 0);
  view.update([{ ...moved, age: PEARL_TRAIL_SECONDS + 1 }], {
    dimension: "overworld",
  });
  assert.equal(view.trails.count, 0);
  view.update([initial], { dimension: "overworld" });
  assert.equal(view.trails.count, 0);
  view.update([initial], { dimension: "nether" });
  assert.equal(view.pearls.count, 0);
  assert.equal(view.trails.count, 0);
  assert.equal(view._history.size, 0);
  view.update([], { dimension: "overworld" });
  assert.equal(view.pearls.visible, false);
  assert.equal(view.trails.visible, false);
});

test("disposing shared pearl resources is idempotent and never disposes borrowed item art", () => {
  const scene = new THREE.Scene();
  const texture = new THREE.Texture();
  const view = new PearlRenderer(scene, { texture });
  assert.equal(view.pearlMaterial.uniforms.pearlTexture.value, texture);
  assert.equal(view.pearlMaterial.uniforms.useTexture.value, true);
  const disposed = new Map();
  for (const resource of [
    texture,
    view.geometry,
    view.pearlMaterial,
    view.trailMaterial,
    view.pearls,
    view.trails,
  ])
    resource.addEventListener("dispose", () =>
      disposed.set(resource, (disposed.get(resource) ?? 0) + 1)
    );
  view.update([pearlRecord()], { dimension: "overworld" });
  view.dispose();
  view.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(view._history.size, 0);
  for (const resource of [
    view.geometry,
    view.pearlMaterial,
    view.trailMaterial,
    view.pearls,
    view.trails,
  ])
    assert.equal(disposed.get(resource), 1);
  assert.equal(disposed.get(texture), undefined);
  assert.equal(view.update([], { dimension: "overworld" }), false);
  texture.dispose();
});
