import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustCombatDamage, advanceCombatCredit, advanceHurtWindow, BLAZE_IMPACT_DAMAGE,
  classifyCombatAttack, combatVictimOwner, COMBAT_RULES_VERSION, COMBAT_SPECIES_RULES,
  decideCombatCredit, decideCombatRetaliation, decideHurtWindow,
  HURT_WINDOW_SECONDS, PLAYER_CREDIT_SECONDS,
} from "../src/combat-rules.js";
import { MOB_SPECIES } from "../src/mob-species.js";

const damage = (overrides = {}) => adjustCombatDamage(Object.freeze({
  attackKind: "arrow", responsibleKind: "mob", victimKind: "player",
  rawDamage: 8, difficulty: "normal", ...overrides,
}));
const target = (overrides = {}) => Object.freeze({
  kind: "mob", id: "combat/attacker/skeleton", species: "skeleton",
  eligible: true, playerOwnerId: null, ...overrides,
});
const retaliation = (overrides = {}) => decideCombatRetaliation(Object.freeze({
  victimSpecies: "skeleton", victimId: "combat/victim/skeleton",
  victimCanDamage: true, healthDamage: 1, attackKind: "arrow",
  attacker: target(), ...overrides,
}));
const creditedHit = (overrides = {}) => Object.freeze({
  committed: true, healthDamage: 1, responsibleKind: "player",
  playerOwnerId: "combat/player/6e0d261c-86a2-4383-89f0-9162c1c10662",
  ...overrides,
});

test("attack classification selects explicit defenses without authorizing ownership or rewards", () => {
  for (const [attackKind, damageType, shield, isFire, projectile] of [
    ["melee", "melee", "directional", false, false],
    ["arrow", "projectile", "directional", false, true],
    ["blaze_fireball", "fireball", "directional", true, true],
    ["ghast_fireball", "fireball", "directional", true, true],
    ["ghast_explosion", "explosion", "directional", false, false],
    ["creeper_explosion", "explosion", "directional", false, false],
    ["guardian_beam", "magic", "none", false, false],
    ["guardian_thorns", "thorns", "none", false, false],
    ["fire_tick", "on_fire", "none", true, false],
  ]) {
    const actual = classifyCombatAttack(Object.freeze({
      attackKind, responsibleKind: "mob", victimKind: "player",
      get sourceAlive() { assert.fail("classification must not require source liveness"); },
      get playerOwnerId() { assert.fail("reward credit is not attack classification"); },
      get ownerAvailable() { assert.fail("routing is not attack authority"); },
    }));
    assert.equal(actual.damageType, damageType);
    assert.equal(actual.shield, shield);
    assert.equal(actual.isFire, isFire);
    assert.equal(actual.projectile, projectile);
    assert.ok(Object.isFrozen(actual));
    assert.equal("authorized" in actual, false);
    assert.equal("playerKill" in actual, false);
  }
});

test("only eligible mob-to-player full damage scales, with one fixed blaze exception", () => {
  for (const [difficulty, expected] of [["easy", 5], ["normal", 8], ["hard", 12]]) {
    assert.equal(damage({ difficulty }).difficultyAdjustedFullDamage, expected);
    assert.equal(damage({ difficulty, victimKind: "mob" }).difficultyAdjustedFullDamage, 8);
    assert.equal(damage({ difficulty, responsibleKind: "player" }).difficultyAdjustedFullDamage, 8);
    assert.equal(damage({
      difficulty, attackKind: "tnt_explosion", responsibleKind: "environment",
    }).difficultyAdjustedFullDamage, 8);
    for (const victimKind of ["mob", "player"]) {
      const fixed = damage({
        difficulty, victimKind, attackKind: "blaze_fireball", rawDamage: BLAZE_IMPACT_DAMAGE,
      });
      assert.equal(fixed.difficultyAdjustedFullDamage, 5);
      assert.equal(fixed.scaling, "fixed-blaze");
    }
  }
  assert.equal(damage({ difficulty: undefined }).difficulty, "normal");
  assert.equal(damage({ difficulty: "peaceful" }).difficultyAdjustedFullDamage, 0);
  assert.equal(damage({ difficulty: "peaceful", victimKind: "mob" }).suppressed, true);
  assert.equal(damage({
    difficulty: "peaceful", attackKind: "blaze_fireball", rawDamage: 5,
  }).difficultyAdjustedFullDamage, 0);
  assert.equal(damage({
    difficulty: "hard", attackKind: "fire_tick", rawDamage: 1,
  }).difficultyAdjustedFullDamage, 1, "DoT provenance must not re-scale ongoing fire");
  assert.equal(damage({
    difficulty: "hard", attackKind: "melee", responsibleSpecies: "blaze", rawDamage: 5,
  }).difficultyAdjustedFullDamage, 7.5, "blaze melee is not the small-fireball exception");
  assert.equal(damage({
    difficulty: "hard", attackKind: "ghast_fireball", rawDamage: 6,
  }).difficultyAdjustedFullDamage, 9, "ghast and blaze impacts have distinct scaling");
  assert.equal(damage({
    difficulty: "hard", attackKind: "ghast_fireball", rawDamage: 6, responsibleKind: "player",
  }).difficultyAdjustedFullDamage, 6, "responsibility can change without changing the immediate cause");
});

test("ambiguous or malformed damage facts refuse instead of guessing a classification", () => {
  for (const rawDamage of [-1, NaN, Infinity, null, "8", undefined])
    assert.throws(() => damage({ rawDamage }), RangeError);
  for (const difficulty of [null, "Normal", "unknown"])
    assert.throws(() => damage({ difficulty }), RangeError);
  for (const attackKind of ["fireball", "explosion", "unknown", "__proto__", { toString: () => "arrow" }])
    assert.throws(() => damage({ attackKind }), RangeError);
  assert.throws(() => damage({ responsibleKind: "environment" }), RangeError);
  assert.throws(() => damage({ victimKind: "horse" }), RangeError);
  assert.throws(() => damage({ attackKind: "blaze_fireball", rawDamage: 8 }), RangeError);
  assert.throws(() => damage({ rawDamage: Number.MAX_VALUE, difficulty: "hard" }), RangeError);
});

test("all actual species route explicitly, including untracked wild horses", () => {
  assert.equal(COMBAT_RULES_VERSION, "mineslop-combat-contract-v2");
  assert.deepEqual(Object.keys(COMBAT_SPECIES_RULES).sort(), Object.keys(MOB_SPECIES).sort());
  for (const [species, definition] of Object.entries(MOB_SPECIES)) {
    const expected = species === "horse" ? "Horses"
      : definition.ecology ? "GameEcologyServices" : "Wildlife";
    assert.equal(combatVictimOwner({ kind: "mob", species }), expected, species);
    assert.ok(Object.isFrozen(COMBAT_SPECIES_RULES[species]));
  }
  for (const retained of [true, false]) {
    assert.equal(combatVictimOwner(Object.freeze({
      kind: "mob", species: "horse", retained, tamed: false, saddled: false, sidecar: null,
      get health() { assert.fail("owner routing cannot read health"); },
      get playerKill() { assert.fail("reward credit cannot select a victim owner"); },
    })), "Horses");
  }
  assert.equal(combatVictimOwner({ kind: "player" }), "Gameplay");
  assert.throws(() => combatVictimOwner({ kind: "mob", species: "unknown" }), RangeError);
  assert.throws(() => combatVictimOwner({ kind: "unknown" }), RangeError);
});

test("skeleton infighting keeps a valid revenge target and never blames a missing source", () => {
  const first = retaliation();
  assert.equal(first.kind, "target");
  assert.equal(first.targetId, "combat/attacker/skeleton");
  const currentRevenge = target({ id: "combat/earlier/attacker", species: "zombie" });
  const kept = retaliation({ currentRevenge });
  assert.equal(kept.kind, "keep");
  assert.equal(kept.targetId, currentRevenge.id);
  assert.equal(kept.alertPack, false);
  assert.equal(retaliation({ attacker: null }).kind, "none");
  assert.equal(retaliation({ attacker: target({ eligible: false }) }).kind, "none");
  assert.equal(retaliation({ attacker: target({ id: "combat/victim/skeleton" }) }).kind, "none");
  assert.equal(retaliation({ attacker: null, currentRevenge }).kind, "keep");
  assert.equal(retaliation({
    currentRevenge: target({ ...currentRevenge, eligible: false }),
  }).kind, "target");
});

test("passives flee the actual attacker or a bounded last-known threat, never an implicit player", () => {
  for (const victimSpecies of ["horse", "cow", "villager", "turtle", "sulfur_cube"]) {
    const response = retaliation({ victimSpecies });
    assert.equal(response.kind, "flee");
    assert.equal(response.targetKind, "mob");
    assert.equal(response.targetId, "combat/attacker/skeleton");
    const absent = retaliation({ victimSpecies, attacker: null, lastKnownThreat: true });
    assert.equal(absent.kind, "flee");
    assert.equal(absent.reason, "last-known-threat");
    assert.equal(absent.targetId, null);
    assert.equal(retaliation({ victimSpecies, attacker: null }).kind, "none");
  }
});

test("creepers prioritize eligible players without switching an existing valid player target", () => {
  const player = target({ kind: "player", id: "combat/player/priority", species: undefined });
  const currentRevenge = target({ id: "combat/mob/old-target" });
  const first = retaliation({ victimSpecies: "creeper", playerTarget: player, currentRevenge });
  assert.equal(first.kind, "target");
  assert.equal(first.targetId, player.id);
  const oldPlayer = target({ ...player, id: "combat/player/old-target" });
  assert.equal(retaliation({
    victimSpecies: "creeper", playerTarget: player, currentRevenge: oldPlayer,
  }).targetId, oldPlayer.id);
  assert.equal(retaliation({
    victimSpecies: "creeper", playerTarget: target({ ...player, eligible: false }), currentRevenge,
  }).targetId, currentRevenge.id);
  assert.equal(retaliation({
    victimSpecies: "creeper", attacker: player, currentRevenge,
  }).targetId, player.id, "an incoming player is itself an eligible player-priority candidate");
});

test("species exclusions, dolphin capability and Enderman handling are explicit", () => {
  for (const victimSpecies of ["ghast", "slime", "guardian", "elder_guardian"]) {
    const decision = retaliation({ victimSpecies, currentRevenge: target() });
    assert.equal(decision.kind, "none");
    assert.equal(decision.reason, "species-no-revenge");
  }
  assert.equal(MOB_SPECIES.dolphin.damage, 0, "existing passive metadata cannot authorize dolphin damage");
  assert.equal(retaliation({ victimSpecies: "dolphin", victimCanDamage: false }).kind, "flee");
  assert.equal(retaliation({ victimSpecies: "dolphin", victimCanDamage: true }).kind, "target");
  for (const attackKind of ["arrow", "blaze_fireball", "ghast_fireball"])
    assert.equal(retaliation({ victimSpecies: "enderman", attackKind }).reason,
      "preserve-enderman-projectile-policy");
  assert.equal(retaliation({ victimSpecies: "enderman", attackKind: "melee" }).kind, "target");
  assert.equal(retaliation({ healthDamage: 0 }).kind, "none");
  assert.throws(() => retaliation({ victimCanDamage: undefined }), RangeError);
});

test("wolf ownership exclusions are separate from reward credit; pack alerts occur once", () => {
  const victim = { victimSpecies: "wolf", victimPlayerOwnerId: "combat/player/owner" };
  for (const attacker of [
    target({ kind: "player", id: victim.victimPlayerOwnerId, species: undefined }),
    target({ species: "wolf", playerOwnerId: victim.victimPlayerOwnerId }),
  ]) assert.equal(retaliation({ ...victim, attacker }).kind, "none");
  const enemy = target({ species: "wolf", playerOwnerId: "combat/player/other-owner" });
  const first = retaliation({ ...victim, attacker: enemy });
  assert.equal(first.kind, "target");
  assert.equal(first.alertPack, true);
  const kept = retaliation({ ...victim, attacker: enemy, currentRevenge: enemy });
  assert.equal(kept.kind, "keep");
  assert.equal(kept.alertPack, false);
  assert.ok(Object.isFrozen(first));
});

test("Easy raw 8 then 10 compares full adjusted 5 then 6, yielding a pre-armor delta of one", () => {
  const firstFull = damage({ rawDamage: 8, difficulty: "easy" }).difficultyAdjustedFullDamage;
  const nextFull = damage({ rawDamage: 10, difficulty: "easy" }).difficultyAdjustedFullDamage;
  assert.equal(firstFull, 5);
  assert.equal(nextFull, 6);
  const first = decideHurtWindow(null, firstFull);
  const running = advanceHurtWindow(first.nextWindow, 0.1);
  const second = decideHurtWindow(running, nextFull);
  assert.equal(second.preArmorDamage, 1);
  assert.equal(second.nextWindow.difficultyAdjustedFullDamage, 6, "store full amount, never delta");
  assert.equal(second.nextWindow.elapsedSeconds, running.elapsedSeconds, "do not restart the clock");
  assert.equal(decideHurtWindow(second.nextWindow, 6).preArmorDamage, 0);
});

test("weaker/equal hits contribute zero, stronger hits retain the window, and expiry admits full damage", () => {
  const first = decideHurtWindow(null, 8);
  const running = advanceHurtWindow(first.nextWindow, 0.25);
  for (const amount of [0, 1, 7, 8]) {
    const hit = decideHurtWindow(running, amount);
    assert.equal(hit.preArmorDamage, 0);
    assert.deepEqual(hit.nextWindow, running);
  }
  const stronger = decideHurtWindow(running, 10);
  assert.equal(stronger.preArmorDamage, 2);
  assert.equal(stronger.nextWindow.elapsedSeconds, 0.25);
  assert.equal(decideHurtWindow(stronger.nextWindow, 13).preArmorDamage, 3);
  const expired = advanceHurtWindow(stronger.nextWindow, 0.25);
  assert.equal(expired, null);
  const after = decideHurtWindow(expired, 3);
  assert.equal(after.preArmorDamage, 3);
  assert.equal(after.nextWindow.elapsedSeconds, 0);
  assert.equal(decideHurtWindow(null, 0).nextWindow, null);
});

test("hurt expiry is exactly 0.5 admitted seconds under different dt partitions and pauses", () => {
  assert.equal(HURT_WINDOW_SECONDS, 0.5);
  const original = decideHurtWindow(null, 5).nextWindow;
  for (const partition of [[0.5], [0.25, 0.25], [0.13, 0.17, 0.2],
    Array(10).fill(0.05), Array(500).fill(0.001)]) {
    let window = original;
    for (let index = 0; index < partition.length; index++) {
      window = advanceHurtWindow(window, partition[index]);
      if (index < partition.length - 1) assert.notEqual(window, null);
    }
    assert.equal(window, null);
  }
  const almost = advanceHurtWindow(original, 0.5 - 1e-9);
  assert.notEqual(almost, null);
  for (let index = 0; index < 100; index++)
    assert.deepEqual(advanceHurtWindow(almost, 0), almost, "pause admits no simulation time");
  assert.equal(original.elapsedSeconds, 0);
  assert.ok(Object.isFrozen(original));
  assert.throws(() => { original.difficultyAdjustedFullDamage = 1; }, TypeError);
});

test("committed player or player-owned wolf health loss establishes stable five-second credit", () => {
  const player = decideCombatCredit(null, creditedHit());
  assert.equal(player.playerOwnerId, creditedHit().playerOwnerId);
  const wolf = decideCombatCredit(null, creditedHit({
    responsibleKind: "mob", responsibleSpecies: "wolf", playerOwnerId: "combat/player/wolf-owner",
    sourceAlive: false, currentPlayerLife: 99, heldItem: null,
  }));
  assert.equal(wolf.playerOwnerId, "combat/player/wolf-owner");
  assert.equal(wolf.elapsedSeconds, 0);
  const refreshed = decideCombatCredit(advanceCombatCredit(player, 4), creditedHit({
    playerOwnerId: "combat/player/new-credit",
  }));
  assert.equal(refreshed.playerOwnerId, "combat/player/new-credit");
  assert.equal(refreshed.elapsedSeconds, 0);
  assert.ok(Object.isFrozen(refreshed));
});

test("misses, blocks, immunity, refusal, uncredited hits and DoT cannot refresh or erase credit", () => {
  const old = advanceCombatCredit(decideCombatCredit(null, creditedHit()), 2);
  const cases = [
    creditedHit({ healthDamage: 0 }),
    creditedHit({ committed: false }),
    creditedHit({ damageOverTime: true }),
    creditedHit({ responsibleKind: "environment", playerOwnerId: null }),
    creditedHit({ responsibleKind: "mob", responsibleSpecies: "skeleton", playerOwnerId: null }),
    creditedHit({ responsibleKind: "mob", responsibleSpecies: "horse" }),
    creditedHit({ responsibleKind: "mob", responsibleSpecies: "wolf", playerOwnerId: null }),
    creditedHit({ playerOwnerId: null }),
  ];
  for (const facts of cases) {
    assert.equal(decideCombatCredit(null, facts), null);
    assert.deepEqual(decideCombatCredit(old, facts), old);
  }
  for (const outcome of ["miss", "blocked", "immune"])
    assert.deepEqual(decideCombatCredit(old, creditedHit({ outcome, healthDamage: 0 })), old);
});

test("credit expires at exactly 5.0 admitted seconds independently of update count or pause", () => {
  assert.equal(PLAYER_CREDIT_SECONDS, 5);
  const original = decideCombatCredit(null, creditedHit());
  for (const partition of [[5], [2.5, 2.5], [0.13, 0.17, 4.7],
    Array(100).fill(0.05), Array(5000).fill(0.001)]) {
    let credit = original;
    for (let index = 0; index < partition.length; index++) {
      credit = advanceCombatCredit(credit, partition[index]);
      if (index < partition.length - 1) assert.notEqual(credit, null);
    }
    assert.equal(credit, null);
  }
  const almost = advanceCombatCredit(original, 5 - 1e-9);
  assert.notEqual(almost, null);
  for (let index = 0; index < 100; index++)
    assert.deepEqual(advanceCombatCredit(almost, 0), almost);
  assert.equal(advanceCombatCredit(original, 100), null);
});

test("malformed damage/clocks reject instead of creating NaN or call-count timers", () => {
  const hurt = decideHurtWindow(null, 5).nextWindow;
  const credit = decideCombatCredit(null, creditedHit());
  for (const invalid of [-1, NaN, Infinity, undefined, null, "0.05"]) {
    assert.throws(() => advanceHurtWindow(hurt, invalid), RangeError);
    assert.throws(() => advanceCombatCredit(credit, invalid), RangeError);
    assert.throws(() => decideHurtWindow(null, invalid), RangeError);
  }
  assert.throws(() => decideHurtWindow({ ...hurt, difficultyAdjustedFullDamage: -1 }, 5), RangeError);
  assert.throws(() => advanceHurtWindow({ ...hurt, compensation: 1 }, 0), RangeError);
  assert.throws(() => advanceCombatCredit({ ...credit, elapsedSeconds: -1 }, 0), RangeError);
  assert.throws(() => decideCombatCredit(null, creditedHit({ committed: "yes" })), RangeError);
});
