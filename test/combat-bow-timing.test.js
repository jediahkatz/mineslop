import assert from "node:assert/strict";
import test from "node:test";
import { ItemUse } from "../src/item-use.js";
import { getItem, ITEM } from "../src/items.js";
import {
  BOW_CLOCK_ROUNDOFF_SECONDS,
  hasFullBowDraw,
} from "./combat-bow-timing.mjs";

function startBow() {
  const use = new ItemUse();
  assert.equal(
    use.start(
      "bow",
      "main",
      { id: ITEM.BOW, count: 1, durability: getItem(ITEM.BOW).durability },
      0
    ),
    true
  );
  return use;
}

// DERIVED NUMERIC CASE, NOT BROWSER TRACE. Start the separate simulation sum
// at 3s and give the real ItemUse the same 50ms steps, without changing its clock.
function derivedDraw(frames) {
  const initial = 3;
  let current = initial;
  const use = startBow();
  for (let frame = 0; frame < frames; frame++) {
    current += 0.05;
    use.advance(0.05);
  }
  return { initial, current, use };
}

for (const [frames, fullCharge, originalPredicate] of [
  [19, false, false],
  [20, true, false],
  [21, true, true],
]) {
  test(`derived ${frames * 50}ms real ItemUse draw: full-charge check ${fullCharge ? "accepts" : "refuses"}`, (t) => {
    const { initial, current, use } = derivedDraw(frames);
    const releaseUse = use.snapshot();
    const simulationDelta = current - initial;
    const correctedPredicate = hasFullBowDraw(initial, current, releaseUse);
    t.diagnostic(
      JSON.stringify({
        provenance: "DERIVED NUMERIC CASE; NOT BROWSER TRACE",
        frames,
        initial,
        current,
        simulationDelta,
        itemUseElapsed: use.elapsed,
        progress: releaseUse.progress,
        originalPredicate: simulationDelta >= 1,
        correctedPredicate,
        allowanceSeconds: BOW_CLOCK_ROUNDOFF_SECONDS,
      })
    );
    assert.equal(simulationDelta >= 1, originalPredicate);
    assert.equal(releaseUse.progress === 1, fullCharge);
    assert.equal(correctedPredicate, fullCharge);
    assert.deepEqual(use.snapshot(), releaseUse, "the check is read-only");
    if (frames === 20) {
      assert.ok(
        simulationDelta < 1,
        "retain the strict-predicate counterexample"
      );
      assert.ok(1 - simulationDelta <= BOW_CLOCK_ROUNDOFF_SECONDS);
    }
    const shot = use.release();
    if (fullCharge) assert.equal(shot.strength, 1);
    else {
      // 950ms is refused as *full charge*, not forbidden as a partial bow shot.
      assert.ok(shot.strength > 0 && shot.strength < 1);
    }
  });
}

test("clock allowance never relaxes the real ItemUse's exact full-charge requirement", () => {
  const use = startBow();
  for (let frame = 0; frame < 3; frame++) use.advance(0.25);
  use.advance(0.25 - Number.EPSILON);
  assert.ok(use.progress < 1);
  assert.ok(1 - use.progress < BOW_CLOCK_ROUNDOFF_SECONDS);
  assert.equal(hasFullBowDraw(3, 4.05, use.snapshot()), false);

  const short = derivedDraw(19);
  assert.equal(hasFullBowDraw(3, 4.05, short.use.snapshot()), false);
  const full = derivedDraw(20);
  assert.equal(
    hasFullBowDraw(full.initial, full.current, full.use.snapshot()),
    true
  );
  full.use.release();
  assert.equal(hasFullBowDraw(3, 4.05, full.use.snapshot()), false);

  const shield = new ItemUse();
  assert.equal(shield.start("shield", "offhand", ITEM.SHIELD), true);
  shield.advance(0.25);
  assert.equal(shield.progress, 1);
  assert.equal(hasFullBowDraw(3, 4.05, shield.snapshot()), false);
});

test("the test-only clock allowance is absolute, finite and bounded", () => {
  const { use } = derivedDraw(20);
  const releaseUse = use.snapshot();
  // Deliberate helper-boundary inputs, not observed browser timestamps.
  assert.equal(
    hasFullBowDraw(3, 4 - BOW_CLOCK_ROUNDOFF_SECONDS / 2, releaseUse),
    true
  );
  assert.equal(
    hasFullBowDraw(3, 4 - BOW_CLOCK_ROUNDOFF_SECONDS * 2, releaseUse),
    false
  );
  const later = 2 ** 20;
  assert.equal(hasFullBowDraw(later, later + 1 - 2 ** -30, releaseUse), false);
  for (const [initial, current] of [
    [3, NaN],
    [NaN, 4],
    [3, Infinity],
    [-Infinity, 4],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
    [4, 3],
  ])
    assert.equal(hasFullBowDraw(initial, current, releaseUse), false);
});
