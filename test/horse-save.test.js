import assert from "node:assert/strict";
import test from "node:test";
import {
  HORSE_BASE_COPY_LIMIT, HORSE_BASE_RECORD_RESERVED_BYTES, HORSE_HEADER_RESERVED_BYTES,
  MAX_LIVING_HORSES, MAX_RETAINED_HORSE_IDS, horseMotion, horseRecordBytes,
} from "../src/horse-definitions.js";
import {
  emptyHorseSnapshot, horseBaseProjection, horseMobLinksValid,
  normalizeHorseRecord, normalizeHorseSnapshot, sameHorseBase,
} from "../src/horse-save.js";
import { normalizeMobSnapshot } from "../src/mob-save.js";
import { MAX_MOBS } from "../src/mob-species.js";
import { getItem, ITEM } from "../src/items.js";
import { encodedBytes } from "../src/save-budget.js";
import { GENERATOR_VERSION } from "../src/terrain.js";
import { createWorldContext } from "../src/world-spec.js";
import { mobRecord, mobSnapshot } from "./entity-context-fixtures.js";
import { horseRecord } from "./horse-fixture.js";

const context = () => createWorldContext({ seed: '  north/"🦄"\n', generatorVersion: 4 });
const snapshot = (ctx, entries = []) => ({ ...emptyHorseSnapshot(ctx), entries });
const base = (ctx, id = "horse:one") => mobRecord(ctx, "overworld", {
  id, kind: "horse", health: 24, position: { x: 8.5, y: 4, z: 8.5 },
});

test("horse absence is explicit; raw seeds and every supported generator context survive unchanged", () => {
  for (let generatorVersion = 1; generatorVersion <= Math.max(4, GENERATOR_VERSION); generatorVersion++) {
    const ctx = createWorldContext({ seed: '  north/"🦄"\n', generatorVersion });
    const original = snapshot(ctx, [horseRecord()]);
    const clean = normalizeHorseSnapshot(original, ctx);
    assert.deepEqual(clean, original);
    assert.equal(clean.seed, ctx.seed);
    assert.deepEqual(normalizeHorseSnapshot(clean, ctx), clean);
    assert.equal(normalizeHorseSnapshot(undefined, ctx), null);
    assert.equal(normalizeHorseSnapshot(null, ctx), null);
    assert.deepEqual(normalizeHorseSnapshot(emptyHorseSnapshot(ctx), ctx), emptyHorseSnapshot(ctx));
  }
});

test("malformed, accessor, duplicated, unsupported, and impossible horse records reject in full", () => {
  const ctx = context(), original = horseRecord();
  for (const patch of [
    { alive: undefined }, { id: "" }, { id: "a".repeat(101) }, { dimension: "moon" },
    { tamed: 1 }, { temper: -1 }, { temper: 101 }, { temper: 1.5 },
    { failedAttempts: 21 }, { failedAttempts: 1 }, { rider: "other-player" },
    { rider: "player" }, { tamingTicksLeft: 61 }, { tamingTicksLeft: NaN },
    { tamingTicksLeft: 0 }, { tamed: true }, { saddle: undefined }, { motion: {} },
    { position: { x: 0, y: 1, z: 0 } }, { health: 24 },
    { motion: { ...horseMotion(), vy: 1 } },
    { motion: { ...horseMotion(), vx: Infinity } },
    { motion: { ...horseMotion(), fallDistance: 513 } },
    { alive: false, saddle: null },
  ]) assert.equal(normalizeHorseRecord({ ...original, ...patch }, ctx), null, JSON.stringify(patch));
  for (const value of [
    {}, [], undefined, null, { ...snapshot(ctx), version: 2 },
    { ...snapshot(ctx), seed: ctx.seed.trim() },
    { ...snapshot(ctx), generatorVersion: 99 }, { ...snapshot(ctx), nextId: 1 },
    snapshot(ctx, [original, original]), snapshot(ctx, Array(1)),
  ]) assert.equal(normalizeHorseSnapshot(value, ctx), null);
  let calls = 0;
  const accessor = snapshot(ctx);
  Object.defineProperty(accessor, "entries", { enumerable: true, get: () => { calls++; return []; } });
  assert.equal(normalizeHorseSnapshot(accessor, ctx), null);
  const entryAccessor = { ...original };
  Object.defineProperty(entryAccessor, "temper", { enumerable: true, get: () => { calls++; return 0; } });
  assert.equal(normalizeHorseSnapshot(snapshot(ctx, [entryAccessor]), ctx), null);
  const mobAccessor = mobSnapshot(ctx, "overworld", [base(ctx)]);
  Object.defineProperty(mobAccessor, "dimension", { enumerable: true, get: () => { calls++; return "overworld"; } });
  assert.equal(normalizeMobSnapshot(mobAccessor, ctx), null);
  assert.equal(calls, 0, "untrusted saves never execute getters");
});

test("live horses, permanent IDs, and the single rider have independent finite limits", () => {
  const ctx = context();
  const living = Array.from({ length: MAX_LIVING_HORSES }, (_, i) => horseRecord(`live:${i}`));
  const dead = Array.from({ length: MAX_RETAINED_HORSE_IDS - living.length }, (_, i) => ({
    id: `dead:${i}`, dimension: "overworld", alive: false,
  }));
  assert.ok(normalizeHorseSnapshot(snapshot(ctx, [...living, ...dead]), ctx));
  assert.equal(normalizeHorseSnapshot(snapshot(ctx, [...living, horseRecord("ninth")]), ctx), null);
  assert.equal(normalizeHorseSnapshot(snapshot(ctx, [...living, ...dead, {
    id: "extra", dimension: "end", alive: false,
  }]), ctx), null);
  assert.equal(normalizeHorseSnapshot(snapshot(ctx, [
    horseRecord("a", { rider: "player", motion: horseMotion() }),
    horseRecord("b", { rider: "player", motion: horseMotion() }),
  ]), ctx), null);
});

test("named saddle stacks are exact, detached, bounded and only valid on tamed horses", () => {
  const ctx = context();
  assert.equal(ITEM.SADDLE, 65633, "Parent's ratified item ID");
  assert.equal(getItem(ITEM.SADDLE)?.stackSize, 1);
  const saddle = { id: ITEM.SADDLE, count: 1, data: { version: 1, name: "🦄 trail saddle" } };
  const entry = horseRecord("owned", { tamed: true, tamingTicksLeft: 0, saddle });
  const clean = normalizeHorseRecord(entry, ctx);
  assert.deepEqual(clean, entry);
  assert.equal(normalizeHorseRecord({ ...entry, tamed: false, tamingTicksLeft: 60 }, ctx), null);
  saddle.data.name = "changed source";
  assert.equal(clean.saddle.data.name, "🦄 trail saddle");
  const bytes = encodedBytes(snapshot(ctx, [clean])) +
    HORSE_BASE_COPY_LIMIT * (encodedBytes(horseBaseProjection(base(ctx, clean.id))) + 1);
  assert.ok(bytes <= HORSE_HEADER_RESERVED_BYTES + horseRecordBytes(clean));
  assert.ok(encodedBytes(horseBaseProjection(base(ctx))) < HORSE_BASE_RECORD_RESERVED_BYTES);
});

test("fixed record reservations cover escaped IDs and changing full-precision numeric projections", () => {
  const ctx = context(), id = "\0".repeat(100);
  const entry = horseRecord(id, {
    tamed: true, tamingTicksLeft: 0, rider: "player",
    saddle: { id: ITEM.SADDLE, count: 1, data: { version: 1, name: "🦄".repeat(50) } },
    motion: { vx: 1.2345678901234567, vy: -31.234567890123457, vz: 1.2345678901234567e-200,
      grounded: false, fallDistance: 123.45678901234567 },
  });
  const mob = { ...base(ctx, id),
    position: { x: 1.2345678901234567e-200, y: 1.2345678901234567e-200, z: 1.2345678901234567e-200 },
    health: 1.2345678901234567e-200, yaw: 1.2345678901234567e-200,
    angry: 1.2345678901234567e-200, attackCooldown: 1.2345678901234567e-200,
    fuse: 1.2345678901234567e-200, pacified: 1.2345678901234567e-200,
  };
  const horses = snapshot(ctx, [entry]);
  assert.ok(normalizeHorseSnapshot(horses, ctx));
  assert.ok(normalizeMobSnapshot(mobSnapshot(ctx, "overworld", [mob]), ctx, "overworld", { horses }));
  const actual = encodedBytes(horses) +
    HORSE_BASE_COPY_LIMIT * (encodedBytes(horseBaseProjection(mob)) + 1);
  assert.ok(actual <= HORSE_HEADER_RESERVED_BYTES + horseRecordBytes(entry));
});

test("retained bases expand only the saved cap, never legacy wolf flags or the active population cap", () => {
  const ctx = context();
  const legacy = Array.from({ length: MAX_MOBS }, (_, i) => mobRecord(ctx, "overworld", { id: `sheep:${i}` }));
  const horses = snapshot(ctx, Array.from({ length: 8 }, (_, i) => horseRecord(`horse:${i}`)));
  const bases = horses.entries.map((entry) => base(ctx, entry.id));
  const mobs = mobSnapshot(ctx, "overworld", [...legacy, ...bases]);
  assert.equal(normalizeMobSnapshot(mobs, ctx), null);
  assert.ok(normalizeMobSnapshot(mobs, ctx, "overworld", { horses }));
  assert.equal(normalizeMobSnapshot(mobs, ctx, "overworld", { horses: undefined }), null);
  assert.equal(normalizeMobSnapshot({ ...mobs, entities: mobs.entities.slice(1) }, ctx, "overworld",
    { horses: snapshot(ctx, [...horses.entries, horseRecord("absent")]) }), null);
  assert.equal(normalizeMobSnapshot(mobSnapshot(ctx, "overworld", [{ ...bases[0], tamed: true }]), ctx,
    "overworld", { horses: snapshot(ctx, [horses.entries[0]]) }), null);
  assert.ok(normalizeMobSnapshot(mobSnapshot(ctx, "overworld", [base(ctx)]), ctx),
    "legacy untracked horse remains an ordinary base record");
});

test("canonical links reject missing/duplicate/dead/species/dimension/ecology aliases", () => {
  const ctx = context(), horses = snapshot(ctx, [horseRecord(), { id: "dead", dimension: "overworld", alive: false }]);
  const mobs = mobSnapshot(ctx, "overworld", [base(ctx)]);
  assert.equal(horseMobLinksValid(horses, [mobs]), true);
  assert.equal(horseMobLinksValid(horses, []), false);
  assert.equal(horseMobLinksValid(horses, [mobs, mobs]), false);
  assert.equal(horseMobLinksValid(horses, [{ ...mobs, entities: [base(ctx, "dead")] }]), false);
  assert.equal(horseMobLinksValid(horses, [{ ...mobs, killed: ["dead"] }]), false);
  assert.equal(horseMobLinksValid(horses, [{ ...mobs, entities: [{ ...base(ctx), kind: "wolf" }] }]), false);
  assert.equal(horseMobLinksValid(horses, [{ ...mobs, dimension: "nether" }]), false);
  for (const ecology of [
    { entries: [{ id: "horse:one", alive: false }], eggs: [] },
    { entries: [], eggs: [{ id: "egg", childId: "horse:one" }] },
    { entries: [], eggs: [{ id: "dead", childId: "child" }] },
  ]) assert.equal(horseMobLinksValid(horses, [mobs], { ecology }), false);
  const other = mobSnapshot(ctx, "nether", [mobRecord(ctx, "nether", { id: "horse:one" })]);
  assert.equal(horseMobLinksValid(horses, [mobs, other]), false);
});

test("compatibility equality covers the complete Wildlife owned projection", () => {
  const a = horseBaseProjection(base(context())), b = structuredClone(a);
  assert.equal(sameHorseBase(a, b), true);
  for (const key of ["id", "kind", "health", "yaw", "tamed", "angry", "attackCooldown", "fuse", "pacified"]) {
    const changed = { ...b, [key]: typeof b[key] === "number" ? b[key] + 0.01 : `${b[key]}:different` };
    assert.equal(sameHorseBase(a, changed), false, key);
  }
  assert.equal(sameHorseBase(a, { ...b, position: { ...b.position, x: b.position.x + 1 } }), false);
});
