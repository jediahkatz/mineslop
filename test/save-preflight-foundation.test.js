import assert from "node:assert/strict";
import test from "node:test";
import { Gameplay } from "../src/gameplay.js";
import {
  normalizeWorldComponents,
  preflightWorldComponents,
} from "../src/save-preflight.js";
import { getWorldSpec } from "../src/world-spec.js";

const worldData = (generatorVersion = 4) => ({
  version: 3,
  seed: "preflight-context",
  dimension: "overworld",
  generatorVersion,
  edits: [],
});

test("component preflight returns detached normalized snapshots without live-world resources", () => {
  const saved = {
    world: worldData(3),
    gameplay: new Gameplay().serialize(),
    settlement: { version: 2, chests: [], furnaces: [], crops: [] },
    fuses: {
      version: 1,
      entries: [{ dimension: "end", x: 5, y: 80, z: 5, remaining: 2 }],
    },
    experienceOrbs: {
      version: 1,
      orbs: [{ amount: 5, x: 1, y: 1000, z: 2, dimension: "overworld" }],
    },
  };
  const before = structuredClone(saved);
  const normalized = normalizeWorldComponents(saved);
  assert.equal(normalized.context.seed, saved.world.seed);
  assert.equal(normalized.context.generatorVersion, 3);
  assert.equal(
    normalized.context.specForDimension("end"),
    getWorldSpec(3, "end")
  );
  assert.deepEqual(normalized.world, saved.world);
  assert.deepEqual(normalized.gameplay, saved.gameplay);
  normalized.fuses.entries[0].remaining = 0;
  normalized.experienceOrbs.orbs[0].amount = 1;
  normalized.world.seed = "detached";
  assert.deepEqual(saved, before);
  assert.equal(preflightWorldComponents(saved), true);
  assert.equal(preflightWorldComponents({}), true);
  assert.equal(normalizeWorldComponents(null), null);
});

test("all dimension specs reach staged component normalizers, including inactive records", () => {
  const saved = {
    world: worldData(),
    settlement: {
      version: 3,
      chests: [
        { dimension: "overworld", x: 1, y: -64, z: 2, slots: [] },
        { dimension: "nether", x: 1, y: 255, z: 2, slots: [] },
        { dimension: "end", x: 1, y: 0, z: 2, slots: [] },
      ],
      furnaces: [],
      crops: [],
    },
  };
  const before = structuredClone(saved);
  let received;
  // A pure component-owner fixture proves the handoff, not real Settlement v3.
  const normalized = normalizeWorldComponents(saved, {
    normalizers: {
      settlement(data, context) {
        received = context;
        for (const chest of data.chests) {
          const spec = context.specForDimension(chest.dimension);
          assert.ok(chest.y >= spec.minY && chest.y < spec.maxY);
        }
        return data;
      },
    },
  });
  assert.equal(received, normalized.context);
  assert.equal(received.generatorVersion, 4);
  assert.deepEqual(normalized.settlement, saved.settlement);
  normalized.settlement.chests[0].slots.push(null);
  assert.deepEqual(saved, before);
});

test("inactive dimension coordinates are rejected before even calling a component normalizer", () => {
  for (const [dimension, y] of [
    ["nether", -1],
    ["end", 256],
    ["overworld", 320],
    ["moon", 30],
  ]) {
    let calls = 0;
    const saved = {
      world: worldData(),
      fuses: {
        version: 1,
        entries: [{ dimension, x: 0, y, z: 0, remaining: 1 }],
      },
    };
    assert.throws(
      () =>
        normalizeWorldComponents(saved, {
          normalizers: {
            fuses(data) {
              calls++;
              return data;
            },
          },
        }),
      /coordinates/
    );
    assert.equal(calls, 0);
  }
});

test("coordinate preflight does not confuse high flight with the build ceiling", () => {
  const saved = {
    world: worldData(),
    player: { x: 0.5, y: 4_000_000, z: 0.5, yaw: 0, pitch: 0, flying: true },
  };
  assert.deepEqual(normalizeWorldComponents(saved).player, saved.player);
  saved.player.y = -30;
  assert.deepEqual(normalizeWorldComponents(saved).player, saved.player);
  saved.player.y = -129;
  assert.throws(() => normalizeWorldComponents(saved), /player position/);
  saved.world = worldData(3);
  saved.player.y = -30;
  assert.throws(() => normalizeWorldComponents(saved), /player position/);
});

test("unsupported component versions fail closed and async normalizers cannot stage data", () => {
  const saved = {
    world: worldData(),
    settlement: { version: 99, chests: [], crops: [], furnaces: [] },
  };
  assert.throws(
    () => normalizeWorldComponents(saved),
    /container or crop data.*context-aware/
  );
  assert.throws(
    () =>
      normalizeWorldComponents(saved, {
        normalizers: { settlement: async (data) => data },
      }),
    /component normalizer/
  );
  assert.throws(
    () =>
      normalizeWorldComponents(saved, {
        normalizers: { settlement: () => Promise.resolve(saved.settlement) },
      }),
    /Invalid saved/
  );
});
