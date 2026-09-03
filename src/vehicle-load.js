import { captureEntityContext } from "./entity-context.js";

/** Derived from validated records; membership changes, never motion, update it. */
export function vehicleDimensionCounts(records = []) {
  const counts = { overworld: 0, nether: 0, end: 0 };
  for (const record of records) counts[record.dimension]++;
  return counts;
}

export function vehicleDimensionsAfter(counts, before, after) {
  if (before?.dimension === after?.dimension) return counts;
  const next = { ...counts };
  if (before) next[before.dimension]--;
  if (after) next[after.dimension]++;
  return next;
}

/**
 * Snapshot installation is a prepared participant, including for a two-leaf
 * staged load. Neither render work nor observers belong in its publication.
 */
export function prepareVehicleSnapshot(owner, values, afterBytes) {
  if (!owner._ready(true) || owner._updating) return null;
  const revision = owner._revision,
    beforeBytes = owner._bytes;
  const coordinator = owner.coordinator,
    world = owner.world;
  const before = Object.entries(values).map(([key]) => [key, owner[key]]);
  const current = captureEntityContext(world, owner.context);
  let used = false;
  return Object.freeze({
    owner,
    beforeBytes,
    afterBytes,
    validate: () =>
      !used &&
      owner._ready(true) &&
      !owner._updating &&
      owner._revision === revision &&
      owner._bytes === beforeBytes &&
      owner.world === world &&
      owner.coordinator === coordinator &&
      coordinator.usage(owner) === beforeBytes &&
      current() &&
      before.every(([key, value]) => owner[key] === value),
    publish: () => {
      used = true;
      Object.assign(owner, values);
      owner._bytes = afterBytes;
      owner._revision++;
    },
  });
}

/**
 * Only already-normalized archive loads may use allowOverBudget. A temporary
 * staging reservation funds the aggregate increase, then relinquishes it in
 * the SAME commit as every snapshot installs. A rejected participant changes
 * no leaf; finally releases the unused staging reservation. Ordinary actions
 * never enter this path or acquire this exception.
 */
export function commitVehicleSnapshots(
  coordinator,
  participants,
  allowOverBudget = false
) {
  if (typeof allowOverBudget !== "boolean") return false;
  const increase = participants.reduce(
    (sum, participant) =>
      sum + participant.afterBytes - participant.beforeBytes,
    0
  );
  if (!allowOverBudget || increase <= 0)
    return coordinator.commit(participants).ok;
  const staging = {};
  if (!coordinator.register(staging, increase, { allowOverBudget: true }))
    return false;
  let used = false;
  try {
    return coordinator.commit([
      ...participants,
      {
        owner: staging,
        beforeBytes: increase,
        afterBytes: 0,
        validate: () => !used && coordinator.usage(staging) === increase,
        publish: () => {
          used = true;
        },
      },
    ]).ok;
  } finally {
    coordinator.release(staging);
  }
}
