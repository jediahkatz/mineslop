import assert from "node:assert/strict";
import test from "node:test";
import { getItem, ITEM } from "../src/items.js";
import { stackIdentity } from "../src/item-stack-data.js";
import {
  BOW_DRAW_SECONDS,
  bowStrength,
  canShieldBlock,
  FOOD_USE_SECONDS,
  ItemUse,
  itemUseKind,
  SHIELD_RAISE_SECONDS,
} from "../src/item-use.js";

function advance(use, seconds) {
  let ready = false;
  for (let remaining = seconds; remaining > 1e-9; remaining -= 0.05)
    ready = use.advance(Math.min(remaining, 0.05));
  return ready;
}

test("food requires a complete held-use cycle and does not repeat before another cycle", () => {
  const use = new ItemUse();
  assert.equal(use.start("food", "main", 285), true);
  assert.equal(advance(use, FOOD_USE_SECONDS - 0.05), false);
  assert.equal(use.completeFoodCycle(), false);
  assert.equal(use.advance(0.05), true);
  assert.equal(use.completeFoodCycle(), true);
  assert.equal(use.progress, 0);
  assert.equal(use.completeFoodCycle(), false);
  assert.equal(advance(use, FOOD_USE_SECONDS), true);
  assert.equal(use.completeFoodCycle(), true);
  assert.equal(use.release(), null);
  assert.equal(use.active, false);
});

test("repeated starts do not restart use, while another hand or stack does", () => {
  const use = new ItemUse();
  use.start("food", "offhand", 285);
  advance(use, 0.8);
  const elapsed = use.elapsed;
  assert.equal(use.start("food", "offhand", 285), false);
  assert.equal(use.elapsed, elapsed);
  assert.equal(use.matches({ id: 285, count: 3 }), true);
  assert.equal(use.matches({ id: 285, count: 0 }), false);
  assert.equal(use.matches({ id: 286, count: 3 }), false);
  assert.equal(use.matches(null), false);
  assert.equal(use.start("food", "main", 285), true);
  assert.equal(use.elapsed, 0);
  assert.equal(use.hand, "main");
});

test("bow release emits one charged shot; taps and cancellation never fire", () => {
  const use = new ItemUse();
  use.start("bow", "main", 300);
  advance(use, 0.1);
  assert.equal(use.release(), null, "a right-click tap is not a charged shot");
  use.start("bow", "offhand", 300);
  advance(use, 0.5);
  const shot = use.release();
  assert.equal(shot.hand, "offhand");
  assert.equal(shot.itemId, 300);
  assert.ok(Math.abs(shot.strength - 5 / 12) < 1e-9);
  assert.equal(use.release(), null);
  use.start("bow", "main", 300);
  advance(use, BOW_DRAW_SECONDS);
  assert.equal(use.progress, 1);
  use.cancel();
  assert.equal(use.release(), null, "pausing or changing items must not fire");
  use.start("bow", "main", 300);
  advance(use, 20);
  assert.equal(use.release().strength, 1);
});

test("bow strength is bounded, monotonic and rejects invalid elapsed times", () => {
  assert.equal(bowStrength(-1), 0);
  assert.equal(bowStrength(NaN), 0);
  assert.equal(bowStrength(Infinity), 0);
  assert.equal(bowStrength(0), 0);
  let previous = 0;
  for (let i = 0; i <= 100; i++) {
    const strength = bowStrength(i / 100);
    assert.ok(strength >= previous && strength <= 1);
    previous = strength;
  }
  assert.equal(bowStrength(10), 1);
});

test("shield raise delay, release and input resets control blocking", () => {
  const use = new ItemUse();
  use.start("shield", "offhand", 311);
  assert.equal(use.blocking, false);
  advance(use, SHIELD_RAISE_SECONDS - 0.05);
  assert.equal(use.blocking, false);
  use.advance(0.05);
  assert.equal(use.blocking, true);
  assert.equal(use.snapshot().blocking, true);
  assert.equal(use.release(), null);
  assert.equal(use.blocking, false);
  assert.equal(use.snapshot().progress, 0);
  assert.equal(use.snapshot().itemId, 0);
});

test("paused, invalid and oversized deltas cannot instantly complete item use", () => {
  const use = new ItemUse();
  for (const [kind, hand, id] of [
    ["invalid", "main", 1],
    ["food", "invalid", 1],
    ["food", "main", 0],
    ["food", "main", NaN],
  ])
    assert.equal(use.start(kind, hand, id), false);
  use.start("food", "main", 285);
  for (const dt of [0, -1, NaN, Infinity]) {
    assert.equal(use.advance(dt), false);
    assert.equal(use.elapsed, 0);
  }
  assert.equal(use.advance(100), false);
  assert.equal(use.elapsed, 0.25);
  assert.equal(use.start("unknown", "main", 4), false);
  assert.equal(use.itemId, 285, "invalid requests leave active state intact");
});

test("item families select actual held-use behavior", () => {
  assert.equal(itemUseKind({ kind: "food" }), "food");
  assert.equal(itemUseKind({ tool: "bow" }), "bow");
  assert.equal(itemUseKind({ kind: "shield" }), "shield");
  assert.equal(itemUseKind({ shield: true }), "shield");
  assert.equal(itemUseKind({ kind: "block" }), null);
  assert.equal(itemUseKind(null), null);
});

test("shields block attacks from the facing hemisphere, not backs or environmental damage", () => {
  const input = {
    blocking: true,
    eye: { x: 29_000_000.5, y: 22, z: -29_000_000.5 },
    forward: { x: 0, y: -0.6, z: -0.8 },
    source: { x: 29_000_000.5, y: 20, z: -29_000_005.5 },
    kind: "melee",
  };
  for (const kind of ["melee", "projectile", "explosion"])
    assert.equal(canShieldBlock({ ...input, kind }), true);
  assert.equal(canShieldBlock({ ...input, blocking: false }), false);
  assert.equal(
    canShieldBlock({
      ...input,
      source: { ...input.source, z: -28_999_995.5 },
    }),
    false
  );
  for (const kind of ["fall", "lava", "drowning", "void", undefined])
    assert.equal(canShieldBlock({ ...input, kind }), false);
  assert.equal(canShieldBlock({ ...input, source: input.eye }), false);
  assert.equal(canShieldBlock({ ...input, source: null }), false);
  assert.equal(
    canShieldBlock({ ...input, forward: { x: 0, y: 1, z: 0 } }),
    false
  );
});

test("actual stacks match canonical metadata and hand revisions, never current wear", () => {
  const use = new ItemUse();
  const shield = {
    id: ITEM.SHIELD,
    count: 1,
    durability: getItem(ITEM.SHIELD).durability,
    data: { version: 1, name: "Guard", enchantments: { unbreaking: 2 } },
  };
  assert.equal(use.start("shield", "offhand", shield, 4), true);
  advance(use, SHIELD_RAISE_SECONDS);
  assert.equal(
    use.start("shield", "offhand", structuredClone(shield), 4),
    false
  );
  assert.equal(use.blocking, true);
  assert.equal(
    use.matches({ ...shield, durability: shield.durability - 7 }, 4),
    true
  );
  assert.equal(
    use.matches(shield, 5),
    false,
    "even an identical replacement cancels"
  );
  assert.equal(
    use.matches(shield),
    false,
    "actual revision-aware callers cannot omit the revision"
  );
  assert.equal(
    use.matches({ ...shield, data: { ...shield.data, name: "Other" } }, 4),
    false
  );
  shield.data.name = "Mutated caller";
  assert.equal(
    use.matches(shield, 4),
    false,
    "start does not retain mutable metadata"
  );
  assert.equal(use.start("shield", "offhand", shield, 5), true);
  assert.equal(use.elapsed, 0);
});

test("food counts may decrease during one held use, while metadata replacements do not match", () => {
  const use = new ItemUse();
  const apple = {
    id: ITEM.APPLE,
    count: 4,
    data: { version: 1, name: "Lunch" },
  };
  assert.equal(use.start("food", "main", apple, 8), true);
  assert.equal(use.matches({ ...apple, count: 3 }, 8), true);
  assert.equal(use.matches({ id: ITEM.APPLE, count: 3 }, 8), false);
  assert.equal(use.matches({ ...apple, count: 0 }, 8), false);
  assert.equal(
    use.start("food", "main", { ...apple, data: { version: 2 } }, 8),
    false
  );
  assert.equal(use.start("food", "main", apple, -1), false);
  assert.equal(use.start("food", "main", apple, NaN), false);
});

test("charged shots carry the exact kind and hand revision for release-time validation", () => {
  const use = new ItemUse();
  const bow = {
    id: ITEM.BOW,
    count: 1,
    durability: 7,
    data: { version: 1, enchantments: { power: 2, unbreaking: 1 } },
  };
  assert.equal(use.start("bow", "main", bow, 19), true);
  advance(use, BOW_DRAW_SECONDS);
  const shot = use.release();
  assert.equal(shot.stackIdentity, stackIdentity(bow));
  assert.equal(shot.handRevision, 19);
  assert.equal(shot.strength, 1);
  assert.equal(use.snapshot().stackIdentity, null);
  assert.equal(use.snapshot().handRevision, undefined);
});
