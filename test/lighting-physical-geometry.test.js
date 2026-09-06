import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { createSectionMeshJob } from "../src/section-mesh.js";
import { authoredColumns, shapeRenderer, shapeAtlas, disposeShapeRenderer } from "./shape-fixture.js";
import {
  collectPhysicalLightMeshes, intersectPhysicalLightMeshes, physicalColorComponent,
  physicalHitColor, physicalLightGeometryFingerprint,
} from "./lighting-physical-geometry.js";

function fixture(t) {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([[-1, 0], [-2, 0]], [
    [-1, 0, 0, BLOCK.STONE], [-17, 0, 0, BLOCK.STONE],
  ]);
  const graphics = shapeRenderer(world);
  graphics.renderDistanceOverride = 12;
  graphics.meshLimits = { regionalPages: true };
  graphics.rebuildDirty(Infinity);
  graphics.scene.updateMatrixWorld(true);
  t.after(() => disposeShapeRenderer(graphics));
  return { graphics, world };
}

test("real regional shape ray hits physical negative-coordinate geometry missed by column traversal", (t) => {
  const { graphics, world } = fixture(t);
  const ray = new THREE.Raycaster(new THREE.Vector3(-0.5, 3, 0.5), new THREE.Vector3(0, -1, 0));
  const logical = [];
  for (const column of graphics.chunks.values()) column.traverse((mesh) => { if (mesh.isMesh) logical.push(mesh); });
  assert.equal(ray.intersectObjects(logical, false).length, 0, "old column-only collector misses regional submission");
  const hits = intersectPhysicalLightMeshes(graphics, ray);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0].point.toArray(), [-0.5, 1, 0.5]);
  assert.equal(hits[0].object.parent.position.x, -64, "regional world transform, not column-local origin");
  assert.equal(hits[0].object.userData.sectionPage, true);
  assert.equal(hits[0].object.geometry.attributes.color.itemSize, 1);
  const color = physicalHitColor(hits[0]);
  assert.ok(color.every((value) => Number.isFinite(value) && value > 0));

  const reference = createSectionMeshJob(world, -1, 0, 0, shapeAtlas);
  t.after(() => reference.dispose());
  reference.step({ flush: true });
  const original = reference.result.parts[0].opaque;
  const column = graphics.chunks.get("-1,0");
  const source = column.userData.sections.get(0).group.children.find((mesh) => mesh.userData.batch === "opaque");
  const range = column.userData.sectionRanges.get(source), page = range.mesh.geometry;
  for (let vertex = 0; vertex < original.attributes.color.count; vertex++)
    for (let channel = 0; channel < 3; channel++)
      assert.equal(physicalColorComponent(page, range.vertexStart + vertex, channel),
        original.attributes.color.getComponent(vertex, channel), "exact Float32 color matches independent uncompressed section");
  const meshes = collectPhysicalLightMeshes(graphics);
  assert.equal(meshes.length, 1, "two logical columns share one physical page");
  const fingerprint = physicalLightGeometryFingerprint(graphics);
  assert.equal(fingerprint.meshes.length, 1);
  assert.equal(fingerprint.geometries.length, 1);
  const unique = new Set([...Object.values(page.attributes), page.index].map((attribute) => attribute.array.buffer));
  assert.equal(fingerprint.buffers.length, unique.size);
  t.diagnostic(JSON.stringify({ columnHits: 0, physicalHits: hits.length, point: hits[0].point.toArray(),
    regionalOffset: hits[0].object.parent.position.toArray(), color, physicalMeshes: meshes.length, buffers: unique.size }));
});

test("physical collector rejects hidden, detached, wrong-layer, invisible and non-drawable regional pages", (t) => {
  const { graphics } = fixture(t);
  const page = collectPhysicalLightMeshes(graphics)[0], region = page.parent;
  const absent = () => assert.equal(collectPhysicalLightMeshes(graphics).length, 0);
  page.visible = false; absent(); page.visible = true;
  region.visible = false; absent(); region.visible = true;
  graphics.scene.remove(region); absent(); graphics.scene.add(region);
  page.layers.set(7); absent();
  graphics.camera.layers.set(7);
  assert.equal(collectPhysicalLightMeshes(graphics).length, 1, "camera-matching non-default layers are drawable");
  graphics.camera.layers.set(0); page.layers.set(0);
  page.material.visible = false; absent(); page.material.visible = true;
  page.geometry.setDrawRange(0, 2); absent();
  page.geometry.setDrawRange(page.geometry.index.count, Infinity); absent();
  page.geometry.setDrawRange(0, Infinity);
  const indices = page.geometry.index.array.slice();
  page.geometry.index.array.fill(0); absent(); page.geometry.index.array.set(indices);
  const duplicate = new Map(graphics.sectionRegions);
  graphics.sectionRegions.set("alias", region);
  assert.equal(collectPhysicalLightMeshes(graphics).length, 1);
  graphics.sectionRegions = duplicate;
});

test("physical ranges respect material groups and ordinary RGB/RGBA color attributes", (t) => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial({ visible: false })];
  const mesh = new THREE.Mesh(geometry, materials);
  const group = new THREE.Group(); group.add(mesh); scene.add(group);
  const graphics = { scene, camera, chunks: new Map([["0,0", group]]) };
  t.after(() => { geometry.dispose(); materials.forEach((material) => material.dispose()); });
  geometry.addGroup(0, 3, 1);
  assert.equal(collectPhysicalLightMeshes(graphics).length, 0);
  geometry.clearGroups(); geometry.addGroup(0, 3, 0);
  assert.equal(collectPhysicalLightMeshes(graphics).length, 1);
  for (const size of [3, 4]) {
    const values = new Float32Array(size * 3).map((_, i) => (i + 1) / 32);
    geometry.setAttribute("color", new THREE.BufferAttribute(values, size));
    for (let vertex = 0; vertex < 3; vertex++)
      for (let channel = 0; channel < size; channel++)
        assert.equal(physicalColorComponent(geometry, vertex, channel), values[vertex * size + channel]);
  }
  // Explicit actor roots use the same camera/material/ancestry filters.
  assert.deepEqual(collectPhysicalLightMeshes(graphics, camera, [group, group]), [mesh]);
});

test("physical color interpolation and actor rays honor world/instance transforms and visible material ranges", (t) => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 0, 1, 1,
  ], 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute([
    1, 0, 0, 0, 1, 0, 0, 0, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1,
  ], 3));
  geometry.addGroup(0, 3, 0); geometry.addGroup(3, 3, 1);
  const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial({ visible: false })];
  const mesh = new THREE.InstancedMesh(geometry, materials, 1);
  mesh.position.set(-64, 4, 32);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(16, 2, -16));
  scene.add(mesh);
  t.after(() => { mesh.dispose(); geometry.dispose(); materials.forEach((m) => m.dispose()); });
  const graphics = { scene, camera, chunks: new Map() };
  const ray = new THREE.Raycaster(new THREE.Vector3(-47.7, 6.5, 19), new THREE.Vector3(0, 0, -1));
  const hits = intersectPhysicalLightMeshes(graphics, ray, camera, [mesh]);
  assert.equal(hits.length, 1, "nearer invisible material group must not count as a physical hit");
  assert.equal(hits[0].instanceId, 0);
  assert.deepEqual(hits[0].point.toArray(), [-47.7, 6.5, 16]);
  physicalHitColor(hits[0]).forEach((value, i) =>
    assert.ok(Math.abs(value - [0.2, 0.3, 0.5][i]) < 1e-12));
  mesh.count = 0;
  assert.equal(intersectPhysicalLightMeshes(graphics, ray, camera, [mesh]).length, 0);
});
