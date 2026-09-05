import assert from "node:assert/strict";
import test from "node:test";
import { CombatFeedback } from "../src/combat-feedback.js";
import { VoxelGame } from "../src/game.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { ITEM } from "../src/items.js";
import { ContainerUI } from "../src/settlement-ui.js";
import { createHUD } from "../src/ui/hud.js";
import { containerFixture, editOwnership } from "./container-fixture.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

// Regression for a container opening between frames: the model was inactive,
// but the mounted indicator retained its preceding visible "ready" snapshot.
// Exercise the actual Game/container lifecycle and HUD presenter synchronously.
// Only the container's slot rendering/focus shell is lightweight; the unchanged
// combat browser suite owns real input, CSS visibility and precise gap targeting.
function fixture(t, kind = "chest") {
  const domain = containerFixture(kind);
  const { document, root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {} });
  editOwnership(domain.game, (owned) => {
    owned.slots.fill(null);
    owned.slots[0] = { id: ITEM.IRON_SWORD, count: 1, durability: 42 };
    owned.slots[1] = { id: ITEM.BOW, count: 1, durability: 42 };
    owned.slots[2] = { id: ITEM.ARROW, count: 4 };
  });
  assert.equal(domain.state().kind, kind);
  const target = { entity: { id: "combat-menu-target" }, distance: 2 };
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    world: domain.world,
    gameplay: domain.game,
    settlement: domain.settlement,
    paused: false,
    building: false,
    overlayOpen: false,
    elapsed: 10,
    lastAction: 9,
    meleeTarget: target,
    heldAction: "mine",
    miningKey: "previous-target",
    miningProgress: 0.4,
    combatFeedback: new CombatFeedback(),
    player: {
      enabled: true,
      unlock: t.mock.fn(),
      eyePosition: {
        x: domain.hit.x + 0.5,
        y: domain.hit.y + 2,
        z: domain.hit.z + 0.5,
      },
    },
    effects: { shoot: t.mock.fn() },
    ui: {
      isHudVisible: true,
      updateCombat: hud.updateCombat,
      updateHurt: hud.updateHurt,
      update: t.mock.fn(),
    },
    refreshHud: t.mock.fn(),
    scheduleSave: t.mock.fn(),
    resetHeldButtons: t.mock.fn(),
  });
  game.useActions = new GameUseActions(game);
  const element = document.createElement("div");
  element.hidden = true;
  const closeButton = document.createElement("button");
  const status = document.createElement("p");
  element.append(closeButton, status);
  game.containerUI = Object.assign(Object.create(ContainerUI.prototype), {
    document,
    element,
    closeButton,
    status,
    _session: null,
    _interactions: { busy: false, reset() {} },
    onOpenChange: (open) => game.overlayChanged(open),
    onChange: t.mock.fn(),
    onToast: t.mock.fn(),
    refresh: t.mock.fn(() => true),
  });
  const input = () => ({
    now: game.elapsed,
    lastAction: game.lastAction,
    active: game.active,
    hasTarget: !!game.meleeTarget,
    usingItem: game.useActions.use.active,
    hudVisible: game.ui.isHudVisible,
  });
  const view = () => game.combatFeedback.view(input());
  const present = () => {
    const state = view();
    game.ui.updateCombat(state);
    return state;
  };
  t.after(() => {
    hud.dispose();
    domain.game.dispose();
    domain.settlement.dispose();
    domain.world.dispose();
  });
  return {
    game,
    target,
    node: get(".game-hud").querySelector(".combat-indicator"),
    hit: domain.hit,
    snapshot: domain.snapshot,
    input,
    view,
    present,
  };
}

for (const kind of ["chest", "furnace"]) {
  test(`${kind} open hides mounted combat feedback before returning, without a frame or full HUD refresh`, (t) => {
    const { game, node, hit, snapshot, view, present } = fixture(t, kind);
    assert.equal(present().phase, "ready");
    assert.equal(node.hidden, false);
    const before = snapshot();
    const lastAction = game.lastAction;
    const elapsed = game.elapsed;

    assert.equal(game.openStation(hit), true);
    assert.equal(game.containerUI.isOpen, true);
    assert.equal(game.containerUI.element.hidden, false);
    assert.deepEqual(game.containerUI._session.hit, hit);
    assert.deepEqual(game.containerUI.observerErrors, []);
    // Do not present another snapshot before this assertion. The reset callback,
    // not a later frame or an unrelated menu CSS gate, must invalidate the node.
    assert.equal(node.hidden, true, "opening the container hides combat now");
    assert.equal(view().visible, false);
    assert.equal(game.active, false);
    assert.equal(game.simulating, true, "opening a container is not a pause");
    assert.equal(game.player.enabled, false);
    assert.equal(game.player.unlock.mock.callCount(), 1);
    assert.equal(game.heldAction, null);
    assert.equal(game.meleeTarget, null);
    assert.equal(game.miningKey, "");
    assert.equal(game.miningProgress, 0);
    assert.equal(game.resetHeldButtons.mock.callCount(), 1);
    assert.equal(game.elapsed, elapsed);
    assert.equal(game.lastAction, lastAction);
    assert.deepEqual(snapshot(), before);
    assert.equal(game.ui.update.mock.callCount(), 0);
    assert.equal(game.refreshHud.mock.callCount(), 0);
    assert.equal(game.scheduleSave.mock.callCount(), 0);
  });
}

test("menu open clears a refusal immediately; close needs a fresh target and preserves the unfinished cooldown", (t) => {
  const { game, node, hit, target, snapshot, input, present } = fixture(t);
  game.lastAction = game.elapsed - 0.25;
  assert.equal(game.combatFeedback.noteAttempt(input()).acknowledged, true);
  const previous = present();
  assert.equal(node.hidden, false);
  assert.equal(node.dataset.blocked, "cooldown");
  const before = snapshot();
  const lastAction = game.lastAction;
  const elapsed = game.elapsed;

  assert.equal(game.openStation(hit), true);
  assert.equal(node.hidden, true);
  assert.equal(node.dataset.blocked, "");
  assert.equal(game.combatFeedback.acknowledgedAt, -Infinity);
  assert.equal(present().visible, false);
  assert.equal(node.hidden, true);

  // Keep the isolated host paused through close so no asynchronous play/capture
  // work is needed. Re-enable activity without advancing the clock afterwards.
  game.paused = true;
  assert.equal(game.containerUI.close(), true);
  assert.deepEqual(game.containerUI.observerErrors, []);
  assert.equal(game.containerUI.isOpen, false);
  assert.equal(game.containerUI.element.hidden, true);
  assert.equal(node.hidden, true);
  game.paused = false;
  assert.equal(game.active, true);
  assert.equal(
    present().visible,
    false,
    "closing cannot revive the old target"
  );
  assert.equal(node.hidden, true);

  game.meleeTarget = target;
  const reacquired = present();
  assert.equal(node.hidden, false);
  assert.equal(reacquired.phase, "cooldown");
  assert.equal(reacquired.ready, false);
  assert.equal(reacquired.progress, previous.progress);
  assert.equal(reacquired.remaining, previous.remaining);
  assert.equal(reacquired.blockedReason, null);
  assert.equal(node.dataset.blocked, "");
  assert.equal(game.lastAction, lastAction);
  assert.equal(game.elapsed, elapsed);
  assert.deepEqual(snapshot(), before);
});

test("an inventory-style menu reset hides using-item feedback and cancels a charged bow without a release cost", (t) => {
  const { game, node, snapshot, input, present } = fixture(t);
  game.gameplay.select(1);
  assert.equal(
    game.useActions.use.start(
      "bow",
      "main",
      game.gameplay.getHandStack(),
      game.gameplay.getHandRevision("main")
    ),
    true
  );
  game.useActions.held = true;
  game.useActions.source = "remote-key";
  for (let step = 0; step < 4; step++) game.useActions.use.advance(0.25);
  assert.equal(game.useActions.use.progress, 1);
  assert.equal(game.combatFeedback.noteAttempt(input()).acknowledged, true);
  assert.equal(present().phase, "using-item");
  assert.equal(node.hidden, false);
  assert.equal(node.dataset.blocked, "using-item");
  const before = snapshot();
  const lastAction = game.lastAction;

  game.overlayChanged(true);
  assert.equal(node.hidden, true, "menu reset is synchronous during item use");
  assert.equal(node.dataset.blocked, "");
  assert.equal(game.active, false);
  assert.equal(game.useActions.use.active, false);
  assert.equal(game.useActions.held, false);
  assert.equal(game.useActions.source, null);
  assert.equal(game.endUse("remote-key"), false);
  assert.equal(game.effects.shoot.mock.callCount(), 0);
  assert.equal(game.lastAction, lastAction);
  assert.deepEqual(
    snapshot(),
    before,
    "no arrow, bow wear or ownership change"
  );
  assert.equal(game.ui.update.mock.callCount(), 0);
  assert.equal(game.refreshHud.mock.callCount(), 0);
  assert.equal(game.scheduleSave.mock.callCount(), 0);
});
