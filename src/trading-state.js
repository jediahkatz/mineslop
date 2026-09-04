import {
  progressArray,
  progressId,
  progressPosition,
  progressPositionKey,
  progressRecord,
  synchronousProgressCallback,
} from "./progression-common.js";
import {
  MAX_STRUCTURE_MEMBER_ID_LENGTH, parseStructureIdentity,
} from "./canonical-structure-identity.js";
import { normalizeProgressionContext } from "./progression-context.js";
import { encodedBytes } from "./save-budget.js";
import {
  MAX_DAILY_RESTOCKS,
  normalizeTradeClock,
  RESTOCK_WORK_END,
  RESTOCK_WORK_START,
} from "./trading-calendar.js";
import {
  generateTraderOffers,
  MAX_TRADE_OFFERS,
  normalizeTradeOffer,
  TRADE_OFFER_VERSION,
  traderLevel,
  TRADING_JOBSITES,
  TRADING_PROFESSIONS,
} from "./trading-offers.js";

export {
  advanceTraderCalendar,
  MAX_DAILY_RESTOCKS,
  MAX_WORLD_DAY,
  normalizeTradeClock,
  RESTOCK_WORK_END,
  RESTOCK_WORK_START,
} from "./trading-calendar.js";

export const TRADING_VERSION = 1;
export const MAX_TRADERS = 16384;
export const MAX_TRADER_RECORD_BYTES = 16 * 1024;

/** Keep full authored marker IDs, including their encoded seed, without hashes. */
export function traderJobsiteId(value, dimension, context) {
  if (typeof value !== "string" || !value.startsWith("structure:"))
    return progressId(value);
  const separator = value.lastIndexOf("/job_site/");
  if (separator < 0 || value.length > MAX_STRUCTURE_MEMBER_ID_LENGTH ||
      !/^[a-zA-Z0-9_.-]{1,48}$/.test(value.slice(separator + 10)))
    throw new RangeError("Invalid canonical trading jobsite");
  const owner = parseStructureIdentity(
    value.slice(0, separator), context.seed, context.generatorVersion, dimension
  );
  if (owner?.kind !== "village") throw new RangeError("Jobsite is not a village marker");
  return value;
}

export function normalizeTraderJobsite(value, profession, context) {
  if (value === null) return null;
  progressRecord(value, ["id", "kind", "dimension", "position"]);
  if (
    typeof profession !== "string" || !Object.hasOwn(TRADING_JOBSITES, profession) ||
    value.kind !== TRADING_JOBSITES[profession]
  )
    throw new RangeError("Jobsite does not match the profession");
  return {
    id: traderJobsiteId(value.id, value.dimension, context),
    kind: value.kind,
    dimension: value.dimension,
    position: progressPosition(value.position, value.dimension, context),
  };
}

export function normalizeTraderRecord(value, context) {
  progressRecord(value, [
    "id", "profession", "locked", "xp", "offerVersion", "offers",
    "jobsite", "clock", "restocks", "lastRestockTime",
  ]);
  const id = progressId(value.id);
  const profession = value.profession;
  const level = traderLevel(value.xp);
  const clock = normalizeTradeClock(value.clock);
  if (
    ![...TRADING_PROFESSIONS, "unemployed", "nitwit"].includes(profession) ||
    typeof value.locked !== "boolean" ||
    value.locked !== (value.xp > 0) ||
    ![1, TRADE_OFFER_VERSION].includes(value.offerVersion) ||
    !Number.isInteger(value.restocks) || value.restocks < 0 ||
    value.restocks > MAX_DAILY_RESTOCKS ||
    (value.restocks === 0 ? value.lastRestockTime !== null :
      !Number.isInteger(value.lastRestockTime) ||
      value.lastRestockTime < RESTOCK_WORK_START ||
      value.lastRestockTime >= RESTOCK_WORK_END ||
      value.lastRestockTime > clock.time) ||
    (!TRADING_PROFESSIONS.includes(profession) &&
      (value.xp !== 0 || value.jobsite !== null || value.restocks !== 0))
  )
    throw new RangeError("Invalid persistent villager state");
  // Validate the exact saved catalog, not a subset of today's roster. Legacy
  // farmers retain all six offers and their stock; only new catalogs add carrots.
  const expected = generateTraderOffers(id, profession, context, value.offerVersion);
  const supplied = progressArray(value.offers, MAX_TRADE_OFFERS)
    .map((entry) => normalizeTradeOffer(entry, context));
  if (
    supplied.length !== expected.length ||
    (!value.locked && (value.restocks > 0 || supplied.some((entry) => entry.uses > 0)))
  )
    throw new RangeError("Invalid persistent villager offers or trade lock");
  const byId = new Map(supplied.map((entry) => [entry.id, entry]));
  if (byId.size !== supplied.length)
    throw new RangeError("Duplicate persistent offer");
  const offers = expected.map((definition) => {
    const entry = byId.get(definition.id);
    if (
      !entry ||
      JSON.stringify({ ...entry, uses: 0 }) !== JSON.stringify(definition) ||
      (entry.level > level && entry.uses !== 0)
    )
      throw new RangeError("Villager offers do not match their saved identity");
    return entry;
  });
  return {
    id, profession, locked: value.locked, xp: value.xp,
    offerVersion: value.offerVersion, offers,
    jobsite: normalizeTraderJobsite(value.jobsite, profession, context),
    clock, restocks: value.restocks, lastRestockTime: value.lastRestockTime,
  };
}

export function traderRecordBytes(record) {
  const bytes = encodedBytes(record);
  if (bytes > MAX_TRADER_RECORD_BYTES)
    throw new RangeError("Villager record exceeds its byte bound");
  return bytes + 1;
}

function availability(value, context) {
  progressRecord(value, ["adult", "alive", "nitwit", "available", "dimension", "revision"]);
  if (
    ["adult", "alive", "nitwit", "available"].some((key) => typeof value[key] !== "boolean") ||
    !Number.isSafeInteger(value.revision) || value.revision < 0
  )
    throw new RangeError("Invalid NPC availability");
  context.specForDimension(value.dimension);
  return {
    adult: value.adult, alive: value.alive, nitwit: value.nitwit,
    available: value.available, dimension: value.dimension, revision: value.revision,
  };
}

/**
 * The ecology owner supplies age, life, reachability/loading and a revision.
 * Nothing here simulates or duplicates NPC age, movement, death or rendering.
 */
export function captureTraderAvailability(read, id, clock, context) {
  if (!synchronousProgressCallback(read)) return null;
  const first = availability(read(id, Object.freeze({ ...clock })), context);
  if (!first.adult || !first.alive || first.nitwit || !first.available) return null;
  return {
    dimension: first.dimension,
    validate: () => JSON.stringify(first) === JSON.stringify(
      availability(read(id, Object.freeze({ ...clock })), context)
    ),
  };
}

/** Pure preflight preserves every NPC/offer and checks inactive-dimension sites. */
export function normalizeTradingSnapshot(value, context) {
  try {
    context = normalizeProgressionContext(context);
    progressRecord(value, ["version", "seed", "generatorVersion", "npcs"]);
    if (
      value.version !== TRADING_VERSION ||
      value.seed !== context.seed ||
      value.generatorVersion !== context.generatorVersion
    )
      return null;
    const npcs = progressArray(value.npcs, MAX_TRADERS)
      .map((entry) => normalizeTraderRecord(entry, context));
    const ids = new Set();
    const sites = new Set();
    const siteIds = new Set();
    for (const npc of npcs) {
      if (ids.has(npc.id)) return null;
      ids.add(npc.id);
      traderRecordBytes(npc);
      if (npc.jobsite) {
        const site = progressPositionKey(npc.jobsite);
        if (sites.has(site) || siteIds.has(npc.jobsite.id)) return null;
        sites.add(site);
        siteIds.add(npc.jobsite.id);
      }
    }
    return {
      version: TRADING_VERSION,
      seed: context.seed,
      generatorVersion: context.generatorVersion,
      npcs,
    };
  } catch {
    return null;
  }
}
