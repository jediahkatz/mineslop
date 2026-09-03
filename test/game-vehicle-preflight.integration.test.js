import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVehicleServicesSnapshot } from "../src/game-vehicle-state.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { createWorldContext } from "../src/world-spec.js";

const context = createWorldContext({ seed: "", generatorVersion: 3 });
const world = {
  version: 3,
  seed: context.seed,
  generatorVersion: context.generatorVersion,
  dimension: "overworld",
  edits: [],
};

test("vehicle absence migrates empty legacy seeds without inventing a different world", () => {
  const empty = normalizeVehicleServicesSnapshot(null, context);
  assert.ok(empty);
  assert.equal(empty.boats.seed, "");
  assert.equal(empty.fishing.seed, "");
  assert.equal(empty.horses.seed, "");
  assert.deepEqual(empty.boats.boats, []);
  assert.deepEqual(empty.fishing.casts, []);
  assert.deepEqual(empty.horses.entries, []);
  const saved = normalizeWorldComponents({ world });
  assert.deepEqual(saved.boats, empty.boats);
  assert.deepEqual(saved.fishing, empty.fishing);
  assert.deepEqual(saved.horses, empty.horses);
});

test("present invalid vehicle sidecars cannot disappear into empty defaults", () => {
  for (const key of ["boats", "fishing", "horses"])
    for (const value of [undefined, null, [], {}, { version: 2 }]) {
      const saved = { world, [key]: value };
      assert.equal(normalizeVehicleServicesSnapshot(saved, context), null);
      assert.throws(() => normalizeWorldComponents(saved), /boats or fishing or horses/);
    }
});

test("original outer and nested vehicle accessors reject before archive cloning", () => {
  const empty = normalizeVehicleServicesSnapshot({}, context);
  let reads = 0;
  for (const key of ["boats", "fishing", "horses"]) {
    const outer = { world };
    Object.defineProperty(outer, key, {
      enumerable: true,
      get() {
        reads++;
        return empty[key];
      },
    });
    assert.equal(normalizeVehicleServicesSnapshot(outer, context), null);
    assert.throws(() => normalizeWorldComponents(outer), /boats or fishing or horses/);
    const value = structuredClone(empty[key]);
    const arrayName = { boats: "boats", fishing: "casts", horses: "entries" }[key];
    Object.defineProperty(value, arrayName, {
      enumerable: true,
      get() {
        reads++;
        return [];
      },
    });
    const nested = { world, [key]: value };
    assert.equal(normalizeVehicleServicesSnapshot(nested, context), null);
    assert.throws(() => normalizeWorldComponents(nested), /boats or fishing or horses/);
  }
  assert.equal(reads, 0);
});
