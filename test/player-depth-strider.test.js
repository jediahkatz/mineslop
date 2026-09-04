import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { waterMovement } from "../src/enchantment-effects.js";
import { armorItemId } from "../src/gear-content.js";
import { collidesWithWorld } from "../src/player.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { closePoint } from "./dolphin-swim-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";
import { shapeWorld } from "./shape-fixture.js";

const options = (level) => ({
  waterMovement: (onGround) => waterMovement(progressionStack(
    armorItemId("diamond", "feet"), 1,
    level ? { enchantments: { depth_strider: level } } : undefined,
  ), { onGround }),
});

function swimmer(t, { fluid = FLUID.WATER_SOURCE, land = false, y = 2 } = {}) {
  const f = controlFixture(t), cells = [];
  for (let x = -3; x <= 3; x++)
    for (let z = -3; z <= 3; z++)
      for (let h = 0; h <= (land ? 0 : 6); h++)
        cells.push([x, h, z, h === 0 ? BLOCK.STONE :
          fluid === FLUID.LAVA_SOURCE ? BLOCK.LAVA : BLOCK.WATER,
          0, h === 0 ? FLUID.NONE : fluid]);
  f.player.world = shapeWorld(cells);
  f.player.allowFlight = false;
  f.player.setPosition({ x: 0.5, y, z: 0.5 });
  f.press = (code) => dispatch(f.document, "keydown", { code, timeStamp: 1000 });
  return f;
}

test("unenchant callback preserves exact existing Player position and velocity", (t) => {
  const plain = swimmer(t), neutral = swimmer(t);
  for (const f of [plain, neutral]) f.press("KeyW");
  for (const dt of [0.013, 0.05, 0.1, 0.008]) {
    plain.player.update(dt);
    neutral.player.update(dt, options(0));
    assert.deepEqual(neutral.player.position, plain.player.position);
    assert.deepEqual(neutral.player.velocity, plain.player.velocity);
  }
});

test("grounded water uses full interpolation; airborne uses exactly half, levels 1–3", (t) => {
  for (const level of [1, 2, 3]) {
    const ground = swimmer(t, { y: 1 }), air = swimmer(t);
    ground.player.grounded = true;
    for (const f of [ground, air]) f.press("KeyW");
    for (const [f, onGround] of [[ground, true], [air, false]]) {
      const { drag, acceleration } = options(level).waterMovement(onGround);
      const rate = 18 * Math.log(drag) / Math.log(0.8);
      const target = 4.317 * 0.5 * (acceleration / 0.02) / (rate / 18);
      f.player.update(1 / 120, options(level));
      assert.ok(Math.abs(f.player.velocity.z + target * (1 - Math.exp(-rate / 120))) < 1e-12);
    }
    assert.ok(-ground.player.velocity.z > -air.player.velocity.z);
  }
});

for (const kind of ["land", "lava", "flight", "ladder", "unknown"]) {
  test(`Depth Strider is neutral on ${kind}`, (t) => {
    const plain = swimmer(t, { land: kind === "land", fluid: kind === "lava" ? FLUID.LAVA_SOURCE : FLUID.WATER_SOURCE });
    const enchanted = swimmer(t, { land: kind === "land", fluid: kind === "lava" ? FLUID.LAVA_SOURCE : FLUID.WATER_SOURCE });
    for (const f of [plain, enchanted]) {
      if (kind === "flight") { f.player.allowFlight = true; f.player.flying = true; }
      if (kind === "ladder") {
        f.player.world.put(0, 2, 0, BLOCK.LADDER);
        f.player.world.put(0, 3, 0, BLOCK.LADDER);
        f.player.world.put(0, 2, 1, BLOCK.STONE);
        f.player.world.put(0, 3, 1, BLOCK.STONE);
        f.player.setPosition({ x: 0.5, y: 2, z: 0.65 });
      }
      if (kind === "unknown") f.player.world.isLoaded = () => false;
      f.press("KeyW");
    }
    plain.player.update(0.1);
    enchanted.player.update(0.1, options(3));
    closePoint(enchanted.player.position, plain.player.position);
    closePoint(enchanted.player.velocity, plain.player.velocity);
  });
}

for (const fluid of [FLUID.WATER_SOURCE, FLUID.WATER_FALLING, FLUID.BUBBLE_UP, FLUID.BUBBLE_DOWN]) {
  test(`Depth Strider leaves vertical current/bubble/ascent unchanged, fluid=${fluid}`, (t) => {
    const plain = swimmer(t, { fluid }), enchanted = swimmer(t, { fluid });
    for (const f of [plain, enchanted]) { f.press("KeyW"); f.press("Space"); }
    plain.player.update(0.1);
    enchanted.player.update(0.1, options(3));
    assert.equal(enchanted.player.position.y, plain.player.position.y);
    assert.equal(enchanted.player.velocity.y, plain.player.velocity.y);
    assert.ok(enchanted.player.position.z < plain.player.position.z);
  });
}

test("water exit is rechecked per substep, and the next dry update retains no modifier", (t) => {
  const whole = swimmer(t, { y: 6.84 }), split = swimmer(t, { y: 6.84 });
  for (const f of [whole, split]) {
    f.player.velocity.y = 3.4; f.press("KeyW"); f.press("Space");
  }
  whole.player.update(0.1, options(3));
  for (let i = 0; i < 12; i++) split.player.update(1 / 120, options(3));
  closePoint(whole.player.position, split.player.position);
  closePoint(whole.player.velocity, split.player.velocity);
  assert.equal(whole.player.fluidState.waterImmersion, 0);
  whole.player.update(0.05, options(3));
  split.player.update(0.05);
  closePoint(whole.player.position, split.player.position);
});

test("lateral current acceleration is still applied to an idle enchanted swimmer", (t) => {
  const plain = controlFixture(t), enchanted = controlFixture(t);
  for (const f of [plain, enchanted]) {
    f.player.world = shapeWorld([
      [0, 0, 0, BLOCK.STONE], [-1, 1, 0, BLOCK.STONE],
      [0, 1, 0, BLOCK.WATER], [1, 1, 0, BLOCK.WATER, 0, FLUID.WATER_4],
      [2, 1, 0, BLOCK.WATER, 0, FLUID.WATER_7],
      ...[-1, 1].flatMap((z) => [-1, 0, 1, 2, 3].map((x) => [x, 1, z, BLOCK.STONE])),
    ]);
    f.player.allowFlight = false;
    f.player.setPosition({ x: 0.5, y: 1, z: 0.5 });
    assert.ok(f.player.fluidState.current.x > 0.9);
  }
  // No pre-existing velocity: the SAME physical current impulse, after drag.
  plain.player.update(1 / 120);
  enchanted.player.update(1 / 120, options(3));
  assert.ok(enchanted.player.position.x > 0.5);
  closePoint(enchanted.player.position, plain.player.position);
  closePoint(enchanted.player.velocity, plain.player.velocity);
});

test("enchanted water movement uses real collision sweeps without wall penetration", (t) => {
  const f = swimmer(t);
  for (let x = -3; x <= 3; x++)
    for (let y = 1; y <= 6; y++) f.player.world.put(x, y, -1, BLOCK.STONE);
  f.press("KeyW");
  for (let i = 0; i < 10; i++) f.player.update(0.1, options(3));
  assert.ok(f.player.position.z >= 0.3 - 1e-8);
  assert.equal(f.player.velocity.z, 0);
  assert.equal(collidesWithWorld(f.player.world, f.player.position), false);
});

for (const vehicleType of ["boat", "horse"]) {
  test(`${vehicleType} rider/exit handoffs and seated updates never consume Depth Strider`, (t) => {
    const f = swimmer(t);
    const noRead = { waterMovement() { assert.fail("vehicle cannot ask for water gear"); } };
    const pose = {
      position: { x: 0.5, y: 2, z: 0.5 }, velocity: { x: 0.2, y: 0.3, z: -0.4 },
      seated: true, grounded: false, vehicleType, dimension: "overworld",
    };
    assert.equal(f.player.update(0.1, { ...noRead, riderPose: pose }), true);
    f.player.update(0.1, noRead);
    closePoint(f.player.position, pose.position);
    const exit = { ...pose, seated: false };
    assert.equal(f.player.update(0, { ...noRead, exitPose: exit }), true);
    closePoint(f.player.velocity, pose.velocity);
  });
}
