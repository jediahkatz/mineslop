import assert from "node:assert/strict";
import { cloneSlots, insertStack } from "../src/inventory-slots.js";
import { getLootTable } from "../src/loot-tables.js";
import { progressPositionKey } from "../src/progression-common.js";
import { encodedBytes } from "../src/save-budget.js";
import { createWorldContext } from "../src/world-spec.js";

export const progressionContext = (seed = "authored-progression-fixture") =>
  createWorldContext({ seed, generatorVersion: 4 });

export function structureMarker(role = "shipwreck_supply", options = {}) {
  const type = options.type ?? "container";
  const structureId = options.structureId ?? "fixture:structure-0";
  const key = options.key ?? role;
  return {
    id: `${structureId}/${type}/${key}`,
    structureId,
    type,
    key,
    role,
    dimension:
      options.dimension ?? getLootTable(role)?.dimension ?? "overworld",
    position: { x: 8, y: 64, z: -8, ...options.position },
  };
}

export function veto(coordinator, validate = () => false) {
  const owner = {};
  assert.equal(coordinator.register(owner), true);
  return {
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    validate,
    publish() {
      assert.fail("vetoed fixture publication");
    },
  };
}

/**
 * Protocol-only destination for the leaf ledger's authored unit tests.
 * Real World/Settlement/Gameplay/DropOverflow integration lives in
 * exploration-services-fixture.js. No Trading import belongs in this closure.
 */
export class ExplorationDestination {
  constructor(coordinator, context) {
    this.coordinator = coordinator;
    this.context = context;
    this.containers = new Map();
    this.retained = [];
    this.revision = 0;
    this.bytes = 0;
    this.available = true;
    this.refuse = false;
    this.received = [];
    coordinator.register(this);
  }

  view() {
    return structuredClone({
      containers: [...this.containers],
      retained: this.retained,
      revision: this.revision,
    });
  }

  prepare(claims) {
    this.received.push(structuredClone(claims));
    if (this.refuse) return null;
    const containers = new Map(
      [...this.containers].map(([key, slots]) => [
        key,
        cloneSlots(slots, this.context),
      ])
    );
    const retained = cloneSlots(this.retained, this.context);
    for (const claim of claims) {
      const key = progressPositionKey(claim.marker);
      if (claim.firstClaim && containers.has(key)) return null;
      if (claim.action === "open") {
        const slots = Array(27).fill(null);
        for (const stack of claim.stacks)
          if (insertStack(slots, stack)) return null;
        containers.set(key, slots);
      } else if (claim.action === "break") {
        retained.push(
          ...cloneSlots(
            containers.get(key)?.filter(Boolean) ?? [],
            this.context
          )
        );
        retained.push(...cloneSlots(claim.stacks, this.context));
        containers.delete(key);
      } else {
        if (!containers.has(key)) return null;
        retained.push(
          ...cloneSlots(containers.get(key).filter(Boolean), this.context)
        );
        containers.set(key, Array(27).fill(null));
      }
    }
    const beforeBytes = this.bytes;
    const afterBytes = encodedBytes({ containers: [...containers], retained });
    const revision = this.revision;
    let used = false;
    return {
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () => !used && this.available && this.revision === revision,
      publish: () => {
        used = true;
        this.containers = containers;
        this.retained = retained;
        this.bytes = afterBytes;
        this.revision++;
      },
    };
  }
}
