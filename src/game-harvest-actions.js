import { BLOCK, BLOCKS } from "./blocks.js";
import { cellAfterBreaking } from "./block-state.js";
import { isBuildingBlock } from "./building-placement.js";
import { miningExperience } from "./experience-rewards.js";
import { harvestDrops, miningProfile } from "./gameplay-harvest.js";
import { progressionStationKind } from "./progression-station-state.js";
import { TransactionInvariantError } from "./transactions.js";
import { explosionTargets } from "./world-interactions.js";

const containers = new Set([BLOCK.CHEST, BLOCK.FURNACE]);
const center = (hit) =>
  hit && { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 };
const blockKey = (world, hit) =>
  `${world.dimension}:${hit.x},${hit.y},${hit.z}`;
const refused = () => ({ ok: false });

/** World removal never precedes the required tool, item or XP reservations. */
export class GameHarvestActions {
  constructor(game) {
    this.game = game;
  }

  prepareExperience(amount, position) {
    const game = this.game;
    const { experienceOrbs, gameplay, world } = game;
    if (experienceOrbs?.coordinator !== gameplay.coordinator) return null;
    const dimension = world.dimension;
    const participant = experienceOrbs.prepareSpawn(amount, position, {
      dimension,
      pickupDelay: 0.2,
    });
    return (
      participant &&
      Object.freeze({
        ...participant,
        validate: () =>
          game.experienceOrbs === experienceOrbs &&
          game.gameplay === gameplay &&
          game.world === world &&
          world.dimension === dimension &&
          participant.validate(),
      })
    );
  }

  guard(
    plan,
    {
      world,
      gameplay,
      settlement,
      settlementRevision,
      mode,
      linked,
      hit,
      rootKey,
    }
  ) {
    if (!plan?.participants?.length) return null;
    const game = this.game;
    const [first, ...rest] = plan.participants;
    return Object.freeze({
      participants: Object.freeze([
        Object.freeze({
          ...first,
          validate: () =>
            game.world === world &&
            game.gameplay === gameplay &&
            game.settlement === settlement &&
            settlement.revision === settlementRevision &&
            gameplay.mode === mode &&
            (!linked?.validate || linked.validate()) &&
            first.validate(),
        }),
        ...rest,
      ]),
      result: Object.freeze({ ...plan.result, rootKey, hit: { ...hit } }),
    });
  }

  /** {participants,result}|null; preparation never flushes, awards, saves or edits. */
  prepareBreak(hit, { explosion = false, position = center(hit) } = {}) {
    const game = this.game;
    const { world, gameplay, settlement } = game;
    if (
      !hit ||
      !world ||
      !gameplay ||
      !settlement ||
      gameplay.dead ||
      world.coordinator !== gameplay.coordinator ||
      settlement.coordinator !== gameplay.coordinator ||
      [gameplay, settlement].some(
        (owner) =>
          owner.context &&
          (owner.context.seed !== world.seed ||
            owner.context.generatorVersion !== world.generatorVersion)
      ) ||
      ![hit.x, hit.y, hit.z].every(Number.isSafeInteger) ||
      (hit.world !== undefined && hit.world !== world) ||
      (hit.dimension !== undefined && hit.dimension !== world.dimension)
    )
      return null;
    const before = world.getCell(hit.x, hit.y, hit.z);
    if (
      !before ||
      before.id !== hit.id ||
      (hit.state !== undefined && before.state !== hit.state) ||
      (hit.fluid !== undefined && before.fluid !== hit.fluid) ||
      !miningProfile(hit.id) ||
      (explosion && (BLOCKS[hit.id]?.blastProof || hit.id === BLOCK.OBSIDIAN))
    )
      return null;
    const mode = gameplay.mode;
    const scope = {
      world,
      gameplay,
      settlement,
      mode,
      hit,
      settlementRevision: settlement.revision,
      rootKey: blockKey(world, hit),
    };
    if (settlement.hasCrop(world, hit)) {
      // This plan already owns player inventory, source crop and World. It also
      // preserves the existing no-tool-wear crop harvest behavior.
      return this.guard(
        settlement.prepareHarvestCrop(world, hit, gameplay, {
          prepareDrops: (drops) => game.prepareDropItems(drops, position),
        }),
        scope
      );
    }
    const linked = game.buildingActions?.prepareBreak(hit) ?? null;
    if (linked?.ok === false || (isBuildingBlock(hit.id) && !linked))
      return null;
    scope.linked = linked;
    scope.rootKey = linked?.rootKey ?? scope.rootKey;
    const lootOptions = {
      dropId: linked?.dropId,
      dropCount: linked?.dropCount ?? 1,
    };
    const harvest = explosion
      ? null
      : gameplay.prepareHarvest(hit.id, lootOptions);
    if (!explosion && !harvest) return null;
    const drops = explosion
      ? harvestDrops(hit.id, {
          ...lootOptions,
          mode,
          explosion: true,
          random: gameplay.random,
          context: gameplay.context,
        })
      : harvest.drops;
    if (!drops) return null;
    const participants = harvest ? [harvest.participant] : [];
    if (containers.has(hit.id)) {
      const exploration = game.explorationServices?.prepareBreak(hit, {
        explosion,
        drops,
        participants,
        prepareDrops: (allDrops) => game.prepareDropItems(allDrops, position),
        prepareExperience: (amount) => this.prepareExperience(amount, position),
      });
      if (exploration?.handled)
        return exploration.ok ? this.guard(exploration, scope) : null;
      const removed = settlement.prepareRemoveContainer(world, hit, {
        participants,
        // Even an unopened/empty container must retain its block item. The
        // combined proposal has ONE overflow owner, not competing drop plans.
        prepareDrops: (contents) =>
          game.prepareDropItems([...drops, ...contents], position),
        prepareExperience: (amount) => this.prepareExperience(amount, position),
      });
      return this.guard(
        removed && {
          ...removed,
          result: {
            ...removed.result,
            drops: [...drops, ...removed.result.drops],
          },
        },
        scope
      );
    }
    if (progressionStationKind(hit.id) && game.progressionIntegration) {
      const removed = game.progressionIntegration.prepareStationRemoval(
        linked?.changes ?? [{
          x: hit.x, y: hit.y, z: hit.z, before, after: cellAfterBreaking(before),
        }],
        { extraDrops: drops, participants }
      );
      if (!removed?.participants) return null;
      return this.guard({
        ...removed,
        result: {
          ...removed.result, drops, experience: 0,
          dropsCommitted: true, experienceCommitted: true,
        },
      }, scope);
    }
    const mutation = world.prepareMutation(
      linked?.changes ?? [
        {
          x: hit.x,
          y: hit.y,
          z: hit.z,
          before,
          after: cellAfterBreaking(before),
        },
      ],
      { reads: linked?.reads ?? [] }
    );
    if (!mutation) return null;
    participants.push(mutation);
    if (drops.length) {
      const retained = game.prepareDropItems(drops, position);
      if (!retained) return null;
      participants.push(retained);
    }
    const experience = explosion
      ? 0
      : miningExperience(hit.id, drops, mode, gameplay.random);
    if (experience) {
      const reward = this.prepareExperience(experience, position);
      if (!reward) return null;
      participants.push(reward);
    }
    return this.guard(
      {
        participants,
        result: {
          ok: true,
          drops,
          experience,
          dropsCommitted: true,
          experienceCommitted: true,
        },
      },
      scope
    );
  }

  commit(plan) {
    if (!plan) return refused();
    const committed = this.game.gameplay.coordinator.commit(plan.participants);
    // A nested postcommit flush may itself expose a fatal publication failure.
    for (const error of committed.observerErrors ?? [])
      if (error instanceof TransactionInvariantError) throw error;
    return committed.ok
      ? { ...plan.result, observerErrors: committed.observerErrors }
      : refused();
  }

  break(hit, options) {
    return this.commit(this.prepareBreak(hit, options));
  }

  /**
   * Existing station APIs own one record at a time, not a bulk station edit.
   * A radius capped at six gives a bounded candidate set. Each logical block
   * commits World + source + all loot/XP atomically; refusal preserves that
   * entire block, while other blocks may succeed. Never half-publish a chest.
   */
  explode(position, radius) {
    const game = this.game;
    const world = game.world;
    const changed = [];
    const visited = new Set();
    for (const hit of explosionTargets(world, position, radius)) {
      if (game.world !== world) break;
      const plan = this.prepareBreak(hit, { explosion: true });
      if (!plan || visited.has(plan.result.rootKey)) continue;
      visited.add(plan.result.rootKey);
      if (this.commit(plan).ok) changed.push(hit);
    }
    return changed;
  }
}
