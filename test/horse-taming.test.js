import assert from "node:assert/strict";
import test from "node:test";
import { horseMotion } from "../src/horse-definitions.js";
import { normalizeHorseRecord } from "../src/horse-save.js";
import {
  advanceHorseTaming, horseStableDraw, pendingHorseBuck, unseatHorse,
} from "../src/horse-taming.js";
import { createWorldContext } from "../src/world-spec.js";
import { horseRecord } from "./horse-fixture.js";

const context = createWorldContext({ seed: "tamings must not reroll", generatorVersion: 4 });

test("60 authored simulation ticks persist exactly and compare temper before increasing it", () => {
  let entry = horseRecord("taming:zero", { rider: "player", motion: horseMotion() });
  for (let index = 0; index < 17; index++) entry = advanceHorseTaming(entry, 0.05, context).entry;
  assert.equal(entry.tamingTicksLeft, 43);
  entry = normalizeHorseRecord(structuredClone(entry), context);
  for (let index = 0; index < 42; index++) {
    const result = advanceHorseTaming(entry, 0.05, context);
    assert.equal(result.outcome, null);
    entry = result.entry;
  }
  assert.equal(entry.tamingTicksLeft, 1);
  const completed = advanceHorseTaming(entry, 0.05, context);
  assert.equal(completed.outcome, "failed", "zero temper always fails the pre-increment draw");
  assert.equal(completed.entry.temper, 5);
  assert.equal(completed.entry.failedAttempts, 1);
  assert.equal(pendingHorseBuck(completed.entry), true);
  for (let index = 0; index < 200; index++)
    assert.deepEqual(advanceHorseTaming(completed.entry, 0.2, context),
      { entry: completed.entry, outcome: null }, "blocked buck never rerolls or gains temper again");
  const departed = unseatHorse(completed.entry);
  assert.equal(departed.rider, null);
  assert.equal(departed.tamingTicksLeft, 60);
  assert.equal(departed.temper, 5);
  assert.equal(departed.failedAttempts, 1);
});

test("the same ID/world/failure count produces the same next result before and after save", () => {
  const entry = horseRecord("taming:persisted", { rider: "player", motion: horseMotion(),
    temper: 30, failedAttempts: 3, tamingTicksLeft: 0.25 });
  const result = advanceHorseTaming(entry, 0.05, context);
  const restored = normalizeHorseRecord(structuredClone(entry), context);
  assert.deepEqual(advanceHorseTaming(restored, 0.05, context), result);
  assert.equal(horseStableDraw(context, entry.id, entry.dimension, "tame:3"),
    horseStableDraw(context, entry.id, entry.dimension, "tame:3"));
  assert.notEqual(horseStableDraw(context, entry.id, entry.dimension, "tame:3"),
    horseStableDraw(context, entry.id, entry.dimension, "tame:4"));
});

test("temper 100 guarantees success, while ordinary early dismount keeps the remaining attempt", () => {
  const entry = horseRecord("taming:guaranteed", { rider: "player", motion: horseMotion(),
    temper: 100, failedAttempts: 20, tamingTicksLeft: 1 });
  const result = advanceHorseTaming(entry, 0.05, context);
  assert.equal(result.outcome, "tamed");
  assert.equal(result.entry.tamed, true);
  assert.equal(result.entry.failedAttempts, 20);
  assert.equal(result.entry.tamingTicksLeft, 0);
  assert.equal(normalizeHorseRecord(result.entry, context).tamed, true);
  const early = unseatHorse({ ...entry, temper: 30, failedAttempts: 2, tamingTicksLeft: 17.25 });
  assert.equal(early.tamingTicksLeft, 17.25);
  assert.equal(early.motion, null);
  const airborne = unseatHorse({ ...entry, motion: { vx: 1, vy: -2, vz: 3, grounded: false, fallDistance: 4 } });
  assert.deepEqual(airborne.motion, { vx: 1, vy: -2, vz: 3, grounded: false, fallDistance: 4 });
});
