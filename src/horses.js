import { sweepCameraDistance } from "./collision.js";
import { captureEntityContext, entityContextFor, matchesEntityContext } from "./entity-context.js";
import {
  HORSE_ACTIVE_DISTANCE, HORSE_HEADER_RESERVED_BYTES, HORSE_TAMING_TICKS,
  MAX_LIVING_HORSES, MAX_RETAINED_HORSE_IDS,
  createHorseView, horseHeading, horseId, horsePoint, horseRecordBytes, horseSeat, horseSynchronous,
} from "./horse-definitions.js";
import { horseClear, horseEnvironment } from "./horse-collision.js";
import {
  cloneHorseRecord, emptyHorseSnapshot, normalizeHorseRecord, normalizeHorseSnapshot,
} from "./horse-save.js";
import {
  contributeHorseHit, prepareHorseFeed, prepareHorseHit, prepareHorseInteraction, prepareHorseSlotAction,
} from "./horse-actions.js";
import {
  prepareHorseDismount, prepareHorseMount, prepareHorsePassengerRelease, updateHorses,
} from "./horse-riding.js";
import { isValidStack } from "./inventory-slots.js";
import { stackIdentity } from "./item-stack-data.js";
import { normalizeMobSnapshot } from "./mob-save.js";
import { TransactionCoordinator, TransactionInvariantError } from "./transactions.js";
import { commitVehicleSnapshots, prepareVehicleSnapshot } from "./vehicle-load.js";
import { finitePoint } from "./vehicle-water.js";

export { horseInput } from "./horse-definitions.js";
export { emptyHorseSnapshot, horseMobLinksValid, normalizeHorseSnapshot } from "./horse-save.js";

export const horseRefused = (reason) => ({ ok: false, handled: true, reason });
const samePoint = (a, b) => a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export function freezeHorseValue(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeHorseValue(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Third vehicle leaf. Wildlife owns ALL base identity/pose/health/model state.
 *
 * new Horses(null, world, {gameplay, coordinator=world.coordinator, context,
 *   readOwner(ownerId,hand), canMount(ownerId,horseId), available(),
 *   prepareHandCost(request), prepareDrops(request), prepareExperience(request),
 *   overflow?, experienceOrbs?, sampleFluid(world,point), identityReserved(id),
 *   onEvent(event), onChange(), allowOverBudget=false})
 *
 * Hooks are synchronous. canMount checks the OTHER vehicle owner, and is checked
 * during preparation AND validation. Missing mount guards refuse mounting.
 * Resource hooks return ONE registered participant each, never a commit/result.
 * Supplying overflow/experienceOrbs pins hook results to those exact owners.
 *
 * Prepare APIs return {ok:true,handled:true,action,id,participants,...receipt} or
 * {ok:false,handled:true,reason}. commit(plan) removes participants and returns
 * that receipt plus {ok,observerErrors}. Parent may instead compose the list
 * with other owners and commit ONCE. Never run legacy Wildlife actions first.
 * contributeHit(batch,...) returns an incomplete token and opaque peer tokens,
 * not a plan; finalize them with Wildlife before attempting a complete commit.
 *
 * Load sidecar while detached, restore Wildlife ONCE with {horses:serialize()},
 * then bindWildlife(). No base snapshots are stored in this leaf.
 * Parent owns canonical all-dimension/compatibility link preflight.
 */
export class Horses {
  constructor(scene, world, {
    gameplay, coordinator = world?.coordinator, context = world,
    readOwner, canMount, available, prepareHandCost, prepareDrops, prepareExperience,
    overflow, experienceOrbs, sampleFluid, identityReserved, onEvent, onChange,
    allowOverBudget = false,
  } = {}) {
    if (scene !== null && scene !== undefined)
      throw new TypeError("Horse rendering belongs to Wildlife, not another scene owner");
    const hooks = { readOwner, canMount, available, prepareHandCost, prepareDrops,
      prepareExperience, sampleFluid, identityReserved, onEvent, onChange };
    if (!world || !(coordinator instanceof TransactionCoordinator) || coordinator !== world.coordinator ||
      !gameplay || gameplay.coordinator !== coordinator || coordinator.usage(gameplay) === undefined ||
      !horseSynchronous(gameplay.prepareInventory) || !horseSynchronous(gameplay.getHandStack) ||
      !horseSynchronous(gameplay.getHandRevision) ||
      typeof allowOverBudget !== "boolean" ||
      Object.values(hooks).some((hook) => hook !== undefined && !horseSynchronous(hook)) ||
      [overflow, experienceOrbs].some((owner) => owner &&
        (owner._disposed || owner.coordinator !== coordinator || coordinator.usage(owner) === undefined ||
          !matchesEntityContext(world, owner.context) ||
          (owner.world !== undefined && owner.world !== world))))
      throw new TypeError("Horses requires shared real ownership and synchronous hooks");
    this.world = world;
    this.context = entityContextFor(world, context);
    if (!matchesEntityContext(world, this.context) || !matchesEntityContext(world, gameplay.context))
      throw new RangeError("Horse owner context belongs to another world");
    this.coordinator = coordinator;
    this.gameplay = gameplay;
    this.overflow = overflow;
    this.experienceOrbs = experienceOrbs;
    this.hooks = Object.freeze(hooks);
    this._gameplayContext = gameplay.context;
    this._bindings = Object.freeze({ world, gameplay, coordinator, context: this.context,
      overflow, experienceOrbs, hooks: this.hooks });
    this.wildlife = null;
    this._entries = new Map();
    this._living = new Map();
    this._revision = 0;
    this._bytes = HORSE_HEADER_RESERVED_BYTES;
    this._disposed = this._preparing = this._reading = this._updating = false;
    this._claims = new Set();
    this._frameId = null;
    this._autoFrame = 0;
    this._pendingExit = null;
    this._input = null;
    this._strides = new Map();
    if (!normalizeHorseSnapshot(emptyHorseSnapshot(this.context), this.context) ||
      !coordinator.register(this, this._bytes, { allowOverBudget }))
      throw new RangeError("Cannot reserve horse archive header");
  }

  get size() { return this._entries.size; }
  get livingSize() { return this._living.size; }
  get activeSize() {
    let size = 0;
    for (const entry of this._living.values()) if (entry.dimension === this.world.dimension) size++;
    return size;
  }
  get revision() { return this._revision; }
  get reservedBytes() { return this._bytes; }

  _worldReady() {
    return !this._disposed &&
      Object.entries(this._bindings).every(([key, value]) => this[key] === value) &&
      this.world.coordinator === this.coordinator && !this.gameplay._disposed &&
      this.gameplay.coordinator === this.coordinator && this.gameplay.context === this._gameplayContext &&
      this.coordinator.usage(this.gameplay) !== undefined &&
      this.coordinator.usage(this) === this._bytes &&
      matchesEntityContext(this.world, this.context) &&
      matchesEntityContext(this.world, this.gameplay.context);
  }

  get active() {
    const wildlife = this.wildlife;
    return this._worldReady() && !!wildlife && !wildlife.disposed &&
      wildlife.horseServices === this && wildlife.world === this.world &&
      wildlife.dimension === this.world.dimension && wildlife.coordinator === this.coordinator &&
      wildlife._ownsRegistration && this.coordinator.usage(wildlife) === 0 &&
      this._bindingEpoch === (this.world.epoch ?? this.world._epoch);
  }

  _ready(loading = false) {
    return !this._preparing && !this._reading && this._worldReady() &&
      (loading || (this.active &&
        (this.hooks.available === undefined || this._invoke(this.hooks.available) === true)));
  }

  _invoke(callback, ...args) {
    if (!horseSynchronous(callback)) return null;
    try {
      const result = callback(...args);
      return result && typeof result.then === "function" ? null : result;
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    }
  }

  _callback(name, payload, owner) {
    this._preparing = true;
    try {
      const participant = this._invoke(this.hooks[name], freezeHorseValue(payload));
      return this._validParticipant(participant) && (!owner || participant.owner === owner) ? participant : null;
    } finally {
      this._preparing = false;
    }
  }

  _validParticipant(participant) {
    return !!participant && horseSynchronous(participant.validate) && horseSynchronous(participant.publish) &&
      (participant.notify === undefined || horseSynchronous(participant.notify)) &&
      this.coordinator.usage(participant.owner) === participant.beforeBytes &&
      participant.beforeBytes !== undefined &&
      (participant.owner.coordinator === undefined || participant.owner.coordinator === this.coordinator);
  }

  _inventory(edit) {
    this._preparing = true;
    try {
      const participant = this.gameplay.prepareInventory(edit, { notify: false });
      return this._validParticipant(participant) && participant.owner === this.gameplay ? participant : null;
    } finally {
      this._preparing = false;
    }
  }

  _actor(ownerId = "player", hand = "main", { allowDead = false } = {}) {
    if (ownerId !== "player" || !["main", "offhand"].includes(hand) || this._reading) return null;
    this._reading = true;
    let value;
    try { value = this._invoke(this.hooks.readOwner, ownerId, hand); }
    finally { this._reading = false; }
    if (!value || (!allowDead && (value.dead || this.gameplay.dead)) ||
      value.dimension !== this.world.dimension || !finitePoint(value.position)) return null;
    const pose = this.riderPose(ownerId) ?? this._pendingExit;
    const position = horsePoint(pose?.position ?? value.position);
    return {
      ...value, position,
      eye: pose ? { ...position, y: position.y + 1.62 } :
        finitePoint(value.eye) ? horsePoint(value.eye) : { ...position, y: position.y + 1.62 },
      stack: this.gameplay.getHandStack(hand),
      handRevision: this.gameplay.getHandRevision(hand),
      slotKey: hand === "main" ? `inventory:${this.gameplay.selected}` : "offhand:0",
    };
  }

  _actorGuard(ownerId, hand, actor, held = false) {
    const stack = actor.stack;
    const identity = stack ? stackIdentity(stack, this.context) : null;
    return () => {
      const current = this._actor(ownerId, hand);
      return !!current && samePoint(current.position, actor.position) && samePoint(current.eye, actor.eye) &&
        current.targetKey === actor.targetKey && current.poseRevision === actor.poseRevision &&
        (!held || (current.handRevision === actor.handRevision &&
          (stack === null ? current.stack === null :
            isValidStack(current.stack, this.context) &&
            stackIdentity(current.stack, this.context) === identity &&
            current.stack.count === stack.count && current.stack.durability === stack.durability)));
    };
  }

  _base(id, dormant = false) {
    if (!this.active || !horseId(id)) return null;
    const mob = this.wildlife.byId.get(id);
    return mob?.kind === "horse" && !mob.dead && mob.health > 0 &&
      (dormant || !mob.dormant) ? mob : null;
  }

  _reachable(actor, mob) {
    const target = { ...horsePoint(mob.position), y: mob.position.y + 1.4 };
    if (!actor || distance(actor.eye, target) > 6) return false;
    const direction = { x: target.x - actor.eye.x, y: target.y - actor.eye.y, z: target.z - actor.eye.z };
    const length = Math.hypot(direction.x, direction.y, direction.z);
    return length < 0.01 ||
      sweepCameraDistance(this.world, actor.eye, direction, length, 0.02) >= length - 0.04;
  }

  _canMount(ownerId, id) { return this._invoke(this.hooks.canMount, ownerId, id) === true; }

  _newRecord(mob) {
    const previous = this._entries.get(mob.id);
    if (previous) return previous.alive && previous.dimension === this.world.dimension
      ? cloneHorseRecord(previous, this.context) : null;
    if (this.livingSize >= MAX_LIVING_HORSES || this.size >= MAX_RETAINED_HORSE_IDS ||
      this.wildlife.ecologyServices?.ecology.identityReserved(mob.id) ||
      (this.hooks.identityReserved && this._invoke(this.hooks.identityReserved, mob.id) !== false)) return null;
    return { id: mob.id, dimension: this.world.dimension, alive: true,
      tamed: false, temper: 0, failedAttempts: 0, saddle: null, rider: null,
      tamingTicksLeft: HORSE_TAMING_TICKS, motion: null };
  }

  identityReserved(id) { return this._entries.has(id); }
  retainsMob(mob) {
    const entry = this._living.get(typeof mob === "string" ? mob : mob?.id);
    return !!entry && entry.dimension === this.world.dimension;
  }
  canRestore(id, kind, dimension) {
    const state = this._living.get(id);
    return kind === "horse" && !!state && state.dimension === dimension;
  }

  state(id) {
    const entry = this._entries.get(id);
    return entry ? freezeHorseValue(cloneHorseRecord(entry, this.context)) : null;
  }

  getHorse(id) {
    const entry = this._entries.get(id), mob = this._base(id, true);
    if (!entry) return null;
    return freezeHorseValue({
      ...cloneHorseRecord(entry, this.context),
      ...(mob ? { position: horsePoint(mob.position), yaw: mob.root.rotation.y,
        health: mob.health, maxHealth: mob.spec.health, dormant: mob.dormant === true } : {}),
      saddled: !!entry.saddle, controlled: !!(entry.tamed && entry.saddle && entry.rider),
      jumpCharge: this._input?.id === id ? this._input.charge : 0,
    });
  }

  /** Small read-only presentation projection; never an additional pose owner.
   * Wildlife refreshes this before animation AND part picking. The bounded
   * fluid query reads admitted cells only; no save serialization.
   */
  presentation(id) {
    const entry = this._living.get(id), mob = this._base(id, true);
    if (!entry || !mob) return null;
    return createHorseView(entry, horseEnvironment(this.world, mob.position, this.hooks.sampleFluid));
  }

  mountFor(ownerId = "player") {
    for (const entry of this._living.values())
      if (entry.rider === ownerId) return { vehicleType: "horse", id: entry.id, dimension: entry.dimension };
    return null;
  }

  needsDeparture(ownerId = "player") {
    return this.mountFor(ownerId) !== null || (ownerId === "player" && this._pendingExit !== null);
  }

  riderPose(ownerId = "player") {
    const mount = this.mountFor(ownerId);
    if (!mount || mount.dimension !== this.world.dimension) return null;
    const mob = this._base(mount.id, true), entry = this._living.get(mount.id);
    if (!mob) return null;
    return {
      ...mount, position: horseSeat(mob.position),
      velocity: { x: entry.motion.vx, y: entry.motion.vy, z: entry.motion.vz },
      hullYaw: horseHeading(mob.root.rotation.y - Math.PI), seated: true, grounded: false,
    };
  }

  poseForArchive(ownerId = "player") {
    return this.riderPose(ownerId) ?? (this._pendingExit ? structuredClone(this._pendingExit) : null);
  }
  takeExitPose() {
    const result = this._pendingExit;
    this._pendingExit = null;
    return result ? structuredClone(result) : null;
  }

  /** Call once at the START of every Game frame, even when no rider remains.
   * update(...,{frameId}) uses the same token. Late mount/dismount claims remain
   * visible through that frame's Wildlife AI pass; never clear them on release.
   */
  beginFrame(frameId = ++this._autoFrame) {
    if (frameId === this._frameId) return;
    this._frameId = frameId;
    this._claims.clear();
    for (const entry of this._living.values())
      if (entry.dimension === this.world.dimension && (entry.rider || entry.motion))
        this._claims.add(entry.id);
  }
  ownsMotionThisFrame(mob) {
    if (!this.active) return false;
    const id = typeof mob === "string" ? mob : mob?.id, entry = this._living.get(id);
    return this._claims.has(id) || !!(entry && entry.dimension === this.world.dimension &&
      (entry.rider !== null || entry.motion !== null));
  }

  canWake(mob) {
    return this.active && !mob.dead && this.canRestore(mob.id, mob.kind, this.world.dimension) &&
      (!this.wildlife.hasPlayer || distance(mob.position, this.wildlife.player) <= HORSE_ACTIVE_DISTANCE) &&
      horseClear(this.world, mob.position, this._living.get(mob.id).rider !== null);
  }

  _notify(events) {
    const errors = [];
    for (const event of events) {
      try { this.hooks.onEvent?.(event); } catch (error) { errors.push(error); }
    }
    try { this.hooks.onChange?.(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Horse observers failed after commit");
  }

  _prepareRecord(id, value, {
    validate = () => true, events = [], exit, clearExit = false,
    claim = false, resetInput = false, trustedMotion = false, input, stride, environment,
  } = {}) {
    if (!this._ready() || !horseSynchronous(validate)) return null;
    // Trusted motion is produced only by the bounded pure physics/taming path.
    // It never serializes records, inventories or complete saves in the frame.
    const next = trustedMotion ? cloneHorseRecord(value, this.context) : normalizeHorseRecord(value, this.context);
    const before = this._entries.get(id);
    if (!next || next.id !== id || (before && (!before.alive || next.dimension !== before.dimension)) ||
      (!before && (this.size >= MAX_RETAINED_HORSE_IDS ||
        (next.alive && this.livingSize >= MAX_LIVING_HORSES)))) return null;
    const entries = this._entries, living = this._living, revision = this._revision;
    const beforeBytes = this._bytes, afterBytes = beforeBytes + horseRecordBytes(next) - horseRecordBytes(before);
    const current = captureEntityContext(this.world, this.context), wildlife = this.wildlife;
    const mob = wildlife.byId.get(id);
    // Prepare the immutable projection now; publication only installs it, so
    // even an earlier owner's observer sees committed tack/rider/motion state.
    // Motion callers reuse their bounded solver result rather than resampling.
    const view = mob && next.alive
      ? createHorseView(next, environment ?? horseEnvironment(this.world, mob.position, this.hooks.sampleFluid)) : null;
    const notices = events.map((event) => freezeHorseValue(structuredClone(event)));
    const pendingExit = exit ? freezeHorseValue(structuredClone(exit)) : null;
    let used = false;
    return Object.freeze({
      owner: this, beforeBytes, afterBytes,
      validate: () => !used && this._ready() && this.wildlife === wildlife &&
        this._entries === entries && this._living === living && this._revision === revision &&
        this._bytes === beforeBytes && entries.get(id) === before && current() &&
        (!before || before.alive) && validate() === true,
      publish: () => {
        used = true;
        entries.set(id, next);
        if (next.alive) living.set(id, next);
        else living.delete(id);
        this._bytes = afterBytes;
        this._revision++;
        if (claim || before?.rider || next.rider) this._claims.add(id);
        // Ownership of this exit exists BEFORE any observer/parent save runs.
        if (pendingExit) this._pendingExit = pendingExit;
        else if (clearExit) this._pendingExit = null;
        if (input !== undefined) this._input = input;
        if (stride !== undefined) this._strides.set(id, stride);
        // Another tracked horse can be hurt or finish an airborne handoff while
        // the sole rider charges a jump. Its edit cannot reset that rider's input.
        if (this._input?.id === id && (resetInput || !next.alive || !next.rider || !next.saddle))
          this._input = null;
        if (!next.alive) this._strides.delete(id);
        if (mob) mob.horseView = view;
      },
      notify: () => this._notify(notices),
    });
  }

  _plan(action, id, participants, receipt = {}) {
    if (!Array.isArray(participants) || !participants.length ||
      participants.some((part) => !this._validParticipant(part)) ||
      new Set(participants.map((part) => part.owner)).size !== participants.length)
      return horseRefused("invalid-or-duplicate-owner");
    return Object.freeze({ ok: true, handled: true, action, id, ...receipt,
      participants: Object.freeze(participants) });
  }

  commit(plan) {
    if (plan?.complete === false) return horseRefused("incomplete-resident-contribution");
    if (!plan?.ok || !Array.isArray(plan.participants)) return plan ?? horseRefused("invalid-plan");
    const result = this.coordinator.commit(plan.participants);
    if (!result.ok) return { ...result, handled: true };
    const { participants, ...receipt } = plan;
    return { ...receipt, ...result };
  }

  prepareTrack(id, { ownerId = "player" } = {}) {
    if (!this._ready()) return horseRefused("unavailable");
    const mob = this._base(id), actor = this._actor(ownerId);
    if (!mob || !this._reachable(actor, mob)) return horseRefused("inactive-or-out-of-reach");
    const next = this._newRecord(mob);
    if (!next) return horseRefused("horse-capacity-or-reserved-id");
    const guard = this._actorGuard(ownerId, "main", actor);
    const base = this.wildlife.prepareHorseEdit(mob, { retain: true });
    const own = this._prepareRecord(id, next, { validate: () => guard() && this._reachable(actor, mob) });
    return this._plan("track", id, [own, base]);
  }
  track(id, options) { return this.commit(this.prepareTrack(id, options)); }
  prepareMount(id, ownerId = "player", options) { return prepareHorseMount(this, id, ownerId, options); }
  mount(id, ownerId, options) { return this.commit(this.prepareMount(id, ownerId, options)); }
  prepareDismount(ownerId = "player", options) { return prepareHorseDismount(this, ownerId, options); }
  dismount(ownerId, options) { return this.commit(this.prepareDismount(ownerId, options)); }
  preparePassengerRelease(ownerId = "player", options) {
    return prepareHorsePassengerRelease(this, ownerId, options);
  }
  releasePassenger(ownerId, options) { return this.commit(this.preparePassengerRelease(ownerId, options)); }
  prepareFeed(id, options) { return prepareHorseFeed(this, id, options); }
  feed(id, options) { return this.commit(this.prepareFeed(id, options)); }
  prepareInteraction(id, options) { return prepareHorseInteraction(this, id, options); }
  interact(id, options) { return this.commit(this.prepareInteraction(id, options)); }
  prepareSlotAction(id, action, options) { return prepareHorseSlotAction(this, id, action, options); }
  slotAction(id, action, options) { return this.commit(this.prepareSlotAction(id, action, options)); }
  prepareHit(id, amount, direction, options) { return prepareHorseHit(this, id, amount, direction, options); }
  contributeHit(batch, id, amount, direction, options) {
    return contributeHorseHit(this, batch, id, amount, direction, options);
  }
  hurt(mob, amount, direction, options = {}) {
    const result = this.commit(this.prepareHit(typeof mob === "string" ? mob : mob.id, amount,
      direction, { ...options, playerKill: false }));
    return result.ok ? result : { ...result, hit: false, killed: false, damage: 0 };
  }
  update(dt, options) { return updateHorses(this, dt, options); }
  resetInput() { this._input = null; this._revision++; }

  bindWildlife(wildlife) {
    if (!this._ready(true) || this._updating || this.wildlife ||
      !wildlife || wildlife.disposed || wildlife.horseServices ||
      wildlife.world !== this.world || wildlife.dimension !== this.world.dimension ||
      wildlife.coordinator !== this.coordinator || !wildlife._ownsRegistration ||
      this.coordinator.usage(wildlife) !== 0) return false;
    const snapshot = normalizeMobSnapshot(wildlife.serialize(), this.context, wildlife.dimension,
      { horses: this.serialize() });
    if (!snapshot || [...wildlife._retainedHorseIds].some((id) => !this.canRestore(id, "horse", wildlife.dimension)))
      return false;
    const retained = new Set([...this._living.values()].filter((entry) =>
      entry.dimension === wildlife.dimension).map((entry) => entry.id));
    if (retained.size !== wildlife._retainedHorseIds.size) return false;
    this.wildlife = wildlife;
    wildlife.horseServices = this;
    this._bindingEpoch = this.world.epoch ?? this.world._epoch;
    this._revision++;
    this._frameId = null;
    this._claims.clear();
    this.resetInput();
    wildlife.refreshHorseViews();
    return true;
  }

  /** Parent captures the ONE canonical Wildlife snapshot before suspending. */
  suspend() {
    if (!this.wildlife) return true;
    if (this._preparing || this._updating ||
      [...this._living.values()].some((entry) => entry.rider !== null &&
        entry.dimension === this.wildlife.dimension)) return false;
    if (this.wildlife.horseServices !== this) return false;
    this.wildlife.clearHorseViews();
    this.wildlife.horseServices = null;
    this.wildlife = null;
    this._revision++;
    this._pendingExit = null;
    this._claims.clear();
    this.resetInput();
    return true;
  }

  serialize() {
    if (!this._worldReady()) throw new Error("Cannot serialize stale horse ownership");
    return { ...emptyHorseSnapshot(this.context),
      entries: [...this._entries.values()].map((entry) => cloneHorseRecord(entry, this.context)) };
  }

  prepareLoad(data) {
    if (!this._ready(true) || this.wildlife || this._updating) return null;
    const next = normalizeHorseSnapshot(data, this.context);
    if (!next) return null;
    const entries = new Map(next.entries.map((entry) => [entry.id, entry]));
    // A reused owner cannot forget permanent IDs or resurrect a tombstone.
    for (const before of this._entries.values()) {
      const after = entries.get(before.id);
      if (!after || after.dimension !== before.dimension || (!before.alive && after.alive)) return null;
    }
    const rider = next.entries.find((entry) => entry.alive && entry.rider !== null);
    if (rider && !this._canMount(rider.rider, rider.id)) return null;
    const participant = prepareVehicleSnapshot(this, {
      _entries: entries,
      _living: new Map(next.entries.filter((entry) => entry.alive).map((entry) => [entry.id, entry])),
      _claims: new Set(), _frameId: null, _pendingExit: null, _input: null, _strides: new Map(),
    }, HORSE_HEADER_RESERVED_BYTES + next.entries.reduce((bytes, entry) => bytes + horseRecordBytes(entry), 0));
    return participant && Object.freeze({ ...participant,
      validate: () => !this.wildlife && (!rider || this._canMount(rider.rider, rider.id)) && participant.validate() });
  }

  load(data, { allowOverBudget = false } = {}) {
    const participant = this.prepareLoad(data);
    return !!participant && commitVehicleSnapshots(this.coordinator, [participant], allowOverBudget);
  }

  diagnostics() {
    return { active: this.active, retainedIds: this.size, living: this.livingSize,
      tombstones: this.size - this.livingSize, reservedBytes: this._bytes,
      livingLimit: MAX_LIVING_HORSES, identityLimit: MAX_RETAINED_HORSE_IDS,
      motionClaims: [...this._claims], mounted: this.mountFor(),
      dormant: this.wildlife?.dormantHorses.size ?? 0 };
  }

  dispose() {
    if (this._disposed) return true;
    if (!this.suspend() || this._preparing || this._updating || !this.coordinator.release(this)) return false;
    this._disposed = true;
    this._revision++;
    this._entries.clear();
    this._living.clear();
    this._claims.clear();
    this._strides.clear();
    this._bytes = 0;
    return true;
  }
}
