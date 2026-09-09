import assert from "node:assert/strict";
import test from "node:test";
import { getItem, ITEM } from "../src/items.js";
import { combatFixture, combatState, equip } from "./combat-effects-fixture.js";

function observeDispatch(t, f) {
  const actions = f.game.useActions;
  // These spies call the production methods unchanged.
  return {
    legacy: t.mock.method(f.wildlife, "interact"),
    generic: t.mock.method(actions, "useHand"),
    starts: t.mock.method(actions.use, "start"),
    interactions: t.mock.method(f.game.mobActions, "interactHand"),
  };
}

function drawViaInput(f, hand) {
  const before = combatState(f);
  assert.equal(f.game.useActions.begin("mouse"), true,
    "normal begin must dispatch the held bow while physically targeting this mob");
  assert.equal(f.game.mobTarget?.entity, f.mob);
  assert.equal(f.game.useActions.use.kind, "bow");
  assert.equal(f.game.useActions.use.hand, hand);
  assert.deepEqual(combatState(f), before, "drawing cannot publish an arrow, wear or damage");
  for (let tick = 0; tick < 4; tick++) {
    f.game.elapsed += 0.25;
    f.game.useActions.update(0.25);
  }
  assert.equal(f.game.useActions.use.progress, 1);
  assert.deepEqual(combatState(f), before, "charging cannot pay before release");
  return before;
}

// Authored habitat and finite equipment; all picking, dispatch and owners are
// real. This is not a browser transport or natural-acquisition claim.
for (const kind of ["cod", "squid", "drowned", "dolphin", "turtle"]) {
  const hands = ["drowned", "dolphin", "turtle"].includes(kind)
    ? ["main", "offhand"] : ["main"];
  for (const hand of hands)
    test(`${kind} normal ${hand} bow input draws and releases exactly once`, async (t) => {
      const f = await combatFixture(t, kind);
      if (hand === "offhand") f.hold("IRON_SWORD");
      equip(f, { bow: true, hand });
      const observed = observeDispatch(t, f);
      const stack = f.gameplay.getHandStack(hand), health = f.mob.health;
      const otherHand = hand === "main" ? "offhand" : "main";
      const otherStack = f.gameplay.getHandStack(otherHand);
      drawViaInput(f, hand);
      assert.equal(observed.starts.mock.callCount(), 1);
      if (hand === "offhand")
        assert.deepEqual(observed.generic.mock.calls.map((call) => call.arguments[0]),
          ["main", "offhand"], "a no-action main hand permits the offhand bow");
      assert.equal(f.game.useActions.end("mouse"), true);
      assert.equal(f.gameplay.countPlain(ITEM.ARROW), 2);
      assert.equal(f.gameplay.getHandStack(hand).durability, stack.durability - 1);
      assert.deepEqual(f.gameplay.getHandStack(otherHand), otherStack);
      assert.equal(f.mob.health, Math.max(0, health - getItem(ITEM.BOW).damage));
      if (f.game.mobActions.owns(f.mob))
        assert.equal(observed.legacy.mock.callCount(), 0, "owned targets never invoke legacy interaction");
      const paid = combatState(f);
      assert.equal(f.game.useActions.end("mouse"), false);
      assert.deepEqual(combatState(f), paid, "one release cannot pay twice");
    });
}

test("turtle refused supported feed suppresses the offhand bow without legacy fallback", async (t) => {
  const f = await combatFixture(t, "turtle");
  equip(f, { bow: true, hand: "offhand" });
  f.hold("SEAGRASS", { count: 2 });
  const observed = observeDispatch(t, f);
  assert.equal(f.game.useActions.begin("mouse"), true);
  assert.equal(f.game.useActions.use.active, false);
  assert.equal(f.game.useActions.end("mouse"), false);
  assert.equal(f.gameplay.getHandStack().count, 1);
  assert.ok(f.ecology.ecology.state(f.mob.id).loveTime > 0);
  f.game.elapsed += 0.21;
  const before = combatState(f);
  assert.equal(f.game.useActions.begin("mouse"), false);
  assert.equal(f.game.useActions.use.active, false);
  assert.equal(f.game.useActions.end("mouse"), false);
  assert.deepEqual(combatState(f), before);
  assert.equal(observed.generic.mock.callCount(), 0, "refused feed is not generic-use permission");
  assert.equal(observed.legacy.mock.callCount(), 0, "refused feed is not legacy-use permission");
  const refused = observed.interactions.mock.calls.at(-1).result;
  assert.equal(refused?.handled, true, "a recognized but unavailable feed stays handled");
  assert.equal(refused.ok, false);
});

for (const kind of ["drowned", "dolphin", "turtle"]) {
  test(`${kind} normal bow input without arrows refuses without wear or damage`, async (t) => {
    const f = await combatFixture(t, kind);
    equip(f, { bow: true, arrows: 0 });
    const observed = observeDispatch(t, f), before = combatState(f);
    assert.equal(f.game.useActions.begin("mouse"), false);
    assert.equal(f.game.useActions.end("mouse"), false);
    assert.deepEqual(combatState(f), before);
    assert.equal(observed.generic.mock.callCount(), 1);
    assert.equal(observed.starts.mock.callCount(), 0);
    assert.equal(observed.legacy.mock.callCount(), 0);
    assert.ok(f.calls.toasts.some((text) => text.includes("arrows")));
  });

  test(`${kind} two no-action hands refuse without legacy interaction or payment`, async (t) => {
    const f = await combatFixture(t, kind);
    f.hold("IRON_SWORD");
    f.hold("IRON_SWORD", { hand: "offhand" });
    const observed = observeDispatch(t, f), before = combatState(f);
    assert.equal(f.game.useActions.begin("mouse"), false);
    assert.equal(f.game.useActions.end("mouse"), false);
    assert.deepEqual(combatState(f), before);
    assert.deepEqual(observed.generic.mock.calls.map((call) => call.arguments[0]),
      ["main", "offhand"]);
    assert.equal(observed.starts.mock.callCount(), 0);
    assert.equal(observed.legacy.mock.callCount(), 0);
  });

  test(`${kind} canceled normal bow draw spends neither arrow nor wear`, async (t) => {
    const f = await combatFixture(t, kind);
    equip(f, { bow: true });
    const before = drawViaInput(f, "main");
    assert.equal(f.game.useActions.end("mouse", true), false);
    assert.deepEqual(combatState(f), before);
    assert.equal(f.game.useActions.use.active, false);
    assert.equal(f.game.useActions.end("mouse"), false);
  });

  test(`${kind} normal bow payment veto preserves its final wear; a fresh draw pays once`, async (t) => {
    const f = await combatFixture(t, kind);
    equip(f, { bow: true, durability: 1 });
    const observed = observeDispatch(t, f), health = f.mob.health;
    const before = drawViaInput(f, "main");
    const prepare = f.gameplay.prepareBowShot;
    const veto = t.mock.method(f.gameplay, "prepareBowShot", function (...args) {
      const part = Reflect.apply(prepare, this, args);
      assert.ok(part, "the actual arrow/wear owner prepares the release");
      return { ...part, validate: () => false };
    });
    assert.equal(f.game.useActions.end("mouse"), false);
    assert.equal(veto.mock.callCount(), 1);
    assert.deepEqual(combatState(f), before);
    veto.mock.restore();
    drawViaInput(f, "main");
    assert.equal(f.game.useActions.end("mouse"), true);
    assert.equal(f.gameplay.countPlain(ITEM.ARROW), 2);
    assert.equal(f.gameplay.getHandStack(), null);
    assert.ok(f.mob.health < health);
    assert.equal(observed.legacy.mock.callCount(), 0);
    const paid = combatState(f);
    assert.equal(f.game.useActions.end("mouse"), false);
    assert.deepEqual(combatState(f), paid);
  });
}

for (const [kind, hand] of [
  ["dolphin", "main"], ["dolphin", "offhand"], ["turtle", "offhand"],
])
  test(`${kind} supported ${hand} feeding precedes the opposite bow and stays handled on refusal`, async (t) => {
    const f = await combatFixture(t, kind);
    const food = kind === "dolphin" ? "RAW_COD" : "SEAGRASS";
    equip(f, { bow: true, hand: hand === "main" ? "offhand" : "main" });
    f.hold(food, { hand, count: 2 });
    f.gameplay.hunger = 10;
    const observed = observeDispatch(t, f);
    assert.equal(f.game.useActions.begin("mouse"), true);
    assert.equal(f.game.useActions.end("mouse"), false);
    assert.equal(f.gameplay.getHandStack(hand).count, 1);
    assert.equal(f.gameplay.countPlain(ITEM.ARROW), 3);
    f.game.elapsed += 0.21;
    const before = combatState(f);
    assert.equal(f.game.useActions.begin("mouse"), false);
    for (let tick = 0; tick < 8; tick++) {
      f.game.elapsed += 0.25;
      f.game.useActions.update(0.25);
    }
    assert.equal(f.game.useActions.end("mouse"), false);
    assert.deepEqual(combatState(f), before, "a refused feed cannot turn into eating or a bow draw");
    assert.equal(observed.generic.mock.callCount(), 0);
    assert.equal(observed.starts.mock.callCount(), 0);
    assert.equal(observed.legacy.mock.callCount(), 0);
    assert.equal(observed.interactions.mock.calls.at(-1).result.handled, true);
  });

for (const kind of ["dolphin", "turtle"])
  test(`${kind} missing feed payment remains handled and cannot use the offhand bow`, async (t) => {
    const f = await combatFixture(t, kind);
    equip(f, { bow: true, hand: "offhand" });
    f.hold(kind === "dolphin" ? "RAW_SALMON" : "SEAGRASS", { count: 2 });
    const observed = observeDispatch(t, f);
    const veto = t.mock.method(f.gameplay, "prepareHandCost", () => null);
    const before = combatState(f);
    assert.equal(f.game.useActions.begin("mouse"), false);
    assert.equal(f.game.useActions.end("mouse"), false);
    assert.equal(veto.mock.callCount(), 1);
    assert.deepEqual(combatState(f), before);
    assert.equal(observed.generic.mock.callCount(), 0);
    assert.equal(observed.legacy.mock.callCount(), 0);
    assert.equal(observed.interactions.mock.calls.at(-1).result.handled, true);
    veto.mock.restore();
    f.game.elapsed += 0.21;
    assert.equal(f.game.useActions.begin("mouse"), true);
    assert.equal(f.game.useActions.end("mouse"), false);
    assert.equal(f.gameplay.getHandStack().count, 1);
    assert.equal(f.gameplay.countPlain(ITEM.ARROW), 3);
  });

test("normal bow input ignores an unrelated release source and cancels on its own source", async (t) => {
  const f = await combatFixture(t, "turtle");
  equip(f, { bow: true });
  const before = drawViaInput(f, "main");
  assert.equal(f.game.useActions.end("remote-key"), false);
  assert.equal(f.game.useActions.use.active, true);
  assert.equal(f.game.useActions.held, true);
  assert.deepEqual(combatState(f), before);
  assert.equal(f.game.useActions.end("mouse", true), false);
  assert.deepEqual(combatState(f), before);
});

test("an owned target invalidated after the actual input pick cannot start generic bow use", async (t) => {
  const f = await combatFixture(t, "turtle");
  equip(f, { bow: true });
  const observed = observeDispatch(t, f);
  const updateTarget = f.game.updateTarget;
  let invalidated;
  t.mock.method(f.game, "updateTarget", function (...args) {
    const result = Reflect.apply(updateTarget, this, args);
    assert.equal(f.game.mobTarget?.entity, f.mob);
    f.mob.dormant = true;
    invalidated = combatState(f);
    return result;
  });
  assert.equal(f.game.useActions.begin("mouse"), false);
  assert.ok(invalidated);
  assert.equal(f.game.useActions.end("mouse"), false);
  assert.deepEqual(combatState(f), invalidated);
  assert.equal(observed.generic.mock.callCount(), 0);
  assert.equal(observed.legacy.mock.callCount(), 0);
  assert.equal(observed.interactions.mock.calls[0].result.reason, "stale-entity-target");
});

test("an inactive ecology owner refuses bow dispatch without generic or legacy fallback", async (t) => {
  const f = await combatFixture(t, "turtle");
  equip(f, { bow: true });
  assert.equal(f.ecology.suspend(), true);
  const observed = observeDispatch(t, f), before = combatState(f);
  assert.equal(f.game.useActions.begin("mouse"), false);
  assert.equal(f.game.useActions.end("mouse"), false);
  assert.deepEqual(combatState(f), before);
  assert.equal(observed.generic.mock.callCount(), 0);
  assert.equal(observed.legacy.mock.callCount(), 0);
  assert.equal(observed.interactions.mock.calls[0].result.reason, "ecology-owner-unavailable");
});

const replace = (owner, key, value) => {
  const original = owner[key];
  owner[key] = value;
  return () => { owner[key] = original; };
};

for (const [name, invalidate] of [
  ["hand revision", (f) => {
    assert.equal(f.gameplay.inventoryTransaction((owned) => {
      owned.slots[f.gameplay.selected] = { ...owned.slots[f.gameplay.selected] };
      return true;
    }), true);
  }],
  ["session", (f) => replace(f.game, "overlayOpen", true)],
  ["progression", (f) => replace(f.game, "progressionIntegration", null)],
  ["world", (f) => replace(f.game, "world", {})],
  ["epoch", (f) => replace(f.world, "_epoch", f.world.epoch + 1)],
  ["target", (f) => replace(f.mob.position, "x", f.mob.position.x + 2)],
])
  test(`normal bow release refuses a stale ${name} before publishing arrow, wear or health`, async (t) => {
    const f = await combatFixture(t, "turtle");
    equip(f, { bow: true });
    const observed = observeDispatch(t, f);
    drawViaInput(f, "main");
    const commit = f.coordinator.commit;
    let changed, restore;
    const interleave = t.mock.method(f.coordinator, "commit", function (parts) {
      if (!changed && parts.some((part) => part.owner === f.gameplay) &&
          parts.some((part) => part.owner === f.wildlife)) {
        restore = invalidate(f);
        changed = combatState(f);
      }
      return Reflect.apply(commit, this, [parts]);
    });
    try {
      assert.equal(f.game.useActions.end("mouse"), false);
      assert.ok(changed, "invalidate only after the real bow and target participants exist");
      assert.deepEqual(combatState(f), changed);
      assert.equal(f.gameplay.countPlain(ITEM.ARROW), 3);
      assert.equal(observed.legacy.mock.callCount(), 0);
    } finally {
      interleave.mock.restore();
      restore?.();
    }
  });

for (const hand of ["main", "offhand"])
  for (const intent of ["food", "saddle", "empty mount"])
    test(`horse ${intent} retains priority over the opposite ${hand} bow`, async (t) => {
      const f = await combatFixture(t, "horse");
      const bow = equip(f, { bow: true, hand });
      const otherHand = hand === "main" ? "offhand" : "main";
      if (intent !== "empty mount")
        f.hold(intent === "food" ? "WHEAT" : "SADDLE", {
          hand: otherHand, count: intent === "food" ? 2 : 1,
        });
      const observed = observeDispatch(t, f), health = f.mob.health;
      assert.equal(f.game.useActions.begin("mouse"), intent !== "saddle");
      assert.equal(f.game.useActions.end("mouse"), false);
      assert.equal(f.game.useActions.use.active, false);
      assert.equal(f.gameplay.countPlain(ITEM.ARROW), 3);
      assert.deepEqual(f.gameplay.getHandStack(hand), bow);
      assert.equal(f.mob.health, health);
      assert.equal(observed.generic.mock.callCount(), 0);
      assert.equal(observed.legacy.mock.callCount(), 0);
      if (intent === "food") {
        assert.equal(f.gameplay.getHandStack(otherHand).count, 1);
        assert.equal(f.horses.state(f.mob.id).temper, 3);
      }
      if (intent === "saddle")
        assert.equal(f.gameplay.getHandStack(otherHand).count, 1, "untamed saddle refusal cannot draw a bow");
      assert.equal(f.horses.mountFor()?.id ?? null, intent === "empty mount" ? f.mob.id : null);
    });
