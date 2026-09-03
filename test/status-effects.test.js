import assert from "node:assert/strict";
import test from "node:test";
import {
  addStatusEffects,
  advanceStatusBreathing,
  advanceStatusEffects,
  applyNightVisionLight,
  clearStatusEffects,
  createStatusEffects,
  MAX_STATUS_DURATION_TICKS,
  modifyAttackDamage,
  modifyIncomingDamage,
  modifyMiningSpeed,
  modifyMovementSpeed,
  nightVisionRenderHook,
  normalizeStatusEffects,
  planPotionApplication,
  projectStatusHealth,
  splashExposure,
  STATUS_EFFECT_RESERVED_BYTES,
  STATUS_EFFECT_TYPES,
  StatusEffects,
  statusModifiers,
} from "../src/status-effects.js";
import { encodedBytes } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";

const effect = (id, durationTicks = 3600, amplifier = 0) => ({
  id,
  amplifier,
  durationTicks,
});
const stateWith = (...effects) =>
  addStatusEffects(createStatusEffects(), effects);
const potion = (id, flags = {}) => ({ id, form: "drinkable", ...flags });
const vitals = (health) => ({
  health,
  dead: health === 0,
  deathCause: health === 0 ? "prior death" : null,
});
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("same effects refresh rather than add, and stronger effects keep useful ticking weaker fallbacks", () => {
  const initial = stateWith(effect("speed", 300));
  const short = addStatusEffects(initial, [effect("speed", 100)]);
  assert.deepEqual(short, initial);
  const refreshed = addStatusEffects(short, [effect("speed", 400)]);
  assert.equal(refreshed.effects[0].remainingTicks, 400);
  const stronger = addStatusEffects(initial, [effect("speed", 200, 1)]);
  assert.deepEqual(stronger.effects, [
    {
      id: "speed",
      amplifier: 1,
      remainingTicks: 200,
      hidden: [{ amplifier: 0, remainingTicks: 300 }],
    },
  ]);
  const half = advanceStatusEffects(stronger, 5).state;
  assert.equal(half.effects[0].remainingTicks, 100);
  assert.equal(half.effects[0].hidden[0].remainingTicks, 200);
  const resumed = advanceStatusEffects(half, 5).state;
  assert.deepEqual(resumed.effects, [
    { id: "speed", amplifier: 0, remainingTicks: 100 },
  ]);
  assert.equal(statusModifiers(resumed).movementMultiplier, 1.2);
  assert.deepEqual(
    advanceStatusEffects(resumed, 5).state,
    createStatusEffects()
  );
  assert.equal(initial.effects[0].remainingTicks, 300);
});

test("dominated hidden effects disappear and a later weaker but longer effect is retained", () => {
  let state = stateWith(effect("strength", 400), effect("strength", 200, 1));
  state = addStatusEffects(state, [effect("strength", 600, 1)]);
  assert.deepEqual(state.effects, [
    { id: "strength", amplifier: 1, remainingTicks: 600 },
  ]);
  state = addStatusEffects(state, [effect("strength", 100)]);
  assert.equal(state.effects[0].hidden, undefined);
  state = addStatusEffects(state, [effect("strength", 800)]);
  const expiredStrong = advanceStatusEffects(state, 30);
  assert.deepEqual(expiredStrong.expired, []);
  assert.deepEqual(expiredStrong.state.effects, [
    { id: "strength", amplifier: 0, remainingTicks: 200 },
  ]);
});

test("reload preserves fractional ticks and pulse phase; pauses and invalid time never advance", () => {
  const initial = stateWith(effect("regeneration", 900), effect("speed", 100));
  const partial = advanceStatusEffects(initial, 0.075);
  assert.equal(partial.gameplayPlan.health.length, 1);
  close(partial.state.tickRemainder, 0.5);
  const saved = normalizeStatusEffects(
    JSON.parse(JSON.stringify(partial.state))
  );
  assert.deepEqual(saved, partial.state);
  for (const dt of [0, -1, NaN, Infinity, "1"])
    assert.deepEqual(advanceStatusEffects(saved, dt).state, saved);
  assert.deepEqual(
    advanceStatusEffects(saved, 12000, { paused: true }).state,
    saved
  );
  const next = advanceStatusEffects(saved, 0.025);
  assert.equal(
    next.gameplayPlan.health.length,
    0,
    "reload cannot repeat the first regeneration pulse"
  );
  assert.equal(next.state.tickRemainder, 0);
  assert.deepEqual(
    advanceStatusEffects(advanceStatusEffects(initial, 0.3).state, 0.7).state,
    advanceStatusEffects(initial, 1).state
  );
  const bounded = advanceStatusEffects(stateWith(effect("speed", 9600)), 1e9);
  assert.equal(bounded.elapsedTicks, 1200);
  assert.equal(bounded.state.effects[0].remainingTicks, 8400);
});

test("regeneration and poison use Java pulse intervals and correct non-resurrecting health floors", () => {
  const regen = advanceStatusEffects(
    stateWith(effect("regeneration", 900)),
    45
  );
  assert.equal(regen.gameplayPlan.health.length, 18);
  assert.equal(
    regen.gameplayPlan.health[1].tick - regen.gameplayPlan.health[0].tick,
    50
  );
  assert.equal(projectStatusHealth(vitals(1), regen.gameplayPlan).health, 19);
  assert.equal(projectStatusHealth(vitals(19), regen.gameplayPlan).health, 20);
  assert.equal(projectStatusHealth(vitals(0), regen.gameplayPlan).health, 0);
  const poison = advanceStatusEffects(stateWith(effect("poison", 900)), 45);
  assert.equal(
    poison.gameplayPlan.health[1].tick - poison.gameplayPlan.health[0].tick,
    25
  );
  const poisoned = projectStatusHealth(vitals(20), poison.gameplayPlan);
  assert.equal(poisoned.health, 1);
  assert.equal(poisoned.dead, false);
  assert.equal(poisoned.damageTaken, 19);
  assert.equal(
    projectStatusHealth(vitals(0.5), poison.gameplayPlan).health,
    0.5,
    "poison's floor must not heal"
  );
  const stronger = advanceStatusEffects(
    stateWith(effect("poison", 432, 1)),
    21.6
  );
  assert.equal(
    stronger.gameplayPlan.health[1].tick - stronger.gameplayPlan.health[0].tick,
    12
  );
  const regenII = advanceStatusEffects(
    stateWith(effect("regeneration", 450, 1)),
    22.5
  );
  assert.equal(
    regenII.gameplayPlan.health[1].tick - regenII.gameplayPlan.health[0].tick,
    25
  );
});

test("health changes remain ordered so poison floor and healing do not collapse into a wrong net delta", () => {
  const state = stateWith(effect("poison", 100), effect("regeneration", 100));
  const pulse = advanceStatusEffects(state, 0.05);
  assert.deepEqual(
    pulse.gameplayPlan.health.map(({ cause }) => cause),
    ["poison", "regeneration"]
  );
  const next = projectStatusHealth(vitals(1), pulse.gameplayPlan);
  assert.equal(next.health, 2);
  assert.equal(next.damageTaken, 0);
  assert.equal(next.healed, 1);
  const wither = advanceStatusEffects(stateWith(effect("wither", 80)), 4);
  assert.equal(projectStatusHealth(vitals(1), wither.gameplayPlan).dead, true);
  assert.equal(
    projectStatusHealth(vitals(1), wither.gameplayPlan).deathCause,
    "wither"
  );
});

test("instant potions are explicit plans, not live writes or persistent effects", () => {
  const state = stateWith(effect("speed"));
  const before = structuredClone(state);
  const health = vitals(5);
  const healing = planPotionApplication(
    state,
    potion("healing", { strong: true })
  );
  assert.deepEqual(state, before);
  assert.deepEqual(health, vitals(5));
  assert.deepEqual(healing.state, state);
  assert.equal(healing.gameplayPlan.health[0].amount, 8);
  assert.equal(projectStatusHealth(health, healing.gameplayPlan).health, 13);
  const harming = planPotionApplication(state, potion("harming"));
  const harmed = projectStatusHealth(health, harming.gameplayPlan);
  assert.equal(harmed.health, 0);
  assert.equal(harmed.dead, true);
  assert.equal(harmed.deathCause, "instant_damage");
  assert.equal(
    projectStatusHealth(health, harming.gameplayPlan, { invulnerable: true })
      .health,
    5
  );
  assert.equal(normalizeStatusEffects(healing.state).effects.length, 1);
});

test("undead inversion, poison/regen immunity and effect immunity are explicit target mechanics", () => {
  const state = createStatusEffects();
  const undead = { undead: true };
  const healing = planPotionApplication(state, potion("healing"), {
    target: undead,
  });
  assert.equal(healing.gameplayPlan.health[0].amount, 6);
  assert.equal(healing.gameplayPlan.health[0].kind, "damage");
  const harming = planPotionApplication(state, potion("harming"), {
    target: undead,
  });
  assert.equal(harming.gameplayPlan.health[0].amount, 4);
  assert.equal(harming.gameplayPlan.health[0].kind, "heal");
  for (const id of ["poison", "regeneration"])
    assert.equal(
      planPotionApplication(state, potion(id), { target: undead }).applied,
      false
    );
  assert.equal(
    planPotionApplication(state, potion("poison"), {
      target: { poisonImmune: true },
    }).applied,
    false
  );
  assert.equal(
    planPotionApplication(state, potion("strength"), {
      target: { effectImmune: true },
    }).applied,
    false
  );
  const ticking = advanceStatusEffects(stateWith(effect("poison", 900)), 45);
  assert.equal(
    projectStatusHealth(vitals(10), ticking.gameplayPlan, { target: undead })
      .health,
    10
  );
});

test("splash uses full duration on direct hits, distance falloff, nearest ticks and the one-second cutoff", () => {
  const state = createStatusEffects();
  const speed = potion("swiftness", { form: "splash" });
  assert.equal(splashExposure({ distance: 2 }), 0.5);
  assert.equal(splashExposure({ distance: 2, directHit: true }), 1);
  const direct = planPotionApplication(state, speed, {
    splash: { distance: 2, directHit: true },
  });
  assert.equal(direct.state.effects[0].remainingTicks, 3600);
  const near = planPotionApplication(state, speed, { splash: { distance: 2 } });
  assert.equal(near.state.effects[0].remainingTicks, 1800);
  assert.equal(
    planPotionApplication(state, speed, { splash: { distance: 4 } }).applied,
    false
  );
  const weakness = potion("weakness", { form: "splash" });
  assert.equal(
    planPotionApplication(state, weakness, { splash: { distance: 3.96 } })
      .applied,
    false
  );
  assert.equal(
    planPotionApplication(state, weakness, { splash: { distance: 3.75 } }).state
      .effects[0].remainingTicks,
    113,
    "an exactly representable 112.5-tick duration rounds upward"
  );
  assert.equal(
    planPotionApplication(state, weakness, { splash: { distance: 3.95 } }).state
      .effects[0].remainingTicks,
    22,
    "the Java double formula produces 22.499999999999922 before rounding"
  );
  const harming = planPotionApplication(
    state,
    potion("harming", { form: "splash" }),
    { splash: { distance: 2 } }
  );
  assert.equal(
    projectStatusHealth(vitals(20), harming.gameplayPlan).health,
    17
  );
  assert.throws(() => planPotionApplication(state, speed), RangeError);
  assert.throws(
    () =>
      planPotionApplication(state, potion("healing"), {
        splash: { distance: 0 },
      }),
    RangeError
  );
  assert.throws(
    () =>
      planPotionApplication(state, potion("healing", { form: "lingering" })),
    RangeError
  );
});

test("speed/slowness actually scale ground movement without altering swimming, flight or mining", () => {
  const fast = stateWith(effect("speed", 100, 1));
  close(modifyMovementSpeed(4, fast), 5.6);
  assert.equal(modifyMovementSpeed(4, fast, { kind: "swim" }), 4);
  assert.equal(modifyMovementSpeed(4, fast, { kind: "flight" }), 4);
  assert.equal(modifyMiningSpeed(8, fast), 8);
  const slow = addStatusEffects(fast, [effect("slowness", 100, 3)]);
  close(modifyMovementSpeed(4, slow), 2.24);
  assert.equal(modifyMovementSpeed(4, advanceStatusEffects(slow, 5).state), 4);
});

test("haste/mining-fatigue and strength/weakness use Java attributes rather than Bedrock formulas", () => {
  const haste = stateWith(effect("haste", 100));
  close(modifyMiningSpeed(8, haste), 9.6);
  close(statusModifiers(haste).attackSpeedMultiplier, 1.1);
  const fatigued = addStatusEffects(haste, [effect("mining_fatigue", 100, 2)]);
  close(modifyMiningSpeed(8, fatigued), 8 * 1.2 * 0.0027);
  close(statusModifiers(fatigued).attackSpeedMultiplier, 1.1 * 0.7);
  assert.equal(modifyMiningSpeed(8, fatigued, { creative: true }), 8);
  const strength = stateWith(effect("strength", 100));
  assert.equal(modifyAttackDamage(7, strength), 10);
  assert.equal(modifyAttackDamage(7, strength, { kind: "projectile" }), 7);
  assert.equal(modifyAttackDamage(7, strength, { kind: "spear_charge" }), 7);
  assert.equal(
    modifyAttackDamage(
      7,
      addStatusEffects(strength, [effect("weakness", 100)])
    ),
    6
  );
  assert.equal(modifyAttackDamage(1, stateWith(effect("weakness", 100))), 0);
});

test("fire immunity excludes explosions and impact damage; resistance/protection reduce appropriate damage", () => {
  const state = stateWith(
    effect("fire_resistance", 20),
    effect("resistance", 400, 1)
  );
  for (const kind of ["lava", "fire", "magma", "campfire", "fireball"])
    assert.equal(modifyIncomingDamage(10, state, { kind }), 0);
  for (const kind of ["melee", "projectile", "explosion"])
    close(modifyIncomingDamage(10, state, { kind }), 6);
  for (const kind of ["void", "starvation", "kill"])
    assert.equal(modifyIncomingDamage(10, state, { kind }), 10);
  assert.equal(modifyIncomingDamage(10, state, { bypassResistance: true }), 10);
  const expiry = advanceStatusEffects(state, 2);
  assert.deepEqual(
    expiry.segments.map(({ ticks, modifiers }) => [
      ticks,
      modifiers.fireImmune,
    ]),
    [
      [20, true],
      [20, false],
    ]
  );
  close(modifyIncomingDamage(10, expiry.state, { kind: "lava" }), 6);
  const harm = planPotionApplication(state, potion("harming"));
  close(
    projectStatusHealth(vitals(20), harm.gameplayPlan, { protectionFactor: 10 })
      .health,
    20 - 6 * 0.6 * 0.6
  );
});

test("hazard segments cover fractional frames and the exact remaining time around immunity expiry", () => {
  const initial = stateWith(effect("fire_resistance", 1));
  const halfTick = advanceStatusEffects(initial, 0.025).state;
  close(halfTick.tickRemainder, 0.5);
  const expired = advanceStatusEffects(halfTick, 0.05);
  assert.equal(expired.elapsedTicks, 1);
  assert.equal(expired.elapsedSeconds, 0.05);
  assert.deepEqual(
    expired.segments.map(({ ticks, modifiers }) => [
      ticks,
      modifiers.fireImmune,
    ]),
    [
      [1, true],
      [0, false],
    ]
  );
  close(expired.segments[0].seconds, 0.025);
  close(expired.segments[1].fromSeconds, 0.025);
  close(expired.segments[1].seconds, 0.025);
  assert.deepEqual(expired.state, createStatusEffects());

  const fractional = advanceStatusEffects(initial, 0.01);
  assert.equal(fractional.elapsedTicks, 0);
  assert.equal(fractional.segments[0].modifiers.fireImmune, true);
  close(fractional.segments[0].seconds, 0.01);
  const idle = advanceStatusEffects(createStatusEffects(), 0.02);
  assert.equal(idle.changed, false);
  assert.equal(idle.segments[0].modifiers.fireImmune, false);
  close(idle.segments[0].seconds, 0.02);
});

test("Water Breathing restores air and its expiry protects only the corresponding part of a large step", () => {
  const none = createStatusEffects();
  assert.deepEqual(advanceStatusBreathing(none, 20, 16), {
    air: 0,
    drowningSeconds: 1,
    protectedSeconds: 0,
  });
  const breathing = stateWith(effect("water_breathing", 200));
  assert.deepEqual(advanceStatusBreathing(breathing, 0, 5), {
    air: 20,
    drowningSeconds: 0,
    protectedSeconds: 5,
  });
  const expiredInsideStep = advanceStatusBreathing(breathing, 0, 30);
  assert.equal(expiredInsideStep.protectedSeconds, 10);
  assert.equal(expiredInsideStep.air, 0);
  close(expiredInsideStep.drowningSeconds, 5);
  assert.deepEqual(
    advanceStatusBreathing(breathing, 3, 12000, { paused: true }),
    {
      air: 3,
      drowningSeconds: 0,
      protectedSeconds: 0,
    }
  );
  assert.equal(
    advanceStatusBreathing(none, 0, 3.75, { underwater: false }).air,
    20
  );
});

test("night vision exposes and applies visual brightness, then removes it on expiry", () => {
  const state = stateWith(effect("night_vision", 20));
  assert.deepEqual(nightVisionRenderHook(state), {
    strength: 1,
    minimumVisualLight: 1,
    brightensUnderwater: true,
  });
  assert.equal(applyNightVisionLight(0.08, state), 1);
  const expired = advanceStatusEffects(state, 1).state;
  assert.equal(applyNightVisionLight(0.08, expired), 0.08);
});

test("bounded normalizers reject invalid versions, amplifiers, durations, duplicates and forged hidden chains", () => {
  const valid = stateWith(effect("speed", 200, 1), effect("speed", 400));
  const before = structuredClone(valid);
  for (const mutate of [
    (state) => {
      state.version = 9;
    },
    (state) => {
      state.tickRemainder = Infinity;
    },
    (state) => {
      state.tickRemainder = -1;
    },
    (state) => {
      state.tickRemainder = 1;
    },
    (state) => {
      state.effects[0].remainingTicks = 0;
    },
    (state) => {
      state.effects[0].remainingTicks = MAX_STATUS_DURATION_TICKS + 1;
    },
    (state) => {
      state.effects[0].amplifier = 32;
    },
    (state) => {
      state.effects[0].amplifier = -1;
    },
    (state) => {
      state.effects[0].id = "instant_health";
    },
    (state) => {
      state.effects[0].hidden[0].amplifier = 1;
    },
    (state) => {
      state.effects[0].hidden[0].remainingTicks = 100;
    },
    (state) => {
      state.effects.push(structuredClone(state.effects[0]));
    },
    (state) => {
      state.unknown = 1;
    },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => normalizeStatusEffects(invalid), RangeError);
  }
  assert.deepEqual(valid, before);
  const normalized = normalizeStatusEffects(valid);
  normalized.effects[0].hidden[0].remainingTicks = 1234;
  assert.deepEqual(valid, before);
  for (const invalid of [NaN, -1, Infinity])
    assert.throws(() => modifyMovementSpeed(invalid, valid), RangeError);
  assert.throws(
    () => stateWith(effect("poison", 100, 2)),
    RangeError,
    "unimplemented command-only periodic tiers reject"
  );
  assert.throws(() => splashExposure({ distance: NaN }), RangeError);
  assert.throws(
    () =>
      planPotionApplication(valid, potion("healing"), {
        target: { undead: 1 },
      }),
    RangeError
  );
});

test("health plan validation rejects forged causes, event order and values before any live mutation", () => {
  const valid = advanceStatusEffects(
    stateWith(effect("poison", 100)),
    2
  ).gameplayPlan;
  const target = vitals(10);
  for (const mutate of [
    (plan) => {
      plan.health[0].amount = Infinity;
    },
    (plan) => {
      plan.health[0].floor = 0;
    },
    (plan) => {
      plan.health[0].kind = "heal";
    },
    (plan) => {
      plan.health[0].bypassArmor = false;
    },
    (plan) => {
      plan.health[0].resistanceMultiplier = -1;
    },
    (plan) => {
      plan.health.reverse();
    },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => projectStatusHealth(target, invalid), RangeError);
    assert.deepEqual(target, vitals(10));
  }
});

test("fixed reservation covers maximum normalized chains without serializing on timer advancement", (t) => {
  const maximum = normalizeStatusEffects({
    version: 1,
    tickRemainder: 0.99999999,
    effects: Object.entries(STATUS_EFFECT_TYPES).map(
      ([id, { maxAmplifier }]) => ({
        id,
        amplifier: maxAmplifier,
        remainingTicks: MAX_STATUS_DURATION_TICKS - maxAmplifier * 100,
        hidden: Array.from({ length: maxAmplifier }, (_, index) => ({
          amplifier: maxAmplifier - index - 1,
          remainingTicks:
            MAX_STATUS_DURATION_TICKS - (maxAmplifier - index - 1) * 100,
        })),
      })
    ),
  });
  assert.ok(encodedBytes(maximum) < STATUS_EFFECT_RESERVED_BYTES);
  const coordinator = new TransactionCoordinator();
  const effects = new StatusEffects({ coordinator, state: maximum });
  t.after(() => effects.dispose());
  effects.serialize = () =>
    assert.fail("timer preparation must not serialize the owner");
  const next = effects.prepareAdvance(0.05);
  assert.ok(next.participant);
  assert.equal(next.participant.beforeBytes, next.participant.afterBytes);
  assert.equal(coordinator.commit([next.participant]).ok, true);
  assert.equal(coordinator.commit([next.participant]).ok, false);
});

test("runtime owner projections need no archive snapshots and never advance effect state", (t) => {
  const coordinator = new TransactionCoordinator();
  const effects = new StatusEffects({
    coordinator,
    state: stateWith(
      effect("speed"),
      effect("haste"),
      effect("strength"),
      effect("fire_resistance"),
      effect("water_breathing"),
      effect("night_vision")
    ),
  });
  t.after(() => effects.dispose());
  const revision = effects.revision;
  effects.serialize = () => assert.fail("runtime projections cannot serialize");
  close(effects.modifyMovementSpeed(4), 4.8);
  assert.equal(effects.modifyMiningSpeed(5), 6);
  assert.equal(effects.modifyAttackDamage(1), 4);
  assert.equal(effects.modifyIncomingDamage(10, { kind: "lava" }), 0);
  close(effects.advanceBreathing(0, 1).air, 20 / 3.75);
  assert.equal(effects.renderHook.brightensUnderwater, true);
  assert.equal(effects.applyNightVisionLight(0.1), 1);
  assert.equal(effects.revision, revision);
  assert.equal(coordinator.usage(effects), STATUS_EFFECT_RESERVED_BYTES);
});

test("prepared effect state is detached, stale on equal-byte replacement/reload, and never replays instant health", (t) => {
  const coordinator = new TransactionCoordinator();
  const effects = new StatusEffects({ coordinator });
  t.after(() => effects.dispose());
  const initial = effects.serialize();
  const plan = effects.preparePotion(potion("strength"));
  assert.deepEqual(effects.serialize(), initial);
  plan.state.effects[0].remainingTicks = 1;
  assert.equal(coordinator.commit([plan.participant]).ok, true);
  assert.equal(effects.serialize().effects[0].remainingTicks, 3600);
  const stale = effects.prepareAdvance(1).participant;
  const saved = effects.serialize();
  assert.equal(effects.load(JSON.parse(JSON.stringify(saved))), true);
  assert.equal(coordinator.commit([stale]).ok, false);
  assert.deepEqual(effects.serialize(), saved);
  const instant = effects.preparePotion(potion("healing"));
  assert.equal(instant.gameplayPlan.health.length, 1);
  assert.equal(coordinator.commit([instant.participant]).ok, true);
  assert.deepEqual(effects.serialize(), saved);
  assert.equal(
    effects.load({
      ...saved,
      effects: [{ id: "instant_health", amplifier: 0, remainingTicks: 1 }],
    }),
    false
  );
  assert.deepEqual(effects.serialize(), saved);
  assert.equal(
    effects.preparePotion(potion("healing"), { notify: null }),
    null
  );
  assert.throws(() => new StatusEffects(), RangeError);
});

test("milk/death clears active and hidden layers and explicit cures remove only their effect", () => {
  const initial = stateWith(
    effect("speed", 100, 1),
    effect("speed", 200),
    effect("poison", 100)
  );
  const cured = clearStatusEffects(initial, ["poison"]);
  assert.deepEqual(
    cured.effects.map(({ id }) => id),
    ["speed"]
  );
  assert.equal(cured.effects[0].hidden.length, 1);
  assert.deepEqual(clearStatusEffects(initial), createStatusEffects());
});
