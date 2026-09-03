import {
  admitEcologySpawn,
  AQUATIC_AI_LIMITS,
  clearAquaticIntent,
  ecologyBodySample,
  ecologyCanOccupy,
  ecologyDistance,
  ecologyEye,
  ecologyLineOfSight,
  ecologyPoint,
  ecologySupportAt,
  findDolphinGuide,
  guardianRetaliation,
  isElderMarker,
  isTurtleBeach,
  ELDER_MARKER_KEYS,
  stepAquaticMob,
  synchronousEcologyHook,
} from "./aquatic-ai.js";
import { captureEntityContext, matchesEntityContext } from "./entity-context.js";
import { finitePosition } from "./mob-navigation.js";
import { admitNpcSpawn, clearNpcIntent, readVillagerAvailability, stepNpcMob } from "./npc-ai.js";
import { encodedBytes } from "./save-budget.js";
import { WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { TransactionInvariantError } from "./transactions.js";
import { createWorldContext, DIMENSIONS, getWorldSpec } from "./world-spec.js";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const passive = (name, habitat, extra) => ({
  name, habitat, dimension: "overworld", temperament: "passive",
  health: 10, speed: 1, radius: 0.45, height: 0.6, eyeHeight: 0.5,
  stepHeight: 0.6, vision: 16, reach: 1.8, damage: 0, cooldown: 1.5,
  drops: [], ecology: true, ...extra,
});
const hostile = (name, habitat, extra) => passive(name, habitat, {
  temperament: "hostile", health: 20, damage: 4, ...extra,
});

/** Registered by MOB_SPECIES; Wildlife activates this domain explicitly.
 * Symbolic food/rewards are resolved by prepared Game hooks, never raw IDs here.
 * `aquatic` describes spawn habitat; it must NOT select legacy full-water motion.
 */
export const ECOLOGY_SPECIES = freeze({
  dolphin: passive("Dolphin", /ocean$/, {
    health: 10, speed: 2.7, radius: 0.45, height: 0.6, eyeHeight: 0.55,
    aquatic: true, minWaterDepth: 2, limit: 3, foodNames: ["RAW_COD", "RAW_SALMON"],
  }),
  turtle: passive("Turtle", /beach|ocean$/, {
    health: 30, speed: 0.65, radius: 0.6, height: 0.55, eyeHeight: 0.42,
    amphibious: true, limit: 4, foodNames: ["SEAGRASS"],
  }),
  drowned: hostile("Drowned", /ocean$|river$/, {
    speed: 1.3, radius: 0.32, height: 1.95, eyeHeight: 1.62,
    aquatic: true, amphibious: true, minWaterDepth: 2, vision: 18, limit: 4,
    variant: "unarmed",
  }),
  guardian: hostile("Guardian", /ocean$/, {
    health: 30, speed: 1.5, radius: 0.46, height: 0.9, eyeHeight: 0.47,
    aquatic: true, minWaterDepth: 2, vision: 22, reach: 16, damage: 6,
    cooldown: 2.5, limit: 5, structureOnly: "ocean_monument",
  }),
  elder_guardian: hostile("Elder guardian", /ocean$/, {
    health: 80, speed: 0.8, radius: 0.85, height: 1.7, eyeHeight: 0.9,
    aquatic: true, minWaterDepth: 3, vision: 24, reach: 20, damage: 8,
    cooldown: 3, limit: 3, structureOnly: "ocean_monument", unique: true,
  }),
  villager: passive("Villager", /plains|meadow|savanna|desert|taiga|snowy/, {
    health: 20, speed: 1.1, radius: 0.32, height: 1.95, eyeHeight: 1.7,
    harmless: true, limit: 8, structureOnly: "village",
  }),
  blaze: hostile("Blaze", /nether/, {
    dimension: "nether", health: 20, speed: 1.2, radius: 0.45, height: 1.8,
    eyeHeight: 1.45, flying: true, fireImmune: true, vision: 22, reach: 18,
    damage: 5, cooldown: 4, limit: 4, structureOnly: "nether_fortress",
  }),
});

export const ECOLOGY_CONTENT_PROPOSALS = freeze({
  newItems: {
    RAW_COD: { source: "cod/fishing", use: "food and dolphin feeding" },
    RAW_SALMON: { source: "fishing", use: "food and dolphin feeding" },
    SCUTE: { source: "one per baby turtle reaching adulthood, never death", use: "turtle shell recipe" },
    BLAZE_ROD: { source: "player-credited blaze death", use: "brewing stand and blaze powder" },
  },
  newBlocks: {
    TURTLE_EGG: {
      support: "sand", collision: "none", selection: "small egg cluster",
      itemUse: "caller-owned placement/break/hatch transaction",
      persistence: "Ecology egg ledger owns age/child identity; block is a visible projection",
    },
  },
  existingContent: ["SEAGRASS", "PRISMARINE_SHARD", "PRISMARINE_CRYSTALS", "WET_SPONGE"],
  effects: {
    dolphins_grace: { swimSpeedMultiplier: 1.6, refreshSeconds: 1.5 },
    mining_fatigue: { level: 2, duration: 40, sourceScoped: true },
  },
  unsupported: [
    "Drowned are unarmed: no trident equipment/projectiles, trident loot, or free conversion weapon.",
    "No dolphin mounting/taming, turtle kill scutes, villager-generated trade stock, or boss campaign.",
  ],
});

export const ECOLOGY_LIMITS = Object.freeze({
  entries: 512, eggs: 256, elders: 1024,
  dolphinAir: 240, dolphinDry: 20, assistance: 45, guidance: 90,
  turtleGrowth: 1200, turtleLove: 30, turtleBreed: 300, eggHatch: 300,
  interactionReach: 4, clutchSerial: 1_000_000, eggBatch: 32,
});
// Authored structure IDs include the escaped world seed. Keep the full marker
// identity in this ledger, and a separate <=100-char base-mob ID supplied by
// Wildlife. Never hash/truncate an ownership identity to fit mob-save v1.
export const MAX_ECOLOGY_STRUCTURE_ID = AQUATIC_AI_LIMITS.structureIdentity;
export const MAX_ECOLOGY_MARKER_ID = 1200;
// The additional 1024 bytes per entry reserve its complete Wildlife base pose
// even in an inactive dimension. No separate unbudgeted dormant-mob archive.
const STATE_BYTES = 4096;
const RESERVATION = Object.freeze({ entries: STATE_BYTES + 1024, eggs: 1024, elders: 4096 });
const HEADER_BYTES = 1024;
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const fields = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.includes(key));
const range = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
const id = (value, maximum = 100) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const commonFields = ["id", "kind", "dimension", "alive", "home"];
const eggPositionKey = (egg) =>
  `${egg.dimension}:${egg.position.x},${egg.position.y},${egg.position.z}`;
const extraFields = Object.freeze({
  dolphin: ["air", "dryTime", "assistTime", "guide"],
  turtle: ["homeBeach", "growthRemaining", "scuteClaimed", "loveTime", "breedCooldown", "gravid", "clutchSerial"],
  drowned: ["variant"],
  guardian: ["structureId"],
  elder_guardian: ["structureId", "markerId"],
  villager: ["memberId"],
  blaze: ["structureId"],
});

function canonicalContext(context) {
  if (!record(context) || context.seed === undefined || String(context.seed).length > 80)
    throw new RangeError("Ecology requires an explicit world context");
  for (const dimension of DIMENSIONS) {
    const expected = getWorldSpec(context.generatorVersion, dimension);
    if (context.specForDimension) {
      const actual = context.specForDimension(dimension);
      if (["minY", "maxY", "seaLevel", "voidY"].some((key) => actual?.[key] !== expected[key]))
        throw new RangeError("Ecology context bounds mismatch");
    }
  }
  return createWorldContext({ seed: String(context.seed), generatorVersion: context.generatorVersion });
}

function positionValid(position, context, dimension, collider = { radius: 0, height: 0 }) {
  if (!fields(position, ["x", "y", "z"]) || !finitePosition(position) || !DIMENSIONS.includes(dimension))
    return false;
  const spec = context.specForDimension(dimension);
  return position.x >= WORLD_MIN + collider.radius && position.x <= WORLD_MAX - collider.radius &&
    position.z >= WORLD_MIN + collider.radius && position.z <= WORLD_MAX - collider.radius &&
    (collider.radius > 0 || (position.x < WORLD_MAX && position.z < WORLD_MAX)) &&
    position.y >= spec.minY && position.y + collider.height <= spec.maxY &&
    (collider.height > 0 || position.y < spec.maxY);
}

/** Always use this collider for runtime navigation/physical picking. Baby scale
 * is derived from a committed growth flag; neutral model bounds are unrelated.
 */
export function ecologyCollider(kind, state) {
  const spec = Object.hasOwn(ECOLOGY_SPECIES, kind) ? ECOLOGY_SPECIES[kind] : null;
  if (!spec) return null;
  const scale = kind === "turtle" && state?.scuteClaimed === false ? 0.5 : 1;
  return Object.freeze({
    radius: spec.radius * scale, height: spec.height * scale,
    eyeHeight: spec.eyeHeight * scale, stepHeight: 0.6,
  });
}

export function ecologyVisualScale(state) {
  return state?.kind === "turtle" && !state.scuteClaimed ? 0.5 : 1;
}

/** Strict detached sidecar, NOT extra keys hidden in mob-save v1. */
export function normalizeEcologyState(value, context) {
  try {
    if (
      !record(value) || !Object.hasOwn(ECOLOGY_SPECIES, value.kind) ||
      !fields(value, [...commonFields, ...extraFields[value.kind]]) ||
      !id(value.id) || value.dimension !== ECOLOGY_SPECIES[value.kind].dimension ||
      typeof value.alive !== "boolean" ||
      !positionValid(value.home, context, value.dimension, ecologyCollider(value.kind, value))
    ) return null;
    const result = {
      id: value.id, kind: value.kind, dimension: value.dimension,
      alive: value.alive, home: ecologyPoint(value.home),
    };
    if (value.kind === "dolphin") {
      if (!range(value.air, 0, ECOLOGY_LIMITS.dolphinAir) ||
        !range(value.dryTime, 0, ECOLOGY_LIMITS.dolphinDry) ||
        !range(value.assistTime, 0, ECOLOGY_LIMITS.assistance)) return null;
      let guide = null;
      if (value.guide !== null) {
        const g = value.guide;
        if (!fields(g, ["id", "kind", "position", "remaining"]) || !id(g.id, MAX_ECOLOGY_STRUCTURE_ID) ||
          !["shipwreck", "ocean_ruin"].includes(g.kind) ||
          !positionValid(g.position, context, value.dimension) ||
          !range(g.remaining, Number.MIN_VALUE, ECOLOGY_LIMITS.guidance)) return null;
        guide = { id: g.id, kind: g.kind, position: ecologyPoint(g.position), remaining: g.remaining };
      }
      Object.assign(result, { air: value.air, dryTime: value.dryTime, assistTime: value.assistTime, guide });
    } else if (value.kind === "turtle") {
      if (!positionValid(value.homeBeach, context, value.dimension, ecologyCollider("turtle")) ||
        !range(value.growthRemaining, 0, ECOLOGY_LIMITS.turtleGrowth) ||
        typeof value.scuteClaimed !== "boolean" || (value.scuteClaimed && value.growthRemaining !== 0) ||
        !range(value.loveTime, 0, ECOLOGY_LIMITS.turtleLove) ||
        !range(value.breedCooldown, 0, ECOLOGY_LIMITS.turtleBreed) ||
        typeof value.gravid !== "boolean" || (value.gravid && value.loveTime > 0) ||
        (!value.scuteClaimed && (value.gravid || value.loveTime > 0)) ||
        !Number.isSafeInteger(value.clutchSerial) || !range(value.clutchSerial, 0, ECOLOGY_LIMITS.clutchSerial))
        return null;
      Object.assign(result, {
        homeBeach: ecologyPoint(value.homeBeach), growthRemaining: value.growthRemaining,
        scuteClaimed: value.scuteClaimed, loveTime: value.loveTime,
        breedCooldown: value.breedCooldown, gravid: value.gravid, clutchSerial: value.clutchSerial,
      });
    } else if (value.kind === "drowned") {
      if (value.variant !== "unarmed") return null;
      result.variant = "unarmed";
    } else if (["guardian", "elder_guardian", "blaze"].includes(value.kind)) {
      if (!id(value.structureId, MAX_ECOLOGY_STRUCTURE_ID)) return null;
      result.structureId = value.structureId;
      if (value.kind === "elder_guardian") {
        if (!id(value.markerId, MAX_ECOLOGY_MARKER_ID)) return null;
        result.markerId = value.markerId;
      }
    } else if (value.kind === "villager") {
      if (!id(value.memberId, MAX_ECOLOGY_MARKER_ID)) return null;
      result.memberId = value.memberId;
    }
    return encodedBytes(result) + 1 <= STATE_BYTES ? result : null;
  } catch {
    return null;
  }
}

export function createEcologyState(kind, entityId, position, context, options = {}) {
  if (!Object.hasOwn(ECOLOGY_SPECIES, kind) || !finitePosition(position) ||
    !record(options) || (options.homeBeach !== undefined && !finitePosition(options.homeBeach))) return null;
  const value = {
    id: entityId, kind, dimension: ECOLOGY_SPECIES[kind].dimension, alive: true,
    home: ecologyPoint(position),
  };
  if (kind === "dolphin") Object.assign(value, {
    air: ECOLOGY_LIMITS.dolphinAir, dryTime: 0, assistTime: 0, guide: null,
  });
  if (kind === "turtle") Object.assign(value, {
    homeBeach: ecologyPoint(options.homeBeach ?? position),
    growthRemaining: options.baby ? ECOLOGY_LIMITS.turtleGrowth : 0,
    scuteClaimed: !options.baby, loveTime: 0, breedCooldown: 0, gravid: false, clutchSerial: 0,
  });
  if (kind === "drowned") value.variant = "unarmed";
  if (["guardian", "elder_guardian", "blaze"].includes(kind)) value.structureId = options.structureId;
  if (kind === "elder_guardian") value.markerId = options.markerId ?? entityId;
  if (kind === "villager") value.memberId = options.memberId ?? entityId;
  return normalizeEcologyState(value, context);
}

function normalizeEgg(value, context) {
  if (
    !fields(value, ["id", "parentId", "childId", "serial", "dimension", "position", "remaining", "status"]) ||
    !id(value.id) || !id(value.parentId) || !id(value.childId) ||
    new Set([value.id, value.parentId, value.childId]).size !== 3 ||
    value.dimension !== "overworld" ||
    !Number.isSafeInteger(value.serial) || !range(value.serial, 1, ECOLOGY_LIMITS.clutchSerial) ||
    !positionValid(value.position, context, value.dimension, ecologyCollider("turtle")) ||
    !range(value.remaining, 0, ECOLOGY_LIMITS.eggHatch) ||
    !["incubating", "hatched", "broken"].includes(value.status) ||
    (value.status === "hatched" && value.remaining !== 0)
  ) return null;
  const result = { ...value, position: ecologyPoint(value.position) };
  return encodedBytes(result) + 1 <= RESERVATION.eggs ? result : null;
}

function normalizeElder(value) {
  if (
    !fields(value, ["id", "entityId", "structureId", "key", "dimension", "status"]) ||
    !id(value.id, MAX_ECOLOGY_MARKER_ID) || !id(value.entityId) ||
    !id(value.structureId, MAX_ECOLOGY_STRUCTURE_ID) || !ELDER_MARKER_KEYS.includes(value.key) ||
    value.id !== `${value.structureId}/encounter/${value.key}` ||
    value.dimension !== "overworld" || !["alive", "defeated"].includes(value.status)
  ) return null;
  const result = { ...value };
  return encodedBytes(result) + 1 <= RESERVATION.elders ? result : null;
}

export function normalizeEcologySnapshot(data, suppliedContext) {
  try {
    const context = canonicalContext(suppliedContext);
    const empty = {
      version: 1, seed: context.seed, generatorVersion: context.generatorVersion,
      entries: [], eggs: [], elders: [],
    };
    if (data === undefined) return empty;
    if (!fields(data, Object.keys(empty)) || data.version !== 1 ||
      data.seed !== context.seed || data.generatorVersion !== context.generatorVersion) return null;
    const stores = {};
    for (const [name, normalize] of [
      ["entries", (value) => normalizeEcologyState(value, context)],
      ["eggs", (value) => normalizeEgg(value, context)],
      ["elders", normalizeElder],
    ]) {
      if (!Array.isArray(data[name]) || data[name].length > ECOLOGY_LIMITS[name]) return null;
      const store = (stores[name] = new Map());
      for (const raw of data[name]) {
        const entry = normalize(raw);
        if (!entry || store.has(entry.id)) return null;
        store.set(entry.id, entry);
      }
    }
    const clutches = new Set(), children = new Set(), eggPositions = new Set();
    for (const egg of stores.eggs.values()) {
      const parent = stores.entries.get(egg.parentId);
      const child = stores.entries.get(egg.childId);
      const clutch = `${egg.parentId}/${egg.serial}`;
      if (parent?.kind !== "turtle" || parent.clutchSerial < egg.serial ||
        stores.entries.has(egg.id) || stores.eggs.has(egg.childId) ||
        clutches.has(clutch) || children.has(egg.childId) ||
        (egg.status === "hatched"
          ? child?.kind !== "turtle"
          : child !== undefined)) return null;
      clutches.add(clutch);
      children.add(egg.childId);
      if (egg.status === "incubating") {
        const key = eggPositionKey(egg);
        if (eggPositions.has(key)) return null;
        eggPositions.add(key);
      }
    }
    for (const elder of stores.elders.values()) {
      const state = stores.entries.get(elder.entityId);
      if (state?.kind !== "elder_guardian" || state.structureId !== elder.structureId ||
        state.markerId !== elder.id || state.alive !== (elder.status === "alive")) return null;
    }
    const members = new Set();
    for (const state of stores.entries.values()) {
      if (state.kind === "elder_guardian" && stores.elders.get(state.markerId)?.entityId !== state.id) return null;
      if (state.kind === "villager") {
        if (members.has(state.memberId)) return null;
        members.add(state.memberId);
      }
    }
    return {
      ...empty,
      ...Object.fromEntries(Object.entries(stores).map(([name, store]) => [
        name, [...store.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ])),
    };
  } catch {
    return null;
  }
}

/** Call in archive preflight AFTER mob-save accepts registered species.
 * Base pose/health/id stay in Wildlife; extra timers/one-shot state stay here.
 * Dormant ecology residents must be retained by Wildlife, not regenerated.
 */
export function ecologyMobLinksValid(snapshot, mobSnapshots) {
  if (!snapshot || !Array.isArray(mobSnapshots)) return false;
  const states = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const liveIds = new Set();
  for (const mobs of mobSnapshots) {
    if (!Array.isArray(mobs?.entities)) return false;
    for (const mob of mobs.entities) {
      if (!Object.hasOwn(ECOLOGY_SPECIES, mob.kind)) continue;
      const state = states.get(mob.id);
      if (!state?.alive || state.kind !== mob.kind || state.dimension !== mobs.dimension ||
        liveIds.has(mob.id)) return false;
      liveIds.add(mob.id);
    }
  }
  // Every living ecology record owns a base pose, including ordinary swimmers.
  // Chunk eviction is suspension, never silent despawn/recreation or healing.
  return snapshot.entries.every((state) => !state.alive || liveIds.has(state.id));
}

function prepareHook(hook, ...args) {
  if (!synchronousEcologyHook(hook)) return null;
  try {
    const value = hook(...args);
    return record(value) && !value.then &&
      synchronousEcologyHook(value.validate) && synchronousEcologyHook(value.publish)
      ? value : null;
  } catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return null;
  }
}

/** CPU domain owner; constructor does NOT register a species, material, save
 * reservation or archive. Stage it, then register reservedBytes with the SAME
 * coordinator as Gameplay/World/Wildlife/loot/XP before using prepared plans.
 * All returned plans must be committed ONCE as a whole. Never publish by hand.
 */
export class ExpansionEcology {
  constructor({ context, coordinator, snapshot, onChange } = {}) {
    this.context = canonicalContext(context);
    const data = normalizeEcologySnapshot(snapshot, this.context);
    if (!data || !coordinator ||
      (onChange !== undefined && !synchronousEcologyHook(onChange)))
      throw new RangeError("Invalid ecology owner");
    this.coordinator = coordinator;
    this.onChange = onChange;
    this._stores = Object.fromEntries(["entries", "eggs", "elders"].map((name) => [
      name, new Map(data[name].map((entry) => [entry.id, freeze(entry)])),
    ]));
    this._revision = 0;
    this._disposed = false;
    this._bytes = this._reservation();
    this._childIds = new Set(data.eggs.map((egg) => egg.childId));
    this._eggOrder = data.eggs.map((egg) => egg.id);
    this._eggPositions = new Map(data.eggs.filter((egg) => egg.status === "incubating")
      .map((egg) => [eggPositionKey(egg), egg.id]));
    this._markerEntities = new Map([
      ...data.elders.map((elder) => [elder.id, elder.entityId]),
      ...data.entries.filter((entry) => entry.kind === "villager")
        .map((entry) => [entry.memberId, entry.id]),
    ]);
  }

  get reservedBytes() { return this._bytes; }
  get revision() { return this._revision; }
  state(entityId) { return this._stores.entries.get(entityId) ?? null; }
  egg(eggId) { return this._stores.eggs.get(eggId) ?? null; }
  eggAt(dimension, position) {
    return this.egg(this._eggPositions.get(eggPositionKey({ dimension, position })));
  }
  elder(markerId) { return this._stores.elders.get(markerId) ?? null; }
  entityIdForMarker(markerId) {
    return this._markerEntities.get(markerId) ?? null;
  }
  identityReserved(entityId) {
    return this._stores.entries.has(entityId) || this._stores.eggs.has(entityId) ||
      this._childIds.has(entityId);
  }
  eggIds(cursor = 0, limit = 4) {
    const count = Math.min(this._eggOrder.length, Math.max(0, Math.min(8, Math.floor(limit))));
    return Array.from({ length: count }, (_, i) => this._eggOrder[(cursor + i) % this._eggOrder.length]);
  }
  invalidateAvailability() { this._revision++; }
  _reservation(sizes = Object.fromEntries(Object.entries(this._stores).map(([key, map]) => [key, map.size]))) {
    return HEADER_BYTES + Object.keys(RESERVATION).reduce((sum, name) => sum + sizes[name] * RESERVATION[name], 0);
  }
  serialize() {
    return normalizeEcologySnapshot({
      version: 1, seed: this.context.seed, generatorVersion: this.context.generatorVersion,
      ...Object.fromEntries(Object.entries(this._stores).map(([name, map]) => [name, [...map.values()]])),
    }, this.context);
  }
  canRestore(entityId, kind, dimension) {
    const state = this.state(entityId);
    return !this._disposed && state?.alive === true && state.kind === kind && state.dimension === dimension &&
      (kind !== "elder_guardian" || this.elder(state.markerId)?.status === "alive");
  }

  _worldMatches(world) {
    return matchesEntityContext(world, this.context) && world?.generatorVersion === this.context.generatorVersion;
  }
  _live(mob, ctx) {
    const state = this.state(mob?.id);
    return !this._disposed && !!state?.alive && !mob.dead && !mob.dormant && mob.health > 0 &&
      state.kind === mob.kind && state.dimension === ctx.world?.dimension &&
      this._worldMatches(ctx.world) && ctx.getMob?.(mob.id) === mob;
  }

  _capture(mob, ctx, interaction = false) {
    if (!this._live(mob, ctx)) return null;
    const world = ctx.world, getMob = ctx.getMob;
    const current = captureEntityContext(world, this.context);
    const position = ecologyPoint(mob.position), health = mob.health;
    const revision = world._editRevision;
    const chunks = [];
    // Connected-shape neighbors and the player's short interaction ray fit
    // within these loaded chunk identities; epoch/edit revision pin ABA edits.
    if (world.chunks instanceof Map) {
      const points = [position, ...(interaction && finitePosition(ctx.player) ? [ctx.player] : [])];
      const seen = new Set();
      for (const point of points)
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const key = `${Math.floor((point.x + dx * 2) / 16)},${Math.floor((point.z + dz * 2) / 16)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const chunk = world.chunks.get(key);
            chunks.push({ key, chunk, incarnation: chunk?.incarnation, revision: chunk?.revision });
          }
    }
    const player = interaction && finitePosition(ctx.playerEye) ? ecologyPoint(ctx.playerEye) : null;
    const targetKey = ctx.playerTargetKey, mode = ctx.mode;
    const allowed = () => this._live(mob, ctx) &&
      ecologyCanOccupy(world, mob.position, ecologyCollider(mob.kind, this.state(mob.id))) &&
      (!interaction || (ctx.health > 0 &&
        (ctx.playerDimension ?? ctx.dimension) === world.dimension &&
        ecologyDistance(ecologyEye(mob, ecologyCollider(mob.kind, this.state(mob.id))), ctx.playerEye) <= ECOLOGY_LIMITS.interactionReach &&
        ecologyLineOfSight(world, ecologyEye(mob, ecologyCollider(mob.kind, this.state(mob.id))), ctx.playerEye)));
    if (!allowed()) return null;
    return () => !this._disposed && ctx.world === world && ctx.getMob === getMob &&
      current() && world._editRevision === revision && allowed() && mob.health === health &&
      ecologyDistance(mob.position, position) === 0 &&
      (!player || (ctx.playerTargetKey === targetKey && ctx.mode === mode &&
        ecologyDistance(ctx.playerEye, player) === 0)) &&
      chunks.every(({ key, chunk, incarnation, revision }) =>
        world.chunks.get(key) === chunk && chunk?.incarnation === incarnation && chunk?.revision === revision);
  }

  _prepare(changes, ctx, guard = () => true) {
    if (this._disposed || !this._worldMatches(ctx.world) || !synchronousEcologyHook(guard)) return null;
    const revision = this._revision, beforeBytes = this._bytes;
    const coordinator = this.coordinator, world = ctx.world, context = this.context;
    const current = captureEntityContext(world, context);
    const stores = this._stores, seen = new Set(), edits = [];
    const sizes = Object.fromEntries(Object.entries(stores).map(([name, map]) => [name, map.size]));
    for (const { store: name, value } of changes) {
      const key = `${name}/${value?.id}`;
      if (!Object.hasOwn(stores, name) || seen.has(key)) return null;
      seen.add(key);
      const next = name === "entries" ? normalizeEcologyState(value, context)
        : name === "eggs" ? normalizeEgg(value, context) : normalizeElder(value);
      if (!next) return null;
      const previous = stores[name].get(next.id);
      if (name === "eggs" && next.status === "incubating" &&
        this._eggPositions.has(eggPositionKey(next)) &&
        this._eggPositions.get(eggPositionKey(next)) !== next.id) return null;
      if (!previous) sizes[name]++;
      if (sizes[name] > ECOLOGY_LIMITS[name]) return null;
      edits.push({ name, previous, next: freeze(next) });
    }
    const afterBytes = this._reservation(sizes);
    let used = false;
    return Object.freeze({
      owner: this, beforeBytes, afterBytes,
      validate: () => !used && !this._disposed && this._revision === revision &&
        this._bytes === beforeBytes && this._stores === stores &&
        this.context === context && this.coordinator === coordinator &&
        coordinator.usage(this) === beforeBytes && ctx.world === world && current() &&
        edits.every(({ name, previous, next }) => stores[name].get(next.id) === previous) &&
        guard() === true,
      publish: () => {
        used = true;
        for (const { name, previous, next } of edits) {
          stores[name].set(next.id, next);
          if (name === "eggs" && !previous) {
            this._childIds.add(next.childId);
            this._eggOrder.push(next.id);
          }
          if (name === "eggs") {
            if (previous?.status === "incubating")
              this._eggPositions.delete(eggPositionKey(previous));
            if (next.status === "incubating")
              this._eggPositions.set(eggPositionKey(next), next.id);
          }
          if (name === "elders") this._markerEntities.set(next.id, next.entityId);
          if (name === "entries" && next.kind === "villager")
            this._markerEntities.set(next.memberId, next.id);
        }
        this._bytes = afterBytes;
        this._revision++;
      },
      notify: () => this.onChange?.(),
    });
  }

  _plan(source, participants, result) {
    if (!source || participants.some((part) => !part)) return null;
    const all = [source, ...participants];
    if (new Set(all.map((part) => part.owner)).size !== all.length ||
      all.some((part) => this.coordinator.usage(part.owner) !== part.beforeBytes)) return null;
    return Object.freeze({ participants: Object.freeze(all), result: freeze(result) });
  }

  /** Prepared spawn participant owns base entity creation/capacity. Population
   * must include water hostiles; do not funnel these through legacy waterHome.
   */
  prepareAdmission({ id: entityId, kind, position }, ctx, { prepareSpawn } = {}) {
    if (kind === "elder_guardian" || !Object.hasOwn(ECOLOGY_SPECIES, kind) ||
      !finitePosition(position) || this.identityReserved(entityId) || ctx.getMob?.(entityId) ||
      (kind === "villager" && this.entityIdForMarker(ctx.marker?.id) !== null)) return null;
    position = ecologyPoint(position);
    const structure = ctx.structure, marker = ctx.marker;
    const state = createEcologyState(kind, entityId, position, this.context, {
      homeBeach: ctx.homeBeach, structureId: structure?.id, memberId: marker?.id,
    });
    const collider = ecologyCollider(kind, state);
    const valid = () => {
      if (state?.dimension !== ctx.world.dimension ||
        (ECOLOGY_SPECIES[kind].structureOnly && (!structure || ctx.structure !== structure ||
          ctx.getStructure?.(structure.id) !== structure)) ||
        (["villager", "blaze"].includes(kind) && (!marker || ctx.marker !== marker ||
          ctx.getMarker?.(marker.id) !== marker))) return false;
      return kind === "villager" || kind === "blaze"
        ? admitNpcSpawn(kind, position, collider, ctx)
        : admitEcologySpawn(kind, position, collider, ctx);
    };
    if (!state || !valid()) return null;
    const spawn = prepareHook(prepareSpawn, freeze({ id: entityId, kind, position: ecologyPoint(position) }));
    const source = this._prepare([{ store: "entries", value: state }], ctx,
      () => !this.state(entityId) && !ctx.getMob?.(entityId) && valid());
    return this._plan(source, [spawn], { ok: true, id: entityId });
  }

  prepareElderAdmission(structure, marker, ctx, { entityId = marker?.id, prepareSpawn } = {}) {
    if (!isElderMarker(structure, marker) || this.elder(marker.id) || this.identityReserved(entityId) ||
      ctx.getStructure?.(structure.id) !== structure || ctx.getMarker?.(marker.id) !== marker) return null;
    const position = { x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5 };
    const state = createEcologyState("elder_guardian", entityId, position, this.context, {
      structureId: structure.id, markerId: marker.id,
    });
    const spawnContext = { ...ctx, structure, marker };
    const valid = () => ctx.getStructure?.(structure.id) === structure &&
      ctx.getMarker?.(marker.id) === marker &&
      admitEcologySpawn("elder_guardian", position, ecologyCollider("elder_guardian"), spawnContext);
    if (!state || !valid()) return null;
    const spawn = prepareHook(prepareSpawn, freeze({ id: entityId, kind: "elder_guardian", position }));
    const source = this._prepare([
      { store: "entries", value: state },
      { store: "elders", value: {
        id: marker.id, entityId, structureId: structure.id, key: marker.key,
        dimension: "overworld", status: "alive",
      } },
    ], ctx, () => !this.elder(marker.id) && !ctx.getMob?.(entityId) && valid());
    return this._plan(source, [spawn], { ok: true, id: entityId, markerId: marker.id });
  }

  /** prepareConsume(name,count) must pin the actual hand, stack metadata and
   * hand revision. No eager Gameplay.consume call and no observer-owned debit.
   */
  prepareFeed(mob, itemName, ctx, { prepareConsume } = {}) {
    const guard = this._capture(mob, ctx, true);
    const previous = this.state(mob?.id);
    if (!guard || !["dolphin", "turtle"].includes(mob.kind)) return null;
    let next, guideDescriptor = null;
    if (mob.kind === "dolphin") {
      const sample = ecologyBodySample(ctx.world, mob.position, ecologyCollider("dolphin"), ctx.sampleFluid);
      if (!ECOLOGY_SPECIES.dolphin.foodNames.includes(itemName) ||
        previous.assistTime > ECOLOGY_LIMITS.assistance - 5 ||
        !sample || sample.waterImmersion < 0.2)
        return null;
      const descriptors = synchronousEcologyHook(ctx.nearbyStructures) && synchronousEcologyHook(ctx.getStructure)
        ? ctx.nearbyStructures(mob.position, {
          kinds: ["shipwreck", "ocean_ruin"],
          radius: AQUATIC_AI_LIMITS.guideDistance, limit: AQUATIC_AI_LIMITS.descriptors,
        }) : [];
      const current = Array.isArray(descriptors) ? descriptors.slice(0, AQUATIC_AI_LIMITS.descriptors)
        .filter((descriptor) => descriptor && ctx.getStructure(descriptor.id) === descriptor) : [];
      const guide = findDolphinGuide(mob.position, previous.dimension, current);
      if (!guide && !synchronousEcologyHook(ctx.applyEffect)) return null;
      if (guide) guideDescriptor = ctx.getStructure(guide.id);
      next = {
        ...previous, assistTime: ECOLOGY_LIMITS.assistance,
        guide: guide ? { ...guide, remaining: ECOLOGY_LIMITS.guidance } : null,
      };
    } else {
      if (itemName !== "SEAGRASS" || !previous.scuteClaimed || previous.gravid ||
        previous.loveTime > 0 || previous.breedCooldown > 0) return null;
      next = { ...previous, loveTime: ECOLOGY_LIMITS.turtleLove };
    }
    const consume = prepareHook(prepareConsume, itemName, 1);
    const source = this._prepare([{ store: "entries", value: next }], ctx,
      () => guard() && (!guideDescriptor || ctx.getStructure?.(guideDescriptor.id) === guideDescriptor));
    return this._plan(source, [consume], { ok: true, kind: mob.kind, guide: next.guide?.id ?? null });
  }

  prepareBreeding(first, second, ctx) {
    const a = this.state(first?.id), b = this.state(second?.id);
    const guardA = this._capture(first, ctx), guardB = this._capture(second, ctx);
    const eligible = (state) => state?.kind === "turtle" && state.scuteClaimed &&
      state.loveTime > 0 && state.breedCooldown === 0 && !state.gravid;
    if (!guardA || !guardB || first === second || !eligible(a) || !eligible(b) ||
      ecologyDistance(first.position, second.position) > 2 ||
      this._stores.eggs.size >= ECOLOGY_LIMITS.eggs) return null;
    const mother = a.id < b.id ? a : b;
    if (mother.clutchSerial >= ECOLOGY_LIMITS.clutchSerial) return null;
    const source = this._prepare([a, b].map((state) => ({
      store: "entries", value: {
        ...state, loveTime: 0, breedCooldown: ECOLOGY_LIMITS.turtleBreed,
        gravid: state === mother,
      },
    })), ctx, () => guardA() && guardB() &&
      ecologyLineOfSight(ctx.world, ecologyEye(first, ecologyCollider("turtle")),
        ecologyEye(second, ecologyCollider("turtle"))));
    return this._plan(source, [], { ok: true, motherId: mother.id });
  }

  /** One visible egg per clutch. Caller supplies collision-free, durable egg
   * and child identities; they are reserved even after hatch/break, never evicted.
   * preparePlaceEgg owns the actual World cell change and its loaded read set.
   */
  prepareLayEgg(mob, { eggId, childId, position }, ctx, { preparePlaceEgg } = {}) {
    if (!finitePosition(position)) return null;
    position = ecologyPoint(position);
    const state = this.state(mob?.id), guard = this._capture(mob, ctx);
    if (!guard || state?.kind !== "turtle" || !state.gravid ||
      this.identityReserved(eggId) || this.identityReserved(childId) ||
      ctx.getMob?.(eggId) || ctx.getMob?.(childId) || eggId === childId ||
      ecologyDistance(mob.position, state.homeBeach) > 1.5 ||
      ecologyDistance(position, state.homeBeach) > 1.5 ||
      !isTurtleBeach(ctx.world, position, ecologyCollider("turtle"), ctx.sampleFluid)) return null;
    const egg = normalizeEgg({
      id: eggId, parentId: mob.id, childId, serial: state.clutchSerial + 1,
      dimension: state.dimension, position, remaining: ECOLOGY_LIMITS.eggHatch, status: "incubating",
    }, this.context);
    if (!egg) return null;
    const block = prepareHook(preparePlaceEgg, freeze({ ...egg, block: "TURTLE_EGG" }));
    const source = this._prepare([
      { store: "entries", value: { ...state, gravid: false, clutchSerial: egg.serial } },
      { store: "eggs", value: egg },
    ], ctx, () => guard() && isTurtleBeach(ctx.world, position, ecologyCollider("turtle"), ctx.sampleFluid));
    return this._plan(source, [block], { ok: true, eggId });
  }

  prepareEggProgress(eggId, dt, ctx) {
    const egg = this.egg(eggId);
    if (!egg || egg.status !== "incubating" || !Number.isFinite(dt) || dt <= 0 ||
      egg.dimension !== ctx.world.dimension || ctx.eggPresent?.(egg) !== true ||
      !isTurtleBeach(ctx.world, egg.position, ecologyCollider("turtle"), ctx.sampleFluid)) return null;
    return this._prepare([{ store: "eggs", value: {
      // The host services a bounded round-robin and pins column incarnation
      // across the missed active interval; never apply wall-clock/offline age.
      ...egg, remaining: Math.max(0, egg.remaining - Math.min(dt, 10)),
    } }], ctx, () => ctx.eggPresent?.(egg) === true &&
      isTurtleBeach(ctx.world, egg.position, ecologyCollider("turtle"), ctx.sampleFluid));
  }

  prepareHatch(eggId, position, ctx, { prepareRemoveEgg, prepareSpawn } = {}) {
    if (!finitePosition(position)) return null;
    position = ecologyPoint(position);
    const egg = this.egg(eggId);
    if (!egg || egg.status !== "incubating" || egg.remaining > 0 ||
      this.state(egg.childId) || ctx.getMob?.(egg.childId) ||
      egg.dimension !== ctx.world.dimension || ctx.eggPresent?.(egg) !== true ||
      ecologyDistance(position, egg.position) > 2) return null;
    const child = createEcologyState("turtle", egg.childId, position, this.context, {
      homeBeach: egg.position, baby: true,
    });
    const collider = ecologyCollider("turtle", child);
    const valid = () => {
      const sample = ecologyBodySample(ctx.world, position, collider, ctx.sampleFluid);
      return !!sample && sample.lavaImmersion === 0 &&
        ecologyCanOccupy(ctx.world, position, collider) &&
        (sample.waterImmersion >= 0.2 ||
          ecologySupportAt(ctx.world, position, collider, { maxRise: 0, maxDrop: 0.1 }) !== null) &&
        ctx.eggPresent?.(egg) === true &&
        isTurtleBeach(ctx.world, egg.position, ecologyCollider("turtle"), ctx.sampleFluid);
    };
    if (!child || !valid()) return null;
    const remove = prepareHook(prepareRemoveEgg, egg);
    const spawn = prepareHook(prepareSpawn, freeze({
      id: child.id, kind: "turtle", position: ecologyPoint(position), baby: true,
    }));
    const source = this._prepare([
      { store: "entries", value: child },
      { store: "eggs", value: { ...egg, status: "hatched" } },
    ], ctx, valid);
    return this._plan(source, [remove, spawn], { ok: true, childId: child.id });
  }

  prepareBreakEgg(eggId, ctx, { prepareRemoveEgg } = {}) {
    return this.prepareBreakEggs([eggId], ctx, {
      prepareRemoveEggs: ([egg]) => prepareHook(prepareRemoveEgg, egg),
    });
  }

  /** One Ecology participant and one World participant, including explosion
   * batches. World must remove ALL these cells in its single prepared write.
   */
  prepareBreakEggs(eggIds, ctx, { prepareRemoveEggs } = {}) {
    if (!Array.isArray(eggIds) || !eggIds.length || eggIds.length > ECOLOGY_LIMITS.eggBatch ||
      new Set(eggIds).size !== eggIds.length) return null;
    const eggs = eggIds.map((eggId) => this.egg(eggId));
    if (eggs.some((egg) => !egg || egg.dimension !== ctx.world.dimension ||
      egg.status !== "incubating" || ctx.eggPresent?.(egg) !== true)) return null;
    const remove = prepareHook(prepareRemoveEggs, Object.freeze(eggs));
    const source = this._prepare(eggs.map((egg) => ({
      store: "eggs", value: { ...egg, status: "broken" },
    })), ctx, () => eggs.every((egg) => ctx.eggPresent?.(egg) === true));
    return this._plan(source, [remove], { ok: true, eggIds: [...eggIds] });
  }

  prepareGrowth(mob, ctx, { prepareDrops } = {}) {
    const state = this.state(mob?.id), guard = this._capture(mob, ctx);
    if (!guard || state?.kind !== "turtle" || state.scuteClaimed || state.growthRemaining > 0 ||
      !ecologyCanOccupy(ctx.world, mob.position, ecologyCollider("turtle"))) return null;
    const drops = prepareHook(prepareDrops, freeze([{ name: "SCUTE", count: 1 }]),
      ecologyPoint(mob.position), state.dimension);
    const source = this._prepare([{ store: "entries", value: { ...state, scuteClaimed: true } }], ctx,
      () => guard() && ecologyCanOccupy(ctx.world, mob.position, ecologyCollider("turtle")));
    return this._plan(source, [drops], { ok: true, scuteCommitted: true });
  }

  /** Must precede the lethal base-health/removal mutation. Removal, durable
   * one-shot ledger, loot retention and XP all publish in one coordinator plan.
   * `prepareDrops` resolves names; unsupported content/capacity must return null.
   */
  prepareDeath(mob, ctx, {
    playerKill = false, prepareRemoval, prepareDrops, prepareExperience, prepareUniqueCompletion,
  } = {}) {
    const state = this.state(mob?.id), guard = this._capture(mob, ctx);
    if (!guard || typeof playerKill !== "boolean") return null;
    const reward = ecologyDeathReward(mob.kind, playerKill);
    const participants = [prepareHook(prepareRemoval, mob)];
    if (reward.drops.length)
      participants.push(prepareHook(prepareDrops, reward.drops, ecologyPoint(mob.position), state.dimension));
    if (reward.experience)
      participants.push(prepareHook(prepareExperience, reward.experience, ecologyPoint(mob.position), state.dimension));
    const changes = [{ store: "entries", value: { ...state, alive: false } }];
    if (mob.kind === "elder_guardian") {
      const elder = this.elder(state.markerId);
      if (elder?.status !== "alive") return null;
      // The ecology tombstone cannot substitute for Exploration's permanent
      // encounter entitlement. Both owners must admit the exact full marker.
      participants.push(prepareHook(prepareUniqueCompletion, elder, state));
      changes.push({ store: "elders", value: { ...elder, status: "defeated" } });
    }
    const source = this._prepare(changes, ctx, guard);
    return this._plan(source, participants, { ok: true, reward, clearEffectSource: mob.id });
  }

  /** Call on suspension/removal even when the outer Wildlife loop skips AI. */
  clearIntent(mob, ctx = {}) {
    if (clearNpcIntent(mob)) this._revision++;
    else clearAquaticIntent(mob, ctx);
  }

  /** Fixed active-time progression only. Caller freezes unloaded/distant
   * residents and passes paused dt=0; this owner never advances wall-clock time.
   * Growth/lay/hatch readiness is observable state, NOT an eager item callback.
   */
  update(mob, dt, ctx) {
    let state = this.state(mob?.id);
    if (!state) return false;
    if (!Number.isFinite(dt) || dt <= 0) return true;
    if (!this._live(mob, ctx) || ecologyDistance(mob.position, ctx.player) > 58) {
      this.clearIntent(mob, ctx);
      return true;
    }
    const step = Math.min(dt, AQUATIC_AI_LIMITS.step);
    const collider = ecologyCollider(mob.kind, state);
    const sample = ecologyBodySample(ctx.world, mob.position, collider, ctx.sampleFluid);
    if (!sample) { this.clearIntent(mob, ctx); return true; }
    let next = null;
    if (mob.kind === "dolphin") {
      const guide = state.guide && state.guide.remaining > step
        ? { ...state.guide, remaining: state.guide.remaining - step } : null;
      next = {
        ...state, air: sample.canBreathe ? ECOLOGY_LIMITS.dolphinAir : Math.max(0, state.air - step),
        dryTime: sample.waterImmersion < 0.08 ? Math.min(ECOLOGY_LIMITS.dolphinDry, state.dryTime + step) : 0,
        assistTime: Math.max(0, state.assistTime - step), guide,
      };
    } else if (mob.kind === "turtle") next = {
      ...state, growthRemaining: Math.max(0, state.growthRemaining - step),
      loveTime: Math.max(0, state.loveTime - step),
      breedCooldown: Math.max(0, state.breedCooldown - step),
    };
    if (next && Object.keys(next).some((key) => next[key] !== state[key])) {
      const guard = this._capture(mob, ctx);
      const source = guard && this._prepare([{ store: "entries", value: next }], ctx, guard);
      if (!source || !this.coordinator.commit([source]).ok) return true;
      state = this.state(mob.id);
    }
    const runtime = { ...ctx, dimension: ctx.world.dimension, ecologyStateFor: (entityId) => this.state(entityId) };
    // Revisioned NPC availability becomes stale on movement/intent changes even
    // when no saved timer needed a participant. This revision is not save data.
    if (mob.kind === "villager") this._revision++;
    if (!stepAquaticMob(mob, step, runtime, state, collider)) stepNpcMob(mob, step, runtime, state, collider);
    return true;
  }

  readAvailability(entityId, ctx, options) {
    const mob = ctx.getMob?.(entityId);
    const result = readVillagerAvailability(mob, ctx, this._revision, options);
    if (!this.canRestore(entityId, "villager", ctx.world.dimension)) {
      result.alive = false;
      result.available = false;
    }
    return result;
  }

  retaliate(mob, hit, ctx) {
    if (!this._live(mob, ctx)) return false;
    const attack = guardianRetaliation(mob, hit, ctx);
    if (!attack || !synchronousEcologyHook(ctx.damagePlayer)) return false;
    ctx.damagePlayer(attack.damage, `${mob.spec.name} spikes`, mob, attack);
    return true;
  }

  dispose() {
    if (this._disposed) return true;
    if (this.coordinator.usage(this) !== undefined && !this.coordinator.release(this)) return false;
    this._disposed = true;
    this._revision++;
    return true;
  }
}

export function ecologyDeathReward(kind, playerKill = false) {
  let drops = [], experience = 0;
  if (kind === "guardian") {
    drops = [{ name: "PRISMARINE_SHARD", count: 2 }, { name: "PRISMARINE_CRYSTALS", count: 1 }];
    experience = 5;
  } else if (kind === "elder_guardian") {
    drops = [
      { name: "WET_SPONGE", count: 1 }, { name: "PRISMARINE_SHARD", count: 3 },
      { name: "PRISMARINE_CRYSTALS", count: 2 },
    ];
    experience = 10;
  } else if (kind === "blaze" && playerKill) {
    drops = [{ name: "BLAZE_ROD", count: 1 }];
    experience = 10;
  } else if (kind === "drowned") experience = 5;
  return freeze({ drops, experience: playerKill ? experience : 0 });
}
