import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  BLOCK_STATE as S,
  FLUID as F,
  normalizeCell,
} from "../src/block-state.js";
import {
  MAX_SPONGE_DISTANCE,
  MAX_SPONGE_WATER,
} from "../src/fluid-constants.js";
import {
  placeFluidBlock,
  prepareFluidBlockPlacement,
} from "../src/game-fluid-block-actions.js";
import {
  aimAt,
  assertNoFeedback,
  CENTER,
  fluidBlockGame,
  named,
  recordCommits,
  retainedCounts,
  setHand,
} from "./game-fluid-block-actions-fixture.js";

const feedback = (id) => [
  ["sound", "place", id],
  ["rebuild", 4],
  ["save"],
  ["target"],
  ["hud"],
];

for (const fluid of [F.WATER_SOURCE, F.WATER_FALLING])
  for (const mode of ["survival", "creative"])
    for (const hand of ["main", "offhand"])
      test(`kelp fluid=${fluid} ${mode}/${hand} uses one real held cost and one World proposal`, (t) => {
        const f = fluidBlockGame(t, {
          mode,
          hand,
          initial: [[8, 1, 8, { id: BLOCK.WATER, fluid }]],
        });
        const original = f.gameplay.getHandStack(hand);
        const slots = f.gameplay.slots;
        const other = f.gameplay.getHandStack(
          hand === "main" ? "offhand" : "main"
        );
        const revision = f.gameplay.getHandRevision(hand);
        const costs = [];
        const prepareCost = f.gameplay.prepareHandCost.bind(f.gameplay);
        f.gameplay.prepareHandCost = (...args) => {
          costs.push(args);
          return prepareCost(...args);
        };
        const worldProposals = [];
        const prepareWorld = f.world.prepareMutation.bind(f.world);
        f.world.prepareMutation = (...args) => {
          worldProposals.push(args);
          return prepareWorld(...args);
        };
        const commits = recordCommits(f);
        const observations = [];
        f.gameplay.onChange = () =>
          observations.push({
            cell: f.world.getCell(8, 1, 8),
            stack: f.gameplay.getHandStack(hand),
          });

        assert.equal(placeFluidBlock(f.game, hand, BLOCK.KELP), true);
        const remaining =
          mode === "creative"
            ? original
            : { ...original, count: original.count - 1 };
        assert.deepEqual(
          f.world.getCell(8, 1, 8),
          normalizeCell({ id: BLOCK.KELP })
        );
        assert.deepEqual(f.gameplay.getHandStack(hand), remaining);
        assert.deepEqual(
          f.gameplay.getHandStack(hand === "main" ? "offhand" : "main"),
          other
        );
        assert.deepEqual(f.gameplay.slots.slice(1), slots.slice(1));
        if (hand === "offhand" || mode === "creative")
          assert.deepEqual(
            f.gameplay.slots,
            slots,
            "virtual use never mints a finite copy"
          );
        assert.equal(f.gameplay.getHandRevision(hand), revision);
        assert.deepEqual(costs, [
          [hand, { count: 1, stack: original, handRevision: revision }],
        ]);
        assert.equal(worldProposals.length, 1);
        assert.equal(worldProposals[0][0].length, 1);
        assert.equal(commits.length, 1);
        assert.deepEqual(
          commits[0].map((p) => p.owner),
          [f.world, f.service, f.gameplay]
        );
        assert.deepEqual(observations, [
          { cell: normalizeCell({ id: BLOCK.KELP }), stack: remaining },
        ]);
        assert.equal(f.overflow.size, 0);
        assert.deepEqual(f.events, feedback(BLOCK.KELP));
        assert.equal(f.game.effects.swing, hand === "main" ? 1 : 0);
        assert.equal(f.game.effects.offhand.swing, hand === "offhand" ? 1 : 0);
      });

test("preparation is detached/immutable and one-time commit retains the exact named stack", (t) => {
  const f = fluidBlockGame(t);
  const before = f.ownership();
  const action = prepareFluidBlockPlacement(f.game, "main", BLOCK.KELP);
  assert.ok(action?.participants);
  assert.ok(Object.isFrozen(action));
  assert.ok(Object.isFrozen(action.participants));
  assert.ok(Object.isFrozen(action.result));
  assert.ok(action.participants.every(Object.isFrozen));
  assert.deepEqual(f.ownership(), before);
  assertNoFeedback(f);
  assert.equal(f.coordinator.commit(action.participants).ok, true);
  assert.deepEqual(f.gameplay.getHandStack(), named(BLOCK.KELP, 2));
  const published = f.ownership();
  assert.equal(f.coordinator.commit(action.participants).ok, false);
  assert.deepEqual(f.ownership(), published);
});

test("kelp can extend an existing kelp column through the service's support plan", (t) => {
  const f = fluidBlockGame(t, { initial: [[8, 0, 8, BLOCK.KELP]] });
  assert.deepEqual(
    [f.game.target.x, f.game.target.y, f.game.target.z],
    [8, 0, 8]
  );
  assert.equal(placeFluidBlock(f.game, "main", BLOCK.KELP), true);
  assert.equal(f.world.get(8, 0, 8), BLOCK.KELP);
  assert.equal(f.world.get(8, 1, 8), BLOCK.KELP);
});

test("the last finite main/offhand item pays once and cannot place again", (t) => {
  for (const id of [BLOCK.KELP, BLOCK.SPONGE])
    for (const hand of ["main", "offhand"]) {
      const f = fluidBlockGame(t, { id, hand });
      setHand(f, hand, named(id, 1));
      assert.equal(placeFluidBlock(f.game, hand, id), true);
      assert.equal(f.gameplay.getHandStack(hand), null);
      const after = f.ownership();
      assert.equal(placeFluidBlock(f.game, hand, id), false);
      assert.deepEqual(f.ownership(), after);
      assert.deepEqual(f.events, feedback(id));
    }
});

test("a side-face click places in that initial adjacent cell, not above the clicked wall", (t) => {
  const f = fluidBlockGame(t, { initial: [[8, 1, 7, BLOCK.STONE]] });
  const hit = aimAt(f, { x: 8.5, y: 1.5, z: 8 });
  assert.deepEqual([hit.x, hit.y, hit.z, hit.normal.z], [8, 1, 7, 1]);
  assert.equal(placeFluidBlock(f.game, "main", BLOCK.KELP), true);
  assert.equal(f.world.get(8, 1, 8), BLOCK.KELP);
  assert.equal(f.world.get(8, 1, 7), BLOCK.STONE);
  assert.equal(f.world.get(8, 2, 7), BLOCK.AIR);
});

for (const center of [BLOCK.AIR, BLOCK.WATER])
  test(`sponge with center=${center} uses the service's dry center, not a guessed wet state`, (t) => {
    const f = fluidBlockGame(t, {
      id: BLOCK.SPONGE,
      initial: [[8, 1, 8, center]],
    });
    let planned;
    const prepare = f.service.prepareSpongeAbsorption.bind(f.service);
    f.service.prepareSpongeAbsorption = (...args) => {
      assert.deepEqual(args, [CENTER, { place: true }]);
      planned = prepare(...args);
      return planned;
    };
    const commits = recordCommits(f);
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), true);
    assert.equal(planned.result.waterCells, 0);
    assert.deepEqual(f.world.getCell(8, 1, 8), planned.result.spongeCell);
    assert.equal(f.world.get(8, 1, 8), BLOCK.SPONGE);
    assert.deepEqual(f.gameplay.getHandStack(), named(BLOCK.SPONGE, 2));
    assert.equal(commits.length, 1);
    assert.equal(f.overflow.size, 0);
    assert.deepEqual(f.events, feedback(BLOCK.SPONGE));
  });

test("wet sponge center, aquatic removal and oriented waterlogged host drainage retain loot exactly once", (t) => {
  const host = {
    id: BLOCK.OAK_STAIRS,
    state: S.TOP | 2,
    fluid: F.WATER_SOURCE,
  };
  const f = fluidBlockGame(t, {
    id: BLOCK.SPONGE,
    hand: "offhand",
    initial: [
      [9, 1, 8, BLOCK.KELP],
      [9, 2, 8, BLOCK.LILY_PAD],
      [8, 1, 7, BLOCK.SEAGRASS],
      [7, 1, 8, host],
    ],
  });
  const inventory = f.gameplay.slots;
  const hit = f.game.target;
  const batches = [];
  const retain = f.overflow.prepareAddBatch.bind(f.overflow);
  f.overflow.prepareAddBatch = (...args) => {
    batches.push(args);
    return retain(...args);
  };
  const observed = [];
  f.overflow.onChange = () =>
    observed.push({
      center: f.world.getCell(8, 1, 8),
      hand: f.gameplay.getHandStack("offhand"),
    });
  const commits = recordCommits(f);

  assert.equal(placeFluidBlock(f.game, "offhand", BLOCK.SPONGE), true);
  assert.equal(commits.length, 1);
  assert.deepEqual(
    commits[0].map((p) => p.owner),
    [f.world, f.service, f.overflow, f.gameplay]
  );
  assert.deepEqual(
    f.world.getCell(8, 1, 8),
    normalizeCell({ id: BLOCK.WET_SPONGE })
  );
  assert.deepEqual(f.world.getCell(7, 1, 8), { ...host, fluid: F.NONE });
  for (const [x, y, z] of [
    [9, 1, 8],
    [9, 2, 8],
    [8, 1, 7],
  ])
    assert.equal(f.world.get(x, y, z), BLOCK.AIR);
  assert.equal(batches.length, 1);
  assert.deepEqual(
    retainedCounts(f),
    new Map([
      [BLOCK.KELP, 1],
      [BLOCK.LILY_PAD, 1],
    ])
  );
  assert.deepEqual(
    f.overflow
      .serialize()
      .entries.map(({ x, y, z, dimension }) => [x, y, z, dimension]),
    [
      [9, 1, 8, "overworld"],
      [9, 2, 8, "overworld"],
    ]
  );
  assert.deepEqual(
    f.gameplay.slots,
    inventory,
    "retained plants are not granted to inventory"
  );
  assert.deepEqual(f.gameplay.getHandStack("offhand"), named(BLOCK.SPONGE, 2));
  assert.deepEqual(observed, [
    {
      center: normalizeCell({ id: BLOCK.WET_SPONGE }),
      hand: named(BLOCK.SPONGE, 2),
    },
  ]);
  const after = f.ownership();
  assert.equal(f.coordinator.commit(commits[0]).ok, false);
  assert.equal(placeFluidBlock(f.game, "offhand", BLOCK.SPONGE, hit), false);
  assert.deepEqual(f.ownership(), after);
  assert.deepEqual(f.events, feedback(BLOCK.SPONGE));
  assert.equal(f.game.effects.offhand.swing, 1);
  assert.equal(f.game.effects.swing, 0);
});

for (const hand of ["main", "offhand"])
  test(`Creative ${hand} sponge absorption keeps existing no-cost semantics without granting plants`, (t) => {
    const f = fluidBlockGame(t, {
      id: BLOCK.SPONGE,
      hand,
      mode: "creative",
      initial: [[9, 1, 8, BLOCK.KELP]],
    });
    const inventory = f.gameplay.serialize();
    const commits = recordCommits(f);
    assert.equal(placeFluidBlock(f.game, hand, BLOCK.SPONGE), true);
    assert.equal(f.world.get(8, 1, 8), BLOCK.WET_SPONGE);
    assert.deepEqual(f.gameplay.serialize(), inventory);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].filter((p) => p.owner === f.gameplay).length, 1);
    assert.deepEqual(retainedCounts(f), new Map([[BLOCK.KELP, 1]]));
  });

test("a large authored reservoir absorbs only the finite connected budget with bounded reads", (t) => {
  const water = [];
  for (let x = 4; x <= 12; x++)
    for (let y = 1; y <= 4; y++)
      for (let z = 4; z <= 12; z++) water.push([x, y, z, BLOCK.WATER]);
  const f = fluidBlockGame(t, { id: BLOCK.SPONGE, initial: water });
  const get = f.world.getCell.bind(f.world);
  let reads = 0;
  f.world.getCell = (...args) => {
    reads++;
    return get(...args);
  };
  const action = prepareFluidBlockPlacement(f.game, "main", BLOCK.SPONGE);
  assert.ok(action?.participants);
  assert.equal(action.result.waterCells, MAX_SPONGE_WATER);
  assert.equal(action.result.limited, true);
  assert.equal(f.coordinator.commit(action.participants).ok, true);
  assert.ok(reads < 8192, `bounded action/validation read ${reads} cells`);
  f.world.getCell = get;
  const absorbed = water.filter(
    ([x, y, z]) =>
      !(x === CENTER.x && y === CENTER.y && z === CENTER.z) &&
      f.world.get(x, y, z) === BLOCK.AIR
  );
  assert.equal(absorbed.length, MAX_SPONGE_WATER);
  assert.ok(
    absorbed.every(
      ([x, y, z]) =>
        Math.abs(x - CENTER.x) +
          Math.abs(y - CENTER.y) +
          Math.abs(z - CENTER.z) <=
        MAX_SPONGE_DISTANCE
    )
  );
  assert.equal(f.world.get(8, 1, 8), BLOCK.WET_SPONGE);
  assert.ok(water.some(([x, y, z]) => f.world.get(x, y, z) === BLOCK.WATER));
  assert.deepEqual(f.gameplay.getHandStack(), named(BLOCK.SPONGE, 2));
});

test("absorption stops at taxicab reach and cannot cross a dry gap", (t) => {
  const f = fluidBlockGame(t, {
    id: BLOCK.SPONGE,
    radius: 1,
    initial: [
      ...Array.from({ length: MAX_SPONGE_DISTANCE + 1 }, (_, i) => [
        9 + i,
        1,
        8,
        BLOCK.WATER,
      ]),
      [6, 1, 8, BLOCK.WATER],
    ],
  });
  assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), true);
  for (let dx = 1; dx <= MAX_SPONGE_DISTANCE; dx++)
    assert.equal(f.world.get(8 + dx, 1, 8), BLOCK.AIR);
  assert.equal(f.world.get(8 + MAX_SPONGE_DISTANCE + 1, 1, 8), BLOCK.WATER);
  assert.equal(f.world.get(6, 1, 8), BLOCK.WATER);
});

test("F5 render-camera offsets never replace the physical-eye placement ray", (t) => {
  for (const perspective of ["back", "front"]) {
    const f = fluidBlockGame(t);
    f.player.perspective = perspective;
    assert.ok(f.camera.position.distanceTo(f.player.eyePosition) > 0.5);
    assert.equal(placeFluidBlock(f.game, "main", BLOCK.KELP), true);
  }
  const fallback = fluidBlockGame(t);
  const eye = fallback.player.eyePosition;
  fallback.camera.position.copy(eye);
  fallback.player.eyePosition = undefined;
  assert.equal(placeFluidBlock(fallback.game, "main", BLOCK.KELP), true);
  fallback.player.eyePosition = eye;
});

test("the physical-eye block reach remains Survival 4.5 and Creative 5", (t) => {
  for (const mode of ["survival", "creative"]) {
    const f = fluidBlockGame(t, { mode });
    const hit = aimAt(
      f,
      { x: 8.5, y: 1, z: 8.5 },
      { x: 8.5, y: 1, z: 12.9 },
      6
    );
    assert.ok(hit.distance > 4.5 && hit.distance < 5);
    const before = f.ownership();
    assert.equal(
      placeFluidBlock(f.game, "main", BLOCK.KELP),
      mode === "creative"
    );
    if (mode === "survival") {
      assert.deepEqual(f.ownership(), before);
      assertNoFeedback(f);
    }
  }
});

test("GameUseActions delegates falling kelp and dry sponge, but wet sponge stays ordinary", (t) => {
  const kelp = fluidBlockGame(t, {
    initial: [[8, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_FALLING }]],
  });
  assert.equal(
    kelp.game.useActions.useHand("main", kelp.gameplay.getHandStack(), false),
    true
  );
  assert.equal(kelp.world.get(8, 1, 8), BLOCK.KELP);
  const sponge = fluidBlockGame(t, {
    id: BLOCK.SPONGE,
    initial: [[9, 1, 8, BLOCK.KELP]],
  });
  assert.equal(sponge.game.useActions.place("main", BLOCK.SPONGE), true);
  assert.equal(sponge.world.get(8, 1, 8), BLOCK.WET_SPONGE);
  assert.deepEqual(retainedCounts(sponge), new Map([[BLOCK.KELP, 1]]));

  const wet = fluidBlockGame(t, {
    id: BLOCK.WET_SPONGE,
    initial: [[9, 1, 8, BLOCK.KELP]],
  });
  wet.game.fluidServices = null;
  assert.equal(
    prepareFluidBlockPlacement(wet.game, "main", BLOCK.WET_SPONGE),
    null
  );
  assert.equal(placeFluidBlock(wet.game, "main", BLOCK.WET_SPONGE), null);
  assert.equal(wet.game.useActions.place("main", BLOCK.WET_SPONGE), true);
  assert.equal(wet.world.get(8, 1, 8), BLOCK.WET_SPONGE);
  assert.equal(wet.world.get(9, 1, 8), BLOCK.KELP);
  assert.equal(wet.overflow.size, 0);
  assert.deepEqual(wet.gameplay.getHandStack(), named(BLOCK.WET_SPONGE, 2));
});

test("a rejected special action never falls through to generic dry sponge placement", (t) => {
  const f = fluidBlockGame(t, {
    id: BLOCK.SPONGE,
    initial: [[9, 1, 8, BLOCK.KELP]],
  });
  f.game.fluidServices = null;
  const before = f.ownership();
  assert.equal(placeFluidBlock(f.game, "main", BLOCK.SPONGE), false);
  assert.equal(f.game.useActions.place("main", BLOCK.SPONGE), false);
  assert.deepEqual(f.ownership(), before);
  assertNoFeedback(f);
});
