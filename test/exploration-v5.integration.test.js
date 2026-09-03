import assert from "node:assert/strict";
import test from "node:test";
import { admittedExplorationEntries } from "../src/exploration-admission.js";
import { nativeExplorationContext } from "../src/exploration-host-state.js";
import { EXPLORATION_SERVICE_LIMITS } from "../src/game-exploration-services.js";
import { settlementPositionValid } from "../src/settlement-state.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";
import {
  explorationServicesFixture,
  expectedExplorationSlots,
  reloadExplorationOwners,
} from "./exploration-services-fixture.js";

for (const generatorVersion of [4, 5]) {
  test(`native v${generatorVersion} chest admission, materialization and owner reload preserve claims`, async (t) => {
    const f = await explorationServicesFixture(t, { generatorVersion });
    assert.equal(f.descriptor.generatorVersion, generatorVersion);
    const entry = f.entries()[0];
    assert.ok(entry, "The native village must admit its container anchor");
    const hit = f.hit(entry.marker);
    assert.equal(f.settlement.getContainerState(f.world, hit, f.gameplay), null);
    assert.equal(f.service.openContainer(hit).ok, true);
    assert.deepEqual(
      f.settlement.inspectContainer(f.world, hit).slots,
      expectedExplorationSlots(entry, f.context),
    );
    const saved = f.snapshot();
    assert.equal(saved.exploration.generatorVersion, generatorVersion);
    f.service.dispose();
    f.service = null;
    reloadExplorationOwners(f, saved);
    t.mock.method(f.service.exploration, "_rollLoot", () => assert.fail("A restored claim cannot reroll"));
    assert.equal(f.service.openContainer(hit).ok, true);
    assert.deepEqual(f.service.serialize().exploration, saved.exploration);
    assert.deepEqual(f.settlement.serialize(), saved.settlement);
  });
}

test("v5 native admission rejects a v4 packet despite matching layout and structure identity", async (t) => {
  const f = await explorationServicesFixture(t, { generatorVersion: 5 });
  const event = f.admission(f.entries()[0].marker);
  const original = event.chunk.structures;
  try {
    event.chunk.structures = original.map((descriptor) => ({ ...descriptor, generatorVersion: 4 }));
    assert.throws(
      () => admittedExplorationEntries(f.world, event, f.context, EXPLORATION_SERVICE_LIMITS),
      /native structure declaration/,
    );
  } finally {
    event.chunk.structures = original;
  }
  assert.ok(admittedExplorationEntries(f.world, event, f.context, EXPLORATION_SERVICE_LIMITS).length);
  assert.throws(
    () => nativeExplorationContext({ ...f.world, generatorVersion: 4 }),
    /sampling is unavailable/,
  );
});

test("expanded settlement bounds include the native floor without widening historical terrain", () => {
  for (const generatorVersion of [3, 4, 5]) {
    const context = createWorldContext({ seed: "settlement-v5-floor", generatorVersion });
    for (const dimension of ["overworld", "nether", "end"]) {
      const { minY, maxY } = getWorldSpec(generatorVersion, dimension);
      assert.equal(settlementPositionValid(dimension, 0, minY, 0, context), generatorVersion >= 4);
      assert.equal(settlementPositionValid(dimension, 0, minY - 1, 0, context), false);
      assert.equal(settlementPositionValid(dimension, 0, maxY, 0, context), false);
      assert.equal(settlementPositionValid(dimension, 0, minY, 0, context, true), false);
      assert.equal(settlementPositionValid(dimension, 0, minY + 1, 0, context, true), generatorVersion >= 4);
    }
  }
});
