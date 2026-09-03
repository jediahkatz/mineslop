import {
  AQUATIC_AI_LIMITS,
  ecologyBodySample,
  ecologyCanOccupy,
  ecologyCanTarget,
  ecologyDistance,
  ecologyEye,
  ecologyLineOfSight,
  ecologyPoint,
  isElderMarker,
  moveEcologyMob,
  synchronousEcologyHook,
} from "./aquatic-ai.js";
import { BIOMES } from "./biomes.js";
import { BLOCK } from "./blocks.js";
import { FLUID } from "./block-state.js";
import { EcologyEffects } from "./ecology-effects.js";
import { ECOLOGY_HOST_LIMITS, populateEcology } from "./ecology-population.js";
import { EcologyAttackRenderer } from "./ecology-render.js";
import {
  ecologyCompletionLinksValid,
  ecologyEncounterProjection,
  normalizeEcologyServicesSnapshot,
} from "./ecology-save.js";
import { captureEntityContext, matchesEntityContext } from "./entity-context.js";
import {
  ecologyCollider,
  ECOLOGY_LIMITS,
  ECOLOGY_SPECIES,
  ExpansionEcology,
} from "./expansion-ecology.js";
import { readGeometryCell } from "./geometry-world.js";
import { getItem, ITEM } from "./items.js";
import { finitePosition } from "./mob-navigation.js";
import { MAX_HOSTILES, MIN_HOSTILE_SPAWN_DISTANCE } from "./mob-species.js";
import {
  captureVillagerTrade,
  villagerAssignmentFromMarkers,
  villagerAssignmentFromTrader,
  villagerJobsiteUsable,
} from "./npc-ai.js";
import { TransactionCoordinator, TransactionInvariantError } from "./transactions.js";
import { createWorldContext } from "./world-spec.js";

export { ECOLOGY_HOST_LIMITS } from "./ecology-population.js";
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const refuse = (reason) => ({ ok: false, reason });
const center = (position) => ({ x: position.x + 0.5, y: position.y, z: position.z + 0.5 });
const canonicalItem = (name) => {
  const value = Object.hasOwn(ITEM, name) ? ITEM[name] : Object.hasOwn(BLOCK, name) ? BLOCK[name] : null;
  return Number.isInteger(value) && getItem(value) ? value : null;
};
const bodyAt = (position) => ({
  x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z),
});
const participant = (value) => record(value) && !value.then &&
  synchronousEcologyHook(value.validate) && synchronousEcologyHook(value.publish);
const ownerKeys = ["gameplay", "overflow", "experienceOrbs", "exploration", "trading"];
const markerMethods = ["getMarker", "getStructure", "nearbyMarkers", "nearbyStructures"];
const invoke = (callback, ...args) => {
  if (!synchronousEcologyHook(callback)) return null;
  try { return callback(...args); }
  catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return null;
  }
};

/**
 * @typedef {Object} EcologyMarkerIndex
 * @property {function(string): object|null} getMarker Current frozen rich catalog marker, exact full ID.
 * @property {function(string): object|null} getStructure Current frozen descriptor from native admission.
 * @property {function(object, object): object[]} nearbyMarkers Loaded cached markers, honors limit.
 * @property {function(object, object): object[]} nearbyStructures Cached descriptors, honors limit.
 * Returned object identity must remain stable until invalidation; these readers
 * never admit/generate chunks or clone the entire resident index during a read.
 *
 * @typedef {Object} EcologyDropPayload
 * @property {object[]} stacks Canonical numeric stacks, all of which must be retained.
 * @property {{x:number,y:number,z:number}} position Feet position.
 * @property {string} dimension
 * @property {string} reason
 *
 * @typedef {Object} EcologyExperiencePayload
 * @property {number} amount
 * @property {{x:number,y:number,z:number}} position
 * @property {string} dimension
 *
 * @typedef {Object} EcologyModifiers
 * @property {number} swimSpeedMultiplier 1 or 1.6, composed by Player with other movement modifiers.
 * @property {number} miningSpeedMultiplier 1 or 0.0027, composed by Gameplay with tool/effect speed.
 * @property {number|null} miningFatigueLevel Null or 2 (zero-based amplifier).
 *
 * @typedef {Object} EcologyPreparedPlan
 * @property {object[]} participants One per owner; commit the entire list once.
 * @property {object} result Receipt only; dropsCommitted/experienceCommitted prohibit duplicate rewards.
 *
 * @typedef {Object} EcologyVillagerDeathPayload
 * @property {string} entityId Stable bounded Trading/Wildlife ID.
 * @property {string} memberId Full canonical native member ID.
 * @property {string} dimension
 *
 * @typedef {Object} EcologyPlayerView
 * @property {{x:number,y:number,z:number}} position Physical feet, not render camera.
 * @property {{x:number,y:number,z:number}} eye Physical eye, not third-person camera.
 * @property {string} dimension
 * @property {string} targetKey Life identity; replace on death/respawn/activation.
 * @property {number} health
 * @property {string} mode
 * @property {boolean} swimming
 * @property {boolean} invulnerable
 *
 * @typedef {Object} EcologyHabitatView
 * @property {string} biomeId Already-admitted biome, never a generator query.
 * @property {number} [blockLight] Actual integer local light 0..15; required for drowned.
 * @property {number} [skyLight] Actual integer local sky light 0..15; required for drowned.
 * @property {{x:number,y:number,z:number}} [homeBeach] Verified sand feet position for water-born turtles.
 *
 * @typedef {Object} EcologyRuntimeContext
 * @property {object} world The installed World, not a generated or archived projection.
 * @property {object} worldContext All-dimension bounds.
 * @property {function(string): object|null} getMob Current bounded Wildlife resident.
 * @property {function(string): object|null} getVillagerAssignment Read-only Trading/canonical marker bridge.
 * @property {function(object, object=): boolean} jobsitePresent Actual loaded World cell check.
 * @property {object[]} threats At most AQUATIC_AI_LIMITS.neighbors live actors.
 * @property {{x:number,y:number,z:number}} player Current physical feet.
 * @property {{x:number,y:number,z:number}} playerEye Current physical eye.
 * Read-only, short-lived view for ProgressionTradingHost. Pair getEcology()
 * with `host.ecology`, and getEcologyContext() with `host.readRuntimeContext()`.
 * Never retain this view as an archive or mutate its live owner references.
 *
 * @typedef {Object} EcologyEggMutationPayload
 * @property {object[]} eggs Frozen incubating records with permanent child IDs.
 * @property {object[]} changes Expected World before/after cells, all must be removed.
 * @property {object[]} reads Loaded support prerequisites.
 * @property {string} dimension
 * A prepareRemoveEggs callback may merge these with an explosion's other World
 * changes and return ONE World participant. It must not commit or publish.
 */

/** Detached staging -> restoreWildlife(candidate) -> activate(candidate).
 * Parent owns Game installation, archive plumbing, input, Player modifiers and
 * trade UI. No Game/global mutation or eager RNG, admission, registration or GPU
 * work occurs here. Keep this owner through dimension travel; suspend BEFORE
 * changing World.dimension, then restore/activate the new Wildlife renderer.
 *
 * All prepared public methods return {participants,result}|null. Compose those
 * participants with the real action/tool-cost plan and commit ONCE. In particular
 * do not call legacy Wildlife.interact/damage then debit a hand or grant XP.
 * prepareDrops(EcologyDropPayload) returns ONE participant owned by `overflow`;
 * prepareExperience(EcologyExperiencePayload) returns ONE owned by `experienceOrbs`.
 * Explicit callback refusal never falls back to direct item/XP grants. The
 * defaults use DropOverflow.prepareEnqueue and ExperienceOrbs.prepareSpawn.
 * onEffectsChanged(EcologyModifiers) and onVillagerIntent(id,intent) are
 * post-state observations only, not ownership transfers or generated trade stock.
 */
export class GameEcologyServices {
  constructor({
    world, gameplay, overflow, experienceOrbs, exploration, trading, markers,
    context = world && createWorldContext(world), saved,
    coordinator = world?.coordinator, allowOverBudget = false,
    readPlayer, readHabitat, prepareDrops, prepareExperience, prepareVillagerDeath,
    getVillagerAssignment, jobsitePresent, isTrading, npcWaypoint,
    onVillagerIntent, onEffectsChanged, onChange,
  } = {}) {
    const normalized = normalizeEcologyServicesSnapshot(saved, context);
    const callbacks = {
      readPlayer, readHabitat, prepareDrops, prepareExperience, prepareVillagerDeath,
      getVillagerAssignment, jobsitePresent, isTrading, npcWaypoint,
      onVillagerIntent, onEffectsChanged, onChange,
    };
    if (!normalized || !world || !matchesEntityContext(world, context) ||
      !(coordinator instanceof TransactionCoordinator) || world.coordinator !== coordinator ||
      typeof allowOverBudget !== "boolean" ||
      Object.values(callbacks).some((fn) => fn !== undefined && !synchronousEcologyHook(fn)) ||
      (markers && markerMethods.some((name) => !synchronousEcologyHook(markers[name]))) ||
      [gameplay, overflow, experienceOrbs, exploration, trading]
        .some((owner) => owner && (owner._disposed || owner.coordinator !== coordinator ||
          coordinator.usage(owner) === undefined ||
          (owner.context && !matchesEntityContext(world, owner.context)))))
      throw new RangeError("Invalid staged ecology host");
    context = createWorldContext(normalized.ecology);
    Object.assign(this, { world, gameplay, overflow, experienceOrbs, exploration, trading, markers,
      context, coordinator, allowOverBudget, hooks: Object.freeze(callbacks) });
    this._bindings = Object.freeze({ world, gameplay, overflow, experienceOrbs, exploration, trading, markers,
      context, coordinator });
    this._ownerContexts = ownerKeys.map((key) => this[key]?.context);
    this._markerMethods = markerMethods.map((name) => markers?.[name]);
    this._stagedCurrent = captureEntityContext(world, context);
    this._candidate = null;
    this._everActivated = false;
    this._revision = 0;
    this.observerErrors = [];
    this._dirty = false;
    this.ecology = new ExpansionEcology({
      context, coordinator, snapshot: normalized.ecology, onChange: () => { this._dirty = true; },
    });
    this._savedMobs = normalized.mobsByDimension;
    this.wildlife = null;
    this.effects = new EcologyEffects({ sourceActive: (id, effect) => this._effectSource(id, effect) });
    this.attacks = null;
    this._disposed = false;
    this._spawnCursor = this._populationRound = this._eggCursor = this._lifecycleCursor = 0;
    this._clock = 0;
    this._eggSeen = new Map();
    this._lastModifiers = null;
  }

  _ownersCurrent() {
    return !this._disposed &&
      Object.entries(this._bindings).every(([key, value]) => this[key] === value) &&
      this.world.coordinator === this.coordinator && matchesEntityContext(this.world, this.context) &&
      this.coordinator.usage(this.world) !== undefined &&
      ownerKeys.every((key, i) => !this[key] || (!this[key]._disposed &&
        this[key].coordinator === this.coordinator && this.coordinator.usage(this[key]) !== undefined &&
        this[key].context === this._ownerContexts[i] &&
        (!this[key].context || matchesEntityContext(this.world, this[key].context)))) &&
      markerMethods.every((name, i) => this.markers?.[name] === this._markerMethods[i]);
  }

  get active() {
    return this._ownersCurrent() && !!this.wildlife && !this.wildlife.disposed &&
      this.wildlife.ecologyServices === this && this.wildlife.world === this.world &&
      this.wildlife.dimension === this.world.dimension && this._activationEpoch === this.world.epoch &&
      this.coordinator.usage(this.ecology) === this.ecology.reservedBytes &&
      this.coordinator.usage(this.wildlife) === 0;
  }
  get reservedBytes() { return this.ecology.reservedBytes; }
  snapshotForDimension(dimension) { return structuredClone(this._savedMobs[dimension] ?? null); }

  /** @returns {EcologyRuntimeContext|null} */
  readRuntimeContext() { return this.active ? this._readContext() : null; }

  restoreWildlife(wildlife) {
    if (this.wildlife || !this._ownersCurrent() || (!this._everActivated && !this._stagedCurrent()) ||
      wildlife?.disposed || wildlife?.ecologyServices ||
      wildlife?.world !== this.world || wildlife.dimension !== this.world.dimension) return false;
    const current = captureEntityContext(this.world, this.context);
    const saved = this._savedMobs[wildlife.dimension];
    const restored = saved ? wildlife.load(saved, { context: this.context, ecology: this.ecology }) :
      wildlife.byId.size === 0;
    this._candidate = restored && current() ? { wildlife, current } : null;
    return this._candidate !== null;
  }

  activate(wildlife) {
    if (!this._ownersCurrent() || this.wildlife || !wildlife || wildlife.disposed ||
      wildlife.ecologyServices || wildlife.world !== this.world ||
      wildlife.dimension !== this.world.dimension ||
      this._candidate?.wildlife !== wildlife || !this._candidate.current())
      return false;
    const saved = {
      version: 1, ecology: this.ecology.serialize(),
      mobsByDimension: { ...this._savedMobs, [wildlife.dimension]: wildlife.serialize() },
    };
    if (!normalizeEcologyServicesSnapshot(saved, this.context) ||
      (saved.ecology.elders.length && (!this.exploration ||
        !ecologyCompletionLinksValid(saved.ecology, this.exploration.serialize())))) return false;
    // Wildlife owns its base-record registration. Ecology and horse services
    // only borrow it, so suspending one host cannot invalidate the other.
    if (wildlife.coordinator !== this.coordinator ||
        this.coordinator.usage(wildlife) !== 0) return false;
    const before = this.coordinator.usage(this.ecology);
    if (before !== undefined && before !== this.ecology.reservedBytes) return false;
    if (before === undefined && !this.coordinator.register(this.ecology, this.ecology.reservedBytes,
      { allowOverBudget: this.allowOverBudget })) return false;
    this.wildlife = wildlife;
    wildlife.ecologyServices = this;
    this._activationEpoch = this.world.epoch;
    this._everActivated = true;
    this._candidate = null;
    this._revision++;
    this.attacks = new EcologyAttackRenderer(wildlife.group, wildlife.context);
    Object.assign(wildlife.context, {
      getStructure: (id) => this.markers?.getStructure(id) ?? null,
      getMarker: (id) => this.markers?.getMarker(id) ?? null,
      nearbyStructures: (position, options) =>
        this.markers?.nearbyStructures(position, { ...options, dimension: this.world.dimension }) ?? [],
      applyEffect: (event) => this.effects.apply(event, this._effectContext()),
      onBeam: (mob, event) => this.attacks.beam(mob, event),
      shootBlaze: (mob, shot) => this.attacks.shootBlaze(mob, shot),
      getVillagerAssignment: (id) => this.assignment(id),
      jobsitePresent: (assignment, proposed) => this.jobsitePresent(assignment, proposed),
      isTrading: (id) => invoke(this.hooks.isTrading, id) === true,
      npcWaypoint: this.hooks.npcWaypoint,
      onVillagerIntent: (mob, intent) => this._observe(this.hooks.onVillagerIntent, mob.id, {
        ...intent, memberId: this.ecology.state(mob.id)?.memberId,
      }),
      eggPresent: (egg) => this.eggPresent(egg),
    });
    this._syncPlayer();
    this.effects.step(0, this._effectContext());
    return true;
  }

  _readContext() {
    const ctx = {
      ...this.wildlife.context,
      threats: this.wildlife.entities.filter((mob) => !mob.dead && !mob.dormant &&
        mob.spec.temperament === "hostile").slice(0, AQUATIC_AI_LIMITS.neighbors),
    };
    if (!this.hooks.readPlayer) return ctx;
    const view = invoke(this.hooks.readPlayer);
    if (!view || !finitePosition(view.position) || !finitePosition(view.eye) ||
      typeof view.targetKey !== "string" || !view.targetKey.length ||
      view.dimension !== this.world.dimension || !Number.isFinite(view.health) ||
      !["survival", "creative"].includes(view.mode)) return { ...ctx, health: 0 };
    return {
      ...ctx, player: view.position, playerEye: view.eye,
      playerTargetKey: view.targetKey, playerDimension: view.dimension,
      health: view.health, mode: view.mode, playerSwimming: view.swimming === true,
      playerInvulnerable: view.invulnerable === true,
    };
  }

  _syncPlayer() {
    if (!this.active) return;
    const view = this._readContext(), ctx = this.wildlife.context;
    ctx.player.copy(view.player);
    Object.assign(ctx.playerEye, view.playerEye);
    for (const key of ["playerTargetKey", "playerDimension", "health", "mode", "playerSwimming", "playerInvulnerable"])
      ctx[key] = view[key];
  }

  _playerGuard() {
    if (!this.active) return null;
    const view = this._readContext();
    if (!(view.health > 0)) return null;
    const position = ecologyPoint(view.player), eye = ecologyPoint(view.playerEye);
    const keys = ["playerTargetKey", "playerDimension", "health", "mode", "playerSwimming", "playerInvulnerable"];
    const values = keys.map((key) => view[key]);
    return () => {
      if (!this.active) return false;
      const next = this._readContext();
      return keys.every((key, i) => next[key] === values[i]) &&
        ecologyDistance(next.player, position) === 0 && ecologyDistance(next.playerEye, eye) === 0;
    };
  }

  _effectContext() {
    const ctx = this.active ? this._readContext() : null;
    return { dimension: this.world.dimension, targetKey: ctx?.playerTargetKey, health: ctx?.health ?? 0 };
  }

  _effectSource(id, effect) {
    const mob = this.wildlife?.byId.get(id);
    if (!this.active || !mob || mob.dead || mob.dormant ||
      !this.ecology.canRestore(id, mob.kind, this.world.dimension)) return false;
    const ctx = this._readContext(), state = this.ecology.state(id);
    if (!ecologyLineOfSight(this.world, ecologyEye(mob), ctx.playerEye)) return false;
    return effect === "dolphins_grace"
      ? mob.kind === "dolphin" && state.assistTime > 0 && ctx.playerSwimming &&
        ecologyBodySample(this.world, mob.position, mob.spec)?.waterImmersion >= 0.08 &&
        ecologyDistance(mob.position, ctx.player) <= 8
      : mob.kind === "elder_guardian" && ecologyCanTarget(mob, ctx) &&
        ecologyDistance(ecologyEye(mob), ctx.playerEye) <= 24;
  }

  _guard() {
    if (!this.active) return null;
    const wildlife = this.wildlife, current = captureEntityContext(this.world, this.context);
    const revision = this._revision;
    return () => this.active && this.wildlife === wildlife && this._revision === revision && current();
  }

  _loadedGuard(position) {
    const world = this.world, revision = world._editRevision;
    const reads = [];
    if (world.chunks instanceof Map) {
      const seen = new Set();
      for (let dz = -2; dz <= 2; dz += 2)
        for (let dx = -2; dx <= 2; dx += 2) {
          const key = `${Math.floor((position.x + dx) / 16)},${Math.floor((position.z + dz) / 16)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const chunk = world.chunks.get(key);
          reads.push({ key, chunk, incarnation: chunk?.incarnation, revision: chunk?.revision });
        }
    }
    return () => this.world === world && world._editRevision === revision &&
      reads.every(({ key, chunk, incarnation, revision }) =>
        world.chunks.get(key) === chunk && chunk?.incarnation === incarnation && chunk?.revision === revision);
  }

  _plan(plan, guard, extra = [], result = {}) {
    if (!plan || !synchronousEcologyHook(guard) || !Array.isArray(plan.participants) ||
      !plan.participants.length || !Array.isArray(extra) ||
      [...plan.participants, ...extra].some((part) => !participant(part))) return null;
    const [first, ...rest] = plan.participants;
    const participants = [
      Object.freeze({ ...first, validate: () => guard() && first.validate() === true }),
      ...rest, ...extra,
    ];
    if (new Set(participants.map((part) => part.owner)).size !== participants.length ||
      participants.some((part) => this.coordinator.usage(part.owner) !== part.beforeBytes)) return null;
    return Object.freeze({
      participants: Object.freeze(participants), result: Object.freeze({ ...plan.result, ...result }),
    });
  }

  commit(plan) {
    if (!this.active || !plan) return refuse("invalid-ecology-plan");
    const committed = this.coordinator.commit(plan.participants);
    if (!committed.ok) return committed;
    this.observerErrors = committed.observerErrors.slice(-16);
    for (const error of this.observerErrors)
      if (error instanceof TransactionInvariantError) throw error;
    this._flushChanges();
    return { ...plan.result, observerErrors: this.observerErrors.slice() };
  }

  _spawnAllowed(kind, position, waking = false) {
    if (!this.active || !Object.hasOwn(ECOLOGY_SPECIES, kind)) return false;
    const { entities, maxEntities, context: ctx } = this.wildlife;
    const spec = ECOLOGY_SPECIES[kind];
    return entities.length < maxEntities &&
      (waking || entities.filter((mob) => mob.kind === kind).length < spec.limit) &&
      (spec.temperament !== "hostile" ||
        (entities.filter((mob) => mob.spec.temperament === "hostile" ||
          mob.spec.temperament === "watchful").length < MAX_HOSTILES &&
          (!(ctx.spawnProtected) || ecologyDistance(position, ctx.player) >= MIN_HOSTILE_SPAWN_DISTANCE) &&
          (waking || spec.structureOnly || ecologyDistance(position, ctx.player) >= MIN_HOSTILE_SPAWN_DISTANCE))) &&
      // Natural spacing/species caps do not strand retained babies or actors
      // that walked together before saving. Active/GPU and hostile caps remain.
      (waking || entities.every((mob) => ecologyDistance(position, mob.position) >
        spec.radius + (ecologyCollider(mob.kind, this.ecology.state(mob.id))?.radius ?? mob.spec.radius)));
  }

  habitat(position) {
    const cell = bodyAt(position);
    if (!this.world.isLoaded(cell.x, cell.z)) return null;
    if (this.hooks.readHabitat) {
      const supplied = invoke(this.hooks.readHabitat, ecologyPoint(position), this.world);
      if (!record(supplied) ||
        (supplied.homeBeach !== undefined && !finitePosition(supplied.homeBeach))) return null;
      return {
        biomeId: supplied.biomeId, blockLight: supplied.blockLight, skyLight: supplied.skyLight,
        homeBeach: supplied.homeBeach && ecologyPoint(supplied.homeBeach),
      };
    }
    const cx = Math.floor(cell.x / 16), cz = Math.floor(cell.z / 16);
    const chunk = this.world.chunks?.get(`${cx},${cz}`);
    const index = (cell.z - cz * 16) * 16 + cell.x - cx * 16;
    const biome = BIOMES[chunk?.biomes?.[index]];
    // No fabricated blockLight=0: a drowned needs a real local-light reader.
    return biome ? { biomeId: biome.id } : null;
  }

  prepareAdmission(kind, position, { structure, marker, homeBeach } = {}) {
    this._syncPlayer();
    const guard = this._guard(), player = this._playerGuard();
    if (!guard || !player || !finitePosition(position) || (marker && !finitePosition(marker.position)) ||
      (kind === "elder_guardian" && (!marker ||
        ecologyDistance(position, center(marker.position)) >= 0.01)) ||
      !this._spawnAllowed(kind, position)) return null;
    const identity = this.wildlife.nextEcologyIdentities();
    if (!identity) return null;
    if (kind === "blaze" && (!finitePosition(marker?.position) ||
      ecologyDistance(center(marker.position), this.wildlife.context.player) > 16)) return null;
    const habitat = this.habitat(position);
    const loaded = this._loadedGuard(position);
    const markerLoaded = marker ? this._loadedGuard(marker.position) : () => true;
    const beach = homeBeach ?? habitat?.homeBeach;
    if (beach !== undefined && !finitePosition(beach)) return null;
    const beachLoaded = beach ? this._loadedGuard(beach) : () => true;
    const ctx = { ...this.wildlife.context, ...habitat, structure, marker,
      homeBeach: beach && ecologyPoint(beach) };
    const hooks = { prepareSpawn: (proposal) =>
      this.wildlife.prepareEcologySpawn(proposal, { nextId: identity.nextId, validate: guard }) };
    let plan;
    if (kind === "elder_guardian") {
      const projection = ecologyEncounterProjection(marker);
      if (!isElderMarker(structure, marker) || !this.exploration || !projection ||
        this.exploration.completed(projection)) return null;
      plan = this.ecology.prepareElderAdmission(structure, marker, ctx, { ...hooks, entityId: identity.ids[0] });
    } else plan = this.ecology.prepareAdmission({ id: identity.ids[0], kind, position }, ctx, hooks);
    return this._plan(plan, () => {
      if (!guard() || !player() || !loaded() || !markerLoaded() || !beachLoaded() ||
        ctx.timeOfDay !== this.wildlife.context.timeOfDay || !this._spawnAllowed(kind, position)) return false;
      const next = this.habitat(position);
      return ["biomeId", "blockLight", "skyLight"].every((key) => next?.[key] === habitat?.[key]) &&
        (habitat?.homeBeach === undefined ? next?.homeBeach === undefined :
          ecologyDistance(habitat.homeBeach, next?.homeBeach) === 0) &&
        (kind !== "elder_guardian" || !this.exploration.completed(ecologyEncounterProjection(marker)));
    });
  }

  /** Bounded native-metadata/loaded-cell candidates; no generator queries. */
  populate() {
    this._syncPlayer();
    return populateEcology(this);
  }

  canWake(mob) {
    if (!this.active || !mob || mob.dead ||
      !this.ecology.canRestore(mob.id, mob.kind, this.world.dimension)) return false;
    const ctx = this.wildlife.context, collider = ecologyCollider(mob.kind, this.ecology.state(mob.id));
    return ecologyDistance(mob.position, ctx.player) <= 58 &&
      (!mob.dormant || this._spawnAllowed(mob.kind, mob.position, true)) &&
      !(ctx.spawnProtected && mob.spec.temperament === "hostile" &&
        ecologyDistance(mob.position, ctx.player) < MIN_HOSTILE_SPAWN_DISTANCE) &&
      ecologyCanOccupy(this.world, mob.position, collider) &&
      !!ecologyBodySample(this.world, mob.position, collider);
  }

  beginFrame(dt) {
    if (!this.active) return;
    this._syncPlayer();
    this.effects.step(dt, this._effectContext());
  }

  stepMob(mob, dt) {
    if (!this.active || !mob.spec.ecology) return;
    const ctx = this.wildlife.context, state = this.ecology.state(mob.id);
    const collider = ecologyCollider(mob.kind, state);
    for (const key of ["hitFlash", "angry", "attackCooldown"])
      mob[key] = Math.max(0, mob[key] - dt);
    if (Math.hypot(mob.knockback.x, mob.knockback.z) > 0.03) {
      moveEcologyMob(this.world, mob, {
        x: mob.knockback.x * dt, y: 0, z: mob.knockback.z * dt,
      }, { collider, locomotion: mob.spec.flying ? "flight" : "amphibious" });
      const decay = Math.exp(-8 * dt);
      mob.knockback.x *= decay;
      mob.knockback.z *= decay;
    }
    ctx.neighbors = this.wildlife.entities.filter((other) => other !== mob && other.kind === "turtle")
      .slice(0, AQUATIC_AI_LIMITS.neighbors);
    ctx.threats = this.wildlife.entities.filter((other) => other !== mob &&
      other.spec.temperament === "hostile").slice(0, AQUATIC_AI_LIMITS.neighbors);
    this.ecology.update(mob, dt, ctx);
  }

  clearIntent(mob) {
    this.ecology.clearIntent(mob, this.wildlife?.context);
    this.effects.clearSource(mob.id);
    this.attacks?.clearSource(mob.id);
  }
  clearAttacks() { this.attacks?.clear(); }

  _drops(rewards, position, dimension, reason) {
    if (!this.active || !this.overflow || dimension !== this.world.dimension) return null;
    const stacks = rewards.map(({ name, count }) => ({ id: canonicalItem(name), count }));
    if (stacks.some((stack) => stack.id === null || !Number.isSafeInteger(stack.count) || stack.count <= 0)) return null;
    const payload = Object.freeze({ stacks: Object.freeze(stacks.map(Object.freeze)),
      position: Object.freeze(ecologyPoint(position)), dimension, reason });
    const result = this.hooks.prepareDrops
      ? invoke(this.hooks.prepareDrops, payload)
      : this.overflow?.prepareEnqueue(stacks, position, dimension, { pickupDelay: 0.4 });
    return participant(result) && result.owner === this.overflow ? result : null;
  }

  _experience(amount, position, dimension) {
    if (!this.active || !this.experienceOrbs || dimension !== this.world.dimension) return null;
    const payload = Object.freeze({ amount, position: Object.freeze(ecologyPoint(position)), dimension });
    const result = this.hooks.prepareExperience
      ? invoke(this.hooks.prepareExperience, payload)
      : this.experienceOrbs?.prepareSpawn(amount, position, { pickupDelay: 0.4 });
    return participant(result) && result.owner === this.experienceOrbs ? result : null;
  }

  /** Actual hand stack, metadata and revision are pinned by Gameplay. */
  prepareInteraction(entityId, { hand = "main", participants = [], validate = () => true } = {}) {
    this._syncPlayer();
    const guard = this._guard(), mob = this.wildlife?.byId.get(entityId);
    const player = this._playerGuard();
    if (!guard || !player || !mob || !this.gameplay || !["main", "offhand"].includes(hand) ||
      !synchronousEcologyHook(validate) || invoke(validate) !== true) return null;
    const stack = this.gameplay.getHandStack(hand), handRevision = this.gameplay.getHandRevision(hand);
    const itemName = ECOLOGY_SPECIES[mob.kind]?.foodNames?.find((name) => canonicalItem(name) === stack?.id);
    if (!itemName) return null;
    const plan = this.ecology.prepareFeed(mob, itemName, this.wildlife.context, {
      prepareConsume: (name, count) => name === itemName ? this.gameplay.prepareHandCost(hand, {
        count, stack, handRevision,
      }) : null,
    });
    return this._plan(plan, () => guard() && player() && validate() === true,
      participants, { handled: true, handCostCommitted: true });
  }

  /** No damage or fake corpse is installed before ALL death owners accept.
   * Player attacks pass their prepared tool/wear participant here. Environmental
   * damage calls hurt(), never the old damage-then-drop callback path.
   */
  prepareHit(entityId, amount, direction, {
    playerKill = false, retaliate = true, hit = null, participants = [], validate,
  } = {}) {
    this._syncPlayer();
    const guard = this._guard(), mob = this.wildlife?.byId.get(entityId);
    if (!guard || !mob || !mob.spec.ecology || mob.dead || mob.dormant ||
      !Number.isFinite(amount) || amount <= 0 || typeof playerKill !== "boolean" ||
      !Array.isArray(participants) ||
      ((playerKill || validate !== undefined) && !synchronousEcologyHook(validate))) return null;
    const currentAction = validate ?? (() => true);
    const player = playerKill ? this._playerGuard() : () => true;
    if (!player || invoke(currentAction) !== true) return null;
    const dealt = Math.min(mob.health, Math.min(1000, amount));
    const loaded = this._loadedGuard(mob.position);
    const ctx = this.wildlife.context;
    const afterHit = () => {
      this.ecology.invalidateAvailability();
      this._dirty = true;
      if (hit && !mob.dead) this.ecology.retaliate(mob, { ...hit, dealt }, ctx);
      if (mob.dead) this.clearIntent(mob);
    };
    let plan;
    if (dealt < mob.health) {
      const source = this.wildlife.prepareEcologyDamage(mob, dealt, direction, {
        retaliate, validate: () => this.canWake(mob), notify: afterHit,
      });
      plan = source && { participants: [source], result: { ok: true } };
    } else plan = this.ecology.prepareDeath(mob, ctx, {
      playerKill,
      prepareRemoval: () => this.wildlife.prepareEcologyRemoval(mob, { notify: afterHit }),
      prepareDrops: (drops, at, dimension) => this._drops(drops, at, dimension, "ecology-death"),
      prepareExperience: (xp, at, dimension) => this._experience(xp, at, dimension),
      prepareUniqueCompletion: (elder) => {
        const marker = this.markers?.getMarker(elder.id);
        const structure = this.markers?.getStructure(elder.structureId);
        if (!this.exploration || !isElderMarker(structure, marker)) return null;
        const completion = this.exploration.prepareEncounterComplete(ecologyEncounterProjection(marker), {
          validate: () => guard() && this.markers.getMarker(elder.id) === marker &&
            this.markers.getStructure(elder.structureId) === structure,
        });
        const source = completion?.participants?.length === 1 ? completion.participants[0] : null;
        return participant(source) && source.owner === this.exploration ? source : null;
      },
    });
    const extra = [...participants];
    if (plan && dealt === mob.health && mob.kind === "villager" &&
      this.trading?.readRuntime(mob.id)?.jobsite && !extra.some((part) => part?.owner === this.trading)) {
      const release = invoke(this.hooks.prepareVillagerDeath, Object.freeze({
        entityId: mob.id, memberId: this.ecology.state(mob.id).memberId, dimension: this.world.dimension,
      }));
      if (!participant(release) || release.owner !== this.trading) return null;
      extra.push(release);
    }
    return this._plan(plan, () => guard() && loaded() && player() && currentAction() === true, extra, {
      handled: true, hit: true, killed: dealt === mob.health, damage: dealt, entityId: mob.id,
      dropsCommitted: true, experienceCommitted: true,
    });
  }

  hurt(mob, amount, direction, options = {}) {
    const plan = this.prepareHit(mob.id, amount, direction, { ...options, playerKill: false });
    const result = plan ? this.commit(plan) : null;
    return result?.ok ? result : { ...result, hit: false, killed: false, damage: 0 };
  }

  eggPresent(egg) {
    if (!this.active || egg.dimension !== this.world.dimension ||
      !Object.values(egg.position).every(Number.isSafeInteger)) return false;
    return readGeometryCell(this.world, egg.position.x, egg.position.y, egg.position.z)?.id === BLOCK.TURTLE_EGG;
  }

  _eggChanges(egg, remove) {
    if (!this.active || !Number.isInteger(BLOCK.TURTLE_EGG)) return null;
    const { x, y, z } = egg.position;
    if (![x, y, z].every(Number.isSafeInteger)) return null;
    const before = readGeometryCell(this.world, x, y, z);
    const floor = readGeometryCell(this.world, x, y - 1, z);
    if (!before || !floor || (remove ? before.id !== BLOCK.TURTLE_EGG :
      before.id !== BLOCK.AIR || before.fluid !== FLUID.NONE || floor.id !== BLOCK.SAND)) return null;
    return {
      changes: [{
        x, y, z, before, after: { id: remove ? BLOCK.AIR : BLOCK.TURTLE_EGG, state: 0, fluid: FLUID.NONE },
      }],
      reads: [{ x, y: y - 1, z, before: floor }],
    };
  }

  _eggMutation(egg, remove) {
    const cells = this._eggChanges(egg, remove);
    return cells ? this.world.prepareMutation(cells.changes, { reads: cells.reads }) : null;
  }

  prepareLayEgg(entityId) {
    const guard = this._guard(), mob = this.wildlife?.byId.get(entityId);
    const state = this.ecology.state(entityId);
    if (!guard || !mob || state?.kind !== "turtle" || !state.gravid) return null;
    const identity = this.wildlife.nextEcologyIdentities(2);
    if (!identity) return null;
    const position = bodyAt(state.homeBeach);
    const plan = this.ecology.prepareLayEgg(mob, {
      eggId: identity.ids[0], childId: identity.ids[1], position,
    }, this.wildlife.context, { preparePlaceEgg: (egg) => this._eggMutation(egg, false) });
    const counter = this.wildlife.prepareEcologyCounter(identity.nextId, guard);
    return this._plan(plan, guard, [counter]);
  }

  prepareBreakEgg(position, options = {}) {
    return this.prepareBreakEggs([position], options);
  }

  /** Mining/trampling/explosions call this BEFORE changing any egg cell.
   * Pass only owned egg positions; other destruction joins prepareRemoveEggs.
   */
  prepareBreakEggs(positions, {
    participants = [], validate = () => true, prepareRemoveEggs,
  } = {}) {
    const guard = this._guard();
    if (!guard || !Array.isArray(positions) || !positions.length ||
      positions.length > ECOLOGY_LIMITS.eggBatch ||
      positions.some((position) => !finitePosition(position) ||
        ![position.x, position.y, position.z].every(Number.isSafeInteger)) ||
      !synchronousEcologyHook(validate) ||
      (prepareRemoveEggs !== undefined && !synchronousEcologyHook(prepareRemoveEggs))) return null;
    const eggs = positions.map((position) => this.ecology.eggAt(this.world.dimension, position));
    if (eggs.some((egg) => !egg)) return null;
    const plan = this.ecology.prepareBreakEggs(eggs.map((egg) => egg.id), this.wildlife.context, {
      prepareRemoveEggs: (values) => {
        const cells = values.map((egg) => this._eggChanges(egg, true));
        if (cells.some((cell) => !cell)) return null;
        const changes = cells.flatMap((cell) => cell.changes), reads = cells.flatMap((cell) => cell.reads);
        const payload = Object.freeze({
          eggs: values, dimension: this.world.dimension,
          changes: Object.freeze(changes.map((change) => Object.freeze({
            ...change, before: Object.freeze(change.before), after: Object.freeze(change.after),
          }))),
          reads: Object.freeze(reads.map((read) => Object.freeze({ ...read, before: Object.freeze(read.before) }))),
        });
        const removal = prepareRemoveEggs ? invoke(prepareRemoveEggs, payload)
          : this.world.prepareMutation(changes, { reads });
        return participant(removal) && removal.owner === this.world ? removal : null;
      },
    });
    return this._plan(plan, () => guard() && validate() === true, participants, { handled: true });
  }

  _hatch(egg) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const at = { x: egg.position.x + 0.5 + dx, y: egg.position.y, z: egg.position.z + 0.5 + dz };
      const plan = this.ecology.prepareHatch(egg.id, at, this.wildlife.context, {
        prepareRemoveEgg: (value) => this._eggMutation(value, true),
        prepareSpawn: (value) => this.wildlife.prepareEcologySpawn(value),
      });
      if (plan && this.commit(plan).ok) return true;
    }
    return false;
  }

  stepWorld(dt) {
    if (!this.active || !Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, AQUATIC_AI_LIMITS.step);
    this._clock += dt;
    this.attacks.update(dt);
    const ctx = this.wildlife.context;
    const ids = this.ecology.eggIds(this._eggCursor, ECOLOGY_HOST_LIMITS.eggsPerStep);
    this._eggCursor += ids.length;
    for (const id of ids) {
      const egg = this.ecology.egg(id);
      if (!egg || egg.status !== "incubating" || egg.dimension !== this.world.dimension ||
        ecologyDistance(egg.position, ctx.player) > 58 || !this.eggPresent(egg)) {
        this._eggSeen.delete(id);
        continue;
      }
      const key = `${Math.floor(egg.position.x / 16)},${Math.floor(egg.position.z / 16)}`;
      const incarnation = this.world.chunks?.get(key)?.incarnation;
      const previous = this._eggSeen.get(id);
      const elapsed = previous?.epoch === this.world.epoch && previous.incarnation === incarnation
        ? this._clock - previous.clock : dt;
      this._eggSeen.set(id, { epoch: this.world.epoch, incarnation, clock: this._clock });
      if (egg.remaining > 0) {
        const progress = this.ecology.prepareEggProgress(id, elapsed, ctx);
        if (progress) this.coordinator.commit([progress]);
      }
      if (this.ecology.egg(id).remaining === 0) this._hatch(this.ecology.egg(id));
    }
    const turtles = this.wildlife.entities.filter((mob) => mob.kind === "turtle" && !mob.dormant);
    for (let i = 0; i < Math.min(turtles.length, ECOLOGY_HOST_LIMITS.lifecyclePerStep); i++) {
      const mob = turtles[(this._lifecycleCursor + i) % turtles.length];
      const state = this.ecology.state(mob.id);
      if (!state.scuteClaimed && state.growthRemaining === 0) {
        const growth = this.ecology.prepareGrowth(mob, ctx, {
          prepareDrops: (drops, at, dimension) => this._drops(drops, at, dimension, "turtle-growth"),
        });
        if (growth) this.commit(growth);
      } else if (state.gravid) {
        const lay = this.prepareLayEgg(mob.id);
        if (lay) this.commit(lay);
      } else if (state.loveTime > 0) {
        const mate = turtles.find((other) => other !== mob &&
          this.ecology.state(other.id)?.loveTime > 0 && ecologyDistance(mob.position, other.position) <= 2);
        if (mate) {
          const breed = this.ecology.prepareBreeding(mob, mate, ctx);
          if (breed) this.commit(breed);
        }
      }
    }
    this._lifecycleCursor += ECOLOGY_HOST_LIMITS.lifecyclePerStep;
  }

  assignment(entityId) {
    if (!this.active) return null;
    if (this.hooks.getVillagerAssignment) return invoke(this.hooks.getVillagerAssignment, entityId);
    const state = this.ecology.state(entityId);
    if (state?.kind !== "villager") return null;
    const member = this.markers?.getMarker(state.memberId);
    const home = this.markers?.getMarker(member?.homeId);
    const site = this.markers?.getMarker(member?.jobSiteId);
    const initial = villagerAssignmentFromMarkers(member, home, site, this.context,
      this.trading?.revision ?? 0, entityId);
    const trader = this.trading?.readRuntime(entityId);
    return trader ? villagerAssignmentFromTrader(trader, {
      entityId, structureId: member?.structureId, home: initial?.home ?? null,
      revision: this.trading.revision,
    }, this.context) : initial;
  }

  jobsitePresent(assignment, proposed) {
    if (!this.active || !assignment?.jobSite) return false;
    if (this.hooks.jobsitePresent)
      return invoke(this.hooks.jobsitePresent, assignment, proposed) === true;
    const jobsite = proposed ?? this.trading?.readRuntime(assignment.id)?.jobsite;
    if (jobsite) {
      if (jobsite.id !== assignment.jobSite.id || jobsite.dimension !== this.world.dimension ||
        !finitePosition(jobsite.position) ||
        ecologyDistance(center(jobsite.position), assignment.jobSite.position) > 0.01 ||
        !Object.hasOwn(BLOCK, jobsite.kind)) return false;
      const at = jobsite.position;
      return readGeometryCell(this.world, at.x, at.y, at.z)?.id === BLOCK[jobsite.kind];
    }
    const state = this.ecology.state(assignment.id);
    const member = this.markers?.getMarker(state?.memberId);
    const site = this.markers?.getMarker(member?.jobSiteId);
    if (!site || site.type !== "job_site" || site.memberId !== state.memberId ||
      site.profession !== assignment.profession ||
      ecologyDistance(center(site.position), assignment.jobSite.position) > 0.01) return false;
    const at = site.position, cell = readGeometryCell(this.world, at.x, at.y, at.z);
    return !!cell && Number.isInteger(BLOCK[site.block]) && cell.id === BLOCK[site.block];
  }

  readAvailability(entityId, options) {
    if (!this.active) return {
      adult: true, alive: false, nitwit: false, available: false,
      dimension: this.world.dimension, revision: this.ecology.revision,
    };
    return this.ecology.readAvailability(entityId, this._readContext(), options);
  }
  captureTrade(entityId) {
    const mob = this.wildlife?.byId.get(entityId);
    const captured = this.active ? captureVillagerTrade(mob, this._readContext()) : null;
    if (!captured) return null;
    const guard = this._guard(), loaded = this._loadedGuard(mob.position);
    const player = this._playerGuard(), revision = this.ecology.revision;
    return player && Object.freeze({ ...captured,
      validate: () => guard() && loaded() && player() &&
        this.ecology.revision === revision && captured.validate(),
    });
  }
  jobsiteUsable(entityId, jobsite) {
    return this.active && villagerJobsiteUsable(this.wildlife.byId.get(entityId), jobsite, this._readContext());
  }
  modifiers() {
    this.effects.step(0, this._effectContext());
    return this.effects.modifiers();
  }

  /** Forward already-published World events; no subscription or terrain edits.
   * Prepared trade availability must become stale even before the next AI tick.
   */
  onMutation(world, event) {
    if (world !== this.world || !this.active || event?.epoch !== world.epoch ||
      event.dimension !== world.dimension) return false;
    this.ecology.invalidateAvailability();
    return true;
  }
  onChunkAdmitted(world, event) {
    if (world !== this.world || !this.active || event?.world !== this.world ||
      event.epoch !== this.world.epoch || event.dimension !== world.dimension ||
      this.world.chunks?.get(event.key) !== event.chunk ||
      event.chunk?.incarnation !== event.incarnation) return false;
    this.ecology.invalidateAvailability();
    return true;
  }
  onChunkLoaded(world, event) { return this.onChunkAdmitted(world, event); }

  _observe(callback, ...args) {
    try { callback?.(...args); }
    catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      this.observerErrors.push(error);
      if (this.observerErrors.length > 16) this.observerErrors.shift();
    }
  }
  _flushChanges() {
    if (!this._dirty) return;
    this._dirty = false;
    this._observe(this.hooks.onChange);
  }
  render(anchor) {
    if (!this.active) return;
    this._syncPlayer();
    this.attacks.render(anchor);
    const modifiers = this.modifiers();
    if (!this._lastModifiers || Object.keys(modifiers).some((key) =>
      modifiers[key] !== this._lastModifiers[key])) {
      this._lastModifiers = modifiers;
      this._observe(this.hooks.onEffectsChanged, modifiers);
    }
    this._flushChanges();
  }

  serialize() {
    if (!this._ownersCurrent()) throw new Error("Cannot serialize stale ecology services");
    const mobsByDimension = { ...this._savedMobs };
    if (this.wildlife && !this.wildlife.disposed)
      mobsByDimension[this.wildlife.dimension] = this.wildlife.serialize();
    return normalizeEcologyServicesSnapshot({
      version: 1, ecology: this.ecology.serialize(), mobsByDimension,
    }, this.context);
  }

  suspend() {
    if (!this.wildlife) return true;
    const wildlife = this.wildlife;
    const snapshot = wildlife.serialize();
    if (wildlife.coordinator !== this.coordinator ||
        this.coordinator.usage(wildlife) !== 0) return false;
    this._savedMobs[wildlife.dimension] = snapshot;
    for (const mob of wildlife.byId.values())
      if (mob.spec.ecology) this.clearIntent(mob);
    this.effects.clear();
    this.attacks.dispose();
    this.attacks = null;
    wildlife.ecologyServices = null;
    this.wildlife = null;
    this._candidate = null;
    this._revision++;
    this._eggSeen.clear();
    this.ecology.invalidateAvailability();
    this._lastModifiers = null;
    this._observe(this.hooks.onEffectsChanged, this.effects.modifiers());
    return true;
  }

  dispose() {
    if (this._disposed) return true;
    if (!this.suspend() || !this.ecology.dispose()) return false;
    this.effects.dispose();
    this._disposed = true;
    this._revision++;
    return true;
  }
}
