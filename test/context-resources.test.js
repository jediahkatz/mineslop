import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { releaseLostContextResources } from "../src/context-resources.js";
import { Effects } from "../src/effects.js";
import { GameRenderer } from "../src/renderer.js";

test("context loss releases shared GL owners once without deleting CPU or scene state", () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry();
  const pixels = new Uint8Array([23, 89, 144, 255]);
  const map = new THREE.DataTexture(pixels, 1, 1);
  const extra = new THREE.DataArrayTexture(new Uint8Array(4), 2, 2, 1);
  const morph = new THREE.DataTexture(new Float32Array(4), 1, 1);
  const material = new THREE.MeshLambertMaterial({ map });
  const shader = new THREE.ShaderMaterial({
    uniforms: { images: { value: [map, extra] } },
  });
  const instances = new THREE.InstancedMesh(geometry, material, 3);
  instances.morphTexture = morph;
  const light = new THREE.DirectionalLight();
  light.shadow.map = new THREE.WebGLRenderTarget(16, 16);
  scene.add(
    instances,
    new THREE.Mesh(geometry, [material, shader]),
    light
  );
  scene.background = map;
  const resources = [geometry, map, extra, morph, material, shader, light.shadow.map, instances];
  const counts = new Map(resources.map((resource) => [resource, 0]));
  for (const resource of resources)
    resource.addEventListener("dispose", () => counts.set(resource, counts.get(resource) + 1));
  const position = geometry.attributes.position;
  const matrices = instances.instanceMatrix;
  const children = [...scene.children];
  let lost = false;
  const renderer = { getContext: () => ({ isContextLost: () => lost }) };
  releaseLostContextResources(renderer, scene, [extra, undefined]);
  assert.ok([...counts.values()].every((count) => count === 0), "healthy contexts are untouched");
  for (let generation = 1; generation <= 2; generation++) {
    lost = true;
    releaseLostContextResources(renderer, scene, [extra, undefined]);
    assert.ok([...counts.values()].every((count) => count === generation));
    assert.deepEqual(scene.children, children);
    assert.equal(geometry.attributes.position, position);
    assert.equal(instances.instanceMatrix, matrices);
    assert.equal(instances.count, 3);
    assert.equal(instances.morphTexture, morph);
    assert.equal(map.image.data, pixels);
    assert.deepEqual(Array.from(pixels), [23, 89, 144, 255]);
    assert.equal(material.map, map);
    assert.equal(light.shadow.map.width, 16);
  }
});

test("explicit retained owners release off-scene caches once and unregister without changing ownership", () => {
  const scene = new THREE.Scene(), owner = Object.create(Effects.prototype);
  const cached = new THREE.Texture(), bound = new THREE.Texture();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial({ map: bound });
  const particleGeometry = new THREE.BoxGeometry(), particleMaterial = new THREE.MeshBasicMaterial();
  const mesh = new THREE.InstancedMesh(particleGeometry, particleMaterial, 2);
  Object.assign(owner, { mesh, geometry: particleGeometry, material: particleMaterial,
    arrowGeometry: geometry, arrowMaterial: material, atlas: { texture: bound, emissiveTexture: cached },
    itemTextures: new Map([[1, cached], [2, bound]]) });
  scene.add(mesh, new THREE.Mesh(geometry, material));
  const resources = [cached, bound, geometry, material, particleGeometry, particleMaterial, mesh];
  const counts = new Map(resources.map((resource) => [resource, 0]));
  for (const resource of resources)
    resource.addEventListener("dispose", () => counts.set(resource, counts.get(resource) + 1));
  const host = Object.create(GameRenderer.prototype);
  host.contextResourceOwners = new Set();
  const unregister = host.registerContextResourceOwner(owner);
  const renderer = { getContext: () => ({ isContextLost: () => true }) };
  releaseLostContextResources(renderer, scene, [], host.contextResourceOwners);
  assert.ok([...counts.values()].every((count) => count === 1));
  assert.equal(owner.itemTextures.get(1), cached);
  assert.equal(owner.arrowGeometry, geometry);
  assert.equal(owner._disposed, undefined);
  unregister();
  unregister();
  assert.equal(host.contextResourceOwners.size, 0);
  releaseLostContextResources(renderer, scene, [], host.contextResourceOwners);
  assert.equal(counts.get(cached), 1, "An unregistered off-scene owner no longer participates");
});

test("context loss keeps every retained array layer dirty through subsequent partial CPU work", () => {
  const data = Uint8Array.from({ length: 20 }, (_, i) => i);
  const texture = new THREE.DataArrayTexture(data, 2, 2, 5);
  texture.addLayerUpdate(2);
  const version = texture.version;
  releaseLostContextResources({ getContext: () => ({ isContextLost: () => true }) }, new THREE.Scene(), [texture]);
  texture.addLayerUpdate(3);
  assert.deepEqual([...texture.layerUpdates].sort(), [0, 1, 2, 3, 4]);
  assert.equal(texture.version, version + 1);
  assert.equal(texture.image.data, data);
  assert.deepEqual([...data], Array.from({ length: 20 }, (_, i) => i));
});
