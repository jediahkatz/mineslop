import assert from "node:assert/strict";
import { normalizeCell } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { PlayerProjectiles } from "../src/player-projectiles.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";

const key = (x, y, z) => `${x},${y},${z}`;
const chunkKey = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;

// Authored cells/parent bridges, not a generator, browser test or natural-play
// claim. A real Gameplay supplies held-stack ownership and shared reservations.
export function pearlWorld({
  generatorVersion = 4,
  dimension = "overworld",
} = {}) {
  const context = createWorldContext({
    seed: "pearl-contract-fixture",
    generatorVersion,
  });
  const chunks = new Map();
  const cells = new Map();
  let incarnation = 0;
  const world = {
    seed: context.seed,
    generatorVersion,
    dimension,
    context,
    coordinator: new TransactionCoordinator(),
    epoch: 1,
    chunks,
    cells,
    reads: 0,
    get spec() {
      return context.specForDimension(this.dimension);
    },
    admit(cx, cz) {
      const column = { cx, cz, incarnation: ++incarnation, revision: 0 };
      chunks.set(`${cx},${cz}`, column);
      return column;
    },
    isLoaded(x, z) {
      return chunks.has(chunkKey(x, z));
    },
    getCell(x, y, z) {
      this.reads++;
      assert.ok(
        y >= this.spec.minY && y < this.spec.maxY,
        "no out-of-build cell reads"
      );
      if (!this.isLoaded(x, z)) return null;
      return {
        ...(cells.get(key(x, y, z)) ?? normalizeCell({ id: BLOCK.AIR })),
      };
    },
    put(x, y, z, id, state = 0, fluid) {
      cells.set(key(x, y, z), normalizeCell({ id, state, fluid }));
      const column = chunks.get(chunkKey(x, z));
      assert.ok(column, "author the loaded column first");
      column.revision++;
    },
    get() {
      throw new Error("Pearls must use non-generating getCell, not get");
    },
    ensureChunk() {
      throw new Error("No implicit pearl terrain generation");
    },
    ensureArea() {
      throw new Error("No implicit pearl terrain generation");
    },
    getSpawn() {
      throw new Error("No platform/landing fallback");
    },
    set() {
      throw new Error("Pearls may not edit the terrain");
    },
  };
  for (let cz = -2; cz <= 3; cz++)
    for (let cx = -2; cx <= 3; cx++) world.admit(cx, cz);
  return world;
}

export function pearlRecord(overrides = {}) {
  return {
    id: 1,
    kind: "ender_pearl",
    ownerId: "local-player",
    life: 0,
    dimension: "overworld",
    position: { x: 4.5, y: 20, z: 4.5 },
    velocity: { x: 30, y: 0, z: 0 },
    age: 0,
    wait: 0,
    spin: 1729,
    ...overrides,
  };
}

export function pearlSnapshot(
  context,
  records = [pearlRecord()],
  overrides = {}
) {
  return {
    version: 1,
    seed: String(context.seed),
    generatorVersion: context.generatorVersion,
    ownerId: "local-player",
    life: 0,
    cooldown: 0,
    randomState: 42,
    nextId: Math.max(0, ...records.map(({ id }) => id)) + 1,
    accumulator: 0,
    projectiles: records,
    ...overrides,
  };
}

export function pearlFixture(t, options = {}) {
  const world = pearlWorld(options);
  const { context, coordinator } = world;
  const game = new Gameplay({
    coordinator,
    context,
    mode: options.mode ?? "survival",
  });
  assert.equal(
    game.inventoryTransaction((owned) => {
      owned.slots.fill(null);
      owned.slots[0] = {
        id: ITEM.ENDER_PEARL,
        count: 16,
        data: { version: 1, name: "Survey pearls" },
      };
      owned.offhand = { id: ITEM.ENDER_PEARL, count: 16 };
      return true;
    }),
    true
  );
  if (game.mode === "creative")
    assert.equal(game.assignSlot(0, ITEM.ENDER_PEARL), true);
  const player = {
    position: { x: 4.5, y: 20, z: 4.5 },
    eye: { x: 4.5, y: 21.62, z: 4.5 },
    forward: { x: 1, y: 0, z: 0 },
    velocity: { x: 1, y: -2, z: 3 },
    fallDistance: 18,
    radius: 0.3,
    height: 1.8,
    grounded: false,
    jumpQueued: true,
  };
  const owner = {
    ref: player,
    world,
    life: 0,
    poseRevision: 0,
    available: true,
  };
  assert.equal(coordinator.register(player, 0), true);
  const events = [];
  const impacts = [];
  const tickets = [];
  const prepareImpact = (request) => {
    impacts.push(request);
    const revision = owner.poseRevision;
    const nextPosition = { ...request.position };
    const nextEye = {
      ...nextPosition,
      y: nextPosition.y + player.height * 0.9,
    };
    const nextVelocity = { ...request.velocity };
    const pose = {
      owner: player,
      beforeBytes: 0,
      afterBytes: 0,
      validate: () =>
        owner.poseRevision === revision &&
        owner.ref === request.ownerRef &&
        owner.world === request.world &&
        owner.life === request.life &&
        !game.dead,
      publish() {
        player.position = nextPosition;
        player.eye = nextEye;
        player.velocity = nextVelocity;
        player.fallDistance = request.fallDistance;
        player.grounded = false;
        player.jumpQueued = false;
        owner.poseRevision = revision + 1;
      },
    };
    // Contract fixture only: production must add this prepared damage bridge.
    const damage = game._prepareState((state) => {
      assert.equal(request.damage.bypassArmor, true);
      assert.equal(request.damage.bypassShield, true);
      if (!(request.damage.creativeImmune && game.mode === "creative")) {
        state.health = Math.max(0, state.health - request.damage.amount);
        state.timers.regen = 0;
        if (!state.health) {
          state.dead = true;
          state.deathCause = request.damage.cause;
        }
      }
      return true;
    });
    return { pose, damage };
  };
  const pearls = new PlayerProjectiles(world, {
    context,
    coordinator,
    ownerId: "local-player",
    staged: options.staged ?? false,
    getOwner: (id) =>
      !owner.available
        ? null
        : {
            id,
            life: owner.life,
            ref: owner.ref,
            world: owner.world,
            dimension: owner.world.dimension,
            alive: !game.dead,
            mode: game.mode,
            position: player.position,
            eye: player.eye,
            forward: player.forward,
            radius: player.radius,
            height: player.height,
          },
    prepareHeldCost: ({ hand, stack, handRevision, count }) =>
      game.prepareHandCost(hand, { stack, handRevision, count }),
    prepareImpact,
    onEvent: (event) => events.push(event),
    requestChunks: (request) => tickets.push(request),
  });
  const shot = (hand = "main") => ({
    hand,
    stack: game.getHandStack(hand),
    handRevision: game.getHandRevision(hand),
  });
  const stage = (records, overrides) => {
    assert.equal(pearls.load(pearlSnapshot(context, records, overrides)), true);
  };
  t.after(() => {
    pearls.dispose();
    game.dispose();
    coordinator.release(player);
  });
  return {
    world,
    context,
    coordinator,
    game,
    player,
    owner,
    pearls,
    shot,
    stage,
    events,
    impacts,
    tickets,
    prepareImpact,
  };
}

export function floorImpact(fixture, overrides = {}) {
  fixture.world.put(4, 0, 4, BLOCK.STONE);
  const record = pearlRecord({
    dimension: fixture.world.dimension,
    position: { x: 4.5, y: 2, z: 4.5 },
    velocity: { x: 0, y: -30, z: 0 },
    ...overrides,
  });
  fixture.stage([record]);
  return record;
}
