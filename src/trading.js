import {
  composeProgressionPlan,
  freezeProgressData,
  prepareProgression,
  progressId,
  progressPosition,
  progressPositionKey,
  progressRecord,
  synchronousProgressCallback,
} from "./progression-common.js";
import { normalizeProgressionContext } from "./progression-context.js";
import { TransactionCoordinator } from "./transactions.js";
import { prepareTradeInventory } from "./trading-inventory.js";
import {
  generateTraderOffers,
  MAX_TRADER_XP,
  MAX_TRADE_USES,
  TRADE_OFFER_VERSION,
  traderLevel,
  TRADING_PROFESSIONS,
} from "./trading-offers.js";
import {
  advanceTraderCalendar,
  captureTraderAvailability,
  MAX_DAILY_RESTOCKS,
  MAX_TRADERS,
  normalizeTradeClock,
  normalizeTraderJobsite,
  normalizeTraderRecord,
  normalizeTradingSnapshot,
  RESTOCK_WORK_END,
  RESTOCK_WORK_START,
  traderRecordBytes,
  TRADING_VERSION,
} from "./trading-state.js";

export { normalizeTradingSnapshot } from "./trading-state.js";
export {
  missingTradeItems,
  PROGRESSION_ACQUISITION_HOOKS,
  TRADE_ACQUISITION,
  traderLevel,
  TRADER_LEVEL_THRESHOLDS,
  TRADING_JOBSITES,
  TRADING_PROFESSIONS,
} from "./trading-offers.js";

/**
 * Persistent NPC trade progression, not inventory, UI or an NPC simulator.
 * Ecology owns visible NPCs and supplies revisioned availability; Settlement
 * owns real claimed/accessibly usable jobsites. There is deliberately NO bed
 * requirement. Keep this ledger across dimension changes and chunk unloads.
 */
export class Trading {
  constructor({
    context, coordinator = new TransactionCoordinator(), onChange,
    allowOverBudget = false,
  } = {}) {
    if (
      !(coordinator instanceof TransactionCoordinator) ||
      typeof allowOverBudget !== "boolean" ||
      (onChange !== undefined && !synchronousProgressCallback(onChange))
    )
      throw new TypeError("Invalid trading dependencies");
    this.context = normalizeProgressionContext(context);
    this.coordinator = coordinator;
    this.onChange = onChange;
    this._npcs = new Map();
    this._jobsiteOwners = new Map();
    this._jobsiteIds = new Map();
    this._recordBytes = new Map();
    this._bytes = 0;
    this._revision = 0;
    this._busy = false;
    this._disposed = false;
    this._sealed = false;
    if (!coordinator.register(this, 0, { allowOverBudget }))
      throw new RangeError("Cannot register trading state");
  }

  get reservedBytes() { return this._bytes; }
  get revision() { return this._revision; }

  /** Detached read model; serialize(), not this view, is the archive schema. */
  get(id) {
    const npc = this._npcs.get(progressId(id));
    return npc ? { ...structuredClone(npc), level: traderLevel(npc.xp) } : null;
  }

  /**
   * Cheap immutable lifecycle/work projection. Checking an open menu or an
   * idle villager must not clone every offer and metadata-bearing stack each
   * frame. Nested values already belong to the frozen published record.
   */
  readRuntime(id) {
    const npc = this._npcs.get(progressId(id));
    return npc ? Object.freeze({
      id: npc.id, profession: npc.profession, jobsite: npc.jobsite,
      clock: npc.clock, restocks: npc.restocks, lastRestockTime: npc.lastRestockTime,
      needsRestock: npc.offers.some((offer) => offer.uses > 0),
    }) : null;
  }

  offers(id) {
    const npc = this._npcs.get(progressId(id));
    return npc ? structuredClone(npc.offers
      .filter((offer) => offer.level <= traderLevel(npc.xp))
      .map((offer) => ({ ...offer, remaining: offer.maxUses - offer.uses }))) : [];
  }

  /** Public physical-removal lookup; callers never inspect either claim Map. */
  jobsiteOwnerAt(dimension, position) {
    const at = progressPosition(position, dimension, this.context);
    return this._jobsiteOwners.get(progressPositionKey({ dimension, position: at })) ?? null;
  }

  _prepareRecord(value, validate) {
    const next = freezeProgressData(normalizeTraderRecord(value, this.context));
    const previous = this._npcs.get(next.id);
    const size = traderRecordBytes(next);
    const beforeBytes = this._bytes;
    const afterBytes = beforeBytes - (this._recordBytes.get(next.id) ?? 0) + size -
      Number(!previous && this._npcs.size === 0);
    const position = next.jobsite ? progressPositionKey(next.jobsite) : null;
    const siteOwner = position === null ? undefined : this._jobsiteOwners.get(position);
    const idOwner = next.jobsite ? this._jobsiteIds.get(next.jobsite.id) : undefined;
    if (
      (!previous && this._npcs.size >= MAX_TRADERS) ||
      (siteOwner !== undefined && siteOwner !== next.id) ||
      (idOwner !== undefined && idOwner !== next.id) ||
      !Number.isSafeInteger(afterBytes) || afterBytes < 0 ||
      !Number.isSafeInteger(this._revision + 1)
    )
      return null;
    const revision = this._revision;
    const context = this.context;
    const coordinator = this.coordinator;
    const store = this._npcs;
    let used = false;
    return Object.freeze({
      owner: this, beforeBytes, afterBytes,
      validate: () =>
        !used && !this._busy && !this._disposed &&
        this.context === context && this.coordinator === coordinator &&
        this._revision === revision && this._bytes === beforeBytes &&
        this._npcs === store && store.get(next.id) === previous &&
        validate() === true,
      publish: () => {
        used = true;
        if (previous?.jobsite) {
          this._jobsiteOwners.delete(progressPositionKey(previous.jobsite));
          this._jobsiteIds.delete(previous.jobsite.id);
        }
        store.set(next.id, next);
        if (next.jobsite) {
          this._jobsiteOwners.set(position, next.id);
          this._jobsiteIds.set(next.jobsite.id, next.id);
        }
        this._recordBytes.set(next.id, size);
        this._bytes = afterBytes;
        this._revision++;
      },
      ...(this.onChange ? { notify: () => this.onChange() } : {}),
    });
  }

  _jobsiteCheck(read, npc, available, clock) {
    if (
      !npc.jobsite ||
      npc.jobsite.dimension !== available?.dimension ||
      !synchronousProgressCallback(read)
    )
      return null;
    const check = () => read(
      npc.id,
      freezeProgressData(structuredClone(npc.jobsite)),
      Object.freeze({ ...clock })
    ) === true;
    return check() ? check : null;
  }

  /**
   * Register a stable ecology/structure NPC id exactly once. Employed newcomers
   * need an accessible claimed matching jobsite; unemployed/nitwit records can
   * be admitted before adulthood. validate pins the actual NPC birth/admission.
   */
  prepareRegister(value, {
    clock, validate, readAvailability, jobsiteUsable, participants = [],
  } = {}) {
    return prepareProgression(this, () => {
      progressRecord(value, ["id", "profession", "jobsite"]);
      const id = progressId(value.id);
      if (this._npcs.has(id) || !synchronousProgressCallback(validate)) return null;
      const profession = value.profession === undefined ? "unemployed" : value.profession;
      const next = {
        id, profession, locked: false, xp: 0, offerVersion: TRADE_OFFER_VERSION,
        offers: generateTraderOffers(id, profession, this.context),
        jobsite: normalizeTraderJobsite(value.jobsite ?? null, profession, this.context),
        clock: normalizeTradeClock(clock), restocks: 0, lastRestockTime: null,
      };
      let available;
      let jobsite;
      if (TRADING_PROFESSIONS.includes(profession)) {
        available = captureTraderAvailability(readAvailability, id, next.clock, this.context);
        jobsite = this._jobsiteCheck(jobsiteUsable, next, available, next.clock);
        if (!available || !jobsite) return null;
      }
      const source = this._prepareRecord(next, () =>
        validate() === true && (!available || available.validate()) && (!jobsite || jobsite())
      );
      return source ? composeProgressionPlan(this, source, participants, {
        ok: true, npcId: id,
      }) : null;
    });
  }

  /**
   * Changing a profession is allowed only before the first trade. Reclaiming or
   * losing a jobsite never rerolls an existing profession's offers or stock.
   * A locked villager can retain its profession with jobsite:null and trade its
   * remaining stock, but cannot restock. Ownership of a site stays exclusive.
   */
  prepareAssign(id, { profession, jobsite }, {
    clock, readAvailability, jobsiteUsable, validate, participants = [],
  } = {}) {
    return prepareProgression(this, () => {
      const previous = this._npcs.get(progressId(id));
      if (
        !previous || !synchronousProgressCallback(validate) ||
        (previous.locked && profession !== previous.profession) ||
        (previous.profession === "nitwit" && profession !== "nitwit") ||
        (profession === "nitwit" && previous.profession !== "nitwit")
      )
        return null;
      const calendar = advanceTraderCalendar(previous, clock);
      const available = captureTraderAvailability(readAvailability, id, calendar.clock, this.context);
      if (!available) return null;
      const next = {
        ...structuredClone(previous), ...calendar, profession,
        jobsite: normalizeTraderJobsite(jobsite, profession, this.context),
        offerVersion: profession === previous.profession ? previous.offerVersion : TRADE_OFFER_VERSION,
        offers: profession === previous.profession ? structuredClone(previous.offers) :
          generateTraderOffers(id, profession, this.context),
      };
      if (!TRADING_PROFESSIONS.includes(profession)) {
        next.restocks = 0;
        next.lastRestockTime = null;
      }
      const siteCheck = next.jobsite
        ? this._jobsiteCheck(jobsiteUsable, next, available, calendar.clock) : null;
      if (
        (next.jobsite && !siteCheck) ||
        (profession !== previous.profession &&
          TRADING_PROFESSIONS.includes(profession) && !next.jobsite)
      )
        return null;
      const source = this._prepareRecord(next, () =>
        available.validate() && (!siteCheck || siteCheck()) && validate() === true
      );
      return source ? composeProgressionPlan(this, source, participants, {
        ok: true, npcId: id,
      }) : null;
    });
  }

  /**
   * Lifecycle hook for a destroyed site, explicit unclaim or NPC death. The
   * owning World/ecology participant and read prerequisite belong in this plan;
   * an unavailable/dead NPC need not be interactable to relinquish its jobsite.
   * Unloading alone must NOT call this. Offers, XP and profession remain intact.
   */
  prepareReleaseJobsite(id, options) {
    return this.prepareReleaseJobsites([id], options);
  }

  /** One ledger participant for a bounded explosion/unclaim batch. */
  prepareReleaseJobsites(ids, { clock, validate, participants = [] } = {}) {
    return prepareProgression(this, () => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 128 ||
          new Set(ids).size !== ids.length || !synchronousProgressCallback(validate))
        return null;
      const store = this._npcs, revision = this._revision, context = this.context;
      const coordinator = this.coordinator, beforeBytes = this._bytes;
      if (!Number.isSafeInteger(revision + 1)) return null;
      let afterBytes = beforeBytes;
      const edits = ids.map((value) => {
        const id = progressId(value), previous = store.get(id);
        if (!previous?.jobsite) throw new RangeError("Unclaimed trader jobsite");
        const next = freezeProgressData(normalizeTraderRecord({
          ...structuredClone(previous),
          ...advanceTraderCalendar(previous, clock),
          jobsite: null,
        }, context));
        const size = traderRecordBytes(next);
        afterBytes += size - this._recordBytes.get(id);
        return { id, previous, next, size };
      });
      let used = false;
      const source = Object.freeze({
        owner: this, beforeBytes, afterBytes,
        validate: () => !used && !this._busy && !this._disposed &&
          this.context === context && this.coordinator === coordinator &&
          this._revision === revision && this._bytes === beforeBytes &&
          this._npcs === store && edits.every(({ id, previous }) => store.get(id) === previous) &&
          validate() === true,
        publish: () => {
          used = true;
          for (const { id, previous, next, size } of edits) {
            this._jobsiteOwners.delete(progressPositionKey(previous.jobsite));
            this._jobsiteIds.delete(previous.jobsite.id);
            store.set(id, next);
            this._recordBytes.set(id, size);
          }
          this._bytes = afterBytes;
          this._revision++;
        },
        ...(this.onChange ? { notify: () => this.onChange() } : {}),
      });
      return composeProgressionPlan(this, source, participants, {
        ok: true, npcIds: edits.map(({ id }) => id), jobSitesReleased: edits.length,
        ...(edits.length === 1 ? { npcId: edits[0].id, jobsiteReleased: true } : {}),
      });
    });
  }

  /**
   * inventory implements the existing Gameplay.prepareInventory API on this
   * coordinator. One participant pays every input, receives every output and
   * grants player XP; one ledger participant changes stock/lock/villager XP.
   * readAvailability includes adult/alive/non-nitwit/reachable checks plus a
   * revision. validate must pin the caller's live calendar/interaction revision;
   * this ledger is not the world's clock authority. Extra participants may pin
   * world/UI prerequisites or free capacity.
   */
  prepareTrade(id, offerId, {
    inventory, count = 1, clock, readAvailability, validate, participants = [],
  } = {}) {
    return prepareProgression(this, () => {
      const previous = this._npcs.get(progressId(id));
      if (
        !previous || !TRADING_PROFESSIONS.includes(previous.profession) ||
        !Number.isInteger(count) || count < 1 || count > MAX_TRADE_USES ||
        !synchronousProgressCallback(validate)
      )
        return null;
      const offer = previous.offers.find((entry) => entry.id === offerId);
      if (
        !offer || offer.level > traderLevel(previous.xp) ||
        offer.uses + count > offer.maxUses ||
        previous.xp + offer.xp * count > MAX_TRADER_XP
      )
        return null;
      const calendar = advanceTraderCalendar(previous, clock);
      const available = captureTraderAvailability(readAvailability, id, calendar.clock, this.context);
      if (!available) return null;
      const next = {
        ...structuredClone(previous), ...calendar,
        locked: true, xp: previous.xp + offer.xp * count,
      };
      next.offers.find((entry) => entry.id === offerId).uses += count;
      const source = this._prepareRecord(next, () => available.validate() && validate() === true);
      if (!source) return null;
      const player = prepareTradeInventory(
        inventory, offer, count, this.coordinator, this.context
      );
      if (!player) return null;
      return composeProgressionPlan(this, source, [player, ...participants], {
        ok: true, npcId: id, offerId, trades: count,
        villagerXp: offer.xp * count, playerXp: offer.playerXp * count,
        experienceCommitted: true,
      });
    });
  }

  /**
   * Explicit work event, never offline catch-up. Calendar advancement (including
   * sleep) only resets today's allowance; it does not grant stock or simulate
   * arbitrary elapsed time. At most two actual restocks/day, at distinct work
   * ticks, with depleted stock and a still-usable claimed jobsite. NO BED CHECK.
   */
  prepareRestock(id, {
    clock, readAvailability, jobsiteUsable, validate, participants = [],
  } = {}) {
    return prepareProgression(this, () => {
      const previous = this._npcs.get(progressId(id));
      if (
        !previous || !TRADING_PROFESSIONS.includes(previous.profession) ||
        !synchronousProgressCallback(validate) ||
        !previous.offers.some((offer) => offer.uses > 0)
      )
        return null;
      const calendar = advanceTraderCalendar(previous, clock);
      if (
        calendar.clock.time < RESTOCK_WORK_START ||
        calendar.clock.time >= RESTOCK_WORK_END ||
        calendar.restocks >= MAX_DAILY_RESTOCKS ||
        (calendar.lastRestockTime !== null &&
          calendar.clock.time <= calendar.lastRestockTime)
      )
        return null;
      const available = captureTraderAvailability(readAvailability, id, calendar.clock, this.context);
      const siteCheck = this._jobsiteCheck(jobsiteUsable, previous, available, calendar.clock);
      if (!available || !siteCheck) return null;
      const next = {
        ...structuredClone(previous), ...calendar,
        restocks: calendar.restocks + 1, lastRestockTime: calendar.clock.time,
        offers: previous.offers.map((offer) => ({ ...structuredClone(offer), uses: 0 })),
      };
      const source = this._prepareRecord(next, () =>
        available.validate() && siteCheck() && validate() === true
      );
      return source ? composeProgressionPlan(this, source, participants, {
        ok: true, npcId: id, restocks: next.restocks,
      }) : null;
    });
  }

  commit(plan) {
    if (!plan) return { ok: false, reason: "invalid-trade-plan" };
    const result = this.coordinator.commit(plan.participants);
    return result.ok ? { ...plan.result, observerErrors: result.observerErrors } : result;
  }

  serialize() {
    return structuredClone({
      version: TRADING_VERSION,
      seed: this.context.seed,
      generatorVersion: this.context.generatorVersion,
      npcs: [...this._npcs.values()],
    });
  }

  load(value, { allowOverBudget = false } = {}) {
    if (this._sealed) return false;
    return prepareProgression(this, () => {
      const normalized = normalizeTradingSnapshot(value, this.context);
      if (!normalized) return false;
      const npcs = new Map();
      const sites = new Map();
      const siteIds = new Map();
      const sizes = new Map();
      let bytes = 0;
      for (const npc of normalized.npcs) {
        const size = traderRecordBytes(npc);
        npcs.set(npc.id, freezeProgressData(npc));
        sizes.set(npc.id, size);
        bytes += size;
        if (npc.jobsite) {
          sites.set(progressPositionKey(npc.jobsite), npc.id);
          siteIds.set(npc.jobsite.id, npc.id);
        }
      }
      bytes -= Number(npcs.size > 0);
      if (!this.coordinator.register(this, bytes, { allowOverBudget })) return false;
      this._npcs = npcs;
      this._jobsiteOwners = sites;
      this._jobsiteIds = siteIds;
      this._recordBytes = sizes;
      this._bytes = bytes;
      this._revision++;
      return true;
    }) === true;
  }

  /** Live archive replacement stages a new host; it never reloads one ledger. */
  seal() {
    if (this._busy || this._disposed ||
        !this.coordinator.register(this, this._bytes, { allowOverBudget: true }))
      return false;
    this._sealed = true;
    return true;
  }

  dispose() {
    if (this._busy || this._disposed || !this.coordinator.release(this)) return false;
    this._disposed = true;
    this._revision++;
    return true;
  }
}
