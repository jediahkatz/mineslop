import { BedSystem } from "./bed-system.js";
import { BLOCKS } from "./blocks.js";
import {
  BuildingReads,
  buildingHasSupport,
  buildingRefusal,
  prepareBuildingBreak,
  prepareBuildingPlacement,
  prepareBuildingToggle,
} from "./building-placement.js";
import { isValidStack, splitStacks } from "./inventory-slots.js";
import { normalizeStackData } from "./item-stack-data.js";
import { getItem } from "./items.js";
import { TransactionInvariantError } from "./transactions.js";
import { createWorldContext } from "./world-spec.js";

const INTERACTIVE = new Set(["door", "trapdoor", "fence_gate", "bed"]);
const SUPPORTED = new Set(["door", "bed", "ladder"]);
const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";
const plainStack = (stack, context) =>
  isValidStack(stack, context) &&
  normalizeStackData(stack.id, stack.data, context) === undefined;

/**
 * Lazy local work for a world mutation. Radius two includes a ladder whose
 * supporting stair changes corner through a neighbor. Feed the iterator into
 * reconcileSupport over subsequent ticks, never recursively from onMutation.
 */
export function* buildingSupportCandidates(event) {
  if (!event || !Array.isArray(event.changes)) return;
  for (const change of event.changes) {
    if (![change.x, change.y, change.z].every(Number.isSafeInteger)) continue;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dy = -1; dy <= 1; dy++)
          yield {
            x: change.x + dx,
            y: change.y + dy,
            z: change.z + dz,
            dimension: event.dimension,
            epoch: event.epoch,
          };
  }
}

/** No registry, renderer or frame ownership. Construct after the live owners exist. */
export class BuildingActions {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.gameplay = game.gameplay;
    this.coordinator = game.world?.coordinator;
    this.context = game.worldContext ?? createWorldContext(game.world);
    if (!this.coordinator || game.gameplay?.coordinator !== this.coordinator)
      throw new RangeError(
        "Building requires the shared world/player coordinator"
      );
    this._ownsBeds = !game.beds;
    this.beds =
      game.beds ??
      new BedSystem({
        coordinator: this.coordinator,
        context: this.context,
        onChange: () => game.scheduleSave?.(),
      });
    if (this.beds.coordinator !== this.coordinator)
      throw new RangeError("Beds must share the building coordinator");
    this._busy = false;
    this._disposed = false;
    this.observerErrors = [];
    this.lastResult = null;
  }

  _live() {
    return (
      !this._disposed &&
      this.game.world === this.world &&
      this.game.gameplay === this.gameplay &&
      !this.world._disposed &&
      this.world.coordinator === this.coordinator &&
      this.gameplay.coordinator === this.coordinator &&
      this.world.seed === this.context.seed &&
      this.world.generatorVersion === this.context.generatorVersion &&
      (!this.gameplay.context ||
        (this.gameplay.context.seed === this.context.seed &&
          this.gameplay.context.generatorVersion ===
            this.context.generatorVersion))
    );
  }

  _prepare(work) {
    if (!this._live() || this._busy || this.game.building)
      return buildingRefusal("Building is unavailable");
    this._busy = true;
    try {
      return work();
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return buildingRefusal("The building action could not be prepared");
    } finally {
      this._busy = false;
    }
  }

  _worldParticipant(proposal, validate = () => true) {
    if (!proposal?.ok) return null;
    const mutation = this.world.prepareMutation(proposal.changes, {
      reads: proposal.reads,
      epoch: proposal.epoch,
    });
    if (!mutation) return null;
    return {
      ...mutation,
      validate: () =>
        !this._busy &&
        this._live() &&
        !this.game.building &&
        proposal.validate() &&
        validate() &&
        mutation.validate(),
    };
  }

  _observe(callback, errors) {
    try {
      callback();
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      errors.push(error);
    }
  }

  _feedback(errors, { id, hand, sound = false } = {}) {
    if (!this._live()) return;
    const game = this.game;
    if (sound) this._observe(() => game.effects?.sound?.("place", id), errors);
    if (hand)
      this._observe(() => {
        const view = hand === "offhand" ? game.effects?.offhand : game.effects;
        if (view) view.swing = 1;
      }, errors);
    for (const callback of [
      () => game.graphics?.rebuildDirty?.(4),
      () => game.scheduleSave?.(),
      () => game.updateTarget?.(),
      () => game.refreshHud?.(),
    ])
      this._observe(callback, errors);
  }

  _commit(plan, feedback) {
    if (!plan?.participants) {
      this.lastResult =
        plan ?? buildingRefusal("The building action is unavailable");
      return this.lastResult;
    }
    // No controller busy guard is held during publication or any observer.
    const committed = this.coordinator.commit(plan.participants);
    for (const error of committed.observerErrors ?? [])
      if (error instanceof TransactionInvariantError) throw error;
    if (!committed.ok) {
      this.lastResult = buildingRefusal(
        "The building action changed or could not fit in the save"
      );
      return this.lastResult;
    }
    const errors = [...committed.observerErrors];
    this._feedback(errors, feedback);
    this.observerErrors = errors;
    this.lastResult = { ok: true, ...plan.result, observerErrors: errors };
    return this.lastResult;
  }

  place(hand, id, hit = this.game.target) {
    const plan = this._prepare(() => {
      const game = this.game,
        gameplay = this.gameplay;
      const item = getItem(id);
      if (
        !["main", "offhand"].includes(hand) ||
        gameplay.dead ||
        !item?.placeable ||
        !BLOCKS[item.blockId] ||
        !synchronous(gameplay.prepareHandCost) ||
        !synchronous(game.player?.intersectsPlacement)
      )
        return buildingRefusal("The held item cannot be placed");
      const held = gameplay.getHandStack(hand);
      if (!held || held.id !== id || !plainStack(held, this.context))
        return buildingRefusal(
          "Hold a plain building item in the requested hand"
        );
      const proposal = prepareBuildingPlacement(
        this.world,
        item.blockId,
        hit,
        game.player.forward
      );
      if (!proposal.ok) return proposal;
      const player = game.player;
      if (player.intersectsPlacement(proposal.changes))
        return buildingRefusal("The placement would intersect the player");
      const selected = gameplay.selected;
      const mode = gameplay.mode;
      const handRevision = gameplay.getHandRevision(hand);
      const inventory = gameplay.prepareHandCost(hand, {
        count: 1,
        stack: held,
        handRevision,
      });
      if (!inventory)
        return buildingRefusal("The held item could not be reserved");
      const mutation = this._worldParticipant(proposal, () => {
        const current = gameplay.getHandStack(hand);
        return (
          game.player === player &&
          !gameplay.dead &&
          gameplay.mode === mode &&
          gameplay.selected === selected &&
          gameplay.getHandRevision(hand) === handRevision &&
          current?.id === held.id &&
          current.count === held.count &&
          plainStack(current, this.context) &&
          !player.intersectsPlacement(proposal.changes)
        );
      });
      return mutation
        ? {
            participants: [mutation, inventory],
            result: { rootKey: proposal.rootKey },
          }
        : buildingRefusal("Both the world and held item must be available");
    });
    return this._commit(plan, { id, hand, sound: true }).ok;
  }

  /** null ONLY for unrecognized blocks. Caller skips this method for sneak-place. */
  tryUse(hit) {
    const currentId =
      hit && [hit.x, hit.y, hit.z].every(Number.isSafeInteger)
        ? this.world.getCell(hit.x, hit.y, hit.z)?.id
        : undefined;
    const kind = INTERACTIVE.has(BLOCKS[currentId]?.shape)
      ? BLOCKS[currentId].shape
      : BLOCKS[hit?.id]?.shape;
    if (!INTERACTIVE.has(kind)) return null;
    if (!this._live() || this._busy || this.game.building || this.gameplay.dead)
      return buildingRefusal("That building block is unavailable");
    if (kind === "bed") {
      const result = this.beds.use(this.game, hit);
      if (result.ok) {
        const errors = [...(result.observerErrors ?? [])];
        this._feedback(errors);
        this.observerErrors = errors;
        this.lastResult = { ...result, observerErrors: errors };
        return this.lastResult;
      }
      return result;
    }
    const plan = this._prepare(() => {
      const player = this.game.player;
      if (!synchronous(player?.intersectsPlacement))
        return buildingRefusal("Player collision checks are unavailable");
      const proposal = prepareBuildingToggle(this.world, hit, player.forward);
      if (!proposal?.ok) return proposal;
      if (player.intersectsPlacement(proposal.changes))
        return buildingRefusal("The moving block would intersect the player");
      const inventory = this.gameplay.prepareInventory(() => true, {
        notify: false,
      });
      const mutation = this._worldParticipant(
        proposal,
        () =>
          this.game.player === player &&
          !this.gameplay.dead &&
          !player.intersectsPlacement(proposal.changes)
      );
      return mutation && inventory
        ? { participants: [mutation, inventory], result: {} }
        : buildingRefusal("The linked block could not be reserved");
    });
    return this._commit(plan, { id: currentId ?? hit?.id, sound: true });
  }

  /**
   * Pure proposal, never publication or loot spawning. null=ordinary mining,
   * ok:false=recognized/refused. Commit its World writes and retained loot once;
   * honor validate() along with reads/epoch. A loaded orphan pays zero items.
   */
  prepareBreak(hit) {
    if (!this._live()) return buildingRefusal("Building is unavailable");
    try {
      const proposal = prepareBuildingBreak(this.world, hit);
      return proposal?.ok
        ? Object.freeze({
            ...proposal,
            validate: () => this._live() && proposal.validate(),
          })
        : proposal;
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return buildingRefusal("The linked block could not be inspected");
    }
  }

  /**
   * Consume at most limit candidates, without recursion. Keep remaining for
   * later frames; retry contains rejected removals, deferred needs a future
   * chunk admission. Drop reservation failure leaves every block owned.
   */
  reconcileSupport(candidates, { limit = 32, prepareDrops } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64)
      return buildingRefusal("Support check limit must be between 1 and 64");
    const iterator = candidates?.next
      ? candidates
      : candidates?.[Symbol.iterator]?.();
    if (!iterator) return buildingRefusal("Support candidates are required");
    const retry = [],
      deferred = [];
    let checked = 0,
      done = false,
      removed = 0;
    const plan = this._prepare(() => {
      const reads = new BuildingReads(this.world);
      const changes = new Map(),
        roots = new Set(),
        counts = new Map();
      while (checked < limit) {
        const next = iterator.next();
        if (next.done) {
          done = true;
          break;
        }
        checked++;
        const at = next.value;
        if (
          !at ||
          ![at.x, at.y, at.z].every(Number.isSafeInteger) ||
          (at.dimension !== undefined &&
            at.dimension !== this.world.dimension) ||
          (at.epoch !== undefined && at.epoch !== reads.epoch)
        )
          continue;
        const cell = reads.at(at);
        if (!cell) {
          deferred.push(at);
          continue;
        }
        if (!SUPPORTED.has(BLOCKS[cell.id]?.shape)) continue;
        const supported = buildingHasSupport(reads, at);
        if (supported === null) {
          deferred.push(at);
          continue;
        }
        if (supported) continue;
        const proposal = prepareBuildingBreak(this.world, at, reads);
        if (
          !proposal?.ok ||
          roots.has(proposal.rootKey) ||
          proposal.changes.some(({ x, y, z }) => changes.has(`${x},${y},${z}`))
        )
          continue;
        roots.add(proposal.rootKey);
        retry.push({ ...at });
        for (const change of proposal.changes)
          changes.set(`${change.x},${change.y},${change.z}`, change);
        if (proposal.dropCount)
          counts.set(
            proposal.dropId,
            (counts.get(proposal.dropId) ?? 0) + proposal.dropCount
          );
      }
      if (!changes.size) return { ok: true };
      const mutation = this._worldParticipant(
        reads.proposal([...changes.values()])
      );
      if (!mutation) return buildingRefusal("Support removal is unavailable");
      const participants = [mutation];
      if (counts.size) {
        const prepare =
          prepareDrops ??
          (synchronous(this.game.preparePlayerDrops)
            ? (stacks) => this.game.preparePlayerDrops(stacks)
            : undefined);
        if (!synchronous(prepare))
          return buildingRefusal("Retained support drops are required");
        const drops = [...counts].flatMap(([id, count]) =>
          splitStacks(id, count)
        );
        const destination = prepare(drops, {
          ...retry[0],
          dimension: this.world.dimension,
        });
        if (!destination)
          return buildingRefusal("Support drops could not be retained");
        participants.push(destination);
      }
      removed = changes.size;
      return { participants, result: { dropsCommitted: counts.size > 0 } };
    });
    const result = plan?.participants ? this._commit(plan) : plan;
    return {
      ...result,
      checked,
      done,
      remaining: iterator,
      removed: result?.ok ? removed : 0,
      retry: result?.ok ? [] : retry,
      deferred,
    };
  }

  dispose() {
    if (this._disposed) return true;
    if (this._busy || (this._ownsBeds && !this.beds.dispose())) return false;
    this._disposed = true;
    return true;
  }
}
