import { cellAfterBreaking } from "./block-state.js";
import {
  mapResolutionFromStructure,
  selectTreasureMapTarget,
} from "./exploration-markers.js";
import { MAX_EXPLORATION_BATCH } from "./exploration-state.js";
import { nativeExplorationContext } from "./exploration-host-state.js";
import { cloneStack } from "./inventory-slots.js";
import { lootNeedsMap } from "./loot-tables.js";
import {
  composeProgressionPlan,
  freezeProgressData,
  progressArray,
  progressPositionKey,
  synchronousProgressCallback,
} from "./progression-common.js";
import { normalizeProgressStack } from "./progression-items.js";
import { resolveStructureMapTarget } from "./structure-catalog.js";

export const explorationRefused = (reason) => ({
  handled: true,
  ok: false,
  reason,
});
export const explorationOrdinary = () => ({ handled: false, ok: true });
const sameMarker = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const center = (hit) => ({ x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });

/** A successful bounded absence is cached too; committed claims never search. */
function mapTarget(service, entry) {
  if (!lootNeedsMap(entry.marker.role)) return undefined;
  if (entry.mapResolution === undefined) {
    const resolution = mapResolutionFromStructure(
      resolveStructureMapTarget(
        entry.declaration.mapTarget,
        nativeExplorationContext(service.world)
      ),
      service.context
    );
    entry.mapResolution = freezeProgressData({
      ...resolution,
      mapTarget:
        resolution.target === null
          ? null
          : selectTreasureMapTarget(
              entry.marker,
              [resolution.target],
              service.context
            ),
    });
    service._mapSearches++;
  }
  return entry.mapResolution.mapTarget;
}

function inspect(service, hit) {
  const { world, settlement, index, exploration } = service;
  if (
    !hit ||
    ![hit.x, hit.y, hit.z].every(Number.isSafeInteger) ||
    (hit.world !== undefined && hit.world !== world) ||
    (hit.dimension !== undefined && hit.dimension !== world.dimension)
  )
    return null;
  const station = settlement.inspectContainer(world, hit);
  if (
    !station ||
    (hit.state !== undefined && station.before.state !== hit.state) ||
    (hit.fluid !== undefined && station.before.fluid !== hit.fluid)
  )
    return null;
  if (station.kind !== "chest" || world.generatorVersion !== 4)
    return { hit, station, entry: null, claim: null };
  if (!index.ensure(hit)) return null;
  const lookup = index.lookup(hit);
  if (lookup.status === "pending") return null;
  const entry = lookup.entry?.marker.type === "container" ? lookup.entry : null;
  const claim = exploration.containerAt(world.dimension, {
    x: hit.x,
    y: hit.y,
    z: hit.z,
  });
  if (claim && (!entry || !sameMarker(claim.marker, entry.marker))) return null;
  return { hit, station, entry, claim };
}

function adoptedState(station) {
  return station.slots.some(Boolean) ? "materialized" : "cleared";
}

function requestFor(service, source, action) {
  const { entry, claim, station } = source;
  if (!entry || claim?.state === "destroyed") return null;
  const marker = entry.marker;
  if (claim) {
    if (action === "open" || (action === "clear" && claim.state === "cleared"))
      return null;
    return { marker, action, firstClaim: false };
  }
  if (station.initialized || !service.index.eligible(entry))
    return {
      marker,
      action: "adopt",
      firstClaim: true,
      state:
        action === "break"
          ? "destroyed"
          : action === "clear"
            ? "cleared"
            : adoptedState(station),
    };
  const target = mapTarget(service, entry);
  return {
    marker,
    action,
    firstClaim: true,
    ...(target === undefined ? {} : { mapTarget: target }),
  };
}

function composed(
  service,
  claims,
  prepareDestination,
  guard,
  result,
  participants = []
) {
  let plan;
  if (claims.length) {
    plan = service.exploration.prepareContainers(claims, {
      validate: guard,
      prepareDestination,
      participants,
    });
  } else {
    const destination = prepareDestination([]);
    if (!destination?.participants?.length) return null;
    const peers = [...destination.participants, ...participants];
    plan = composeProgressionPlan(service, peers[0], peers.slice(1), {
      ok: true,
    });
  }
  if (!plan) return null;
  return service._guardPlan(plan, guard, result());
}

/** First-open owns ledger + actual slots together. No public lazy getter runs. */
export function prepareExplorationOpen(service, hit, options = {}) {
  const source = inspect(service, hit);
  if (!source) return explorationRefused("exploration-admission-pending");
  if (!source.entry) return explorationOrdinary();
  const { station, claim, entry } = source;
  if (claim && claim.state !== "destroyed" && !station.initialized)
    return explorationRefused("claimed-container-ownership-missing");
  const participants = options.participants ?? [];
  if (!Array.isArray(participants))
    return explorationRefused("invalid-open-participants");
  const guard = service._captureGuard([entry], options.validate);
  const request = requestFor(service, source, "open");
  let installation;
  const plan = composed(
    service,
    request ? [request] : [],
    (claims) => {
      installation = service.settlement.prepareContainers(
        service.world,
        [
          {
            hit,
            action: station.initialized ? "adopt" : "initialize",
            expectedInitialized: station.initialized,
            ...(station.initialized ? {} : { stacks: claims[0]?.stacks ?? [] }),
          },
        ],
        { validate: guard }
      );
      return installation;
    },
    guard,
    () => ({
      ok: true,
      opened: true,
      adopted: request?.action === "adopt",
      containerId: entry.marker.id,
      mapTarget:
        claim?.mapTarget ??
        (request?.mapTarget === undefined ? null : request.mapTarget),
    }),
    participants
  );
  return plan ?? explorationRefused("container-materialization-refused");
}

function retainedParticipant(service, entries, prepareDrops) {
  const prepared =
    prepareDrops === undefined
      ? service.overflow.prepareAddBatch(entries)
      : synchronousProgressCallback(prepareDrops)
        ? prepareDrops(structuredClone(entries))
        : null;
  // A single real retained destination; no callback receipts or duplicate sink.
  return prepared?.owner === service.overflow ? prepared : null;
}

/**
 * A bounded all-or-nothing container batch. The caller passes the ACTUAL block
 * drops and its already-prepared Gameplay cost. No second Gameplay, Settlement,
 * World or overflow participant may be appended for these same removals.
 * prepareDrops receives positioned entries, once, even for an empty batch.
 */
export function prepareExplorationBreakBatch(
  service,
  requests,
  {
    explosion = false,
    participants = [],
    prepareDrops,
    prepareExperience,
    validate,
  } = {}
) {
  progressArray(requests, MAX_EXPLORATION_BATCH);
  if (
    !requests.length ||
    typeof explosion !== "boolean" ||
    !Array.isArray(participants) ||
    (!explosion &&
      (requests.length !== 1 ||
        !participants.some(({ owner }) => owner === service.gameplay))) ||
    (prepareDrops !== undefined &&
      !synchronousProgressCallback(prepareDrops)) ||
    (prepareExperience !== undefined &&
      !synchronousProgressCallback(prepareExperience))
  )
    return explorationRefused("invalid-container-break-ownership");
  const sources = requests.map(({ hit, drops }) => {
    const source = inspect(service, hit);
    return (
      source && {
        ...source,
        drops: progressArray(drops, 27).map((stack) =>
          normalizeProgressStack(stack, service.context)
        ),
      }
    );
  });
  if (sources.some((source) => !source))
    return explorationRefused("exploration-admission-pending");
  if (!sources.some(({ entry }) => entry)) return explorationOrdinary();
  const positions = sources.map(({ hit }) =>
    progressPositionKey({ dimension: service.world.dimension, position: hit })
  );
  if (new Set(positions).size !== positions.length)
    return explorationRefused("duplicate-container-break");
  if (
    sources.some(
      ({ claim, station }) =>
        claim && claim.state !== "destroyed" && !station.initialized
    )
  )
    return explorationRefused("claimed-container-ownership-missing");
  const guard = service._captureGuard(
    sources.map(({ entry }) => entry).filter(Boolean),
    validate
  );
  const claims = sources
    .map((source) => requestFor(service, source, "break"))
    .filter(Boolean);
  let drops = [];
  let experience = 0;
  const plan = composed(
    service,
    claims,
    (rolls) => {
      const loot = new Map(rolls.map((roll) => [roll.marker.id, roll.stacks]));
      const stations = service.settlement.prepareContainers(
        service.world,
        sources.map(({ hit, station }) => ({
          hit,
          action: "remove",
          expectedInitialized: station.initialized,
        })),
        { validate: guard }
      );
      if (!stations) return null;
      const entries = [];
      const rewards = [];
      const changes = stations.result.records.map((record, index) => {
        const source = sources[index];
        const position = center(source.hit);
        const stacks = [
          ...source.drops,
          ...record.drops,
          ...(loot.get(source.entry?.marker.id) ?? []),
        ];
        for (const stack of stacks)
          entries.push({
            ...cloneStack(stack, service.context),
            ...position,
            dimension: service.world.dimension,
          });
        if (record.experience)
          rewards.push({ amount: record.experience, position });
        return {
          x: source.hit.x,
          y: source.hit.y,
          z: source.hit.z,
          before: record.before,
          after: cellAfterBreaking(record.before),
        };
      });
      const mutation = service.world.prepareMutation(changes);
      const retained = retainedParticipant(service, entries, prepareDrops);
      if (!mutation || !retained) return null;
      const prepared = [...stations.participants, mutation, retained];
      experience = rewards.reduce((sum, reward) => sum + reward.amount, 0);
      if (experience) {
        // Explicit refusal never falls back to a second Gameplay participant.
        const reward = prepareExperience?.(
          experience,
          structuredClone(rewards)
        );
        if (!reward || reward.owner === service.gameplay) return null;
        prepared.push(reward);
      }
      drops = entries.map((entry) => cloneStack(entry, service.context));
      return { participants: prepared };
    },
    guard,
    () => ({
      ok: true,
      drops,
      experience,
      containers: sources.length,
      dropsCommitted: true,
      experienceCommitted: true,
    }),
    participants
  );
  return plan ?? explorationRefused("container-break-refused");
}

/** Clearing is a debit + retained destination + permanent empty claim, not a reset. */
export function prepareExplorationClear(
  service,
  hit,
  { participants = [], prepareDrops, validate } = {}
) {
  const source = inspect(service, hit);
  if (!source) return explorationRefused("exploration-admission-pending");
  if (!source.entry) return explorationOrdinary();
  if (!source.station.initialized || source.station.kind !== "chest")
    return explorationRefused("container-not-initialized");
  const guard = service._captureGuard([source.entry], validate);
  const claim = requestFor(service, source, "clear");
  let drops = [];
  const plan = composed(
    service,
    claim ? [claim] : [],
    () => {
      const stations = service.settlement.prepareContainers(
        service.world,
        [
          {
            hit,
            action: "clear",
            expectedInitialized: true,
          },
        ],
        { validate: guard }
      );
      if (!stations) return null;
      drops = stations.result.records[0].drops;
      const retained = retainedParticipant(
        service,
        drops.map((stack) => ({
          ...stack,
          ...center(hit),
          dimension: service.world.dimension,
        })),
        prepareDrops
      );
      return retained
        ? { participants: [...stations.participants, retained] }
        : null;
    },
    guard,
    () => ({
      ok: true,
      cleared: true,
      drops,
      dropsCommitted: true,
    }),
    participants
  );
  return plan ?? explorationRefused("container-clear-refused");
}
