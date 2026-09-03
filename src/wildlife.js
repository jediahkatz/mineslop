import * as THREE from "three";
import { ecologyCanOccupy, ecologyDistance, synchronousEcologyHook } from "./aquatic-ai.js";
import { BLOCK } from "./blocks.js";
import { captureEntityContext, entityContextFor, matchesEntityContext } from "./entity-context.js";
import { ecologyCollider, ecologyVisualScale } from "./expansion-ecology.js";
import { ECOLOGY_HOST_LIMITS } from "./ecology-population.js";
import { ITEM } from "./items.js";
import { createMobState, mobEye, stepMob } from "./mob-ai.js";
import {
  animateMob,
  createMobModel,
  createProjectileModel,
  MAX_PARTS_PER_MOB,
} from "./mob-models.js";
import {
  canOccupy,
  finitePosition,
  footprintLoaded,
  groundAt,
  hasLineOfSight,
  insideWorld,
  rayBoxDistance,
  waterHome,
} from "./mob-navigation.js";
import {
  isMobId,
  normalizeMobHeading,
  normalizeMobSnapshot,
  validMobPosition,
} from "./mob-save.js";
import {
  createMobGelResources,
  createMobSkinResources,
  MAX_GEL_INSTANCES,
} from "./mob-skin-atlas.js";
import {
  DESPAWN_DISTANCE,
  isDaylight,
  isHostileSpecies,
  MAX_HOSTILES,
  MAX_ECOLOGY_RESIDENTS,
  MAX_KILLED_MOBS,
  MAX_MOBS,
  MAX_PROJECTILES,
  MIN_HOSTILE_SPAWN_DISTANCE,
  MOB_SPECIES,
  SPAWN_GRACE_SECONDS,
  speciesForBiome,
} from "./mob-species.js";
import {
  feedSulfurCube,
  releaseSulfurBlock,
  setSulfurBlock,
} from "./mob-sulfur.js";
import { CHUNK_SIZE } from "./terrain.js";
import { isWorldPose } from "./world-spec.js";

const CELL_SIZE = 8;
const RED = new THREE.Color("#ff7c70");
const WHITE = new THREE.Color("#fff4de");
const FORWARD = new THREE.Vector3(0, 0, 1);
const noop = () => {};
const dimensionOf = (world) => world.dimension ?? "overworld";
const positionData = ({ x, y, z }) => ({ x, y, z });
function hash(value) {
  let result = 2166136261;
  for (const char of String(value))
    result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}
const roll = (value) => hash(value) / 4294967296;

/** An instanced, bounded ecosystem. Positions are feet positions in world space. */
export class Wildlife {
  constructor(
    scene,
    world,
    {
      onDamage = noop,
      onDrop = noop,
      onExplode = noop,
      onToast = noop,
      autoSpawn = true,
      maxEntities = MAX_MOBS,
      context = world,
    } = {}
  ) {
    this.scene = scene;
    this.world = world;
    this.worldContext = entityContextFor(world, context);
    if (!matchesEntityContext(world, this.worldContext))
      throw new RangeError("Mob context belongs to another world");
    this.dimension = dimensionOf(world);
    this.onDamage = onDamage;
    this.onDrop = onDrop;
    this.onExplode = onExplode;
    this.onToast = onToast;
    this.autoSpawn = autoSpawn;
    this.maxEntities = Number.isFinite(maxEntities)
      ? Math.max(1, Math.min(MAX_MOBS, Math.floor(maxEntities)))
      : MAX_MOBS;
    this.entities = [];
    this.animals = this.entities;
    this.byId = new Map();
    this.dormantEcology = new Map();
    this.ecologyServices = null;
    this._ecologyRevision = 0;
    this._dormantIterator = null;
    this.killed = new Set();
    this.projectiles = [];
    this.randomState = hash(`${world.seed}:${this.dimension}:wildlife`);
    this.nextId = 0;
    this.clock = 0;
    this.spawnProtectionUntil = 0;
    this.elapsed = 0;
    this.spawnTimer = 0;
    this.disposed = false;
    this.defendTarget = null;
    this.defendUntil = 0;
    this.player = new THREE.Vector3();
    this.hasPlayer = false;
    const capacity = MAX_MOBS * MAX_PARTS_PER_MOB + MAX_PROJECTILES * 3;
    this.skinResources = createMobSkinResources(capacity);
    this.geometry = this.skinResources.geometry;
    this.material = this.skinResources.material;
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = "Single-atlas pixel-skinned voxel ecosystem";
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.gelMesh = null;
    this.gelResources = null;
    this.gelCount = 0;
    this.opaqueCount = 0;
    // Reused records make gathering and back-to-front sorting allocation-free.
    this.gelInstances = Array.from({ length: MAX_GEL_INSTANCES }, () => ({
      part: null,
      flash: 0,
      hitFlash: false,
      depth: 0,
    }));
    this.color = new THREE.Color();
    this.pickRay = new THREE.Ray();
    this.localRay = new THREE.Ray();
    this.pickPoint = new THREE.Vector3();
    this.inversePart = new THREE.Matrix4();
    this.uploadMatrix = new THREE.Matrix4();
    this.unitBox = new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5)
    );
    this.group = new THREE.Group();
    this.group.name = "Interactive wildlife";
    this.group.add(this.mesh);
    scene.add(this.group);
    this.context = {
      world,
      random: () => this.random(),
      hurt: (mob, damage, direction, retaliate) => mob.spec.ecology
        ? this.ecologyServices?.hurt(mob, damage, direction, { retaliate })
        : this.damage(mob, damage, direction, retaliate),
      cull: (mob) => this.remove(mob),
      relocate: (...args) => this.relocate(...args),
      explodeMob: (...args) => this.explodeMob(...args),
      shoot: (mob) => this.shoot(mob),
      damagePlayer: (...args) => this.damagePlayer(...args),
      wolfTarget: (mob) => this.wolfTarget(mob),
      isLookingAt: (mob) => this.isLookingAt(mob),
      player: this.player,
      playerEye: { x: 0, y: 0, z: 0 },
      playerHeight: 1.8,
      renderEye: null,
      renderForward: null,
      mode: "creative",
      health: 20,
      spawnProtected: false,
      getMob: (id) => this.byId.get(id) ?? null,
      worldContext: this.worldContext,
    };
  }

  random() {
    this.randomState =
      (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }

  /** Also useful for authored encounters; rejects unloaded or unsafe spawn space. */
  spawn(kind, position, { id, restoring = false } = {}) {
    const spec =
      typeof kind === "string" && Object.hasOwn(MOB_SPECIES, kind)
        ? MOB_SPECIES[kind]
        : null;
    if (
      this.disposed ||
      dimensionOf(this.world) !== this.dimension ||
      !matchesEntityContext(this.world, this.worldContext) ||
      !spec ||
      spec.ecology ||
      !insideWorld(position, this.world) ||
      !validMobPosition(position, spec, this.worldContext, this.dimension) ||
      this.entities.length >= this.maxEntities
    )
      return null;
    const dimensions = Array.isArray(spec.dimension)
      ? spec.dimension
      : [spec.dimension];
    if (!dimensions.includes(this.dimension)) return null;
    const local = id === undefined;
    let nextId = this.nextId;
    if (local) {
      // Authored IDs and older counters may overlap. Skip retained identities
      // without replacing a mob/tombstone or ever incrementing into unsafe IDs.
      do {
        if (
          !Number.isSafeInteger(nextId) ||
          nextId < 0 ||
          nextId >= Number.MAX_SAFE_INTEGER - 1
        )
          return null;
        id = `${this.dimension}:local:${nextId++}`;
      } while (this.byId.has(id) || this.killed.has(id) ||
        this.ecologyServices?.ecology.identityReserved(id));
    }
    if (!isMobId(id) || this.byId.has(id) || this.killed.has(id) ||
      this.ecologyServices?.ecology.identityReserved(id)) return null;
    if (!restoring) {
      if (spec.aquatic || spec.flying) {
        if (
          !canOccupy(
            this.world,
            position.x,
            position.y,
            position.z,
            spec,
            !!spec.aquatic
          )
        )
          return null;
        if (
          spec.aquatic &&
          waterHome(this.world, position.x, position.z, spec) === null
        )
          return null;
      } else if (
        groundAt(this.world, position.x, position.z, spec, {
          nearY: position.y,
          stepHeight: 0,
          maxDrop: 0,
        }) === null
      )
        return null;
    }
    const entity = this._createEntity(kind, position, id, () => this.random());
    if (local) this.nextId = nextId;
    this.entities.push(entity);
    this.byId.set(id, entity);
    this._ecologyRevision++;
    return entity;
  }

  _createEntity(kind, position, id, random) {
    const entity = createMobState(kind, random);
    entity.id = id;
    entity.model = createMobModel(kind);
    setSulfurBlock(entity);
    entity.root = entity.model.root;
    entity.position = entity.root.position;
    entity.position.copy(position);
    entity.root.rotation.y = entity.targetYaw;
    entity.home = entity.position.clone();
    entity.groundY = position.y;
    return entity;
  }

  remove(entity) {
    if (this.byId.get(entity.id) !== entity) return;
    // An ecology resident can only relinquish its base pose in a prepared
    // death plan, alongside its domain state and retained rewards.
    if (entity.spec.ecology) return false;
    this.byId.delete(entity.id);
    this.entities.splice(this.entities.indexOf(entity), 1);
    entity.dead = true;
    this._ecologyRevision++;
  }

  /** Pure monotonic allocation proposal. Full canonical marker identities live
   * in Ecology, never in this bounded runtime ID or its hashed appearance RNG.
   */
  nextEcologyIdentities(count = 1) {
    if (!this.ecologyServices || !Number.isInteger(count) || count < 1 || count > 2) return null;
    const ids = [];
    let nextId = this.nextId, tries = 0;
    while (ids.length < count && tries++ < MAX_ECOLOGY_RESIDENTS * 3 + 4) {
      if (!Number.isSafeInteger(nextId) || nextId >= Number.MAX_SAFE_INTEGER - 1) return null;
      const id = `${this.dimension}:ecology:${nextId++}`;
      if (!this.byId.has(id) && !this.killed.has(id) &&
        !this.ecologyServices.ecology.identityReserved(id)) ids.push(id);
    }
    return ids.length === count ? Object.freeze({ ids: Object.freeze(ids), nextId }) : null;
  }

  _prepareEcologyEdit({ spawn, remove, damage, nextId = this.nextId, validate = () => true, notify } = {}) {
    const host = this.ecologyServices, coordinator = host?.coordinator;
    if (this.disposed || !host?.active || coordinator.usage(this) !== 0 ||
      !synchronousEcologyHook(validate) || (notify !== undefined && !synchronousEcologyHook(notify)) ||
      !Number.isSafeInteger(nextId) || nextId < this.nextId || nextId >= Number.MAX_SAFE_INTEGER)
      return null;
    const revision = this._ecologyRevision, priorId = this.nextId;
    const entities = this.entities, byId = this.byId, dormant = this.dormantEcology;
    const mob = remove ?? damage?.mob;
    if (mob && (!mob.spec.ecology || mob.dead || mob.dormant ||
      byId.get(mob.id) !== mob || !entities.includes(mob))) return null;
    const health = mob?.health, position = mob && positionData(mob.position);
    const current = captureEntityContext(this.world, this.worldContext);
    if (spawn && (entities.length >= this.maxEntities || byId.has(spawn.id) || this.killed.has(spawn.id) ||
      dormant.size + entities.filter((entry) => entry.spec.ecology).length >= MAX_ECOLOGY_RESIDENTS)) return null;
    let used = false;
    return Object.freeze({
      owner: this, beforeBytes: 0, afterBytes: 0,
      validate: () => !used && !this.disposed && this.ecologyServices === host && host.active &&
        coordinator.usage(this) === 0 && this._ecologyRevision === revision && this.nextId === priorId &&
        this.entities === entities && this.byId === byId && this.dormantEcology === dormant && current() &&
        (!mob || (byId.get(mob.id) === mob && entities.includes(mob) && !mob.dead && !mob.dormant &&
          mob.health === health && ecologyDistance(mob.position, position) === 0)) &&
        (!spawn || (!byId.has(spawn.id) && !this.killed.has(spawn.id) && entities.length < this.maxEntities)) &&
        validate() === true,
      publish: () => {
        used = true;
        if (spawn) {
          entities.push(spawn);
          byId.set(spawn.id, spawn);
        }
        if (remove) {
          entities.splice(entities.indexOf(remove), 1);
          dormant.delete(remove.id);
          byId.delete(remove.id);
          remove.health = 0;
          remove.dead = true;
        }
        if (damage) {
          mob.health = health - damage.amount;
          mob.hitFlash = 0.24;
          mob.threat = damage.threat;
          mob.knockback.x = damage.knockback.x;
          mob.knockback.z = damage.knockback.z;
          if (damage.retaliate) {
            if (mob.spec.temperament === "passive") mob.fleeTime = 5;
            else mob.angry = 20;
          }
        }
        this.nextId = nextId;
        this._ecologyRevision++;
      },
      ...(notify ? { notify } : {}),
    });
  }

  prepareEcologySpawn(proposal, { nextId, validate } = {}) {
    const host = this.ecologyServices, spec = MOB_SPECIES[proposal?.kind];
    const collider = ecologyCollider(proposal?.kind, { scuteClaimed: !proposal?.baby });
    if (!host?.active || !spec?.ecology || !isMobId(proposal.id) || !collider ||
      !validMobPosition(proposal.position, collider, this.worldContext, this.dimension) ||
      !ecologyCanOccupy(this.world, proposal.position, collider)) return null;
    // Detached model construction cannot consume Wildlife's committed RNG.
    let randomState = hash(`${this.world.seed}:${proposal.id}:appearance`);
    const entity = this._createEntity(proposal.kind, proposal.position, proposal.id, () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 4294967296;
    });
    entity.root.scale.setScalar(proposal.baby ? 0.5 : 1);
    return this._prepareEcologyEdit({
      spawn: entity, nextId,
      validate: () => ecologyCanOccupy(this.world, proposal.position, collider) &&
        (!validate || validate() === true),
    });
  }

  prepareEcologyRemoval(mob, options = {}) {
    return this._prepareEcologyEdit({ remove: mob, ...options });
  }

  prepareEcologyCounter(nextId, validate) {
    return this._prepareEcologyEdit({ nextId, validate });
  }

  prepareEcologyDamage(mob, amount, direction, { retaliate = true, validate, notify } = {}) {
    if (!mob?.spec.ecology || !Number.isFinite(amount) || amount <= 0 || amount >= mob.health) return null;
    const length = finitePosition(direction) ? Math.hypot(direction.x, direction.z) : 0;
    const strength = Math.min(7, 2.5 + amount * 0.4);
    return this._prepareEcologyEdit({
      damage: {
        mob, amount, retaliate,
        knockback: length ? { x: direction.x / length * strength, z: direction.z / length * strength } : { x: 0, z: 0 },
        threat: length ? {
          x: mob.position.x - direction.x / length * 3, z: mob.position.z - direction.z / length * 3,
        } : { x: this.player.x, z: this.player.z },
      },
      validate, notify,
    });
  }

  suspendEcology(mob) {
    if (!mob?.spec.ecology || this.byId.get(mob.id) !== mob || this.dormantEcology.has(mob.id)) return false;
    const index = this.entities.indexOf(mob);
    if (index < 0) return false;
    this.entities.splice(index, 1);
    this.dormantEcology.set(mob.id, mob);
    mob.dormant = true;
    this._ecologyRevision++;
    this.ecologyServices?.clearIntent(mob);
    return true;
  }

  _wakeEcology() {
    if (!this.ecologyServices?.active || !this.dormantEcology.size) return;
    for (let i = 0; i < ECOLOGY_HOST_LIMITS.dormantPerFrame && this.entities.length < this.maxEntities; i++) {
      this._dormantIterator ??= this.dormantEcology.values();
      const next = this._dormantIterator.next();
      if (next.done) { this._dormantIterator = null; break; }
      const mob = next.value;
      if (!this.ecologyServices.canWake(mob)) continue;
      this.dormantEcology.delete(mob.id);
      this.entities.push(mob);
      mob.dormant = false;
      this._ecologyRevision++;
    }
  }

  get spawnGrace() {
    const remaining = this.spawnProtectionUntil - this.clock;
    return remaining > 1e-9 ? remaining : 0;
  }

  endSpawnProtection() {
    this.spawnProtectionUntil = 0;
    this.context.spawnProtected = false;
  }

  /** Once per safe arrival, not on menu resume or ordinary portal travel. */
  protectSpawn(position) {
    if (
      this.disposed ||
      dimensionOf(this.world) !== this.dimension ||
      !matchesEntityContext(this.world, this.worldContext) ||
      !isWorldPose(position, this.worldContext, this.dimension)
    )
      return false;
    for (const mob of [...this.entities]) {
      if (
        mob.tamed ||
        mob.position.distanceTo(position) >= MIN_HOSTILE_SPAWN_DISTANCE
      )
        continue;
      if (mob.spec.temperament === "hostile") {
        if (mob.spec.ecology) {
          this.suspendEcology(mob);
          continue;
        }
        // Despawn, not a kill: no free loot or permanent killed-site tombstone.
        this.remove(mob);
      } else if (mob.spec.temperament !== "passive") {
        // Endermen and wild neutral animals forget the previous life.
        mob.angry = mob.lookTimer = mob.fuse = 0;
        mob.attacking = mob.fusing = false;
        mob.attackCooldown = mob.spec.cooldown;
      }
    }
    this.projectiles.length = 0;
    this.ecologyServices?.clearAttacks();
    this.defendTarget = null;
    this.defendUntil = 0;
    this.spawnProtectionUntil = this.clock + SPAWN_GRACE_SECONDS;
    this.context.spawnProtected = true;
    return true;
  }

  surfaceAt(x, z, kind = "sheep") {
    const spec = Object.hasOwn(MOB_SPECIES, kind) ? MOB_SPECIES[kind] : null;
    return spec ? groundAt(this.world, x, z, spec) : null;
  }

  relocate(entity, center, minRadius = 2, maxRadius = 5) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const angle = this.random() * Math.PI * 2;
      const radius = minRadius + this.random() * (maxRadius - minRadius);
      const x = center.x + Math.sin(angle) * radius;
      const z = center.z + Math.cos(angle) * radius;
      const y = groundAt(this.world, x, z, entity.spec, {
        nearY: center.y,
        stepHeight: 2,
        maxDrop: 5,
      });
      if (y === null) continue;
      entity.position.set(x, y, z);
      entity.groundY = y;
      entity.velocityY = 0;
      entity.knockback.x = entity.knockback.z = 0;
      entity.home.copy(entity.position);
      entity.dormant = false;
      return true;
    }
    return false;
  }

  populate() {
    this.ecologyServices?.populate();
    const hostiles = this.entities.filter((mob) =>
      isHostileSpecies(mob.spec)
    ).length;
    let hostileCount = hostiles,
      peacefulCount = this.entities.length - hostiles,
      added = 0;
    const passiveLimit = Math.min(16, this.maxEntities);
    const hostileLimit = Math.min(MAX_HOSTILES, this.maxEntities);
    for (
      let attempt = 0;
      attempt < 36 && added < 4 && this.entities.length < this.maxEntities;
      attempt++
    ) {
      const angle = this.random() * Math.PI * 2;
      const distance = 9 + this.random() * 23;
      const cx = Math.floor(
        (this.player.x + Math.sin(angle) * distance) / CELL_SIZE
      );
      const cz = Math.floor(
        (this.player.z + Math.cos(angle) * distance) / CELL_SIZE
      );
      const site = `${this.world.seed}:${this.dimension}:${cx},${cz}`;
      const x = cx * CELL_SIZE + 1.5 + roll(`${site}:x`) * 5;
      const z = cz * CELL_SIZE + 1.5 + roll(`${site}:z`) * 5;
      if (!this.world.isLoaded(Math.floor(x), Math.floor(z))) continue;
      const modernSurface = typeof this.world.surfaceYAt === "function";
      const terrain = modernSurface
        ? this.world.surfaceYAt(Math.floor(x), Math.floor(z))
        : this.world.heightAt(Math.floor(x), Math.floor(z));
      const hasSurface =
        Number.isSafeInteger(terrain) && (modernSurface || terrain >= 0);
      const water =
        hasSurface &&
        this.world.get(Math.floor(x), terrain + 1, Math.floor(z)) ===
          BLOCK.WATER;
      const underground =
        hasSurface &&
        this.dimension === "overworld" &&
        this.player.y < terrain - 4;
      const wantHostile =
        !water &&
        (this.dimension !== "overworld" ||
          ((!isDaylight(this.context.timeOfDay) || underground) &&
            (this.random() < 0.55 || peacefulCount >= passiveLimit)));
      if (
        (wantHostile && hostileCount >= hostileLimit) ||
        (!wantHostile && peacefulCount >= passiveLimit)
      )
        continue;
      const id = `${this.dimension}:${cx},${cz}:${wantHostile ? "h" : water ? "w" : "p"}`;
      if (this.byId.has(id) || this.killed.has(id)) continue;
      const biome = this.world.getBiome(
        x,
        z,
        underground ? this.player.y : undefined
      );
      const kinds = speciesForBiome(biome, {
        dimension: this.dimension,
        timeOfDay: underground ? 0 : this.context.timeOfDay,
        water,
        hostile: wantHostile,
      }).filter(
        (kind) =>
          (!MOB_SPECIES[kind].undergroundOnly || underground) &&
          this.entities.filter((mob) => mob.kind === kind).length <
            (MOB_SPECIES[kind].limit ?? 5)
      );
      if (!kinds.length) continue;
      const kind =
        kinds[
          Math.floor(roll(`${site}:${wantHostile}:species`) * kinds.length)
        ];
      const spec = MOB_SPECIES[kind];
      let y;
      if (spec.aquatic) y = waterHome(this.world, x, z, spec);
      else if (spec.flying) {
        y = this.player.y + 4 + roll(`${site}:altitude`) * 4;
        if (!canOccupy(this.world, x, y, z, spec)) y = null;
      } else {
        y = groundAt(this.world, x, z, spec, {
          ...(underground || this.dimension === "nether"
            ? { nearY: this.player.y, stepHeight: 5, maxDrop: 9 }
            : {}),
          natural: true,
        });
      }
      if (y === null || !Number.isFinite(y)) continue;
      // Check the actual birth position after cell jitter and height selection.
      if (
        wantHostile &&
        Math.hypot(x - this.player.x, y - this.player.y, z - this.player.z) <
          MIN_HOSTILE_SPAWN_DISTANCE
      )
        continue;
      if (
        this.entities.some(
          (mob) =>
            Math.hypot(mob.position.x - x, mob.position.z - z) <
            spec.radius + mob.spec.radius + 1
        )
      )
        continue;
      if (this.spawn(kind, { x, y, z }, { id })) {
        added++;
        if (wantHostile) hostileCount++;
        else peacefulCount++;
      }
    }
  }

  update(
    dt,
    elapsed = 0,
    playerPosition,
    {
      timeOfDay = 0.3,
      mode = "creative",
      playerForward,
      playerEye,
      playerHeight = 1.8,
      renderEye,
      renderForward,
      health = 20,
      playerSwimming = false,
      playerInvulnerable = false,
      playerTargetKey = "player",
      playerDimension = this.dimension,
    } = {}
  ) {
    if (
      this.disposed ||
      dimensionOf(this.world) !== this.dimension ||
      !matchesEntityContext(this.world, this.worldContext)
    )
      return;
    dt = Number.isFinite(dt) ? Math.max(0, Math.min(0.2, dt)) : 0;
    if (isWorldPose(playerPosition, this.worldContext, this.dimension)) {
      this.player.copy(playerPosition);
      this.hasPlayer = true;
    }
    const ctx = this.context;
    Object.assign(ctx, {
      timeOfDay: Number.isFinite(timeOfDay) ? timeOfDay : 0.3,
      mode,
      health: Number.isFinite(health) ? Math.max(0, health) : 20,
      playerForward: finitePosition(playerForward) ? playerForward : null,
      playerHeight:
        Number.isFinite(playerHeight) &&
        playerHeight >= 0.5 &&
        playerHeight <= 3
          ? playerHeight
          : 1.8,
      renderEye: finitePosition(renderEye) ? renderEye : null,
      renderForward: finitePosition(renderForward) ? renderForward : null,
      dimension: this.dimension,
      playerDimension,
      playerSwimming: playerSwimming === true,
      playerInvulnerable: playerInvulnerable === true,
      playerTargetKey,
    });
    Object.assign(
      ctx.playerEye,
      finitePosition(playerEye)
        ? playerEye
        : { x: this.player.x, y: this.player.y + 1.45, z: this.player.z }
    );
    if (mode === "creative" || ctx.health <= 0) this.endSpawnProtection();
    if (dt > 0 && this.hasPlayer) {
      this.clock += dt;
      ctx.spawnProtected = this.spawnGrace > 0;
      if (Number.isFinite(elapsed)) this.elapsed = elapsed;
      ctx.time = this.clock;
      this._ecologyRevision++;
      this.ecologyServices?.beginFrame(dt);
      for (const mob of [...this.entities]) {
        const distance = mob.position.distanceTo(this.player);
        const loaded = footprintLoaded(
          this.world,
          mob.position.x,
          mob.position.z,
          mob.spec.radius
        );
        if (mob.spec.ecology) {
          if (!this.ecologyServices?.canWake(mob))
            this.suspendEcology(mob);
          else mob.dormant = false;
        } else if (mob.tamed && (!loaded || distance > 18)) {
          if (mob.teleportCooldown <= 0) {
            this.relocate(mob, this.player, 2, 5);
            mob.teleportCooldown = 2;
          }
          mob.dormant =
            !footprintLoaded(
              this.world,
              mob.position.x,
              mob.position.z,
              mob.spec.radius
            ) || mob.position.distanceTo(this.player) > DESPAWN_DISTANCE;
          if (mob.dormant)
            mob.teleportCooldown = Math.max(0, mob.teleportCooldown - dt);
        } else if (!loaded || distance > DESPAWN_DISTANCE) {
          this.remove(mob);
        } else if (
          mob.spec.aquatic &&
          !canOccupy(
            this.world,
            mob.position.x,
            mob.position.y,
            mob.position.z,
            mob.spec,
            true
          )
        ) {
          this.remove(mob);
        } else mob.dormant = false;
      }
      this._wakeEcology();
      this.spawnTimer -= dt;
      if (this.autoSpawn && this.spawnTimer <= 0) {
        this.spawnTimer = 1.5;
        this.populate();
      }
      const steps = Math.ceil(dt / 0.05),
        step = dt / steps;
      for (let i = 0; i < steps; i++) {
        for (const mob of [...this.entities]) {
          if (mob.spec.ecology) this.ecologyServices?.stepMob(mob, step);
          else stepMob(mob, step, ctx);
        }
        this.updateProjectiles(step);
        this.ecologyServices?.stepWorld(step);
      }
    }
    this.render(dt);
  }

  damagePlayer(amount, cause, source, attack) {
    const ctx = this.context;
    if (
      ctx.mode === "creative" ||
      ctx.spawnProtected ||
      ctx.health <= 0 ||
      !Number.isFinite(amount) ||
      amount <= 0
    )
      return;
    ctx.health = Math.max(0, ctx.health - amount);
    if (source && !source.dead) {
      this.defendTarget = source.id;
      this.defendUntil = this.clock + 8;
    }
    const result = this.onDamage(amount, cause, source, attack);
    // Armor and shields are owned by Gameplay, not the AI's raw damage budget.
    // Explicit reconciliation keeps a blocked hit from exhausting this context.
    if (Number.isFinite(result?.health))
      ctx.health = Math.max(0, Math.min(20, result.health));
    return result;
  }

  damage(entity, amount, direction, retaliate = true) {
    if (typeof entity === "string") entity = this.byId.get(entity);
    if (
      this.disposed ||
      !entity ||
      entity.dead ||
      this.byId.get(entity.id) !== entity ||
      !Number.isFinite(amount) ||
      amount <= 0
    )
      return { hit: false, killed: false, damage: 0 };
    if (entity.spec.ecology)
      return { hit: false, killed: false, damage: 0, reason: "prepared-ecology-hit-required" };
    amount = Math.min(1000, amount);
    const dealt = Math.min(entity.health, amount);
    entity.health -= dealt;
    entity.hitFlash = 0.24;
    if (finitePosition(direction)) {
      const length = Math.hypot(direction.x, direction.z);
      if (length > 0) {
        const strength = Math.min(7, 2.5 + amount * 0.4);
        entity.knockback.x = (direction.x / length) * strength;
        entity.knockback.z = (direction.z / length) * strength;
        entity.threat = {
          x: entity.position.x - (direction.x / length) * 3,
          z: entity.position.z - (direction.z / length) * 3,
        };
        if (!entity.spec.aquatic && !entity.spec.flying) entity.velocityY = 2.4;
      }
    } else entity.threat = { x: this.player.x, z: this.player.z };
    if (retaliate) {
      if (entity.spec.temperament === "passive" || entity.tamed)
        entity.fleeTime = 5;
      else entity.angry = 20;
      if (isHostileSpecies(entity.spec)) {
        this.defendTarget = entity.id;
        this.defendUntil = this.clock + 8;
      }
    }
    if (entity.health > 0)
      return { hit: true, killed: false, damage: dealt, entity };
    const position = positionData(entity.position);
    this.rememberKilled(entity.id);
    this.remove(entity);
    const drops = [];
    const absorbed = releaseSulfurBlock(entity);
    if (absorbed) {
      drops.push(absorbed);
      this.onDrop(absorbed.id, absorbed.count, { ...position });
    }
    for (const entry of entity.spec.drops) {
      if (!Number.isInteger(entry.id) || this.random() > entry.chance) continue;
      const count =
        entry.min + Math.floor(this.random() * (entry.max - entry.min + 1));
      drops.push({ id: entry.id, count });
      this.onDrop(entry.id, count, { ...position });
    }
    return { hit: true, killed: true, damage: dealt, entity, drops };
  }

  rememberKilled(id) {
    if (!isMobId(id) || this.byId.get(id)?.spec.ecology ||
      this.ecologyServices?.ecology.identityReserved(id)) return false;
    this.killed.add(id);
    if (this.killed.size > MAX_KILLED_MOBS)
      this.killed.delete(this.killed.values().next().value);
    return true;
  }

  interact(entity, itemId) {
    if (typeof entity === "string") entity = this.byId.get(entity);
    if (!entity || entity.dead || this.byId.get(entity.id) !== entity)
      return false;
    if (entity.spec.ecology) return false;
    if (entity.kind === "sulfur_cube")
      return feedSulfurCube(entity, itemId, this);
    if (entity.kind === "wolf" && itemId === ITEM.BONE && !entity.tamed) {
      if (this.entities.filter((mob) => mob.tamed).length >= 4) {
        this.onToast("You already have four wolf companions nearby.");
        return false;
      }
      entity.tamed = true;
      entity.angry = entity.fleeTime = 0;
      entity.health = entity.spec.health;
      this.onToast("Wolf tamed. It will follow and defend you.");
      return true;
    }
    if (entity.kind === "piglin" && itemId === ITEM.GOLD_INGOT) {
      entity.pacified = 60;
      entity.angry = 0;
      this.onToast("The piglin accepts your gold. Peace, for now.");
      return true;
    }
    if (entity.spec.food?.includes(itemId)) {
      if (entity.kind === "wolf" && entity.health >= entity.spec.health)
        return false;
      entity.health = Math.min(entity.spec.health, entity.health + 6);
      entity.followTime = 20;
      entity.fleeTime = 0;
      this.onToast(`${entity.name} fed.`);
      return true;
    }
    return false;
  }

  wolfTarget(wolf) {
    if (
      this.context.mode === "creative" ||
      this.context.spawnProtected ||
      this.context.health <= 0
    )
      return null;
    const chosen =
      this.clock < this.defendUntil ? this.byId.get(this.defendTarget) : null;
    if (
      chosen &&
      !chosen.dead &&
      !chosen.tamed &&
      chosen.position.distanceTo(this.player) < 12
    )
      return chosen;
    return (
      this.entities.find(
        (mob) =>
          mob !== wolf &&
          mob.attacking &&
          !mob.dead &&
          mob.position.distanceTo(this.player) < 7 &&
          mob.position.distanceTo(wolf.position) < 10
      ) ?? null
    );
  }

  explodeMob(entity, radius) {
    if (
      entity.dead ||
      this.context.mode === "creative" ||
      this.context.spawnProtected
    )
      return;
    const position = {
      x: entity.position.x,
      y: entity.position.y + 0.65,
      z: entity.position.z,
    };
    this.rememberKilled(entity.id);
    this.remove(entity);
    this.explosion(position, radius, entity);
  }

  explosion(position, radius, source) {
    if (this.context.mode === "creative" || this.context.spawnProtected) return;
    const distance = Math.hypot(
      this.player.x - position.x,
      this.player.y + 0.8 - position.y,
      this.player.z - position.z
    );
    if (
      distance < radius * 1.5 &&
      hasLineOfSight(this.world, position, this.context.playerEye)
    )
      this.damagePlayer(
        Math.max(1, Math.round(14 * (1 - distance / (radius * 1.5)))),
        `${source.name} explosion`,
        source,
        { kind: "explosion", position }
      );
    for (const mob of [...this.entities]) {
      const separation = Math.hypot(
        mob.position.x - position.x,
        mob.position.y - position.y,
        mob.position.z - position.z
      );
      if (
        separation < radius * 1.5 &&
        hasLineOfSight(this.world, position, mobEye(mob))
      ) {
        const hurt = mob.spec.ecology
          ? (entity, amount, direction) => this.ecologyServices?.hurt(entity, amount, direction, { retaliate: false })
          : (...args) => this.damage(...args);
        hurt(
          mob,
          Math.max(1, 16 * (1 - separation / (radius * 1.5))),
          {
            x: mob.position.x - position.x,
            y: 0.3,
            z: mob.position.z - position.z,
          },
          false
        );
      }
    }
    this.onExplode({ ...position }, radius);
  }

  shoot(entity) {
    if (
      this.projectiles.length >= MAX_PROJECTILES ||
      this.context.mode === "creative" ||
      this.context.spawnProtected
    )
      return;
    const kind = entity.spec.ranged;
    const start = mobEye(entity);
    const target = this.context.playerEye;
    const speed = kind === "arrow" ? 12 : 6;
    const travelTime =
      Math.hypot(target.x - start.x, target.z - start.z) / speed;
    const velocity = new THREE.Vector3(
      target.x - start.x,
      target.y -
        start.y +
        (kind === "arrow" ? 1.4 * travelTime * travelTime : 0),
      target.z - start.z
    )
      .normalize()
      .multiplyScalar(speed);
    const model = createProjectileModel(kind);
    model.root.position.copy(start);
    this.projectiles.push({
      kind,
      model,
      position: model.root.position,
      velocity,
      age: 0,
      source: entity,
      damage: entity.spec.damage,
    });
  }

  updateProjectiles(dt) {
    if (
      this.context.mode === "creative" ||
      this.context.spawnProtected ||
      this.context.health <= 0
    ) {
      this.projectiles.length = 0;
      return;
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const shot = this.projectiles[i];
      const from = shot.position.clone();
      shot.age += dt;
      if (shot.kind === "arrow") shot.velocity.y -= 2.8 * dt;
      const next = from.clone().addScaledVector(shot.velocity, dt);
      const travel = next.distanceTo(from);
      const direction = shot.velocity.clone().normalize();
      const hit = rayBoxDistance(
        from,
        direction,
        this.player,
        0.36,
        this.context.playerHeight,
        travel
      );
      const endpoint =
        hit === null ? next : from.clone().addScaledVector(direction, hit);
      const clear = hasLineOfSight(this.world, from, endpoint);
      const loaded = this.world.isLoaded(
        Math.floor(endpoint.x),
        Math.floor(endpoint.z)
      );
      const expired =
        shot.age > 6 ||
        next.distanceTo(this.player) > DESPAWN_DISTANCE ||
        !insideWorld(next, this.world);
      if (!clear || hit !== null || expired || !loaded) {
        if (!expired && loaded) {
          if (shot.kind === "fireball") this.explosion(from, 1.8, shot.source);
          else if (hit !== null && clear)
            this.damagePlayer(
              shot.damage,
              `${shot.source.name} arrow`,
              shot.source,
              { kind: "projectile", position: from }
            );
        }
        this.projectiles.splice(i, 1);
      } else {
        shot.position.copy(next);
        shot.model.root.quaternion.setFromUnitVectors(FORWARD, direction);
      }
    }
  }

  /** Crosshair ray against the rendered head, including its current rotation. */
  isLookingAt(mob) {
    const { playerEye, playerForward } = this.context;
    const head = mob.model.stareTarget;
    if (
      !head ||
      !playerForward ||
      Math.hypot(playerForward.x, playerForward.y, playerForward.z) < 1e-9
    )
      return false;
    this.pickRay.origin.copy(playerEye);
    this.pickRay.direction.copy(playerForward).normalize();
    mob.root.updateMatrixWorld(true);
    this.inversePart.copy(head.matrixWorld).invert();
    this.localRay.copy(this.pickRay).applyMatrix4(this.inversePart);
    if (!this.localRay.intersectBox(this.unitBox, this.pickPoint)) return false;
    this.pickPoint.applyMatrix4(head.matrixWorld);
    return (
      this.pickPoint.distanceTo(this.pickRay.origin) <= 18 &&
      hasLineOfSight(this.world, playerEye, this.pickPoint)
    );
  }

  raycast(origin, direction, maxDistance = 5) {
    if (
      this.disposed ||
      !finitePosition(origin) ||
      !finitePosition(direction) ||
      !Number.isFinite(maxDistance) ||
      maxDistance < 0
    )
      return null;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 1e-9) return null;
    const normalized = {
      x: direction.x / length,
      y: direction.y / length,
      z: direction.z / length,
    };
    this.pickRay.origin.copy(origin);
    this.pickRay.direction.copy(normalized);
    let result = null;
    for (const entity of this.entities) {
      if (entity.dead || entity.dormant) continue;
      const { model } = entity;
      const base = {
        x: entity.position.x,
        y: entity.position.y + model.pickFloor,
        z: entity.position.z,
      };
      if (
        rayBoxDistance(
          origin,
          normalized,
          base,
          model.pickRadius,
          model.pickHeight - model.pickFloor,
          Math.min(80, result?.distance ?? maxDistance)
        ) === null
      )
        continue;
      model.root.updateMatrixWorld(true);
      for (const part of model.parts) {
        if (part.condition && !entity[part.condition]) continue;
        this.inversePart.copy(part.node.matrixWorld).invert();
        this.localRay.copy(this.pickRay).applyMatrix4(this.inversePart);
        if (!this.localRay.intersectBox(this.unitBox, this.pickPoint)) continue;
        this.pickPoint.applyMatrix4(part.node.matrixWorld);
        const distance = this.pickPoint.distanceTo(this.pickRay.origin);
        if (distance > Math.min(80, result?.distance ?? maxDistance)) continue;
        if (hasLineOfSight(this.world, origin, this.pickPoint))
          result = { entity, distance, name: entity.name };
      }
    }
    return result;
  }

  uploadMobPart(mesh, resources, index, part, flash, hitFlash) {
    // Subtract in CPU double precision before either Float32 instance upload.
    // World matrices stay untouched for physics and exact model-part picking.
    this.uploadMatrix.copy(part.node.matrixWorld);
    this.uploadMatrix.elements[12] -= mesh.position.x;
    this.uploadMatrix.elements[14] -= mesh.position.z;
    mesh.setMatrixAt(index, this.uploadMatrix);
    if (part.skin.tintable) this.color.copy(part.color);
    else this.color.setRGB(1, 1, 1);
    if (flash) this.color.copy(hitFlash ? RED : WHITE);
    resources.write(index, part.skin, flash);
    mesh.setColorAt(index, this.color);
  }

  batchMobModel(model, mob) {
    const hitFlash = mob?.hitFlash > 0;
    const flash = hitFlash
      ? 0.7
      : mob?.fusing && Math.sin(mob.fuse * (16 + mob.fuse * 14)) > 0
        ? 0.8
        : 0;
    for (const part of model.parts) {
      if (part.condition && !mob?.[part.condition]) continue;
      if (part.skin.translucent) {
        if (this.gelCount >= MAX_GEL_INSTANCES)
          throw new Error("Mob gel instance budget exceeded");
        const instance = this.gelInstances[this.gelCount++];
        instance.part = part;
        instance.flash = flash;
        instance.hitFlash = hitFlash;
      } else {
        this.uploadMobPart(
          this.mesh,
          this.skinResources,
          this.opaqueCount++,
          part,
          flash,
          hitFlash
        );
      }
    }
  }

  clearGelBatch() {
    if (!this.gelMesh) return;
    this.group.remove(this.gelMesh);
    this.gelMesh.dispose();
    this.gelResources.dispose();
    this.gelMesh = this.gelResources = null;
  }

  render(dt) {
    let anchor = this.hasPlayer ? this.player : null;
    if (!anchor) {
      for (const mob of this.entities) {
        if (mob.dormant) continue;
        anchor = mob.position;
        break;
      }
      anchor ??= this.projectiles[0]?.position;
    }
    if (anchor) {
      this.mesh.position.set(
        Math.floor(anchor.x / CHUNK_SIZE) * CHUNK_SIZE,
        0,
        Math.floor(anchor.z / CHUNK_SIZE) * CHUNK_SIZE
      );
    }
    const previousGelCount = this.gelCount;
    this.opaqueCount = this.gelCount = 0;
    for (const mob of this.entities) {
      if (mob.dormant) continue;
      const ecologyState = mob.spec.ecology && this.ecologyServices?.ecology.state(mob.id);
      if (ecologyState) mob.root.scale.setScalar(ecologyVisualScale(ecologyState));
      animateMob(mob, dt, this.elapsed, this.hasPlayer ? this.player : null);
      this.batchMobModel(mob.model, mob);
    }
    for (const shot of this.projectiles) {
      shot.model.root.updateMatrixWorld(true);
      this.batchMobModel(shot.model);
    }
    this.mesh.count = this.opaqueCount;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.skinResources.update();
    this.ecologyServices?.render(anchor);
    for (let i = this.gelCount; i < previousGelCount; i++)
      this.gelInstances[i].part = null;
    if (this.gelCount === 0) {
      // No extra draw or resident GPU geometry when the last gel disappears.
      this.clearGelBatch();
      return;
    }
    if (!this.gelMesh) {
      // Allocate only on an empty -> visible transition, never per mob/frame.
      this.gelResources = createMobGelResources(this.skinResources);
      this.gelMesh = new THREE.InstancedMesh(
        this.gelResources.geometry,
        this.gelResources.material,
        MAX_GEL_INSTANCES
      );
      this.gelMesh.name = "Shared translucent slime shells";
      this.gelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.gelMesh.setColorAt(0, this.color);
      this.gelMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.gelMesh.frustumCulled = false;
      this.gelMesh.castShadow = false;
      this.gelMesh.receiveShadow = true;
      this.group.add(this.gelMesh);
    }
    this.gelMesh.position.copy(this.mesh.position);
    const eye = this.hasPlayer
      ? (this.context.renderEye ?? this.context.playerEye)
      : (anchor ?? this.player);
    const forward = this.hasPlayer
      ? (this.context.renderForward ?? this.context.playerForward)
      : null;
    for (let i = 0; i < this.gelCount; i++) {
      const instance = this.gelInstances[i];
      const matrix = instance.part.node.matrixWorld.elements;
      const dx = matrix[12] - eye.x;
      const dy = matrix[13] - eye.y;
      const dz = matrix[14] - eye.z;
      instance.depth = forward
        ? dx * forward.x + dy * forward.y + dz * forward.z
        : dx * dx + dy * dy + dz * dz;
      // Stable insertion sort is bounded to six shells per mob. Three sorts
      // objects, not instances; this prevents spawn-order-dependent overlaps.
      let j = i;
      while (j > 0 && this.gelInstances[j - 1].depth < instance.depth) {
        this.gelInstances[j] = this.gelInstances[j - 1];
        j--;
      }
      this.gelInstances[j] = instance;
    }
    for (let i = 0; i < this.gelCount; i++) {
      const { part, flash, hitFlash } = this.gelInstances[i];
      this.uploadMobPart(
        this.gelMesh,
        this.gelResources,
        i,
        part,
        flash,
        hitFlash
      );
    }
    this.gelMesh.count = this.gelCount;
    this.gelMesh.instanceMatrix.needsUpdate = true;
    this.gelMesh.instanceColor.needsUpdate = true;
    this.gelResources.update();
    // Keep the batch's sort center current relative to other transparent objects.
    this.gelMesh.computeBoundingSphere();
  }

  serialize() {
    return {
      version: 1,
      seed: String(this.world.seed),
      dimension: this.dimension,
      randomState: this.randomState,
      nextId: this.nextId,
      killed: [...this.killed],
      entities: [...this.byId.values()].map((mob) => ({
        id: mob.id,
        kind: mob.kind,
        position: positionData(mob.position),
        health: mob.health,
        yaw: normalizeMobHeading(mob.root.rotation.y),
        tamed: mob.tamed,
        angry: mob.angry,
        attackCooldown: mob.attackCooldown,
        fuse: mob.fuse,
        pacified: mob.pacified,
        ...(mob.kind === "sulfur_cube"
          ? { absorbedBlock: mob.absorbedBlock }
          : {}),
      })),
    };
  }

  load(data, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options))
      return false;
    if (this.ecologyServices?.active) return false;
    let context;
    try {
      context = entityContextFor(
        this.world,
        options.context ?? this.worldContext
      );
    } catch {
      return false;
    }
    if (
      this.disposed ||
      dimensionOf(this.world) !== this.dimension ||
      !matchesEntityContext(this.world, context)
    )
      return false;
    const snapshot = normalizeMobSnapshot(data, context, this.dimension);
    const ecology = options.ecology ?? this.ecologyServices?.ecology;
    if (!snapshot ||
      snapshot.entities.filter((entry) => !MOB_SPECIES[entry.kind].ecology).length > this.maxEntities ||
      snapshot.entities.some((entry) => MOB_SPECIES[entry.kind].ecology &&
        (!ecology?.canRestore(entry.id, entry.kind, this.dimension) ||
          !validMobPosition(entry.position, ecologyCollider(entry.kind, ecology.state(entry.id)), context, this.dimension))))
      return false;
    // Build all runtime records only after the complete pure preflight succeeds.
    // A model allocation failure cannot clear the old ecosystem or advance RNG.
    // Preserve legacy initialization of unsaved wander/animation fields.
    let randomState = this.randomState;
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 4294967296;
    };
    const next = snapshot.entities.map((entry) => {
      const mob = this._createEntity(
        entry.kind,
        entry.position,
        entry.id,
        random
      );
      Object.assign(mob, {
        health: entry.health,
        tamed: entry.tamed,
        angry: entry.angry,
        attackCooldown: entry.attackCooldown,
        fuse: entry.fuse,
        pacified: entry.pacified,
      });
      setSulfurBlock(mob, entry.absorbedBlock ?? null);
      mob.root.rotation.y = entry.yaw;
      if (mob.spec.ecology) mob.root.scale.setScalar(ecologyVisualScale(ecology.state(mob.id)));
      mob.dormant = mob.spec.ecology || !footprintLoaded(
        this.world,
        mob.position.x,
        mob.position.z,
        mob.spec.radius
      );
      return mob;
    });
    const byId = new Map(next.map((mob) => [mob.id, mob]));
    const killed = new Set(snapshot.killed);
    const active = next.filter((mob) => !mob.spec.ecology);
    const dormant = new Map();
    for (const mob of next) {
      if (!mob.spec.ecology) continue;
      if (mob.dormant || active.length >= this.maxEntities) {
        mob.dormant = true;
        dormant.set(mob.id, mob);
      } else active.push(mob);
    }
    for (const mob of this.byId.values()) mob.dead = true;
    this.entities = this.animals = active;
    this.byId = byId;
    this.dormantEcology = dormant;
    this._dormantIterator = null;
    this._ecologyRevision++;
    this.killed = killed;
    this.projectiles.length = 0;
    this.worldContext = context;
    this.context.worldContext = context;
    this.randomState = snapshot.randomState;
    this.nextId = snapshot.nextId;
    this.render(0);
    return true;
  }

  dispose() {
    if (this.disposed) return true;
    // Host captures the complete base snapshot before resources disappear.
    if (this.ecologyServices && !this.ecologyServices.suspend()) return false;
    this.disposed = true;
    this.scene.remove(this.group);
    this.clearGelBatch();
    this.mesh.dispose();
    this.skinResources.dispose();
    for (const instance of this.gelInstances) instance.part = null;
    this.entities.length = 0;
    this.byId.clear();
    this.dormantEcology.clear();
    this._dormantIterator = null;
    this.projectiles.length = 0;
    this.killed.clear();
    return true;
  }
}

export default Wildlife;
