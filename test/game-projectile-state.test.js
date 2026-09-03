import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectileServicesSnapshot } from "../src/game-projectile-state.js";
import { normalizePlayerProjectilesSnapshot } from "../src/pearl-save.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { createWorldContext } from "../src/world-spec.js";
import { pearlRecord, pearlSnapshot } from "./pearl-fixtures.js";

const context = createWorldContext({
  seed: "projectile-preflight",
  generatorVersion: 3,
});
const world = {
  version: 3,
  seed: context.seed,
  generatorVersion: 3,
  dimension: "overworld",
  edits: [],
};

test("missing projectile data migrates without introducing a fictitious owner or scene", () => {
  for (const saved of [
    undefined,
    null,
    {},
    { time: 0.4 },
    { playerProjectiles: undefined },
  ])
    assert.deepEqual(normalizeProjectileServicesSnapshot(saved, context), {});
});

test("present projectile data is detached and preserved by actual archive preflight", () => {
  const playerProjectiles = pearlSnapshot(context, [pearlRecord()]);
  const saved = { world, playerProjectiles };
  const normalized = normalizeWorldComponents(saved);
  assert.deepEqual(normalized.playerProjectiles, playerProjectiles);
  normalized.playerProjectiles.projectiles[0].position.x++;
  assert.equal(playerProjectiles.projectiles[0].position.x, 4.5);
  assert.deepEqual(
    normalizeProjectileServicesSnapshot(saved, context).playerProjectiles,
    playerProjectiles
  );
});

test("malformed explicit projectile sidecars reject before candidate activation", () => {
  const good = pearlSnapshot(context, [pearlRecord()]);
  for (const playerProjectiles of [
    null,
    [],
    {},
    { ...good, version: 99 },
    { ...good, seed: "other" },
    { ...good, life: 1 },
    { ...good, ownerId: "other" },
    { ...good, extra: true },
    { ...good, cooldown: 2 },
  ]) {
    assert.equal(
      normalizeProjectileServicesSnapshot({ playerProjectiles }, context),
      null
    );
    assert.throws(
      () => normalizeWorldComponents({ world, playerProjectiles }),
      /player projectiles/
    );
  }
  let reads = 0;
  const getter = {};
  Object.defineProperty(getter, "playerProjectiles", {
    enumerable: true,
    get() {
      reads++;
      return good;
    },
  });
  assert.equal(normalizeProjectileServicesSnapshot(getter, context), null);
  assert.equal(reads, 0);
  Object.defineProperty(getter, "world", { value: world, enumerable: true });
  assert.throws(() => normalizeWorldComponents(getter), /player projectiles/);
  assert.equal(
    reads,
    0,
    "archive preflight must not clone an unvalidated getter"
  );

  const nested = structuredClone(good);
  Object.defineProperty(nested.projectiles[0].position, "x", {
    enumerable: true,
    get() {
      reads++;
      return 4.5;
    },
  });
  assert.throws(
    () => normalizeWorldComponents({ world, playerProjectiles: nested }),
    /player projectiles/
  );
  assert.equal(
    reads,
    0,
    "nested sidecar accessors are rejected before cloning"
  );
});

test("canonical legacy empty-string seeds remain valid with saved pearls", () => {
  const empty = createWorldContext({ seed: "", generatorVersion: 3 });
  const playerProjectiles = pearlSnapshot(empty, []);
  assert.deepEqual(
    normalizePlayerProjectilesSnapshot(playerProjectiles, empty),
    playerProjectiles
  );
  const saved = {
    world: { ...world, seed: "" },
    playerProjectiles,
  };
  assert.deepEqual(
    normalizeWorldComponents(saved).playerProjectiles,
    playerProjectiles
  );
});

test("the active dimension cannot excuse an invalid inactive-dimension flight", () => {
  const modern = createWorldContext({
    seed: "projectile-preflight",
    generatorVersion: 4,
  });
  const valid = pearlSnapshot(modern, [
    pearlRecord({ dimension: "overworld", position: { x: 4, y: -40, z: 4 } }),
    pearlRecord({
      id: 2,
      dimension: "nether",
      position: { x: 4, y: 300, z: 4 },
    }),
  ]);
  assert.ok(
    normalizeProjectileServicesSnapshot({ playerProjectiles: valid }, modern)
  );
  const invalid = structuredClone(valid);
  invalid.projectiles[1].position.y = modern.specForDimension("nether").voidY;
  assert.equal(
    normalizeProjectileServicesSnapshot({ playerProjectiles: invalid }, modern),
    null
  );
});
