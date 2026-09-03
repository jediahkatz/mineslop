import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import {
  cloneSlots,
  cloneStack,
  insertStack,
  isValidStack,
} from "../src/inventory-slots.js";
import { Pickups } from "../src/pickups.js";
import { encodedBytes } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";

export const DROP_POSITION = Object.freeze({ x: 0.5, y: 1.14, z: 0.5 });
export const STILL_MOTION = Object.freeze({ x: 0, y: 0, z: 0 });

/** Historical loaded-cell fixture, not a fabricated terrain generator. */
export function metadataWorld() {
  return {
    ...createWorldContext({
      seed: "metadata-transfer-fixture",
      generatorVersion: 3,
    }),
    spec: getWorldSpec(3, "overworld"),
    dimension: "overworld",
    epoch: 0,
    loaded: true,
    isLoaded() {
      return this.loaded;
    },
    isSolid(_x, y) {
      return y === 0;
    },
    get(_x, y) {
      return y === 0 ? BLOCK.STONE : BLOCK.AIR;
    },
    getCell(x, y, z) {
      return this.isLoaded(x, z)
        ? { id: this.get(x, y, z), state: 0, fluid: 0 }
        : null;
    },
  };
}

export function pickupFixture(t, options = {}) {
  const world = metadataWorld();
  const coordinator = options.coordinator ?? new TransactionCoordinator();
  const pickups = new Pickups(new THREE.Scene(), world, {
    ...options,
    coordinator,
  });
  t.after(() => pickups.dispose());
  return { world, pickups, coordinator };
}

/**
 * Test-only ownership participant for isolated protocol tests. The production
 * Gameplay bridge is covered separately by gameplay-prepared/pickups tests.
 */
export class PreparedInventoryFixture {
  constructor(coordinator, slots = Array(36).fill(null)) {
    this.coordinator = coordinator;
    this.slots = cloneSlots(slots);
    this.revision = 0;
    this.notifications = 0;
    if (!coordinator.register(this, encodedBytes(this.slots)))
      throw new Error("Fixture reservation failed");
  }

  prepare(edit, { valid = () => true } = {}) {
    const next = cloneSlots(this.slots);
    if (edit(next) !== true) return null;
    const revision = this.revision;
    const beforeBytes = this.coordinator.usage(this);
    const afterBytes = encodedBytes(next);
    let used = false;
    return {
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () => !used && this.revision === revision && valid(),
      publish: () => {
        used = true;
        this.slots = next;
        this.revision++;
      },
      notify: () => {
        this.notifications++;
      },
    };
  }

  prepareAddStack(stack) {
    if (!isValidStack(stack)) return null;
    const detached = cloneStack(stack);
    return this.prepare((slots) => insertStack(slots, detached) === null);
  }
}
