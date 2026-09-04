import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createGenerator } from "../src/terrain.js";
import { DistantLandmarks } from "../src/distant-landmarks.js";
import { auditPillarDraws } from "./distant-native-coverage.mjs";
import { acceptanceConfig } from "./distant-native-acceptance-config.mjs";

test("GPU URLs preserve root and /mineslop/ project prefixes with configurable nonzero gates", () => {
  for (const base of ["https://example.test/mineslop", "https://example.test/mineslop/"]) {
    const config = acceptanceConfig({ VOXELCRAFT_TEST_URL: base, LOD_GPU_SETTLE_FRAMES: "6", LOD_GPU_SWEEP_FRAMES: "12" });
    assert.equal(new URL(config.url).pathname, "/mineslop/test/realtime/index.html");
    assert.equal(new URL(config.coverageURL).pathname, "/mineslop/test/distant-native-coverage.mjs");
    assert.equal(config.settleFrames, 6);
    assert.equal(config.sweepFrames, 12);
  }
  assert.equal(new URL(acceptanceConfig({ VOXELCRAFT_TEST_URL: "https://example.test/" }).url).pathname, "/test/realtime/index.html");
  assert.throws(() => acceptanceConfig({ LOD_GPU_SETTLE_FRAMES: "0" }), /Invalid/);
  assert.throws(() => acceptanceConfig({ LOD_GPU_SWEEP_FRAMES: "NaN" }), /Invalid/);
  assert.equal(acceptanceConfig({ LOD_GPU_SEED: "" }).seed, "");
});

function fixture() {
  const generator = createGenerator("cedar-valley", "end", 7);
  const world = { generator, generatorVersion: 7, dimension: "end", seed: "cedar-valley", spec: generator.spec, edits: new Map() };
  const scene = new THREE.Scene(), group = new THREE.Group();
  scene.add(group);
  scene.fog = new THREE.Fog("#222233", 224, 448);
  const lod = new DistantLandmarks(group, world);
  for (let i = 0; i < 1000 && (!lod.group.children.length || lod.job); i++) lod.update({ budgetMs: 2 });
  assert.equal(lod.job, null);
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 768);
  camera.position.set(0, 165, 260);
  camera.lookAt(0, 85, 0);
  const graphics = { world, scene, camera, chunks: new Map(), distant: { group } };
  return { lod, graphics };
}

function drawParts(mesh, predicate) {
  const source = mesh.userData.landmarkSource;
  let count = 0;
  for (const part of source.parts) if (predicate(part)) {
    mesh.geometry.index.array.set(source.indices.subarray(part.start, part.start + part.count), count);
    count += part.count;
  }
  mesh.geometry.setDrawRange(0, count);
}

test("native ray oracle catches seven missing pillars despite unchanged source counts", () => {
  const { lod, graphics } = fixture();
  try {
    const complete = auditPillarDraws(graphics);
    assert.equal(complete.expectedPillars, 10);
    assert.deepEqual(complete.errors, []);
    for (const mesh of lod.group.children) drawParts(mesh, (part) => part.pillar < 3);
    assert.equal(lod.group.userData.renderablePillars, 10, "metadata deliberately lies");
    const missing = auditPillarDraws(graphics);
    assert.deepEqual(missing.pillars.filter((p) => p.missing).map((p) => p.id), [3, 4, 5, 6, 7, 8, 9]);
  } finally { lod.dispose(); }
});

test("real triangle intersections verify partial section union and detect duplicates/hidden detail", () => {
  const { lod, graphics } = fixture();
  const detail = new THREE.Group();
  graphics.scene.add(detail);
  graphics.chunks.set("partial", detail);
  const sourceMesh = lod.group.children[0];
  const part = sourceMesh.userData.landmarkSource.parts.find((p) => p.pillar === 0 && p.high > 96);
  const detailMesh = new THREE.Mesh(sourceMesh.geometry.clone(), sourceMesh.material);
  detailMesh.userData.landmarkSource = sourceMesh.userData.landmarkSource;
  drawParts(detailMesh, (p) => p.section === part.section);
  detail.add(detailMesh);
  try {
    const duplicate = auditPillarDraws(graphics);
    assert.ok(duplicate.pillars.some((p) => p.duplicate > 0));
    lod.update({ detailSections: new Set([part.section]), budgetMs: 0 });
    const union = auditPillarDraws(graphics);
    assert.deepEqual(union.errors, []);
    assert.ok(union.mixedOwnershipPillars.includes(0));
    detail.visible = false;
    assert.ok(auditPillarDraws(graphics).pillars.find((p) => p.id === 0).missing > 0);
  } finally { lod.dispose(); detailMesh.geometry.dispose(); }
});

test("fogged-out geometry cannot satisfy native readability", () => {
  const { lod, graphics } = fixture();
  try {
    graphics.scene.fog.near = 20;
    graphics.scene.fog.far = 160;
    const audit = auditPillarDraws(graphics);
    assert.equal(audit.expectedPillars, 10);
    assert.ok(audit.pillars.every((p) => p.missing === 0));
    assert.ok(audit.pillars.some((p) => p.fogHidden > 0));
    assert.ok(audit.errors.some((e) => e.includes("fog transmission")));
  } finally { lod.dispose(); }
});
