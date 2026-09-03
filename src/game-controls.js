const RESERVED_KEYS = new Set(["F1", "F3", "F5"]);
const isEditing = (event) =>
  event.target?.isContentEditable ||
  Boolean(
    event.target?.closest?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    )
  );

export function bindGameControls(game) {
  const abort = new AbortController();
  const heldButtons = new Set();
  let rightMode = null;
  let remoteUse = false;
  // resetActions owns gameplay cancellation. Its callback must only forget
  // transport state, never call resetActions or the Player back recursively.
  const resetHeldButtons = () => {
    heldButtons.clear();
    rightMode = null;
    remoteUse = false;
  };
  game.resetHeldButtons = resetHeldButtons;
  const playing = () =>
    game.active &&
    game.player?.enabled &&
    !game.ui.isMenuOpen &&
    !game.ui.isOverlayOpen;
  const actions = new Map([
    ["KeyF", () => game.swapHands()],
    ["KeyQ", (event) => game.dropSelected(Boolean(event.ctrlKey))],
    ["F1", () => game.ui.toggleHud()],
    ["F3", () => game.ui.toggleDebug()],
    ["F5", () => game.cyclePerspective()],
    ["KeyP", () => void game.save(true)],
  ]);
  const listen = (target, type, callback, options = {}) =>
    target.addEventListener(type, callback, {
      ...options,
      signal: abort.signal,
    });
  const clearMining = () => {
    game.miningKey = "";
    game.miningProgress = 0;
  };
  const syncMining = () => {
    game.heldAction =
      playing() && heldButtons.has(0) && rightMode !== "native" && !remoteUse
        ? "mine"
        : null;
    if (game.heldAction !== "mine") clearMining();
  };
  const cancelAll = () => {
    if (rightMode === "native") game.endUse("mouse", true);
    if (remoteUse) game.endUse("remote-key", true);
    game.resetActions();
  };
  const lostButtons = (event) => {
    if (!Number.isFinite(event.buttons)) {
      syncMining();
      return;
    }
    if (heldButtons.has(0) && !(event.buttons & 1)) {
      heldButtons.delete(0);
      clearMining();
    }
    if (heldButtons.has(2) && !(event.buttons & 2)) {
      heldButtons.delete(2);
      const previousMode = rightMode;
      rightMode = null;
      if (previousMode === "native") game.endUse("mouse", true);
      // RemoteLook itself clears its gesture on a no-RMB mousemove. The
      // forgotten press also prevents any later release from becoming a tap.
    }
    syncMining();
  };
  listen(document, "pointerlockchange", () => {
    if (game.player?.inputMode !== "native" || game.player.locked) return;
    cancelAll();
    if (
      !game.paused &&
      !game.overlayOpen &&
      !game.gameplay.dead &&
      !game.building
    )
      void game.pause();
  });
  listen(
    window,
    "keydown",
    (event) => {
      if (
        !game.started ||
        event.defaultPrevented ||
        !RESERVED_KEYS.has(event.code)
      )
        return;
      // Modal capture may stop propagation before the game listener. F1/F3
      // belong to the UI there; F5 must still never reload, nor may text inputs
      // open browser Help/Find instead of leaving gameplay shortcuts inactive.
      if (
        isEditing(event) ||
        game.building ||
        !game.player ||
        (event.code === "F5" &&
          (game.paused ||
            game.overlayOpen ||
            game.gameplay.dead ||
            game.ui.isMenuOpen ||
            game.ui.isOverlayOpen))
      )
        event.preventDefault();
    },
    { capture: true }
  );
  listen(document, "keydown", (event) => {
    if (event.defaultPrevented) return;
    if (game.started && RESERVED_KEYS.has(event.code)) event.preventDefault();
    if (event.code === "Escape" && game.started) {
      event.preventDefault();
      if (event.repeat || game.building || game.gameplay.dead) return;
      if (game.containerUI?.isOpen) game.containerUI.close();
      else if (game.overlayOpen) {
        void game.ui.closeInventory();
        game.ui.closeAtlas?.();
      } else if (!game.paused) void game.pause();
      else if (
        game.ui.isMenuOpen &&
        document.querySelector?.(".menu-screen")?.dataset.page === "main"
      )
        void game.play();
      return;
    }
    if (isEditing(event)) return;
    if (
      game.paused ||
      !game.player ||
      game.building ||
      game.gameplay.dead ||
      game.ui.isMenuOpen
    )
      return;
    if (event.code === "KeyE") {
      event.preventDefault();
      if (event.repeat) return;
      if (game.containerUI?.isOpen) game.containerUI.close();
      else game.ui.toggleInventory();
      return;
    }
    // Mineslop extensions: B opens the atlas; P saves the local world.
    if (event.code === "KeyB") {
      event.preventDefault();
      if (event.repeat || game.containerUI?.isOpen) return;
      game.ui.toggleAtlas?.();
      return;
    }
    if (game.overlayOpen || game.ui.isOverlayOpen) return;
    if (event.code === "KeyV" && game.player.inputMode === "remote") {
      event.preventDefault();
      if (event.repeat || remoteUse || !playing()) return;
      remoteUse = true;
      syncMining();
      game.beginUse("remote-key");
      return;
    }
    if (/^Digit[1-9]$/.test(event.code)) {
      event.preventDefault();
      game.select(Number(event.code.slice(5)) - 1);
      return;
    }
    const action = actions.get(event.code);
    if (action) {
      event.preventDefault();
      if (!event.repeat) action(event);
    }
  });
  listen(
    document,
    "keyup",
    (event) => {
      if (event.code !== "KeyV" || !remoteUse) return;
      remoteUse = false;
      game.endUse(
        "remote-key",
        !playing() || game.player?.inputMode !== "remote" || isEditing(event)
      );
      syncMining();
    },
    { capture: true }
  );
  listen(game.container, "mousedown", (event) => {
    if (event.defaultPrevented || !playing()) return;
    if (!game.player.inputReady) {
      void game.player.lock();
      return;
    }
    lostButtons(event);
    if (heldButtons.has(event.button)) return;
    if (event.button === 2) {
      event.preventDefault();
      heldButtons.add(2);
      rightMode = game.player.inputMode;
      syncMining();
      if (rightMode === "remote") game.player.beginRemoteLook(event);
      else game.beginUse("mouse");
      return;
    }
    game.updateTarget();
    if (event.button === 0) {
      heldButtons.add(0);
      syncMining();
      if (game.heldAction === "mine")
        game.primary(game.gameplay.mode === "creative" ? 1 : 0, true);
    } else if (event.button === 1) {
      event.preventDefault();
      game.pickBlock();
    }
  });
  // UI stops bubbling. Real releases still end a held use; state loss cancels
  // instead, so a charged bow cannot fire after a menu/focus/world transition.
  listen(
    document,
    "mouseup",
    (event) => {
      if (event.button === 0) {
        heldButtons.delete(0);
        clearMining();
      }
      if (event.button === 2) {
        const previousMode = rightMode;
        heldButtons.delete(2);
        rightMode = null;
        if (previousMode === "native")
          game.endUse(
            "mouse",
            !playing() || game.player?.inputMode !== "native"
          );
        const tap = game.player?.endRemoteLook(event);
        if (
          previousMode === "remote" &&
          tap &&
          playing() &&
          game.container.contains(event.target)
        ) {
          game.updateTarget();
          game.secondary();
        }
      }
      lostButtons(event);
    },
    { capture: true }
  );
  listen(
    document,
    "mousemove",
    (event) => {
      if (!playing() && (heldButtons.size || remoteUse)) cancelAll();
      else lostButtons(event);
    },
    { capture: true }
  );
  listen(game.container, "contextmenu", (event) => event.preventDefault());
  listen(
    game.container,
    "wheel",
    (event) => {
      if (!playing()) return;
      event.preventDefault();
      game.select((game.gameplay.selected + (event.deltaY > 0 ? 1 : 8)) % 9);
    },
    { passive: false }
  );
  listen(document, "pointercancel", cancelAll, { capture: true });
  listen(
    document,
    "focusin",
    (event) => {
      if (isEditing(event)) cancelAll();
    },
    { capture: true }
  );
  listen(window, "resize", () => {
    cancelAll();
    game.graphics?.resize();
  });
  listen(window, "blur", () => {
    cancelAll();
    if (game.started && !game.paused && !game.overlayOpen && !game.building)
      game.pause();
  });
  listen(document, "visibilitychange", () => {
    game.resetFrameRate?.();
    game.graphics?.observeFrame?.(0, {
      paused: game.paused,
      hidden: document.hidden,
    });
    if (document.hidden) {
      cancelAll();
      if (game.started) void game.save();
      if (game.active) game.pause();
    }
  });
  listen(window, "pagehide", () => {
    cancelAll();
    if (game.started) void game.save();
  });
  return () => {
    abort.abort();
    if (game.resetHeldButtons === resetHeldButtons) {
      cancelAll();
      delete game.resetHeldButtons;
    }
  };
}
