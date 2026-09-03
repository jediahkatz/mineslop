import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  FUSE_RECORD_RESERVED_BYTES,
  Fuses,
  MAX_FUSES,
  normalizeFuseSnapshot,
} from "../src/fuses.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { createWorldContext } from "../src/world-spec.js";
import { fixtureWorld } from "./world-foundation-fixtures.js";

function fixture(t, options = {}) {
  const world = fixtureWorld(t, { generatorVersion: 4, ...options });
  const context = createWorldContext(world);
  const fuses = new Fuses({ coordinator: world.coordinator, context });
  t.after(() => fuses.dispose());
  return { world, context, fuses, coordinator: world.coordinator };
}

test("priming atomically owns TNT at signed and tall bounds in all dimensions", (t) => {
  for (const [dimension, y] of [
    ["overworld", -64],
    ["overworld", 319],
    ["nether", 0],
    ["nether", 255],
    ["end", 255],
  ]) {
    const { world, fuses, coordinator } = fixture(t, { dimension });
    const hit = { x: 1, y, z: 2 };
    assert.equal(world.set(hit.x, y, hit.z, BLOCK.TNT), true);
    const observed = [];
    world.onMutation = () =>
      observed.push({
        block: world.get(hit.x, y, hit.z),
        pending: fuses.entries.length,
        bytes: coordinator.usage(fuses),
      });
    assert.equal(fuses.prime(world, hit), true);
    assert.deepEqual(observed, [
      {
        block: BLOCK.AIR,
        pending: 1,
        bytes: FUSE_RECORD_RESERVED_BYTES,
      },
    ]);
    assert.equal(fuses.entries[0].dimension, dimension);
    assert.equal(fuses.entries[0].y, y);
    assert.deepEqual(
      normalizeFuseSnapshot(fuses.serialize(), createWorldContext(world)),
      fuses.serialize()
    );
  }
});

test("vetoes and a full shared budget cannot remove TNT before retaining its fuse", (t) => {
  const { world, fuses, coordinator } = fixture(t);
  const hit = { x: 1, y: -8, z: 2 };
  world.set(hit.x, hit.y, hit.z, BLOCK.TNT);
  const before = world.serialize();
  const veto = {};
  coordinator.register(veto, 0);
  const plans = fuses.preparePrime(world, hit);
  assert.ok(plans);
  assert.equal(
    coordinator.commit([
      ...plans,
      {
        owner: veto,
        beforeBytes: 0,
        afterBytes: 0,
        validate: () => false,
        publish: () => assert.fail("Rejected transaction published"),
      },
    ]).ok,
    false
  );
  assert.deepEqual(world.serialize(), before);
  assert.equal(fuses.entries.length, 0);
  assert.equal(coordinator.usage(fuses), 0);

  const filler = {};
  const usage = MAX_RESERVED_BYTES - coordinator.budget.totalBytes;
  assert.equal(coordinator.register(filler, usage), true);
  assert.equal(fuses.prime(world, hit), false);
  assert.equal(world.get(hit.x, hit.y, hit.z), BLOCK.TNT);
  assert.equal(fuses.entries.length, 0);
  const funded = fuses.preparePrime(world, hit);
  assert.ok(
    funded,
    "preparation allows aggregate funding by another participant"
  );
  assert.equal(
    coordinator.commit([
      ...funded,
      {
        owner: filler,
        beforeBytes: usage,
        afterBytes: usage - FUSE_RECORD_RESERVED_BYTES,
        validate: () => true,
        publish() {},
      },
    ]).ok,
    true
  );
  assert.equal(world.get(hit.x, hit.y, hit.z), BLOCK.AIR);
  assert.equal(fuses.entries.length, 1);
});

test("stale column admissions, world changes and fuse revisions reject both owners", (t) => {
  for (const stale of ["column", "dimension", "fuse"]) {
    const { world, fuses, coordinator } = fixture(t);
    const hit = { x: 1, y: 20, z: 2 };
    world.set(hit.x, hit.y, hit.z, BLOCK.TNT);
    const plans = fuses.preparePrime(world, hit);
    assert.ok(plans);
    if (stale === "column") {
      world._removeChunk("0,0", world.chunks.get("0,0"));
      world._generateSync(0, 0);
    } else if (stale === "dimension") {
      world.setDimension("nether");
    } else {
      assert.equal(fuses.load(fuses.serialize()), true);
    }
    const afterStale = world.serialize();
    assert.equal(coordinator.commit(plans).ok, false, stale);
    assert.deepEqual(world.serialize(), afterStale);
    assert.equal(fuses.entries.length, 0);
    assert.equal(coordinator.usage(fuses), 0);
  }
});

test("unloaded targets, mismatched coordinators and capped pools refuse priming before writes", (t) => {
  const { world, context, fuses } = fixture(t);
  const hit = { x: 1, y: 20, z: 2 };
  world.set(hit.x, hit.y, hit.z, BLOCK.TNT);
  assert.equal(fuses.prime(world, { ...hit, x: 1000 }), false);
  assert.equal(new Fuses().prime(world, hit), false);
  assert.equal(
    fuses.prime(
      {
        dimension: "overworld",
        isLoaded: () => true,
        get: () => BLOCK.TNT,
        set: () => assert.fail("Unsafe legacy set must never be called"),
      },
      hit
    ),
    false
  );
  const entries = Array.from({ length: MAX_FUSES }, (_, x) => ({
    dimension: "overworld",
    x,
    y: -8,
    z: 0,
    remaining: 1,
  }));
  assert.equal(fuses.load({ version: 1, entries }, { context }), true);
  assert.equal(fuses.prime(world, hit), false);
  assert.equal(world.get(hit.x, hit.y, hit.z), BLOCK.TNT);
  const before = fuses.serialize();
  assert.equal(
    fuses.load({ version: 1, entries: [...entries, entries[0]] }),
    false
  );
  assert.deepEqual(fuses.serialize(), before);
});

test("all due fuses publish once before observers, while inactive dimensions remain frozen", (t) => {
  const { world, fuses, coordinator } = fixture(t);
  const entries = [
    { dimension: "overworld", x: 1, y: -8, z: 2, remaining: 0.5 },
    { dimension: "overworld", x: 2, y: -8, z: 2, remaining: 0.5 },
    { dimension: "nether", x: 1, y: 100, z: 2, remaining: 0.5 },
  ];
  fuses.load({ version: 1, entries });
  const observed = [];
  const result = fuses.update(1, world, (position, radius) => {
    observed.push({
      position,
      radius,
      pending: fuses.serialize(),
      bytes: coordinator.usage(fuses),
    });
    fuses.update(1, world, () =>
      assert.fail("Reentrant update exploded twice")
    );
    if (observed.length === 1) throw new Error("observer failed");
  });
  assert.equal(result.ok, true);
  assert.equal(result.observerErrors.length, 1);
  assert.equal(
    observed.length,
    2,
    "one throwing observer cannot skip another due fuse"
  );
  assert.ok(
    observed.every(
      ({ pending, bytes }) =>
        pending.entries.length === 1 &&
        pending.entries[0].dimension === "nether" &&
        pending.entries[0].remaining === 0.5 &&
        bytes === FUSE_RECORD_RESERVED_BYTES
    )
  );
  assert.deepEqual(observed[0].position, { x: 1.5, y: -7.5, z: 2.5 });
  fuses.update(5, world, () => assert.fail("Removed TNT exploded twice"));
  assert.deepEqual(fuses.serialize(), { version: 1, entries: [entries[2]] });
});

test("fuse normalization is detached, contextual and bounded for every accepted countdown", () => {
  const context = createWorldContext({ seed: "fuses", generatorVersion: 4 });
  const entry = {
    dimension: "overworld",
    x: -29_999_999,
    y: -64,
    z: 29_999_999,
    remaining: Number.MIN_VALUE,
  };
  const saved = { version: 1, entries: [entry] };
  const normalized = normalizeFuseSnapshot(saved, context);
  assert.deepEqual(normalized, saved);
  assert.ok(
    encodedBytes(normalized.entries[0]) + 1 <= FUSE_RECORD_RESERVED_BYTES
  );
  entry.remaining = 2;
  assert.equal(normalized.entries[0].remaining, Number.MIN_VALUE);
  for (const patch of [
    { dimension: "nether" },
    { dimension: "end" },
    { y: -65 },
    { y: 320 },
    { y: 1.5 },
    { x: Infinity },
    { remaining: NaN },
    { remaining: 61 },
  ])
    assert.equal(
      normalizeFuseSnapshot(
        { version: 1, entries: [{ ...entry, ...patch }] },
        context
      ),
      null
    );
  const legacy = createWorldContext({ seed: "fuses", generatorVersion: 3 });
  for (const y of [-1, 0, 96, 319])
    assert.equal(
      normalizeFuseSnapshot({ version: 1, entries: [{ ...entry, y }] }, legacy),
      null
    );
  assert.ok(
    normalizeFuseSnapshot(
      { version: 1, entries: [{ ...entry, y: 95 }] },
      legacy
    )
  );
});
