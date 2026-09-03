import { normalizeCell } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { MOB_SPECIES } from "../src/mob-species.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";

export const entityContext = (generatorVersion = 4) =>
  createWorldContext({ seed: "entity-context-fixture", generatorVersion });

/** Authored scalar geometry only, not a natural terrain generator. */
export function entityWorld({
  generatorVersion = 4,
  dimension = "overworld",
  floor,
  waterTop = -Infinity,
  coordinator = new TransactionCoordinator(),
} = {}) {
  const context = entityContext(generatorVersion);
  return {
    ...context,
    context,
    coordinator,
    dimension,
    epoch: 1,
    loaded: () => true,
    floor: floor ?? context.specForDimension(dimension).minY,
    get spec() {
      return context.specForDimension(this.dimension);
    },
    isLoaded(x, z) {
      return this.loaded(x, z);
    },
    surfaceYAt() {
      return this.floor;
    },
    heightAt() {
      return this.floor;
    },
    getBiome() {
      return { id: this.dimension === "nether" ? "nether_wastes" : "plains" };
    },
    getCell(x, y, z) {
      if (y < this.spec.minY || y >= this.spec.maxY || !this.isLoaded(x, z))
        return null;
      const id =
        y <= this.floor ? BLOCK.STONE : y <= waterTop ? BLOCK.WATER : BLOCK.AIR;
      return normalizeCell({ id });
    },
    get(x, y, z) {
      return this.getCell(x, y, z)?.id ?? BLOCK.AIR;
    },
  };
}

export function mobRecord(context, dimension = "overworld", overrides = {}) {
  const kind =
    dimension === "overworld"
      ? "sheep"
      : dimension === "nether"
        ? "piglin"
        : "enderman";
  return {
    id: `${dimension}:local:0`,
    kind,
    position: {
      x: 2.5,
      y: context.specForDimension(dimension).minY + 9,
      z: 2.5,
    },
    health: MOB_SPECIES[kind].health,
    yaw: 0.25,
    tamed: false,
    angry: 0,
    attackCooldown: 0.5,
    fuse: 0,
    pacified: 0,
    ...overrides,
  };
}

export function mobSnapshot(context, dimension = "overworld", entities) {
  return {
    version: 1,
    seed: String(context.seed),
    dimension,
    randomState: 0xffffffff,
    nextId: 1,
    killed: [],
    entities: entities ?? [mobRecord(context, dimension)],
  };
}
