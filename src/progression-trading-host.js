import { BLOCK } from "./blocks.js";
import { captureEntityContext } from "./entity-context.js";
import { synchronous } from "./enchantment-domain.js";
import {
  captureVillagerTrade, normalizeVillagerAssignment, villagerJobsiteUsable,
} from "./npc-ai.js";
import { captureProgressionActor, progressionReadSet } from "./progression-access.js";
import {
  advanceTraderCalendar, MAX_DAILY_RESTOCKS, normalizeTradeClock,
  RESTOCK_WORK_END, RESTOCK_WORK_START,
} from "./trading-calendar.js";
import { TRADING_JOBSITES, TRADING_PROFESSIONS } from "./trading-offers.js";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Live bridge, not another NPC/Settlement authority. Parent supplies the real
 * ecology runtime context and ecology owner. The context's getVillagerAssignment
 * comes from exploration/claimed jobsites (or the saved trade assignment).
 * Calendar comes ONLY from GameBuildingServices.clockProjection().
 */
export class ProgressionTradingHost {
  constructor({ world, gameplay, trading, getEcology, getEcologyContext,
    getBuildingServices, validateLive, readActor }) {
    Object.assign(this, {
      world, gameplay, trading, getEcology, getEcologyContext,
      getBuildingServices, validateLive, readActor,
    });
  }

  #context() {
    if (!this.validateLive() || !synchronous(this.getEcologyContext) ||
        !synchronous(this.getEcology)) return null;
    const ctx = this.getEcologyContext();
    return ctx?.world === this.world && synchronous(ctx.getMob) &&
      synchronous(ctx.getVillagerAssignment) ? ctx : null;
  }

  #clock() {
    const building = this.getBuildingServices?.();
    if (!building?.active || building.world !== this.world ||
        building.gameplay !== this.gameplay) return null;
    const clock = building.clockProjection()?.tradingClock;
    if (!clock) return null;
    const normalized = normalizeTradeClock(clock);
    const revision = building.worldClock.revision;
    return {
      clock: normalized,
      validate: () => this.getBuildingServices() === building && building.active &&
        building.worldClock.revision === revision &&
        same(building.clockProjection()?.tradingClock, normalized),
    };
  }

  #availability(id, interaction) {
    const ecology = this.getEcology?.();
    const read = () => {
      const ctx = this.#context();
      if (!ctx || this.getEcology() !== ecology || !synchronous(ecology?.readAvailability) ||
          ecology.coordinator !== this.world.coordinator ||
          this.world.coordinator.usage(ecology) !== ecology.reservedBytes ||
          ecology._disposed)
        return null;
      return ecology.readAvailability(id, ctx, { interaction });
    };
    return { read, ecology };
  }

  #jobsite(id, assignment, ctx) {
    const profession = assignment.profession;
    if (!TRADING_PROFESSIONS.includes(profession) || !assignment.jobSite) return null;
    const kind = TRADING_JOBSITES[profession];
    const { position: jobPosition } = assignment.jobSite;
    const site = {
      id: assignment.jobSite.id, kind, dimension: assignment.dimension,
      position: { x: Math.floor(jobPosition.x), y: Math.floor(jobPosition.y), z: Math.floor(jobPosition.z) },
    };
    const reads = progressionReadSet(this.world, this.trading.context);
    if (!reads || reads.read(site.position.x, site.position.y, site.position.z)?.id !== BLOCK[kind])
      return null;
    const mob = ctx.getMob(id);
    if (!mob?.position) return null;
    const position = { x: mob.position.x, y: mob.position.y, z: mob.position.z };
    const editRevision = this.world._editRevision;
    reads.read(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    const usable = () => {
      const now = this.#context();
      const next = now && normalizeVillagerAssignment(now.getVillagerAssignment(id), this.trading.context);
      return !!now && now.getMob(id) === mob && same(next, assignment) &&
        this.world._editRevision === editRevision &&
        ["x", "y", "z"].every((axis) => mob.position[axis] === position[axis]) &&
        reads.validate() && villagerJobsiteUsable(mob, site, now);
    };
    return usable() ? { site, usable } : null;
  }

  /**
   * Called on an ecology work observation, or when first opening a live NPC.
   * An employed newcomer is admitted only at its actual usable matching site.
   * Repeated admission/opening never regenerates offers.
   */
  prepareAdmission(id) {
    if (this.trading.readRuntime(id)) return null;
    const ctx = this.#context(), calendar = this.#clock();
    if (!ctx || !calendar) return null;
    const assignment = normalizeVillagerAssignment(ctx.getVillagerAssignment(id), this.trading.context);
    if (!assignment || assignment.id !== id) return null;
    const site = this.#jobsite(id, assignment, ctx);
    if (!site) return null;
    const availability = this.#availability(id, false);
    const current = captureEntityContext(this.world, this.trading.context);
    return this.trading.prepareRegister({
      id, profession: assignment.profession, jobsite: site.site,
    }, {
      clock: calendar.clock, readAvailability: availability.read,
      jobsiteUsable: () => site.usable(),
      validate: () => this.validateLive() && current() && calendar.validate() && site.usable(),
    });
  }

  captureInteraction(id) {
    const ctx = this.#context(), calendar = this.#clock();
    if (!ctx || !calendar || this.gameplay.dead) return null;
    const actor = captureProgressionActor(this.world, this.gameplay, this.readActor);
    if (!actor) return null;
    const mob = ctx.getMob(id);
    const capture = captureVillagerTrade(mob, ctx);
    if (!capture) return null;
    const trader = this.trading.readRuntime(id);
    if (trader && trader.profession !== capture.assignment.profession) return null;
    const read = this.#availability(id, true).read;
    const observed = read();
    if (!observed?.available || !observed.alive || !observed.adult || observed.nitwit)
      return null;
    const current = captureEntityContext(this.world, this.trading.context);
    const validate = () => {
      const now = this.#context();
      return !!now && this.validateLive() && current() && actor.validate() &&
        !this.gameplay.dead &&
        now.getMob(id) === mob && capture.validate() && calendar.validate() &&
        same(read(), observed) &&
        same(normalizeVillagerAssignment(now.getVillagerAssignment(id), this.trading.context), capture.assignment);
    };
    return validate() ? { id, mob, clock: calendar.clock, readAvailability: read, validate } : null;
  }

  view(id) {
    const access = this.captureInteraction(id);
    const trader = access && this.trading.get(id);
    if (!trader) return null;
    let calendar;
    try { calendar = advanceTraderCalendar(trader, access.clock); } catch { return null; }
    return {
      kind: "trading", title: `${trader.profession[0].toUpperCase()}${trader.profession.slice(1)}`,
      npcId: id, level: trader.level, xp: trader.xp, restocks: calendar.restocks,
      offers: this.trading.offers(id), gameplay: this.gameplay.getState(),
      clock: access.clock, tradingRevision: this.trading.revision,
    };
  }

  prepareTrade(id, offerId, { count = 1, validateSession } = {}) {
    const access = this.captureInteraction(id);
    if (!access || !synchronous(validateSession)) return null;
    return this.trading.prepareTrade(id, offerId, {
      inventory: this.gameplay, count, clock: access.clock,
      readAvailability: access.readAvailability,
      validate: () => validateSession() && access.validate(),
    });
  }

  /** Only a real at-jobsite work event may restock; a frame/day jump cannot. */
  prepareWork(id, observation, expectedMob) {
    if (observation?.intent !== "work" || observation.atJobsite !== true) return null;
    const ctx = this.#context(), calendar = this.#clock();
    if (!ctx || !calendar || (expectedMob !== undefined && ctx.getMob(id) !== expectedMob))
      return null;
    const assignment = normalizeVillagerAssignment(ctx.getVillagerAssignment(id), this.trading.context);
    if (!assignment || observation.assignmentRevision !== assignment.revision ||
        observation.jobSiteId !== assignment.jobSite?.id) return null;
    const previous = this.trading.readRuntime(id);
    if (!previous) return this.prepareAdmission(id);
    const anchor = assignment.jobSite;
    const sameSite = previous.profession === assignment.profession &&
      previous.jobsite?.id === anchor?.id &&
      previous.jobsite?.dimension === assignment.dimension &&
      ["x", "y", "z"].every((axis) =>
        previous.jobsite?.position[axis] === Math.floor(anchor?.position[axis]));
    if (!sameSite) return this.prepareJobsiteAssignment(id);
    if (!previous.needsRestock) return null;
    if (calendar.clock.day < previous.clock.day ||
        (calendar.clock.day === previous.clock.day && calendar.clock.time < previous.clock.time))
      return null;
    const allowance = advanceTraderCalendar(previous, calendar.clock);
    if (calendar.clock.time < RESTOCK_WORK_START || calendar.clock.time >= RESTOCK_WORK_END ||
        allowance.restocks >= MAX_DAILY_RESTOCKS ||
        (allowance.lastRestockTime !== null && calendar.clock.time <= allowance.lastRestockTime))
      return null;
    const site = this.#jobsite(id, assignment, ctx);
    if (!site) return null;
    const availability = this.#availability(id, false);
    const current = captureEntityContext(this.world, this.trading.context);
    return this.trading.prepareRestock(id, {
      clock: calendar.clock, readAvailability: availability.read,
      jobsiteUsable: () => site.usable(),
      validate: () => this.validateLive() && current() && calendar.validate() && site.usable(),
    });
  }

  /**
   * Adopt the actual ecology/exploration assignment at its physically usable
   * jobsite. The ledger owns exclusivity and profession locking. Reclaiming the
   * same profession keeps its offers/uses/XP; this is never a restock or an
   * admission with a fresh identity. Parent may add its prepared claim peers.
   */
  prepareJobsiteAssignment(id, { validate = () => true, participants = [] } = {}) {
    if (!synchronous(validate) || !Array.isArray(participants)) return null;
    const ctx = this.#context(), calendar = this.#clock();
    const previous = this.trading.readRuntime(id);
    if (!ctx || !calendar || !previous) return null;
    const assignment = normalizeVillagerAssignment(ctx.getVillagerAssignment(id), this.trading.context);
    if (!assignment || assignment.id !== id) return null;
    const site = this.#jobsite(id, assignment, ctx);
    if (!site || (previous.profession === assignment.profession && same(previous.jobsite, site.site)))
      return null;
    const availability = this.#availability(id, false);
    const current = captureEntityContext(this.world, this.trading.context);
    return this.trading.prepareAssign(id, {
      profession: assignment.profession, jobsite: site.site,
    }, {
      clock: calendar.clock, participants, readAvailability: availability.read,
      jobsiteUsable: () => site.usable(),
      validate: () => this.validateLive() && current() && calendar.validate() &&
        site.usable() && validate() === true,
    });
  }

  /**
   * Parent composes this with the real World/ecology removal/unclaim plan.
   * A dead/unloaded NPC need not be interactable to release its claim. Merely
   * closing a menu or unloading a chunk MUST NOT call this.
   */
  prepareJobsiteRelease(id, options) {
    return this.prepareJobsitesRelease([id], options);
  }

  prepareJobsitesRelease(ids, { validate, participants = [] } = {}) {
    const calendar = this.#clock();
    if (!this.validateLive() || !calendar || !synchronous(validate)) return null;
    const current = captureEntityContext(this.world, this.trading.context);
    return this.trading.prepareReleaseJobsites(ids, {
      clock: calendar.clock, participants,
      validate: () => this.validateLive() && current() && calendar.validate() &&
        validate() === true,
    });
  }
}
