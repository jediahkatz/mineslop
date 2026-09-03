import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE, FLUID, normalizeCell } from "../src/block-state.js";
import { ITEM } from "../src/items.js";

export const fluidPlayConfig = {
  ids: {
    air: BLOCK.AIR,
    stone: BLOCK.STONE,
    water: BLOCK.WATER,
    kelp: BLOCK.KELP,
    seagrass: BLOCK.SEAGRASS,
    sponge: BLOCK.SPONGE,
    wetSponge: BLOCK.WET_SPONGE,
    bucket: ITEM.BUCKET,
    waterBucket: ITEM.WATER_BUCKET,
  },
  cells: {
    air: normalizeCell({ id: BLOCK.AIR }),
    stone: normalizeCell({ id: BLOCK.STONE }),
    magma: normalizeCell({ id: BLOCK.MAGMA_BLOCK }),
    partial: normalizeCell({ id: BLOCK.OAK_SLAB, state: BLOCK_STATE.TOP }),
    kelp: normalizeCell({ id: BLOCK.KELP }),
    seagrass: normalizeCell({ id: BLOCK.SEAGRASS }),
  },
  fluid: FLUID,
  supplies: [
    { id: ITEM.WATER_BUCKET, count: 1 },
    { id: BLOCK.KELP, count: 4, data: { version: 1, name: "Fluid test kelp" } },
    { id: BLOCK.SEAGRASS, count: 1 },
    { id: ITEM.WATER_BUCKET, count: 1 },
    { id: BLOCK.SPONGE, count: 1 },
    { id: BLOCK.STONE, count: 2 },
    { id: ITEM.WATER_BUCKET, count: 1 },
  ],
  limits: {
    setupReads: 40000,
    setupMs: 5000,
    authoredCells: 160,
    relocations: 16,
    observationMs: 60000,
    observedFrames: 4096,
    transitions: 48,
    inputs: 256,
    looseRecords: 64,
    archiveEdits: 20000,
  },
};

/**
 * page.evaluate(installFluidPlayFixture, { config: fluidPlayConfig })
 *
 * prepare() is ONE explicitly authored, paused setup: finite supplies, a dry
 * enclosed channel and top-slab basin above 84 already-loaded natural columns.
 * It neither edits generated terrain nor supplies preflowing water/plants.
 * relocate(name) is separately labeled paused positioning, never measured
 * movement or aim. It does not write yaw/pitch, targets, clocks or handlers.
 *
 * All other methods are bounded read-only observers. begin/end use an independent
 * rAF; no Game/World/FluidSystem/Player/render method is wrapped or replaced.
 * After real reload, reinstall with the returned manifest; DO NOT call prepare.
 */
export function installFluidPlayFixture({ config, manifest = null }) {
  const game = window.__voxelBot?.game;
  if (!game || window.__voxelFluidPlay)
    throw new Error("Expected a fresh realtime host without a fluid fixture");
  const { world, gameplay, player, fluidServices } = game;
  if (
    !fluidServices?.active ||
    game.fluids !== fluidServices.fluids ||
    typeof fluidServices.prepareKelpPlacement !== "function" ||
    typeof fluidServices.prepareSpongeAbsorption !== "function" ||
    typeof gameplay.prepareHandCost !== "function"
  )
    throw new Error("Frozen host lacks active fluid services/held-item APIs");
  const point = ({ x, y, z }) => ({ x, y, z });
  const clone = (value) => structuredClone(value);
  const abort = new AbortController();
  let fixture = manifest && clone(manifest);
  let prepared = Boolean(manifest);
  let relocations = 0;
  let observation = null;
  let animation = null;

  function current() {
    if (
      window.__voxelBot.game !== game ||
      game.world !== world ||
      game.player !== player ||
      game.gameplay !== gameplay ||
      game.fluidServices !== fluidServices ||
      !fluidServices.active ||
      game.fluids !== fluidServices.fluids ||
      game.failed ||
      gameplay.dead
    )
      throw new Error("Fluid fixture lost its real live owners");
  }

  function paused() {
    current();
    if (
      !game.paused ||
      game.active ||
      player.enabled ||
      game.overlayOpen ||
      game.building ||
      game.closingScreens ||
      observation
    )
      throw new Error(
        "End observation and pause before authored setup/readback"
      );
  }

  paused();
  if (
    fixture &&
    (fixture.seed !== world.seed ||
      fixture.generatorVersion !== world.generatorVersion ||
      fixture.dimension !== world.dimension)
  )
    throw new Error("Reload manifest belongs to a different world");

  const at = (x, y, z) => ({
    x: fixture.origin.x + x,
    y: fixture.origin.y + y,
    z: fixture.origin.z + z,
  });
  const cellAt = (position) =>
    world.getCell(position.x, position.y, position.z);
  const inside = (x, y, z) => {
    const { min, max } = fixture.bounds;
    return (
      x >= min.x &&
      x <= max.x &&
      y >= min.y &&
      y <= max.y &&
      z >= min.z &&
      z <= max.z
    );
  };

  function installLayout() {
    fixture.points = {
      source: at(0, 2, 0),
      lateral: at(1, 2, 0),
      lip: at(2, 2, 0),
      falling: at(2, 1, 0),
      sponge: at(3, 1, 0),
      end: at(4, 1, 0),
      partial: at(7, 1, 0),
      collision: at(7, 1, 3),
    };
    fixture.channel = [
      ...Array.from({ length: 5 }, (_, x) => at(x, 2, 0)),
      ...[2, 3, 4].map((x) => at(x, 1, 0)),
    ];
    const onWall = (x, floorY) => ({
      position: at(x + 0.5, 3, 1.15),
      aim: at(x + 0.5, floorY + 1, 0.5),
      hit: { ...at(x, floorY, 0), normal: { x: 0, y: 1, z: 0 } },
    });
    fixture.stances = {
      source: onWall(0, 1),
      lateral: onWall(1, 1),
      falling: onWall(2, 0),
      sponge: onWall(3, 0),
      end: onWall(4, 0),
      partial: {
        position: at(7.5, 1, 2.5),
        aim: at(7.5, 2, 0.5),
        hit: { ...at(7, 1, 0), normal: { x: 0, y: 1, z: 0 } },
      },
      collision: {
        position: at(7.5, 1, 3.5),
        aim: at(7.7, 1, 3.5),
        hit: { ...at(7, 0, 3), normal: { x: 0, y: 1, z: 0 } },
      },
    };
  }

  async function prepare() {
    paused();
    if (prepared)
      throw new Error("Fluid geometry/supplies may be authored once");
    prepared = true;
    if (world.dimension !== "overworld")
      throw new Error("This authored browser fixture requires the Overworld");
    const started = performance.now();
    let reads = 0;
    const read = (x, y, z) => {
      if (
        ++reads > config.limits.setupReads ||
        performance.now() - started > config.limits.setupMs
      )
        throw new Error(
          "Loaded-air fixture search exhausted its read/time bound"
        );
      const cell = world.getCell(x, y, z);
      if (!cell) throw new Error("Fixture requires already-loaded real cells");
      return cell;
    };
    const x0 = Math.floor(player.position.x);
    const z0 = Math.floor(player.position.z);
    let highest = world.minY;
    // Read the highest *non-air* cell, including leaves/plants, not a lucky flat
    // biome or a generator estimate. No ensureArea, generation or terrain clearing.
    for (let x = -2; x <= 9; x++)
      for (let z = -2; z <= 4; z++) {
        if (!world.isLoaded(x0 + x, z0 + z))
          throw new Error("The 12x7 authored footprint must already be loaded");
        for (let y = world.maxY - 1; y >= world.minY; y--)
          if (read(x0 + x, y, z0 + z).id !== config.ids.air) {
            highest = Math.max(highest, y);
            break;
          }
      }
    const y0 = highest + 1;
    if (y0 + 5 >= world.maxY)
      throw new Error(
        "Loaded natural location lacks six cells of air overhead"
      );
    fixture = {
      label: "authored-fluid-channel-not-natural-acquisition",
      provenance:
        "Paused real World/inventory transactions: dry 12x7 platform, enclosed two-level channel, dry top-slab basin; three water buckets, four kelp, one seagrass, one sponge, two stone. Paused relocations only; all aim/use/save inputs are real.",
      seed: world.seed,
      generatorVersion: world.generatorVersion,
      dimension: world.dimension,
      origin: { x: x0, y: y0, z: z0 },
      bounds: {
        min: { x: x0 - 2, y: y0, z: z0 - 2 },
        max: { x: x0 + 9, y: y0 + 5, z: z0 + 4 },
      },
      naturalColumns: 84,
      highestNaturalCell: highest,
    };
    installLayout();
    const cells = new Map();
    const put = (x, y, z, cell = config.cells.stone) =>
      cells.set(`${x},${y},${z}`, { ...at(x, y, z), after: clone(cell) });
    for (let x = -2; x <= 9; x++) for (let z = -2; z <= 4; z++) put(x, 0, z);
    put(4, 0, 0, config.cells.magma); // Real source water, invalid kelp support.
    for (let x = -1; x <= 5; x++)
      for (const z of [-1, 1]) for (const y of [1, 2]) put(x, y, z);
    for (const x of [-1, 5]) for (const y of [1, 2]) put(x, y, 0);
    for (const x of [0, 1]) put(x, 1, 0);
    for (const [x, z] of [
      [6, 0],
      [8, 0],
      [7, -1],
      [7, 1],
    ])
      put(x, 1, z);
    put(7, 1, 0, config.cells.partial);
    if (cells.size > config.limits.authoredCells)
      throw new Error("Authored geometry exceeded its cell cap");
    // Entire body/head/ray volume is clear before adding owned fixture geometry.
    for (let x = -2; x <= 9; x++)
      for (let z = -2; z <= 4; z++)
        for (let y = 0; y <= 5; y++)
          if (read(x0 + x, y0 + y, z0 + z).id !== config.ids.air)
            throw new Error(
              "Authoring must not erase any generated cell/owner"
            );
    const changes = [...cells.values()].map((change) => ({
      ...change,
      before: read(change.x, change.y, change.z),
    }));
    const terrain = world.prepareMutation(changes);
    const inventory = gameplay.prepareInventory((draft) => {
      draft.slots = Array(36).fill(null);
      config.supplies.forEach((stack, index) => {
        draft.slots[index] = clone(stack);
      });
      draft.offhand = null;
      draft.cursor = null;
      draft.equipment = { head: null, chest: null, legs: null, feet: null };
      draft.craftingGrid = Array(9).fill(null);
      draft.craftingSize = 2;
      return true;
    });
    if (
      !terrain ||
      !inventory ||
      !world.coordinator.commit([terrain, inventory]).ok
    )
      throw new Error("Real World/finite inventory setup transaction refused");
    if (!(await game.setMode("survival")) || gameplay.mode !== "survival")
      throw new Error(
        "Could not enter finite Survival mode through the real API"
      );
    paused();
    game.select(0);
    fixture.authoredCells = changes.length;
    fixture.setupReads = reads;
    fixture.setupMilliseconds = performance.now() - started;
    fixture.guardCells = changes
      .map(({ x, y, z, after }) => ({
        x,
        y,
        z,
        cell: after,
      }))
      .filter(({ x, y, z }) => {
        const p = fixture.points.partial;
        return x !== p.x || y !== p.y || z !== p.z;
      });
    // No renderer/update call: ordinary paused frames rebuild the real mesh.
    relocate("source");
    game.refreshHud();
    return clone(fixture);
  }

  function relocate(name) {
    paused();
    if (!fixture?.stances[name] || ++relocations > config.limits.relocations)
      throw new Error("Unknown/excessive authored stance");
    const stance = fixture.stances[name];
    player.setPosition(stance.position);
    return {
      label: `paused-authored-relocation-${name}`,
      position: point(player.position),
      aimWithRealControls: clone(stance.aim),
    };
  }

  function inventoryView(saved) {
    return clone({
      mode: saved.mode,
      selected: saved.selected,
      slots: saved.slots,
      offhand: saved.offhand,
      cursor: saved.cursor,
      equipment: saved.equipment,
      craftingGrid: saved.craftingGrid,
      craftingSize: saved.craftingSize,
    });
  }

  function ownership(inventory) {
    if (
      game.pickups.size > config.limits.looseRecords ||
      game.overflow.size > config.limits.looseRecords
    )
      throw new Error(
        "Unrelated loose ownership exceeded this observer's bound"
      );
    const pickups = game.pickups.serialize().items;
    const overflow = game.overflow.serialize().entries;
    if (pickups.length > config.limits.looseRecords)
      throw new Error("Pickup observation bound exceeded");
    const slots = [
      ...inventory.slots,
      inventory.offhand,
      inventory.cursor,
      ...inventory.craftingGrid,
      ...Object.values(inventory.equipment),
    ].filter(Boolean);
    const count = (records, id) =>
      records.reduce(
        (total, stack) => total + (stack.id === id ? stack.count : 0),
        0
      );
    return Object.fromEntries(
      ["kelp", "seagrass", "sponge", "bucket", "waterBucket"].map((name) => {
        const id = config.ids[name];
        const owned = {
          inventory: count(slots, id),
          pickups: count(pickups, id),
          overflow: count(overflow, id),
        };
        return [
          name,
          {
            ...owned,
            total: owned.inventory + owned.pickups + owned.overflow,
          },
        ];
      })
    );
  }

  function read() {
    current();
    const fluid = game.fluids.diagnostics();
    const renderer = game.graphics.renderer;
    const inventory = inventoryView(gameplay.serialize());
    const target = game.target;
    return {
      frame: renderer.info.render.frame,
      elapsed: game.elapsed,
      lastUse: game.useActions.lastUse,
      paused: game.paused,
      active: game.active,
      simulating: game.simulating,
      mode: gameplay.mode,
      selected: gameplay.selected,
      hand: gameplay.getHandStack("main"),
      handRevision: gameplay.getHandRevision("main"),
      offhand: gameplay.getHandStack("offhand"),
      hotbar: inventory.slots.slice(0, 9),
      ownership: ownership(inventory),
      health: gameplay.health,
      grounded: player.grounded,
      position: point(player.position),
      eye: point(player.eyePosition),
      yaw: player.yaw,
      pitch: player.pitch,
      forward: point(player.forward),
      inputMode: player.inputMode,
      sensitivity: player.mouseSensitivity,
      mobTarget: Boolean(game.mobTarget),
      target: target && {
        ...point(target),
        id: target.id,
        state: target.state,
        fluid: target.fluid,
        normal: point(target.normal),
      },
      targetCell: target && world.getCell(target.x, target.y, target.z),
      cells:
        fixture &&
        Object.fromEntries(
          Object.entries(fixture.points).map(([name, position]) => [
            name,
            cellAt(position),
          ])
        ),
      channel: fixture?.channel.map(cellAt) ?? [],
      fluid: {
        clock: fluid.clock,
        queued: fluid.queued,
        dirtySections: fluid.dirtySections,
        scans: fluid.scanJobs,
        limits: fluid.limits,
        last: fluid.last,
        total: fluid.total,
      },
      gpu: {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        contextLost: renderer.getContext().isContextLost(),
        badPrograms: renderer.info.programs.filter(
          (program) => program.diagnostics?.runnable === false
        ).length,
      },
    };
  }

  function volume() {
    current();
    const water = [];
    let reads = 0;
    const { min, max } = fixture.bounds;
    for (let x = min.x; x <= max.x; x++)
      for (let z = min.z; z <= max.z; z++)
        for (let y = min.y; y <= max.y; y++) {
          const cell = world.getCell(x, y, z);
          if (!cell) throw new Error("Authored inspection volume unloaded");
          reads++;
          if (cell.fluid !== config.fluid.NONE)
            water.push({ x, y, z, ...cell });
        }
    const guardsIntact = fixture.guardCells.every(({ x, y, z, cell }) => {
      const actual = world.getCell(x, y, z);
      return (
        actual &&
        ["id", "state", "fluid"].every((key) => actual[key] === cell[key])
      );
    });
    return { reads, water, guardsIntact };
  }

  function archiveView(snapshot) {
    if (
      !snapshot?.fluids ||
      snapshot.world.edits.length > config.limits.archiveEdits
    )
      throw new Error(
        "Missing fluid archive or excessive unrelated world edits"
      );
    return {
      inventory: inventoryView(snapshot.gameplay),
      world: {
        version: snapshot.world.version,
        seed: snapshot.world.seed,
        generatorVersion: snapshot.world.generatorVersion,
        dimension: snapshot.world.dimension,
        edits: snapshot.world.edits
          .filter(
            ([dimension, x, y, z]) =>
              dimension === fixture.dimension && inside(x, y, z)
          )
          .sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3]),
      },
      fluids: snapshot.fluids,
      pickups: snapshot.pickups,
      overflow: snapshot.overflow,
    };
  }

  function snapshot() {
    paused();
    if (world.edits.size > config.limits.archiveEdits)
      throw new Error("Archive inspection exceeds the fixture's edit bound");
    return archiveView(game.snapshot());
  }

  async function stored() {
    paused();
    const saved = await game.archive.storage.load();
    paused();
    return archiveView(saved);
  }

  function begin(label) {
    current();
    if (
      observation ||
      !fixture ||
      typeof label !== "string" ||
      label.length > 160
    )
      throw new Error("Begin one labeled fluid observation at a time");
    const initial = read();
    observation = {
      label,
      started: performance.now(),
      initial,
      last: initial,
      frames: 0,
      changes: [],
      inputs: [],
      error: null,
    };
    const signature = (state) =>
      JSON.stringify([state.cells, state.hotbar, state.ownership]);
    let previous = signature(initial);
    const observe = () => {
      if (!observation) return;
      if (
        performance.now() - observation.started > config.limits.observationMs ||
        observation.frames >= config.limits.observedFrames
      ) {
        observation.error = "Read-only fluid observation exhausted its bound";
        return;
      }
      try {
        const state = read();
        if (state.frame !== observation.last.frame) {
          observation.frames++;
          observation.last = state;
          const next = signature(state);
          if (next !== previous) {
            if (observation.changes.length >= config.limits.transitions)
              throw new Error("Fluid transition record limit exceeded");
            observation.changes.push({
              frame: state.frame,
              clock: state.fluid.clock,
              cells: state.cells,
              hotbar: state.hotbar,
              ownership: state.ownership,
            });
            previous = next;
          }
          if (
            !state.paused &&
            (!state.gpu.calls || state.gpu.contextLost || state.gpu.badPrograms)
          )
            throw new Error("Real WebGL rendering failed during fluid play");
        }
        animation = requestAnimationFrame(observe);
      } catch (error) {
        observation.error = error.stack ?? String(error);
      }
    };
    animation = requestAnimationFrame(observe);
  }

  const observations = () => observation && clone(observation);
  function end() {
    cancelAnimationFrame(animation);
    animation = null;
    const result = observation && { ...observations(), current: read() };
    observation = null;
    return result;
  }

  for (const type of ["keydown", "keyup", "mousedown", "mouseup"])
    window.addEventListener(
      type,
      (event) => {
        if (!observation) return;
        if (observation.inputs.length >= config.limits.inputs) {
          observation.error = "Fluid input observation limit exceeded";
          return;
        }
        observation.inputs.push({
          type,
          code: event.code ?? null,
          button: event.button ?? null,
          trusted: event.isTrusted,
          frame: game.graphics.renderer.info.render.frame,
        });
      },
      { capture: true, passive: true, signal: abort.signal }
    );

  window.__voxelFluidPlay = {
    prepare,
    relocate,
    read,
    volume,
    snapshot,
    stored,
    begin,
    observations,
    end,
    get manifest() {
      return clone(fixture);
    },
    get error() {
      return observation?.error ?? null;
    },
    dispose() {
      cancelAnimationFrame(animation);
      abort.abort();
      observation = null;
      delete window.__voxelFluidPlay;
    },
  };
}
