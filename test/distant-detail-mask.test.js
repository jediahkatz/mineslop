import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { releaseLostContextResources } from "../src/context-resources.js";
import { DistantDetailMask, distantDetailBatches } from "../src/distant-detail-mask.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { regionalRegressionFixture } from "./regional-regression-fixture.js";

test("detail volume has independent batches and inward ownership on every section boundary", () => {
  const mask = new DistantDetailMask();
  const spec = { minY: -64, maxY: 320 };
  const center = new THREE.Vector3();
  mask.update(center, spec, new Map([["0,0,0", 3], ["-1,0,0", 8], ["0,0,-1", 4]]));
  assert.equal(mask.resources().cpuBytes, 25 * 25 * 24 * 4);
  assert.equal(mask.resources().gpuBytes, 25 * 25 * 24 * 4);
  for (const axis of ["x", "y", "z"]) for (const side of [-1, 1]) {
    const p = new THREE.Vector3(8, 8, 8), n = new THREE.Vector3();
    p[axis] = side > 0 ? 16 : 0; n[axis] = side;
    assert.equal(mask.owns(p, n, 0), true, `${axis} ${side}: inward side`);
    assert.equal(mask.owns(p, n, 1), true);
    assert.equal(mask.owns(p, n, 3), false);
    n.multiplyScalar(-1);
    assert.equal(mask.owns(p, n, 0), false, `${axis} ${side}: missing neighbor`);
  }
  assert.equal(mask.owns(new THREE.Vector3(-1, 8, 8), new THREE.Vector3(0, 1, 0), 3), true);
  assert.equal(mask.owns(new THREE.Vector3(8, -1, 8), new THREE.Vector3(0, 1, 0), 2), true);
  mask.dispose();
});

test("mask changes atomically on eviction, camera movement, bounds and context recovery", () => {
  const mask = new DistantDetailMask(), center = new THREE.Vector3(), n = new THREE.Vector3(0, 1, 0);
  const spec = { minY: 0, maxY: 96 }, sections = new Map([["0,0,0", 15]]);
  const scene = new THREE.Scene(), first = new THREE.MeshLambertMaterial();
  const second = new THREE.MeshLambertMaterial();
  mask.install(first);
  mask.install(second, 3);
  mask.update(center, spec, sections);
  const texture = mask.texture.value, pixels = mask.data, version = mask.version;
  mask.update(center, spec, new Map(sections));
  assert.equal(mask.version, version, "identical ownership does not upload");
  assert.equal(first.distantDetailMaskTexture, texture);
  assert.equal(second.distantDetailMaskTexture, texture);
  scene.add(new THREE.Mesh(new THREE.BufferGeometry(), first), new THREE.Mesh(new THREE.BufferGeometry(), second));
  let releases = 0;
  texture.addEventListener("dispose", () => releases++);
  releaseLostContextResources({ getContext: () => ({ isContextLost: () => true }) }, scene);
  assert.equal(releases, 1, "shared context allocation releases exactly once");
  mask.update(center, spec, sections);
  assert.equal(mask.data, pixels, "context loss retains authoritative CPU image");
  assert.equal(mask.owns(new THREE.Vector3(8, 16, 8), n), true);
  mask.update(new THREE.Vector3(16, 0, 0), spec, sections);
  assert.equal(mask.owns(new THREE.Vector3(8, 16, 8), n), true, "origin shifts atomically");
  mask.update(center, spec, new Map());
  assert.equal(mask.owns(new THREE.Vector3(8, 16, 8), n), false, "eviction restores fallback");
  mask.update(center, { minY: -64, maxY: 320 }, new Map([["0,0,-1", 15]]));
  assert.notEqual(mask.texture.value, texture);
  assert.equal(mask.owns(new THREE.Vector3(8, 0, 8), n), true);
  mask.dispose();
  assert.equal(mask.resources().cpuBytes, 0);
  assert.equal(mask.resources().gpuBytes, 0);
  first.dispose();
  second.dispose();
});

test("real regional partial publication supplies per-batch ownership, not column completion", (t) => {
  const { renderer, world } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [2, 0, 1, BLOCK.SPRUCE_LEAVES], [3, 0, 1, BLOCK.WATER],
  ], [[0, 0]]);
  let partial = false;
  for (let i = 0; i < 300; i++) {
    renderer.rebuildDirty(1);
    const map = distantDetailBatches(renderer.chunks, renderer.camera);
    const column = renderer.chunks.get("0,0");
    if (column?.userData.sections.has(0) && !column.userData.meshed) {
      assert.equal(map.get("0,0,0"), 15);
      assert.equal(renderer.detailCoverage().has("0,0"), false);
      partial = true;
      break;
    }
  }
  assert.equal(partial, true, "exercise actual bounded publication, not synthetic coverage");
  renderer.rebuildDirty(Infinity);
  const cachedBatches = renderer.detailBatchCoverage();
  assert.equal(renderer.detailBatchCoverage(), cachedBatches,
    "unchanged frames reuse the section-level coverage census");
  renderer.meshResourceRevision++;
  assert.notEqual(renderer.detailBatchCoverage(), cachedBatches,
    "physical publication revisions invalidate the coverage census");
  const column = renderer.chunks.get("0,0"), section = column.userData.sections.get(0);
  const mask = new DistantDetailMask();
  mask.update(renderer.camera.position, { minY: 0, maxY: 96 }, new Map([["0,0,0", 15]]));
  const before = detailMeshResources(renderer), distant = renderer.distant;
  renderer.distant = { detailMask: mask };
  const accounted = detailMeshResources(renderer);
  renderer.distant = distant;
  assert.equal(accounted.gpuBytes, before.gpuBytes + mask.resources().gpuBytes);
  assert.equal(accounted.canonicalBytes, before.canonicalBytes + mask.resources().cpuBytes);
  assert.equal(accounted.combinedCpuBytes, before.combinedCpuBytes + mask.resources().cpuBytes);
  mask.dispose();
  const source = section.group.children.find(s => s.userData.batch === "foliage");
  const range = column.userData.sectionRanges.get(source), page = range.mesh;
  const read = () => distantDetailBatches(renderer.chunks, renderer.camera).get("0,0,0");
  assert.equal(read(), 15);
  page.layers.mask = 0;
  assert.equal(read(), 13, "hidden foliage does not withdraw terrain or water authority");
  page.layers.mask = 1;
  page.visible = false;
  assert.equal(read(), 13);
  page.visible = true;
  const owner = page.parent;
  owner.remove(page);
  assert.equal(read(), 13, "unloaded physical page cannot hide fallback");
  owner.add(page);
  column.userData.sectionRanges.set(source, { ...range, mesh: source });
  assert.equal(read(), 13, "stale logical source cannot impersonate a submitted page");
  column.userData.sectionRanges.set(source, range);
  section.group.visible = false;
  assert.equal(read(), undefined);
  section.group.visible = true;
  assert.equal(read(), 15);
  assert.equal(distantDetailBatches(renderer.chunks, renderer.camera).get("0,0,1"), 15,
    "completed empty section owns intentional absence");
  world.put(2, 0, 1, BLOCK.AIR);
  assert.equal(read(), 15, "old published ownership survives a pending edit replacement");
  renderer.rebuildDirty(Infinity);
  assert.equal(read(), 15, "published empty foliage batch suppresses resurrected proxy");
  renderer.removeChunk("0,0");
  assert.equal(read(), undefined);
});

test("ownership shader chains existing hooks and distinguishes foliage from terrain/water", () => {
  const mask = new DistantDetailMask(), material = new THREE.MeshLambertMaterial();
  material.onBeforeCompile = shader => { shader.uniforms.existing = { value: 1 }; };
  mask.install(material, 3);
  const shader = {
    uniforms: {}, vertexShader: "#include <begin_vertex>",
    fragmentShader: "#include <clipping_planes_fragment>",
  };
  material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.existing.value, 1);
  assert.equal(shader.uniforms.uLodDetailMask, mask.texture);
  assert.equal(material.defaultAttributeValues.lodDetailBatch[0], 3);
  assert.match(shader.fragmentShader, /if \(owned > 0.5\) discard/);
  material.dispose();
  mask.dispose();
});
