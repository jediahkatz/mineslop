import * as THREE from "three";
import {
  captureEntityContext,
  entityContextFor,
  matchesEntityContext,
} from "./entity-context.js";
import {
  EXPERIENCE_ORB_LIFETIME,
  EXPERIENCE_ORB_RECORD_RESERVED_BYTES,
  MAX_EXPERIENCE_ORBS,
  MAX_ORB_EXPERIENCE,
  normalizeExperienceOrbSnapshot,
} from "./experience-orb-save.js";
import {
  isLooseDimension,
  isLooseMotion,
  isLoosePosition,
  isLooseRecord,
  loadedLooseColumns,
  looseDistanceSquared,
  looseMotion,
  MAX_LOOSE_Y,
  sameLooseMotion,
  serializeLooseMotion,
  stepLooseEntity,
} from "./loose-entity.js";
import { CHUNK_SIZE } from "./terrain.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";

export {
  EXPERIENCE_ORB_LIFETIME,
  EXPERIENCE_ORB_RECORD_RESERVED_BYTES,
  MAX_EXPERIENCE_ORBS,
  MAX_ORB_EXPERIENCE,
  normalizeExperienceOrbSnapshot,
  validateExperienceOrbs,
} from "./experience-orb-save.js";

const HALF_SIZE = 0.12;
const FOOTPRINT = HALF_SIZE * Math.SQRT2;
const ACTIVE_DISTANCE_SQ = 80 ** 2;
const ATTRACT_DISTANCE_SQ = 8 ** 2;
const COLLECT_DISTANCE_SQ = 1;
const MERGE_DISTANCE_SQ = 1.5 ** 2;
const RETRY_DELAY = 0.5;
const TAU = Math.PI * 2;
const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";

function makeOrb(amount, position, dimension, motion, age = 0) {
  return {
    amount,
    x: position.x,
    y: position.y,
    z: position.z,
    dimension,
    ...motion,
    age,
    retryIn: 0,
    collecting: false,
    phase: (position.x * 13 + position.z * 17 + amount) % TAU,
  };
}

function orbMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: { time: { value: 0 } },
    vertexShader: `
      varying vec2 orbUv;
      void main() {
        orbUv = uv;
        // Instance translations are world-local. Expand the tiny quad in view
        // space so every instance is a billboard without per-orb camera work.
        vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        center.xy += position.xy * vec2(
          length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz)
        );
        gl_Position = projectionMatrix * center;
      }
    `,
    fragmentShader: `
      uniform float time;
      varying vec2 orbUv;
      void main() {
        // Original 9x9 stepped pixel art: translucent green rim, lime body,
        // yellow-white upper-left spark. No sprites, textures or point lights.
        vec2 pixel = floor(orbUv * 9.0) - vec2(4.0);
        float edge = max(abs(pixel.x), abs(pixel.y));
        float diamond = abs(pixel.x) + abs(pixel.y);
        if (edge > 4.0 || diamond > 6.0) discard;
        float pulse = 0.5 + 0.5 * sin(time * 3.0);
        vec3 color = vec3(0.16, 0.68, 0.025);
        float alpha = 0.14;
        if (edge <= 3.0 && diamond <= 5.0) {
          color = vec3(0.24, 0.85, 0.035);
          alpha = 0.45;
        }
        if (edge <= 2.0 && diamond <= 3.0) {
          color = mix(vec3(0.43, 0.95, 0.035), vec3(0.83, 1.0, 0.08), pulse);
          alpha = 1.0;
        }
        if (pixel.x <= 0.0 && pixel.y >= 0.0 && diamond <= 1.0) {
          color = vec3(0.94, 1.0, 0.52);
          alpha = 1.0;
        }
        gl_FragColor = vec4(color, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Inventory-independent physical XP, in one instanced billboard draw.
 *
 * At most 256 orbs, each 1..32767 XP. spawn splits a larger positive integer
 * (at most the pool's total capacity) and merges nearby same-dimension rewards
 * only when their delay/velocity match. Merges refresh that orb's lifetime to
 * protect the new reward. A failed spawn is atomic: no eviction/partial credit.
 *
 * Orbs expire after 300 active simulation seconds in loaded columns within
 * 80 horizontal blocks of the player; unloaded, distant, other-dimension and
 * paused time is frozen. Items never share this pool. There is no XP spill
 * buffer: callers must handle a false spawn result.
 * prepareCollect(amount) supplies the receiving Gameplay participant. onCollect
 * is then only a postcommit notification, never a credit/veto callback.
 * Without prepareCollect, the deprecated isolated-caller adapter still requires
 * onCollect(amount) to return true only after accepting the entire amount.
 */
export class ExperienceOrbs {
  constructor(
    scene,
    world,
    {
      coordinator = world.coordinator ?? new TransactionCoordinator(),
      context = world,
      prepareCollect,
      onCollect,
    } = {}
  ) {
    this.scene = scene;
    this.world = world;
    this.context = entityContextFor(world, context);
    this.coordinator = coordinator;
    this.prepareCollect = prepareCollect;
    this.onCollect = onCollect;
    this._orbs = [];
    this._bytes = 0;
    this._revision = 0;
    this._disposed = false;
    this._updating = false;
    this._preparingCollect = false;
    if (!matchesEntityContext(world, this.context))
      throw new RangeError("Experience context belongs to another world");
    if (!coordinator.register(this, 0))
      throw new RangeError("Cannot register experience-orb reservation");
    this._matrix = new THREE.Object3D();
    this.geometry = new THREE.PlaneGeometry(0.52, 0.52);
    this.material = orbMaterial();
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      MAX_EXPERIENCE_ORBS
    );
    this.mesh.name = "experience-orbs";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  get size() {
    return this._orbs.length;
  }

  get revision() {
    return this._revision;
  }

  get reservedBytes() {
    return this._bytes;
  }

  _positionInWorld(position) {
    const dimension = this.world.dimension;
    return (
      isLooseDimension(dimension) &&
      isLooseRecord(position) &&
      (position.dimension === undefined || position.dimension === dimension) &&
      isLoosePosition(
        { x: position.x, y: position.y, z: position.z, dimension },
        this.context
      )
    );
  }

  _prepareReplacement(next, notify) {
    if (
      this._disposed ||
      this._preparingCollect ||
      next.length > MAX_EXPERIENCE_ORBS ||
      !matchesEntityContext(this.world, this.context)
    )
      return null;
    const revision = this._revision;
    const beforeBytes = this._bytes;
    const afterBytes = next.length * EXPERIENCE_ORB_RECORD_RESERVED_BYTES;
    const coordinator = this.coordinator;
    const world = this.world;
    const context = this.context;
    const current = captureEntityContext(world, context);
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        !this._disposed &&
        !this._preparingCollect &&
        this._revision === revision &&
        this._bytes === beforeBytes &&
        this.coordinator === coordinator &&
        coordinator.usage(this) === beforeBytes &&
        this.world === world &&
        this.context === context &&
        current(),
      publish: () => {
        used = true;
        this._orbs = next;
        this._bytes = afterBytes;
        this._revision++;
        this.mesh.count = 0;
      },
      ...(notify ? { notify } : {}),
    });
  }

  /** options: { pickupDelay?: seconds, velocity?: {x,y,z} }. */
  spawn(amount, position, options = {}) {
    const participant = this.prepareSpawn(amount, position, options);
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  /** Detached merge/split plan, composable with station output ownership. */
  prepareSpawn(amount, position, options = {}) {
    const dimension = this.world.dimension;
    if (
      this._disposed ||
      this._preparingCollect ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > MAX_ORB_EXPERIENCE * MAX_EXPERIENCE_ORBS ||
      !this._positionInWorld(position) ||
      !isLooseMotion(options)
    )
      return null;
    const motion = looseMotion(options, 2.2);
    const next = this._orbs.slice();
    let remaining = amount;
    for (let index = 0; index < next.length; index++) {
      const orb = next[index];
      if (
        orb.collecting ||
        orb.dimension !== dimension ||
        orb.amount === MAX_ORB_EXPERIENCE ||
        !sameLooseMotion(orb, motion) ||
        looseDistanceSquared(orb, position) > MERGE_DISTANCE_SQ
      )
        continue;
      const moved = Math.min(remaining, MAX_ORB_EXPERIENCE - orb.amount);
      next[index] = { ...orb, amount: orb.amount + moved, age: 0 };
      remaining -= moved;
      if (!remaining) break;
    }
    if (
      next.length + Math.ceil(remaining / MAX_ORB_EXPERIENCE) >
      MAX_EXPERIENCE_ORBS
    )
      return null;
    while (remaining > 0) {
      const moved = Math.min(remaining, MAX_ORB_EXPERIENCE);
      next.push(makeOrb(moved, position, dimension, motion));
      remaining -= moved;
    }
    return this._prepareReplacement(next);
  }

  _prepareRemoval(orb, notify) {
    const index = this._orbs.indexOf(orb);
    if (index < 0) return null;
    const next = this._orbs.slice();
    next.splice(index, 1);
    return this._prepareReplacement(next, notify);
  }

  _collectPrepared(orb) {
    const notify = this.onCollect;
    const amount = orb.amount;
    const remove = this._prepareRemoval(
      orb,
      typeof notify === "function" ? () => notify(amount) : undefined
    );
    if (!remove || !synchronous(this.prepareCollect)) return false;
    let receive;
    this._preparingCollect = true;
    try {
      // This callback prepares detached Gameplay state; it does not credit XP.
      receive = this.prepareCollect(amount);
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return false;
    } finally {
      this._preparingCollect = false;
    }
    if (!isLooseRecord(receive) || typeof receive.then === "function")
      return false;
    return this.coordinator.commit([receive, remove]).ok;
  }

  /** Deprecated, non-transactional receiver adapter for old isolated callers. */
  _collectLegacy(orb) {
    let accepted;
    orb.collecting = true;
    try {
      accepted = this.onCollect(orb.amount) === true;
    } finally {
      orb.collecting = false;
    }
    if (this._disposed || !accepted) return accepted;
    // A legacy callback can spawn more orbs. Prepare against the current pool,
    // and never merge into the callback's in-flight, already credited record.
    const remove = this._prepareRemoval(orb);
    if (!remove || !this.coordinator.commit([remove]).ok)
      throw new TransactionInvariantError(
        "Accepted legacy XP could not relinquish its orb"
      );
    return true;
  }

  /**
   * Player position is feet, as in Pickups.update. Optional gameplay is consulted
   * only for .dead, never inventory slots/capacity or Gameplay.add().
   */
  update(dt, elapsed, playerPosition, gameplay) {
    if (
      this._disposed ||
      this._updating ||
      this._preparingCollect ||
      !matchesEntityContext(this.world, this.context)
    )
      return;
    const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const step = Math.min(delta, 0.1);
    const hasPlayer = this._positionInWorld(playerPosition);
    const prepared = this.prepareCollect !== undefined;
    const canCollect =
      (prepared
        ? synchronous(this.prepareCollect)
        : synchronous(this.onCollect)) && !gameplay?.dead;
    const world = this.world;
    const context = this.context;
    const current = captureEntityContext(world, context);
    this._updating = true;
    try {
      if (step > 0 && hasPlayer) {
        const target = {
          x: playerPosition.x,
          y: Math.min(MAX_LOOSE_Y, playerPosition.y + 0.9),
          z: playerPosition.z,
        };
        // A callback may spawn an orb; never simulate/collect it in this pass.
        for (const orb of [...this._orbs]) {
          if (this.world !== world || this.context !== context || !current())
            break;
          if (!this._orbs.includes(orb) || !this._active(orb, playerPosition))
            continue;
          const next = { ...orb };
          const delay = Math.max(0, orb.pickupDelay - delta);
          const distance = looseDistanceSquared(orb, target);
          const attracting =
            canCollect && delay === 0 && distance <= ATTRACT_DISTANCE_SQ;
          if (attracting && distance > 0) {
            const speed = 8 / Math.sqrt(distance);
            const blend = 1 - Math.exp(-10 * step);
            next.vx += ((target.x - orb.x) * speed - next.vx) * blend;
            next.vy += ((target.y - orb.y) * speed - next.vy) * blend;
            next.vz += ((target.z - orb.z) * speed - next.vz) * blend;
          }
          if (
            !stepLooseEntity(this.world, next, step, {
              halfSize: HALF_SIZE,
              footprint: FOOTPRINT,
              gravity: attracting ? 0 : 16,
              drag: attracting ? 1 : 3,
            })
          )
            continue;
          const age = orb.age + delta;
          if (age >= EXPERIENCE_ORB_LIFETIME) {
            const remove = this._prepareRemoval(orb);
            if (remove) this.coordinator.commit([remove]);
            continue;
          }
          Object.assign(orb, {
            x: next.x,
            y: next.y,
            z: next.z,
            vx: next.vx,
            vy: next.vy,
            vz: next.vz,
            pickupDelay: delay,
            age,
            retryIn: Math.max(0, orb.retryIn - delta),
          });
          this._revision++;
          if (
            !canCollect ||
            delay > 0 ||
            orb.retryIn > 0 ||
            looseDistanceSquared(orb, target) > COLLECT_DISTANCE_SQ
          )
            continue;
          const accepted = prepared
            ? this._collectPrepared(orb)
            : this._collectLegacy(orb);
          if (this._disposed) return;
          if (!accepted && this._orbs.includes(orb)) {
            orb.retryIn = RETRY_DELAY;
            this._revision++;
          }
        }
      }
      this._render(
        elapsed,
        hasPlayer &&
          this.world === world &&
          this.context === context &&
          current()
          ? playerPosition
          : null
      );
    } finally {
      this._updating = false;
    }
  }

  _active(orb, player) {
    return (
      orb.dimension === this.world.dimension &&
      (orb.x - player.x) ** 2 + (orb.z - player.z) ** 2 <= ACTIVE_DISTANCE_SQ &&
      loadedLooseColumns(this.world, orb, FOOTPRINT) !== null
    );
  }

  _render(elapsed, player) {
    const phase = Number.isFinite(elapsed) ? elapsed % TAU : 0;
    this.material.uniforms.time.value = phase;
    this.mesh.count = 0;
    if (!player) return;
    this.mesh.position.set(
      Math.floor(player.x / CHUNK_SIZE) * CHUNK_SIZE,
      Math.floor(player.y / CHUNK_SIZE) * CHUNK_SIZE,
      Math.floor(player.z / CHUNK_SIZE) * CHUNK_SIZE
    );
    for (const orb of this._orbs) {
      if (!this._active(orb, player)) continue;
      this._matrix.position.set(
        orb.x - this.mesh.position.x,
        orb.y - this.mesh.position.y + Math.sin(phase * 2 + orb.phase) * 0.025,
        orb.z - this.mesh.position.z
      );
      this._matrix.updateMatrix();
      this.mesh.setMatrixAt(this.mesh.count++, this._matrix.matrix);
    }
    if (this.mesh.count) this.mesh.instanceMatrix.needsUpdate = true;
  }

  serialize() {
    return {
      version: 1,
      orbs: this._orbs.map((orb) => ({
        amount: orb.amount,
        dimension: orb.dimension,
        x: orb.x,
        y: orb.y,
        z: orb.z,
        age: orb.age,
        ...serializeLooseMotion(orb),
      })),
    };
  }

  /** Atomic load; undefined is the backwards-compatible empty component. */
  load(data, options = {}) {
    if (
      !isLooseRecord(options) ||
      this._disposed ||
      this._updating ||
      this._preparingCollect
    )
      return false;
    const { context = this.context, allowOverBudget = false } = options;
    let nextContext;
    try {
      nextContext = entityContextFor(this.world, context);
    } catch {
      return false;
    }
    if (
      typeof allowOverBudget !== "boolean" ||
      !matchesEntityContext(this.world, nextContext)
    )
      return false;
    const snapshot = normalizeExperienceOrbSnapshot(data, nextContext);
    if (snapshot === null) return false;
    const next = snapshot.orbs.map((orb) =>
      makeOrb(orb.amount, orb, orb.dimension, looseMotion(orb), orb.age)
    );
    const bytes = next.length * EXPERIENCE_ORB_RECORD_RESERVED_BYTES;
    if (!this.coordinator.register(this, bytes, { allowOverBudget }))
      return false;
    this._orbs = next;
    this.context = nextContext;
    this._bytes = bytes;
    this._revision++;
    this.mesh.count = 0;
    return true;
  }

  dispose() {
    if (this._disposed || this._preparingCollect) return;
    if (
      this.coordinator.usage(this) !== undefined &&
      !this.coordinator.release(this)
    )
      return;
    this._disposed = true;
    this._revision++;
    this._bytes = 0;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.count = 0;
    this._orbs.length = 0;
    this.onCollect = this.prepareCollect = null;
  }
}
