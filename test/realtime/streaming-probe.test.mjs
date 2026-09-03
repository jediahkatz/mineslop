import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { probeGroundColumn, sampleGroundCoverage } from "./ground-coverage.js";

// Tests of diagnostic fidelity only; these do not claim browser/runtime proof.
function fixture() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#ffffff", 10, 45);
  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 512);
  camera.position.set(8, 152, 8);
  camera.lookAt(8, 32, -24);
  camera.updateMatrixWorld(true);
  const geometry = new THREE.PlaneGeometry(16, 16);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(8, 32, 8);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  const detail = new THREE.Group();
  detail.add(mesh);
  const distant = new THREE.Group();
  const distantGround = new THREE.Group();
  distant.add(distantGround);
  scene.add(detail, distant);
  scene.updateMatrixWorld(true);
  return {
    graphics: {
      scene,
      camera,
      chunks: new Map([["0,0", detail]]),
      renderRadius: 2,
      distant: { group: distant, _active: { group: distantGround } },
    },
    detail,
    distant,
    distantGround,
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

test("ground probes intersect rendered triangles, not a ready or loaded flag", () => {
  const sample = fixture();
  try {
    const visible = probeGroundColumn(
      sample.graphics,
      8.31,
      8.31,
      32,
      "underfoot"
    );
    assert.equal(visible.source, "detail");
    assert.ok(Math.abs(visible.renderedHeight - 32) < 0.00001);
    sample.mesh.geometry.setDrawRange(0, 0);
    assert.equal(
      probeGroundColumn(sample.graphics, 8.31, 8.31, 32).source,
      null
    );
  } finally {
    sample.dispose();
  }
});

test("ground probes honor chunk, distant-parent and material visibility", () => {
  const sample = fixture();
  try {
    sample.detail.visible = false;
    assert.equal(
      probeGroundColumn(sample.graphics, 8.31, 8.31, 32).source,
      null
    );
    sample.distantGround.add(sample.mesh);
    sample.graphics.scene.updateMatrixWorld(true);
    assert.equal(
      probeGroundColumn(sample.graphics, 8.31, 8.31, 32).source,
      "distant"
    );
    sample.distant.visible = false;
    assert.equal(
      probeGroundColumn(sample.graphics, 8.31, 8.31, 32).source,
      null
    );
    sample.distant.visible = true;
    sample.mesh.material.visible = false;
    assert.equal(
      probeGroundColumn(sample.graphics, 8.31, 8.31, 32).source,
      null
    );
  } finally {
    sample.dispose();
  }
});

test("detached chunks and far canopies cannot masquerade as drawn ground", () => {
  const sample = fixture();
  try {
    sample.graphics.scene.remove(sample.detail);
    assert.equal(
      probeGroundColumn(sample.graphics, 8.31, 8.31, 32).source,
      null
    );
    sample.distant.add(sample.mesh);
    sample.graphics.scene.updateMatrixWorld(true);
    assert.equal(
      probeGroundColumn(sample.graphics, 8.31, 8.31, 32).source,
      null
    );
    sample.distantGround.add(sample.mesh);
    sample.graphics.scene.updateMatrixWorld(true);
    assert.equal(
      probeGroundColumn(sample.graphics, 8.31, 8.31, 32).source,
      "distant"
    );
  } finally {
    sample.dispose();
  }
});

test("high-altitude probes distinguish horizontal distance from Three fog view depth", () => {
  const sample = fixture();
  try {
    const ground = probeGroundColumn(sample.graphics, 8.31, 8.31, 32);
    assert.ok(ground.viewDepth > 100);
    assert.ok(ground.horizontalDistance < 1);
    assert.equal(ground.fogByViewDepth, 1);
    assert.equal(ground.fogByHorizontalDistance, 0);
  } finally {
    sample.dispose();
  }
});

test("coverage probes report missing geometry but exclude genuine End void", () => {
  const sample = fixture();
  try {
    const world = {
      dimension: "overworld",
      generator: { terrainHeight: () => 31 },
    };
    const coverage = sampleGroundCoverage({ graphics: sample.graphics, world });
    assert.ok(coverage.expected > 10);
    assert.ok(coverage.drawn > 0);
    assert.ok(coverage.missingDetail > 0);
    assert.equal(coverage.expected, coverage.drawn + coverage.missing);
    world.dimension = "end";
    world.generator.terrainHeight = () => -1;
    const empty = sampleGroundCoverage({ graphics: sample.graphics, world });
    assert.equal(empty.expected, 0);
    assert.equal(empty.missing, 0);
    assert.equal(empty.inViewExpected, 0);
  } finally {
    sample.dispose();
  }
});
