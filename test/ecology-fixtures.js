import { BLOCK } from "../src/blocks.js";
import { defaultFluidFor, FLUID, normalizeCell } from "../src/block-state.js";
import {
  createEcologyState,
  ECOLOGY_SPECIES,
  ExpansionEcology,
} from "../src/expansion-ecology.js";
import { encodedBytes } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";

/** Deliberately only admitted cells. Generation/top/biome APIs throw: these
 * fixtures exercise CPU decisions and ownership, not natural spawning or GPU.
 */
export function ecologyWorld({
  dimension = "overworld",
  water = () => 6,
  ground = () => 0,
  loaded = () => true,
} = {}) {
  const context = createWorldContext({ seed: "ecology-fixture", generatorVersion: 4 });
  const edits = new Map();
  const world = {
    ...context, dimension, spec: context.specForDimension(dimension),
    epoch: 1, _editRevision: 0, reads: 0, unloadedReads: 0,
    isLoaded: loaded,
    getCell(x, y, z) {
      if (!this.isLoaded(x, z)) {
        this.unloadedReads++;
        throw new Error("AI read an unloaded cell");
      }
      this.reads++;
      const override = edits.get(`${x},${y},${z}`);
      if (override) return { ...override };
      const id = y <= ground(x, z) ? BLOCK.SAND : y <= water(x, z) ? BLOCK.WATER : BLOCK.AIR;
      return { id, state: 0, fluid: defaultFluidFor(id) };
    },
    setCell(x, y, z, value) {
      edits.set(`${x},${y},${z}`, normalizeCell(value));
      this._editRevision++;
    },
    heightAt() { throw new Error("AI generated a terrain height"); },
    surfaceYAt() { throw new Error("AI queried a terrain surface"); },
    getBiome() { throw new Error("AI generated biome metadata"); },
  };
  return world;
}

export function ecologyMob(kind, id, position) {
  const root = { rotation: { y: 0 }, position: { ...position } };
  return {
    kind, id, spec: ECOLOGY_SPECIES[kind], name: ECOLOGY_SPECIES[kind].name,
    health: ECOLOGY_SPECIES[kind].health, root, position: root.position,
    groundY: position.y, dead: false, dormant: false, fleeTime: 0,
  };
}

export function ecologyState(world, kind, id, position, extra = {}) {
  return {
    ...createEcologyState(kind, id, position, world, {
      structureId: extra.structureId ?? "monument-fixture",
      homeBeach: extra.homeBeach, baby: extra.baby,
    }),
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "baby")),
  };
}

export function ecologyFixture({ world = ecologyWorld(), entries = [], eggs = [], elders = [] } = {}) {
  const coordinator = new TransactionCoordinator();
  const mobs = new Map(entries.filter((state) => state.alive).map((state) => [
    state.id, ecologyMob(state.kind, state.id, state.home),
  ]));
  const structures = new Map(), markers = new Map(), effects = [], damage = [], beams = [], hurt = [];
  const owner = new ExpansionEcology({
    context: world, coordinator,
    snapshot: { version: 1, seed: world.seed, generatorVersion: 4, entries, eggs, elders },
  });
  coordinator.register(owner, owner.reservedBytes);
  const ctx = {
    world, worldContext: world, dimension: world.dimension,
    player: { x: 2, y: 2, z: 0 }, playerEye: { x: 2, y: 3.62, z: 0 },
    playerTargetKey: "player:life:1", playerSwimming: true,
    health: 20, mode: "survival", timeOfDay: 0, spawnProtected: false,
    biomeId: "ocean", blockLight: 0, skyLight: 0,
    getMob: (id) => mobs.get(id),
    getStructure: (id) => structures.get(id),
    getMarker: (id) => markers.get(id),
    nearbyStructures: () => [...structures.values()],
    applyEffect: (effect) => { effects.push(effect); return true; },
    damagePlayer: (...args) => { damage.push(args); },
    hurt: (...args) => { hurt.push(args); },
    onBeam: (mob, event) => { beams.push({ id: mob.id, ...event }); return true; },
  };
  return { world, owner, coordinator, ctx, mobs, structures, markers, effects, damage, beams, hurt };
}

/** Real coordinator participants, fake sinks only. Publication installs a
 * detached value; validators model stock/hand/capacity refusal without side effects.
 */
export function ecologyStore(coordinator, initial) {
  const store = {
    value: structuredClone(initial), revision: 0,
    prepare(edit, validate = () => true) {
      const value = structuredClone(this.value);
      if (edit(value) === false) return null;
      const revision = this.revision, previous = this.value;
      const beforeBytes = coordinator.usage(this), afterBytes = encodedBytes(value);
      let used = false;
      return {
        owner: this, beforeBytes, afterBytes,
        validate: () => !used && this.revision === revision && this.value === previous && validate() === true,
        publish: () => { used = true; this.value = value; this.revision++; },
      };
    },
  };
  coordinator.register(store, encodedBytes(store.value));
  return store;
}

export function feedHook(store) {
  return (name, count) => store.prepare((draft) => {
    if ((draft[name] ?? 0) < count) return false;
    draft[name] -= count;
  });
}

export function monumentFixture() {
  const structure = {
    id: "monument-fixture", kind: "ocean_monument", dimension: "overworld",
    origin: { x: 0, y: 1, z: 0 },
    bounds: { minX: -18, minY: 1, minZ: -16, maxX: 19, maxY: 10, maxZ: 17 },
  };
  const markers = [
    ["elder_west", -7, 2, "west_wing"],
    ["elder_east", 7, 2, "east_wing"],
    ["elder_crown", 0, 4, "crown"],
  ].map(([key, x, y, role]) => ({
    type: "encounter", key, role, id: `${structure.id}/encounter/${key}`,
    structureId: structure.id, dimension: "overworld", entity: "elder_guardian",
    unique: true, position: { x, y, z: 0 },
    bounds: { minX: x - 2, maxX: x + 3, minY: y, maxY: y + 3, minZ: -3, maxZ: 4 },
  }));
  return { structure, markers };
}

export function solidWall(world, x, low = 1, high = 8) {
  for (let y = low; y <= high; y++)
    for (let z = -5; z <= 5; z++)
      world.setCell(x, y, z, { id: BLOCK.STONE, state: 0, fluid: FLUID.NONE });
}
