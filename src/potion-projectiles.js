import { intersectRayBox } from "./aabb.js";
import { bodyBox } from "./collision.js";
import { captureEntityContext } from "./entity-context.js";
import { dataRecord, immutable, synchronous } from "./enchantment-domain.js";
import { PEARL_RADIUS, PEARL_STEP_SECONDS, probePearlOrigin } from "./pearl-physics.js";
import { validPearlLife, validPearlOwnerId } from "./pearl-save.js";
import {
  createPotionProjectilesSnapshot, MAX_SPLASH_PROJECTILES,
  normalizePotionProjectile, normalizePotionProjectilesSnapshot,
  SPLASH_FRONTIER_LIFETIME, SPLASH_HEADER_BYTES, SPLASH_LIFETIME, SPLASH_MOTION_BYTES,
  splashLaunchVelocity, stepSplashFlight,
} from "./potion-projectile-state.js";
import { encodedBytes } from "./save-budget.js";
import { prepareSplashThrow, prepareStatusApplication } from "./status-effect-actions.js";
import { progressionPlan } from "./progression-station-interactions.js";
import { normalizeProgressionContext } from "./progression-context.js";
import { TransactionCoordinator, TransactionInvariantError } from "./transactions.js";

const point = (value) => !!value && ["x", "y", "z"].every((axis) => Number.isFinite(value[axis]));
const vector = ({ x, y, z }) => ({ x, y, z });
const equalPoint = (a, b) => point(a) && point(b) && a.x === b.x && a.y === b.y && a.z === b.z;
const projectileBox = (p) => [
  p.x - PEARL_RADIUS, p.y - PEARL_RADIUS, p.z - PEARL_RADIUS,
  p.x + PEARL_RADIUS, p.y + PEARL_RADIUS, p.z + PEARL_RADIUS,
];
const boxDistance = (a, b) => Math.hypot(...[0, 1, 2].map((axis) =>
  Math.max(0, a[axis] - b[axis + 3], b[axis] - a[axis + 3])
));
const inSplash = (impact, bounds) => [4, 2, 4].every((distance, axis) =>
  bounds[axis] <= impact[axis + 3] + distance &&
  bounds[axis + 3] >= impact[axis] - distance
);

/**
 * Independent bounded bottle owner; shares the parent's pearl owner/life bridge.
 * It never grants an effect at throw time. At impact the single-use retirement,
 * every affected StatusEffects owner and any instant-health Gameplay owner
 * publish in ONE World-coordinator commit. Miss/death/travel never refunds.
 *
 * readTargets() returns <=32 live {id,ref,dimension,position,radius,height,
 * gameplay,effects,available,target?} descriptors. This implementation handles
 * Gameplay-backed effect targets; NPC effects need an ecology-owned adapter,
 * not a made-up second NPC health store. The default host includes the player.
 */
export class PotionProjectiles {
  #state;
  #sizes = new Map();
  #bytes;
  #revision = 0;
  #disposed = false;
  #bindings = null;
  #busy = false;

  constructor({ world, context, catalog, ownerId, snapshot, allowOverBudget = false } = {}) {
    context = normalizeProgressionContext(context);
    if (!(world?.coordinator instanceof TransactionCoordinator) ||
        world._disposed || world.coordinator.usage(world) === undefined ||
        world.seed !== context.seed || world.generatorVersion !== context.generatorVersion ||
        !validPearlOwnerId(ownerId) || typeof allowOverBudget !== "boolean")
      throw new RangeError("Invalid potion projectile dependencies");
    const state = normalizePotionProjectilesSnapshot(
      snapshot === undefined ? createPotionProjectilesSnapshot(context, ownerId) : snapshot,
      context, ownerId
    );
    Object.defineProperties(this, {
      world: { value: world }, context: { value: context },
      coordinator: { value: world.coordinator }, catalog: { value: catalog },
      ownerId: { value: ownerId },
    });
    this.#state = immutable(state);
    for (const record of state.projectiles)
      this.#sizes.set(record.id, SPLASH_MOTION_BYTES + encodedBytes(record.stack));
    this.#bytes = SPLASH_HEADER_BYTES + [...this.#sizes.values()].reduce((a, b) => a + b, 0);
    if (!this.coordinator.register(this, this.#bytes, { allowOverBudget }))
      throw new RangeError("Cannot reserve thrown potions");
  }

  get projectiles() { return this.#state.projectiles; }
  get size() { return this.#state.projectiles.length; }
  get revision() { return this.#revision; }
  get reservedBytes() { return this.#bytes; }
  get activated() { return this.#bindings !== null && !this.#disposed; }
  serialize() { return structuredClone(this.#state); }

  activate({ getOwner, readTargets, validateLive, onEvent = () => {} }) {
    if (this.#disposed || this.#bindings ||
        ![getOwner, readTargets, validateLive, onEvent].every(synchronous) ||
        !this.coordinator.register(this, this.#bytes, { allowOverBudget: true }))
      return false;
    this.#bindings = { getOwner, readTargets, validateLive, onEvent };
    return true;
  }

  #owner() {
    if (this.#disposed || !this.#bindings?.validateLive()) return null;
    const owner = this.#bindings.getOwner(this.ownerId);
    if (!owner || owner.id !== this.ownerId || !validPearlLife(owner.life) ||
        owner.world !== this.world || owner.dimension !== this.world.dimension ||
        !owner.ref || owner.alive !== true || !point(owner.position) ||
        !point(owner.eye) || !point(owner.forward)) return null;
    return { ...owner, position: vector(owner.position), eye: vector(owner.eye),
      forward: vector(owner.forward), poseRevision: owner.poseRevision ?? owner.ref.poseRevision };
  }

  #ownerGuard(owner, pose = false) {
    const current = captureEntityContext(this.world, this.context);
    return () => {
      const now = this.#owner();
      return !!now && current() && now.ref === owner.ref && now.life === owner.life &&
        now.dimension === owner.dimension && (!pose ||
          (now.poseRevision === owner.poseRevision &&
            equalPoint(now.position, owner.position) && equalPoint(now.eye, owner.eye) &&
            equalPoint(now.forward, owner.forward)));
    };
  }

  #prepare(state, validate, event) {
    if (this.#disposed || !synchronous(validate) ||
        !Number.isSafeInteger(this.#revision + 1)) return null;
    const previous = this.#state, revision = this.#revision, beforeBytes = this.#bytes;
    const next = Object.freeze({ ...state, projectiles: Object.freeze(state.projectiles) });
    const sizes = new Map(next.projectiles.map((record) => [
      record.id, this.#sizes.get(record.id) ?? SPLASH_MOTION_BYTES + encodedBytes(record.stack),
    ]));
    const afterBytes = SPLASH_HEADER_BYTES + [...sizes.values()].reduce((a, b) => a + b, 0);
    let used = false;
    return Object.freeze({
      owner: this, beforeBytes, afterBytes,
      validate: () => !used && !this.#disposed && this.#state === previous &&
        this.#revision === revision && this.world.coordinator === this.coordinator &&
        this.coordinator.usage(this) === beforeBytes && validate() === true,
      publish: () => {
        used = true;
        this.#state = next; this.#sizes = sizes;
        this.#bytes = afterBytes; this.#revision++;
      },
      ...(event ? { notify: () => this.#bindings?.onEvent(event) } : {}),
    });
  }

  prepareThrow(gameplay, use, { validate = () => true } = {}) {
    const owner = this.#owner();
    if (!owner || !synchronous(validate) || gameplay.coordinator !== this.coordinator ||
        this.size >= MAX_SPLASH_PROJECTILES || this.#state.nextId >= 0x7fffffff)
      return null;
    const velocity = splashLaunchVelocity(owner.forward);
    const origin = { ...owner.eye, y: owner.eye.y - 0.1 };
    const probe = velocity && probePearlOrigin(this.world, this.context, origin);
    if (probe?.kind !== "ready") return null;
    const ownerValid = this.#ownerGuard(owner, true);
    return prepareSplashThrow(gameplay, use, {
      catalog: this.catalog,
      prepareProjectile: (stack) => {
        const record = immutable(normalizePotionProjectile({
          id: this.#state.nextId, ownerId: this.ownerId, life: owner.life,
          dimension: this.world.dimension, position: origin, velocity,
          age: 0, wait: 0, stack,
        }, this.context, this.ownerId));
        return this.#prepare({
          ...this.#state, nextId: record.id + 1,
          accumulator: this.size ? this.#state.accumulator : 0,
          projectiles: [...this.#state.projectiles, record],
        }, () => validate() && ownerValid() && probe.validate(), { type: "throw", id: record.id });
      },
    });
  }

  /**
   * Explicit death/travel retirement, including a leave-and-return with no
   * simulation frame in between. Never refunds a bottle, changes a table seed,
   * or increments the pearl owner's shared life counter. Can be composed with
   * effect clearing in the parent's death lifecycle commit.
   */
  prepareCancel(reason = "travel", { validate = () => true } = {}) {
    const bindings = this.#bindings;
    if (!bindings || !synchronous(validate) || typeof reason !== "string" ||
        !reason.length || reason.length > 80) return null;
    const current = captureEntityContext(this.world, this.context);
    const ids = Object.freeze(this.projectiles.map((entry) => entry.id));
    const source = this.#prepare({
      ...this.#state, accumulator: 0, projectiles: [],
    }, () => this.#bindings === bindings && bindings.validateLive() &&
      current() && validate() === true, { type: "cancel", reason, ids });
    return source ? progressionPlan(this.coordinator, [source], {
      ok: true, cancelled: ids.length,
    }) : null;
  }

  #targets() {
    const values = this.#bindings.readTargets();
    if (!Array.isArray(values) || values.length > 32) return null;
    const result = [], seen = new Set();
    for (const target of values) {
      if (!target || target.available !== true || target.dimension !== this.world.dimension) continue;
      if (typeof target.id !== "string" || target.id.length > 128 || !target.ref ||
          !point(target.position) || !Number.isFinite(target.radius) || target.radius <= 0 ||
          target.radius > 2 || !Number.isFinite(target.height) || target.height <= 0 ||
          target.height > 4 || target.gameplay?.coordinator !== this.coordinator ||
          target.effects?.coordinator !== this.coordinator ||
          target.gameplay.context?.seed !== this.context.seed ||
          target.gameplay.context?.generatorVersion !== this.context.generatorVersion ||
          target.gameplay.dead || target.gameplay._disposed || seen.has(target.id) ||
          this.coordinator.usage(target.gameplay) === undefined ||
          this.coordinator.usage(target.effects) !== target.effects.reservedBytes ||
          target.effects.reservedBytes === 0 ||
          result.some((entry) => entry.gameplay === target.gameplay || entry.effects === target.effects))
        return null;
      dataRecord(target.target ?? {}, [
        "undead", "ignoresPoisonAndRegeneration", "poisonImmune", "effectImmune",
      ], "splash target flags");
      seen.add(target.id);
      result.push({ ...target, position: vector(target.position),
        target: { ...target.target },
        poseRevision: target.poseRevision ?? target.ref.poseRevision,
        revision: target.gameplay.revision, effectRevision: target.effects.revision,
        bounds: bodyBox(target.position, target.radius, target.height) });
    }
    return result;
  }

  #targetGuard(targets) {
    return () => {
      const now = this.#targets();
      return !!now && now.length === targets.length && targets.every((target) => {
        const next = now.find((entry) => entry.id === target.id);
        return next?.ref === target.ref && next.gameplay === target.gameplay &&
          next.effects === target.effects && next.revision === target.revision &&
          next.effectRevision === target.effectRevision && next.poseRevision === target.poseRevision &&
          next.radius === target.radius &&
          next.height === target.height && equalPoint(next.position, target.position) &&
          JSON.stringify(next.target) === JSON.stringify(target.target);
      });
    };
  }

  prepareStep(id) {
    const projectile = this.projectiles.find((entry) => entry.id === id);
    if (!projectile || !this.#bindings) return null;
    const owner = this.#owner();
    const current = captureEntityContext(this.world, this.context);
    const retire = (validate, event, peers = []) => {
      const source = this.#prepare({ ...this.#state,
        accumulator: this.size === 1 ? 0 : this.#state.accumulator,
        projectiles: this.projectiles.filter((entry) => entry !== projectile) },
      validate, event);
      return source ? progressionPlan(this.coordinator, [source, ...peers], { ok: true, ...event }) : null;
    };
    if (!owner || owner.life !== projectile.life || owner.dimension !== projectile.dimension)
      return retire(() => current() && this.#bindings.validateLive(), { type: "cancel", id });
    const validOwner = this.#ownerGuard(owner);
    if (projectile.age + PEARL_STEP_SECONDS >= SPLASH_LIFETIME)
      return retire(validOwner, { type: "miss", id });
    const step = stepSplashFlight(this.world, this.context, projectile);
    if (step.kind === "frontier") {
      const wait = projectile.wait + PEARL_STEP_SECONDS;
      if (wait >= SPLASH_FRONTIER_LIFETIME)
        return retire(validOwner, { type: "miss", id });
      const record = immutable({ ...projectile, wait, age: projectile.age + PEARL_STEP_SECONDS });
      const source = this.#prepare({ ...this.#state,
        projectiles: this.projectiles.map((entry) => entry === projectile ? record : entry) },
      () => current() && validOwner() && step.validate());
      return source ? progressionPlan(this.coordinator, [source], { ok: true, type: "frontier" }) : null;
    }
    if (!["flight", "impact"].includes(step.kind))
      return retire(() => current() && validOwner() && (!step.validate || step.validate()),
        { type: "miss", id });
    const targets = this.#targets();
    if (!targets) return null;
    const targetGuard = this.#targetGuard(targets);
    let fraction = step.kind === "impact" ? step.hit.fraction : 1;
    let impact = step.kind === "impact" ? step.hit.center : null;
    let direct = null;
    const displacement = ["x", "y", "z"].map((axis) => projectile.velocity[axis] * PEARL_STEP_SECONDS);
    for (const target of targets) {
      if (target.ref === owner.ref && projectile.age < 0.15) continue;
      const hit = intersectRayBox(["x", "y", "z"].map((axis) => projectile.position[axis]), displacement,
        target.bounds.map((value, axis) => value + (axis < 3 ? -PEARL_RADIUS : PEARL_RADIUS)), fraction);
      if (!hit || hit.distance >= fraction) continue;
      fraction = hit.distance;
      direct = target.id;
      impact = Object.fromEntries(["x", "y", "z"].map((axis, index) =>
        [axis, projectile.position[axis] + displacement[index] * fraction]));
    }
    const valid = () => validOwner() && step.validate() && targetGuard();
    if (impact) {
      const bounds = projectileBox(impact), peers = [];
      for (const target of targets) {
        if (!inSplash(bounds, target.bounds)) continue;
        const distance = boxDistance(bounds, target.bounds);
        if (distance >= 4 && direct !== target.id) continue;
        const plan = prepareStatusApplication(target.gameplay, target.effects, projectile.stack.data.potion, {
          splash: { distance, directHit: target.id === direct }, target: target.target,
        });
        if (!plan) return null;
        peers.push(...plan.participants);
      }
      return retire(valid, { type: "impact", id, position: vector(impact) }, peers);
    }
    const record = immutable({ ...projectile, position: step.position, velocity: step.velocity,
      age: projectile.age + PEARL_STEP_SECONDS, wait: 0 });
    const source = this.#prepare({ ...this.#state,
      projectiles: this.projectiles.map((entry) => entry === projectile ? record : entry) }, valid);
    return source ? progressionPlan(this.coordinator, [source], { ok: true, type: "flight" }) : null;
  }

  /** Active seconds only, at most five fixed ticks × sixteen bottles per frame. */
  frame(dt) {
    if (this.#busy || this.#disposed ||
        !Number.isFinite(dt) || dt < 0) return { ok: false };
    if (!this.size || dt === 0) return { ok: true, changed: false };
    if (!this.#bindings?.validateLive()) return { ok: false };
    this.#busy = true;
    const errors = [];
    try {
      const total = this.#state.accumulator + Math.min(dt, 0.25);
      const ticks = Math.min(5, Math.floor((total + 1e-9) / PEARL_STEP_SECONDS));
      const accumulator = Math.max(0, total - ticks * PEARL_STEP_SECONDS);
      const current = captureEntityContext(this.world, this.context);
      const timer = this.#prepare({ ...this.#state, accumulator },
        () => current() && this.#bindings.validateLive());
      if (!timer || !this.coordinator.commit([timer]).ok) return { ok: false };
      for (let tick = 0; tick < ticks; tick++) {
        for (const id of this.projectiles.map((entry) => entry.id)) {
          const plan = this.prepareStep(id);
          if (!plan) continue;
          const result = this.coordinator.commit(plan.participants);
          errors.push(...(result.observerErrors ?? []));
        }
      }
      for (const error of errors) if (error instanceof TransactionInvariantError) throw error;
      return { ok: true, changed: true, observerErrors: errors };
    } finally {
      this.#busy = false;
    }
  }

  dispose() {
    if (this.#disposed) return true;
    if (this.#busy || !this.coordinator.release(this)) return false;
    this.#disposed = true; this.#revision++; this.#bindings = null;
    return true;
  }
}
