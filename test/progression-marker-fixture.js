import assert from "node:assert/strict";
import { ExplorationState } from "../src/exploration-state.js";
import {
  describeStructure,
  resolveStructureMapTarget,
  STRUCTURE_LIMITS,
} from "../src/structure-catalog.js";
import { encodedBytes } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";
import { authoredColumn, authoredContext } from "./structure-fixtures.js";

// Real describeStructure()/marker output over explicitly AUTHORED column fields.
// These fixtures test catalog contracts, not natural discovery or NPC interaction.
export function catalogDescriptor(kind, terrainContext, matches = () => true) {
  for (let gz = -8; gz < 8; gz++) {
    for (let gx = -8; gx < 8; gx++) {
      const descriptor = describeStructure(kind, terrainContext, gx, gz);
      if (descriptor && matches(descriptor)) return descriptor;
    }
  }
  assert.fail(`Bounded authored catalog search did not select ${kind}`);
}

export function catalogFixture(
  kind,
  {
    seed = "progression-catalog-fixture",
    column = authoredColumn(kind),
    matches,
  } = {}
) {
  const { context: terrainContext, calls } = authoredContext(
    kind,
    seed,
    column
  );
  return {
    descriptor: catalogDescriptor(kind, terrainContext, matches),
    terrainContext,
    calls,
    column,
    context: createWorldContext({ seed, generatorVersion: 4 }),
  };
}

export function catalogRoleFixtures() {
  return [
    catalogFixture("shipwreck", { matches: (d) => d.plan.damage === "whole" }),
    catalogFixture("ocean_ruin", { matches: (d) => d.plan.annex }),
    catalogFixture("ocean_ruin", {
      seed: "progression-catalog-cold",
      column: authoredColumn("ocean_ruin", {
        id: "cold_ocean",
        temperature: 0.2,
      }),
      matches: (d) => d.plan.annex,
    }),
    catalogFixture("buried_treasure"),
    catalogFixture("village"),
    catalogFixture("nether_fortress"),
    catalogFixture("bastion_remnant", {
      matches: (d) => d.variant === "bridge_keep",
    }),
    catalogFixture("dungeon"),
  ];
}

/** One consistent authored world: source owner cell surrounded by real beach sites. */
export function catalogMapSearch(fixture, marker) {
  const beach = authoredColumn("buried_treasure");
  const terrainContext = {
    ...fixture.terrainContext,
    sampleColumn(x, z) {
      return Math.floor(x / STRUCTURE_LIMITS.spacing) ===
        fixture.descriptor.gx &&
        Math.floor(z / STRUCTURE_LIMITS.spacing) === fixture.descriptor.gz
        ? fixture.terrainContext.sampleColumn(x, z)
        : beach;
    },
    generateChunk() {
      assert.fail("Map projection/search must not generate chunks");
    },
  };
  return {
    terrainContext,
    result: resolveStructureMapTarget(marker.mapTarget, terrainContext),
  };
}

/**
 * Deliberately empty entitlement + bounded prepared-destination fixture, NOT
 * inventory/Settlement integration. Real default-table tests use registered
 * canonical stacks separately and never substitute this empty roller.
 */
export function emptyClaimFixture(context) {
  const coordinator = new TransactionCoordinator();
  const rolls = [];
  const ledger = new ExplorationState({
    context,
    coordinator,
    rollLoot(marker, _context, options) {
      rolls.push(structuredClone({ marker, options }));
      return [];
    },
  });
  const destination = { claims: [], bytes: 0, revision: 0 };
  assert.equal(coordinator.register(destination), true);
  const prepareDestination = (claims) => {
    const next = structuredClone(claims);
    const beforeBytes = destination.bytes;
    const afterBytes = encodedBytes(next);
    const revision = destination.revision;
    return {
      owner: destination,
      beforeBytes,
      afterBytes,
      validate: () => destination.revision === revision,
      publish() {
        destination.claims = next;
        destination.bytes = afterBytes;
        destination.revision++;
      },
    };
  };
  return {
    ledger,
    coordinator,
    destination,
    rolls,
    options: { prepareDestination, validate: () => true },
  };
}
