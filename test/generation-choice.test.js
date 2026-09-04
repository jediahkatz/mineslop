import assert from "node:assert/strict";
import test from "node:test";
import { generationChoiceFromInput, newWorldGeneratorVersion } from "../src/generation-choice.js";
import { GENERATOR_VERSION } from "../src/terrain.js";
import { GameTravel } from "../src/game-travel.js";

test("new-world opt-in is strictly 3 or 7; the global and legacy defaults stay 3", () => {
  assert.equal(GENERATOR_VERSION, 3);
  assert.equal(newWorldGeneratorVersion(), 3);
  for (const version of [3, 7]) {
    assert.equal(newWorldGeneratorVersion(version), version);
    assert.equal(generationChoiceFromInput(String(version)), version);
  }
  for (const value of [null, false, true, 0, 1, 2, 4, 5, 6, 8, -1, NaN, Infinity, "3", "7", {}, [], 7.1])
    assert.throws(() => newWorldGeneratorVersion(value), RangeError);
  for (const value of [undefined, null, 3, 7, "07", "7 ", "", "4", "latest", {}])
    assert.throws(() => generationChoiceFromInput(value), RangeError);
});

test("tampered generation is refused before gate, confirmation, archive or resources", async () => {
  const game = new Proxy({}, {
    get() { assert.fail("an invalid choice must not touch the Game"); },
  });
  const travel = new GameTravel(game);
  for (const choice of [null, "7", 4, {}, NaN])
    assert.equal((await travel.generate("seed", choice)).ok, false);
});
