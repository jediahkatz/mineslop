import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import {
  createHeldItemView,
  disposeHeldItemView,
  requestHeldItemMining,
  selectHeldItem,
  updateHeldItemView,
  usesHeldSprite,
} from "../src/held-item.js";
import { ItemUse } from "../src/item-use.js";
import { ITEM, ITEMS } from "../src/items.js";

const closeTo = (actual, expected, epsilon = 1e-10) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
const xyz = (value) => [value.x, value.y, value.z];
const handPose = (view) => [
  ...xyz(view.hand.position), ...xyz(view.hand.rotation), ...xyz(view.hand.scale),
];
const renderPose = (view) => [
  ...handPose(view), ...xyz(view.itemMesh.rotation), ...xyz(view.itemMesh.scale),
];

function fixture(t, mainId = ITEM.WOOD_PICKAXE, offhandId = BLOCK.TORCH) {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
  const texture = new THREE.Texture();
  const textures = new Map(
    ITEMS.filter((item) => usesHeldSprite(item.id)).map((item) => [item.id, texture])
  );
  const atlas = { texture, uvFor: () => [0.1, 0.2, 0.4, 0.6] };
  const main = createHeldItemView(camera, atlas, textures);
  const offhand = createHeldItemView(camera, atlas, textures, true);
  const views = [main, offhand];
  let elapsed = 0;
  const tick = (dt, { moving = false, visible = true, use, at } = {}) => {
    elapsed = at ?? elapsed + dt;
    for (const view of views)
      updateHeldItemView(view, dt, elapsed, moving, visible, use);
  };
  const advance = (seconds, input, schedule = [1 / 60]) => {
    let remaining = seconds;
    let frame = 0;
    while (remaining > 1e-12) {
      const dt = Math.min(remaining, schedule[frame++ % schedule.length]);
      tick(dt, input);
      remaining -= dt;
    }
  };
  selectHeldItem(main, mainId);
  selectHeldItem(offhand, offhandId);
  // Isolate action edges from the separately tested selection pulse.
  tick(0, { visible: false });
  tick(0);
  t.after(() => {
    disposeHeldItemView(main);
    disposeHeldItemView(offhand);
    texture.dispose();
  });
  return { camera, texture, main, offhand, tick, advance };
}

for (const [kind, id] of [
  ["food", ITEM.APPLE], ["bow", ITEM.BOW], ["shield", ITEM.SHIELD],
]) {
  for (const hand of ["main", "offhand"]) {
    for (const ending of ["release", "cancel"]) {
      test(`${hand} ${kind}: smooth entry/${ending}, inactive hand and ItemUse unchanged`, (t) => {
        const fx = fixture(
          t, hand === "main" ? id : ITEM.WOOD_PICKAXE,
          hand === "offhand" ? id : BLOCK.TORCH
        );
        const active = fx[hand];
        const other = hand === "main" ? fx.offhand : fx.main;
        const idle = renderPose(active);
        const otherIdle = renderPose(other);
        const use = new ItemUse();
        assert.equal(use.start(kind, hand, id), true);
        fx.tick(0, { use });
        assert.deepEqual(renderPose(active), idle, "entry cannot teleport at zero dt");
        for (let frame = 0; frame < 30; frame++) {
          use.advance(1 / 60);
          const timing = use.snapshot();
          fx.tick(1 / 60, { use });
          assert.deepEqual(use.snapshot(), timing, "the renderer cannot advance gameplay use");
          assert.deepEqual(renderPose(other), otherIdle);
          if (frame === 0) {
            assert.ok(active.motion[kind].value > 0 && active.motion[kind].value < 0.06);
            assert.ok(active.hand.position.z < -0.81, "the first frame is not the held target");
          }
        }
        assert.ok(active.hand.position.z > -0.8, "active use reaches the held area");
        const held = renderPose(active);
        const result = use[ending]();
        if (ending === "release" && kind === "bow")
          assert.ok(result?.strength > 0, "visual smoothing does not prevent a charged release");
        const ended = use.snapshot();
        fx.tick(0, { use });
        assert.deepEqual(renderPose(active), held, "release/cancel cannot teleport at zero dt");
        fx.tick(1 / 60, { use });
        assert.ok(active.motion[kind].value > 0.94);
        assert.ok(active.hand.position.z > -0.82, "release/cancel eases instead of snapping");
        fx.advance(0.35, { use });
        assert.ok(active.motion[kind].value < 0.004);
        closeTo(active.hand.position.z, -0.82, 0.001);
        assert.deepEqual(renderPose(other), otherIdle);
        assert.deepEqual(use.snapshot(), ended);
      });
    }
  }
}

test("accepted mining explicitly renews the Effects-shaped main view, never the offhand", (t) => {
  const fx = fixture(t);
  // Mirrors Effects' Object.assign(createHeldItemView(...)) ownership.
  const effects = Object.assign({}, fx.main);
  const motion = effects.motion;
  const other = renderPose(fx.offhand);
  const pitches = new Set();
  for (let frame = 0; frame < 30; frame++) {
    requestHeldItemMining(effects);
    assert.equal(effects.motion, motion);
    fx.tick(0.1);
    pitches.add(fx.main.hand.rotation.x.toFixed(4));
    assert.equal(motion.miningActive, true);
    assert.equal(motion.miningRequested, false);
    assert.equal(fx.main.swing, 0, "sustained mining is not a swing top-up");
    assert.deepEqual(renderPose(fx.offhand), other);
  }
  assert.ok(pitches.size > 8);
  fx.advance(0.35);
  assert.equal(motion.miningActive, false);
  closeTo(fx.main.hand.rotation.x, 0.15, 0.003);
});

test("one-shot swing writes survive zero dt, are consumed once, and ease back", (t) => {
  const fx = fixture(t);
  const before = handPose(fx.main);
  fx.main.swing = 1;
  fx.tick(0);
  assert.equal(fx.main.swing, 1);
  assert.deepEqual(handPose(fx.main), before);
  fx.tick(1 / 60);
  assert.equal(fx.main.swing, 0);
  assert.ok(fx.main.hand.rotation.x < 0.15);
  assert.equal(fx.main.motion.miningActive, false);
  fx.advance(1);
  closeTo(fx.main.hand.rotation.x, 0.15, 0.00001);
});

for (const hand of ["main", "offhand"]) {
  test(`${hand} selection changes the asset immediately without a pose reset`, (t) => {
    const fx = fixture(t);
    const view = fx[hand];
    const other = hand === "main" ? fx.offhand : fx.main;
    const otherIdle = renderPose(other);
    for (const id of [BLOCK.STONE, ITEM.WOOD_PICKAXE, BLOCK.GLASS, ITEM.APPLE, ITEM.SHIELD]) {
      const before = handPose(view);
      selectHeldItem(view, id);
      assert.equal(view.itemId, id, "no delayed visual item identity");
      assert.deepEqual(handPose(view), before);
      fx.tick(0);
      assert.deepEqual(handPose(view), before);
      fx.tick(1 / 60);
      assert.ok(view.motion.equip.value > 0);
      const equip = { ...view.motion.equip };
      selectHeldItem(view, id);
      assert.deepEqual(view.motion.equip, equip, "same-id refresh must not retrigger");
      assert.deepEqual(renderPose(other), otherIdle);
    }
    fx.advance(1);
    closeTo(view.hand.rotation.x, 0.15, 0.00001);
    selectHeldItem(view, 0);
    fx.tick(0);
    assert.equal(view.hand.visible, hand === "main", "empty offhands stay hidden");
  });
}

for (const hand of ["main", "offhand"]) {
  test(`${hand} shield's recorded dt=0.1 entry does not jump to the blocking target`, (t) => {
    const fx = fixture(
      t, hand === "main" ? ITEM.SHIELD : 0,
      hand === "offhand" ? ITEM.SHIELD : 0
    );
    fx.camera.aspect = 1.5980024968789013;
    fx.tick(0);
    const view = fx[hand];
    const side = hand === "main" ? 1 : -1;
    const idle = view.hand.position.clone();
    closeTo(idle.x, side * 0.7641618838987075);
    closeTo(idle.y, -0.47190609760706065);
    const use = {
      active: true, kind: "shield", hand, itemId: ITEM.SHIELD, progress: 0.4,
    };
    fx.tick(0.1, { use });
    const targetX = side * 0.4414285593766603;
    assert.ok(Math.abs(view.hand.position.x - idle.x) > 0.01);
    assert.ok(
      Math.abs(view.hand.position.x - targetX) > Math.abs(idle.x - targetX) * 0.25,
      "the first 100ms sample must still have a visible transition remaining"
    );
    assert.ok(view.itemMesh.scale.x > 1.35 && view.itemMesh.scale.x < 1.6);
    assert.ok(view.hand.rotation.x > 0 && view.hand.rotation.x < 0.15);
  });
}

test("selection during use eases out the old pose without altering the use owner", (t) => {
  const fx = fixture(t, ITEM.BOW);
  const use = new ItemUse();
  use.start("bow", "main", ITEM.BOW);
  use.advance(0.25);
  fx.advance(0.4, { use });
  const held = handPose(fx.main);
  const owner = use.snapshot();
  selectHeldItem(fx.main, ITEM.APPLE);
  fx.tick(0, { use });
  assert.deepEqual(handPose(fx.main), held);
  fx.tick(1 / 60, { use });
  assert.ok(fx.main.motion.bow.value > 0.9);
  fx.advance(0.35, { use });
  assert.ok(fx.main.motion.bow.value < 0.004, "a stale item identity cannot hold the old pose");
  assert.deepEqual(use.snapshot(), owner, "only the caller may cancel gameplay use");
});

test("a completed food cycle does not reset the visual phase while use stays held", (t) => {
  const fx = fixture(t, ITEM.APPLE);
  const use = new ItemUse();
  use.start("food", "main", ITEM.APPLE);
  for (let i = 0; i < 96; i++) {
    use.advance(1 / 60);
    fx.tick(1 / 60, { use });
  }
  const before = renderPose(fx.main);
  const phase = fx.main.motion.foodPhase;
  assert.equal(use.completeFoodCycle(), true);
  fx.tick(0, { use });
  assert.deepEqual(renderPose(fx.main), before);
  assert.equal(fx.main.motion.foodPhase, phase);
  assert.equal(use.active, true);
});

test("animated poses reproject at the same screen anchor across FOV/aspect changes", (t) => {
  const fx = fixture(t, ITEM.SHIELD);
  const use = { active: true, kind: "shield", hand: "main", itemId: ITEM.SHIELD, progress: 0.4 };
  fx.tick(0.1, { use });
  const mainPose = { ...fx.main.motion.pose };
  fx.camera.position.set(3, 12, -8);
  fx.camera.rotation.set(-0.12, -4.933120000000302, 0);
  fx.camera.updateMatrixWorld(true);
  for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
    for (const fov of [60, 75, 90]) {
      fx.camera.fov = fov;
      fx.camera.aspect = aspect;
      fx.camera.updateProjectionMatrix();
      const cameraBefore = [
        ...xyz(fx.camera.position), ...xyz(fx.camera.rotation),
        ...fx.camera.quaternion.toArray(), ...fx.camera.matrixWorld.elements,
        ...fx.camera.projectionMatrix.elements,
      ];
      fx.tick(0, { use });
      assert.deepEqual(fx.main.motion.pose, mainPose, "projection is not a motion input");
      const tangent = Math.tan(fov * Math.PI / 360);
      for (const view of [fx.main, fx.offhand]) {
        const depth = -view.hand.position.z;
        closeTo(view.hand.position.x / (depth * tangent * aspect), view.motion.pose.x);
        closeTo(view.hand.position.y / (depth * tangent), view.motion.pose.y);
        closeTo(view.hand.scale.x / tangent, 0.85 / Math.tan(75 * Math.PI / 360));
      }
      assert.deepEqual([
        ...xyz(fx.camera.position), ...xyz(fx.camera.rotation),
        ...fx.camera.quaternion.toArray(), ...fx.camera.matrixWorld.elements,
        ...fx.camera.projectionMatrix.elements,
      ], cameraBefore, "hand motion must not move the camera or physical aim");
    }
  }
});

test("elapsed jumps and zero/invalid dt cannot move an existing visual pose", (t) => {
  const fx = fixture(t, ITEM.APPLE);
  const use = { active: true, kind: "food", hand: "main", progress: 0.5 };
  fx.advance(0.12, { moving: true, use });
  const before = renderPose(fx.main);
  const phase = fx.main.motion.walkPhase;
  for (const dt of [0, NaN, Infinity, -1]) {
    fx.tick(dt, { moving: true, use, at: 30 * 86400 });
    assert.deepEqual(renderPose(fx.main), before);
  }
  fx.tick(1 / 60, { moving: true, use, at: 0 });
  closeTo(fx.main.motion.walkPhase, phase + 11 / 60);
});

for (const gate of ["F1", "F5", "pause/resume"]) {
  test(`${gate} visibility contract discards hidden motion and resumes from idle`, (t) => {
    // These are caller-contract tests, not a claim of GUI key/menu coverage.
    const fx = fixture(t, ITEM.APPLE, ITEM.SHIELD);
    const initialMain = renderPose(fx.main);
    const initialOffhand = renderPose(fx.offhand);
    const use = new ItemUse();
    use.start("food", "main", ITEM.APPLE);
    fx.advance(0.3, { moving: true, use });
    requestHeldItemMining(fx.main);
    fx.main.swing = 1;
    for (let i = 0; i < 8; i++) {
      fx.tick(0.1, { moving: true, visible: false, use });
      assert.equal(fx.main.hand.visible, false);
      assert.equal(fx.offhand.hand.visible, false);
      assert.equal(fx.main.motion.miningRequested, false);
      assert.equal(fx.main.swing, 0);
      assert.deepEqual(renderPose(fx.main), initialMain);
      assert.deepEqual(renderPose(fx.offhand), initialOffhand);
    }
    use.cancel();
    fx.tick(0, { use, at: 86400 });
    assert.equal(fx.main.hand.visible, true);
    assert.equal(fx.offhand.hand.visible, true);
    assert.deepEqual(renderPose(fx.main), initialMain);
    assert.deepEqual(renderPose(fx.offhand), initialOffhand);
    fx.advance(0.2, { use });
    assert.deepEqual(renderPose(fx.main), initialMain, "no deferred hidden impulse");
    use.start("food", "main", ITEM.APPLE);
    fx.tick(1 / 60, { use });
    assert.ok(fx.main.motion.food.value > 0 && fx.main.motion.food.value < 0.06);
  });
}

test("reduced-motion preference is live, cached per view, and adds no listeners", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  let queries = 0;
  const preference = {
    matches: true,
    addEventListener: () => assert.fail("no per-view preference listener"),
    addListener: () => assert.fail("no legacy preference listener"),
  };
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (query) => {
      assert.equal(query, "(prefers-reduced-motion: reduce)");
      queries++;
      return preference;
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "matchMedia", descriptor);
    else delete globalThis.matchMedia;
  });
  const fx = fixture(t);
  const before = renderPose(fx.main);
  const motion = fx.main.motion;
  const channels = [...motion.channels];
  const pose = motion.pose;
  const geometry = fx.main.itemGeometry;
  const material = fx.main.itemMaterial;
  const texture = material.map;
  const uv = Array.from(fx.main.handGeometry.getAttribute("uv").array);
  selectHeldItem(fx.main, BLOCK.STONE);
  const selectedUV = Array.from(fx.main.handGeometry.getAttribute("uv").array);
  assert.notDeepEqual(selectedUV, uv);
  for (let i = 0; i < 240; i++) {
    requestHeldItemMining(fx.main);
    fx.main.swing = 1;
    fx.tick(1 / 60, { moving: true });
    assert.deepEqual(renderPose(fx.main), before);
    assert.equal(fx.main.motion, motion);
    assert.equal(motion.pose, pose);
    assert.equal(fx.main.itemGeometry, geometry);
    assert.equal(fx.main.itemMaterial, material);
    assert.equal(material.map, texture);
    for (let j = 0; j < channels.length; j++)
      assert.equal(motion.channels[j], channels[j]);
  }
  assert.deepEqual(Array.from(fx.main.handGeometry.getAttribute("uv").array), selectedUV);
  assert.equal(queries, 2, "no per-frame matchMedia allocation");
  preference.matches = false;
  fx.tick(1 / 60, { moving: true });
  assert.notDeepEqual(renderPose(fx.main), before, "cached matches reflects changed preferences");
  assert.equal(queries, 2);
});
