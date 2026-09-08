import "../../src/style.css";
import "../../src/settlement.css";
import { VoxelGame } from "../../src/game.js";
import { nativeExplorationContext } from "../../src/exploration-host-state.js";
import { ITEM } from "../../src/items.js";
import {
  locateStructure,
  resolveStructureMapTarget,
} from "../../src/structure-catalog.js";
import { describeV7Structure } from "../../src/terrain-v7-manifest.js";

const game = new VoxelGame(document.querySelector("#game"));
const documentId = crypto.randomUUID();
const observedDomInputs = { trusted: 0, untrusted: 0 };
const privilegedActions = [];
const mapAnnouncements = [];
const mapVisibleUpdates = [];
let ready = false;
let error = null;
let discoveredRoute = null;

for (const type of ["keydown", "keyup", "mousedown", "mouseup", "mousemove"])
  document.addEventListener(
    type,
    (event) => observedDomInputs[event.isTrusted ? "trusted" : "untrusted"]++,
    { capture: true, passive: true }
  );

const announcement = document.querySelector(".map-guidance-announcement");
const visibleGuidance = document.querySelector(".map-guidance");
let lastAnnouncement = announcement.textContent;
let lastVisibleGuidance = visibleGuidance.textContent;
new MutationObserver(() => {
  const text = announcement.textContent;
  if (text !== lastAnnouncement) {
    lastAnnouncement = text;
    mapAnnouncements.push(text);
  }
}).observe(announcement, { childList: true, characterData: true, subtree: true });
new MutationObserver(() => {
  const text = visibleGuidance.textContent;
  if (text !== lastVisibleGuidance) {
    lastVisibleGuidance = text;
    mapVisibleUpdates.push(text);
  }
}).observe(visibleGuidance, { childList: true, characterData: true, subtree: true });

function computeRoute() {
  if (!ready || game.world.generatorVersion !== 7) return null;
  const context = nativeExplorationContext(game.world);
  const located = locateStructure(
    "shipwreck",
    context,
    { x: 0, z: 0 },
    { radius: 12, maxCells: 625, maxSamples: 12288 }
  );
  if (!located.target) return null;
  const shipwreck = describeV7Structure(
    "shipwreck",
    { ...context, generatorVersion: 7 },
    located.target.gx,
    located.target.gz
  );
  const chart = shipwreck.markers.find(
    (marker) => marker.type === "container" && marker.mapTarget
  );
  if (!chart) return null;
  const mapped = resolveStructureMapTarget(chart.mapTarget, context).target;
  if (!mapped) return null;
  const treasure = describeV7Structure(
    "buried_treasure",
    { ...context, generatorVersion: 7 },
    mapped.gx,
    mapped.gz
  );
  const heart = treasure.markers.find(
    (marker) => marker.type === "container"
  );
  const route = {
    shipwreck: {
      id: shipwreck.id,
      variant: shipwreck.variant,
      entry: shipwreck.entries[0],
    },
    chart,
    mapped,
    treasure: {
      id: treasure.id,
      entry: treasure.entries[0],
      marker: heart,
      cover: [3, 2, 1].map((dy) => ({
        x: heart.position.x,
        y: heart.position.y + dy,
        z: heart.position.z,
      })),
    },
  };
  return structuredClone(route);
}

function recordPrivileged(type) {
  const receipt = Object.freeze({
    sequence: privilegedActions.length + 1,
    type,
  });
  privilegedActions.push(receipt);
  return receipt;
}

function discover() {
  recordPrivileged("locator-discover");
  discoveredRoute = computeRoute();
  return structuredClone(discoveredRoute);
}

const values = (state) =>
  [
    ...(state?.slots ?? []),
    state?.cursor,
    state?.offhand,
    ...Object.values(state?.equipment ?? {}),
    ...(state?.craftingGrid ?? []),
  ].filter(Boolean);

function read() {
  const base = {
    ready: ready && !game.building,
    error,
    documentId,
    observedDomInputs: structuredClone(observedDomInputs),
    privilegedActions: structuredClone(privilegedActions),
    routeAvailable: discoveredRoute !== null,
    mapAnnouncements: [...mapAnnouncements],
    mapVisibleUpdates: [...mapVisibleUpdates],
  };
  if (!base.ready) return base;
  const state = game.gameplay.getState();
  const position = game.player.position;
  const container = game.containerUI.isOpen
    ? game.settlement.getContainerState(
        game.world,
        game.containerUI._session.hit,
        game.gameplay
      )
    : null;
  const route = discoveredRoute;
  const observedCells = [
    ...(route?.treasure.cover ?? []),
    ...(route?.treasure.marker ? [route.treasure.marker.position] : []),
  ];
  return {
    ...base,
    active: game.active,
    paused: game.paused,
    locked: game.player.locked,
    overlayOpen: game.overlayOpen,
    containerOpen: game.containerUI.isOpen,
    position: { x: position.x, y: position.y, z: position.z },
    eye: {
      x: game.player.eyePosition.x,
      y: game.player.eyePosition.y,
      z: game.player.eyePosition.z,
    },
    yaw: game.player.yaw,
    pitch: game.player.pitch,
    target: game.target ? structuredClone(game.target) : null,
    cells: Object.fromEntries(
      observedCells.map((cell) => [
        `${cell.x},${cell.y},${cell.z}`,
        game.world.isLoaded(cell.x, cell.z)
          ? game.world.get(cell.x, cell.y, cell.z)
          : null,
      ])
    ),
    seed: game.world.seed,
    generatorVersion: game.world.generatorVersion,
    mode: game.gameplay.mode,
    selected: state.selected,
    slots: structuredClone(state.slots),
    inventory: structuredClone(values(state)),
    containerSlots: structuredClone(container?.slots ?? []),
    claims: structuredClone(
      game.explorationServices?.serialize().exploration.containers ?? []
    ),
    mapGuidance:
      document.querySelector(".map-guidance")?.textContent ?? "",
    mapGuidanceVisible:
      document.querySelector(".map-guidance")?.hidden === false,
    storageRevision: game.storage.revision,
    storageStatus: game.storageStatus,
    toast: document.querySelector(".toast > span")?.textContent ?? "",
    heartCount: values(state)
      .filter((stack) => stack.id === ITEM.HEART_OF_THE_SEA)
      .reduce((total, stack) => total + stack.count, 0),
    mapCount: values(state)
      .filter((stack) => stack.id === ITEM.TREASURE_MAP)
      .reduce((total, stack) => total + stack.count, 0),
  };
}

async function travel(which) {
  const route = discoveredRoute;
  const destination =
    which === "chart" ? route?.chart?.position : route?.treasure?.entry;
  if (!destination) throw new RangeError("Unknown natural destination");
  recordPrivileged(`game-teleport:${which}`);
  return game.teleport(destination);
}

async function probeGuidance(positions) {
  if (
    !discoveredRoute ||
    !Array.isArray(positions) ||
    !positions.length ||
    positions.length > 8 ||
    positions.some(
      (position) =>
        !position ||
        ![position.x, position.y, position.z].every(Number.isFinite)
    )
  )
    throw new RangeError("Invalid bounded HUD position probe");
  recordPrivileged("hud-position-probe");
  for (const position of positions) {
    game.ui.update({ position });
    await Promise.resolve();
  }
  game.ui.update({ position: game.player.position });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return read();
}

Object.defineProperty(window, "__oceanAcceptance", {
  value: Object.freeze({ discover, probeGuidance, read, travel }),
  writable: false,
  configurable: false,
});

game
  .start()
  .then(() => {
    ready = true;
  })
  .catch((failure) => {
    error = failure.message;
    game.showError(failure);
  });
