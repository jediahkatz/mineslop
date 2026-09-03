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
  assert.deepEqual(empty.boats.boats, []);
  assert.deepEqual(empty.fishing.casts, []);
  const saved = normalizeWorldComponents({ world });
  assert.deepEqual(saved.boats, empty.boats);
  assert.deepEqual(saved.fishing, empty.fishing);
});

test("present invalid vehicle sidecars cannot disappear into empty defaults", () => {
  for (const key of ["boats", "fishing"])
    for (const value of [undefined, null, [], {}, { version: 2 }]) {
      const saved = { world, [key]: value };
      assert.equal(normalizeVehicleServicesSnapshot(saved, context), null);
      assert.throws(() => normalizeWorldComponents(saved), /boats or fishing/);
    }
});

test("original outer and nested vehicle accessors reject before archive cloning", () => {
  const empty = normalizeVehicleServicesSnapshot({}, context);
  let reads = 0;
  for (const key of ["boats", "fishing"]) {
    const outer = { world };
    Object.defineProperty(outer, key, {
      enumerable: true,
      get() {
        reads++;
        return empty[key];
      },
    });
    assert.equal(normalizeVehicleServicesSnapshot(outer, context), null);
    assert.throws(() => normalizeWorldComponents(outer), /boats or fishing/);
    const value = structuredClone(empty[key]);
    const arrayName = key === "boats" ? "boats" : "casts";
    Object.defineProperty(value, arrayName, {
      enumerable: true,
      get() {
        reads++;
        return [];
      },
    });
    const nested = { world, [key]: value };
    assert.equal(normalizeVehicleServicesSnapshot(nested, context), null);
    assert.throws(() => normalizeWorldComponents(nested), /boats or fishing/);
  }
  assert.equal(reads, 0);
});
