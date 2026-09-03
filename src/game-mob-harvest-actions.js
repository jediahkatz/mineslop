import { BLOCK } from "./blocks.js";
import { cellsEqual } from "./block-state.js";
import { GameHarvestActions } from "./game-harvest-actions.js";

/**
 * Keep the existing real container/station/crop/mining receipts. An owned egg
 * additionally retires its permanent Ecology identity in the SAME World/tool/
 * loot transaction. Explosions use this override through the base dispatch.
 */
export class GameMobHarvestActions extends GameHarvestActions {
  prepareBreak(hit, options) {
    const source = this._prepareEggBreak(hit, options);
    if (!source) return null;
    const game = this.game, world = game.world;
    const progression = game.progressionIntegration?.services;
    const trading = progression?.trading;
    const villager = trading?.jobsiteOwnerAt(world.dimension, hit);
    if (!villager) return source;
    // A composter/lectern and an escrow-bearing station use the same claimed
    // jobsite ledger. Removing the actual cell must release its claim together
    // with every original World/tool/escrow/drop participant, never afterwards.
    const release = progression.prepareVillagerJobsiteRelease(villager, {
      participants: source.participants,
      validate: () => game.world === world &&
        game.progressionIntegration?.services === progression &&
        progression.trading === trading &&
        trading.jobsiteOwnerAt(world.dimension, hit) === villager &&
        source.participants.every((part) => part.validate() === true),
    });
    return release?.participants ? {
      participants: release.participants, result: source.result,
    } : null;
  }

  _prepareEggBreak(hit, options) {
    const game = this.game, host = game.ecologyServices;
    const egg = hit?.id === BLOCK.TURTLE_EGG &&
      host?.ecology.eggAt(game.world.dimension, hit);
    if (!egg) return super.prepareBreak(hit, options);
    if (!host.active || host.world !== game.world || host.wildlife !== game.wildlife ||
        host.gameplay !== game.gameplay) return null;
    const source = super.prepareBreak(hit, options);
    if (!source?.participants ||
        source.participants.filter((part) => part.owner === game.world).length !== 1)
      return null;
    const world = game.world;
    const removal = source.participants.find((part) => part.owner === world);
    const plan = host.prepareBreakEgg({ x: hit.x, y: hit.y, z: hit.z }, {
      participants: source.participants.filter((part) => part.owner !== world),
      // Also retain the base harvest's settlement/mode/linked-structure guard.
      validate: () => game.world === world && game.ecologyServices === host &&
        source.participants[0].validate() === true,
      // Reuse the original World proposal and additionally pin Ecology's egg
      // and support reads. Never prepare a competing second World editor.
      prepareRemoveEggs: ({ changes, reads }) => ({
        ...removal,
        validate: () => removal.validate() === true &&
          [...changes, ...reads].every(({ x, y, z, before }) =>
            cellsEqual(world.getCell(x, y, z), before)),
      }),
    });
    return plan ? {
      participants: plan.participants,
      result: { ...source.result, ...plan.result, dropsCommitted: true, experienceCommitted: true },
    } : null;
  }
}
