import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { GameConduitServices } from "../src/game-conduit-services.js";
import { ITEM } from "../src/items.js";
import { ecologyEncounterProjection } from "../src/ecology-save.js";
import { ecologyHostFixture, ecologyTotals } from "./ecology-host-fixture.js";
import { monumentFixture } from "./ecology-fixtures.js";
import { buildConduit, putCell } from "./conduit-fixture.js";

const at = { x: 1, y: 3, z: 1 };
function fixture(t, options) {
  const f = ecologyHostFixture(t, options);
  const document = { hidden: false };
  const player = { world: f.world, position: f.player.position, height: 1.8, eyeHeight: 1.62,
    element: { ownerDocument: document } };
  const progression = { active: true, pearls: { life: 0 } };
  const game = { world: f.world, gameplay: f.gameplay, player, progressionIntegration: progression,
    ecologyServices: f.host, wildlife: f.wildlife, simulating: true, paused: false };
  const conduit = game.conduitServices = new GameConduitServices(game);
  const original = f.world.onMutation;
  f.world.onMutation = (event) => { original(event); conduit.onMutation(f.world, event); };
  const { structure, markers } = monumentFixture();
  f.markerIndex.add(structure, markers);
  t.after(() => conduit.dispose());
  return Object.assign(f, { game, conduit, document, structure, markers });
}

test("41 cannot attack; 42 deals four damage to one target per two simulation seconds at inclusive eight", (t) => {
  const f = fixture(t);
  const first = f.admit("guardian", { x: 9.5, y: 3.5, z: 1.5 }, { structure: f.structure });
  const second = f.admit("guardian", { x: 7.5, y: 3.5, z: 3.5 }, { structure: f.structure });
  buildConduit(f.world, 41, at);
  assert.equal(f.conduit.prepareAttack(at), null);
  for (let i = 0; i < 8; i++) f.conduit.frame(0.25);
  assert.equal(first.health, 30);
  buildConduit(f.world, 42, at);
  for (let i = 0; i < 7; i++) f.conduit.frame(0.25);
  assert.equal(first.health, 30);
  f.conduit.frame(0.25);
  assert.equal(first.health, 26);
  assert.equal(second.health, 30);
  assert.equal(first.angry, 0, "environmental damage has no retaliation credit");
  assert.equal(ecologyTotals(f).xp, 0);
  for (let i = 0; i < 8; i++) f.conduit.frame(0.25);
  assert.equal(first.health, 22);
});

test("attack preparation revalidates frame, target wetness, range, unload, life and source capacity", (t) => {
  const f = fixture(t);
  const mob = f.admit("guardian", { x: 9.5, y: 3.5, z: 1.5 }, { structure: f.structure });
  buildConduit(f.world, 42, at);
  const prepare = () => {
    const plan = f.conduit.prepareAttack(at);
    assert.ok(plan);
    return plan;
  };
  let plan = prepare();
  mob.position.x += 0.000001;
  assert.equal(f.host.commit(plan).ok, false);
  assert.equal(f.conduit.prepareAttack(at), null);
  mob.position.x -= 0.000001;
  plan = prepare();
  putCell(f.world, { x: 9, y: 3, z: 1 }, BLOCK.AIR);
  putCell(f.world, { x: 9, y: 4, z: 1 }, BLOCK.AIR);
  assert.equal(f.host.commit(plan).ok, false);
  assert.equal(f.conduit.prepareAttack(at), null);
  putCell(f.world, { x: 9, y: 3, z: 1 }, BLOCK.WATER);
  putCell(f.world, { x: 9, y: 4, z: 1 }, BLOCK.WATER);
  plan = prepare();
  buildConduit(f.world, 41, at);
  assert.equal(f.host.commit(plan).ok, false);
  buildConduit(f.world, 42, at);
  plan = prepare();
  putCell(f.world, at, BLOCK.WATER);
  assert.equal(f.host.commit(plan).ok, false);
  buildConduit(f.world, 42, at);
  plan = prepare();
  const chunk = f.world.chunks.get("-1,-1");
  f.world.chunks.delete("-1,-1");
  assert.equal(f.host.commit(plan).ok, false);
  f.world.chunks.set("-1,-1", chunk);
  plan = prepare();
  f.game.progressionIntegration.pearls.life++;
  assert.equal(f.host.commit(plan).ok, false);
  f.conduit.index.overflow = true;
  assert.equal(f.conduit.prepareAttack(at), null);
  assert.equal(mob.health, 30);
});

test("pause, loading, hidden and invalid sources do not accumulate pulse catch-up", (t) => {
  const f = fixture(t);
  const mob = f.admit("guardian", { x: 9.5, y: 3.5, z: 1.5 }, { structure: f.structure });
  buildConduit(f.world, 42, at);
  f.conduit.frame(0.25);
  for (const flag of ["paused", "building"]) {
    f.game[flag] = true;
    for (let i = 0; i < 10; i++) f.conduit.frame(0.25);
    f.game[flag] = false;
  }
  f.document.hidden = true;
  for (let i = 0; i < 10; i++) f.conduit.frame(0.25);
  f.document.hidden = false;
  assert.equal(mob.health, 30);
  for (let i = 0; i < 7; i++) f.conduit.frame(0.25);
  assert.equal(mob.health, 30, "loading invalidated the previous partial pulse");
  f.conduit.frame(0.25);
  assert.equal(mob.health, 26);
  buildConduit(f.world, 41, at);
  buildConduit(f.world, 42, at);
  f.conduit.frame(0.25);
  assert.equal(mob.health, 26);
});

test("elder death/drop/completion commits once, never creates player XP", (t) => {
  const f = fixture(t);
  const marker = f.markers[1];
  const mob = f.admit("elder_guardian", {
    x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5,
  }, { structure: f.structure, marker });
  buildConduit(f.world, 42, at);
  assert.equal(f.host.hurt(mob, 76, null, { retaliate: false }).ok, true);
  assert.equal(mob.health, 4);
  const plan = f.conduit.prepareAttack(at);
  assert.ok(plan);
  assert.ok(plan.participants.some((p) => p.owner === f.exploration));
  assert.equal(f.host.commit(plan).ok, true);
  assert.equal(f.host.commit(plan).ok, false);
  assert.equal(f.host.ecology.elder(marker.id).status, "defeated");
  assert.equal(f.exploration.completed(ecologyEncounterProjection(marker)), true);
  assert.equal(ecologyTotals(f).drops[BLOCK.WET_SPONGE], 1);
  assert.equal(ecologyTotals(f).xp, 0);
  assert.equal(f.gameplay.getState().experience.total, 0);
  assert.equal(f.conduit.prepareAttack(at), null);
});

test("retained-drop overflow vetoes environmental death without corpse, completion or partial loot", (t) => {
  const f = fixture(t, { maxEntries: 1 });
  const marker = f.markers[1];
  const mob = f.admit("elder_guardian", {
    x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5,
  }, { structure: f.structure, marker });
  buildConduit(f.world, 42, at);
  assert.equal(f.host.hurt(mob, 76, null, { retaliate: false }).ok, true);
  const before = f.ownership();
  assert.equal(f.conduit.prepareAttack(at), null);
  assert.deepEqual(f.ownership(), before);
  assert.equal(mob.health, 4);
  assert.equal(f.host.ecology.elder(marker.id).status, "alive");
});

test("resident drowned is eligible without inventing a nautilus-shell death route", (t) => {
  const f = fixture(t);
  f.player.position = { x: 30, y: 2, z: 30 };
  const mob = f.admit("drowned", { x: 9.5, y: 3.5, z: 1.5 });
  buildConduit(f.world, 42, at);
  for (let i = 0; i < 40; i++) f.conduit.frame(0.25);
  assert.equal(mob.dead, true);
  assert.equal(ecologyTotals(f).xp, 0);
  assert.equal(ecologyTotals(f).drops[ITEM.NAUTILUS_SHELL], undefined);
});
