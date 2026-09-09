import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { fluidSteps } from "./fluid-fixture.js";

export const kelpColumn = (height = 6, x = 8, y = 1, z = 8) =>
  Array.from({ length: height }, (_, i) => [
    x, y + i, z, i === 0 ? BLOCK.KELP : BLOCK.WATER,
  ]);

export const kelpTimer = (fluids, x = 8, y = 1, z = 8, dimension = "overworld") =>
  fluids.serialize().dimensions.find((work) => work.dimension === dimension)
    ?.marine?.kelp.find((entry) => entry[0] === x && entry[1] === y && entry[2] === z);

/** Advance bounded ACTIVE ticks, never inject a clock/deadline or wall catch-up. */
export function fluidTo(fluids, clock) {
  const delta = clock - fluids.diagnostics().clock;
  assert.ok(Number.isSafeInteger(delta) && delta >= 0 && delta <= 16384);
  // Leave headroom for an archived fractional tick; a one-second update would
  // intentionally discard that fraction at the runtime's catch-up ceiling.
  for (let left = delta; left > 0; left -= 3)
    fluids.update(Math.min(left, 3) * 0.25);
  assert.equal(fluids.diagnostics().clock, clock);
}

export function activateKelp(fluids, x = 8, y = 1, z = 8) {
  assert.equal(fluids.onMutation([{ x, y, z }]), true);
  fluidSteps(fluids, 1);
  const timer = kelpTimer(fluids, x, y, z);
  assert.ok(timer, "a supported tip must acquire a saved cooldown");
  return timer;
}
