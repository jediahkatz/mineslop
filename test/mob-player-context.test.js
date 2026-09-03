import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createProjectileModel } from "../src/mob-models.js";
import { Wildlife } from "../src/wildlife.js";
import { ecosystem } from "./mob-fixtures.js";

function damageContext(onDamage) {
  return {
    context: { mode: "survival", spawnProtected: false, health: 20 },
    clock: 3,
    onDamage,
  };
}

test("blocked damage reconciles AI health and does not suppress later valid attacks", () => {
  const source = { id: "test-attacker", dead: false };
  const attack = { kind: "projectile", position: { x: 1, y: 10, z: -2 } };
  const events = [];
  const wildlife = damageContext((...args) => {
    events.push(args);
    return { health: 20, blocked: true, damage: 0 };
  });
  for (let i = 0; i < 3; i++)
    Wildlife.prototype.damagePlayer.call(wildlife, 20, "arrow", source, attack);
  assert.equal(events.length, 3);
  assert.equal(wildlife.context.health, 20);
  assert.equal(events[0][2], source);
  assert.equal(events[0][3], attack);
  assert.equal(wildlife.defendTarget, source.id);
});

test("mitigated damage uses explicit reported health while old callbacks retain raw semantics", () => {
  const armored = damageContext(() => ({ health: 17, damage: 3 }));
  Wildlife.prototype.damagePlayer.call(armored, 8, "Zombie");
  assert.equal(armored.context.health, 17);
  const legacy = damageContext(() => 999);
  Wildlife.prototype.damagePlayer.call(legacy, 8, "Zombie");
  assert.equal(
    legacy.context.health,
    12,
    "a numeric callback return is not a health report"
  );
  const invalid = damageContext(() => ({ health: NaN }));
  Wildlife.prototype.damagePlayer.call(invalid, 8, "Zombie");
  assert.equal(invalid.context.health, 12);
});

test("Creative, dead, protected and invalid damage never call the player damage hook", () => {
  for (const patch of [
    { mode: "creative" },
    { health: 0 },
    { spawnProtected: true },
  ]) {
    let calls = 0;
    const wildlife = damageContext(() => calls++);
    Object.assign(wildlife.context, patch);
    Wildlife.prototype.damagePlayer.call(wildlife, 5, "Zombie");
    assert.equal(calls, 0);
  }
  let calls = 0;
  const wildlife = damageContext(() => calls++);
  for (const amount of [0, -1, NaN, Infinity])
    Wildlife.prototype.damagePlayer.call(wildlife, amount, "Zombie");
  assert.equal(calls, 0);
});

test("projectile collision uses actual crouched height and forwards the impact approach", (t) => {
  for (const [height, expectedHits] of [
    [1.8, 1],
    [1.5, 0],
  ]) {
    const events = [];
    const wildlife = ecosystem(undefined, {
      onDamage: (...event) => events.push(event),
    });
    t.after(() => wildlife.dispose());
    const player = new THREE.Vector3(0, 9, 0);
    wildlife.update(0, 0, player, {
      mode: "survival",
      playerHeight: height,
      playerEye: { x: 0, y: 9 + height - 0.18, z: 0 },
    });
    const model = createProjectileModel("arrow");
    model.root.position.set(-1, 10.7, 0);
    const source = {
      id: "test-archer",
      name: "Skeleton",
      position: new THREE.Vector3(-5, 9, 0),
    };
    wildlife.projectiles.push({
      kind: "arrow",
      model,
      position: model.root.position,
      velocity: new THREE.Vector3(20, 0, 0),
      age: 0,
      source,
      damage: 4,
    });
    wildlife.updateProjectiles(0.1);
    assert.equal(events.length, expectedHits);
    if (expectedHits) {
      assert.equal(events[0][2], source);
      assert.equal(events[0][3].kind, "projectile");
      assert.equal(
        events[0][3].position.x,
        -1,
        "shield direction uses the arrow approach"
      );
    }
  }
});

test("third-person transparency sorting uses render view without changing physical AI sight", (t) => {
  const wildlife = ecosystem();
  t.after(() => wildlife.dispose());
  wildlife.spawn("slime", { x: 0, y: 9, z: 1 });
  wildlife.spawn("slime", { x: 0, y: 9, z: -2 });
  const eye = { x: 0, y: 10.62, z: 0 };
  const forward = { x: 0, y: 0, z: -1 };
  const renderEye = { x: 0, y: 10.62, z: -4 };
  const renderForward = { x: 0, y: 0, z: 1 };
  wildlife.update(0, 0, new THREE.Vector3(0, 9, 0), {
    mode: "creative",
    playerEye: eye,
    playerForward: forward,
    renderEye,
    renderForward,
  });
  assert.deepEqual(wildlife.context.playerEye, eye);
  assert.equal(wildlife.context.playerForward, forward);
  assert.equal(wildlife.context.renderEye, renderEye);
  let previous = Infinity;
  for (let i = 0; i < wildlife.gelCount; i++) {
    const instance = wildlife.gelInstances[i];
    const actualDepth =
      instance.part.node.matrixWorld.elements[14] - renderEye.z;
    assert.ok(Math.abs(instance.depth - actualDepth) < 1e-9);
    assert.ok(
      instance.depth <= previous,
      "shells sort back to front in the actual camera"
    );
    previous = instance.depth;
  }
});
