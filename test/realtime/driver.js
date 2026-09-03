import { BLOCK } from "../../src/blocks.js";
import { VoxelGame } from "../../src/game.js";
import { collidesWithWorld } from "../../src/player.js";
import { CHUNK_SIZE, WATER_LEVEL, WORLD_HEIGHT } from "../../src/terrain.js";
import { BotMetrics } from "./metrics.js";
import { softwareRenderer } from "./statistics.js";
import { installStreamingProbe } from "./streaming-probe.js";

const query = new URLSearchParams(location.search);
const quality = query.get("quality") ?? "medium";
const seed = query.get("seed") ?? "cedar-valley";
const pixelRatioOverride = query.has("pixelRatio")
  ? Number(query.get("pixelRatio"))
  : null;
if (!["low", "medium", "high"].includes(quality) || !seed || seed.length > 80)
  throw new Error("Invalid realtime fixture quality or seed");
if (
  pixelRatioOverride !== null &&
  (!Number.isFinite(pixelRatioOverride) ||
    pixelRatioOverride < 0.4 ||
    pixelRatioOverride > 2)
)
  throw new Error("Invalid resolution experiment");

const game = new VoxelGame(document.querySelector("#game"));
let ready = false;
let error = null;
let syntheticFixture = null;
const position = ({ x, y, z }) => ({ x, y, z });

/** Read actual loaded voxels along three screen-facing rays, including water. */
function probeView() {
  const { camera } = game.graphics;
  const fogFar = game.graphics.scene.fog.far;
  let terrainRaysHit = 0;
  for (const [yawOffset, pitchOffset] of [
    [0, 0],
    [-0.25, -0.3],
    [0.25, -0.3],
  ]) {
    const yaw = game.player.yaw + yawOffset;
    const pitch = game.player.pitch + pitchOffset;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    for (let step = 0.5; step <= Math.min(100, fogFar); step += 0.75) {
      const x = Math.floor(camera.position.x + dx * step);
      const y = Math.floor(camera.position.y + dy * step);
      const z = Math.floor(camera.position.z + dz * step);
      const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
      if (
        game.world.get(x, y, z) !== BLOCK.AIR &&
        game.graphics.chunks.get(key)?.visible
      ) {
        terrainRaysHit++;
        break;
      }
    }
  }
  return {
    terrainRaysHit,
    sampledRays: 3,
    fogFar,
    pitch: game.player.pitch,
    visibleChunkGroups: [...game.graphics.chunks.values()].filter(
      (group) => group.visible
    ).length,
  };
}

const metrics = new BotMetrics(game, { probeView });

function plannedHeights() {
  const player = game.player;
  const strafe =
    Number(player._keys.has("KeyD")) - Number(player._keys.has("KeyA"));
  const length = Math.hypot(1, strafe);
  const dx = (Math.cos(player.yaw) * strafe - Math.sin(player.yaw)) / length;
  const dz = (-Math.sin(player.yaw) * strafe - Math.cos(player.yaw)) / length;
  const samples = [0, 6, 12, 18].map((ahead) => {
    const x = Math.floor(player.position.x + dx * ahead);
    const z = Math.floor(player.position.z + dz * ahead);
    const loaded = game.world.isLoaded(x, z);
    let topSolid = null;
    if (loaded) {
      for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
        if (!game.world.isSolid(x, y, z)) continue;
        topSolid = y;
        break;
      }
    }
    return {
      ahead,
      x,
      z,
      terrainHeight: game.world.generator.terrainHeight(x, z),
      loaded,
      topSolid,
    };
  });
  return { samples, worldHeight: WORLD_HEIGHT, waterLevel: WATER_LEVEL };
}

function rendererInfo() {
  const renderer = game.graphics.renderer;
  const gl = renderer.getContext();
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = extension
    ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
    : null;
  return {
    renderer: rendererName,
    vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
    maskedRenderer: gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
    shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    softwareRenderer: softwareRenderer(rendererName),
    drawingBuffer: {
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
    },
    contextLost: gl.isContextLost(),
    pixelRatio: renderer.getPixelRatio(),
  };
}

function inspectFixture() {
  if (!syntheticFixture) return null;
  const { target } = syntheticFixture;
  return {
    ...syntheticFixture,
    targetId: game.world.get(target.x, target.y, target.z),
    miningSeconds: game.gameplay.miningDuration(target.id),
  };
}

function state({ planning = false, renderer = false } = {}) {
  if (!ready) return { ready, error };
  const { player, world, graphics } = game;
  return {
    ready,
    error,
    build: {
      production: import.meta.env.PROD,
      label: import.meta.env.VITE_BENCHMARK_LABEL ?? null,
    },
    now: performance.now(),
    frame: metrics.sessionFrames,
    active: game.active,
    paused: game.paused,
    overlayOpen: game.overlayOpen,
    overlay: document.querySelector("#ui").dataset.overlay,
    building: game.building,
    failed: game.failed,
    hidden: document.hidden,
    mode: game.gameplay.mode,
    quality: game.quality,
    seed: world.seed,
    dimension: world.dimension,
    position: position(player.position),
    velocity: position(player.velocity),
    yaw: player.yaw,
    pitch: player.pitch,
    camera: {
      yaw: graphics.camera.rotation.y,
      pitch: graphics.camera.rotation.x,
    },
    grounded: player.grounded,
    flying: player.flying,
    allowFlight: player.allowFlight,
    enabled: player.enabled,
    locked: player.locked,
    keys: [...player._keys],
    moving: player.moving,
    sprinting: player.sprinting,
    colliding: collidesWithWorld(world, player.position, player.height),
    health: game.gameplay.health,
    hunger: game.gameplay.hunger,
    dead: game.gameplay.dead,
    timeOfDay: game.currentTime,
    wildlifeClock: game.wildlife.clock,
    miningProgress: game.miningProgress,
    target: game.target ? { ...game.target } : null,
    syntheticFixture: inspectFixture(),
    world: {
      loaded: world.isLoaded(player.position.x, player.position.z),
      chunks: world.chunks.size,
      requests: world._requests.size,
      inFlight: world._inFlight.size,
      renderRadius: graphics.renderRadius,
      renderedChunks: graphics.chunks.size,
      dirtyChunks: world.dirtyChunks.size,
      workerDisabled: world._workerDisabled,
    },
    inputs: metrics.sessionInputs,
    live: metrics.live(),
    ...(planning ? { planning: plannedHeights() } : {}),
    ...(renderer ? { renderer: rendererInfo(), view: probeView() } : {}),
  };
}

/**
 * Synthetic CONTROL fixture, never used for terrain/performance claims.
 * The only pose writes in the harness are explicitly unmeasured setup here.
 * During every measured segment, movement goes through trusted browser inputs.
 */
function prepareGroundFixture() {
  if (metrics.recording || !game.paused)
    throw new Error(
      "Pause and stop measurement before preparing a control fixture"
    );
  const x = Math.floor(game.player.position.x);
  const z = Math.floor(game.player.position.z);
  const floorY = Math.max(
    4,
    Math.min(WORLD_HEIGHT - 8, game.world.generator.terrainHeight(x, z) + 2)
  );
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -5; dz <= 4; dz++) {
      if (!game.world.isLoaded(x + dx, z + dz))
        throw new Error("Ground fixture requires loaded neighboring chunks");
      game.world.set(x + dx, floorY, z + dz, BLOCK.STONE);
      for (let y = floorY + 1; y < WORLD_HEIGHT; y++)
        game.world.set(x + dx, y, z + dz, BLOCK.AIR);
    }
  }
  const wallZ = z - 3;
  for (let dx = -3; dx <= 3; dx++)
    for (let dy = 1; dy <= 3; dy++)
      game.world.set(x + dx, floorY + dy, wallZ, BLOCK.DIRT);
  const spawn = { x: x + 0.5, y: floorY + 1.01, z: z + 1.5 };
  game.player.setPosition(spawn);
  game.player.yaw = 0;
  game.player.pitch = 0;
  game.player.update(0.001);
  game.wildlife.protectSpawn(game.player.position);
  game.graphics.rebuildDirty(Infinity);
  game.graphics.update(0, game.elapsed, game.player.position);
  game.graphics.render();
  syntheticFixture = {
    label: "synthetic-flat-controls-only",
    description:
      "A 7×10 stone floor and dirt wall in the real world, not demo or terrain benchmark evidence.",
    floorY,
    spawn,
    wallZ,
    collisionLimitZ: wallZ + 1 + 0.3,
    target: { x, y: floorY + 2, z: wallZ, id: BLOCK.DIRT },
  };
  return inspectFixture();
}

// This global exists only in test/realtime/index.html, never in the real entrypoint.
window.__voxelBot = {
  // Test-host-only access for read-only planning and explicitly unmeasured setup.
  get game() {
    return game;
  },
  get ready() {
    return ready;
  },
  get error() {
    return error;
  },
  state,
  metrics: {
    reset: (label) => metrics.reset(label),
    results: (options) => metrics.results(options),
  },
  fixture: { prepareGround: prepareGroundFixture, inspect: inspectFixture },
};
metrics.wrap(window.__voxelBot, "state", "bot.state");

game.quality = quality;
game.soundEnabled = false;
game.setMode("creative");
game
  .start()
  .then(async () => {
    if (game.world.seed !== seed)
      await game.initialize(seed, null, { mode: "creative" });
    if (pixelRatioOverride !== null) {
      game.graphics.renderer.setPixelRatio(pixelRatioOverride);
      game.graphics.scaleController?.reset({
        minRatio: pixelRatioOverride,
        maxRatio: pixelRatioOverride,
        pixelRatio: pixelRatioOverride,
      });
    }
    metrics.attach();
    // Extra ray sampling is opt-in; the normal realtime bot is unchanged.
    if (query.get("streamingProbe") === "1")
      window.__voxelBot.streaming = installStreamingProbe(game);
    ready = true;
  })
  .catch((failure) => {
    error = failure.stack ?? String(failure);
    game.showError(failure);
  });
