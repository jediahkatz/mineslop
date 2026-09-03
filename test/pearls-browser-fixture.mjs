import { BLOCK } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";
import { PEARL_TRAIL_POINTS } from "../src/pearl-render.js";
import { MAX_PLAYER_PEARLS } from "../src/pearl-save.js";

const durable = (id) => ({ id, count: 1, durability: getItem(id).durability });

export const pearlBrowserConfig = {
  air: BLOCK.AIR,
  stone: BLOCK.STONE,
  pearl: ITEM.ENDER_PEARL,
  pearls: {
    id: ITEM.ENDER_PEARL,
    count: 12,
    data: { version: 1, name: "Finite browser-test pearls" },
  },
  shield: durable(ITEM.SHIELD),
  equipment: {
    head: durable(ITEM.IRON_HELMET),
    chest: durable(ITEM.IRON_ARMOR),
    legs: durable(ITEM.IRON_LEGGINGS),
    feet: durable(ITEM.IRON_BOOTS),
  },
  naturalFloor: [
    BLOCK.GRASS,
    BLOCK.DIRT,
    BLOCK.STONE,
    BLOCK.SAND,
    BLOCK.SNOW,
    BLOCK.GRAVEL,
    BLOCK.CLAY,
    BLOCK.PODZOL,
    BLOCK.MYCELIUM,
  ],
  maxPearls: MAX_PLAYER_PEARLS,
  trailPoints: PEARL_TRAIL_POINTS,
  wallPitch: 0.12,
  skyPitch: 1.35,
  limits: {
    searchRadius: 12,
    setupReads: 100000,
    setupMs: 4000,
    authoredCells: 75,
    stages: 10,
    observationMs: 15000,
    frames: 1024,
    inputs: 128,
    transitions: 24,
    gpuErrors: 16,
    looseItems: 128,
    archiveEdits: 20000,
    archiveBytes: 32 * 1024 * 1024,
  },
};

/**
 * Serialize with page.evaluate(installPearlBrowserFixture, { config, manifest? }).
 *
 * AUTHORED SETUP ONLY: prepare() supplies twelve finite pearls, full iron armor,
 * one shield and a Creative palette entry. It searches loaded natural terrain
 * for a clear 3x19 lane; otherwise it adds a 57-cell floor ABOVE, never through,
 * the loaded natural terrain. The target is a twelve-cell stone wall. A six-cell
 * removable ceiling makes the ONE impact pose genuinely too small for a body.
 * stage() authors a paused stance/aim, never a measured movement or health result.
 * Neither operation resets health, time, RNG, cooldown, life, or live flights.
 *
 * Everything else is read-only game observation. Independent, bounded rAF and
 * input listeners observe completed draws / real handlers, without wrapping any
 * method. Pixel reads use the actual canvas, not a second render or fake scene.
 * After reload, reinstall with the manifest; NEVER call prepare() again.
 */
export function installPearlBrowserFixture({ config, manifest = null }) {
  const game = window.__voxelBot?.game;
  if (!game || window.__voxelPearls)
    throw new Error(
      "Expected one fresh frozen realtime host without a pearl fixture"
    );
  const {
    world,
    player,
    gameplay,
    graphics,
    projectileServices: service,
  } = game;
  const pool = game.projectiles;
  if (!service?.active || pool !== service.projectiles || !game.hurtFeedback)
    throw new Error(
      "Frozen host lacks the complete real Game pearl integration"
    );
  const generator = world.generator;
  const clone = (value) => structuredClone(value);
  const point = ({ x, y, z }) => ({ x, y, z });
  const cellKey = ({ x, y, z }) => `${x},${y},${z}`;
  const sameCell = (a, b) =>
    a && b && ["id", "state", "fluid"].every((key) => a[key] === b[key]);
  const abort = new AbortController();
  const locations = new WeakMap();
  const identities = new WeakMap();
  const gpuErrors = [];
  let gpuErrorOverflow = false;
  let contextLosses = 0;
  graphics.renderer.domElement.addEventListener(
    "webglcontextlost",
    () => {
      contextLosses++;
    },
    { passive: true, signal: abort.signal }
  );
  let nextIdentity = 1;
  const identity = (object) => {
    if (!identities.has(object)) identities.set(object, nextIdentity++);
    return identities.get(object);
  };
  const methods = [
    [game, "frame"],
    [game, "resetActions"],
    [game.archive, "snapshot"],
    [player, "update"],
    [player, "setPosition"],
    [gameplay, "damage"],
    [gameplay, "onHurt"],
    [gameplay, "onDeath"],
    [game.useActions, "begin"],
    [game.useActions, "perform"],
    [service, "throw"],
    [service, "frame"],
    [service, "cancel"],
    [pool, "prepareThrow"],
    [pool, "prepareImpact"],
    [pool, "update"],
    [pool, "onEvent"],
    [pool, "cancelPending"],
    [graphics, "render"],
  ].map(([owner, key]) => ({ owner, key, method: owner[key] }));
  let fixture = manifest && clone(manifest);
  let prepared = Boolean(manifest);
  let stages = 0;
  let observation = null;
  let animation = null;
  let previous = null;
  let deadline = null;
  const pendingInputs = new WeakMap();

  function owners() {
    const owner = pool.getOwner(pool.ownerId);
    return {
      game: window.__voxelBot.game === game,
      world: game.world === world && player.world === world,
      generator: world.generator === generator,
      player: game.player === player && owner?.ref === player,
      gameplay: game.gameplay === gameplay && service.gameplay === gameplay,
      service: game.projectileServices === service && service.game === game,
      pool: game.projectiles === pool && service.projectiles === pool,
      activeService: service.active,
      scene: game.graphics === graphics && service._scene === graphics.scene,
      camera: player.camera === graphics.camera,
      coordinator: [gameplay, service, pool].every(
        (owner) => owner.coordinator === world.coordinator
      ),
      reserved: [world, gameplay, service, pool].every(
        (owner) => world.coordinator.usage(owner) !== undefined
      ),
      binding: !pool.size || pool._binding?.ref === player,
      life: owner?.life === pool.life,
      methods: methods.every(({ owner, key, method }) => owner[key] === method),
    };
  }

  function current() {
    if (Object.values(owners()).some((value) => value !== true) || game.failed)
      throw new Error(
        "Pearl fixture lost its real owners or unchanged methods"
      );
  }

  function quiet({ setup = false, archive = false } = {}) {
    current();
    const deathInspection =
      archive &&
      !setup &&
      gameplay.dead === true &&
      game.ui.isDead === true &&
      game.simulating === false &&
      !game.active;
    if (
      (!game.paused && !gameplay.dead) ||
      game.active ||
      player.enabled ||
      (game.overlayOpen && !deathInspection) ||
      game.building ||
      game.closingScreens ||
      observation ||
      (setup && (gameplay.dead || pool.size || world.dimension !== "overworld"))
    )
      throw new Error(
        `End observation and pause; setup cannot alter a live flight/life: ${JSON.stringify(
          {
            setup,
            archive,
            paused: game.paused,
            dead: gameplay.dead,
            uiDead: game.ui.isDead,
            active: game.active,
            enabled: player.enabled,
            overlayOpen: game.overlayOpen,
            building: game.building,
            closingScreens: Boolean(game.closingScreens),
            observing: Boolean(observation),
          }
        )}`
      );
  }

  quiet();
  if (
    fixture &&
    (fixture.seed !== world.seed ||
      fixture.generatorVersion !== world.generatorVersion ||
      fixture.dimension !== world.dimension)
  )
    throw new Error("Reload manifest belongs to another world");

  function findLane() {
    const started = performance.now();
    const columns = new Map();
    let reads = 0;
    const read = (x, y, z) => {
      if (
        ++reads > config.limits.setupReads ||
        performance.now() - started > config.limits.setupMs
      )
        throw new Error("Natural lane search exceeded its read/time bound");
      return world.getCell(x, y, z);
    };
    const unedited = (x, y, z) => !world.edits.has(`overworld:${x},${y},${z}`);
    const column = (x, z) => {
      const key = `${x},${z}`;
      if (columns.has(key)) return columns.get(key);
      let found = null;
      if (world.isLoaded(x, z)) {
        for (let y = world.maxY - 1; y >= world.minY; y--) {
          const cell = read(x, y, z);
          if (!cell) throw new Error("A loaded setup column disappeared");
          if (cell.id === config.air && !cell.fluid) continue;
          found = {
            x,
            y,
            z,
            cell: clone(cell),
            natural:
              config.naturalFloor.includes(cell.id) &&
              cell.state === 0 &&
              !cell.fluid &&
              unedited(x, y, z),
          };
          break;
        }
      }
      columns.set(key, found);
      return found;
    };
    const boot = point(player.position);
    const sx = Math.floor(boot.x),
      sz = Math.floor(boot.z);
    const apronLoaded = (x, z) =>
      [-3, 3].every((dx) =>
        [-20, 4].every((dz) => world.isLoaded(x + dx, z + dz))
      );
    let chosen = null;
    let candidates = 0;
    // Deterministic bounded search, not a retry of a failing throw.
    for (let r = 0; r <= config.limits.searchRadius && !chosen; r++) {
      for (let dz = -r; dz <= r && !chosen; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          candidates++;
          const x = sx + dx,
            z = sz + dz;
          if (!apronLoaded(x, z)) continue;
          const center = column(x, z);
          if (!center?.natural || center.y + 7 >= world.maxY) continue;
          const supports = [];
          for (let oz = -17; oz <= 1; oz++) {
            for (let ox = -1; ox <= 1; ox++) {
              const support = column(x + ox, z + oz);
              if (!support?.natural || support.y !== center.y) break;
              supports.push(support);
            }
            if (supports.length !== (oz + 18) * 3) break;
          }
          if (supports.length === 57) {
            chosen = { x, z, floorY: center.y, supports, natural: true };
            break;
          }
        }
      }
    }
    if (!chosen) {
      if (!apronLoaded(sx, sz))
        throw new Error(
          "The fallback lane and its collision apron must already be loaded"
        );
      const supports = [];
      for (let z = sz - 17; z <= sz + 1; z++)
        for (let x = sx - 1; x <= sx + 1; x++) {
          const support = column(x, z);
          if (!support)
            throw new Error("Fallback requires real, nonempty loaded columns");
          supports.push(support);
        }
      chosen = {
        x: sx,
        z: sz,
        floorY: Math.max(...supports.map(({ y }) => y)) + 1,
        supports,
        natural: false,
      };
    }
    if (chosen.floorY + 7 >= world.maxY)
      throw new Error(
        "No loaded room for a small above-terrain collision lane"
      );
    const checks = [];
    for (let z = chosen.z - 17; z <= chosen.z + 1; z++)
      for (let x = chosen.x - 1; x <= chosen.x + 1; x++)
        for (let y = chosen.floorY; y <= chosen.floorY + 6; y++) {
          const cell = read(x, y, z);
          if (
            !cell ||
            !unedited(x, y, z) ||
            ((y !== chosen.floorY || !chosen.natural) &&
              (cell.id !== config.air || cell.fluid))
          )
            throw new Error(
              "Room setup may not erase generated cells, fluids or edits"
            );
          checks.push({ x, y, z, cell: clone(cell) });
        }
    return {
      ...chosen,
      boot,
      checks,
      reads,
      candidates,
      searchMs: performance.now() - started,
    };
  }

  function prepare() {
    quiet({ setup: true });
    if (
      prepared ||
      world.generatorVersion !== 3 ||
      gameplay.mode !== "creative"
    )
      throw new Error(
        "Prepare once on the fresh v3 Creative host, before the UI Survival choice"
      );
    prepared = true;
    if (
      gameplay.health !== 20 ||
      pool.serialize().nextId !== 1 ||
      game.wildlife.projectiles.length
    )
      throw new Error(
        "Setup cannot reset prior health, throws or hostile projectiles"
      );
    const lane = findLane();
    const stone = { id: config.stone, state: 0, fluid: 0 };
    const wallZ = lane.z - 17;
    const changes = lane.checks
      .filter(
        ({ y, z }) =>
          (!lane.natural && y === lane.floorY) ||
          (z === wallZ && y > lane.floorY && y <= lane.floorY + 4)
      )
      .map(({ x, y, z, cell }) => ({ x, y, z, before: cell, after: stone }));
    if (changes.length + 6 > config.limits.authoredCells)
      throw new Error("Pearl collision room exceeds its 75-cell cap");
    const terrain = world.prepareMutation(changes);
    const inventory = gameplay.prepareInventory((draft) => {
      draft.slots = Array(36).fill(null);
      draft.slots[0] = clone(config.pearls);
      draft.cursor = null;
      draft.offhand = clone(config.shield);
      draft.equipment = clone(config.equipment);
      draft.craftingGrid = Array(9).fill(null);
      draft.craftingSize = 2;
      return true;
    });
    if (
      !terrain ||
      !inventory ||
      !world.coordinator.commit([terrain, inventory]).ok ||
      !gameplay.assignSlot(0, config.pearl)
    )
      throw new Error(
        "Real terrain/finite-inventory/palette setup was refused"
      );
    const changed = new Set(changes.map(cellKey));
    fixture = {
      label: "authored-pearl-collision-lane-not-natural-acquisition",
      provenance:
        "Twelve finite decorated pearls, one shield and full iron armor replace the starter inventory; one Creative palette entry and paused authored stance/aim. No health, time, RNG, cooldown, life, flight or success writes.",
      terrain: lane.natural
        ? "Unmodified naturally flat loaded floor; twelve authored wall cells."
        : "57-cell floor and twelve-cell wall added only in empty air above 57 loaded natural columns; generated terrain is preserved.",
      seed: world.seed,
      generatorVersion: world.generatorVersion,
      dimension: world.dimension,
      origin: { x: lane.x, y: lane.floorY, z: wallZ },
      shooter: { x: lane.x + 0.5, y: lane.floorY + 1, z: lane.z + 0.5 },
      boot: lane.boot,
      naturalFloor: lane.natural,
      naturalSupports: lane.supports,
      authoredBaseCells: changes.length,
      authoredChanges: clone(changes),
      ceilingCells: 6,
      setupReads: lane.reads,
      searchCandidates: lane.candidates,
      searchMs: lane.searchMs,
      checks: lane.checks.map((entry) => ({
        ...entry,
        cell: changed.has(cellKey(entry)) ? clone(stone) : entry.cell,
      })),
      ceiling: [],
      scenario: null,
      supplies: {
        pearls: clone(config.pearls),
        shield: clone(config.shield),
        equipment: clone(config.equipment),
      },
    };
    for (let x = lane.x - 1; x <= lane.x + 1; x++)
      for (let z = wallZ + 1; z <= wallZ + 2; z++)
        fixture.ceiling.push({ x, y: lane.floorY + 4, z });
    stage("wall");
    game.refreshHud();
    return clone(fixture);
  }

  function geometryIntact() {
    if (!fixture || world.dimension !== fixture.dimension) return null;
    return (
      fixture.checks.every(({ x, y, z, cell }) =>
        sameCell(world.getCell(x, y, z), cell)
      ) &&
      fixture.naturalSupports.every(({ x, y, z, cell }) =>
        sameCell(world.getCell(x, y, z), cell)
      )
    );
  }

  function stage(kind = "wall") {
    quiet({ setup: true });
    if (
      !fixture ||
      !["wall", "blocked", "sky", "travel"].includes(kind) ||
      ++stages > config.limits.stages ||
      !geometryIntact()
    )
      throw new Error("Unknown/excessive pearl setup or altered real geometry");
    const before = { health: gameplay.health, packet: pool.serialize() };
    const ceilingKeys = new Set(fixture.ceiling.map(cellKey));
    const after = {
      id: kind === "blocked" ? config.stone : config.air,
      state: 0,
      fluid: 0,
    };
    const changes = fixture.checks
      .filter(
        (entry) =>
          ceilingKeys.has(cellKey(entry)) && !sameCell(entry.cell, after)
      )
      .map(({ x, y, z, cell }) => ({ x, y, z, before: cell, after }));
    if (changes.length && !world.applyCells(changes))
      throw new Error("The real World refused the small collision ceiling");
    for (const entry of fixture.checks)
      if (ceilingKeys.has(cellKey(entry))) entry.cell = clone(after);
    const nearWall = { ...fixture.shooter, z: fixture.origin.z + 3.5 };
    const distance = (position) =>
      Math.hypot(position.x - fixture.boot.x, position.z - fixture.boot.z);
    const position =
      kind === "travel" && distance(nearWall) > distance(fixture.shooter)
        ? nearWall
        : fixture.shooter;
    player.yaw = 0;
    player.pitch = ["sky", "travel"].includes(kind)
      ? config.skyPitch
      : config.wallPitch;
    player.setPosition(position);
    fixture.scenario = kind;
    if (
      before.health !== gameplay.health ||
      JSON.stringify(before.packet) !== JSON.stringify(pool.serialize())
    )
      throw new Error(
        "Paused positioning must not change health or projectile ownership"
      );
    return {
      label: `paused-authored-pearl-${kind}-${stages}`,
      position: point(player.position),
      yaw: player.yaw,
      pitch: player.pitch,
      health: gameplay.health,
      cooldown: pool.cooldown,
      life: pool.life,
      ceiling: kind === "blocked",
      geometryIntact: geometryIntact(),
    };
  }

  function ownership() {
    const state = gameplay.getState();
    if (
      game.pickups.size > config.limits.looseItems ||
      game.overflow.size > config.limits.looseItems
    )
      throw new Error("Loose ownership exceeds this bounded pearl observer");
    const pickups = game.pickups.serialize().items;
    const overflow = game.overflow.serialize().entries;
    const owned = {
      slots: state.slots,
      offhand: state.offhand,
      cursor: state.cursor,
      equipment: state.equipment,
      craftingGrid: state.craftingGrid,
    };
    const count = (entries) =>
      entries.reduce(
        (sum, entry) => sum + (entry?.id === config.pearl ? entry.count : 0),
        0
      );
    const inventory = count([
      ...state.slots,
      state.offhand,
      state.cursor,
      ...state.craftingGrid,
      ...Object.values(state.equipment),
    ]);
    return {
      ...owned,
      inventoryPearls: inventory,
      totalPearls: inventory + count(pickups) + count(overflow),
      loosePearls: count(pickups) + count(overflow),
    };
  }

  const multiply = (m, v) =>
    [0, 1, 2, 3].map(
      (row) =>
        m[row] * v[0] +
        m[row + 4] * v[1] +
        m[row + 8] * v[2] +
        m[row + 12] * v[3]
    );
  function gpu(pixels) {
    const { renderer, scene, camera } = graphics;
    const gl = renderer.getContext();
    const view = service.renderer;
    const list = renderer.renderLists.get(scene, 0).transparent;
    const meshState = (mesh, kind) => {
      if (!mesh) return null;
      const program = renderer.properties.get(mesh.material).currentProgram
        ?.program;
      let projection = null;
      if (program && !gl.isContextLost()) {
        if (!locations.has(program))
          locations.set(
            program,
            gl.getUniformLocation(program, "projectionMatrix")
          );
        const location = locations.get(program);
        if (location !== null) projection = gl.getUniform(program, location);
      }
      const count = mesh.count;
      const matrix = mesh.instanceMatrix.array;
      const samples = [];
      // At most two 7x7 canvas reads per mesh/frame. No framebuffer binding,
      // alternate camera, material override, draw call or GL method interception.
      if (
        pixels &&
        count &&
        projection?.length === 16 &&
        gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === null
      ) {
        for (let i = 0; i < Math.min(count, 2); i++) {
          const offset = i * 16;
          const center = multiply(
            projection,
            multiply(camera.matrixWorldInverse.elements, [
              matrix[offset + 12],
              matrix[offset + 13],
              matrix[offset + 14],
              1,
            ])
          );
          const x = Math.floor(
            ((center[0] / center[3]) * 0.5 + 0.5) * gl.drawingBufferWidth
          );
          const y = Math.floor(
            ((center[1] / center[3]) * 0.5 + 0.5) * gl.drawingBufferHeight
          );
          if (
            center[3] <= 0 ||
            Math.abs(center[2] / center[3]) > 1 ||
            x < 3 ||
            y < 3 ||
            x + 3 >= gl.drawingBufferWidth ||
            y + 3 >= gl.drawingBufferHeight
          )
            continue;
          const data = new Uint8Array(7 * 7 * 4);
          gl.readPixels(x - 3, y - 3, 7, 7, gl.RGBA, gl.UNSIGNED_BYTE, data);
          let matching = 0;
          for (let at = 0; at < data.length; at += 4) {
            const [r, g, b] = data.subarray(at, at + 3);
            matching += Number(
              kind === "pearl"
                ? g > r + 30 && b > r + 25 && g > b - 16
                : r > g + 10 && b > r + 7
            );
          }
          samples.push({ index: i, x, y, matching });
        }
      }
      return {
        count,
        capacity: mesh.instanceMatrix.count,
        visible: mesh.visible && mesh.parent === scene,
        listed: list.some(
          (entry) => entry.object === mesh && entry.material === mesh.material
        ),
        linked: Boolean(
          program && gl.getProgramParameter(program, gl.LINK_STATUS)
        ),
        finite: matrix.subarray(0, count * 16).every(Number.isFinite),
        firstPosition: count
          ? { x: matrix[12], y: matrix[13], z: matrix[14] }
          : null,
        samples,
      };
    };
    const state = {
      frame: renderer.info.render.frame,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      contextLost: gl.isContextLost(),
      contextLosses,
      badPrograms: renderer.info.programs.filter(
        (p) => p.diagnostics?.runnable === false
      ).length,
      pearls: meshState(view?.pearls, "pearl"),
      trails: meshState(view?.trails, "trail"),
      resources: view && [
        view.pearls.uuid,
        view.trails.uuid,
        view.geometry.uuid,
        view.pearlMaterial.uuid,
        view.trailMaterial.uuid,
      ],
      sharedGeometry:
        !view ||
        (view.pearls.geometry === view.geometry &&
          view.trails.geometry === view.geometry),
      history: view?._history.size ?? 0,
      maxHistory: view
        ? Math.max(
            0,
            ...[...view._history.values()].map((entries) => entries.length)
          )
        : 0,
      error: gl.getError(),
    };
    // getError consumes the GL flag. Retain every nonzero read, including
    // polling/input reads, so a later rAF cannot accidentally hide an error.
    if (state.error) {
      if (gpuErrors.length >= config.limits.gpuErrors) gpuErrorOverflow = true;
      else gpuErrors.push({ frame: state.frame, code: state.error });
    }
    return {
      ...state,
      errors: clone(gpuErrors),
      errorOverflow: gpuErrorOverflow,
    };
  }

  function read({ pixels = false } = {}) {
    const node = document.querySelector(".hurt-indicator");
    const opacity = node ? Number(getComputedStyle(node).opacity) : 0;
    return {
      frame: graphics.renderer.info.render.frame,
      elapsed: game.elapsed,
      simulationTime: game.wildlife.clock,
      active: game.active,
      simulating: game.simulating,
      paused: game.paused,
      building: game.building,
      enabled: player.enabled,
      failed: game.failed,
      mode: gameplay.mode,
      health: gameplay.health,
      dead: gameplay.dead,
      deathCause: gameplay.deathCause,
      selected: gameplay.selected,
      inputMode: player.inputMode,
      sensitivity: player.mouseSensitivity,
      main: gameplay.getHandStack("main"),
      offhand: gameplay.getHandStack("offhand"),
      mainRevision: gameplay.getHandRevision("main"),
      offhandRevision: gameplay.getHandRevision("offhand"),
      ownership: ownership(),
      packet: pool.serialize(),
      owners: owners(),
      position: point(player.position),
      eye: point(player.eyePosition),
      velocity: point(player.velocity),
      forward: point(player.forward),
      yaw: player.yaw,
      pitch: player.pitch,
      poseRevision: player.poseRevision,
      height: player.height,
      eyeHeight: player.eyeHeight,
      perspective: player.perspective,
      camera: point(graphics.camera.position),
      grounded: player.grounded,
      flying: player.flying,
      fallDistance: player.fallDistance,
      moving: player.moving,
      sprinting: player.sprinting,
      jumpQueued: player._jumpQueued,
      bob: player._bob,
      lastUse: game.useActions.lastUse,
      use: game.useActions.use.snapshot(),
      mobTarget: Boolean(game.mobTarget),
      wildlifeIdentity: identity(game.wildlife),
      nearbyHostiles: game.wildlife.entities.filter(
        (mob) =>
          ["hostile", "watchful"].includes(mob.spec.temperament) &&
          mob.position.distanceTo(player.position) < 12
      ).length,
      autoSpawn: game.wildlife.autoSpawn,
      geometryIntact: geometryIntact(),
      dimension: world.dimension,
      epoch: world.epoch,
      observerErrors: service.observerErrors.map((error) => String(error)),
      chunkRequestBridge: typeof pool.requestChunks,
      hurt: {
        remaining: game.hurtFeedback.remaining,
        opacity,
        visible: Boolean(node && !node.hidden && opacity > 0),
      },
      avatar: {
        visible: game.playerVisual.visible,
        parts: game.playerVisual.mesh?.count ?? 0,
      },
      gpu: gpu(pixels),
    };
  }

  function append(list, value, limit) {
    if (list.length >= limit) {
      observation.error ??= "Bounded pearl observation overflow";
      return;
    }
    list.push(value);
  }
  function sample(state) {
    if (!observation) return;
    const removed = previous.packet.projectiles
      .filter(
        (entry) =>
          !state.packet.projectiles.some((next) => next.id === entry.id)
      )
      .map(({ id }) => id);
    if (removed.length)
      append(
        observation.retirements,
        { ids: removed, before: previous, after: state },
        config.limits.transitions
      );
    if (state.health < previous.health)
      append(
        observation.losses,
        { before: previous, after: state },
        config.limits.transitions
      );
    previous = state;
  }
  function observeFrame() {
    if (!observation || observation.error) return;
    if (
      performance.now() - observation.started > config.limits.observationMs ||
      observation.frames.length >= config.limits.frames
    ) {
      observation.error = "Pearl rAF observer exceeded its time/frame bound";
      return;
    }
    try {
      const state = read({ pixels: true });
      if (state.frame !== observation.lastDraw) {
        observation.lastDraw = state.frame;
        sample(state);
        observation.frames.push(state);
      }
      animation = requestAnimationFrame(observeFrame);
    } catch (error) {
      observation.error = error.stack ?? String(error);
    }
  }
  function begin(label) {
    current();
    if (
      !fixture ||
      observation ||
      typeof label !== "string" ||
      !label ||
      label.length > 160
    )
      throw new Error("Begin one labeled pearl observation at a time");
    previous = read();
    observation = {
      label,
      started: performance.now(),
      initial: previous,
      lastDraw: previous.frame,
      frames: [],
      inputs: [],
      retirements: [],
      losses: [],
      error: null,
    };
    deadline = setTimeout(() => {
      if (observation)
        observation.error ??= "Pearl observer reached its wall-clock deadline";
      cancelAnimationFrame(animation);
    }, config.limits.observationMs);
    animation = requestAnimationFrame(observeFrame);
  }
  const observations = () => observation && { ...observation, current: read() };
  function end() {
    clearTimeout(deadline);
    cancelAnimationFrame(animation);
    const result = observations();
    observation = previous = null;
    animation = deadline = null;
    return result;
  }
  for (const type of [
    "keydown",
    "keyup",
    "mousedown",
    "mouseup",
    "mousemove",
    "click",
  ]) {
    window.addEventListener(
      type,
      (event) => {
        if (!observation) return;
        const input = {
          type,
          code: event.code ?? null,
          button: event.button ?? null,
          buttons: event.buttons ?? null,
          clientX: event.clientX ?? null,
          clientY: event.clientY ?? null,
          timestamp: event.timeStamp,
          trusted: event.isTrusted,
          repeat: event.repeat ?? false,
          target: event.target?.tagName ?? null,
          before: read(),
          after: null,
        };
        append(observation.inputs, input, config.limits.inputs);
        pendingInputs.set(event, input);
      },
      { capture: true, passive: true, signal: abort.signal }
    );
    // Game's document listeners already exist. KeyV commits synchronously in its
    // real bubble listener; this later listener reads that committed result.
    document.addEventListener(
      type,
      (event) => {
        const input = pendingInputs.get(event);
        if (!observation || !input) return;
        input.after = read();
        sample(input.after);
        pendingInputs.delete(event);
      },
      { passive: true, signal: abort.signal }
    );
  }

  function archiveView(saved) {
    if (
      !saved?.playerProjectiles ||
      saved.world.edits.length > config.limits.archiveEdits
    )
      throw new Error(
        "Missing projectile archive or excessive unrelated edits"
      );
    const state = saved.gameplay;
    return {
      packet: clone(saved.playerProjectiles),
      player: clone(saved.player),
      health: state.health,
      dead: state.dead,
      mode: state.mode,
      owned: clone({
        slots: state.slots,
        offhand: state.offhand,
        cursor: state.cursor,
        equipment: state.equipment,
        craftingGrid: state.craftingGrid,
      }),
      world: {
        seed: saved.world.seed,
        generatorVersion: saved.world.generatorVersion,
        dimension: saved.world.dimension,
      },
    };
  }
  function snapshot() {
    quiet();
    if (world.edits.size > config.limits.archiveEdits)
      throw new Error("Archive inspection exceeds this fixture's edit bound");
    return archiveView(game.snapshot());
  }
  async function stored() {
    // Death is itself a UI overlay. This read may inspect its completed save;
    // no setup/movement/capture operation receives that exception.
    quiet({ archive: true });
    const saved = await game.archive.storage.load();
    quiet({ archive: true });
    return archiveView(saved);
  }
  function beforeThrowCapture() {
    quiet({ setup: true });
    if (
      gameplay.mode !== "survival" ||
      gameplay.health !== 20 ||
      pool.serialize().nextId !== 1 ||
      fixture.scenario !== "wall"
    )
      throw new Error("Capture only the actual paused BEFORE-THROW state");
    if (world.edits.size > config.limits.archiveEdits)
      throw new Error("BEFORE-THROW capture exceeds this fixture's edit bound");
    const save = game.snapshot();
    if (JSON.stringify(save).length > config.limits.archiveBytes)
      throw new Error("BEFORE-THROW capture exceeds its archive bound");
    return {
      save,
      manifest: clone(fixture),
      provenance:
        "Read-only capture of the actual paused setup, before any throw. Finite authored supplies/room, not natural acquisition. Import this save via the real UI; choose Remote controls, Play, F5 once, then hold V.",
    };
  }
  window.__voxelPearls = {
    prepare,
    stage,
    read,
    begin,
    observations,
    end,
    snapshot,
    stored,
    beforeThrowCapture,
    get manifest() {
      return fixture && clone(fixture);
    },
    dispose() {
      end();
      abort.abort();
      delete window.__voxelPearls;
    },
  };
}

/** Read-only boot witness, installed once before the first real reload.
 * The same init script observes later reloads in their NEW documents. No save
 * injection, UI mutation, source hook, timer replacement or resume is performed.
 */
export function installPearlReloadObserver() {
  const proof = {
    samples: 0,
    readyFrames: 0,
    first: null,
    last: null,
    maxHurt: 0,
    maxOpacity: 0,
    changes: [],
    error: null,
    done: false,
  };
  window.__voxelPearlReload = proof;
  const started = performance.now();
  let signature = null;
  function observe() {
    if (++proof.samples > 5000 || performance.now() - started > 75000) {
      proof.error =
        "Read-only pearl boot observer exhausted its startup budget";
      proof.done = true;
      return;
    }
    try {
      const game = window.__voxelBot?.game;
      if (game?.projectileServices?.active) {
        const value = {
          packet: game.projectileServices.serialize().playerProjectiles,
          health: game.gameplay.health,
          paused: game.paused,
          simulating: game.simulating,
          position: {
            x: game.player.position.x,
            y: game.player.position.y,
            z: game.player.position.z,
          },
        };
        proof.first ??= value;
        proof.last = value;
        proof.maxHurt = Math.max(proof.maxHurt, game.hurtFeedback.remaining);
        const node = document.querySelector(".hurt-indicator");
        proof.maxOpacity = Math.max(
          proof.maxOpacity,
          node ? Number(getComputedStyle(node).opacity) : 0
        );
        const next = JSON.stringify(value);
        if (signature !== null && next !== signature) {
          if (proof.changes.length >= 16)
            throw new Error("Pearl boot transition bound exceeded");
          proof.changes.push(value);
        }
        signature = next;
      }
      if (window.__voxelBot?.error) throw new Error(window.__voxelBot.error);
      if (window.__voxelBot?.ready && ++proof.readyFrames >= 8) {
        proof.done = true;
        return;
      }
      requestAnimationFrame(observe);
    } catch (error) {
      proof.error = error.stack ?? String(error);
      proof.done = true;
    }
  }
  requestAnimationFrame(observe);
}
