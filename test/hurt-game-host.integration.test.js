import assert from "node:assert/strict";
import test from "node:test";
import { Gameplay } from "../src/gameplay.js";
import { HurtFeedback } from "../src/hurt-feedback.js";
import { parityGame } from "./parity-fixture.js";

// These exercise the small parent-owned Game binding/reset hunks at checkpoint.
// Damage remains real Gameplay damage; no callback or health loss is fabricated.
function fixture(t) {
  const { game } = parityGame();
  const initial = game.gameplay;
  const feedback = new HurtFeedback({ motionPreference: { matches: false } });
  game.hurtFeedback = feedback;
  let hudVisible = false;
  game.ui.updateHurt = (view) => {
    hudVisible = view?.visible === true;
  };
  game.player.unlock = () => {};
  game.containerUI.close = () => true;
  game.bindGameplay(initial);
  t.after(() => {
    feedback.dispose();
    initial.dispose();
    game.gameplay.dispose();
    game.buildingActions.dispose();
    game.overflow.dispose();
    game.settlement.dispose();
    game.fuses.dispose();
  });
  return { game, feedback, hudVisible: () => hudVisible };
}

test("the live Game binding observes damage and input/death resets clear both pulse and mounted HUD", (t) => {
  const { game, feedback, hudVisible } = fixture(t);
  game.gameplay.damage(2, "fall");
  const hurt = feedback.update(0);
  assert.equal(hurt.visible, true);
  game.ui.updateHurt(hurt);
  assert.equal(hudVisible(), true);
  game.resetActions();
  assert.equal(feedback.update(0).visible, false);
  assert.equal(hudVisible(), false);
  game.gameplay.damage(2);
  game.ui.updateHurt(feedback.update(0));
  assert.equal(hudVisible(), true);
  game.gameplay.damage(50);
  assert.equal(game.gameplay.dead, true);
  assert.equal(feedback.update(0).visible, false);
  assert.equal(hudVisible(), false);
  game.gameplay.respawn();
  assert.equal(feedback.update(0).visible, false);
});

test("binding a loaded/replacement owner clears old hurt and ignores a detached old owner's later damage", (t) => {
  const { game, feedback } = fixture(t);
  const previous = game.gameplay;
  previous.damage(1);
  assert.equal(feedback.update(0).visible, true);
  const replacement = new Gameplay({
    coordinator: game.coordinator,
    context: game.worldContext,
  });
  assert.equal(
    replacement.load(
      {
        ...replacement.serialize(),
        health: 9,
      },
      { notify: false }
    ),
    true
  );
  game.gameplay = game.bindGameplay(replacement);
  assert.equal(feedback.update(0).visible, false);
  assert.equal(previous.damage(1), 1);
  assert.equal(feedback.update(0).visible, false);
  assert.equal(replacement.damage(1), 1);
  assert.equal(feedback.update(0).visible, true);
});
