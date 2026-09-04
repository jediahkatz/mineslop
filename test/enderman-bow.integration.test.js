import assert from "node:assert/strict";
import test from "node:test";
import { stackIdentity } from "../src/item-stack-data.js";
import { getItem, ITEM } from "../src/items.js";
import { ecosystem } from "./mob-fixtures.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

function fixture(t, kind = "enderman", trapped = false) {
  const base = parityGame("survival");
  const { game } = base;
  const wildlife = ecosystem(game.world, {
    context: game.worldContext,
    onDrop: (...args) => base.drops.push(args),
  });
  t.after(() => wildlife.dispose());
  game.wildlife = wildlife;
  const mob = wildlife.spawn(kind, { x: 0.5, y: 9, z: 6.5 });
  assert.ok(mob);
  game.player.forward.set(0, (kind === "enderman" ? 2.855 : 1) - 1.62, 6).normalize();
  wildlife.update(0, 0, game.player.position, {
    mode: "survival", playerEye: game.player.eyePosition, playerForward: game.player.forward,
  });
  assert.equal(wildlife.raycast(game.player.eyePosition, game.player.forward, 32)?.entity, mob);
  setOwnedSlots(game, [
    [0, { id: ITEM.BOW, count: 1, durability: 20 }],
    [9, { id: ITEM.ARROW, count: 3 }],
  ]);
  if (trapped) {
    const loaded = game.world.isLoaded.bind(game.world);
    game.world.isLoaded = (x, z) => loaded(x, z) && x === 0 && z >= 0 && z <= 6;
  }
  const shot = Object.freeze({
    hand: "main", itemId: ITEM.BOW, strength: 1,
    stackIdentity: stackIdentity(game.gameplay.getHandStack(), game.gameplay.context),
    handRevision: game.gameplay.getHandRevision(),
  });
  return { ...base, wildlife, mob, shot };
}

function paidOnce(f) {
  assert.equal(f.game.gameplay.countPlain(ITEM.ARROW), 2);
  assert.equal(f.game.gameplay.getHandStack().durability, 19);
  assert.equal(f.game.gameplay.getHandRevision(), f.shot.handRevision + 1);
  const after = f.game.gameplay.serialize();
  assert.equal(f.game.useActions.fireBow(f.shot), false);
  assert.equal(f.game.useActions.fireBow({ ...f.shot }), false);
  assert.deepEqual(f.game.gameplay.serialize(), after);
}

for (const trapped of [false, true]) {
  for (const throwing of [false, true]) {
    test(`real bow Enderman ${trapped ? "trapped immunity" : "safe dodge"} survives ${throwing ? "throwing" : "normal"} observers`, (t) => {
      const f = fixture(t, "enderman", trapped);
      const before = f.mob.position.clone();
      const health = f.mob.health;
      let changes = 0, shoots = 0, sounds = 0, saves = 0, hud = 0;
      const replay = [];
      f.game.gameplay.onChange = () => {
        changes++;
        replay.push(f.game.useActions.fireBow(f.shot));
      };
      f.game.effects.shoot = () => {
        shoots++;
        assert.equal(f.mob.health, health);
        assert.ok(f.mob.teleportCooldown > 0, "gameplay handling precedes presentation");
        replay.push(f.game.useActions.fireBow({ ...f.shot }));
        if (throwing) throw new Error("shot observer");
      };
      f.game.effects.sound = () => { sounds++; if (throwing) throw new Error("sound observer"); };
      f.game.scheduleSave = () => saves++;
      f.game.refreshHud = () => hud++;
      assert.equal(f.game.useActions.fireBow(f.shot), true);
      assert.equal(f.mob.health, health);
      assert.equal(f.mob.position.equals(before), trapped);
      assert.equal(f.mob.angry, 0);
      assert.equal(f.mob.hitFlash, 0);
      assert.equal(f.wildlife.byId.get(f.mob.id), f.mob);
      assert.deepEqual(f.drops, []);
      assert.deepEqual(f.experience, []);
      assert.deepEqual(replay, [false, false]);
      assert.deepEqual([changes, shoots, sounds, saves, hud], [1, 1, 1, 1, 1]);
      assert.equal(f.game.useActions.observerErrors.length, throwing ? 2 : 0);
      paidOnce(f);
    });
  }
}

test("real bow still damages other legacy mobs without optional dodge capability and despite throwing observers", (t) => {
  const f = fixture(t, "zombie");
  f.wildlife.dodgeProjectile = undefined;
  const health = f.mob.health;
  f.game.effects.shoot = () => { throw new Error("shot"); };
  f.game.effects.sound = () => { throw new Error("sound"); };
  assert.equal(f.game.useActions.fireBow(f.shot), true);
  assert.equal(f.mob.health, health - getItem(ITEM.BOW).damage);
  assert.deepEqual(f.drops, []);
  assert.deepEqual(f.experience, []);
  assert.equal(f.game.useActions.observerErrors.length, 2);
  paidOnce(f);
});

for (const replacement of [
  "world", "player", "wildlife", "target", "moved", "epoch", "dimension",
  "dead", "dormant", "disposed", "player-moved", "aim",
]) {
  for (const kind of ["enderman", "zombie"]) {
    test(`paid ${kind} bow skips stale ${replacement} after payment notification`, (t) => {
      const f = fixture(t, kind);
      const before = f.mob.position.clone(), health = f.mob.health;
      f.game.gameplay.onChange = () => {
        if (replacement === "world") f.game.world = { ...f.game.world };
        if (replacement === "player") f.game.player = { ...f.game.player };
        if (replacement === "wildlife") f.game.wildlife = { ...f.wildlife };
        if (replacement === "target") f.wildlife.byId.set(f.mob.id, { ...f.mob });
        if (replacement === "moved") f.mob.position.x += 1;
        if (replacement === "epoch") f.game.world.epoch++;
        if (replacement === "dimension") f.game.world.dimension = "nether";
        if (replacement === "dead") f.mob.dead = true;
        if (replacement === "dormant") f.mob.dormant = true;
        if (replacement === "disposed") f.wildlife.dispose();
        if (replacement === "player-moved") f.game.player.position.x += 1;
        if (replacement === "aim") f.game.player.forward.set(0, 0, -1);
      };
      assert.equal(f.game.useActions.fireBow(f.shot), true, "paid release remains consumed");
      assert.equal(f.mob.health, health);
      assert.equal(f.mob.teleportCooldown, 0);
      assert.equal(f.mob.position.x, before.x + (replacement === "moved" ? 1 : 0));
      assert.deepEqual(f.drops, []);
      assert.deepEqual(f.experience, []);
      paidOnce(f);
    });
  }
}

test("a throwing payment observer cannot skip Enderman handling or make the release retryable", (t) => {
  const f = fixture(t);
  const error = new Error("payment notification");
  f.game.gameplay.onChange = () => { throw error; };
  assert.equal(f.game.useActions.fireBow(f.shot), true);
  assert.equal(f.mob.health, 40);
  assert.ok(f.mob.teleportCooldown > 0);
  assert.deepEqual(f.game.useActions.observerErrors, [error]);
  paidOnce(f);
});

test("presentation replacement cannot redirect a paid shot or subsequent observers to a new world", (t) => {
  const f = fixture(t);
  let sounds = 0, saves = 0;
  f.game.effects.shoot = () => {
    assert.equal(f.mob.health, 40);
    assert.ok(f.mob.teleportCooldown > 0);
    f.game.world = { ...f.game.world };
  };
  f.game.effects.sound = () => sounds++;
  f.game.scheduleSave = () => saves++;
  assert.equal(f.game.useActions.fireBow(f.shot), true);
  assert.equal(sounds, 0);
  assert.equal(saves, 0);
  paidOnce(f);
});
