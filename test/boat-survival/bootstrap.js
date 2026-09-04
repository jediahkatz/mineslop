import "../../src/style.css";
import "../../src/settlement.css";
import { VoxelGame } from "../../src/game.js";
import { collidesWithWorld } from "../../src/player.js";
import { DAY_SECONDS } from "../../src/world-clock.js";
import { cellKey, planShoreRoute, planTreeRoute, planWalkingRoute } from "./planning.js";
import { renderedCameraOrientation, shortestYawDelta } from "./yaw-follow.mjs";

// The same constructor, styles, DOM roots and start() as src/main.js. There are
// no query-string overrides, extra initializers, fixtures or production globals.
// Use a disposable browser context: this actual Game owns an actual local save.
const game = new VoxelGame(document.querySelector("#game"));
const documentId = crypto.randomUUID();
const inputs = { trusted: 0, untrusted: 0, byType: {}, byKey: {} };
let ready = false, error = null, initialPose = null, firstActivePose = null;
const frames = [];
const vector = (value) => value ? { x: value.x, y: value.y, z: value.z } : null;

for (const type of ["keydown", "keyup", "mousedown", "mouseup", "mousemove"]) {
  document.addEventListener(type, (event) => {
    inputs[event.isTrusted ? "trusted" : "untrusted"]++;
    inputs.byType[type] = (inputs.byType[type] ?? 0) + 1;
    if (type === "keydown") inputs.byKey[event.code] = (inputs.byKey[event.code] ?? 0) + 1;
  }, { capture: true, passive: true });
}

function pose() {
  const player = game.player;
  const boat = game.boats?.size === 1
    ? game.boats.getBoat(game.boats.serialize().boats[0].id) : null;
  const rendered = renderedCameraOrientation(game.graphics?.camera.matrixWorld.elements);
  return {
    frame: game.vehicleFrame ?? 0,
    at: performance.now(),
    active: game.active,
    position: vector(player?.position),
    eye: vector(player?.eyePosition),
    camera: vector(game.graphics?.camera.position),
    velocity: vector(player?.velocity),
    yaw: player?.yaw,
    pitch: player?.pitch,
    cameraForward: rendered?.cameraForward ?? null,
    cameraYaw: rendered?.cameraYaw ?? null,
    cameraPitch: rendered?.cameraPitch ?? null,
    hullYaw: boat?.yaw ?? null,
    relativeViewYaw: player?.seated && boat
      ? shortestYawDelta(player.yaw, boat.yaw) : null,
    relativeCameraYaw: player?.seated && boat && rendered
      ? shortestYawDelta(rendered.cameraYaw, boat.yaw) : null,
    seated: player?.seated,
    vehicleType: player?.vehicleType,
    hullHeading: player?.hullHeading,
    mount: game.boats?.mountFor() ?? null,
    boat,
  };
}

function observeFrames() {
  if (ready && !game.building) {
    const current = pose();
    frames.push(current);
    if (frames.length > 80) frames.shift();
    if (current.active && firstActivePose === null) firstActivePose = current;
  }
  requestAnimationFrame(observeFrames);
}

function read(cells = []) {
  if (!Array.isArray(cells) || cells.length > 32)
    throw new RangeError("At most 32 explicit voxel observations per read");
  const base = { ready: ready && !game.building, error, documentId, inputs: structuredClone(inputs) };
  if (!base.ready) return base;
  const player = game.player, world = game.world;
  for (const cell of cells) {
    if (![cell.x, cell.y, cell.z].every(Number.isSafeInteger) ||
      Math.abs(cell.x - player.position.x) > 192 ||
      Math.abs(cell.z - player.position.z) > 192)
      throw new RangeError("Voxel observations must be finite and within 192 blocks");
  }
  const saved = game.gameplay.serialize();
  const owned = game.gameplay.getState();
  const boats = game.boats.serialize();
  const pickups = game.pickups.serialize().items;
  const overflow = game.overflow.serialize().entries;
  if (boats.boats.length > 4 || pickups.length > 64 || overflow.length > 64 || world.edits.size > 32)
    throw new Error("Observation bounds exceeded; this is no longer the finite boat acceptance route");
  return {
    ...base, ...pose(),
    initialPose: structuredClone(initialPose),
    firstActivePose: structuredClone(firstActivePose),
    frames: structuredClone(frames),
    failed: game.failed,
    hidden: document.hidden,
    enabled: player.enabled,
    locked: player.locked,
    inputMode: player.inputMode,
    grounded: player.grounded,
    flying: player.flying,
    allowFlight: player.allowFlight,
    colliding: collidesWithWorld(world, player.position),
    perspective: player.perspective,
    forward: vector(player.forward),
    fluid: structuredClone(player.fluidState),
    seed: world.seed,
    generatorVersion: world.generatorVersion,
    dimension: world.dimension,
    quality: game.quality,
    mode: game.gameplay.mode,
    health: game.gameplay.health,
    hunger: game.gameplay.hunger,
    air: game.gameplay.air,
    dead: game.gameplay.dead,
    elapsed: game.elapsed,
    clock: { ...game.worldClock.serialize(), daySeconds: DAY_SECONDS },
    inventory: saved.inventory,
    slots: saved.slots,
    cursor: saved.cursor,
    offhand: saved.offhand,
    equipment: saved.equipment,
    craftingGrid: saved.craftingGrid,
    craftingSize: saved.craftingSize,
    craftingResult: owned.craftingResult,
    selected: saved.selected,
    equipped: saved.hotbar[saved.selected],
    overlayOpen: game.overlayOpen,
    inventoryScreen: document.querySelector(".inventory-panel")?.dataset.screen ?? null,
    inventoryBusy: document.querySelector(".inventory-overlay")?.getAttribute("aria-busy") === "true",
    recipeBookOpen: document.querySelector(".recipe-book-toggle")?.getAttribute("aria-expanded") === "true",
    target: game.target ? structuredClone(game.target) : null,
    mobTarget: game.mobTarget?.name ?? null,
    vehicleTarget: game.vehicleTarget ? structuredClone(game.vehicleTarget) : null,
    miningProgress: game.miningProgress,
    targetMiningSeconds: game.target ? game.gameplay.miningDuration(game.target.id) : null,
    cells: Object.fromEntries(cells.map((cell) => [
      cellKey(cell),
      world.isLoaded(cell.x, cell.z) ? world.get(cell.x, cell.y, cell.z) : null,
    ])),
    edits: world.serialize().edits,
    loadedChunks: world.chunks.size,
    boats: boats.boats,
    renderedBoatParts: game.boats.renderer?.mesh.count ?? 0,
    pickups,
    overflow,
    storageStatus: game.storageStatus,
    storageRevision: game.storage.revision,
    toast: document.querySelector(".toast > span")?.textContent ?? "",
  };
}

async function archive(cells = []) {
  if (!Array.isArray(cells) || cells.length > 32 ||
    cells.some((cell) => ![cell.x, cell.y, cell.z].every(Number.isSafeInteger)))
    throw new RangeError("At most 32 explicit saved-cell observations");
  const database = game.storage.database;
  if (!database) return null;
  // Read the already-open browser database; never call storage.load(), which
  // would adopt a revision into the live owner, and never open a write txn.
  const transaction = database.transaction(["worlds", "chunks"], "readonly");
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
  const result = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const chunkKey = (cell) =>
    `active|${game.world.dimension}|${Math.floor(cell.x / 16)},${Math.floor(cell.z / 16)}`;
  const keys = [...new Set(cells.map(chunkKey))];
  const [record, chunks] = await Promise.all([
    result(transaction.objectStore("worlds").get("active")),
    Promise.all(keys.map((key) => result(transaction.objectStore("chunks").get(key)))),
    done,
  ]);
  const saved = record?.snapshot;
  if (!saved) return null;
  const boats = saved.boats?.boats ?? [];
  const pickups = saved.pickups?.items ?? [];
  const overflow = saved.overflow?.entries ?? [];
  if (boats.length > 4 || pickups.length > 64 || overflow.length > 64 ||
    chunks.some((chunk) => (chunk?.edits?.length ?? 0) > 32))
    throw new Error("Saved observation exceeds finite acceptance bounds");
  return {
    revision: record.revision,
    updatedAt: record.updatedAt,
    world: saved.world,
    player: saved.player,
    gameplay: saved.gameplay,
    boats, pickups, overflow,
    cells: Object.fromEntries(cells.map((cell) => {
      const edits = chunks[keys.indexOf(chunkKey(cell))]?.edits ?? [];
      const edit = edits.find(([x, y, z]) => x === cell.x && y === cell.y && z === cell.z);
      return [cellKey(cell), edit ? edit[3] : null];
    })),
  };
}

// No Game, World, owner or mutable reference is exported. Every public method
// is a bounded query, returning detached data; all actions must enter the DOM.
Object.defineProperty(window, "__boatSurvival", {
  value: Object.freeze({
    read, archive,
    tree: () => planTreeRoute(game.world, game.player.position),
    shore: () => planShoreRoute(game.world, game.player.position),
    route: (destination) => planWalkingRoute(game.world, game.player.position, destination),
  }),
  writable: false,
  configurable: false,
});

game.start().then(() => {
  initialPose = pose();
  ready = true;
  requestAnimationFrame(observeFrames);
}).catch((failure) => {
  error = failure.message;
  game.showError(failure);
});
