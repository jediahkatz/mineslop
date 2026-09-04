import assert from "node:assert/strict";
import { BIOMES } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { Player, PLAYER_FLUID_PHYSICS } from "../src/player.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { gameMobFixture, gameMobGenerator, point } from "./game-mob-integration-fixture.js";

export const SWIM_START = Object.freeze({ x: 8.5, y: 67, z: 12.5 });

// Authored ocean volume, not a natural-distribution/acquisition claim. All
// admitted cells, feeding transactions, lifecycle owners and Game frames are real.
function oceanGenerator(...args) {
  const generator = gameMobGenerator(...args);
  return {
    ...generator,
    getSpawn: () => ({ x: 1.5, y: 73, z: 1.5 }),
    generateChunk(cx, cz) {
      const chunk = generator.generateChunk(cx, cz);
      chunk.blocks.fill(BLOCK.WATER, (65 - chunk.minY) * 256, (73 - chunk.minY) * 256);
      chunk.biomes.fill(BIOMES.findIndex((biome) => biome.id === "ocean"));
      // Finite dry spawn island for the actual death/respawn lifecycle.
      if (cx === 0 && cz === 0)
        for (let y = 65; y <= 72; y++)
          for (let x = 0; x <= 2; x++)
            for (let z = 0; z <= 2; z++)
              chunk.blocks[(y - chunk.minY) * 256 + z * 16 + x] = BLOCK.SAND;
      return chunk;
    },
  };
}

export async function dolphinSwimFixture(t) {
  const f = await gameMobFixture(t, {
    generatorVersion: 4, generatorFactory: oceanGenerator, spawnPosition: SWIM_START,
  });
  const plan = f.ecology.prepareAdmission("dolphin", { x: 8.5, y: 67, z: 10.5 });
  assert.ok(plan, "admit a real dolphin into the loaded ocean body");
  assert.equal(f.ecology.commit(plan).ok, true);
  const dolphin = f.wildlife.byId.get(plan.result.id);
  const updates = [];
  const originalUpdate = Player.prototype.update;
  t.mock.method(f.player, "update", function (dt, options) {
    const before = point(this.position);
    const result = originalUpdate.call(this, dt, options);
    updates.push({ dt, options, before, after: point(this.position) });
    const diagnostics = this.fluidDiagnostics();
    assert.ok(diagnostics.queries <= PLAYER_FLUID_PHYSICS.maxQueriesPerUpdate);
    assert.ok(diagnostics.cells <= diagnostics.queries * PLAYER_FLUID_PHYSICS.maxBodyCellsPerQuery);
    return result;
  });
  return Object.assign(f, {
    dolphin,
    updates,
    frameMs(ms = 50) {
      const count = updates.length;
      f.withGlobals(() => f.game.frame(f.game.lastFrame + ms));
      return updates.length > count ? updates.at(-1) : null;
    },
    feed() {
      f.hold("RAW_COD");
      f.aim(dolphin);
      const fed = f.game.mobActions.interact(dolphin);
      assert.equal(fed.ok, true, fed.reason);
      assert.equal(f.gameplay.getHandStack(), null, "real feeding consumes the fish");
      this.frameMs();
      assert.equal(f.ecology.modifiers().swimSpeedMultiplier, 1.6);
      assert.equal(f.game.ecologyModifiers.swimSpeedMultiplier, 1.6);
    },
    swimStart() {
      f.player.setPosition(SWIM_START);
      f.player.yaw = 0;
      f.player.pitch = 0;
      f.key("KeyW", false);
      f.key("KeyW");
    },
  });
}

// A second real Player supplies a neutral-physics reference from the exact
// current velocity/pose. This deliberately preserves ordinary inertia when
// assistance disappears; no reset can hide a retained modifier.
export function neutralNextStep(t, f, dt) {
  const reference = controlFixture(t);
  const source = f.player, player = reference.player;
  player.world = source.world;
  player.allowFlight = source.allowFlight;
  player.flying = source.flying;
  player.setPosition(source.position);
  player.velocity.copy(source.velocity);
  player.grounded = source.grounded;
  player.yaw = source.yaw;
  player.pitch = source.pitch;
  player.canSprint = source.canSprint;
  for (const code of source.vehicleKeys ?? [])
    dispatch(reference.document, "keydown", { code, timeStamp: 1000 });
  player.update(dt, { recoverFromVoid: false });
  return { position: point(player.position), velocity: point(player.velocity) };
}

export function closePoint(actual, expected) {
  for (const axis of ["x", "y", "z"])
    assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-9,
      `${axis}: ${actual[axis]} != ${expected[axis]}`);
}
