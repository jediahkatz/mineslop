import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { Gameplay } from "../src/gameplay.js";
import { Settlement } from "../src/settlement.js";
import { createWorldContext } from "../src/world-spec.js";
import { fluidFixture } from "./fluid-fixture.js";

export const fluidChannel = (from = 6, to = 12, y = 1, z = 8) =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, y, z, BLOCK.AIR]);

/** Authored cells + real World/FluidSystem/Overflow/coordinator, no GUI claims. */
export function fluidServicesFixture(
  t,
  {
    stage = true,
    activate = true,
    crops = [],
    saved = null,
    limits,
    allowOverBudget = false,
    maxEntries,
    ...worldOptions
  } = {}
) {
  const f = fluidFixture(t, {
    radius: 0,
    base: BLOCK.STONE,
    initial: fluidChannel(),
    ...worldOptions,
    connect: false,
  });
  f.fluids.dispose();
  const { world, put } = f;
  const context = createWorldContext(world),
    coordinator = world.coordinator;
  const gameplay = new Gameplay({ mode: "survival", coordinator, context });
  const overflow = new DropOverflow({ context, coordinator, maxEntries });
  const settlement = new Settlement({ context, coordinator });
  assert.equal(
    settlement.load(
      {
        version: 3,
        crops,
        chests: [],
        furnaces: [],
      },
      { context, world }
    ),
    true
  );
  const game = {
    world,
    gameplay,
    overflow,
    settlement,
    coordinator,
    worldContext: context,
    simulating: true,
    paused: false,
    building: false,
    failed: false,
  };
  const services = [];
  const fixture = {
    world,
    put,
    context,
    coordinator,
    gameplay,
    overflow,
    settlement,
    game,
    service: null,
    create(options = {}) {
      const service = new GameFluidServices({
        world,
        overflow,
        settlement,
        coordinator,
        context,
        saved,
        limits,
        allowOverBudget,
        ...options,
      });
      services.push(service);
      return service;
    },
    snapshot: () => ({
      world: world.serialize(),
      crops: settlement.serialize(),
      overflow: overflow.serialize(),
      gameplay: gameplay.serialize(),
    }),
    admission(cx = 0, cz = 0) {
      const chunk = world.chunks.get(`${cx},${cz}`);
      assert.ok(chunk, "admission fixture requires a real resident chunk");
      return Object.freeze({
        world,
        chunk,
        seed: world.seed,
        generatorVersion: world.generatorVersion,
        epoch: world.epoch,
        dimension: world.dimension,
        cx,
        cz,
        key: `${cx},${cz}`,
        incarnation: chunk.incarnation,
        revision: chunk.revision,
      });
    },
  };
  world.onMutation = (event) => fixture.service?.onMutation(world, event);
  world.onChunkAdmitted = (event) =>
    fixture.service?.onChunkLoaded(world, event);
  t.after(() => {
    for (const service of services) service.dispose();
    overflow.dispose();
    settlement.dispose();
    gameplay.dispose();
  });
  if (stage) {
    fixture.service = fixture.create();
    if (activate) assert.equal(fixture.service.activate(game).ok, true);
  }
  return fixture;
}

export function serviceSteps(service, count, dt = 0.25) {
  assert.ok(Number.isInteger(count) && count >= 0 && count <= 2048);
  for (let i = 0; i < count; i++)
    assert.equal(service.frame(dt, { simulating: true }).ok, true);
}
