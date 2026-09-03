import { BLOCK, BLOCKS } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";
import { MOB_SPECIES } from "../src/mob-species.js";

export const hurtEncounterConfig = {
  air: BLOCK.AIR,
  kind: "husk", // A real daylight-safe hostile; no time-of-day or AI overrides.
  damage: MOB_SPECIES.husk.damage,
  sword: {
    id: ITEM.IRON_SWORD,
    count: 1,
    durability: getItem(ITEM.IRON_SWORD).durability,
  },
  shield: {
    id: ITEM.SHIELD,
    count: 1,
    durability: getItem(ITEM.SHIELD).durability,
  },
  food: { id: ITEM.APPLE, count: 4 },
  naturalFloorIds: [
    BLOCK.GRASS,
    BLOCK.DIRT,
    BLOCK.STONE,
    BLOCK.SAND,
    BLOCK.SNOW,
    BLOCK.GRAVEL,
    BLOCK.CLAY,
    BLOCK.PODZOL,
    BLOCK.MYCELIUM,
    BLOCK.RED_SAND,
    BLOCK.MUD,
  ].filter(Number.isInteger),
  harmlessPlants: [
    BLOCK.TALL_GRASS,
    BLOCK.FERN,
    BLOCK.RED_FLOWER,
    BLOCK.YELLOW_FLOWER,
    BLOCK.DEAD_BUSH,
    BLOCK.SUNFLOWER,
    BLOCK.PINK_PETALS,
  ].filter((id) => BLOCKS[id]?.shape === "cross" && !BLOCKS[id].solid),
  limits: {
    radius: 40,
    candidates: 6500,
    columns: 9000,
    searchMs: 3000,
    setups: 6,
    frames: 2048,
    inputs: 256,
    observationMs: 30000,
  },
};

/**
 * page.evaluate(installHurtEncounterFixture, hurtEncounterConfig)
 *
 * CONTROLLED SETUP, not natural acquisition or an AI/performance benchmark:
 * prepare({ kind: "mob" | "fall" }) works only while paused, outside observation.
 * It uses real inventory/respawn/position/spawn APIs, never writes terrain, and
 * never replaces a source method, clock, damage callback or input handler.
 * A mob encounter ends spawn grace via its domain API and starts four blocks
 * along the existing physical heading. Fall setup is an explicitly authored
 * seven-block airborne release above a checked, naturally clear landing column.
 *
 * read(), begin(label), observations(), end() only observe the game. Frames use
 * a separate bounded rAF, not a wrapper around Game.frame or HurtFeedback.render.
 * GPU uniforms expose the projection actually uploaded during the previous draw;
 * canvas readback of blue trousers distinguishes real avatar tint from the DOM
 * edge flash. Only rAF samples read pixels, before the drawing buffer is cleared.
 * dispose() removes these observers, not the game, renderer or encounter.
 */
export function installHurtEncounterFixture(config) {
  const game = window.__voxelBot?.game;
  if (!game || window.__voxelHurtRegression)
    throw new Error("Expected a fresh realtime host without a hurt fixture");
  if (!game.hurtFeedback || !document.querySelector(".hurt-indicator"))
    throw new Error(
      "The frozen host must include the complete hurt integration"
    );
  const world = game.world;
  const origin = {
    x: Math.floor(game.player.position.x),
    z: Math.floor(game.player.position.z),
  };
  const floorIds = new Set(config.naturalFloorIds);
  const plants = new Set(config.harmlessPlants);
  const locations = new WeakMap();
  const abort = new AbortController();
  let footprint = null;
  let fixture = null;
  let setups = 0;
  let observation = null;
  let animation = null;
  let previous = null;
  let indicatorNode = null;
  const point = ({ x, y, z }) => ({ x, y, z });

  function requirePaused() {
    if (
      window.__voxelBot.game !== game ||
      game.world !== world ||
      world.dimension !== "overworld" ||
      !game.paused ||
      game.active ||
      game.player.enabled ||
      game.overlayOpen ||
      game.building ||
      game.closingScreens ||
      observation
    )
      throw new Error(
        "End observation and pause the unchanged world before setup"
      );
  }

  requirePaused();

  const unedited = (x, y, z) =>
    !world.edits.has(`${world.dimension}:${x},${y},${z}`);

  function clearCell(x, y, z, allowPlant = false) {
    const cell = world.getCell(x, y, z);
    return (
      cell &&
      unedited(x, y, z) &&
      !cell.fluid &&
      (cell.id === config.air || (allowPlant && plants.has(cell.id)))
    );
  }

  function findFootprint() {
    const started = performance.now();
    const columns = new Map();
    let candidates = 0;
    function budget() {
      if (
        candidates > config.limits.candidates ||
        columns.size > config.limits.columns ||
        performance.now() - started > config.limits.searchMs
      )
        throw new Error(
          "Natural hurt-footing search exhausted its bounded budget"
        );
    }
    function column(x, z) {
      const key = `${x},${z}`;
      if (columns.has(key)) return columns.get(key);
      budget();
      if (columns.size >= config.limits.columns)
        throw new Error("Natural hurt-footing column limit exceeded");
      let result = null;
      if (world.isLoaded(x, z)) {
        const y = world.surfaceYAt(x, z);
        if (
          Number.isInteger(y) &&
          y >= 0 &&
          y + 10 < world.maxY &&
          floorIds.has(world.get(x, y, z)) &&
          unedited(x, y, z) &&
          [1, 2, 3, 4].every((dy) => clearCell(x, y + dy, z, dy === 1))
        )
          result = { x, y, z, id: world.get(x, y, z) };
      }
      columns.set(key, result);
      return result;
    }
    for (let radius = 0; radius <= config.limits.radius; radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          candidates++;
          budget();
          const center = column(origin.x + dx, origin.z + dz);
          if (!center) continue;
          const support = [];
          let clear = true;
          for (let oz = -3; oz <= 3 && clear; oz++) {
            for (let ox = -3; ox <= 3; ox++) {
              const found = column(center.x + ox, center.z + oz);
              if (!found || found.y !== center.y) {
                clear = false;
                break;
              }
              support.push(found);
            }
          }
          if (clear)
            return {
              center: { x: center.x + 0.5, y: center.y + 1, z: center.z + 0.5 },
              support,
              candidates,
              columns: columns.size,
            };
        }
      }
    }
    throw new Error(
      "No loaded natural 7x7 footing with dry, clear body/head space"
    );
  }

  function supportIntact() {
    return (
      game.world === world &&
      footprint?.support.every(
        ({ x, y, z, id }) =>
          world.isLoaded(x, z) &&
          world.get(x, y, z) === id &&
          unedited(x, y, z) &&
          [1, 2, 3, 4].every((dy) => clearCell(x, y + dy, z, dy === 1))
      )
    );
  }

  async function prepare({ kind = "mob" } = {}) {
    requirePaused();
    if (!["mob", "fall"].includes(kind))
      throw new Error("Unknown hurt scenario");
    if (++setups > config.limits.setups)
      throw new Error("Hurt setup limit exceeded");
    // Normal calendar/support work elsewhere is allowed to keep running. Only
    // this naturally generated footing/headroom must be free of world edits.
    footprint ??= findFootprint();
    if (!supportIntact())
      throw new Error("The natural encounter footing changed");
    let center = footprint.center;
    if (kind === "fall") {
      // At most 49 already-checked columns, ten cells each; no terrain clearing
      // or unbounded search for an ideal cliff is permitted.
      const landing = footprint.support.find(({ x, y, z }) => {
        for (let dy = 1; dy <= 10; dy++)
          if (!clearCell(x, y + dy, z, dy === 1)) return false;
        return true;
      });
      if (!landing)
        throw new Error(
          "The natural footing lacks a clear seven-block fall column"
        );
      center = { x: landing.x + 0.5, y: landing.y + 1, z: landing.z + 0.5 };
    }
    // Seed before switching modes: never pass through the unrelated Creative
    // empty-selected-slot case. A nonempty sword remains selected in every phase.
    if (
      !game.gameplay.inventoryTransaction((draft) => {
        draft.slots = Array(36).fill(null);
        draft.slots[0] = { ...config.sword };
        draft.slots[1] = { ...config.food };
        draft.cursor = null;
        draft.offhand = { ...config.shield };
        draft.equipment = { head: null, chest: null, legs: null, feet: null };
        draft.craftingGrid = Array(9).fill(null);
        draft.craftingSize = 2;
        return true;
      })
    )
      throw new Error(
        "The real inventory transaction refused finite test supplies"
      );
    game.select(0);
    if (!(await game.setMode("survival")) || !game.gameplay.respawn())
      throw new Error("The domain refused healthy Survival encounter setup");
    requirePaused();
    if (game.wildlife.projectiles.length)
      throw new Error(
        "Unexpected live projectiles would contaminate this encounter"
      );
    for (const mob of [...game.wildlife.entities]) game.wildlife.remove(mob);
    const heading = {
      x: -Math.sin(game.player.yaw),
      z: -Math.cos(game.player.yaw),
    };
    game.player.setPosition(
      kind === "fall"
        ? { ...center, y: center.y + 7 }
        : {
            x: center.x - heading.x * 2,
            y: center.y,
            z: center.z - heading.z * 2,
          }
    );
    const mob =
      kind === "mob"
        ? game.wildlife.spawn(config.kind, {
            x: center.x + heading.x * 2,
            y: center.y,
            z: center.z + heading.z * 2,
          })
        : null;
    if (kind === "mob" && !mob)
      throw new Error(
        "Wildlife.spawn refused the genuine hostile on natural footing"
      );
    game.wildlife.endSpawnProtection();
    game.refreshHud();
    fixture = {
      label: `controlled-hurt-${kind}-${setups}`,
      provenance:
        "Paused domain setup: finite sword/shield/four apples, health reset, existing physical heading, natural unmodified footing. No acquisition, AI-balance or performance claim.",
      encounter:
        kind === "mob"
          ? "One genuine Husk, four blocks away; normal AI and spawning, spawn grace ended through its domain API."
          : "Controlled seven-block airborne release; no mob, artificial platform, fall callback or health write during play.",
      kind,
      id: mob?.id ?? null,
      player: point(game.player.position),
      landing: point(center),
      mob: mob && point(mob.position),
      autoSpawn: game.wildlife.autoSpawn,
      entityCount: game.wildlife.entities.length,
      terrainEdits: world.edits.size,
      supportColumns: footprint.support.length,
      searchCandidates: footprint.candidates,
      searchColumns: footprint.columns,
    };
    return fixture;
  }

  function gpuState() {
    const { renderer, camera } = game.graphics;
    const gl = renderer.getContext();
    const lost = gl.isContextLost();
    const program = lost ? null : gl.getParameter(gl.CURRENT_PROGRAM);
    let matrix = null;
    if (program) {
      if (!locations.has(program))
        locations.set(
          program,
          gl.getUniformLocation(program, "projectionMatrix")
        );
      const location = locations.get(program);
      if (location !== null) matrix = gl.getUniform(program, location);
    }
    const cpu = camera.projectionMatrix.elements;
    const valid = matrix?.length === 16 && [...matrix].every(Number.isFinite);
    const roll = valid
      ? Math.atan2(matrix[1] / cpu[5], matrix[0] / cpu[0])
      : null;
    let projectionError = null;
    if (valid) {
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      projectionError = 0;
      for (let i = 0; i < 16; i++) {
        const expected =
          i < 4
            ? cpu[i] * c + cpu[i + 4] * s
            : i < 8
              ? -cpu[i - 4] * s + cpu[i] * c
              : cpu[i];
        projectionError = Math.max(
          projectionError,
          Math.abs(matrix[i] - expected) / (1 + Math.abs(expected))
        );
      }
    }
    return {
      matrix,
      state: {
        frame: renderer.info.render.frame,
        draws: renderer.info.render.calls,
        contextLost: lost,
        valid: Boolean(valid),
        roll,
        projectionError,
        cpuOffAxis: Math.max(Math.abs(cpu[1]), Math.abs(cpu[4])),
        badPrograms: renderer.info.programs.filter(
          (entry) => entry.diagnostics?.runnable === false
        ).length,
      },
    };
  }

  function avatarState(matrix, pixels) {
    const visual = game.playerVisual;
    const mesh = visual?.mesh;
    if (!mesh)
      return { visible: false, parts: 0, tint: 0, pixel: null, batch: null };
    const parts = visual.rig.parts.filter((part) => part.visible);
    const index = parts.findIndex((part) => part.node.name === "right-thigh");
    let pixel = null;
    if (pixels && matrix && index >= 0 && game.player.perspective === "back") {
      const part = parts[index].node.matrixWorld.elements;
      const p = [
        part[12] + mesh.position.x,
        part[13] + mesh.position.y,
        part[14] + mesh.position.z,
        1,
      ];
      const multiply = (m, v) =>
        [0, 1, 2, 3].map(
          (row) =>
            m[row] * v[0] +
            m[row + 4] * v[1] +
            m[row + 8] * v[2] +
            m[row + 12] * v[3]
        );
      const clip = multiply(
        matrix,
        multiply(game.graphics.camera.matrixWorldInverse.elements, p)
      );
      const gl = game.graphics.renderer.getContext();
      const x = Math.floor(
        ((clip[0] / clip[3]) * 0.5 + 0.5) * gl.drawingBufferWidth
      );
      const y = Math.floor(
        ((clip[1] / clip[3]) * 0.5 + 0.5) * gl.drawingBufferHeight
      );
      if (
        clip[3] > 0 &&
        Math.abs(clip[2] / clip[3]) <= 1 &&
        x >= 1 &&
        y >= 1 &&
        x + 1 < gl.drawingBufferWidth &&
        y + 1 < gl.drawingBufferHeight &&
        gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === null
      ) {
        const data = new Uint8Array(36);
        gl.readPixels(x - 1, y - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, data);
        const rgb = [0, 1, 2].map((channel) => {
          let sum = 0;
          for (let i = channel; i < data.length; i += 4) sum += data[i];
          return sum / 9;
        });
        pixel = { part: "right-thigh", x, y, rgb };
      }
    }
    return {
      visible: mesh.visible && mesh.parent === game.graphics.scene,
      parts: mesh.count,
      tint: visual.resources.flashes.getX(Math.max(0, index)),
      pixel,
      batch: `${mesh.uuid}/${mesh.geometry.uuid}/${mesh.material.uuid}`,
    };
  }

  function read({ pixels = false } = {}) {
    const { player, gameplay, graphics } = game;
    const mob = game.wildlife.byId.get(fixture?.id);
    const indicator = document.querySelector(".hurt-indicator");
    const style = indicator && getComputedStyle(indicator);
    const rect = indicator?.getBoundingClientRect();
    const opacity = style ? Number(style.opacity) : 0;
    const { matrix, state: gpu } = gpuState();
    return {
      frame: window.__voxelBot.state().frame,
      simulationTime: game.wildlife.clock,
      active: game.active,
      simulating: game.simulating,
      paused: game.paused,
      health: gameplay.health,
      dead: gameplay.dead,
      mode: gameplay.mode,
      yaw: player.yaw,
      pitch: player.pitch,
      position: point(player.position),
      eye: point(player.eyePosition),
      forward: point(player.forward),
      cameraPosition: point(graphics.camera.position),
      quaternion: graphics.camera.quaternion.toArray(),
      grounded: player.grounded,
      velocityY: player.velocity.y,
      flying: player.flying,
      perspective: player.perspective,
      main: gameplay.getHandStack("main"),
      offhand: gameplay.getHandStack("offhand"),
      blocking: game.useActions.use.blocking,
      useActive: game.useActions.use.active,
      remaining: game.hurtFeedback.remaining,
      reducedMotion: game.hurtFeedback.motionPreference?.matches === true,
      supportIntact: supportIntact() ?? null,
      terrainEdits: game.world.edits.size,
      otherNearbyHostiles: game.wildlife.entities.filter(
        (entity) =>
          entity !== mob &&
          ["hostile", "watchful"].includes(entity.spec.temperament) &&
          entity.position.distanceTo(player.position) < 8
      ).length,
      mob: mob
        ? {
            id: mob.id,
            health: mob.health,
            attacking: mob.attacking,
            cooldown: mob.attackCooldown,
            distance: mob.position.distanceTo(player.position),
            reach: mob.spec.reach,
          }
        : null,
      flash: {
        visible: Boolean(
          indicator &&
            !indicator.hidden &&
            opacity > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
        ),
        opacity,
        background: style?.backgroundImage ?? null,
        pointerEvents: style?.pointerEvents ?? null,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        viewport: [innerWidth, innerHeight],
      },
      gpu,
      avatar: avatarState(matrix, pixels),
    };
  }

  function observeFrame() {
    if (!observation) return;
    if (
      performance.now() - observation.started > config.limits.observationMs ||
      observation.frames.length >= config.limits.frames
    ) {
      observation.error =
        "Read-only hurt observation reached its time/frame limit";
      return;
    }
    try {
      const state = read({ pixels: true });
      if (state.gpu.frame !== previous.gpu.frame) {
        const { summary } = observation;
        if (state.health < previous.health) {
          summary.healthLosses++;
          if (!state.dead && state.flash.visible) summary.visibleLosses++;
        }
        if (state.offhand?.durability < previous.offhand?.durability)
          summary.shieldWear++;
        if (state.flash.visible) summary.flashFrames++;
        if (state.flash.visible && Math.abs(state.gpu.roll) > 0.001)
          summary.rolledFlashFrames++;
        if (
          state.avatar.visible &&
          state.avatar.tint > 0.05 &&
          state.avatar.pixel
        )
          summary.tintedFrames++;
        if (
          state.remaining > previous.remaining + 1e-8 &&
          state.health >= previous.health
        )
          summary.unexplainedPulses++;
        observation.frames.push(state);
        previous = state;
      }
      animation = requestAnimationFrame(observeFrame);
    } catch (error) {
      observation.error = error.stack ?? String(error);
    }
  }

  function begin(label) {
    if (
      observation ||
      typeof label !== "string" ||
      !label ||
      label.length > 160
    )
      throw new Error(
        "Begin one clearly labeled, bounded observation at a time"
      );
    indicatorNode = document.querySelector(".hurt-indicator");
    previous = read();
    observation = {
      label,
      started: performance.now(),
      initial: previous,
      frames: [],
      inputs: [],
      error: null,
      summary: {
        healthLosses: 0,
        visibleLosses: 0,
        shieldWear: 0,
        flashFrames: 0,
        rolledFlashFrames: 0,
        tintedFrames: 0,
        unexplainedPulses: 0,
      },
    };
    animation = requestAnimationFrame(observeFrame);
  }

  function observations() {
    if (!observation) return null;
    return {
      ...observation,
      current: read(),
      stableIndicator:
        indicatorNode?.isConnected &&
        document.querySelector(".hurt-indicator") === indicatorNode &&
        document.querySelectorAll(".hurt-indicator").length === 1,
    };
  }

  function end() {
    cancelAnimationFrame(animation);
    animation = null;
    try {
      return observations();
    } finally {
      observation = null;
      previous = null;
    }
  }

  for (const type of ["keydown", "keyup", "mousedown", "mouseup"])
    window.addEventListener(
      type,
      (event) => {
        if (!observation) return;
        if (observation.inputs.length >= config.limits.inputs) {
          observation.error = "Hurt input observation limit exceeded";
          return;
        }
        observation.inputs.push({
          type,
          code: event.code ?? null,
          button: event.button ?? null,
          trusted: event.isTrusted,
          frame: window.__voxelBot.state().frame,
        });
      },
      { capture: true, passive: true, signal: abort.signal }
    );
  window.__voxelHurtRegression = {
    prepare,
    read,
    begin,
    observations,
    end,
    get fixture() {
      return fixture;
    },
    dispose() {
      try {
        end();
      } finally {
        abort.abort();
        delete window.__voxelHurtRegression;
      }
    },
  };
}

/** Install before a real reload; observe health publication from the first rAF.
 * Aggregates every sample, retains only eight anomaly records, and stops after
 * eight ready frames (or 75s/5000 frames). No game methods or globals are replaced.
 */
export function installHurtReloadObserver() {
  const proof = {
    samples: 0,
    readyFrames: 0,
    sawReducedHealth: false,
    maxRemaining: 0,
    maxOpacity: 0,
    anomalies: [],
    done: false,
    error: null,
  };
  window.__voxelHurtReloadProof = proof;
  const started = performance.now();
  function observe() {
    if (++proof.samples > 5000 || performance.now() - started > 75000) {
      proof.error = "Reload observation exhausted its startup budget";
      proof.done = true;
      return;
    }
    const game = window.__voxelBot?.game;
    if (game?.gameplay && game.hurtFeedback) {
      const health = game.gameplay.health;
      const remaining = game.hurtFeedback.remaining;
      const node = document.querySelector(".hurt-indicator");
      const opacity = node ? Number(getComputedStyle(node).opacity) : 0;
      proof.sawReducedHealth ||= health > 0 && health < 20;
      proof.maxRemaining = Math.max(proof.maxRemaining, remaining);
      proof.maxOpacity = Math.max(proof.maxOpacity, opacity);
      if ((remaining > 0 || opacity > 0) && proof.anomalies.length < 8)
        proof.anomalies.push({
          health,
          remaining,
          opacity,
          paused: game.paused,
        });
    }
    if (window.__voxelBot?.ready && ++proof.readyFrames >= 8) {
      proof.done = true;
      return;
    }
    requestAnimationFrame(observe);
  }
  requestAnimationFrame(observe);
}
