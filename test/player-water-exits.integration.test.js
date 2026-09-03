import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCell } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { sampleFluidAtPoint } from "../src/fluid-sampling.js";
import {
  collidesWithWorld,
  PLAYER_FLUID_PHYSICS,
  PLAYER_HEIGHT,
} from "../src/player.js";
import { World } from "../src/world.js";
import { controlFixture, dispatch } from "./control-fixture.js";

const options = { timeout: 30000 };
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

// Real admission and cell transactions, followed by finite authored geometry.
// Static sources isolate Player physics; this is not a fluid-scheduler test.
async function swimmingFixture(t, variant) {
  const f = controlFixture(t);
  const world = new World("player-water-exits", {
    generatorVersion: 3,
    useWorker: false,
  });
  t.after(() => world.dispose());
  await world.ensureArea({ x: 8.5, y: 72.5, z: 9.7 }, 1);
  const frontier = variant === "frontier";
  const startX = frontier ? 21 : 3;
  const bank = ["bank", "raised-bank", "slab-bank", "low-slab-bank", "roof"]
    .includes(variant);
  const changes = [];
  for (let x = startX; x < startX + 11; x++)
    for (let z = 0; z <= 14; z++)
      for (let y = 67; y <= 80; y++) {
        let id = y === 67 ? BLOCK.STONE : y <= 72 ? BLOCK.WATER : BLOCK.AIR;
        if (bank && z <= 7) {
          if (y <= (variant === "raised-bank" ? 73 : 72)) id = BLOCK.STONE;
          if (variant === "slab-bank" && y === 73) id = BLOCK.OAK_SLAB;
          if (variant === "low-slab-bank" && y === 72) id = BLOCK.OAK_SLAB;
          if (variant === "roof" && y === 74) id = BLOCK.STONE;
        }
        if (variant === "ceiling" && y === 74) id = BLOCK.STONE;
        const before = world.getCell(x, y, z);
        const after = normalizeCell({ id });
        assert.ok(before, "only admitted cells may be authored");
        if (["id", "state", "fluid"].some((key) => before[key] !== after[key]))
          changes.push({ x, y, z, before, after });
      }
  assert.ok(changes.length <= 2310);
  if (changes.length) assert.equal(world.applyCells(changes), true);
  const start = { x: frontier ? 30.5 : 8.5, y: 72.5, z: 9.7 };
  const { surfaceY } = sampleFluidAtPoint(world, start);
  assert.ok(Number.isFinite(surfaceY));
  f.player.world = world;
  f.player.allowFlight = false;
  f.player.setPosition({ ...start, y: surfaceY - 1 });
  f.player.yaw = frontier ? -Math.PI / 2 : 0;
  return { ...f, world, surfaceY, ticks: 0 };
}

function advance(f, hz, seconds, keys) {
  for (const code of ["KeyW", "Space"])
    dispatch(f.document, keys.includes(code) ? "keydown" : "keyup", {
      code,
      repeat: false,
      timeStamp: 1000,
      target: f.element,
    });
  const chunks = f.world.chunks.size;
  let maxFeetY = f.player.position.y;
  let surfaced = false;
  for (let frame = 0; frame < hz * seconds; frame++) {
    assert.ok(++f.ticks <= 432, "each case has at most three simulated seconds");
    f.player.update(1 / hz, { recoverFromVoid: false });
    maxFeetY = Math.max(maxFeetY, f.player.position.y);
    surfaced ||= f.player.fluidState.waterImmersion === 0;
    assert.equal(collidesWithWorld(f.world, f.player.position), false);
    assert.equal(f.player.fluidMovementBlocked, false);
    assert.equal(f.player.flying, false);
    const stats = f.player.fluidDiagnostics();
    assert.ok(stats.queries <= PLAYER_FLUID_PHYSICS.maxQueriesPerUpdate);
    assert.ok(
      stats.cells <= stats.queries * PLAYER_FLUID_PHYSICS.maxBodyCellsPerQuery
    );
  }
  assert.equal(f.world.chunks.size, chunks, "swimming cannot admit more terrain");
  return { maxFeetY, surfaced };
}

for (const hz of [30, 60, 144]) {
  test(`held Space reaches the real open-water surface at ${hz} Hz`, options, async (t) => {
    const f = await swimmingFixture(t, "open");
    const result = advance(f, hz, 2, ["KeyW", "Space"]);
    assert.equal(result.surfaced, true);
    assert.ok(result.maxFeetY > f.surfaceY + 0.12);
    assert.equal(f.player.grounded, false);
    advance(f, hz, 1, []);
    assert.equal(f.player.grounded, false);
  });

  test(`W+Space clears an ordinary bank and lands on real support at ${hz} Hz`, options, async (t) => {
    const f = await swimmingFixture(t, "bank");
    advance(f, hz, 2, ["KeyW", "Space"]);
    assert.ok(f.player.position.z < 7.7, "the whole body must cross the bank");
    advance(f, hz, 1, []);
    close(f.player.position.y, 73);
    assert.equal(f.player.grounded, true);
    assert.equal(f.player.fluidState.waterImmersion, 0);
  });
}

test("W+Space exits onto a lower half-slab's exact support surface", options, async (t) => {
  const f = await swimmingFixture(t, "low-slab-bank");
  advance(f, 60, 2, ["KeyW", "Space"]);
  assert.ok(f.player.position.z < 7.7);
  advance(f, 60, 1, []);
  close(f.player.position.y, 72.5);
  assert.equal(f.player.grounded, true);
});

for (const variant of ["raised-bank", "slab-bank", "roof"]) {
  test(`swim ascent does not bypass the ${variant} collision control`, options, async (t) => {
    const f = await swimmingFixture(t, variant);
    const result = advance(f, 60, 2, ["KeyW", "Space"]);
    close(f.player.position.z, 8.3);
    assert.ok(result.maxFeetY < 73.5, "no unsupported full ground-jump impulse");
    advance(f, 60, 1, []);
    close(f.player.position.z, 8.3);
    assert.equal(f.player.grounded, false);
  });
}

test("a real ceiling clips held swim ascent without expanding the collider", options, async (t) => {
  const f = await swimmingFixture(t, "ceiling");
  const result = advance(f, 60, 2, ["KeyW", "Space"]);
  close(result.maxFeetY, 74 - PLAYER_HEIGHT);
  assert.equal(result.surfaced, false);
  assert.equal(f.player.grounded, false);
});

test("held swim ascent cannot cross or generate an unadmitted chunk frontier", options, async (t) => {
  const f = await swimmingFixture(t, "frontier");
  assert.equal(f.world.isLoaded(32, 9), false);
  advance(f, 60, 2, ["KeyW", "Space"]);
  close(f.player.position.x, 31.7);
  advance(f, 60, 1, []);
  close(f.player.position.x, 31.7);
  assert.equal(f.world.isLoaded(32, 9), false);
  assert.equal(f.player.grounded, false);
});
