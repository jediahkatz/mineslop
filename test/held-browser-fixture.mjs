import { BLOCK } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";

const durable = (id) => ({ id, count: 1, durability: getItem(id).durability });
export const heldBrowserConfig = {
  air: BLOCK.AIR,
  stone: BLOCK.STONE,
  obsidian: BLOCK.OBSIDIAN,
  apple: ITEM.APPLE,
  bow: ITEM.BOW,
  arrow: ITEM.ARROW,
  pickaxe: ITEM.WOOD_PICKAXE,
  shield: ITEM.SHIELD,
  // Preserve the four real starter apples; add only these finite test supplies.
  slots: [null, durable(ITEM.SHIELD), { id: ITEM.APPLE, count: 4 },
    durable(ITEM.BOW), { id: ITEM.ARROW, count: 6 }, durable(ITEM.WOOD_PICKAXE)],
  offhand: durable(ITEM.SHIELD),
  foodPrerequisiteHunger: 12,
  limits: {
    authoredCells: 125, searchRadius: 8, setupReads: 100000, setupMs: 4000,
    stages: 16, windows: 24, frames: 2048, totalFrames: 8192, inputs: 128,
    gestureMs: 8000, releaseMs: 350, armMs: 120000, armFrames: 32768,
  },
};

/** A supplied isolated host only. Preserve the Pages prefix, unlike a root URL. */
export function heldBrowserURL(raw) {
  if (!raw) throw new Error("Set VOXELCRAFT_TEST_URL to a fresh frozen host");
  const base = new URL(raw);
  const protectedPorts = new Set([
    "5173", "5280", "5290", "5297", "5311", "5352", "5363", "5487",
    "5488", "5491", "5503", "5504", "5505", "5521",
  ]);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !["127.0.0.1", "[::1]"].includes(base.hostname) || !base.port ||
    base.username || base.password || base.search || base.hash ||
    protectedPorts.has(base.port)
  ) throw new Error("Use an explicit fresh numeric-loopback port, not a shared/protected host");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const url = new URL("test/realtime/index.html", base);
  url.searchParams.set("quality", "low");
  url.searchParams.set("seed", "cedar-valley");
  return url;
}

/**
 * page.evaluate(installHeldBrowserFixture, { config, provenance }).
 *
 * prepare()/stage() are explicitly UNMEASURED prerequisites, not acquisition:
 * a 7x5x4 sealed stone shell (110 cells including its obsidian target), added
 * only in unedited loaded air above all native cells, finite supplies, one
 * prepared hunger change, and paused physical stance/aim. No native cell is
 * removed. No mob, AI/damage flag, health, clock, RNG or action timer is written.
 *
 * The rest is an external read-only observer. It does not import a toy Game,
 * install a hand probe, wrap methods, advance time, render, or inject input.
 * The existing realtime host's dormant metrics wrappers are left untouched.
 */
export function installHeldBrowserFixture({ config, provenance = null }) {
  const game = window.__voxelBot?.game;
  if (!game || window.__voxelHeld)
    throw new Error("Expected one fresh real Game without a held fixture");
  const { world, gameplay, player, graphics, effects, useActions, wildlife } = game;
  const use = useActions.use;
  const generator = world.generator;
  const mainMotion = effects.motion, offMotion = effects.offhand?.motion;
  if (!mainMotion || !offMotion)
    throw new Error("Frozen Game does not contain the explicit held-motion state");
  const clone = (value) => structuredClone(value);
  const xyz = ({ x, y, z }) => ({ x, y, z });
  const cellKey = ({ x, y, z }) => `${x},${y},${z}`;
  const sameCell = (a, b) => a && b &&
    ["id", "state", "fluid"].every((key) => a[key] === b[key]);
  const abort = new AbortController();
  const methods = [
    [game, "frame"], [game, "primary"], [game, "resetActions"], [game, "select"],
    [game, "updateTarget"], [game, "setControlPreferences"],
    [world, "prepareMutation"], [world.coordinator, "commit"],
    [gameplay, "prepareInventory"], [gameplay, "_prepareState"],
    [gameplay, "damage"], [gameplay, "miningDuration"],
    [player, "update"], [player, "setPosition"], [graphics, "render"],
    [effects, "update"], [effects, "select"], [effects, "selectOffhand"],
    [useActions, "begin"], [useActions, "end"], [useActions, "update"],
    [useActions, "perform"], [use, "start"], [use, "advance"],
    [use, "release"], [use, "cancel"], [wildlife, "update"],
  ].map(([owner, key]) => ({ owner, key, method: owner[key] }));
  let manifest = null, attempted = false, stages = 0, windows = 0, totalFrames = 0;
  let record = null, animation = null, timer = null, badge = null;
  const live = () => record && ["armed", "recording"].includes(record.status);

  function owners() {
    return {
      game: window.__voxelBot?.game === game,
      world: game.world === world && player.world === world,
      generator: world.generator === generator,
      gameplay: game.gameplay === gameplay,
      player: game.player === player && player.camera === graphics.camera,
      graphics: game.graphics === graphics,
      effects: game.effects === effects && effects.scene === graphics.scene,
      hands: effects.hand.parent === graphics.camera &&
        effects.offhand.hand.parent === graphics.camera,
      motion: effects.motion === mainMotion && effects.offhand.motion === offMotion,
      use: game.useActions === useActions && useActions.game === game && useActions.use === use,
      wildlife: game.wildlife === wildlife && wildlife.world === world,
      coordinator: gameplay.coordinator === world.coordinator &&
        [world, gameplay].every((owner) => world.coordinator.usage(owner) !== undefined),
      methods: methods.every(({ owner, key, method }) => owner[key] === method),
    };
  }
  function current() {
    if (game.failed || Object.values(owners()).some((value) => !value))
      throw new Error("Real Game owners/methods changed or the host failed");
  }
  function quiet() {
    current();
    if (!game.paused || game.active || player.enabled || game.overlayOpen ||
      game.building || game.closingScreens || gameplay.dead || live() ||
      use.active || useActions.held || game.heldAction || player._keys.size)
      throw new Error("Prerequisites require a paused, released, unmeasured real Game");
  }
  function counters() {
    return {
      health: gameplay.health, air: gameplay.air, saturation: gameplay.saturation,
      exhaustion: gameplay.exhaustion, timers: clone(gameplay._timers),
      elapsed: game.elapsed, wildlifeClock: wildlife.clock, day: game.currentTime,
      lastAction: String(game.lastAction), lastUse: String(useActions.lastUse),
      spawnProtectionUntil: wildlife.spawnProtectionUntil,
      wildlifeNextId: wildlife.nextId, wildlifeRandom: wildlife.randomState,
    };
  }

  function findRoom() {
    const started = performance.now(), columns = new Map();
    let reads = 0, candidates = 0;
    const read = (x, y, z) => {
      if (++reads > config.limits.setupReads ||
        performance.now() - started > config.limits.setupMs)
        throw new Error("Loaded-air room search exceeded its read/time budget");
      return world.getCell(x, y, z);
    };
    const unedited = (x, y, z) => !world.edits.has(`${world.dimension}:${x},${y},${z}`);
    const top = (x, z) => {
      const key = `${x},${z}`;
      if (columns.has(key)) return columns.get(key);
      let result = null;
      if (world.isLoaded(x, z)) {
        for (let y = world.maxY - 1; y >= world.minY; y--) {
          const cell = read(x, y, z);
          if (!cell) throw new Error("An already-loaded room column disappeared");
          if (cell.id === config.air && !cell.fluid && !cell.state) continue;
          result = { x, y, z, cell: clone(cell) };
          break;
        }
      }
      columns.set(key, result);
      return result;
    };
    const sx = Math.floor(player.position.x), sz = Math.floor(player.position.z);
    for (let radius = 0; radius <= config.limits.searchRadius; radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const x = sx + dx, z = sz + dz, supports = [];
          if (![-5, 5].every((ox) => [-4, 4].every((oz) =>
            world.isLoaded(x + ox, z + oz)))) continue;
          for (let ox = -3; ox <= 3; ox++)
            for (let oz = -2; oz <= 2; oz++) supports.push(top(x + ox, z + oz));
          if (supports.some((entry) => !entry)) continue;
          const highest = Math.max(...supports.map((entry) => entry.y));
          // Three bounded height candidates; never request a new chunk or clear terrain.
          for (const gap of [4, 6, 8]) {
            candidates++;
            const floorY = highest + gap;
            if (floorY + 3 >= world.maxY) continue;
            if (wildlife.entities.length > 256) throw new Error("Mob inspection exceeds setup bound");
            if (wildlife.entities.some(({ position: p }) =>
              p.x >= x - 4 && p.x <= x + 5 && p.z >= z - 3 && p.z <= z + 4 &&
              p.y >= floorY - 3 && p.y <= floorY + 5)) continue;
            const checks = [];
            for (let ox = -3; ox <= 3; ox++)
              for (let oz = -2; oz <= 2; oz++)
                for (let oy = 0; oy <= 3; oy++) {
                  const cx = x + ox, cy = floorY + oy, cz = z + oz;
                  const cell = read(cx, cy, cz);
                  if (!cell || !unedited(cx, cy, cz) || cell.id !== config.air ||
                    cell.state || cell.fluid) continue;
                  checks.push({ x: cx, y: cy, z: cz, cell: clone(cell),
                    shell: Math.abs(ox) === 3 || Math.abs(oz) === 2 || oy === 0 || oy === 3 });
                }
            if (checks.length === 140)
              return { x, z, floorY, supports, checks, reads, candidates,
                searchMs: performance.now() - started };
          }
        }
      }
    }
    throw new Error("No safe unedited, loaded, above-terrain air volume within the bounded search");
  }

  function intact() {
    return Boolean(manifest && world.dimension === manifest.dimension &&
      manifest.checks.every(({ x, y, z, cell }) => sameCell(world.getCell(x, y, z), cell)) &&
      manifest.nativeSupports.every(({ x, y, z, cell }) => sameCell(world.getCell(x, y, z), cell)));
  }
  function stage() {
    quiet();
    if (!manifest || ++stages > config.limits.stages || !intact())
      throw new Error("No intact room or paused-stance budget remains");
    const before = JSON.stringify({ counters: counters(), hunger: gameplay.hunger });
    player.yaw = 0;
    player.pitch = 0;
    player.setPosition(manifest.stance);
    if (before !== JSON.stringify({ counters: counters(), hunger: gameplay.hunger }))
      throw new Error("Stance setup changed unrelated gameplay counters");
    return { label: `AUTHORED paused stance ${stages}`, position: xyz(player.position),
      yaw: player.yaw, pitch: player.pitch, health: gameplay.health };
  }
  function prepare() {
    quiet();
    if (attempted || world.generatorVersion !== 3 || world.dimension !== "overworld" ||
      gameplay.mode !== "survival" || gameplay.health !== 20 || gameplay.hunger !== 20)
      throw new Error("Prepare exactly once on a fresh 20HP v3 host, after choosing Survival");
    attempted = true;
    const original = gameplay.getState();
    if (original.slots[0]?.id !== config.apple || original.slots[0]?.count !== 4 ||
      original.slots.slice(1).some(Boolean) || original.offhand || original.cursor ||
      original.craftingGrid.some(Boolean) || Object.values(original.equipment).some(Boolean) ||
      wildlife.projectiles.length || useActions.lastUse !== -Infinity)
      throw new Error("Expected untouched finite starter ownership and no prior use/projectiles");
    const before = counters(), room = findRoom();
    const target = { x: room.x, y: room.floorY + 2, z: room.z - 2 };
    const changes = room.checks.filter((cell) => cell.shell).map(({ x, y, z, cell }) => ({
      x, y, z, before: cell,
      after: { id: cellKey({ x, y, z }) === cellKey(target) ? config.obsidian : config.stone,
        state: 0, fluid: 0 },
    }));
    if (changes.length !== 110 || changes.length > config.limits.authoredCells)
      throw new Error("Authored sealed room exceeds its finite-cell contract");
    const terrain = world.prepareMutation(changes, {
      reads: [...room.checks.filter((entry) => !entry.shell), ...room.supports]
        .map(({ x, y, z, cell }) => ({ x, y, z, before: cell })),
    });
    const inventory = gameplay.prepareInventory((draft) => {
      draft.slots = Array(36).fill(null);
      for (let i = 0; i < config.slots.length; i++) draft.slots[i] = clone(config.slots[i]);
      draft.offhand = clone(config.offhand);
      return true;
    });
    if (!terrain || !inventory || !world.coordinator.commit([terrain, inventory]).ok)
      throw new Error("Real World/Gameplay coordinator refused finite room/supply setup");
    // Explicit FOOD TEST prerequisite, not healing or claimed Survival acquisition.
    const food = gameplay._prepareState((draft) => {
      draft.hunger = config.foodPrerequisiteHunger;
      return true;
    });
    if (!food || !world.coordinator.commit([food]).ok)
      throw new Error("Real prepared Gameplay state refused the one-time food prerequisite");
    if (JSON.stringify(before) !== JSON.stringify(counters()))
      throw new Error("Prerequisites changed health, timers, wildlife or world time");
    const changed = new Map(changes.map((entry) => [cellKey(entry), entry.after]));
    manifest = {
      label: "AUTHORED HAND-MOTION VISUAL TEST — NOT SURVIVAL ACQUISITION",
      provenance: clone(provenance),
      disclosure: "110 stone/obsidian cells in previously empty loaded air; intact native terrain. " +
        "Four starter apples retained, two finite shields, one bow, six arrows, one wooden pickaxe. " +
        "One prepared hunger change 20→12 before measurement; no healing, AI/damage/time changes. " +
        "Paused authored stance/aim; every measured action is trusted browser input.",
      seed: world.seed, dimension: world.dimension, generatorVersion: world.generatorVersion,
      bootPosition: xyz(player.position), target,
      stance: { x: room.x + 0.5, y: room.floorY + 1, z: room.z + 0.5 },
      authoredCells: changes.length, changes: clone(changes), nativeSupports: room.supports,
      checks: room.checks.map(({ shell, ...entry }) => ({
        ...entry, cell: clone(changed.get(cellKey(entry)) ?? entry.cell),
      })),
      search: { reads: room.reads, candidates: room.candidates, ms: room.searchMs },
      originalOwned: { slots: original.slots, offhand: original.offhand },
      countersBefore: before, foodPrerequisite: { before: 20, after: gameplay.hunger },
      slots: clone(config.slots), offhand: clone(config.offhand),
    };
    stage();
    game.refreshHud();
    badge = document.createElement("aside");
    badge.setAttribute("role", "note");
    badge.textContent = "AUTHORED VISUAL TEST · sealed air-only room · finite items · initial hunger 12/20 · not acquisition";
    badge.style.cssText = "position:fixed;top:8px;left:8px;z-index:10000;pointer-events:none;" +
      "max-width:90vw;padding:6px 9px;background:#171d26e8;color:#fff;" +
      "font:11px/1.4 monospace;border:1px solid #d8b065;border-radius:3px";
    document.body.append(badge);
    return clone(manifest);
  }

  const channelNames = ["walk", "mining", "food", "bow", "shield", "charge", "equip", "strike"];
  function hand(view, lists) {
    const motion = view.motion;
    return {
      id: view.itemId, visible: view.hand.visible,
      position: xyz(view.hand.position), rotation: xyz(view.hand.rotation), scale: xyz(view.hand.scale),
      itemPosition: xyz(view.itemMesh.position), itemRotation: xyz(view.itemMesh.rotation),
      itemScale: xyz(view.itemMesh.scale), itemVisible: view.itemMesh.visible,
      blockVisible: view.held.visible, reducedMotion: Boolean(view.motionPreference?.matches),
      drawn: [view.arm, view.held, view.itemMesh].some((mesh) =>
        lists.opaque.some((entry) => entry.object === mesh) ||
        lists.transparent.some((entry) => entry.object === mesh)),
      resources: [view.hand.uuid, view.handGeometry.uuid, view.handMaterial.uuid,
        view.itemGeometry.uuid, view.itemMaterial.uuid],
      motion: {
        ...Object.fromEntries(channelNames.map((key) => [key, { ...motion[key] }])),
        pose: { ...motion.pose }, miningActive: motion.miningActive,
        miningRequested: motion.miningRequested, miningPhase: motion.miningPhase,
        walkPhase: motion.walkPhase, foodPhase: motion.foodPhase,
      },
    };
  }
  function read() {
    current();
    const state = gameplay.getState(), renderer = graphics.renderer;
    const lists = renderer.renderLists.get(graphics.scene, 0);
    return {
      now: performance.now(), frame: game.vehicleFrame, draw: renderer.info.render.frame,
      frameTime: game.lastFrame, elapsed: game.elapsed, simulationTime: wildlife.clock,
      day: game.currentTime, active: game.active, simulating: game.simulating,
      paused: game.paused, enabled: player.enabled, failed: game.failed, mode: gameplay.mode,
      health: gameplay.health, hunger: gameplay.hunger, saturation: gameplay.saturation,
      exhaustion: gameplay.exhaustion, dead: gameplay.dead, inputMode: player.inputMode,
      position: xyz(player.position), eye: xyz(player.eyePosition), velocity: xyz(player.velocity),
      forward: xyz(player.forward), yaw: player.yaw, pitch: player.pitch,
      perspective: player.perspective, hudVisible: game.ui.isHudVisible !== false,
      documentHidden: document.hidden, camera: xyz(graphics.camera.position),
      projection: { fov: graphics.camera.fov, aspect: graphics.camera.aspect },
      grounded: player.grounded, moving: player.moving, flying: player.flying,
      selected: gameplay.selected, keys: [...player._keys], heldAction: game.heldAction,
      miningProgress: game.miningProgress, miningDuration: gameplay.miningDuration(config.obsidian),
      target: game.target && { x: game.target.x, y: game.target.y, z: game.target.z,
        id: game.target.id, distance: game.target.distance },
      targetCell: manifest && world.getCell(manifest.target.x, manifest.target.y, manifest.target.z),
      mobTarget: Boolean(game.mobTarget || game.meleeTarget || game.vehicleTarget),
      use: { ...use.snapshot(), elapsed: use.elapsed, held: useActions.held, source: useActions.source },
      main: hand(effects, lists), offhand: hand(effects.offhand, lists),
      owned: { slots: state.slots, offhand: state.offhand, cursor: state.cursor,
        equipment: state.equipment, craftingGrid: state.craftingGrid },
      mainRevision: gameplay.getHandRevision("main"), offhandRevision: gameplay.getHandRevision("offhand"),
      owners: owners(), geometryIntact: intact(), autoSpawn: wildlife.autoSpawn,
      gpu: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
        contextLost: renderer.getContext().isContextLost(),
        badPrograms: renderer.info.programs.filter((p) => p.diagnostics?.runnable === false).length },
    };
  }
  function accepted(kind, state) {
    if (!state.active || !state.enabled) return false;
    if (kind === "mining")
      return state.mode === "survival" && state.heldAction === "mine" &&
        state.miningProgress > 0 && !state.mobTarget &&
        state.target?.id === config.obsidian &&
        cellKey(state.target) === cellKey(manifest.target);
    if (kind === "walking")
      return state.moving && state.keys.some((key) => ["KeyW", "KeyA", "KeyS", "KeyD"].includes(key));
    const [useKind, handName] = kind.split("-");
    return state.use.active && state.use.held && state.use.kind === useKind &&
      state.use.hand === handName;
  }
  function relevant(input, kind) {
    return input.trusted && !input.repeat &&
      (kind === "mining" ? input.type === "mousedown" && input.button === 0 :
        kind === "walking" ? input.type === "keydown" &&
          ["KeyW", "KeyA", "KeyS", "KeyD"].includes(input.code) :
          (input.type === "keydown" && input.code === "KeyV") ||
          (input.type === "mousedown" && input.button === 2));
  }
  function finish(reason, error = null) {
    if (!live()) return;
    clearTimeout(timer);
    cancelAnimationFrame(animation);
    record.status = error ? "error" : reason === "release-or-cancel-plus-350ms" ? "complete" : "stopped";
    record.reason = reason;
    record.error ??= error;
    record.endedAt = performance.now();
    try { record.current = read(); }
    catch (failure) { record.status = "error"; record.error ??= String(failure); }
  }
  function edge(state) {
    if (!live()) return;
    const active = accepted(record.kind, state);
    if (record.status === "armed") {
      const input = record.inputs.findLast((entry) => relevant(entry, record.kind));
      if (!active || !input) return;
      if (record.kind === "walking" &&
        Math.hypot(state.position.x - input.before.position.x,
          state.position.z - input.before.position.z) <= 0.0005) return;
      record.status = "recording";
      record.startedAt = performance.now();
      record.initial = input.before;
      record.activation = state;
      record.trigger = { type: input.type, code: input.code, button: input.button,
        trusted: input.trusted, at: input.at };
      clearTimeout(timer);
      timer = setTimeout(() => finish("gesture-ceiling", "Eight-second gesture ceiling reached"),
        config.limits.gestureMs);
    }
    if (!active && record.releasedAt === null) {
      record.releasedAt = performance.now();
      record.release = state;
      // This timer stops observation only. It never advances the Game or its physics.
      clearTimeout(timer);
      const remaining = config.limits.gestureMs - (record.releasedAt - record.startedAt);
      timer = setTimeout(() => remaining < config.limits.releaseMs
        ? finish("gesture-ceiling", "Eight-second gesture ceiling reached")
        : finish("release-or-cancel-plus-350ms"),
      Math.max(0, Math.min(config.limits.releaseMs, remaining)));
    } else if (active && record.releasedAt !== null) {
      finish("retriggered", "A second action entered the same finite gesture window");
    }
  }
  function observeFrame() {
    if (!live()) return;
    try {
      const state = read();
      if (state.frame !== record.lastFrame) {
        if (state.frame !== record.lastFrame + 1 || state.draw <= record.lastDraw)
          throw new Error("Observer missed a completed Game frame or its actual render");
        record.lastFrame = state.frame;
        record.lastDraw = state.draw;
        if (++record.armFrames > config.limits.armFrames)
          throw new Error("Armed observer exceeded its finite frame budget");
        edge(state);
        if (record.status === "recording") {
          if (record.frames.length >= config.limits.frames ||
            totalFrames >= config.limits.totalFrames) {
            record.overflow = true;
            throw new Error("Held observer frame cap reached");
          }
          record.frames.push(state);
          totalFrames++;
        }
      }
      if (live()) animation = requestAnimationFrame(observeFrame);
    } catch (error) { finish("observer-error", error.stack ?? String(error)); }
  }
  function arm(kind, label = kind) {
    current();
    if (!manifest || live() || use.active || useActions.held || game.heldAction ||
      player.moving || !/^(mining|walking|(food|bow|shield)-(main|offhand))$/.test(kind) ||
      typeof label !== "string" || !label || label.length > 160 ||
      ++windows > config.limits.windows || totalFrames >= config.limits.totalFrames)
      throw new Error("Release inputs, finish the prior window, and arm one bounded genuine action");
    const state = read();
    record = {
      kind, label, status: "armed", armedAt: performance.now(), armedInitial: state,
      startedAt: null, releasedAt: null, endedAt: null, activation: null, initial: null,
      release: null, current: null, trigger: null, reason: null, error: null, overflow: false,
      lastFrame: state.frame, lastDraw: state.draw, armFrames: 0, frames: [], inputs: [],
    };
    timer = setTimeout(() => finish("arm-ceiling", "No accepted action within the armed budget"),
      config.limits.armMs);
    animation = requestAnimationFrame(observeFrame);
    return status();
  }
  function status() {
    return { status: record?.status ?? "idle", label: record?.label ?? null,
      kind: record?.kind ?? null, startedAt: record?.startedAt ?? null,
      reason: record?.reason ?? null, error: record?.error ?? null,
      overflow: record?.overflow ?? false, frames: record?.frames.length ?? 0,
      inputs: record?.inputs.length ?? 0, windows, totalFrames };
  }
  const pending = new WeakMap();
  for (const type of ["keydown", "keyup", "mousedown", "mouseup", "mousemove", "click"]) {
    window.addEventListener(type, (event) => {
      if (!live()) return;
      try {
        if (record.inputs.length >= config.limits.inputs) {
          record.overflow = true;
          throw new Error("Held observer trusted-input buffer overflow");
        }
        const input = { type, code: event.code ?? null, button: event.button ?? null,
          buttons: event.buttons ?? null, trusted: event.isTrusted, repeat: event.repeat ?? false,
          at: performance.now(), eventTimestamp: event.timeStamp, before: read(), after: null };
        record.inputs.push(input);
        pending.set(event, { record, input });
      } catch (error) { finish("input-observer-error", String(error)); }
    }, { capture: true, passive: true, signal: abort.signal });
    // Window bubble is after real Player/document/container handlers. UI events
    // that stop propagation deliberately retain after:null, never fake acceptance.
    window.addEventListener(type, (event) => {
      const entry = pending.get(event);
      if (!live() || entry?.record !== record) return;
      try {
        entry.input.after = read();
        edge(entry.input.after);
      } catch (error) { finish("input-observer-error", String(error)); }
      pending.delete(event);
    }, { passive: true, signal: abort.signal });
  }
  window.__voxelHeld = {
    prepare, stage, read, arm, status,
    result: () => record && clone(record),
    stop: () => { finish("manual-stop"); return status(); },
    get manifest() { return manifest && clone(manifest); },
    dispose() {
      finish("disposed");
      abort.abort();
      badge?.remove();
      delete window.__voxelHeld;
    },
  };
}
