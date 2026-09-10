import { prepareStatusApplication } from "./status-effect-actions.js";
import { projectStatusHealth } from "./status-effects.js";
import { TransactionInvariantError } from "./transactions.js";
import { ITEM } from "./items.js";
import { GameIngredientMobActions } from "./game-ingredient-mob-actions.js";
import { MAX_MOBS, MOB_SPECIES } from "./mob-species.js";

const point = ({ x, y, z }) => ({ x, y, z });
const undead = new Set(["zombie", "skeleton", "husk", "stray", "drowned"]);
const poisonImmune = new Set(["spider"]);

export const MOB_POTION_POLICIES = Object.freeze(Object.fromEntries(
  Object.keys(MOB_SPECIES).map((kind) => [kind, Object.freeze({
    undead: undead.has(kind),
    ignoresPoisonAndRegeneration: undead.has(kind),
    poisonImmune: poisonImmune.has(kind),
    effectImmune: false,
  })])
));

export function mobPotionPolicy(kind) {
  return MOB_POTION_POLICIES[kind] ?? null;
}

function samePoint(a, b) {
  return a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
}

function legacyReward(mob, state) {
  const drops = mob.kind === "sulfur_cube" && mob.absorbedBlock !== null
    ? [{ id: mob.absorbedBlock, count: 1 }]
    : [];
  const random = () => {
    state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
    return state.value / 4294967296;
  };
  for (const entry of mob.spec.drops) {
    if (!Number.isInteger(entry.id) || random() > entry.chance) continue;
    drops.push({
      id: entry.id,
      count: entry.min + Math.floor(random() * (entry.max - entry.min + 1)),
    });
  }
  let xpHash = 2166136261;
  for (const char of `${mob.id}:${mob.life}`)
    xpHash = Math.imul(xpHash ^ char.charCodeAt(0), 16777619);
  const experience = mob.kind === "slime" ? 1
    : ["hostile", "watchful"].includes(mob.spec.temperament) ? 5
      : 1 + ((xpHash >>> 0) % 3);
  return { drops, experience };
}

export class GameMobPotionImpact {
  constructor(game) {
    this.game = game;
    this.observerErrors = [];
  }

  readTargets() {
    const game = this.game, { wildlife, world, player, gameplay } = game;
    if (!game.active || !wildlife || wildlife.disposed || gameplay.dead ||
      wildlife.world !== world || wildlife.dimension !== world.dimension)
      return [];
    const active = wildlife.entities;
    const mapped = [...wildlife.byId.values()]
      .filter((mob) => !mob.dead && !mob.dormant);
    if (!Array.isArray(active) || active.length > MAX_MOBS ||
      new Set(active).size !== active.length ||
      new Set(active.map((mob) => mob?.id)).size !== active.length ||
      mapped.length !== active.length ||
      active.some((mob) => !mob || mob.dead || mob.dormant ||
        wildlife.byId.get(mob.id) !== mob || !mapped.includes(mob)))
      return null;
    const targets = [{
      id: `player:${game.progressionIntegration.pearls.ownerId}`,
      ref: player,
      dimension: world.dimension,
      position: point(player.position),
      radius: 0.3,
      height: player.height,
      available: true,
      poseRevision: player.poseRevision,
      target: {},
      ownerType: "player",
    }];
    const mobs = [...active].sort((a, b) => a.id.localeCompare(b.id));
    for (const mob of mobs) targets.push({
      id: `mob:${mob.id}:${mob.life}`,
      ref: mob,
      dimension: world.dimension,
      position: point(mob.position),
      radius: mob.spec.radius,
      height: mob.spec.height,
      available: true,
      poseRevision: mob.poseRevision ?? 0,
      target: mobPotionPolicy(mob.kind),
      ownerType: "mob",
      entityId: mob.id,
      life: mob.life,
    });
    return targets.length <= MAX_MOBS + 1 ? targets : null;
  }

  prepareImpact({ potion, impacts, validate }) {
    const game = this.game, { wildlife, gameplay, mobStatusEffects } = game;
    game.ingredientMobActions ??= new GameIngredientMobActions(game);
    if (!Array.isArray(impacts) || impacts.length > MAX_MOBS + 1 ||
      typeof validate !== "function" || !mobStatusEffects ||
      wildlife?.disposed || gameplay?.dead)
      return null;
    if (impacts.some((impact) => !impact?.target ||
      typeof impact.target.id !== "string") ||
      new Set(impacts.map(({ target }) => target.id)).size !== impacts.length)
      return null;
    const ordered = [...impacts].sort((a, b) => a.target.id.localeCompare(b.target.id));
    const playerImpacts = ordered.filter(({ target }) => target.ownerType === "player");
    const mobImpacts = ordered.filter(({ target }) => target.ownerType === "mob");
    if (playerImpacts.length > 1 ||
      playerImpacts.length + mobImpacts.length !== ordered.length)
      return null;
    const current = () => game.active && game.wildlife === wildlife &&
      game.gameplay === gameplay && game.mobStatusEffects === mobStatusEffects &&
      validate() === true;
    const targetGuards = mobImpacts.map(({ target }) => {
      const mob = wildlife.byId.get(target.entityId), at = mob && point(mob.position);
      return () => current() && mob && wildlife.byId.get(target.entityId) === mob &&
        !mob.dead && !mob.dormant && mob.life === target.life &&
        samePoint(mob.position, at);
    });
    if (targetGuards.some((guard) => !guard())) return null;

    const playerPlan = playerImpacts[0] && prepareStatusApplication(
      gameplay,
      game.progressionIntegration.services.effects,
      potion,
      {
        splash: playerImpacts[0].splash,
        target: playerImpacts[0].target.target,
        notify: false,
      }
    );
    if (playerImpacts[0] && !playerPlan) return null;

    const applications = mobImpacts.map(({ target, splash }) => ({
      dimension: target.dimension,
      entityId: target.entityId,
      life: target.life,
      potion,
      splash,
      target: target.target,
    }));
    const preview = mobStatusEffects.prepareApplications(applications, { validate: current });
    if (!preview || preview.outcomes.length !== applications.length ||
      preview.outcomes.some((outcome, index) => outcome.target !== applications[index]))
      return null;
    const projected = preview.outcomes.map((outcome, index) => {
      const mob = wildlife.byId.get(outcome.target.entityId);
      const health = projectStatusHealth({
        health: mob.health,
        dead: false,
        deathCause: null,
      }, outcome.gameplayPlan, {
        maximum: mob.spec.health,
        target: outcome.target.target,
      });
      return { mob, health, outcome, guard: targetGuards[index] };
    });
    const retired = projected.filter(({ health }) => health.dead)
      .map(({ outcome }) => outcome.target);
    const status = mobStatusEffects.prepareApplications(applications, {
      validate: current,
      retire: retired,
    });
    if (!status) return null;

    const changed = projected.filter(({ mob, health }) => health.health !== mob.health);
    const batch = changed.length ? wildlife.beginPotionResidentEditBatch() : null;
    if (changed.length && !batch) return null;
    const contributions = [], peers = [], rewards = [];
    for (const entry of changed) {
      const { mob, health, guard } = entry;
      const contribution = this._contributeHealth(batch, mob, health, guard);
      if (!contribution || contribution.ok === false) return null;
      contributions.push(contribution);
      peers.push(...contribution.peers);
      const result = contribution.result;
      if (health.dead) rewards.push({
        mob,
        drops: result?.drops ?? result?.reward?.drops ?? [],
        experience: result?.experience ?? result?.reward?.experience ?? 0,
        generic: !mob.spec.ecology && mob.kind !== "horse" &&
          !game.ingredientMobActions.owns(mob),
      });
    }

    const rng = { value: wildlife.randomState };
    for (const reward of rewards) {
      if (reward.generic)
        Object.assign(reward, legacyReward(reward.mob, rng));
    }
    const rewardDropGroups = rewards.flatMap(({ mob, drops }) => drops.length ? [{
      drops: drops.map((drop) => ({
        id: drop.id ?? ITEM[drop.name],
        count: drop.count,
        ...(drop.durability === undefined ? {} : { durability: drop.durability }),
        ...(drop.data === undefined ? {} : { data: drop.data }),
      })),
      position: point(mob.position),
      options: {
        pickupDelay: 0.4,
        velocity: { x: 0, y: 1.5, z: 0 },
      },
    }] : []);
    if (rewardDropGroups.length) {
      const drop = game.inventoryActions?.prepareDropItemGroups(rewardDropGroups);
      if (!drop) return null;
      peers.push(drop);
    }
    const experience = rewards.flatMap(({ mob, experience: amount }) => amount ? [{
      amount,
      position: point(mob.position),
      options: { pickupDelay: 0.4 },
    }] : []);
    if (experience.length) {
      const xp = game.experienceOrbs.prepareSpawnBatch(experience);
      if (!xp) return null;
      peers.push(xp);
    }
    if (batch && status.participant) peers.push(status.participant);
    const finalized = batch && wildlife.finalizeResidentEditBatch(batch, {
      contributions,
      participants: peers,
      randomState: rng.value,
    });
    if (batch && !finalized) return null;
    const participants = [
      ...(playerPlan?.participants ?? []),
      ...(!batch && status.participant ? [status.participant] : []),
      ...(finalized?.participants ?? []),
    ];
    if (new Set(participants.map((part) => part.owner)).size !== participants.length)
      return null;
    return {
      participants,
      result: {
        ok: true,
        affected: ordered.length,
        mobs: projected.map(({ mob, health }) => ({
          id: mob.id,
          health: health.health,
          killed: health.dead,
        })),
      },
    };
  }

  _contributeHealth(batch, mob, health, validate) {
    const game = this.game;
    if (health.dead && mob.kind === "horse")
      return game.vehicleServices.horses.contributeHit(
        batch, mob.id, mob.health, { x: 0, y: 0, z: 0 }, {
          playerCredit: true,
          deferRewards: true,
          retaliate: false,
          validate,
        }
      );
    if (health.dead && mob.spec.ecology)
      return game.ecologyServices.contributeHit(
        batch, mob.id, mob.health, { x: 0, y: 0, z: 0 }, {
          playerCredit: true,
          deferRewards: true,
          retaliate: false,
          validate,
        }
      );
    if (health.dead && game.ingredientMobActions.owns(mob))
      return game.ingredientMobActions.contributePotionDeath(batch, mob, { validate });
    if (health.dead)
      return game.wildlife.contributePotionHealth(batch, mob, health.health, { validate });
    if (mob.kind === "horse")
      return game.vehicleServices.horses.contributePotionHealth(
        batch, mob.id, health.health, { validate });
    if (mob.spec.ecology)
      return game.ecologyServices.contributePotionHealth(
        batch, mob.id, health.health, { validate });
    if (game.ingredientMobActions.owns(mob))
      return game.ingredientMobActions.contributePotionHealth(
        batch, mob, health.health, { validate });
    return game.wildlife.contributePotionHealth(batch, mob, health.health, { validate });
  }

  frame(dt, { simulating = this.game.simulating === true } = {}) {
    const game = this.game, { wildlife, mobStatusEffects } = game;
    if (!simulating || !game.active || game.paused || game.building ||
      game.failed || game.gameplay.dead || !Number.isFinite(dt) || dt <= 0)
      return { ok: true, advanced: false };
    const descriptors = this.readTargets();
    if (!descriptors) return { ok: false };
    const targets = descriptors.filter((target) => target.ownerType === "mob");
    const revision = wildlife._ecologyRevision;
    const current = () => game.active && game.wildlife === wildlife &&
      game.mobStatusEffects === mobStatusEffects &&
      wildlife._ecologyRevision === revision;
    const advance = mobStatusEffects.prepareAdvance(targets, Math.min(dt, 0.25), {
      validate: current,
    });
    if (!advance) return { ok: false };
    const changed = advance.outcomes.flatMap((outcome) => {
      const mob = wildlife.byId.get(outcome.target.entityId);
      if (!mob || mob.life !== outcome.target.life || mob.dead || mob.dormant)
        return [];
      const health = projectStatusHealth({
        health: mob.health,
        dead: false,
        deathCause: null,
      }, outcome.gameplayPlan, {
        maximum: mob.spec.health,
        target: outcome.target.target,
      });
      return health.health === mob.health ? [] : [{ mob, health }];
    });
    const batch = changed.length ? wildlife.beginPotionResidentEditBatch() : null;
    const contributions = [];
    if (changed.length && !batch) return { ok: false };
    for (const { mob, health } of changed) {
      const contribution = this._contributeHealth(batch, mob, health, current);
      if (!contribution) return { ok: false };
      contributions.push(contribution);
    }
    const finalized = batch && wildlife.finalizeResidentEditBatch(batch, {
      contributions,
    });
    if (batch && !finalized) return { ok: false };
    const participants = [
      ...(advance.participant ? [advance.participant] : []),
      ...(finalized?.participants ?? []),
    ];
    if (!participants.length) return { ok: true, advanced: false };
    const committed = game.coordinator.commit(participants);
    if (committed.ok) game.scheduleSave?.();
    return { ...committed, advanced: committed.ok };
  }

  commit(plan) {
    if (!plan?.participants) return { ok: false };
    const result = this.game.coordinator.commit(plan.participants);
    this.observerErrors = result.observerErrors ?? [];
    for (const error of this.observerErrors)
      if (error instanceof TransactionInvariantError) throw error;
    if (result.ok) {
      this.game.applyVehiclePose?.();
      this.game.scheduleSave?.();
      this.game.refreshHud?.();
    }
    return result.ok ? { ...plan.result, ...result } : result;
  }
}
