import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { BOAT_DRAFT } from "../src/boat-definitions.js";
import { Boats } from "../src/boats.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { Fishing } from "../src/fishing.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";

/** Authored scalar water/geometry fixture; never natural-world visual proof. */
export function aquaticWorld({
  seed = "vehicle-fishing-fixture",
  generatorVersion = 4,
  dimension = "overworld",
  floor = 3,
  waterTop = 8,
  coordinator = new TransactionCoordinator(),
} = {}) {
  const context = createWorldContext({ seed, generatorVersion });
  return {
    ...context,
    context,
    coordinator,
    dimension,
    epoch: 1,
    floor,
    waterTop,
    cells: new Map(),
    loaded: () => true,
    reads: 0,
    get spec() {
      return context.specForDimension(this.dimension);
    },
    get surface() {
      return this.waterTop + 0.88;
    },
    isLoaded(x, z) {
      return this.loaded(x, z);
    },
    getCell(x, y, z) {
      this.reads++;
      if (!this.isLoaded(x, z) || y < this.spec.minY || y >= this.spec.maxY)
        return null;
      const stored = this.cells.get(`${this.dimension}:${x},${y},${z}`);
      return stored
        ? { ...stored }
        : normalizeCell({
            id:
              y <= this.floor
                ? BLOCK.STONE
                : y <= this.waterTop
                  ? BLOCK.WATER
                  : BLOCK.AIR,
          });
    },
    get(x, y, z) {
      return this.getCell(x, y, z)?.id ?? BLOCK.AIR;
    },
    setCell(x, y, z, cell) {
      this.cells.set(`${this.dimension}:${x},${y},${z}`, normalizeCell(cell));
    },
    ensureChunk() {
      throw new Error("Aquatic physics must not generate chunks");
    },
  };
}

export function physicsBoat(world, overrides = {}) {
  return {
    id: 1,
    wood: "oak",
    dimension: world.dimension,
    x: 0.5,
    y: world.surface - BOAT_DRAFT,
    z: 0.5,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    turnVelocity: 0,
    submergedTime: 0,
    bubbleTime: 0,
    bubbleDirection: 0,
    paddlePhase: 0,
    passengers: [null, null],
    ...overrides,
  };
}

export function physicsBobber(world, overrides = {}) {
  return {
    id: 1,
    ownerId: "player",
    dimension: world.dimension,
    x: 0.5,
    y: world.surface - 0.035,
    z: 0.5,
    vx: 0,
    vy: 0,
    vz: 0,
    phase: "waiting",
    remaining: 100,
    total: 100,
    flightTicks: 0,
    randomState: 7,
    openWater: true,
    accumulator: 0,
    approachAngle: 0,
    lure: 0,
    luck: 0,
    ...overrides,
  };
}

/** No invented numeric IDs or test-only production registry. Parent adds real names. */
export function requiredAquaticItem(name) {
  const item = getItem(ITEM[name]);
  assert.ok(
    item,
    `Parent checkpoint must register real ${name} before these tests run`
  );
  return item;
}

export function aquaticOwners(
  t,
  { world = aquaticWorld(), overflowEntries, scene = new THREE.Scene() } = {}
) {
  const coordinator = world.coordinator;
  const gameplay = new Gameplay({ coordinator, context: world.context });
  const overflow = new DropOverflow({
    coordinator,
    context: world.context,
    ...(overflowEntries ? { maxEntries: overflowEntries } : {}),
  });
  const experience = new ExperienceOrbs(scene, world, {
    coordinator,
    context: world.context,
    prepareCollect: (amount) => gameplay.prepareExperience(amount),
  });
  const actors = new Map([
    [
      "player",
      {
        position: { x: 0.5, y: world.surface + 0.2, z: 3.5 },
        direction: { x: 0, y: -0.2, z: -1 },
      },
    ],
  ]);
  const events = [];
  const systems = [];
  const hooks = {
    coordinator,
    context: world.context,
    readOwner(ownerId, hand = "main") {
      const actor = actors.get(ownerId);
      if (!actor) return null;
      return {
        position: { ...actor.position },
        dimension: actor.dimension ?? world.dimension,
        eye: { ...actor.position, y: actor.position.y + 1.62 },
        direction: actor.direction ?? { x: 0, y: 0, z: -1 },
        dead: actor.dead ?? gameplay.dead,
        stack: gameplay.getHandStack(hand),
        handRevision: gameplay.getHandRevision(hand),
        slotKey:
          hand === "main" ? `inventory:${gameplay.selected}` : "offhand:0",
      };
    },
    prepareHandCost({ hand, stack, handRevision, count = 0, wear = 0 }) {
      return gameplay.prepareHandCost(hand, {
        stack,
        handRevision,
        count,
        wear,
      });
    },
    prepareDrops({ stacks, position, dimension, velocity, pickupDelay }) {
      return overflow.prepareEnqueue(stacks, position, dimension, {
        velocity,
        pickupDelay,
      });
    },
    prepareExperience({ amount, position, dimension, velocity, pickupDelay }) {
      return dimension === world.dimension
        ? experience.prepareSpawn(amount, position, { velocity, pickupDelay })
        : null;
    },
    onEvent(event) {
      events.push(event);
      const actor = actors.get(event.ownerId);
      if (actor && event.type === "mount")
        actor.position = { ...event.position };
      if (actor && event.type === "dismount")
        actor.position = { ...event.exit.position };
    },
  };
  t.after(() => {
    for (const system of systems) system.dispose();
    experience.dispose();
    overflow.dispose();
    gameplay.dispose();
  });
  return {
    world,
    coordinator,
    gameplay,
    overflow,
    experience,
    actors,
    events,
    hooks,
    scene,
    setHand(name, { durability, data, hand = "main" } = {}) {
      const item = requiredAquaticItem(name);
      const stack = {
        id: item.id,
        count: 1,
        ...(item.durability
          ? { durability: durability ?? item.durability }
          : {}),
        ...(data === undefined ? {} : { data }),
      };
      assert.equal(
        gameplay.inventoryTransaction((draft) => {
          if (hand === "main") draft.slots[gameplay.selected] = stack;
          else draft.offhand = stack;
          return true;
        }),
        true
      );
      return stack;
    },
    boats(options = {}) {
      const system = new Boats(scene, world, { ...hooks, ...options });
      systems.push(system);
      return system;
    },
    fishing(options = {}) {
      const system = new Fishing(scene, world, { ...hooks, ...options });
      systems.push(system);
      return system;
    },
    placement() {
      return { point: { x: 0.5, y: world.surface - 0.04, z: 0.5 } };
    },
  };
}

export function advanceFishingTo(fishing, phase, limit = 800) {
  for (let tick = 0; tick < limit; tick++) {
    const cast = fishing.getCast();
    assert.ok(cast, "cast must remain owned during physical progression");
    if (cast.phase === phase) return cast;
    fishing.update(0.05);
  }
  assert.fail(
    `Fishing did not reach ${phase} within its bounded phase durations`
  );
}

/** Authored save-window setup only, for isolated atomicity tests. */
export function savedHookFixture(fishing, world) {
  assert.equal(fishing.cast().ok, true);
  const snapshot = fishing.serialize();
  Object.assign(snapshot.casts[0], {
    x: 0.5,
    y: world.surface - 0.035,
    z: 0.5,
    vx: 0,
    vy: 0,
    vz: 0,
    phase: "hook",
    total: 30,
    remaining: 30,
    accumulator: 0,
    openWater: true,
  });
  assert.equal(fishing.load(snapshot), true);
  assert.equal(fishing.bindLoadedOwner().ok, true);
  return fishing.getCast();
}
