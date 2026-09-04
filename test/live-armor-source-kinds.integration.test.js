import assert from "node:assert/strict";
import test from "node:test";
import { liveArmorFixture } from "./live-armor-fixture.js";

test("native blaze fireball kind respects Fire Resistance without armor wear or RNG", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  f.status("fire_resistance");
  const equipment = f.gameplay.equipment;
  const random = f.services.stations.randomState;
  f.hit(5, "Blaze fireball", "blaze_fireball");
  assert.equal(f.gameplay.health, 20);
  assert.deepEqual(f.gameplay.equipment, equipment);
  assert.equal(f.services.stations.randomState, random);
  assert.equal(f.events.length, 0);
});

test("native guardian beam kind bypasses ordinary armor without wear or RNG", (t) => {
  const f = liveArmorFixture(t);
  f.armor("netherite", {});
  const equipment = f.gameplay.equipment;
  const random = f.services.stations.randomState;
  f.hit(6, "Guardian", "guardian_beam");
  assert.equal(f.gameplay.health, 14);
  assert.deepEqual(f.gameplay.equipment, equipment);
  assert.equal(f.services.stations.randomState, random);
  assert.equal(f.events.length, 1);
});

test("guardian magic still receives Protection and Resistance exactly once", (t) => {
  const f = liveArmorFixture(t);
  f.armor();
  f.status("resistance");
  const equipment = f.gameplay.equipment;
  const random = f.services.stations.randomState;
  f.hit(6, "Guardian", "guardian_beam");
  assert.ok(Math.abs(f.gameplay.health - (20 - 6 * 0.8 * 0.36)) < 1e-8);
  assert.deepEqual(f.gameplay.equipment, equipment);
  assert.equal(f.services.stations.randomState, random);
});
