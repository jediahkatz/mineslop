import { BLOCKS } from "./blocks.js";
import { cellAfterBreaking } from "./block-state.js";
import { HORIZONTAL_DIRECTIONS } from "./block-shapes.js";
import {
  BuildingReads,
  buildingRefusal,
  linkedSupport,
  offsetPosition,
  readBuildingPair,
} from "./building-placement.js";
import { findBedRespawn } from "./bed-spawn.js";
import { encodedBytes } from "./save-budget.js";
import { TransactionInvariantError } from "./transactions.js";
import {
  createWorldContext,
  DIMENSIONS,
  getWorldSpec,
  inWorldBounds,
  isEditablePosition,
} from "./world-spec.js";
import { isSleepTime, normalizeWorldClock } from "./world-clock.js";

export const BED_STATE_VERSION = 1;
export const BED_EXPLOSION_RADIUS = 5;
export const BED_USE_REACH = 4;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";
const finitePosition = (position) =>
  position && [position.x, position.y, position.z].every(Number.isFinite);
const SPAWN_FIELDS = [
  "seed",
  "generatorVersion",
  "dimension",
  "x",
  "y",
  "z",
  "id",
  "facing",
];

function bedContext(context) {
  if (
    !object(context) ||
    typeof context.seed !== "string" ||
    context.seed.length > 80 ||
    !synchronous(context.specForDimension)
  )
    throw new RangeError("Invalid bed context");
  for (const dimension of DIMENSIONS) {
    const spec = context.specForDimension(dimension);
    const canonical = getWorldSpec(context.generatorVersion, dimension);
    if (
      !object(spec) ||
      ["minY", "maxY", "seaLevel", "voidY"].some(
        (key) => spec[key] !== canonical[key]
      )
    )
      throw new RangeError("Invalid bed dimension bounds");
  }
  return createWorldContext(context);
}

/** Pure, detached preflight component. Missing legacy state is {version:1,spawn:null}. */
export function normalizeBedSnapshot(data, context) {
  try {
    context = bedContext(context);
    if (
      !object(data) ||
      data.version !== BED_STATE_VERSION ||
      Object.keys(data).some((key) => !["version", "spawn"].includes(key))
    )
      return null;
    if (data.spawn === null) return { version: BED_STATE_VERSION, spawn: null };
    const spawn = data.spawn;
    if (
      !object(spawn) ||
      Object.keys(spawn).some((key) => !SPAWN_FIELDS.includes(key)) ||
      spawn.seed !== context.seed ||
      spawn.generatorVersion !== context.generatorVersion ||
      spawn.dimension !== "overworld" ||
      !Number.isSafeInteger(spawn.id) ||
      BLOCKS[spawn.id]?.shape !== "bed" ||
      !Number.isInteger(spawn.facing) ||
      spawn.facing < 0 ||
      spawn.facing > 3
    )
      return null;
    const spec = context.specForDimension(spawn.dimension);
    const other = offsetPosition(spawn, HORIZONTAL_DIRECTIONS[spawn.facing]);
    if (
      ![spawn, other].every(
        ({ x, y, z }) =>
          isEditablePosition(
            x,
            y,
            z,
            context.generatorVersion,
            spawn.dimension
          ) && inWorldBounds(x, y - 1, z, spec)
      )
    )
      return null;
    return {
      version: BED_STATE_VERSION,
      spawn: Object.fromEntries(
        SPAWN_FIELDS.map((field) => [field, spawn[field]])
      ),
    };
  } catch {
    return null;
  }
}

export function hasNearbySleepThreat(
  entities,
  position,
  dimension = "overworld"
) {
  if (!Array.isArray(entities) || !finitePosition(position)) return false;
  return entities.some((mob) => {
    if (
      !mob ||
      mob.dead ||
      mob.health === 0 ||
      mob.tamed ||
      !finitePosition(mob.position) ||
      (mob.dimension !== undefined && mob.dimension !== dimension)
    )
      return false;
    const hostile =
      (mob.spec?.temperament === "hostile" && !(mob.pacified > 0)) ||
      mob.attacking === true ||
      mob.angry > 0;
    return (
      hostile &&
      Math.abs(mob.position.x - position.x) <= 8 &&
      Math.abs(mob.position.y - position.y) <= 5 &&
      Math.abs(mob.position.z - position.z) <= 8
    );
  });
}

function inReach(player, pair) {
  return (
    finitePosition(player?.position) &&
    pair.cells.some(
      ({ x, y, z }) =>
        Math.hypot(
          player.position.x - x - 0.5,
          player.position.y - y,
          player.position.z - z - 0.5
        ) <= BED_USE_REACH
    )
  );
}

function spawnIdentity(world, pair) {
  return {
    seed: world.seed,
    generatorVersion: world.generatorVersion,
    dimension: "overworld",
    ...pair.root,
    id: pair.id,
    facing: pair.facing,
  };
}

/** Owns one respawn identity, not terrain or a second simulation clock. */
export class BedSystem {
  constructor({
    coordinator,
    context,
    onChange,
    allowOverBudget = false,
  } = {}) {
    this.context = bedContext(context);
    this.coordinator = coordinator;
    this.onChange = onChange;
    this._spawn = null;
    this._bytes = encodedBytes(this.serialize());
    this._revision = 0;
    this._disposed = false;
    this._busy = false;
    this.observerErrors = [];
    if (!coordinator?.register(this, this._bytes, { allowOverBudget }))
      throw new RangeError("Cannot reserve bed state");
  }

  get revision() {
    return this._revision;
  }
  getRespawn() {
    return this._spawn ? { ...this._spawn } : null;
  }
  serialize() {
    return { version: BED_STATE_VERSION, spawn: this.getRespawn() };
  }

  _matchesWorld(world) {
    return (
      !this._disposed &&
      !!world &&
      !world._disposed &&
      world.coordinator === this.coordinator &&
      world.seed === this.context.seed &&
      world.generatorVersion === this.context.generatorVersion
    );
  }

  findRespawn(world) {
    if (!this._matchesWorld(world)) return null;
    return findBedRespawn(world, this._spawn);
  }

  _prepareSpawn(spawn, validate) {
    const clean = normalizeBedSnapshot(
      { version: BED_STATE_VERSION, spawn },
      this.context
    );
    if (!clean || this._disposed) return null;
    const previous = this._spawn;
    const revision = this._revision;
    const beforeBytes = this._bytes;
    const afterBytes = encodedBytes(clean);
    const next = clean.spawn && Object.freeze(clean.spawn);
    const coordinator = this.coordinator;
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        !this._disposed &&
        !this._busy &&
        this._spawn === previous &&
        this._revision === revision &&
        this._bytes === beforeBytes &&
        this.coordinator === coordinator &&
        validate(),
      publish: () => {
        used = true;
        this._spawn = next;
        this._bytes = afterBytes;
        this._revision++;
      },
      notify: () => this.onChange?.(this.serialize()),
    });
  }

  /**
   * Game supplies world/gameplay/player/worldClock/wildlife and explode(). The
   * caller owns sneak-place priority. No movement, healing or simulator update
   * occurs here; the clock and spawn publish together, or neither changes.
   */
  use(game, hit) {
    if (this._busy || this._disposed)
      return buildingRefusal("Bed state is unavailable");
    let plan;
    this._busy = true;
    try {
      plan = this._prepareUse(game, hit);
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return buildingRefusal("The bed could not be used");
    } finally {
      this._busy = false;
    }
    if (!plan?.participants)
      return plan ?? buildingRefusal("The bed could not be used");
    const committed = this.coordinator.commit(plan.participants);
    if (!committed.ok)
      return buildingRefusal("The bed changed before it could be used");
    const errors = [...committed.observerErrors];
    for (const error of errors)
      if (error instanceof TransactionInvariantError) throw error;
    if (plan.afterCommit) {
      try {
        plan.afterCommit();
      } catch (error) {
        if (error instanceof TransactionInvariantError) throw error;
        errors.push(error);
      }
    }
    this.observerErrors = errors;
    return { ...plan.result, observerErrors: errors };
  }

  _prepareUse(game, hit) {
    const { world, gameplay, player } = game;
    if (
      !this._matchesWorld(world) ||
      game.building ||
      gameplay?.dead ||
      gameplay?.coordinator !== this.coordinator ||
      (gameplay.context &&
        (gameplay.context.seed !== this.context.seed ||
          gameplay.context.generatorVersion !==
            this.context.generatorVersion)) ||
      !synchronous(gameplay.prepareInventory)
    )
      return buildingRefusal("The bed is unavailable");
    const reads = new BuildingReads(world);
    const pair = readBuildingPair(reads, hit);
    if (
      !pair ||
      pair.kind !== "bed" ||
      !pair.valid ||
      linkedSupport(reads, pair) !== true ||
      !inReach(player, pair)
    )
      return buildingRefusal(
        "Both bed halves, their support and a nearby player are required"
      );
    const current = () =>
      !this._disposed &&
      !this._busy &&
      game.world === world &&
      game.gameplay === gameplay &&
      game.player === player &&
      !game.building &&
      this._matchesWorld(world) &&
      !gameplay.dead &&
      reads.validate() &&
      inReach(player, pair);
    const inventory = gameplay.prepareInventory(() => true, { notify: false });
    if (!inventory) return buildingRefusal("Player state is unavailable");
    if (world.dimension !== "overworld") {
      if (!synchronous(game.explode))
        return buildingRefusal("The bed explosion handler is unavailable");
      const mutation = world.prepareMutation(
        pair.cells.map((cell) => ({
          ...cell,
          after: cellAfterBreaking(cell.before),
        })),
        { reads: reads.proposal([]).reads, epoch: reads.epoch }
      );
      if (!mutation)
        return buildingRefusal("Both bed halves must be removable");
      const dimension = world.dimension;
      const explode = game.explode;
      return {
        participants: [
          {
            ...mutation,
            validate: () =>
              current() && game.explode === explode && mutation.validate(),
          },
          inventory,
        ],
        result: {
          ok: true,
          exploded: true,
          message: "Beds explode in this dimension",
        },
        afterCommit: () => {
          if (game.world !== world || world.dimension !== dimension)
            throw new Error("World changed before the committed bed explosion");
          // Both cells are gone before the existing explosion can inspect them.
          explode.call(
            game,
            {
              x: pair.other.x + 0.5,
              y: pair.other.y + 0.5,
              z: pair.other.z + 0.5,
            },
            BED_EXPLOSION_RADIUS,
            true
          );
        },
      };
    }
    const clock = game.worldClock;
    const time = normalizeWorldClock(clock?.serialize?.());
    if (!time || clock._disposed || clock.coordinator !== this.coordinator)
      return buildingRefusal("The world clock is unavailable");
    const clockRevision = clock.revision;
    const sleeping = isSleepTime(time.time);
    const center = {
      x: pair.other.x + 0.5,
      y: pair.other.y,
      z: pair.other.z + 0.5,
    };
    const threatened = () =>
      (!game.wildlife?.dimension ||
        game.wildlife.dimension === world.dimension) &&
      hasNearbySleepThreat(game.wildlife?.entities, center, world.dimension);
    const spawn = spawnIdentity(world, pair);
    if (sleeping && threatened())
      return buildingRefusal("You cannot sleep while monsters are nearby");
    if (sleeping && !findBedRespawn(world, spawn, { reads }))
      return buildingRefusal("The bed or its standing space is obstructed");
    const source = this._prepareSpawn(
      spawn,
      () =>
        current() &&
        game.worldClock === clock &&
        clock.coordinator === this.coordinator &&
        !clock._disposed &&
        clock.revision === clockRevision &&
        clock.time === time.time &&
        clock.day === time.day &&
        (!sleeping || !threatened())
    );
    const dawn =
      sleeping && synchronous(clock.prepareSleep) ? clock.prepareSleep() : null;
    if (!source || (sleeping && !dawn))
      return buildingRefusal("The bed and dawn could not be reserved");
    return {
      participants: [source, inventory, ...(dawn ? [dawn] : [])],
      result: {
        ok: true,
        spawnSet: true,
        slept: sleeping,
        message: sleeping ? "Slept until dawn" : "Respawn point set",
      },
    };
  }

  load(data, options = {}) {
    if (this._disposed || this._busy || !object(options)) return false;
    const { context = this.context, allowOverBudget = false } = options;
    let nextContext;
    try {
      nextContext = bedContext(context);
    } catch {
      return false;
    }
    const clean = normalizeBedSnapshot(data, nextContext);
    if (!clean) return false;
    const bytes = encodedBytes(clean);
    if (!this.coordinator.register(this, bytes, { allowOverBudget }))
      return false;
    this.context = nextContext;
    this._spawn = clean.spawn && Object.freeze(clean.spawn);
    this._bytes = bytes;
    this._revision++;
    return true;
  }

  dispose() {
    if (this._disposed) return true;
    if (this._busy || !this.coordinator.release(this)) return false;
    this._disposed = true;
    this._revision++;
    this._spawn = null;
    this._bytes = 0;
    this.onChange = undefined;
    return true;
  }
}
