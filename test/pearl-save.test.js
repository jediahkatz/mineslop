import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PlayerProjectiles } from "../src/player-projectiles.js";
import { MAX_PEARL_SPEED, PEARL_STEP_SECONDS } from "../src/pearl-physics.js";
import {
  MAX_PEARL_ID,
  MAX_PLAYER_PEARLS,
  nextPearlRandom,
  normalizePlayerProjectilesSnapshot,
  PEARL_COOLDOWN_SECONDS,
  PEARL_FRONTIER_SECONDS,
  PEARL_LIFETIME_SECONDS,
  pearlReservedBytes,
} from "../src/pearl-save.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  floorImpact,
  pearlFixture,
  pearlRecord,
  pearlSnapshot,
  pearlWorld,
} from "./pearl-fixtures.js";

test("pearl snapshots retain signed/high-flight positions and every dimension's void bound", () => {
  for (const generatorVersion of [1, 2, 3, 4]) {
    const { context } = pearlWorld({ generatorVersion });
    const records = ["overworld", "nether", "end"].flatMap(
      (dimension, index) => {
        const spec = context.specForDimension(dimension);
        return [
          pearlRecord({
            id: index * 2 + 1,
            dimension,
            position: { x: 4.5, y: spec.voidY + 0.1, z: 4.5 },
          }),
          pearlRecord({
            id: index * 2 + 2,
            dimension,
            position: { x: 4.5, y: spec.maxY + 10_000, z: 4.5 },
          }),
        ];
      }
    );
    const snapshot = pearlSnapshot(context, records);
    assert.deepEqual(
      normalizePlayerProjectilesSnapshot(snapshot, context),
      snapshot
    );
    for (let i = 0; i < records.length; i++) {
      const broken = structuredClone(snapshot);
      broken.projectiles[i].position.y = context.specForDimension(
        records[i].dimension
      ).voidY;
      assert.equal(normalizePlayerProjectilesSnapshot(broken, context), null);
    }
  }
  const modern = pearlWorld().context;
  const historical = pearlWorld({ generatorVersion: 3 }).context;
  const negative = pearlRecord({ position: { x: 4, y: -40, z: 4 } });
  assert.ok(
    normalizePlayerProjectilesSnapshot(
      pearlSnapshot(modern, [negative]),
      modern
    )
  );
  assert.equal(
    normalizePlayerProjectilesSnapshot(
      pearlSnapshot(historical, [negative]),
      historical
    ),
    null
  );
});

test("unknown kinds, identities, fields and malformed coordinates reject the whole snapshot", () => {
  const { context } = pearlWorld();
  const base = pearlSnapshot(context, [
    pearlRecord(),
    pearlRecord({ id: 2, dimension: "end" }),
  ]);
  const corruptions = [
    (s) => {
      s.version = 2;
    },
    (s) => {
      s.seed = "another-world";
    },
    (s) => {
      s.generatorVersion = 3;
    },
    (s) => {
      s.ownerId = "";
    },
    (s) => {
      s.life = -1;
    },
    (s) => {
      s.extra = true;
    },
    (s) => {
      s.projectiles[1].kind = "arrow";
    },
    (s) => {
      s.projectiles[1].ownerId = "another-player";
    },
    (s) => {
      s.projectiles[1].life = 1;
    },
    (s) => {
      s.projectiles[1].id = s.projectiles[0].id;
    },
    (s) => {
      s.projectiles[1].id = s.nextId;
    },
    (s) => {
      s.projectiles[1].dimension = "unknown";
    },
    (s) => {
      s.projectiles[1].position.x = NaN;
    },
    (s) => {
      s.projectiles[1].position.y = Infinity;
    },
    (s) => {
      s.projectiles[1].position.z = WORLD_MAX;
    },
    (s) => {
      s.projectiles[1].position = [4, 20, 4];
    },
    (s) => {
      s.projectiles[1].position.dimension = "nether";
    },
    (s) => {
      s.projectiles[1].velocity.x = MAX_PEARL_SPEED + 1;
    },
    (s) => {
      s.projectiles[1].velocity.y = -Infinity;
    },
    (s) => {
      s.projectiles[1].velocity.extra = 0;
    },
    (s) => {
      s.projectiles[1].callback = "teleport";
    },
    (s) => {
      delete s.projectiles[1];
    },
  ];
  for (const corrupt of corruptions) {
    const broken = structuredClone(base);
    corrupt(broken);
    assert.equal(normalizePlayerProjectilesSnapshot(broken, context), null);
  }
  assert.equal(
    normalizePlayerProjectilesSnapshot(base, context, { id: "other-player" }),
    null
  );
  assert.equal(
    normalizePlayerProjectilesSnapshot(base, context, {
      id: base.ownerId,
      life: 1,
    }),
    null
  );
  const getter = structuredClone(base);
  Object.defineProperty(getter.projectiles[0], "age", {
    enumerable: true,
    get() {
      throw new Error("normalization must reject accessors before reading");
    },
  });
  assert.equal(normalizePlayerProjectilesSnapshot(getter, context), null);
});

test("cooldown, counters, RNG, age, wait and all capacities are bounded", () => {
  const { context } = pearlWorld();
  const base = pearlSnapshot(context);
  for (const [field, values] of Object.entries({
    cooldown: [-1, PEARL_COOLDOWN_SECONDS + 0.01, NaN],
    randomState: [0, -1, 0x100000000, 1.1],
    nextId: [0, 1, MAX_PEARL_ID + 1, Infinity],
    accumulator: [-0.1, PEARL_STEP_SECONDS, Infinity],
  })) {
    for (const value of values) {
      assert.equal(
        normalizePlayerProjectilesSnapshot(
          { ...base, [field]: value },
          context
        ),
        null
      );
    }
  }
  for (const [field, values] of Object.entries({
    age: [-1, PEARL_LIFETIME_SECONDS, NaN],
    wait: [-1, PEARL_FRONTIER_SECONDS, 0.1],
    spin: [0, 0x100000000, 0.1],
  })) {
    for (const value of values) {
      const broken = structuredClone(base);
      broken.projectiles[0][field] = value;
      assert.equal(
        normalizePlayerProjectilesSnapshot(broken, context),
        null,
        field
      );
    }
  }
  const records = Array.from({ length: MAX_PLAYER_PEARLS }, (_, index) =>
    pearlRecord({ id: index + 1 })
  );
  assert.ok(
    normalizePlayerProjectilesSnapshot(pearlSnapshot(context, records), context)
  );
  records.push(pearlRecord({ id: MAX_PLAYER_PEARLS + 1 }));
  assert.equal(
    normalizePlayerProjectilesSnapshot(
      pearlSnapshot(context, records),
      context
    ),
    null
  );
  assert.notEqual(nextPearlRandom(42), 42);
  assert.equal(nextPearlRandom(42), nextPearlRandom(42));
});

test("canonical pearl snapshots are detached, lossless and idempotent", () => {
  const { context } = pearlWorld();
  const original = pearlSnapshot(
    context,
    [
      pearlRecord({
        age: 1.25,
        wait: 0.3,
        dimension: "nether",
        spin: 0xffffffff,
      }),
      pearlRecord({
        id: 7,
        dimension: "end",
        velocity: { x: -18.52, y: -51, z: 0.00001 },
      }),
    ],
    { cooldown: 0.625, accumulator: 0.0125, randomState: 0xffffffff }
  );
  const untouched = structuredClone(original);
  const normalized = normalizePlayerProjectilesSnapshot(original, context, {
    id: "local-player",
    life: 0,
  });
  assert.deepEqual(normalized, untouched);
  assert.deepEqual(
    normalizePlayerProjectilesSnapshot(normalized, context),
    normalized
  );
  normalized.projectiles[0].position.y = 500;
  normalized.projectiles[1].velocity.x = 0;
  assert.deepEqual(original, untouched);
});

test("the pure normalizer imports and runs with THREE explicitly unavailable", () => {
  const { context } = pearlWorld();
  const input = pearlSnapshot(context);
  const moduleUrl = new URL("../src/pearl-save.js", import.meta.url).href;
  const contextUrl = new URL("../src/world-spec.js", import.meta.url).href;
  const loader = `export async function resolve(name, context, next) {
    if (name === "three" || name.startsWith("three/")) throw new Error("render import in preflight");
    return next(name, context);
  }`;
  const source = `
    import { register } from "node:module";
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
    const { normalizePlayerProjectilesSnapshot } = await import(${JSON.stringify(moduleUrl)});
    const { createWorldContext } = await import(${JSON.stringify(contextUrl)});
    const data = ${JSON.stringify(input)};
    const context = createWorldContext(data);
    if (!normalizePlayerProjectilesSnapshot(data, context)) throw new Error("normalization failed");
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf8",
      timeout: 10_000,
    }
  );
  assert.equal(result.status, 0, result.stderr);
});

test("fixed moving-record reservations cover maximal supported JSON fields", () => {
  const context = createWorldContext({
    seed: "界".repeat(80),
    generatorVersion: 4,
  });
  const ownerId = "p".repeat(64);
  const records = Array.from({ length: MAX_PLAYER_PEARLS }, (_, index) =>
    pearlRecord({
      id: MAX_PEARL_ID - index - 1,
      ownerId,
      life: MAX_PEARL_ID,
      position: {
        x: WORLD_MAX - 0.3,
        y: Number.MAX_SAFE_INTEGER - 32,
        z: WORLD_MIN + 0.3,
      },
      velocity: {
        x: -MAX_PEARL_SPEED,
        y: Number.MIN_VALUE,
        z: MAX_PEARL_SPEED,
      },
      age: 29.999999999999996,
      wait: 1.9999999999999998,
      spin: 0xffffffff,
    })
  );
  const snapshot = pearlSnapshot(context, records, {
    ownerId,
    life: MAX_PEARL_ID,
    nextId: MAX_PEARL_ID,
    randomState: 0xffffffff,
    cooldown: 0.9999999999999999,
    accumulator: 0.04999999999999999,
  });
  assert.ok(normalizePlayerProjectilesSnapshot(snapshot, context));
  assert.ok(encodedBytes(snapshot) <= pearlReservedBytes(records.length));
});

test("contextual loads are detached, revisioned and reject owner or capacity mismatch atomically", (t) => {
  const f = pearlFixture(t);
  const before = f.pearls.serialize();
  const revision = f.pearls.revision;
  const wrong = pearlSnapshot(f.context, [pearlRecord({ life: 1 })], {
    life: 1,
  });
  assert.equal(f.pearls.load(wrong), false);
  assert.deepEqual(f.pearls.serialize(), before);
  assert.equal(f.pearls.revision, revision);
  const filler = {};
  assert.equal(
    f.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const data = pearlSnapshot(f.context);
  assert.equal(f.pearls.load(data), false);
  assert.deepEqual(f.pearls.serialize(), before);
  assert.equal(f.pearls.reservedBytes, pearlReservedBytes(0));
  assert.equal(f.pearls.load(data, { allowOverBudget: true }), true);
  assert.ok(f.coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
  data.projectiles[0].position.x = 10;
  assert.equal(f.pearls.projectiles[0].position.x, 4.5);
  const cost = f.game.getHandStack();
  assert.equal(f.pearls.throwPearl(f.shot()), false);
  assert.deepEqual(f.game.getHandStack(), cost);
  assert.equal(f.pearls.cancelPending(), true);
  assert.ok(f.coordinator.budget.totalBytes <= MAX_RESERVED_BYTES);
  f.coordinator.release(filler);
  const prepared = f.pearls.prepareThrow(f.shot());
  assert.ok(prepared);
  assert.equal(f.pearls.load(f.pearls.serialize()), true);
  assert.equal(f.coordinator.commit(prepared.participants).ok, false);
});

test("staged over-budget archives can explicitly admit the bounded pearl header", () => {
  const world = pearlWorld();
  const filler = {};
  assert.equal(
    world.coordinator.register(filler, MAX_RESERVED_BYTES + 1, {
      allowOverBudget: true,
    }),
    true
  );
  const options = { ownerId: "local-player", getOwner: () => null };
  assert.throws(() => new PlayerProjectiles(world, options), RangeError);
  assert.equal(world.coordinator.budget.totalBytes, MAX_RESERVED_BYTES + 1);
  const pearls = new PlayerProjectiles(world, {
    ...options,
    allowOverBudget: true,
  });
  assert.equal(world.coordinator.usage(pearls), pearlReservedBytes(0));
  assert.equal(pearls.dispose(), true);
  assert.equal(world.coordinator.budget.totalBytes, MAX_RESERVED_BYTES + 1);
});

test("candidate packets stage without a live Player and bind only after explicit identity-checked activation", (t) => {
  const f = pearlFixture(t, { staged: true });
  const getOwner = f.pearls.getOwner;
  let ownerReads = 0;
  f.pearls.getOwner = () => {
    ownerReads++;
    return null;
  };
  floorImpact(f);
  const before = f.pearls.serialize();
  assert.equal(ownerReads, 0);
  assert.equal(f.pearls.staged, true);
  assert.equal(f.pearls.update(1), false);
  assert.equal(f.pearls.prepareThrow(f.shot()), null);
  assert.equal(f.pearls.prepareImpactTransaction(1), null);
  assert.equal(ownerReads, 0);
  assert.deepEqual(f.pearls.serialize(), before);
  assert.equal(f.coordinator.usage(f.pearls), pearlReservedBytes(1));
  assert.equal(f.pearls.activateOwner(), false);
  f.pearls.getOwner = getOwner;
  f.owner.life++;
  assert.equal(f.pearls.activateOwner(), false);
  assert.deepEqual(f.pearls.serialize(), before);
  f.owner.life--;
  assert.equal(f.pearls.activateOwner(), true);
  assert.equal(f.pearls.staged, false);
  assert.equal(f.pearls.activateOwner(), false);
  assert.equal(f.game.health, 20);
  f.pearls.update(0.05);
  assert.equal(f.game.health, 15);
  assert.equal(f.pearls.size, 0);
});

test("activating a dead owner's staged packet clears pearls without reviving delayed effects", (t) => {
  const f = pearlFixture(t, { staged: true });
  floorImpact(f);
  f.game.damage(20, "fall");
  const position = { ...f.player.position };
  assert.equal(f.pearls.activateOwner(), true);
  assert.equal(f.pearls.size, 0);
  assert.equal(f.coordinator.usage(f.pearls), pearlReservedBytes(0));
  assert.deepEqual(f.player.position, position);
  f.game.respawn();
  f.pearls.update(0.05);
  assert.equal(f.game.health, 20);
  assert.equal(f.impacts.length, 0);
});
