import assert from "node:assert/strict";
import test from "node:test";
import { Gameplay } from "../src/gameplay.js";

function fixture(t) {
  const hurts = [];
  const gameplay = new Gameplay({ onHurt: (event) => hurts.push(event) });
  t.after(() => gameplay.dispose());
  return { gameplay, hurts };
}

test("unknown fluid coverage freezes air and drowning rather than assuming open air", (t) => {
  const { gameplay, hurts } = fixture(t);
  gameplay.update(15.5, { underwater: true });
  assert.equal(gameplay.air, 0);
  const health = gameplay.health;
  const drowning = gameplay._timers.drowning;
  const count = hurts.length;
  gameplay.update(30, {
    underwater: false,
    airKnown: false,
    restoreAir: true,
  });
  assert.equal(gameplay.air, 0, "unknown coverage cannot grant bubble air");
  assert.equal(gameplay._timers.drowning, drowning);
  assert.equal(gameplay.health, health);
  assert.equal(hurts.length, count);
  gameplay.update(2, { underwater: true, airKnown: true });
  assert.ok(
    gameplay.health < health,
    "known water resumes the existing hazard"
  );
  assert.ok(hurts.length > count);
});

test("bubble eye contact restores full air and clears partial drowning without a hurt event", (t) => {
  const { gameplay, hurts } = fixture(t);
  gameplay.update(15.5, { underwater: true });
  assert.ok(gameplay._timers.drowning > 0);
  const health = gameplay.health;
  const count = hurts.length;
  gameplay.update(0.05, {
    underwater: true,
    inWater: true,
    airKnown: true,
    restoreAir: true,
  });
  assert.equal(gameplay.air, 20);
  assert.equal(gameplay._timers.drowning, 0);
  assert.equal(gameplay.health, health);
  assert.equal(hurts.length, count);
  gameplay.update(1, { underwater: true, restoreAir: true });
  assert.equal(gameplay.air, 20);
  assert.equal(gameplay._timers.drowning, 0);
  gameplay.update(0.75, { underwater: true });
  assert.ok(Math.abs(gameplay.air - 19) < 1e-8);
});

test("ordinary water and air keep the legacy breathing behavior when new flags are omitted", (t) => {
  const { gameplay } = fixture(t);
  gameplay.update(15, { underwater: true });
  assert.ok(gameplay.air < 1e-8);
  gameplay.update(0.25);
  assert.ok(Math.abs(gameplay.air - 1) < 1e-8);
  assert.equal(gameplay._timers.drowning, 0);
  gameplay.update(20);
  assert.equal(gameplay.air, 20);
});

test("unknown breathing coverage does not suppress other real damage or duplicate its notification", (t) => {
  const { gameplay, hurts } = fixture(t);
  gameplay.update(7.5, { underwater: true });
  const air = gameplay.air;
  const drowning = gameplay._timers.drowning;
  gameplay.update(1, { airKnown: false, inLava: true });
  assert.equal(gameplay.air, air);
  assert.equal(gameplay._timers.drowning, drowning);
  assert.ok(gameplay.health < 20);
  assert.equal(
    hurts.reduce((damage, event) => damage + event.damage, 0),
    20 - gameplay.health
  );
});

test("malformed breathing flags are rejected without advancing owned state", (t) => {
  const { gameplay } = fixture(t);
  const before = gameplay.serialize();
  const revision = gameplay.revision;
  for (const environment of [
    { airKnown: null },
    { airKnown: "unknown" },
    { restoreAir: 1 },
    { restoreAir: null },
  ]) {
    gameplay.update(1, environment);
    assert.deepEqual(gameplay.serialize(), before);
    assert.equal(gameplay.revision, revision);
  }
});
