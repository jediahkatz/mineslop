import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE } from "../src/block-state.js";
import { raycastMelee } from "../src/melee-targeting.js";
import { animateMob } from "../src/mob-models.js";
import { rayBoxDistance } from "../src/mob-navigation.js";
import { MAX_MOBS, MOB_SPECIES } from "../src/mob-species.js";
import { raycast } from "../src/raycast.js";
import { ecosystem, flatWorld } from "./mob-fixtures.js";

function fixture(t, world = flatWorld()) {
  const wildlife = ecosystem(world);
  t.after(() => wildlife.dispose());
  const mob = wildlife.spawn("enderman", { x: 0.5, y: 9, z: 3 });
  assert.ok(mob, "the real Enderman passes spawn/collider validation");
  mob.root.rotation.y = mob.targetYaw = Math.PI;
  const eye = { x: 0.5, y: 10.62, z: 0.5 };
  const forward = { x: 0, y: 0, z: 1 };
  return { wildlife, world, mob, eye, forward };
}

const aimAt = (eye, point) =>
  new THREE.Vector3(
    point.x - eye.x,
    point.y - eye.y,
    point.z - eye.z
  ).normalize();
const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

test("eye-gap and collider-center acquire melee without changing precise picking", (t) => {
  const { wildlife, world, mob, eye } = fixture(t);
  world.edits.set("0,10,4", BLOCK.DIRT);
  for (const height of [1.62, mob.spec.height / 2]) {
    const direction = aimAt(eye, {
      ...mob.position,
      y: mob.position.y + height,
    });
    const precise = wildlife.raycast(eye, direction, 3);
    const block = raycast(world, eye, direction, 4.5);
    assert.equal(
      precise,
      null,
      "the observed rendered-part gap is still precise"
    );
    assert.equal(block?.id, BLOCK.DIRT);
    const hit = raycastMelee(wildlife, world, eye, direction, 3, {
      preciseHit: precise,
      blockHit: block,
    });
    assert.equal(hit?.entity, mob);
    assert.ok(hit.distance < block.distance && hit.distance <= 3);
    assert.equal(wildlife.raycast(eye, direction, 32), null);
    assert.equal(world.edits.get("0,10,4"), BLOCK.DIRT, "a query never mines");
  }
});

test("physical volume is continuous across headings, ray azimuths and animation poses", (t) => {
  const { wildlife, world, mob } = fixture(t);
  const before = mob.position.clone();
  for (let heading = 0; heading < 16; heading++) {
    mob.root.rotation.y = (heading * Math.PI) / 8;
    for (const moving of [false, true]) {
      mob.moving = moving;
      animateMob(mob, 0.1, heading * 0.17);
      for (let azimuth = 0; azimuth < 8; azimuth++) {
        const angle = (azimuth * Math.PI) / 4;
        const direction = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
        const eye = {
          x: mob.position.x - direction.x * 2.5,
          y: mob.position.y + 1.62,
          z: mob.position.z - direction.z * 2.5,
        };
        const hit = raycastMelee(wildlife, world, eye, direction, 3, {
          preciseHit: null,
          blockHit: null,
        });
        assert.equal(hit?.entity, mob, `${heading}/${moving}/${azimuth}`);
        close(
          hit.distance,
          2.5 -
            mob.spec.radius /
              Math.max(Math.abs(direction.x), Math.abs(direction.z))
        );
      }
    }
  }
  assert.ok(
    mob.position.equals(before),
    "no animation/model position is substituted"
  );
});

test("torso/head controls remain selectable and the precise head stare stays separate", (t) => {
  const { wildlife, world, mob, eye, forward } = fixture(t);
  wildlife.context.playerEye = eye;
  wildlife.context.playerForward = forward;
  assert.equal(wildlife.isLookingAt(mob), false);
  assert.equal(raycastMelee(wildlife, world, eye, forward, 3)?.entity, mob);
  assert.equal(wildlife.isLookingAt(mob), false, "melee is not a stare query");
  for (let heading = 0; heading < 8; heading++) {
    mob.root.rotation.y = (heading * Math.PI) / 4;
    for (const role of ["body", "head", "leg"]) {
      const part = mob.model.parts.find((entry) => entry.role === role);
      const point = part.node.getWorldPosition(new THREE.Vector3());
      const direction = aimAt(eye, point);
      const precise = wildlife.raycast(eye, direction, 3);
      assert.equal(precise?.entity, mob, `${heading}/${role}`);
      assert.equal(
        raycastMelee(wildlife, world, eye, direction, 3)?.entity,
        mob
      );
      wildlife.context.playerForward = direction;
      assert.equal(wildlife.isLookingAt(mob), role === "head");
    }
  }
});

test("only the real body is filled, not the wider model broad phase or extra height", (t) => {
  const { wildlife, world, mob, eye, forward } = fixture(t);
  const outside = { ...eye, x: mob.position.x + mob.spec.radius + 0.04 };
  assert.notEqual(
    rayBoxDistance(
      outside,
      forward,
      mob.position,
      mob.model.pickRadius,
      mob.model.pickHeight,
      3
    ),
    null,
    "control ray passes through cosmetic broad-phase bounds"
  );
  assert.equal(raycastMelee(wildlife, world, outside, forward, 3), null);
  assert.equal(
    raycastMelee(
      wildlife,
      world,
      {
        ...eye,
        y: mob.position.y + mob.spec.height + 0.01,
      },
      forward,
      3
    ),
    null
  );
});

test("3/5-block reach uses the physical surface and normalizes direction without extending range", (t) => {
  const { wildlife, world, mob, eye, forward } = fixture(t);
  for (const reach of [3, 5]) {
    for (const offset of [-0.00001, 0, 0.00001]) {
      mob.position.z = eye.z + reach + mob.spec.radius + offset;
      const direction = { x: 0, y: 0, z: 19 };
      const hit = raycastMelee(wildlife, world, eye, direction, reach);
      if (offset > 0) assert.equal(hit, null);
      else {
        assert.equal(hit?.entity, mob);
        close(hit.distance, reach + offset);
        assert.ok(hit.distance <= reach);
      }
      assert.deepEqual(direction, { x: 0, y: 0, z: 19 });
    }
    mob.position.z = eye.z + reach + mob.spec.radius - 0.00001;
    assert.equal(
      raycastMelee(wildlife, world, eye, forward, reach)?.entity,
      mob
    );
  }
});

test("pitched diagonal reach is measured along the ray, not one horizontal component", (t) => {
  const { wildlife, world, mob, eye } = fixture(t);
  const direction = { x: 1, y: 0.2, z: 1 };
  const component = 1 / Math.hypot(1, 0.2, 1);
  for (const reach of [3, 5]) {
    for (const offset of [-0.00001, 0.00001]) {
      mob.position.x = eye.x + component * (reach + offset) + mob.spec.radius;
      mob.position.z = eye.z + component * (reach + offset) + mob.spec.radius;
      const hit = raycastMelee(wildlife, world, eye, direction, reach, {
        preciseHit: null,
      });
      if (offset > 0) assert.equal(hit, null);
      else {
        assert.equal(hit?.entity, mob);
        close(hit.distance, reach + offset);
      }
    }
  }
});

test("closest blocks win including ties; a farther background block does not mask melee", (t) => {
  const { wildlife, world, eye, forward, mob } = fixture(t);
  const hit = raycastMelee(wildlife, world, eye, forward, 3);
  for (const distance of [0, hit.distance - 0.00001, hit.distance]) {
    assert.equal(
      raycastMelee(wildlife, world, eye, forward, 3, {
        blockHit: { distance },
        preciseHit: null,
      }),
      null
    );
  }
  assert.equal(
    raycastMelee(wildlife, world, eye, forward, 3, {
      blockHit: { distance: hit.distance + 0.00001 },
    })?.entity,
    mob
  );
  world.edits.set("0,10,1", BLOCK.STONE);
  assert.equal(raycastMelee(wildlife, world, eye, forward, 3), null);
  assert.equal(
    raycastMelee(wildlife, world, eye, forward, 3, { blockHit: null }),
    null,
    "LOS also rejects solid cover independently of the selection hit"
  );
});

test("LOS respects partial-block cover, not an expanded or full-cube approximation", (t) => {
  const { wildlife, world, mob, eye, forward } = fixture(t);
  // Opt this legacy test world into the real state-aware shape channels.
  let state = 0;
  world.getBlockState = () => state;
  world.edits.set("0,10,1", BLOCK.OAK_SLAB);
  assert.equal(raycastMelee(wildlife, world, eye, forward, 3)?.entity, mob);
  state = BLOCK_STATE.TOP;
  assert.equal(raycastMelee(wildlife, world, eye, forward, 3), null);
  assert.equal(
    raycastMelee(wildlife, world, eye, forward, 3, { blockHit: null }),
    null
  );
});

test("unloaded origin, intervening, entry and far body columns all fail closed without reads", (t) => {
  const missing = new Set();
  const world = flatWorld({ loaded: (x, z) => !missing.has(`${x},${z}`) });
  const { wildlife, mob, eye, forward } = fixture(t, world);
  for (const column of ["0,0", "0,1", "0,2", "0,3"]) {
    missing.clear();
    missing.add(column);
    assert.equal(raycastMelee(wildlife, world, eye, forward, 3), null, column);
    const head = mob.model.stareTarget.getWorldPosition(new THREE.Vector3());
    assert.equal(raycastMelee(wildlife, world, eye, aimAt(eye, head), 3), null);
    assert.equal(world.unloadedReads, 0);
  }
  missing.clear();
  assert.equal(raycastMelee(wildlife, world, eye, forward, 3)?.entity, mob);
});

test("a sub-millimeter body overlap with an unloaded side column also fails closed", (t) => {
  let missing = false;
  const world = flatWorld({
    loaded: (x, z) => !(missing && x === 1 && z === 3),
  });
  const { wildlife, mob, eye, forward } = fixture(t, world);
  mob.position.x = eye.x = 1 - mob.spec.radius + 0.0005;
  assert.equal(raycastMelee(wildlife, world, eye, forward, 3)?.entity, mob);
  missing = true;
  assert.equal(raycastMelee(wildlife, world, eye, forward, 3), null);
  assert.equal(world.unloadedReads, 0);
});

test("nearest precise animals and nearest Endermen win independent of entity order", (t) => {
  const { wildlife, world, mob, eye, forward } = fixture(t);
  const zombie = wildlife.spawn("zombie", { x: 0.5, y: 9, z: 1.75 });
  assert.ok(zombie);
  const head = zombie.model.parts.find((entry) => entry.role === "head");
  const direction = aimAt(eye, head.node.getWorldPosition(new THREE.Vector3()));
  const precise = wildlife.raycast(eye, direction, 3);
  assert.equal(precise?.entity, zombie);
  for (let i = 0; i < 2; i++) {
    assert.equal(
      raycastMelee(wildlife, world, eye, direction, 3)?.entity,
      zombie
    );
    wildlife.entities.reverse();
  }
  wildlife.remove(zombie);
  const farther = wildlife.spawn("enderman", { x: 0.5, y: 9, z: 4 });
  assert.ok(farther);
  for (let i = 0; i < 2; i++) {
    assert.equal(raycastMelee(wildlife, world, eye, forward, 5)?.entity, mob);
    wildlife.entities.reverse();
  }
  const equal = {
    entity: farther,
    distance: 2.5 - mob.spec.radius,
    name: farther.name,
  };
  assert.equal(
    raycastMelee(wildlife, world, eye, forward, 5, { preciseHit: equal }),
    equal,
    "equal-distance precise candidates retain their existing precedence"
  );
});

test("a non-Enderman model gap is not filled by its physical collider", (t) => {
  const { wildlife, world, mob, eye } = fixture(t);
  wildlife.remove(mob);
  const skeleton = wildlife.spawn("skeleton", { x: 0.5, y: 9, z: 3 });
  assert.ok(skeleton);
  const gap = aimAt(eye, {
    x: skeleton.position.x,
    y: skeleton.position.y + 0.35,
    z: skeleton.position.z,
  });
  assert.equal(wildlife.raycast(eye, gap, 3), null);
  assert.equal(
    raycastMelee(wildlife, world, eye, gap, 3),
    null,
    "only an actual precise result may select another species"
  );
  const point = skeleton.model.parts
    .find((part) => part.role === "skull")
    .node.getWorldPosition(new THREE.Vector3());
  const direction = aimAt(eye, point);
  const precise = wildlife.raycast(eye, direction, 3);
  assert.equal(precise?.entity, skeleton);
  assert.equal(
    raycastMelee(wildlife, world, eye, direction, 3, { preciseHit: precise }),
    precise
  );
});

test("dead, dormant, removed or context-stale entities cannot be selected", (t) => {
  const { wildlife, world, mob, eye, forward } = fixture(t);
  const precise = { entity: mob, distance: 2.5, name: mob.name };
  const query = () =>
    raycastMelee(wildlife, world, eye, forward, 3, { preciseHit: precise });
  for (const flag of ["dead", "dormant"]) {
    mob[flag] = true;
    assert.equal(query(), null);
    mob[flag] = false;
  }
  wildlife.byId.delete(mob.id);
  assert.equal(query(), null);
  wildlife.byId.set(mob.id, mob);
  world.dimension = "nether";
  assert.equal(query(), null);
  world.dimension = "overworld";
  assert.equal(raycastMelee(wildlife, flatWorld(), eye, forward, 3), null);
  wildlife.dispose();
  assert.equal(query(), null);
});

test("inside-volume starts return zero for every axis, even at zero reach", (t) => {
  const { wildlife, world, mob } = fixture(t);
  const eye = { ...mob.position, y: mob.position.y + 1.62 };
  for (const axis of ["x", "y", "z"]) {
    for (const sign of [-1, 1]) {
      const direction = { x: 0, y: 0, z: 0, [axis]: sign };
      const hit = raycastMelee(wildlife, world, eye, direction, 0);
      assert.equal(hit?.entity, mob);
      assert.equal(hit.distance, 0);
    }
  }
  world.edits.set("0,10,3", BLOCK.STONE);
  assert.equal(
    raycastMelee(wildlife, world, eye, { x: 0, y: 0, z: 1 }, 3),
    null,
    "a zero-distance block still wins while inside the mob"
  );
  assert.equal(
    raycastMelee(
      wildlife,
      world,
      { ...eye, z: eye.z + 0.1 },
      {
        x: 0,
        y: 0,
        z: 1,
      },
      3,
      { blockHit: null }
    ),
    null,
    "zero-length LOS is not permission to hit from inside solid cover"
  );
});

test("far-world coordinates retain physical double-precision distances", (t) => {
  const { wildlife, world, mob } = fixture(t);
  mob.position.set(29_000_000.5, 9, -29_000_000.5);
  const eye = { x: mob.position.x, y: 10.62, z: mob.position.z - 2.5 };
  const hit = raycastMelee(wildlife, world, eye, { x: 0, y: 0, z: 1 }, 3);
  assert.equal(hit?.entity, mob);
  close(hit.distance, 2.5 - MOB_SPECIES.enderman.radius, 1e-7);
});

test("reusing raw precise/block results avoids duplicate queries and preserves their objects", (t) => {
  const { wildlife, world, eye, mob } = fixture(t);
  const point = mob.model.stareTarget.getWorldPosition(new THREE.Vector3());
  const direction = aimAt(eye, point);
  const precise = wildlife.raycast(eye, direction, 3);
  const before = { ...precise };
  t.mock.method(wildlife, "raycast", () =>
    assert.fail("duplicate precise query")
  );
  const hit = raycastMelee(wildlife, world, eye, direction, 3, {
    preciseHit: precise,
    blockHit: null,
  });
  assert.equal(hit?.entity, mob);
  assert.deepEqual(precise, before);
});

test("invalid rays and oversized queries fail before unbounded work", (t) => {
  const { wildlife, world, eye, forward } = fixture(t);
  t.mock.method(wildlife, "raycast", () =>
    assert.fail("invalid query reached model picking")
  );
  for (const reach of [-1, NaN, Infinity, 5.01]) {
    assert.equal(raycastMelee(wildlife, world, eye, forward, reach), null);
  }
  for (const direction of [
    { x: 0, y: 0, z: 0 },
    { x: NaN, y: 0, z: 1 },
    { x: Number.MAX_VALUE, y: Number.MAX_VALUE, z: Number.MAX_VALUE },
  ])
    assert.equal(raycastMelee(wildlife, world, eye, direction, 3), null);
  assert.equal(
    raycastMelee(wildlife, world, { ...eye, y: NaN }, forward, 3),
    null
  );
  const entities = wildlife.entities;
  wildlife.entities = Array(MAX_MOBS + 1).fill(entities[0]);
  assert.equal(raycastMelee(wildlife, world, eye, forward, 3), null);
  wildlife.entities = entities;
});
