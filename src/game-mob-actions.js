import { captureEntityContext } from "./entity-context.js";
import { ECOLOGY_SPECIES } from "./expansion-ecology.js";
import { MINING_TOOLS } from "./gameplay-harvest.js";
import { wearDraftHand, withBrokenToolNotice } from "./gameplay-hand-actions.js";
import { horseFood, isHorseSaddle } from "./horse-definitions.js";
import { raycastMelee } from "./melee-targeting.js";
import { TransactionInvariantError } from "./transactions.js";
import { raycast } from "./world.js";

export { GameMobHarvestActions } from "./game-mob-harvest-actions.js";

const refuse = (reason) => ({ ok: false, handled: true, reason });
const point = ({ x, y, z }) => ({ x, y, z });
const samePoint = (a, b) => a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
const finite = (at) => at && [at.x, at.y, at.z].every(Number.isFinite);
const eyeFor = (game) => {
  const pose = game.vehicleServices?.poseForArchive();
  return pose ? { ...pose.position, y: pose.position.y + game.player.eyeHeight }
    : game.player.eyePosition;
};

/**
 * Game's entity dispatch. Horse/Ecology preparations own damage, death and all
 * rewards. A refusal NEVER invokes legacy Wildlife mutation or a second debit.
 * Friendly-fire attribution/status combat beyond these receipts stays with the
 * parent combat adapter; this boundary uses the current local-player attack.
 */
export class GameMobActions {
  constructor(game) { this.game = game; }

  owns(mob) {
    return mob?.kind === "horse" || Object.hasOwn(ECOLOGY_SPECIES, mob?.kind ?? "");
  }

  capture(mob, { melee = false, reach } = {}) {
    const game = this.game, { world, wildlife, player, gameplay } = game;
    if (!game.active || !world || !wildlife || !player || gameplay.dead ||
        game.paused || game.building || game.failed || game.overlayOpen ||
        game.closingScreens || player.world !== world || wildlife.world !== world ||
        wildlife.dimension !== world.dimension || wildlife.disposed ||
        wildlife.byId.get(mob?.id) !== mob || mob.dead || mob.dormant)
      return null;
    const limit = reach ?? (gameplay.mode === "creative" ? 5 : 3);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 32) return null;
    const eye = eyeFor(game), direction = player.forward;
    if (!finite(eye) || !finite(direction)) return null;
    const at = point(eye), forward = point(direction), poseRevision = player.poseRevision;
    const current = captureEntityContext(world, gameplay.context);
    const pick = () => {
      const block = raycast(world, at, forward, limit);
      const precise = wildlife.raycast(at, forward, limit);
      const hit = melee ? raycastMelee(wildlife, world, at, forward, limit, {
        blockHit: block, preciseHit: precise,
      }) : precise && (!block || precise.distance < block.distance) ? precise : null;
      return hit?.entity === mob;
    };
    const validate = () => game.active === true && !game.paused && !game.building &&
      !game.failed && !game.closingScreens && !game.overlayOpen && !gameplay.dead &&
      game.world === world && game.wildlife === wildlife && game.player === player &&
      game.gameplay === gameplay && player.world === world && !wildlife.disposed &&
      wildlife.dimension === world.dimension && current() &&
      wildlife.byId.get(mob.id) === mob && !mob.dead && !mob.dormant &&
      player.poseRevision === poseRevision && samePoint(eyeFor(game), at) &&
      samePoint(player.forward, forward) && pick();
    return validate() ? validate : null;
  }

  /** null means an unowned legacy actor; every owned refusal remains handled. */
  interact(mob, { held = false } = {}) {
    if (!this.owns(mob)) return null;
    const game = this.game;
    const validate = this.capture(mob);
    if (!validate) return refuse("stale-entity-target");
    if (mob.kind === "horse") {
      const service = game.vehicleServices;
      if (!service?.active || service.horses.wildlife !== game.wildlife)
        return refuse("horse-owner-unavailable");
      const inventory = game.player.sneaking === true || game.player.crouching === true;
      for (const hand of ["main", "offhand"]) {
        const stack = game.gameplay.getHandStack(hand);
        if (inventory || horseFood(stack?.id) || isHorseSaddle(stack))
          return service.interactHorse(mob.id, { hand, held, inventory, validate });
      }
      // A real offhand food/saddle use precedes an otherwise empty main-hand
      // mount, just as entity use precedes eating that same food in Game.
      for (const hand of ["main", "offhand"])
        if (game.gameplay.getHandStack(hand) === null)
          return service.interactHorse(mob.id, { hand, held, inventory, validate });
      return refuse("empty-hand-food-or-saddle-required");
    }
    const host = game.ecologyServices;
    if (!host?.active || host.wildlife !== game.wildlife ||
        host.gameplay !== game.gameplay)
      return refuse("ecology-owner-unavailable");
    if (mob.kind === "villager") {
      const result = validate() && game.progressionIntegration?.openTrader(mob.id);
      return result ? { ...result, handled: true } : refuse("villager-unavailable");
    }
    for (const hand of ["main", "offhand"]) {
      const plan = host.prepareInteraction(mob.id, { hand, validate });
      if (plan) return this.commit(plan);
    }
    return refuse("ecology-interaction-unavailable");
  }

  prepareHit(mob, amount, {
    participants = [], melee = false, reach, validate: extra = () => true,
  } = {}) {
    if (!this.owns(mob)) return null;
    const game = this.game, target = this.capture(mob, { melee, reach });
    if (!target || !Number.isFinite(amount) || amount <= 0 ||
        typeof extra !== "function" || !Array.isArray(participants))
      return refuse("invalid-owned-hit");
    const validate = () => target() && extra() === true;
    const options = { playerKill: true, participants, validate };
    let plan;
    if (mob.kind === "horse") {
      const vehicles = game.vehicleServices;
      if (!vehicles?.active || vehicles.horses.wildlife !== game.wildlife)
        return refuse("horse-owner-unavailable");
      const horse = vehicles.prepareHorseHit(mob.id, amount, game.player.forward, options);
      if (!horse?.ok) return horse ?? refuse("horse-hit-refused");
      const { participants: peers, ...result } = horse;
      plan = { participants: peers, result };
    } else {
      const host = game.ecologyServices;
      if (!host?.active || host.wildlife !== game.wildlife)
        return refuse("ecology-owner-unavailable");
      plan = host.prepareHit(mob.id, amount, game.player.forward, options);
    }
    return plan?.participants ? {
      ...plan,
      result: { ...plan.result, ok: true, handled: true, kind: mob.kind,
        handCostCommitted: participants.some((part) => part.owner === game.gameplay) },
    } : refuse("owned-hit-refused");
  }

  prepareMelee(mob) {
    const { gameplay } = this.game;
    const stack = gameplay.getHandStack("main"), item = gameplay.selectedItem;
    const amount = item?.tool === "bow" ? 1 : gameplay.attackDamage();
    const selected = gameplay.selected;
    let broken = false;
    // One actual Gameplay state edit pays tool wear and exhaustion together.
    // A bow melee hit retains the existing no-arrow, one-damage behavior.
    const cost = gameplay._prepareState((state) => {
      if (gameplay.mode === "creative" || item?.tool === "bow") return true;
      if (MINING_TOOLS.has(item?.tool))
        broken = wearDraftHand(state.owned, "main", selected, item.tool === "sword" ? 1 : 2);
      state.exhaustion += 0.1;
      while (state.exhaustion >= 4) {
        state.exhaustion -= 4;
        if (state.saturation > 0) state.saturation = Math.max(0, state.saturation - 1);
        else state.hunger = Math.max(0, state.hunger - 1);
      }
      return true;
    }, { notify: false, selfUseHands: ["main"] });
    return cost ? this.prepareHit(mob, amount, {
      melee: true, participants: [withBrokenToolNotice(cost, gameplay, stack, broken)],
    }) : refuse("attack-cost-refused");
  }

  commit(plan) {
    if (!plan?.participants?.length) return plan ?? refuse("invalid-owned-action");
    const game = this.game;
    const committed = game.gameplay.coordinator.commit(plan.participants);
    for (const error of committed.observerErrors ?? [])
      if (error instanceof TransactionInvariantError) throw error;
    if (!committed.ok) return { ...committed, handled: true };
    const result = { ...plan.result, ...committed, handled: true };
    const observe = (work) => {
      try { work(); } catch (error) {
        if (error instanceof TransactionInvariantError) throw error;
        result.observerErrors.push(error);
      }
    };
    if (result.hit) observe(() => game.wildlife.endSpawnProtection?.());
    observe(() => game.applyVehiclePose?.());
    observe(() => game.scheduleSave?.());
    observe(() => game.refreshHud?.());
    return result;
  }

  melee(mob) { return this.commit(this.prepareMelee(mob)); }
  hit(mob, amount, options) { return this.commit(this.prepareHit(mob, amount, options)); }
}
