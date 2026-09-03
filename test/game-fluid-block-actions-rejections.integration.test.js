import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  BLOCK_STATE as S,
  FLUID as F,
  normalizeCell,
} from "../src/block-state.js";
import {
  placeFluidBlock,
  prepareFluidBlockPlacement,
} from "../src/game-fluid-block-actions.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionInvariantError } from "../src/transactions.js";
import { raycast } from "../src/world.js";
import {
  aimAt,
  assertNoFeedback,
  CENTER,
  fluidBlockGame,
  named,
  recordCommits,
  setHand,
} from "./game-fluid-block-actions-fixture.js";

const sponge = (t, options = {}) =>
  fluidBlockGame(t, {
    id: BLOCK.SPONGE,
    initial: [
      [9, 1, 8, BLOCK.KELP],
      [9, 2, 8, BLOCK.LILY_PAD],
    ],
    ...options,
  });

test("all lateral-water levels refuse kelp without changing either owner", (t) => {
  for (let fluid = F.WATER_1; fluid <= F.WATER_7; fluid++) {
    const f = fluidBlockGame(t, {
      initial: [[8, 1, 8, { id: BLOCK.WATER, fluid }]],
    });
    const before = f.ownership();
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.KELP), false);
    assert.deepEqual(f.ownership(), before);
    assertNoFeedback(f);
  }
});

test("kelp support is decided by the real service, including magma and non-full support refusal", (t) => {
  for (const support of [
    BLOCK.AIR,
    BLOCK.MAGMA_BLOCK,
    { id: BLOCK.OAK_SLAB, state: 0 },
  ]) {
    const f = fluidBlockGame(t, {
      initial: [
        [8, 0, 8, support],
        [8, 1, 7, BLOCK.STONE],
      ],
    });
    const hit = aimAt(f, { x: 8.5, y: 1.5, z: 8 });
    assert.deepEqual([hit.x, hit.y, hit.z, hit.normal.z], [8, 1, 7, 1]);
    const before = f.ownership();
    assert.equal(
      prepareFluidBlockPlacement(f.game, "main", BLOCK.KELP).reason,
      "fluid-placement-refused"
    );
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.KELP), false);
    assert.deepEqual(f.ownership(), before);
    assertNoFeedback(f);
  }
});

test("unloaded destination and absorption frontier fail closed without requesting a chunk", (t) => {
  for (const missing of ["destination", "absorption-frontier"]) {
    const f = fluidBlockGame(
      t,
      missing === "destination"
        ? {}
        : {
            id: BLOCK.SPONGE,
            initial: Array.from({ length: 8 }, (_, i) => [
              9 + i,
              1,
              8,
              BLOCK.WATER,
            ]),
          }
    );
    if (missing === "destination") {
      const chunk = f.world.chunks.get("0,0");
      f.world._removeChunk("0,0", chunk);
    } else {
      // x=16 must be inside the seven-cell absorption range, not beyond it.
      aimAt(f, { x: 9.5, y: 1, z: 8.5 }, { x: 9.5, y: 1, z: 11.5 });
    }
    let generated = 0;
    const generate = f.world.generator.generateChunk.bind(f.world.generator);
    f.world.generator.generateChunk = (...args) => {
      generated++;
      return generate(...args);
    };
    const before = f.ownership();
    assert.equal(placeFluidBlock(f.game, f.hand, f.id), false);
    assert.equal(generated, 0);
    assert.deepEqual(f.ownership(), before);
    assertNoFeedback(f);
  }
});

test("unloaded cells beyond the sponge's declared range do not expand its required frontier", (t) => {
  const f = fluidBlockGame(t, {
    id: BLOCK.SPONGE,
    initial: Array.from({ length: 8 }, (_, i) => [9 + i, 1, 8, BLOCK.WATER]),
  });
  const chunks = f.world.chunks.size;
  assert.equal(f.world.getCell(16, 1, 8), null);
  assert.equal(placeFluidBlock(f.game, f.hand, f.id), true);
  assert.equal(f.gameplay.getHandStack(f.hand).count, 2);
  assert.equal(f.world.get(8, 1, 8), BLOCK.WET_SPONGE);
  assert.equal(f.world.get(15, 1, 8), BLOCK.AIR);
  assert.equal(f.world.getCell(16, 1, 8), null);
  assert.equal(f.world.chunks.size, chunks);
});

test("the collision geometry apron cannot treat an unloaded neighbor as known empty space", (t) => {
  const f = fluidBlockGame(t, {
    initial: [
      [15, 1, 8, BLOCK.WATER],
      [15, 0, 8, { id: BLOCK.OAK_STAIRS, state: S.TOP }],
    ],
  });
  const hit = aimAt(f, { x: 15.5, y: 1, z: 8.5 }, { x: 15.5, y: 1, z: 11.5 });
  assert.ok(hit);
  assert.equal(f.world.getCell(16, 1, 8), null);
  const before = f.ownership();
  assert.equal(placeFluidBlock(f.game, "main", BLOCK.KELP), false);
  assert.deepEqual(f.ownership(), before);
  assertNoFeedback(f);
});

test("click coordinates, cell state/fluid, normal and tagged source must match the real ray", (t) => {
  const mutations = [
    (hit) => ({ ...hit, x: hit.x + 1 }),
    (hit) => ({ ...hit, x: hit.x + 0.5 }),
    (hit) => ({ ...hit, id: BLOCK.DIRT }),
    (hit) => ({ ...hit, state: S.TOP }),
    (hit) => ({ ...hit, fluid: F.WATER_SOURCE }),
    (hit) => ({ ...hit, normal: { x: 1, y: 0, z: 0 } }),
    (hit) => ({ ...hit, normal: { x: 1, y: 1, z: 0 } }),
    (hit) => ({ ...hit, normal: { x: 0, y: NaN, z: 0 } }),
    (hit) => ({ ...hit, epoch: -1 }),
    (hit) => ({ ...hit, dimension: "nether" }),
    (hit) => ({ ...hit, world: {} }),
  ];
  const f = fluidBlockGame(t);
  const original = f.game.target;
  const before = f.ownership();
  for (const mutate of mutations) {
    f.game.target = mutate(original);
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.KELP), false);
    assert.deepEqual(f.ownership(), before);
    assertNoFeedback(f);
  }
});

test("occlusion and a closer F5 camera cannot authorize an out-of-reach physical click", (t) => {
  const occluded = fluidBlockGame(t);
  occluded.put(8, 2, 10, BLOCK.STONE);
  assert.notDeepEqual(
    raycast(
      occluded.world,
      occluded.player.eyePosition,
      occluded.player.forward,
      4.5
    ),
    occluded.game.target
  );
  const original = occluded.ownership();
  assert.equal(placeFluidBlock(occluded.game, "main", BLOCK.KELP), false);
  assert.deepEqual(occluded.ownership(), original);
  assertNoFeedback(occluded);

  const distant = fluidBlockGame(t);
  const hit = aimAt(
    distant,
    { x: 8.5, y: 1, z: 8.5 },
    { x: 8.5, y: 1, z: 14.5 },
    7
  );
  assert.ok(hit.distance > 5);
  distant.camera.position
    .copy(distant.player.eyePosition)
    .addScaledVector(distant.player.forward, 3);
  assert.ok(
    raycast(distant.world, distant.camera.position, distant.player.forward, 4.5)
  );
  const before = distant.ownership();
  assert.equal(placeFluidBlock(distant.game, "main", BLOCK.KELP), false);
  assert.deepEqual(distant.ownership(), before);
  assertNoFeedback(distant);
});

test("both dry and wet sponge proposals run actual player collision before any cost", (t) => {
  for (const initial of [[], [[9, 1, 8, BLOCK.KELP]]]) {
    const f = sponge(t, { initial });
    const hit = aimAt(f, { x: 8.5, y: 1, z: 8.5 }, { x: 8.5, y: 1, z: 8.5 });
    assert.deepEqual([hit.x, hit.y, hit.z, hit.normal.y], [8, 0, 8, 1]);
    assert.equal(
      f.player.intersectsPlacement([
        { ...CENTER, after: normalizeCell({ id: BLOCK.SPONGE }) },
      ]),
      true
    );
    const before = f.ownership();
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), false);
    assert.deepEqual(f.ownership(), before);
    assertNoFeedback(f);
  }
});

test("collision checks include resolved neighboring geometry, not just the sponge's cube", (t) => {
  const f = sponge(t, { initial: [[9, 1, 8, BLOCK.OAK_FENCE]] });
  const hit = aimAt(f, { x: 8.5, y: 1, z: 8.5 }, { x: 9.75, y: 1, z: 8.5 });
  assert.deepEqual([hit.x, hit.y, hit.z], [8, 0, 8]);
  assert.equal(f.player.intersectsBlock(8, 1, 8), false);
  assert.equal(
    f.player.intersectsPlacement([
      { ...CENTER, after: normalizeCell({ id: BLOCK.SPONGE }) },
    ]),
    true
  );
  const before = f.ownership();
  assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), false);
  assert.deepEqual(f.ownership(), before);
  assertNoFeedback(f);
});

test("missing real collision or sponge center proposal is an explicit gap, never a bypass", (t) => {
  const f = sponge(t);
  const before = f.ownership();
  const collision = f.player.intersectsPlacement;
  f.player.intersectsPlacement = undefined;
  assert.equal(
    prepareFluidBlockPlacement(f.game, "main", BLOCK.SPONGE).reason,
    "fluid-collision-unavailable"
  );
  f.player.intersectsPlacement = collision;
  const prepare = f.service.prepareSpongeAbsorption.bind(f.service);
  f.service.prepareSpongeAbsorption = (...args) => {
    const action = prepare(...args);
    assert.ok(action);
    const { spongeCell, ...result } = action.result;
    assert.ok(spongeCell);
    return { ...action, result };
  };
  assert.equal(
    prepareFluidBlockPlacement(f.game, "main", BLOCK.SPONGE).reason,
    "fluid-collision-proposal-unavailable"
  );
  assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), false);
  assert.deepEqual(f.ownership(), before);
  assertNoFeedback(f);
});

test("record capacity and shared-byte rejection preserve center, plants, hand and reservations", (t) => {
  for (const capacity of ["records", "bytes"]) {
    const f = sponge(t, { maxEntries: capacity === "records" ? 1 : undefined });
    const filler = {};
    if (capacity === "bytes")
      assert.equal(
        f.coordinator.register(
          filler,
          MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
        ),
        true
      );
    const before = f.ownership();
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), false);
    assert.deepEqual(f.ownership(), before);
    assertNoFeedback(f);
    if (capacity === "bytes") f.coordinator.release(filler);
  }
});

test("a real World, retention or held-cost veto rejects the entire shared transaction", (t) => {
  for (const owner of ["world", "overflow", "hand"]) {
    const f = sponge(t);
    const source =
      owner === "world"
        ? f.world
        : owner === "overflow"
          ? f.overflow
          : f.gameplay;
    const method =
      owner === "world"
        ? "prepareMutation"
        : owner === "overflow"
          ? "prepareAddBatch"
          : "prepareHandCost";
    const prepare = source[method].bind(source);
    source[method] = (...args) => {
      const participant = prepare(...args);
      assert.ok(participant);
      return { ...participant, validate: () => false };
    };
    const commits = recordCommits(f);
    const before = f.ownership();
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), false);
    assert.equal(commits.length, 1);
    assert.deepEqual(f.ownership(), before);
    assertNoFeedback(f);
  }
});

test("stale hand, owner, epoch, pose, ray and collision state cannot publish prepared ownership", (t) => {
  const cases = [
    ["same hand copy", (f) => setHand(f, "main", named(BLOCK.SPONGE))],
    [
      "decorated hand",
      (f) => setHand(f, "main", named(BLOCK.SPONGE, 3, "Replacement")),
    ],
    [
      "self-use count",
      (f) => assert.equal(f.gameplay.consumeHand("main", 1), true),
    ],
    ["selection", (f) => f.gameplay.select(1)],
    ["mode", (f) => f.gameplay.setMode("creative")],
    [
      "world",
      (f, other) => {
        f.game.world = other.world;
      },
    ],
    [
      "gameplay",
      (f, other) => {
        f.game.gameplay = other.gameplay;
      },
    ],
    [
      "player",
      (f, other) => {
        f.game.player = other.player;
      },
    ],
    [
      "player world",
      (f, other) => {
        f.player.world = other.world;
      },
    ],
    [
      "service",
      (f, other) => {
        f.game.fluidServices = other.service;
      },
    ],
    [
      "bound game",
      (f, other) => {
        f.service._game = other.game;
      },
    ],
    [
      "coordinator",
      (f, other) => {
        f.game.coordinator = other.coordinator;
      },
    ],
    [
      "fluid alias",
      (f, other) => {
        f.game.fluids = other.service.fluids;
      },
    ],
    ["epoch", (f) => f.world.setDimension("nether")],
    ["pose", (f) => f.player.setPosition({ x: 8.5, y: 1, z: 11.6 })],
    [
      "eye",
      (f) => {
        f.player.eyePosition.y += 0.01;
      },
    ],
    [
      "aim",
      (f) => {
        f.player.yaw += 0.01;
      },
    ],
    [
      "stance",
      (f) => {
        f.player.sneaking = true;
      },
    ],
    [
      "click",
      (f) => {
        f.game.target = { ...f.game.target, normal: { x: 1, y: 0, z: 0 } };
      },
    ],
    ["occluder", (f) => f.put(8, 2, 10, BLOCK.STONE)],
    [
      "collision",
      (f) => {
        f.player.position.set(8.5, 1, 8.5);
        assert.equal(
          f.player.intersectsPlacement([
            { ...CENTER, after: normalizeCell({ id: BLOCK.WET_SPONGE }) },
          ]),
          true
        );
      },
    ],
    [
      "paused",
      (f) => {
        f.game.paused = true;
      },
    ],
    [
      "inactive",
      (f) => {
        f.game.active = false;
      },
    ],
    [
      "mob target",
      (f) => {
        f.game.mobTarget = { distance: 1 };
      },
    ],
    [
      "collision channel",
      (f) => {
        f.player.intersectsPlacement = undefined;
      },
    ],
  ];
  const other = sponge(t);
  for (const [label, mutate] of cases) {
    const f = sponge(t);
    const action = prepareFluidBlockPlacement(f.game, "main", BLOCK.SPONGE);
    assert.ok(action?.participants, label);
    mutate(f, other);
    const before = f.ownership();
    const otherBefore = other.ownership();
    assert.equal(f.coordinator.commit(action.participants).ok, false, label);
    assert.deepEqual(f.ownership(), before, label);
    assert.deepEqual(other.ownership(), otherBefore, label);
    assertNoFeedback(f);
    // Restore the service's sole binding for the real fixture cleanup.
    if (label === "bound game") f.service._game = f.game;
  }
});

test("offhand replacement and Creative palette replacement veto the captured costs", (t) => {
  for (const mode of ["survival", "creative"])
    for (const hand of ["main", "offhand"]) {
      const f = sponge(t, { mode, hand });
      const action = prepareFluidBlockPlacement(f.game, hand, BLOCK.SPONGE);
      assert.ok(action?.participants);
      if (mode === "creative" && hand === "main") {
        assert.equal(f.gameplay.assignSlot(0, BLOCK.DIRT), true);
        assert.equal(f.gameplay.assignSlot(0, BLOCK.SPONGE), true);
      } else setHand(f, hand, named(BLOCK.SPONGE));
      const before = f.ownership();
      assert.equal(f.coordinator.commit(action.participants).ok, false);
      assert.deepEqual(f.ownership(), before);
    }
});

test("support changes and unload/readmission invalidate even value-identical prepared cells", (t) => {
  for (const stale of ["support", "incarnation"]) {
    const f = fluidBlockGame(t);
    const action = prepareFluidBlockPlacement(f.game, "main", BLOCK.KELP);
    assert.ok(action?.participants);
    if (stale === "support") f.put(8, 0, 8, BLOCK.MAGMA_BLOCK);
    else {
      const old = f.world.chunks.get("0,0");
      f.world._removeChunk("0,0", old);
      const current = f.world._generateSync(0, 0);
      assert.notEqual(current.incarnation, old.incarnation);
    }
    const before = f.ownership();
    assert.equal(f.coordinator.commit(action.participants).ok, false);
    assert.deepEqual(f.ownership(), before);
    assertNoFeedback(f);
  }
});

test("state changes during the service prepare are caught before the hand cost is prepared", (t) => {
  for (const change of ["hand", "world", "epoch", "pose", "ray", "click"]) {
    const f = sponge(t);
    const other = sponge(t);
    const prepare = f.service.prepareSpongeAbsorption.bind(f.service);
    let afterIntervention;
    f.service.prepareSpongeAbsorption = (...args) => {
      const action = prepare(...args);
      assert.ok(action);
      if (change === "hand") setHand(f, "main", named(BLOCK.SPONGE));
      if (change === "world") f.game.world = other.world;
      if (change === "epoch") f.world.setDimension("nether");
      if (change === "pose") f.player.position.x += 0.01;
      if (change === "ray") f.player.yaw += 0.01;
      if (change === "click") f.game.target.normal.x = 1;
      afterIntervention = f.ownership();
      return action;
    };
    let costs = 0;
    const prepareCost = f.gameplay.prepareHandCost.bind(f.gameplay);
    f.gameplay.prepareHandCost = (...args) => {
      costs++;
      return prepareCost(...args);
    };
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), false);
    assert.equal(costs, 0);
    assert.deepEqual(f.ownership(), afterIntervention);
    assertNoFeedback(f);
  }
});

test("a body move during hand preparation is checked before returning the proposal", (t) => {
  const f = sponge(t);
  const prepare = f.gameplay.prepareHandCost.bind(f.gameplay);
  f.gameplay.prepareHandCost = (...args) => {
    const cost = prepare(...args);
    f.player.position.set(8.5, 1, 8.5);
    return cost;
  };
  const before = f.ownership();
  const commits = recordCommits(f);
  assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), false);
  assert.equal(commits.length, 0);
  assert.deepEqual(f.ownership(), before);
  assertNoFeedback(f);
});

test("fatal publication invariants propagate, never masquerade as ordinary placement refusal", (t) => {
  const f = sponge(t);
  const prepare = f.world.prepareMutation.bind(f.world);
  f.world.prepareMutation = (...args) => {
    const participant = prepare(...args);
    return {
      ...participant,
      publish() {
        throw new Error("authored publication failure");
      },
    };
  };
  assert.throws(
    () => placeFluidBlock(f.game, "main", BLOCK.SPONGE),
    TransactionInvariantError
  );
  assertNoFeedback(f);
});
