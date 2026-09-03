import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ITEM } from "../src/items.js";
import { CHUNK_SIZE } from "../src/terrain.js";
import { advance, ecosystem, flatWorld } from "./mob-fixtures.js";

const EPSILON = 1e-5;
const FAR = 29_000_000;

function uploadedPositions(wildlife) {
  wildlife.scene.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  return Array.from({ length: wildlife.mesh.count }, (_, index) => {
    wildlife.mesh.getMatrixAt(index, matrix);
    return new THREE.Vector3()
      .setFromMatrixPosition(matrix)
      .applyMatrix4(wildlife.mesh.matrixWorld);
  });
}

function visibleParts(wildlife) {
  return [
    ...wildlife.entities.flatMap((mob) =>
      mob.dormant
        ? []
        : mob.model.parts.filter(
            (part) => !part.condition || mob[part.condition]
          )
    ),
    ...wildlife.projectiles.flatMap((shot) => shot.model.parts),
  ];
}

function assertAccurateUploads(wildlife) {
  const uploaded = uploadedPositions(wildlife);
  const parts = visibleParts(wildlife);
  assert.equal(uploaded.length, parts.length);
  let maxError = 0;
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < parts.length; i++) {
    const expected = new THREE.Vector3().setFromMatrixPosition(
      parts[i].node.matrixWorld
    );
    maxError = Math.max(maxError, uploaded[i].distanceTo(expected));
    wildlife.mesh.getMatrixAt(i, matrix);
    for (const axis of [12, 13, 14]) {
      assert.ok(
        Math.abs(matrix.elements[axis]) < 128,
        "GPU translations stay local, not at world-border magnitudes"
      );
    }
  }
  assert.ok(maxError < EPSILON, `maximum instance error: ${maxError}`);
  return maxError;
}

test("Float32 uploads retain fractional mob details at +/-29 million like the origin", (t) => {
  let reference;
  for (const offset of [0, FAR, -FAR]) {
    const wildlife = ecosystem();
    t.after(() => wildlife.dispose());
    const mob = wildlife.spawn("sheep", {
      x: offset + 0.5,
      y: 9,
      z: -offset + 0.5,
    });
    mob.root.rotation.y = 0;
    // Loading a save can render before a player position has been supplied.
    wildlife.update(0, 0);
    const maxError = assertAccurateUploads(wildlife);
    const relative = uploadedPositions(wildlife).map((position) =>
      position.sub(mob.position)
    );
    const distinctX = new Set(relative.map((position) => position.x.toFixed(6)))
      .size;
    reference ??= relative;
    assert.ok(distinctX > 1, "separate eyes, ears, and legs do not collapse");
    for (let i = 0; i < reference.length; i++)
      assert.ok(relative[i].distanceTo(reference[i]) < EPSILON);
    assert.equal(mob.position.x, offset + 0.5);
    assert.equal(
      mob.model.parts[0].node.matrixWorld.elements[12],
      mob.position.x
    );
    t.diagnostic(
      `World x=${offset}: ${distinctX} distinct X offsets; maximum GPU position error=${maxError}`
    );
  }
});

test("repeated chunk-origin rebases do not accumulate drift or change world-space picking and saves", (t) => {
  const wildlife = ecosystem();
  t.after(() => wildlife.dispose());
  const horse = wildlife.spawn("horse", {
    x: FAR + 14.375,
    y: 9,
    z: -FAR + 0.5,
  });
  horse.root.rotation.y = Math.PI / 2;
  wildlife.update(0, 0, horse.position);
  const before = wildlife.serialize();
  const matrices = horse.model.parts.map((part) =>
    part.node.matrixWorld.elements.slice()
  );
  const reference = uploadedPositions(wildlife);
  const origin = {
    x: horse.position.x + 2,
    y: 10.9,
    z: horse.position.z,
  };
  const direction = { x: -1, y: 0, z: 0 };
  const initialHit = wildlife.raycast(origin, direction, 1);
  assert.equal(initialHit?.entity, horse);
  for (let frame = 0; frame < 60; frame++) {
    const shift = [15.9, 16.1, 32.1, -0.1, 0.1][frame % 5];
    const player = new THREE.Vector3(FAR + shift, 9, -FAR - shift);
    wildlife.update(0, 0, player);
    assert.equal(
      wildlife.mesh.position.x,
      Math.floor(player.x / CHUNK_SIZE) * CHUNK_SIZE
    );
    assert.equal(
      wildlife.mesh.position.z,
      Math.floor(player.z / CHUNK_SIZE) * CHUNK_SIZE
    );
    assertAccurateUploads(wildlife);
    const positions = uploadedPositions(wildlife);
    for (let i = 0; i < reference.length; i++) {
      assert.ok(positions[i].distanceTo(reference[i]) < EPSILON);
      assert.deepEqual(
        horse.model.parts[i].node.matrixWorld.elements,
        matrices[i]
      );
    }
    const hit = wildlife.raycast(origin, direction, 1);
    assert.equal(hit?.entity, horse);
    assert.ok(Math.abs(hit.distance - initialHit.distance) < EPSILON);
  }
  assert.deepEqual(wildlife.serialize(), before);
});

test("projectile uploads rebase with mobs while world-space flight and impact stay unchanged", (t) => {
  const results = [];
  for (const offset of [0, FAR, -FAR]) {
    const attacks = [];
    const wildlife = ecosystem(flatWorld(), {
      onDamage: (...event) => attacks.push(event),
    });
    t.after(() => wildlife.dispose());
    const player = new THREE.Vector3(offset + 0.5, 9, -offset + 0.5);
    const skeleton = wildlife.spawn("skeleton", {
      x: player.x + 8,
      y: 9,
      z: player.z,
    });
    advance(wildlife, 0.7, player);
    assert.equal(wildlife.projectiles.length, 1);
    assertAccurateUploads(wildlife);
    const shot = wildlife.projectiles[0];
    assert.equal(shot.source, skeleton);
    const shotPosition = shot.position.clone().sub(player);
    advance(wildlife, 1, player);
    assert.equal(attacks.length, 1);
    assert.equal(wildlife.projectiles.length, 0);
    const [damage, cause, source, impact] = attacks[0];
    assert.equal(source, skeleton, "the actual shooter reaches onDamage");
    assert.equal(damage, skeleton.spec.damage);
    assert.equal(cause, `${skeleton.name} arrow`);
    assert.equal(impact.kind, "projectile");
    assert.ok(
      impact.position.equals(shot.position),
      "impact context retains the projectile's exact world-space position"
    );
    results.push({
      shotPosition,
      attack: { damage, cause, sourceKind: source.kind, kind: impact.kind },
      impactPosition: impact.position.clone().sub(player),
    });
  }
  for (const result of results.slice(1)) {
    assert.ok(
      results[0].shotPosition.distanceTo(result.shotPosition) < EPSILON
    );
    assert.deepEqual(result.attack, results[0].attack);
    assert.ok(
      results[0].impactPosition.distanceTo(result.impactPosition) < EPSILON,
      "relative projectile impact is unchanged across world-space rebases"
    );
  }
});

test("tamed wolves keep following and safely catch up across far-coordinate render rebases", (t) => {
  const wildlife = ecosystem();
  t.after(() => wildlife.dispose());
  const player = new THREE.Vector3(FAR + 0.5, 9, -FAR + 0.5);
  const wolf = wildlife.spawn("wolf", {
    x: player.x + 7,
    y: 9,
    z: player.z,
  });
  assert.equal(wildlife.interact(wolf, ITEM.BONE), true);
  advance(wildlife, 2, player, { mode: "creative" });
  assert.ok(wolf.position.distanceTo(player) < 5);
  assertAccurateUploads(wildlife);
  player.add(new THREE.Vector3(37.375, 0, 31.125));
  advance(wildlife, 0.1, player, { mode: "creative" });
  assert.ok(wolf.tamed && !wolf.dead);
  assert.ok(wolf.position.distanceTo(player) < 6);
  assert.ok(wolf.position.x > FAR && wolf.position.z < -FAR + 40);
  assert.equal(wolf.position.y, wolf.groundY);
  assertAccurateUploads(wildlife);
  const hit = wildlife.raycast(
    { x: wolf.position.x + 2, y: wolf.position.y + 0.65, z: wolf.position.z },
    { x: -1, y: 0, z: 0 },
    3
  );
  assert.equal(hit?.entity, wolf);
});
