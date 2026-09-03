import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BOAT_WOODS, MAX_ACTIVE_BOATS } from "../src/boat-definitions.js";
import { BoatRenderer, MAX_BOAT_RENDER_PARTS } from "../src/boat-render.js";
import { MAX_FISHING_CASTS } from "../src/fishing-physics.js";
import {
  FishingRenderer,
  FISHING_LINE_SEGMENTS,
  MAX_BOBBER_RENDER_PARTS,
  MAX_FISHING_FEEDBACK,
} from "../src/fishing-render.js";
import {
  aquaticWorld,
  physicsBoat,
  physicsBobber,
} from "./vehicle-fishing-fixture.js";

test("all boat palettes and rafts share one bounded geometry/material setup", () => {
  const world = aquaticWorld(),
    scene = new THREE.Scene();
  const renderer = new BoatRenderer(scene);
  try {
    const geometry = renderer.mesh.geometry,
      material = renderer.mesh.material;
    const boats = Array.from({ length: MAX_ACTIVE_BOATS + 5 }, (_, index) =>
      physicsBoat(world, {
        id: index + 1,
        wood: BOAT_WOODS[index % BOAT_WOODS.length],
        x: index * 3,
      })
    );
    renderer.render(boats, { x: 1_000_000, y: 10, z: 0 });
    assert.equal(scene.children.length, 1);
    assert.ok(renderer.mesh.count > MAX_ACTIVE_BOATS);
    assert.ok(renderer.mesh.count <= MAX_ACTIVE_BOATS * MAX_BOAT_RENDER_PARTS);
    const matrix = renderer.mesh.instanceMatrix.array;
    renderer.render(boats.slice(0, 1), { x: 0, y: 10, z: 0 });
    assert.equal(renderer.mesh.geometry, geometry);
    assert.equal(renderer.mesh.material, material);
    assert.equal(renderer.mesh.instanceMatrix.array, matrix);
    assert.equal(renderer.diagnostics().textures, 0);
  } finally {
    renderer.dispose();
  }
  assert.equal(scene.children.length, 0);
});

test("splash/bite/catch feedback stays visible after removal, caps its ring, and expires without new buffers", () => {
  const scene = new THREE.Scene(),
    renderer = new FishingRenderer(scene);
  try {
    const matrices = renderer.bobbers.instanceMatrix.array,
      lines = renderer.linePositions;
    for (let index = 0; index < 100; index++)
      renderer.event({
        type: ["splash", "bite", "catch", "miss"][index % 4],
        position: { x: 0.5, y: 8.8, z: 0.5 },
        dimension: "overworld",
      });
    assert.equal(renderer.diagnostics().feedback, MAX_FISHING_FEEDBACK);
    renderer.render([], { x: 0, y: 10, z: 0 }, new Map(), 0, "overworld");
    assert.equal(renderer.lineGeometry.drawRange.count, 0);
    assert.ok(
      renderer.bobbers.count > 0,
      "a consumed cast does not erase its committed catch splash"
    );
    assert.ok(renderer.bobbers.count <= renderer.bobbers.instanceMatrix.count);
    renderer.render([], { x: 0, y: 10, z: 0 }, new Map(), 0, "end");
    assert.equal(
      renderer.bobbers.count,
      0,
      "old-dimension feedback is never drawn into the destination"
    );
    for (let frame = 0; frame < 4; frame++)
      renderer.render([], { x: 0, y: 10, z: 0 }, new Map(), 0.2, "overworld");
    assert.equal(renderer.hasFeedback, false);
    assert.equal(renderer.bobbers.count, 0);
    assert.equal(renderer.bobbers.instanceMatrix.array, matrices);
    assert.equal(renderer.linePositions, lines);
  } finally {
    renderer.dispose();
  }
  assert.equal(scene.children.length, 0);
});

test("bobbers, approach bubbles and line segments reuse bounded buffers", () => {
  const world = aquaticWorld(),
    scene = new THREE.Scene();
  const renderer = new FishingRenderer(scene);
  try {
    const casts = Array.from({ length: MAX_FISHING_CASTS }, (_, index) =>
      physicsBobber(world, {
        id: index + 1,
        ownerId: `player${index}`,
        phase: "approach",
        total: 40,
        remaining: 20,
      })
    );
    const owners = new Map(
      casts.map((cast) => [cast.ownerId, { eye: { x: 2, y: 10.5, z: 2 } }])
    );
    const positions = renderer.linePositions,
      matrices = renderer.bobbers.instanceMatrix.array;
    renderer.render(casts, { x: 0, y: 10, z: 0 }, owners);
    assert.equal(scene.children.length, 2);
    assert.equal(
      renderer.bobbers.count,
      MAX_FISHING_CASTS * MAX_BOBBER_RENDER_PARTS
    );
    assert.equal(
      renderer.lineGeometry.drawRange.count,
      MAX_FISHING_CASTS * FISHING_LINE_SEGMENTS * 2
    );
    renderer.render(casts.slice(0, 1), { x: 0, y: 10, z: 0 }, owners);
    assert.equal(renderer.linePositions, positions);
    assert.equal(renderer.bobbers.instanceMatrix.array, matrices);
    assert.equal(renderer.diagnostics().textures, 0);
    renderer.render([], null, new Map());
    assert.equal(renderer.lineGeometry.drawRange.count, 0);
    assert.equal(renderer.bobbers.count, 0);
  } finally {
    renderer.dispose();
  }
  assert.equal(scene.children.length, 0);
});
