import { BLOCK, BLOCKS } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";

export const endermanCombatConfig = {
  air: BLOCK.AIR,
  dirt: BLOCK.DIRT,
  stone: BLOCK.STONE,
  chest: BLOCK.CHEST,
  sword: ITEM.IRON_SWORD,
  bow: ITEM.BOW,
  arrow: ITEM.ARROW,
  harmlessPlants: [
    BLOCK.TALL_GRASS,
    BLOCK.FERN,
    BLOCK.RED_FLOWER,
    BLOCK.YELLOW_FLOWER,
    BLOCK.DEAD_BUSH,
    BLOCK.SUNFLOWER,
    BLOCK.PINK_PETALS,
  ].filter((id) => BLOCKS[id]?.shape === "cross" && !BLOCKS[id].solid),
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
  supplies: [
    {
      id: ITEM.IRON_SWORD,
      count: 1,
      durability: getItem(ITEM.IRON_SWORD).durability,
    },
    { id: ITEM.BOW, count: 1, durability: getItem(ITEM.BOW).durability },
    { id: ITEM.ARROW, count: 4 },
    { id: BLOCK.DIRT, count: 17 },
    { id: ITEM.APPLE, count: 5 },
  ],
};

/**
 * Serialize with page.evaluate(installEndermanCombatFixture, endermanCombatConfig).
 * This is AUTHORED, UNMEASURED encounter setup, not natural resource acquisition.
 * Inventory/entity/world setup uses domain APIs while paused. The chest's initial
 * level look is authored under the same guard; no pose is written during play.
 * Ground/headroom are discovered, never manufactured; only the named rear block
 * and optional cover are authored.
 * Neither the real frame loop, AI, queries, input handlers nor clocks are replaced.
 *
 * The test-host-only window.__voxelCombatRegression exposes:
 *   await prepare({ rear: "dirt" | "chest", distance: 2.6 }) -- paused setup;
 *   addCover() -- paused, non-intersecting stone cover in the current aim;
 *   read(), begin(label), observations(), end() -- read-only game observation.
 * A parent may reuse this setup for an honestly labeled computer-use encounter.
 */
export function installEndermanCombatFixture(config) {
  const game = window.__voxelBot?.game;
  if (!game || window.__voxelCombatRegression)
    throw new Error("Expected one fresh realtime game and no combat fixture");
  const world = game.world;
  const origin = {
    x: Math.floor(game.player.position.x),
    z: Math.floor(game.player.position.z),
  };
  const naturalFloor = new Set(config.naturalFloorIds);
  const harmlessPlants = new Set(config.harmlessPlants);
  const authored = new Map();
  let footprint = null;
  let fixture = null;
  let setups = 0;
  let observation = null;
  let pendingPress = null;
  let pendingRightRelease = null;
  let pendingRelease = null;
  let animation = null;
  let hudObserver = null;
  let stableNodes = [];
  const abort = new AbortController();
  const point = ({ x, y, z }) => ({ x, y, z });
  const cellKey = ({ x, y, z }) => `${x},${y},${z}`;
  const maxSamples = 512;

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
      observation
    )
      throw new Error(
        "Stop observation and pause the unchanged real world before setup"
      );
  }

  function findFootprint() {
    const started = performance.now();
    const columns = new Map();
    let attempts = 0;
    const column = (x, z) => {
      const key = `${x},${z}`;
      if (columns.has(key)) return columns.get(key);
      let result = null;
      if (world.isLoaded(x, z)) {
        const floorY = world.surfaceYAt(x, z);
        if (
          Number.isInteger(floorY) &&
          floorY + 4 < world.maxY &&
          naturalFloor.has(world.get(x, floorY, z)) &&
          [1, 2, 3, 4].every((dy) => {
            const cell = world.getCell(x, floorY + dy, z);
            // One-cell, non-colliding flowers/grass can stay below the eye ray.
            // Do not clear vegetation or accept fluids, trees or a low ceiling.
            return (
              cell &&
              !cell.fluid &&
              (cell.id === config.air ||
                (dy === 1 && harmlessPlants.has(cell.id)))
            );
          })
        )
          result = { x, y: floorY, z, id: world.get(x, floorY, z) };
      }
      columns.set(key, result);
      return result;
    };
    for (let radius = 0; radius <= 40; radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          if (++attempts > 6500 || performance.now() - started > 3000)
            throw new Error(
              "Natural combat-footprint search exhausted its 6500-candidate/3s budget"
            );
          const x = origin.x + dx;
          const z = origin.z + dz;
          const center = column(x, z);
          if (!center) continue;
          const support = [];
          let clear = true;
          for (let oz = -3; oz <= 3 && clear; oz++) {
            for (let ox = -3; ox <= 3; ox++) {
              const found = column(x + ox, z + oz);
              if (!found || found.y !== center.y) {
                clear = false;
                break;
              }
              support.push(found);
            }
          }
          if (clear)
            return {
              center: { x: x + 0.5, y: center.y + 1, z: z + 0.5 },
              support,
              attempts,
            };
        }
      }
    }
    throw new Error(
      "No loaded, naturally supported 7x7 footprint with safe body space/headroom"
    );
  }

  function write(position, id) {
    const before = world.getCell(position.x, position.y, position.z);
    if (!before || before.id !== config.air || before.fluid)
      throw new Error(
        "Authored combat blocks must replace empty, dry cells only"
      );
    if (!world.set(position.x, position.y, position.z, id))
      throw new Error("The real World rejected an authored combat block");
    authored.set(cellKey(position), { ...point(position), original: before });
  }

  function restoreAuthoredCells() {
    if (!authored.size) return;
    const changes = [...authored.values()].map(({ original, ...position }) => ({
      ...position,
      before: world.getCell(position.x, position.y, position.z),
      after: original,
    }));
    if (!world.applyCells(changes))
      throw new Error(
        "Could not restore the previous fixture's authored cells"
      );
    authored.clear();
  }

  async function prepare({ rear = "dirt", distance = 2.6 } = {}) {
    requirePaused();
    if (!["dirt", "chest"].includes(rear) || ![2.6, 2.95].includes(distance))
      throw new Error("Unknown bounded combat scenario");
    if (++setups > 6) throw new Error("Combat fixture setup limit exceeded");
    restoreAuthoredCells();
    footprint ??= findFootprint();
    if (
      !footprint.support.every(({ x, y, z, id }) => world.get(x, y, z) === id)
    )
      throw new Error("The naturally generated support changed between phases");
    if (!(await game.setMode("survival")))
      throw new Error("Could not enter real Survival mode");
    requirePaused();
    // Independent encounters start with healthy, finite supplies through Gameplay.
    // This does not grant invulnerability during any measured phase.
    if (
      !game.gameplay.respawn() ||
      !game.gameplay.inventoryTransaction((draft) => {
        draft.slots = Array(36).fill(null);
        config.supplies.forEach((stack, index) => {
          draft.slots[index] = { ...stack };
        });
        draft.cursor = null;
        draft.offhand = null;
        draft.equipment = { head: null, chest: null, legs: null, feet: null };
        draft.craftingGrid = Array(9).fill(null);
        draft.craftingSize = 2;
        return true;
      })
    )
      throw new Error("Could not establish the real owned-inventory encounter");
    game.select(0);
    for (const entity of [...game.wildlife.entities])
      game.wildlife.remove(entity);
    const mob = game.wildlife.spawn("enderman", footprint.center);
    if (!mob)
      throw new Error("Wildlife.spawn rejected the natural Enderman footprint");
    // Use the spawn's actual heading; do not rotate, immobilize or pacify its AI.
    const facing = {
      x: Math.sin(mob.root.rotation.y),
      z: Math.cos(mob.root.rotation.y),
    };
    const initialLook =
      rear === "chest"
        ? { yaw: Math.atan2(facing.x, facing.z), pitch: 0 }
        : null;
    if (initialLook) {
      requirePaused();
      // Only authored chest setup: begin facing the existing spawn, before AI
      // resumes. setPosition below synchronizes the camera through the real API.
      game.player.yaw = initialLook.yaw;
      game.player.pitch = initialLook.pitch;
    }
    game.player.setPosition({
      x: mob.position.x + facing.x * distance,
      y: footprint.center.y,
      z: mob.position.z + facing.z * distance,
    });
    const rearPosition = {
      x: Math.floor(mob.position.x - facing.x * (4 - distance)),
      y: footprint.center.y + 1,
      z: Math.floor(mob.position.z - facing.z * (4 - distance)),
    };
    write(rearPosition, config[rear]);
    game.wildlife.endSpawnProtection();
    game.graphics.rebuildDirty(8);
    game.refreshHud();
    fixture = {
      label: `authored-survival-enderman-${rear}-${setups}`,
      provenance:
        "Injected finite inventory and one domain-spawned Enderman; natural unmodified support, authored rear block and paused initial level look for chest only. Not natural acquisition, AI balance, teleport or performance evidence.",
      id: mob.id,
      rear: { ...rearPosition, id: config[rear] },
      cover: [],
      supportColumns: footprint.support.length,
      searchCandidates: footprint.attempts,
      spawn: point(mob.position),
      player: point(game.player.position),
      initialLook,
      autoSpawn: game.wildlife.autoSpawn,
    };
    return fixture;
  }

  function addCover() {
    requirePaused();
    const mob = game.wildlife.byId.get(fixture?.id);
    if (!mob || fixture.cover.length)
      throw new Error("Expected an uncovered live encounter");
    const eye = game.player.eyePosition;
    const forward = game.player.forward;
    const distance = Math.hypot(mob.position.x - eye.x, mob.position.z - eye.z);
    const horizontal = Math.hypot(forward.x, forward.z);
    if (horizontal < 0.1)
      throw new Error("Aim toward the encounter before preparing cover");
    const position = {
      x: Math.floor(eye.x + (forward.x * distance) / (2 * horizontal)),
      z: Math.floor(eye.z + (forward.z * distance) / (2 * horizontal)),
    };
    const cover = [1, 2, 3].map((dy) => ({
      ...position,
      y: footprint.center.y + dy,
      id: config.stone,
    }));
    for (const block of cover) {
      const r = mob.spec.radius;
      const overlapsMob =
        block.x < mob.position.x + r &&
        block.x + 1 > mob.position.x - r &&
        block.z < mob.position.z + r &&
        block.z + 1 > mob.position.z - r &&
        block.y < mob.position.y + mob.spec.height &&
        block.y + 1 > mob.position.y;
      if (overlapsMob || game.player.intersectsBlock(block.x, block.y, block.z))
        throw new Error(
          "Cover setup would intersect a real body; encounter is not suitable"
        );
      const cell = world.getCell(block.x, block.y, block.z);
      if (cell?.id !== config.air || cell.fluid)
        throw new Error("Cover setup requires naturally clear space");
    }
    for (const block of cover) write(block, block.id);
    fixture.cover = cover;
    game.graphics.rebuildDirty(8);
    return fixture;
  }

  function read() {
    const mob = game.wildlife.byId.get(fixture?.id);
    const owned = game.gameplay.getState();
    const indicator = document.querySelector(".combat-indicator");
    const style = indicator && getComputedStyle(indicator);
    const rect = indicator?.getBoundingClientRect();
    const openedHit = game.containerUI._session?.hit;
    return {
      elapsed: game.elapsed,
      simulationTime: game.wildlife.clock,
      frame: window.__voxelBot.state().frame,
      active: game.active,
      paused: game.paused,
      mode: game.gameplay.mode,
      dead: game.gameplay.dead,
      playerHealth: game.gameplay.health,
      position: point(game.player.position),
      eye: point(game.player.eyePosition),
      yaw: game.player.yaw,
      pitch: game.player.pitch,
      mouseSensitivity: game.player.mouseSensitivity,
      grounded: game.player.grounded,
      flying: game.player.flying,
      held: game.heldAction,
      miningProgress: game.miningProgress,
      lastAction: game.lastAction,
      acknowledgedAt: game.combatFeedback.acknowledgedAt,
      feedback: game.combatFeedback.view({
        now: game.elapsed,
        lastAction: game.lastAction,
        active: game.active,
        hasTarget: !!game.meleeTarget,
        usingItem: game.useActions.use.active,
        hudVisible: game.ui.isHudVisible,
      }),
      use: game.useActions.use.snapshot(),
      hand: game.gameplay.getHandStack(),
      ownership: {
        slots: owned.slots,
        cursor: owned.cursor,
        offhand: owned.offhand,
        equipment: owned.equipment,
        craftingGrid: owned.craftingGrid,
      },
      precise: game.mobTarget?.entity.id ?? null,
      melee: game.meleeTarget?.entity.id ?? null,
      block: game.target ? { ...game.target } : null,
      container: {
        open: game.containerUI.isOpen,
        kind: game.containerUI.kind,
        hit: openedHit ? { ...openedHit } : null,
      },
      rear:
        fixture &&
        world.getCell(fixture.rear.x, fixture.rear.y, fixture.rear.z),
      cover: fixture?.cover.map(({ x, y, z }) => world.get(x, y, z)) ?? [],
      supportIntact: footprint?.support.every(
        ({ x, y, z, id }) => world.get(x, y, z) === id
      ),
      mob: mob
        ? {
            id: mob.id,
            health: mob.health,
            radius: mob.spec.radius,
            height: mob.spec.height,
            position: point(mob.position),
            head: point(
              mob.model.stareTarget.getWorldPosition(mob.position.clone())
            ),
            lookingAt: game.wildlife.isLookingAt(mob),
            lookTimer: mob.lookTimer,
            angry: mob.angry,
            moving: mob.moving,
            dormant: mob.dormant,
          }
        : null,
      indicator: indicator
        ? {
            visible:
              !indicator.hidden &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0,
            phase: indicator.dataset.phase,
            blocked: indicator.dataset.blocked,
            value: Number(indicator.getAttribute("aria-valuenow")),
            text: indicator.getAttribute("aria-valuetext"),
          }
        : null,
    };
  }

  function push(list, value) {
    if (list.length < maxSamples) list.push(value);
    else observation.overflow++;
  }
  function observeFrame() {
    if (!observation) return;
    push(observation.frames, read());
    animation = requestAnimationFrame(observeFrame);
  }
  function begin(label) {
    if (observation || !fixture || !game.active)
      throw new Error("Observation requires one active, prepared encounter");
    stableNodes = [
      document.querySelector(".game-hud"),
      document.querySelector(".hotbar"),
      document.querySelector(".combat-indicator"),
      ...document.querySelectorAll(".hotbar [data-slot]"),
    ];
    const hotbar = stableNodes[1];
    const indicator = stableNodes[2];
    const meter = document.querySelector(".experience-track");
    observation = {
      label,
      initial: read(),
      frames: [],
      presses: [],
      rightReleases: [],
      releases: [],
      overflow: 0,
      hotbarChildChanges: 0,
      indicatorChildChanges: 0,
      fullHudMeterWrites: 0,
    };
    hudObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList" && hotbar.contains(record.target))
          observation.hotbarChildChanges++;
        if (record.type === "childList" && indicator.contains(record.target))
          observation.indicatorChildChanges++;
        if (record.target === meter && record.attributeName === "aria-valuenow")
          observation.fullHudMeterWrites++;
      }
    });
    hudObserver.observe(document.querySelector(".game-hud"), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-valuenow"],
    });
    animation = requestAnimationFrame(observeFrame);
  }
  function observations() {
    if (!observation) return null;
    return {
      ...observation,
      current: read(),
      stableHudNodes:
        stableNodes.every((node) => node?.isConnected) &&
        document.querySelectorAll(".combat-indicator").length === 1,
    };
  }
  function end() {
    const result = observations();
    hudObserver?.disconnect();
    hudObserver = null;
    cancelAnimationFrame(animation);
    animation = null;
    observation = null;
    pendingPress = null;
    pendingRightRelease = null;
    pendingRelease = null;
    return result;
  }
  // Pure before/after observers surround the real container's mousedown handler.
  // They neither dispatch input nor invoke primary/secondary/use/target methods.
  document.addEventListener(
    "mousedown",
    (event) => {
      if (
        observation &&
        event.button === 0 &&
        game.active &&
        game.container.contains(event.target)
      )
        pendingPress = { event, before: read() };
    },
    { capture: true, signal: abort.signal }
  );
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!observation || pendingPress?.event !== event) return;
      push(observation.presses, {
        trusted: event.isTrusted,
        before: pendingPress.before,
        after: read(),
      });
      pendingPress = null;
    },
    { signal: abort.signal }
  );
  // Chest-only observers surround the real document-capture RMB release handler.
  // Window capture runs before it; this later document-capture listener runs
  // immediately after it, even if an opened menu stops subsequent bubbling.
  // All reads are observational; trust is recorded, not synthesized or filtered.
  window.addEventListener(
    "mouseup",
    (event) => {
      if (
        observation &&
        fixture.rear.id === config.chest &&
        event.button === 2 &&
        game.active &&
        game.container.contains(event.target)
      )
        pendingRightRelease = {
          event,
          before: read(),
          precise:
            game.wildlife.raycast(
              game.player.eyePosition,
              game.player.forward,
              3
            )?.entity.id ?? null,
        };
    },
    { capture: true, passive: true, signal: abort.signal }
  );
  document.addEventListener(
    "mouseup",
    (event) => {
      if (!observation || pendingRightRelease?.event !== event) return;
      push(observation.rightReleases, {
        trusted: event.isTrusted,
        button: event.button,
        eventTimestamp: event.timeStamp,
        before: pendingRightRelease.before,
        precise: pendingRightRelease.precise,
        after: read(),
      });
      pendingRightRelease = null;
    },
    { capture: true, passive: true, signal: abort.signal }
  );
  // Window capture precedes the game's document-capture KeyV handler. This
  // observes the real full-charge ray before fireBow runs, without updating
  // game targets or replacing any action/query/input handler.
  window.addEventListener(
    "keyup",
    (event) => {
      if (observation && event.code === "KeyV")
        pendingRelease = {
          event,
          before: read(),
          precise:
            game.wildlife.raycast(
              game.player.eyePosition,
              game.player.forward,
              32
            )?.entity.id ?? null,
        };
    },
    { capture: true, signal: abort.signal }
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (!observation || pendingRelease?.event !== event) return;
      push(observation.releases, {
        trusted: event.isTrusted,
        code: event.code,
        before: pendingRelease.before,
        precise: pendingRelease.precise,
        after: read(),
        shotEnd: point(game.useActions.shotEnd),
      });
      pendingRelease = null;
    },
    { signal: abort.signal }
  );
  requirePaused();
  window.__voxelCombatRegression = {
    prepare,
    addCover,
    read,
    begin,
    observations,
    end,
    get fixture() {
      return fixture;
    },
    dispose() {
      end();
      abort.abort();
      delete window.__voxelCombatRegression;
    },
  };
}
