/**
 * Read-only, serialized directly into the page by Playwright. The optional
 * environment lets unit regressions exercise the same predicate without a
 * browser, timers, or changes to game/storage methods.
 */
export function completedFpsImport(
  before,
  {
    game = globalThis.window?.__voxelBot?.game,
    hostError = globalThis.window?.__voxelBot?.error,
    root = globalThis.document,
  } = {}
) {
  const storage = game?.storage;
  const status = root?.querySelector(".storage-status");
  const menu = root?.querySelector(".menu-screen");
  const loading = root?.querySelector(".loading-screen");
  const sameGame = Boolean(game && game === before?.game);
  const sameStorage = Boolean(storage && storage === before?.storage);
  const worldReplaced = Boolean(
    before?.world && game?.world && game.world !== before.world
  );
  // WorldStorage publishes this token only after its transaction commits.
  // The pre-import checkpoint also saves, so this alone is NOT completion.
  const revisionChanged =
    typeof before?.revision === "string" &&
    before.revision.length > 0 &&
    typeof storage?.revision === "string" &&
    storage.revision.length > 0 &&
    storage.revision !== before.revision;
  const storageReady = Boolean(storage?.hydrated === true && storage.database);
  const gatesIdle =
    game?.building === false &&
    game.transitionGate?.busy === false &&
    !game.closingScreens &&
    !game.screenClose &&
    !game.playing &&
    game.started === true &&
    game.paused === true &&
    game.overlayOpen === false &&
    menu?.hidden === false &&
    menu.getAttribute("aria-busy") === "false" &&
    loading?.hidden === true;
  const controlsEnabled = [
    ".save-button",
    ".export-button",
    ".import-button",
    ".import-file",
    ".play-button",
    ".menu-back-button",
    ".generate-button",
    ".new-world-button",
  ].every((selector) => root?.querySelector(selector)?.disabled === false);
  const saveSucceeded =
    game?.storageStatus === "Saved on this device" &&
    game.saveErrorReported === false;
  const errorFree = game?.failed === false && !hostError;
  const uiState = status?.dataset?.state;
  const uiText = status?.textContent?.trim() ?? "";
  // The HUD can replace the brief imported/success label with saved/idle.
  // Neither UI form can stand in for the committed save and idle gates above.
  const successStatus =
    (uiState === "success" && /\bimported\b/i.test(uiText)) ||
    (uiState === "idle" && uiText === "Saved on this device");
  if (
    !sameGame ||
    !sameStorage ||
    !worldReplaced ||
    !revisionChanged ||
    !storageReady ||
    !gatesIdle ||
    !controlsEnabled ||
    !saveSucceeded ||
    !errorFree ||
    !successStatus
  )
    return false;
  return {
    sameGame,
    sameStorage,
    worldReplaced,
    revisionChanged,
    storageReady,
    gatesIdle,
    controlsEnabled,
    saveSucceeded,
    errorFree,
    modelStatus: game.storageStatus,
    saveErrorReported: game.saveErrorReported,
    uiState,
    uiText,
  };
}
