import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { HORSE_STRIDE_DISTANCE } from "../src/horse-definitions.js";
import { createMobState } from "../src/mob-ai.js";
import {
  animateMob, createMobModel, isMobPartVisible, MAX_PARTS_PER_MOB,
} from "../src/mob-models.js";
import {
  createMobSkinResources, getMobSkinAtlasData, MAX_MOB_SKINS, MOB_SKIN_ATLAS_SIZE,
} from "../src/mob-skin-atlas.js";
import { paintMobSkinFace } from "../src/mob-skins.js";
import { MOB_SPECIES } from "../src/mob-species.js";
import { ecosystem } from "./mob-fixtures.js";

const view = (extra = {}) => Object.freeze({
  tamed: false, saddled: false, ridden: false, grounded: true, swimming: false, ...extra,
});
function horse() {
  const model = createMobModel("horse");
  return {
    ...createMobState("horse", () => 0), model, root: model.root,
    position: model.root.position, horseView: view(),
  };
}
const visible = (mob) => mob.model.parts.filter((part) => isMobPartVisible(part, mob));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("all tack is conditional on the committed horse view, never a held item or legacy tame flag", () => {
  const mob = horse();
  const tack = mob.model.parts.filter((part) => part.condition === "horseSaddled");
  const bareCount = mob.model.parts.length - tack.length;
  assert.equal(tack.length, 12);
  assert.equal(visible(mob).length, bareCount);
  mob.tamed = true; // Wolf-only field, deliberately not the horse authority.
  mob.horseSaddled = true; // An old ad-hoc flag must not bypass the view.
  mob.heldItem = { name: "Saddle", count: 1 };
  for (const horseView of [
    undefined, view(), view({ tamed: true }), view({ saddled: true }),
    view({ ridden: true }), view({ tamed: true, ridden: true }),
  ]) {
    mob.horseView = horseView;
    assert.equal(visible(mob).length, bareCount);
  }
  mob.horseView = view({ tamed: true, saddled: true });
  const committed = structuredClone(mob.horseView);
  assert.equal(visible(mob).length, mob.model.parts.length);
  assert.deepEqual(mob.horseView, committed);
  mob.horseView = view({ tamed: true, ridden: true });
  assert.equal(visible(mob).length, bareCount, "removal immediately hides every strap");
});

test("horse part visibility leaves all other species and their existing conditions unchanged", () => {
  for (const kind of Object.keys(MOB_SPECIES)) {
    if (kind === "horse") continue;
    const model = createMobModel(kind);
    assert.ok(model.parts.every((part) => part.condition !== "horseSaddled"), kind);
    for (const enabled of [false, true]) {
      const entity = { kind, horseView: view({ tamed: true, saddled: true }) };
      for (const part of model.parts) {
        if (part.condition) entity[part.condition] = enabled;
        assert.equal(isMobPartVisible(part, entity), !part.condition || enabled, kind);
      }
    }
  }
});

test("horse strides follow actual grounded displacement; idle intent, flight, swimming and warps do not walk", () => {
  const mob = horse();
  animateMob(mob, 0, 0);
  mob.moving = true;
  animateMob(mob, 0.1, 0.1);
  assert.equal(mob.stride, 0, "blocked intent is not movement");
  assert.ok(mob.model.legs.every((leg) => leg.rotation.x === 0));
  mob.moving = false;
  mob.position.z += 0.15;
  const position = mob.position.toArray(), yaw = mob.root.rotation.y;
  animateMob(mob, 0.05, 0.15);
  near(mob.stride, 0.15 / HORSE_STRIDE_DISTANCE * Math.PI * 2);
  const legs = mob.model.legs;
  assert.ok(Math.abs(legs[0].rotation.x) > 0.01);
  near(legs[0].rotation.x, legs[3].rotation.x);
  near(legs[1].rotation.x, legs[2].rotation.x);
  near(legs[0].rotation.x, -legs[1].rotation.x);
  assert.deepEqual(mob.position.toArray(), position);
  assert.equal(mob.root.rotation.y, yaw);
  const stride = mob.stride;
  for (const horseView of [
    view({ ridden: true, grounded: false }),
    view({ ridden: true, swimming: true }),
  ]) {
    mob.horseView = horseView;
    mob.position.z += 0.2;
    animateMob(mob, 0.1, 0.3);
    assert.equal(mob.stride, stride);
    assert.equal(mob.model.horseMotion.moving, false);
    if (horseView.swimming) assert.ok(legs.every((leg) => leg.rotation.x === 0));
  }
  mob.horseView = view({ ridden: true });
  mob.position.x = 29_000_000.375;
  animateMob(mob, 0.1, 0.4);
  assert.equal(mob.stride, stride, "teleport is not a run across the map");
  for (const dt of [0, -1, NaN, Infinity]) {
    mob.position.z += 0.1;
    animateMob(mob, dt, 0.5);
    assert.equal(mob.stride, stride);
    assert.ok(mob.model.parts.every((part) => part.node.matrixWorld.elements.every(Number.isFinite)));
  }
});

test("untracked and bareback horses share distance-based cadence without grazing into the rider", () => {
  const a = horse(), b = horse();
  a.horseView = undefined;
  b.horseView = view({ ridden: true });
  for (const mob of [a, b]) {
    mob.wanderTimer = 5;
    animateMob(mob, 0, 0);
  }
  for (let i = 0; i < 10; i++) {
    a.position.z += 0.1;
    animateMob(a, 0.05, i * 0.05);
  }
  for (let i = 0; i < 5; i++) {
    b.position.z += 0.2;
    animateMob(b, 0.1, i * 0.1);
  }
  near(a.stride, b.stride);
  for (let i = 0; i < 10; i++) animateMob(b, 0.1, i * 0.1, new THREE.Vector3(2, 0, 2));
  assert.equal(b.model.head.rotation.x, 0);
  assert.equal(b.model.head.rotation.y, 0);
  assert.equal(b.tamed, false, "bareback does not imply tame");
});

test("the complete horse model pre-registers nonemissive tack in the existing bounded shared atlas", (t) => {
  const mob = horse(), model = mob.model;
  const atlas = getMobSkinAtlasData();
  const resources = createMobSkinResources(MAX_PARTS_PER_MOB);
  t.after(() => resources.dispose());
  assert.ok(model.parts.length <= MAX_PARTS_PER_MOB);
  assert.ok(atlas.entries.size <= MAX_MOB_SKINS);
  assert.ok(atlas.usedHeight <= MOB_SKIN_ATLAS_SIZE);
  assert.equal(atlas.data.byteLength, 512 * 512 * 4);
  const parts = model.parts.slice(), nodes = [];
  model.root.traverse((node) => nodes.push(node));
  const unit = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const bounds = new THREE.Box3();
  model.root.updateMatrixWorld(true);
  for (const part of model.parts) {
    bounds.union(unit.clone().applyMatrix4(part.node.matrixWorld));
    assert.ok(atlas.entries.has(part.skin.key), part.skin.key);
    assert.equal(part.skin.translucent, false);
    if (part.condition === "horseSaddled")
      for (let face = 0; face < 6; face++) {
        const image = paintMobSkinFace(part.skin, face);
        assert.deepEqual(image.data, paintMobSkinFace(part.skin, face).data);
        for (let i = 3; i < image.data.length; i += 4) assert.equal(image.data[i], 0);
      }
  }
  assert.ok(bounds.max.y <= MOB_SPECIES.horse.height + 0.015);
  const buffers = [resources.rects.array, resources.sizes.array, resources.flashes.array];
  animateMob(mob, 0, 0);
  for (let frame = 0; frame < 80; frame++) {
    mob.horseView = view({ tamed: true, saddled: frame % 2 === 0, ridden: true });
    mob.position.z += 0.1;
    animateMob(mob, 0.05, frame * 0.05);
    visible(mob).forEach((part, i) => resources.write(i, part.skin));
    resources.update();
    assert.ok(model.parts.every((part, i) => part === parts[i]));
    assert.equal(getMobSkinAtlasData(), atlas);
  }
  const afterNodes = [];
  model.root.traverse((node) => afterNodes.push(node));
  assert.deepEqual(afterNodes, nodes);
  const afterBuffers = [resources.rects.array, resources.sizes.array, resources.flashes.array];
  assert.ok(afterBuffers.every((buffer, i) => buffer === buffers[i]));
  let disposals = 0;
  for (const resource of [resources.texture, resources.material, resources.geometry])
    resource.addEventListener("dispose", () => disposals++);
  resources.dispose();
  resources.dispose();
  assert.equal(disposals, 3);
});

test("native Wildlife batching and picking both honor the same committed saddle view", (t) => {
  // Integration gate: the Wildlife owner must replace both legacy condition
  // checks with isMobPartVisible. No render/pick monkeypatch hides a missed hook.
  const wildlife = ecosystem();
  t.after(() => wildlife.dispose());
  const mob = wildlife.spawn("horse", { x: 0, y: 9, z: 0 });
  assert.ok(mob);
  mob.root.rotation.y = 0;
  mob.horseView = view({ tamed: true });
  wildlife.render(0);
  const mesh = wildlife.mesh, resources = wildlife.skinResources;
  const bareCount = visible(mob).length;
  assert.equal(mesh.count, bareCount);
  const origin = { x: 2, y: 10.45, z: -0.12 }, direction = { x: -1, y: 0, z: 0 };
  const bareHit = wildlife.raycast(origin, direction, 3);
  assert.equal(bareHit?.entity, mob);
  mob.horseView = view({ tamed: true, saddled: true });
  wildlife.render(0);
  assert.equal(wildlife.mesh.count, mob.model.parts.length);
  const saddleHit = wildlife.raycast(origin, direction, 3);
  assert.equal(saddleHit?.entity, mob);
  assert.ok(saddleHit.distance < bareHit.distance - 0.02, "the equipped side flap is pickable");
  mob.horseView = view({ tamed: true, ridden: true });
  wildlife.render(0);
  assert.equal(mesh.count, bareCount);
  near(wildlife.raycast(origin, direction, 3).distance, bareHit.distance);
  assert.equal(wildlife.mesh, mesh);
  assert.equal(wildlife.skinResources, resources);
  assert.equal(wildlife.gelMesh, null);
});
