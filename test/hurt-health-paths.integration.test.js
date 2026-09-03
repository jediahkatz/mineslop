import assert from "node:assert/strict";
import test from "node:test";
import { GameUseActions } from "../src/game-use-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { HurtFeedback } from "../src/hurt-feedback.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  prepareStatusAdvance,
  prepareStatusApplication,
} from "../src/status-effect-actions.js";
import {
  addStatusEffects,
  createStatusEffects,
  StatusEffects,
} from "../src/status-effects.js";
import { controlFixture } from "./control-fixture.js";
import { hurtFixture, loadVitals } from "./hurt-fixture.js";
import { floorImpact, pearlFixture } from "./pearl-fixtures.js";

const potion = (id) => ({ id, form: "drinkable" });

function statusFixture(t, gameplay, id, durationTicks = 100) {
  const effects = new StatusEffects({
    coordinator: gameplay.coordinator,
    state: id
      ? addStatusEffects(createStatusEffects(), [
          { id, durationTicks, amplifier: 0 },
        ])
      : undefined,
  });
  t.after(() => effects.dispose());
  return effects;
}

function veto(t, coordinator) {
  const owner = {};
  assert.equal(coordinator.register(owner, 0), true);
  t.after(() => coordinator.release(owner));
  return {
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () => false,
    publish: () => assert.fail("rejected participant published"),
  };
}

test("real incoming melee/projectiles pulse once, full shields/Creative do not, and the attack hand stays unchanged", (t) => {
  const { gameplay, feedback, events } = hurtFixture(t);
  const f = controlFixture(t);
  const effects = { swing: 0.37, offhand: { swing: 0.23 }, sound() {} };
  const actions = new GameUseActions({
    gameplay,
    player: f.player,
    graphics: { camera: f.camera },
    effects,
    scheduleSave() {},
  });
  const front = { x: 0.5, y: 2, z: -2 };
  assert.deepEqual(actions.damage(3, "zombie", front), {
    health: 17,
    blocked: false,
    damage: 3,
  });
  assert.deepEqual(actions.damage(2, "arrow", front, "projectile"), {
    health: 15,
    blocked: false,
    damage: 2,
  });
  assert.equal(events.length, 2);
  assert.equal(feedback.update(0).visible, true);
  assert.equal(effects.swing, 0.37);
  assert.equal(effects.offhand.swing, 0.23);

  assert.equal(
    gameplay.inventoryTransaction((owned) => {
      owned.offhand = { id: ITEM.SHIELD, count: 1, durability: 50 };
      return true;
    }),
    true
  );
  assert.equal(
    actions.use.start(
      "shield",
      "offhand",
      gameplay.offhand,
      gameplay.getHandRevision("offhand")
    ),
    true
  );
  actions.use.advance(0.25);
  feedback.reset();
  for (const kind of ["melee", "projectile"]) {
    assert.deepEqual(actions.damage(4, kind, front, kind), {
      health: 15,
      blocked: true,
      damage: 0,
    });
  }
  assert.equal(gameplay.offhand.durability, 40);
  assert.equal(events.length, 2);
  assert.equal(feedback.update(0).visible, false);
  assert.equal(actions.damage(0, "arrow", front, "projectile").damage, 0);
  actions.reset();
  gameplay.setMode("creative");
  assert.deepEqual(actions.damage(8, "zombie", front), {
    health: 20,
    blocked: false,
    damage: 0,
  });
  assert.equal(events.length, 2);
  assert.equal(effects.swing, 0.37);
});

test("a physical landing uses Player.onFall and produces one real health-loss pulse", (t) => {
  const { gameplay, feedback, events } = hurtFixture(t);
  const { player } = controlFixture(t);
  player.allowFlight = false;
  player.setPosition({ x: 0.5, y: 12, z: 0.5 });
  player.onFall = (distance) =>
    gameplay.damage(Math.ceil(distance - 3), "fall");
  for (let frame = 0; frame < 100 && !player.grounded; frame++)
    player.update(0.05);
  assert.equal(player.grounded, true);
  assert.ok(gameplay.health > 0 && gameplay.health < 20);
  assert.equal(events.length, 1);
  assert.equal(events[0].damage, 20 - gameplay.health);
  assert.equal(feedback.update(0).visible, true);
  player.update(0.05);
  assert.equal(events.length, 1);
});

test("quiet poison health and effect time publish together before hurt; veto/replay/pause stay silent", (t) => {
  const { gameplay, feedback, events } = hurtFixture(t);
  const effects = statusFixture(t, gameplay, "poison");
  const coordinator = gameplay.coordinator;
  const observed = [];
  const onHurt = gameplay.onHurt;
  gameplay.onHurt = (event) => {
    observed.push({
      health: gameplay.health,
      ticks: effects.serialize().effects[0].remainingTicks,
      reservation: coordinator.usage(effects),
      bytes: effects.reservedBytes,
    });
    onHurt(event);
  };
  let snapshots = 0;
  gameplay.onChange = () => snapshots++;
  const tick = prepareStatusAdvance(gameplay, effects, 0.05);
  assert.ok(tick);
  const health = tick.participants.find(({ owner }) => owner === gameplay);
  health.notify();
  assert.equal(events.length, 0);
  assert.equal(gameplay.health, 20);
  assert.equal(
    coordinator.commit([...tick.participants, veto(t, coordinator)]).ok,
    false
  );
  assert.equal(events.length, 0);
  assert.equal(effects.serialize().effects[0].remainingTicks, 100);
  assert.deepEqual(coordinator.commit(tick.participants), {
    ok: true,
    observerErrors: [],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].damage, 1);
  assert.deepEqual(observed, [
    {
      health: 19,
      ticks: 99,
      reservation: effects.reservedBytes,
      bytes: effects.reservedBytes,
    },
  ]);
  assert.equal(snapshots, 0, "quiet ticks do not force a full HUD snapshot");
  assert.equal(feedback.update(0).visible, true);
  health.notify();
  assert.equal(
    events.length,
    1,
    "a wrapped notification cannot replay the pulse"
  );
  assert.equal(coordinator.commit(tick.participants).ok, false);
  const paused = prepareStatusAdvance(gameplay, effects, 500, { paused: true });
  assert.deepEqual(paused.participants, []);
  assert.equal(coordinator.commit(paused.participants).ok, true);
  assert.equal(events.length, 1);
});

test("stale/capacity-refused prepared damage never pulses or publishes health", (t) => {
  const { gameplay, feedback, events } = hurtFixture(t);
  const effects = statusFixture(t, gameplay);
  const coordinator = gameplay.coordinator;
  const stale = prepareStatusApplication(gameplay, effects, potion("harming"));
  gameplay.select(1);
  assert.equal(coordinator.commit(stale.participants).ok, false);
  assert.equal(gameplay.health, 20);
  assert.equal(events.length, 0);
  const recipient = new Gameplay({ coordinator });
  const full = {};
  t.after(() => {
    coordinator.release(full);
    recipient.dispose();
  });
  assert.equal(
    coordinator.register(
      full,
      MAX_RESERVED_BYTES - coordinator.budget.totalBytes
    ),
    true
  );
  const growth = recipient.prepareAddStack({ id: ITEM.STICK, count: 1 });
  const plan = prepareStatusApplication(gameplay, effects, potion("harming"), {
    participants: [growth],
  });
  assert.ok(plan);
  const result = coordinator.commit(plan.participants);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "budget-rejected");
  assert.equal(recipient.count(ITEM.STICK), 0);
  assert.equal(gameplay.health, 20);
  assert.equal(events.length, 0);
  assert.equal(feedback.update(0).visible, false);
});

test("prepared healing, poison's one-health floor and Creative instant damage never pulse", (t) => {
  const { gameplay, feedback, events } = hurtFixture(t);
  loadVitals(gameplay, { health: 1 });
  const effects = statusFixture(t, gameplay, "poison");
  const tick = prepareStatusAdvance(gameplay, effects, 0.05);
  assert.equal(gameplay.coordinator.commit(tick.participants).ok, true);
  assert.equal(gameplay.health, 1);
  const heal = prepareStatusApplication(gameplay, effects, potion("healing"));
  assert.equal(gameplay.coordinator.commit(heal.participants).ok, true);
  assert.ok(gameplay.health > 1);
  gameplay.setMode("creative");
  const harming = prepareStatusApplication(
    gameplay,
    effects,
    potion("harming")
  );
  assert.equal(gameplay.coordinator.commit(harming.participants).ok, true);
  assert.equal(gameplay.health, 20);
  assert.equal(events.length, 0);
  assert.equal(feedback.update(0).visible, false);
});

test("prepared observer errors preserve damage, notify snapshots, and cannot skip quiet lethal cleanup", (t) => {
  for (const lethal of [false, true]) {
    const { gameplay } = hurtFixture(t);
    // Wither pulses on 40-tick boundaries; 80 makes this first tick lethal.
    const effects = statusFixture(
      t,
      gameplay,
      lethal ? "wither" : undefined,
      80
    );
    if (lethal) loadVitals(gameplay, { health: 1 });
    const failure = new Error("hurt display failed");
    const seen = [];
    gameplay.onHurt = () => {
      seen.push({ type: "hurt", health: gameplay.health });
      throw failure;
    };
    gameplay.onChange = () =>
      seen.push({ type: "change", health: gameplay.health });
    gameplay.onDeath = () =>
      seen.push({
        type: "death",
        dead: gameplay.dead,
        effects: effects.serialize().effects,
      });
    const plan = lethal
      ? prepareStatusAdvance(gameplay, effects, 0.05)
      : prepareStatusApplication(gameplay, effects, potion("harming"));
    const result = gameplay.coordinator.commit(plan.participants);
    assert.equal(result.ok, true);
    assert.deepEqual(result.observerErrors, [failure]);
    assert.deepEqual(
      seen.map(({ type }) => type),
      ["hurt", lethal ? "death" : "change"]
    );
    assert.ok(gameplay.health < (lethal ? 1 : 20));
    if (lethal) {
      assert.deepEqual(seen[1], { type: "death", dead: true, effects: [] });
    }
  }
});

test("actual swept pearl impacts notify only after pose, health and retirement commit; Creative remains silent", (t) => {
  for (const mode of ["survival", "creative"]) {
    const f = pearlFixture(t, { mode });
    const feedback = new HurtFeedback({ motionPreference: { matches: false } });
    t.after(() => feedback.dispose());
    const observed = [];
    f.game.onHurt = (event) => {
      observed.push({
        event,
        position: { ...f.player.position },
        velocity: { ...f.player.velocity },
        fallDistance: f.player.fallDistance,
        pearls: f.pearls.size,
        health: f.game.health,
      });
      feedback.noteHealthLoss(event);
    };
    floorImpact(f);
    const plan = f.pearls.prepareImpactTransaction(1);
    assert.ok(plan);
    assert.equal(observed.length, 0);
    assert.equal(
      f.coordinator.commit([...plan.participants, veto(t, f.coordinator)]).ok,
      false
    );
    assert.equal(f.game.health, 20);
    assert.equal(observed.length, 0);
    assert.deepEqual(f.coordinator.commit(plan.participants), {
      ok: true,
      observerErrors: [],
    });
    assert.equal(f.pearls.size, 0);
    assert.equal(observed.length, mode === "survival" ? 1 : 0);
    assert.equal(feedback.update(0).visible, mode === "survival");
    if (mode === "survival") {
      assert.equal(observed[0].health, 20 - plan.request.damage.amount);
      assert.deepEqual(observed[0].position, plan.request.position);
      assert.deepEqual(observed[0].velocity, { x: 0, y: 0, z: 0 });
      assert.equal(observed[0].fallDistance, 0);
      assert.equal(observed[0].pearls, 0);
    }
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
  }
});
