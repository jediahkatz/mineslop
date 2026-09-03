import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createMobState, mobEye } from "../src/mob-ai.js";
import {
  animateMob,
  createMobModel,
  createProjectileModel,
  MAX_GEL_PARTS_PER_MOB,
  MAX_PARTS_PER_MOB,
} from "../src/mob-models.js";
import { paintMobSkinFace } from "../src/mob-skins.js";
import { MOB_SPECIES } from "../src/mob-species.js";
import { ecosystem } from "./mob-fixtures.js";

const unit = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5)
);
function bounds(model, parts = model.parts) {
  model.root.updateMatrixWorld(true);
  const result = new THREE.Box3();
  for (const part of parts)
    result.union(unit.clone().applyMatrix4(part.node.matrixWorld));
  return result;
}

function entityFor(kind) {
  const model = createMobModel(kind);
  return {
    ...createMobState(kind, () => 0),
    model,
    root: model.root,
    position: model.root.position,
  };
}

test("every species has finite, grounded anatomy within its existing height and picking bounds", () => {
  const silhouettes = new Set();
  for (const [kind, spec] of Object.entries(MOB_SPECIES)) {
    const model = createMobModel(kind);
    const box = bounds(
      model,
      model.parts.filter((part) => !part.condition)
    );
    assert.ok(
      model.parts.length > 5 && model.parts.length <= MAX_PARTS_PER_MOB,
      kind
    );
    assert.ok(
      box.max.y <= spec.height + 0.015,
      `${kind}: model ${box.max.y} > physics height ${spec.height}`
    );
    if (!spec.flying && !spec.aquatic) {
      assert.ok(box.min.y >= -1e-8, `${kind}: feet penetrate the floor`);
      assert.ok(
        box.min.y < 0.03,
        `${kind}: feet float ${box.min.y} above ground`
      );
    }
    assert.ok(model.pickFloor <= box.min.y && model.pickHeight >= box.max.y);
    assert.ok(
      model.pickRadius >=
        Math.max(Math.abs(box.min.x), box.max.x, Math.abs(box.min.z), box.max.z)
    );
    for (const part of model.parts) {
      assert.ok(part.node.matrixWorld.elements.every(Number.isFinite));
      assert.ok(part.node.scale.toArray().every((value) => value > 0));
    }
    silhouettes.add(
      JSON.stringify(
        model.parts.map((part) => [
          part.node.position.toArray(),
          part.node.scale.toArray(),
        ])
      )
    );
  }
  assert.ok(
    silhouettes.size >= 24,
    "distinct bodies, not just distinct palettes"
  );
});

test("recognizable hostile anatomy has narrow bones, long limbs, and eight planted spider legs", () => {
  const skeleton = createMobModel("skeleton");
  const ribs = skeleton.parts.filter((part) => part.role === "rib");
  assert.equal(skeleton.legs.length, 2);
  assert.ok(ribs.length >= 3);
  assert.ok(ribs.every((part) => part.node.scale.y < 0.13));
  assert.ok(skeleton.parts.some((part) => part.role === "bow"));
  assert.ok(
    !skeleton.parts.some((part) => /socket|pupil|eye_white/.test(part.role))
  );
  const enderman = createMobModel("enderman");
  const longLeg = enderman.parts.find((part) => part.role === "leg").node;
  const torso = enderman.parts.find((part) => part.role === "body").node;
  assert.ok(longLeg.scale.y > torso.scale.y * 2);
  assert.ok(longLeg.scale.x < torso.scale.x / 3);
  const spider = createMobModel("spider");
  const spiderBounds = bounds(spider);
  assert.equal(spider.legs.length, 8);
  assert.ok(spiderBounds.max.x - spiderBounds.min.x > spiderBounds.max.y * 2);
  for (const joint of spider.legs) {
    const foot = bounds(
      spider,
      spider.parts.filter((part) => part.node.parent === joint)
    );
    assert.ok(foot.min.y >= 0 && foot.min.y < 0.03);
  }
});

test("quadrupeds walk with opposing sides and diagonal support, keeping visual motion out of physics", () => {
  for (const kind of [
    "sheep",
    "pig",
    "cow",
    "horse",
    "wolf",
    "fox",
    "goat",
    "polar_bear",
    "panda",
    "camel",
    "mooshroom",
    "creeper",
  ]) {
    const mob = entityFor(kind);
    const position = mob.position.toArray();
    mob.moving = true;
    animateMob(mob, 0.1, 0.1);
    const legs = mob.model.legs;
    assert.equal(legs.length, 4, kind);
    assert.ok(Math.abs(legs[0].rotation.x) > 0.01, kind);
    assert.ok(Math.abs(legs[0].rotation.x - legs[3].rotation.x) < 1e-10, kind);
    assert.ok(Math.abs(legs[1].rotation.x - legs[2].rotation.x) < 1e-10, kind);
    assert.ok(Math.abs(legs[0].rotation.x + legs[1].rotation.x) < 1e-10, kind);
    assert.deepEqual(
      mob.position.toArray(),
      position,
      "animation never lifts or steers the physics root"
    );
    mob.moving = false;
    animateMob(mob, 0.2, 0.3);
    assert.ok(legs.every((leg) => leg.rotation.x === 0));
  }
});

test("hopping gels squash about ground contact and retain the same simulated position", () => {
  for (const kind of ["slime", "sulfur_cube"]) {
    const mob = entityFor(kind);
    const before = mob.position.toArray();
    for (const [velocityY, moving] of [
      [3, true],
      [0, true],
      [0, false],
    ]) {
      Object.assign(mob, { velocityY, moving });
      animateMob(mob, 0.05, 0.5);
      const box = bounds(
        mob.model,
        mob.model.parts.filter((part) => !part.condition)
      );
      assert.ok(
        Math.abs(box.min.y) < 1e-8,
        `${kind}: squash must not sink into the floor`
      );
      assert.deepEqual(mob.position.toArray(), before);
      assert.ok(
        mob.model.core.scale
          .toArray()
          .every((value) => Number.isFinite(value) && value > 0)
      );
    }
  }
});

test("slime has a wholly enclosed opaque face/core and the same grounded outer silhouette", () => {
  const mob = entityFor("slime");
  const model = mob.model;
  const shell = model.parts.find((part) => part.role === "gel_shell");
  const nucleus = model.parts.find((part) => part.role === "gel");
  assert.equal(
    model.parts.filter((part) => part.skin.translucent).length,
    MAX_GEL_PARTS_PER_MOB
  );
  assert.equal(model.parts.filter((part) => !part.skin.translucent).length, 1);
  assert.equal(shell.skin.translucent, true);
  assert.equal(nucleus.skin.translucent, false);
  assert.equal(nucleus.node.parent, shell.node.parent);
  const rest = bounds(model);
  for (const [actual, expected] of [
    [rest.min.x, -0.52],
    [rest.max.x, 0.52],
    [rest.min.z, -0.52],
    [rest.max.z, 0.52],
    [rest.min.y, 0],
    [rest.max.y, 1.1075],
  ])
    assert.ok(Math.abs(actual - expected) < 1e-8, "unchanged shell dimensions");
  for (const velocityY of [-3, 0, 4]) {
    for (const elapsed of [0, 0.3, 0.94, 1.57]) {
      mob.moving = true;
      mob.velocityY = velocityY;
      animateMob(mob, 0.05, elapsed);
      const shellSpace = shell.node.matrixWorld.clone().invert();
      const inner = unit
        .clone()
        .applyMatrix4(shellSpace.multiply(nucleus.node.matrixWorld));
      for (const axis of ["x", "y", "z"]) {
        assert.ok(inner.min[axis] > -0.4 && inner.max[axis] < 0.4, axis);
      }
      const outer = bounds(model);
      assert.ok(
        Math.abs(outer.min.y) < 1e-8,
        "no floor penetration at squash extremes"
      );
      assert.deepEqual(mob.position.toArray(), [0, 0, 0]);
    }
  }
  const face = paintMobSkinFace(nucleus.skin, "front");
  const ink = new Set();
  for (let y = 0; y < face.height * 0.5; y++) {
    for (let x = 0; x < face.width; x++) {
      const i = (y * face.width + x) * 4;
      if (face.data[i] === 0x35 && face.data[i + 1] === 0x57)
        ink.add(x < face.width / 2 ? "left" : "right");
    }
  }
  assert.equal(
    ink.size,
    2,
    "both inset eyes survive the smaller core's texel grid"
  );
  for (const model of Object.keys(MOB_SPECIES)
    .filter((kind) => kind !== "slime")
    .map(createMobModel))
    assert.ok(
      model.parts.every((part) => !part.skin.translucent),
      model.kind
    );
});

test("the Enderman skin's eye row and real animated head remain the gameplay stare target", () => {
  const wildlife = ecosystem();
  try {
    const mob = wildlife.spawn("enderman", {
      x: 29_000_000.375,
      y: 9,
      z: -29_000_000.625,
    });
    const part = mob.model.parts.find(
      (entry) => entry.node === mob.model.stareTarget
    );
    const face = paintMobSkinFace(part.skin, "front");
    const rows = new Set();
    for (let y = 0; y < face.height; y++)
      for (let x = 0; x < face.width; x++)
        if (face.data[(y * face.width + x) * 4 + 3] > 0) rows.add(y);
    assert.equal(rows.size, 1, "one narrow eye row, not an emissive head");
    const row = [...rows][0];
    const eyeY =
      mob.position.y +
      mob.model.head.position.y +
      (0.5 - (row + 0.5) / face.height) * part.node.scale.y;
    assert.ok(Math.abs(eyeY - mobEye(mob).y) < 1e-6);
    mob.root.rotation.y = 0.7;
    mob.model.head.rotation.y = -0.3;
    wildlife.context.playerEye = {
      x: mob.position.x,
      y: eyeY,
      z: mob.position.z + 3,
    };
    wildlife.context.playerForward = { x: 0, y: 0, z: -1 };
    assert.equal(wildlife.isLookingAt(mob), true);
    const hit = wildlife.raycast(
      wildlife.context.playerEye,
      wildlife.context.playerForward,
      5
    );
    assert.equal(hit?.entity, mob);
    wildlife.context.playerEye.y = mob.position.y + 2;
    assert.equal(wildlife.isLookingAt(mob), false);
  } finally {
    wildlife.dispose();
  }
});

test("native wings, bow poses, tentacles, tails, and three-part projectile transforms stay finite", () => {
  for (const kind of Object.keys(MOB_SPECIES)) {
    const mob = entityFor(kind);
    mob.moving = true;
    mob.velocityY = -1;
    for (let frame = 0; frame < 8; frame++) {
      animateMob(mob, 0.05, frame * 0.05, new THREE.Vector3(2, 0, 3));
      for (const part of mob.model.parts)
        assert.ok(part.node.matrixWorld.elements.every(Number.isFinite), kind);
    }
  }
  for (const kind of ["arrow", "fireball"]) {
    const model = createProjectileModel(kind);
    model.root.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0.2, -0.4).normalize()
    );
    model.root.updateMatrixWorld(true);
    assert.equal(model.parts.length, 3);
    assert.ok(
      model.parts.every((part) =>
        part.node.matrixWorld.elements.every(Number.isFinite)
      )
    );
  }
});
