import { GameMobActions } from "./game-mob-actions.js";
import { ingredientMobLoot, isIngredientMob } from "./ingredient-mob-loot.js";
import { TransactionInvariantError } from "./transactions.js";
import { residentDamage } from "./wildlife-resident-edit.js";

const refuse = (reason) => ({ ok: false, hit: false, killed: false, damage: 0, handled: true, reason });

/**
 * Separate from Horse/Ecology ownership. Reuses physical targeting, real melee
 * payment and post-commit presentation, not their resident/resource borrowers.
 */
export class GameIngredientMobActions extends GameMobActions {
  owns(mob) { return isIngredientMob(mob); }
  interact() { return null; }

  prepareHit(mob, amount, {
    participants = [], melee = false, reach, validate: extra = () => true,
  } = {}) {
    // Direct-player attribution is a receipt-bearing input path, not an
    // arbitrary Game.hitMob call after separately paying an irreversible cost.
    if (!Array.isArray(participants) ||
      !participants.some((part) => part?.owner === this.game.gameplay))
      return refuse("prepared-player-cost-required");
    const target = this.capture(mob, { melee, reach });
    if (!target || typeof extra !== "function") return refuse("invalid-player-hit");
    return this._prepare(mob, amount, this.game.player.forward, {
      directPlayer: true, participants, validate: () => target() && extra() === true,
    });
  }

  /** Wildlife.damage never infers player credit from retaliation or proximity. */
  environment(mob, amount, direction, retaliate = true) {
    const plan = this._prepare(mob, amount, direction, {
      directPlayer: false, retaliate,
    });
    if (!plan?.participants) return plan;
    // Do not end player spawn protection or apply direct-player hit presentation.
    const committed = this.game.gameplay.coordinator.commit(plan.participants);
    for (const error of committed.observerErrors ?? [])
      if (error instanceof TransactionInvariantError) throw error;
    return committed.ok ? { ...plan.result, ...committed } : { ...refuse(committed.reason), ...committed };
  }

  _prepare(mob, amount, direction, {
    directPlayer, retaliate = true, participants = [], validate = () => true,
  }) {
    const game = this.game;
    const { wildlife, world, gameplay, overflow, pickups, inventoryActions, experienceOrbs, mobIntegration } = game;
    if (!this.owns(mob) || !Number.isFinite(amount) || amount <= 0 ||
      typeof directPlayer !== "boolean" ||
      typeof retaliate !== "boolean" || !Array.isArray(participants) ||
      wildlife?.byId.get(mob.id) !== mob || mob.dead || mob.dormant ||
      !mobIntegration?._current() || world !== wildlife.world ||
      !inventoryActions || overflow?.coordinator !== gameplay.coordinator)
      return refuse("ingredient-owner-unavailable");
    const mode = gameplay.mode, rng = wildlife.randomState;
    const current = () => game.wildlife === wildlife && game.world === world &&
      game.gameplay === gameplay && game.overflow === overflow && game.pickups === pickups &&
      game.inventoryActions === inventoryActions && game.experienceOrbs === experienceOrbs &&
      game.mobIntegration === mobIntegration && mobIntegration._current() &&
      gameplay.mode === mode && wildlife.randomState === rng && validate() === true;
    const damage = Math.min(1000, amount, mob.health), killed = damage === mob.health;
    const quote = killed ? ingredientMobLoot(world, mob, directPlayer) : null;
    if (killed && !quote) return refuse("ingredient-quote-refused");
    const parts = [...participants];
    if (quote) {
      const loot = inventoryActions.prepareDropItems(quote.drops, mob.position);
      if (!loot) return refuse("ingredient-loot-refused");
      parts.push(loot);
      if (quote.experience && mode === "survival") {
        if (experienceOrbs?.coordinator !== gameplay.coordinator) return refuse("ingredient-xp-unavailable");
        const xp = experienceOrbs.prepareSpawn(quote.experience, mob.position, { pickupDelay: 0.2 });
        if (!xp) return refuse("ingredient-xp-refused");
        parts.push(xp);
      }
    }
    const base = wildlife._prepareResidentEdit("ingredient", {
      ...(killed ? { remove: mob } : {
        damage: residentDamage(wildlife.player, mob, damage, direction, retaliate, true),
      }),
      validate: current,
    });
    if (!base) return refuse("ingredient-victim-refused");
    return {
      participants: [...parts, base],
      result: { ok: true, handled: true, hit: true, killed, damage, entity: mob,
        drops: quote?.drops ?? [], provenance: directPlayer ? "direct-player" : "environment",
        handCostCommitted: participants.some((part) => part.owner === gameplay) },
    };
  }
}
