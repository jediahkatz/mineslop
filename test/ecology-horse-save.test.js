import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEcologyServicesSnapshot } from "../src/ecology-save.js";
import { createEcologyState, normalizeEcologySnapshot } from "../src/expansion-ecology.js";
import { MAX_LIVING_HORSES, MAX_RETAINED_HORSE_IDS } from "../src/horse-definitions.js";
import { emptyHorseSnapshot, normalizeHorseSnapshot } from "../src/horse-save.js";
import { MAX_MOBS } from "../src/mob-species.js";
import { createWorldContext, DIMENSIONS } from "../src/world-spec.js";
import { ecologyHorseArchive } from "./ecology-horse-fixture.js";
import { mobRecord } from "./entity-context-fixtures.js";
import { horseRecord } from "./horse-fixture.js";

const context = createWorldContext({ seed: "  raw ecology horses\n", generatorVersion: 4 });

test("omitted horse options retain standalone ecology migration; explicit malformed values never migrate", () => {
  const empty = normalizeEcologyServicesSnapshot(undefined, context);
  assert.ok(empty);
  assert.deepEqual(normalizeEcologyServicesSnapshot(empty, context), empty);
  assert.deepEqual(normalizeEcologyServicesSnapshot(empty, context, {}), empty);
  assert.deepEqual(normalizeEcologyServicesSnapshot(empty, context, {
    horses: emptyHorseSnapshot(context),
  }), empty);
  for (const options of [null, [], false, "horses", { unknown: true },
    ...[undefined, null, false, [], {}, { version: 99 }].map((horses) => ({ horses }))]) {
    assert.equal(normalizeEcologyServicesSnapshot(empty, context, options), null);
    assert.equal(normalizeEcologyServicesSnapshot(undefined, context, options), null);
  }
});

test("horse options, entries, saddle metadata and dimension maps are data-only before any accessor runs", () => {
  let reads = 0;
  const get = () => { reads++; return null; };
  const { saved, horses } = ecologyHorseArchive(context, { horseCount: 2 });
  const accessor = Object.defineProperty({}, "horses", { enumerable: true, get });
  const hidden = Object.defineProperty({}, "horses", { value: horses });
  const symbol = { horses, [Symbol("hidden sidecar")]: true };
  const inherited = Object.create({ horses });
  for (const options of [accessor, hidden, symbol, inherited])
    assert.equal(normalizeEcologyServicesSnapshot(saved, context, options), null);
  for (const mutate of [
    (value) => Object.defineProperty(value, "entries", { enumerable: true, get }),
    (value) => Object.defineProperty(value.entries, "0", { enumerable: true, get }),
    (value) => Object.defineProperty(value.entries[0], "tamed", { enumerable: true, get }),
    (value) => Object.defineProperty(value.entries[1].saddle, "data", { enumerable: true, get }),
  ]) {
    const invalid = structuredClone(horses);
    mutate(invalid);
    assert.equal(normalizeEcologyServicesSnapshot(saved, context, { horses: invalid }), null);
  }
  for (const field of ["version", "ecology", "mobsByDimension"]) {
    const invalid = structuredClone(saved);
    Object.defineProperty(invalid, field, { enumerable: true, get });
    assert.equal(normalizeEcologyServicesSnapshot(invalid, context, { horses }), null);
  }
  const invalid = structuredClone(saved);
  Object.defineProperty(invalid.mobsByDimension, "nether", { enumerable: true, get });
  assert.equal(normalizeEcologyServicesSnapshot(invalid, context, { horses }), null);
  assert.equal(reads, 0);
});

test("horse-aware normalization retains the bounded living/tamed/dead ledger beyond the legacy base cap", () => {
  for (const generatorVersion of [1, 2, 3, 4, 5]) {
    const bounds = createWorldContext({ seed: "", generatorVersion });
    const { saved, horses } = ecologyHorseArchive(bounds, {
      legacyCount: MAX_MOBS, horseCount: MAX_LIVING_HORSES,
      tombstones: MAX_RETAINED_HORSE_IDS - MAX_LIVING_HORSES,
    });
    const input = structuredClone({ saved, horses });
    assert.ok(normalizeHorseSnapshot(horses, bounds));
    assert.equal(normalizeEcologyServicesSnapshot(saved, bounds), null, "legacy capacity is unchanged");
    const normalized = normalizeEcologyServicesSnapshot(saved, bounds, { horses });
    assert.ok(normalized);
    assert.equal(normalized.mobsByDimension.overworld.entities.length, MAX_MOBS + MAX_LIVING_HORSES);
    assert.deepEqual(Object.keys(normalized.mobsByDimension), DIMENSIONS);
    assert.deepEqual({ saved, horses }, input, "normalization cannot change either owner");
    assert.deepEqual(normalizeEcologyServicesSnapshot(normalized, bounds, { horses }), normalized);
    saved.mobsByDimension.overworld.entities[0].position.x += 1;
    assert.notEqual(saved.mobsByDimension.overworld.entities[0].position.x,
      normalized.mobsByDimension.overworld.entities[0].position.x);
  }
});

test("horse options never relax legacy, living, identity or rider-envelope limits", () => {
  const { saved, horses } = ecologyHorseArchive(context, {
    legacyCount: MAX_MOBS, horseCount: MAX_LIVING_HORSES,
    tombstones: MAX_RETAINED_HORSE_IDS - MAX_LIVING_HORSES,
  });
  const tooManyLegacy = structuredClone(saved);
  tooManyLegacy.mobsByDimension.overworld.entities.push(mobRecord(context, "overworld", { id: "extra:legacy" }));
  assert.equal(normalizeEcologyServicesSnapshot(tooManyLegacy, context, { horses }), null);
  const tooManyLiving = structuredClone(horses);
  tooManyLiving.entries[tooManyLiving.entries.length - 1] = horseRecord("extra:living");
  assert.equal(normalizeEcologyServicesSnapshot(saved, context, { horses: tooManyLiving }), null);
  const tooManyIds = structuredClone(horses);
  tooManyIds.entries.push({ id: "extra:dead", dimension: "end", alive: false });
  assert.equal(normalizeEcologyServicesSnapshot(saved, context, { horses: tooManyIds }), null);
  const ridden = ecologyHorseArchive(context, { tombstones: 0 });
  Object.assign(ridden.horses.entries[0], {
    rider: "player", motion: { vx: 0, vy: 0, vz: 0, grounded: true, fallDistance: 0 },
  });
  ridden.saved.mobsByDimension.overworld.entities[0].position.y = context.specForDimension("overworld").maxY - 2.5;
  assert.equal(normalizeEcologyServicesSnapshot(ridden.saved, context, { horses: ridden.horses }), null);
});

test("horse and legacy identities cannot alias a base or killed cache in any inactive dimension", () => {
  const { saved, horses } = ecologyHorseArchive(context, { legacyCount: 1 });
  for (const dimension of DIMENSIONS)
    for (const id of ["horse:retained:0", "horse:dead:0", "horse:dead:1"]) {
      const killed = structuredClone(saved);
      killed.mobsByDimension[dimension].killed.push(id);
      assert.equal(normalizeEcologyServicesSnapshot(killed, context, { horses }), null);
      const alias = structuredClone(saved);
      alias.mobsByDimension[dimension].entities.push(mobRecord(context, dimension, { id }));
      assert.equal(normalizeEcologyServicesSnapshot(alias, context, { horses }), null);
    }
  for (const dimension of ["nether", "end"]) {
    const duplicate = structuredClone(saved);
    duplicate.mobsByDimension[dimension].entities.push(mobRecord(context, dimension, { id: "legacy:0" }));
    assert.equal(normalizeEcologyServicesSnapshot(duplicate, context, { horses }), null);
  }
  const missing = structuredClone(saved);
  delete missing.mobsByDimension.overworld;
  assert.equal(normalizeEcologyServicesSnapshot(missing, context, { horses }), null);
  const wolfFlag = structuredClone(saved);
  wolfFlag.mobsByDimension.overworld.entities.find((mob) => mob.kind === "horse").tamed = true;
  assert.equal(normalizeEcologyServicesSnapshot(wolfFlag, context, { horses }), null);
});

test("horse tombstones cannot alias Ecology actors, egg IDs or reserved unborn children", () => {
  for (const alias of ["entry", "egg", "child"]) {
    const { saved, horses } = ecologyHorseArchive(context);
    const state = createEcologyState("turtle", alias === "entry" ? "horse:dead:1" : "turtle:parent",
      { x: 24, y: 1, z: 24 }, { ...context, dimension: "overworld" });
    assert.ok(state);
    if (alias === "entry") state.alive = false;
    else {
      state.clutchSerial = 1;
      saved.mobsByDimension.overworld.entities.push(mobRecord(context, "overworld", {
        id: state.id, kind: "turtle", health: 30, position: { ...state.home },
      }));
      saved.ecology.eggs.push({
        id: alias === "egg" ? "horse:dead:1" : "turtle:egg",
        childId: alias === "child" ? "horse:dead:1" : "turtle:child",
        parentId: state.id, serial: 1, dimension: "overworld",
        position: { ...state.home }, remaining: 20, status: "incubating",
      });
    }
    saved.ecology.entries.push(state);
    assert.ok(normalizeEcologySnapshot(saved.ecology, context));
    assert.ok(normalizeEcologyServicesSnapshot(saved, context), "the cross-owner alias needs the horse sidecar");
    assert.equal(normalizeEcologyServicesSnapshot(saved, context, { horses }), null);
  }
});
