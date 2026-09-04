import {
  activeEnchantmentLevel, bowDamage, durabilityLoss, durabilityUseChance, meleeDamage, miningSpeed,
  planMendingExperience, reduceEnchantedDamage, respirationAirLoss, waterMovement,
} from "./enchantment-effects.js";
import { boundedDurabilityWear } from "./bounded-durability-wear.js";
import { reduceArmorDamage } from "./gear.js";
import { EQUIPMENT_SLOTS, ownedSlot } from "./inventory-domain.js";
import { getItem } from "./items.js";
import { progressionPlan } from "./progression-station-interactions.js";
import { finite, synchronous } from "./enchantment-domain.js";

const armorBypass = new Set(["fall", "pearl", "drowning", "starvation", "void", "magic", "kill"]);
const fire = new Set(["fire", "in_fire", "on_fire", "lava", "magma", "hot_floor", "campfire", "fireball"]);
const wearCount = (uses) => {
  if (!Array.isArray(uses) || !uses.length || uses.length > 6 ||
      uses.some((use) => !use || !Number.isInteger(use.amount) || use.amount < 1))
    return null;
  const count = uses.reduce((sum, use) => sum + use.amount, 0);
  return count <= 256 ? count : null;
};

/** Numeric effect hooks take unmodified base values; never apply them twice. */
export class ProgressionGearEffects {
  constructor(gameplay, effects, stations) {
    Object.assign(this, { gameplay, effects, stations });
  }

  movementSpeed(base, options) { return this.effects.modifyMovementSpeed(base, options); }
  attackSpeed(base) {
    finite(base, "base attack speed");
    return base * this.effects.modifiers.attackSpeedMultiplier;
  }
  attackDamage(base, options) { return this.effects.modifyAttackDamage(base, options); }
  miningSpeed(base, tool = this.gameplay.getHandStack(), options = {}) {
    return this.effects.modifyMiningSpeed(miningSpeed(base, tool, {
      helmet: this.gameplay.equipment.head, context: this.gameplay.context, ...options,
    }), { creative: this.gameplay.mode === "creative" });
  }
  // Parent first applies attackDamage to the raw attribute, THEN its charge/
  // critical multiplier. Enchantment damage is added last and never crit-scaled.
  meleeDamage(scaledBase, weapon = this.gameplay.getHandStack(), options = {}) {
    return meleeDamage(scaledBase, weapon, {
      context: this.gameplay.context, ...options,
    });
  }
  bowDamage(base, bow, context = this.gameplay.context) { return bowDamage(base, bow, context); }
  waterMovement(options) {
    return waterMovement(this.gameplay.getEquipmentStack("feet"), {
      context: this.gameplay.context, ...options,
    });
  }
  respirationAirLoss(roll) {
    return respirationAirLoss(this.gameplay.getEquipmentStack("head"), roll, this.gameplay.context);
  }
  breathing(air, dt, options) { return this.effects.advanceBreathing(air, dt, options); }
  visualLight(light) { return this.effects.applyNightVisionLight(light); }
  get lighting() { return this.effects.renderHook; }

  knockback(amount) {
    finite(amount, "base knockback");
    return amount * (1 - this.armorProfile().knockbackResistance);
  }

  armorProfile(equipment = this.gameplay.equipment) {
    return EQUIPMENT_SLOTS.reduce((result, slot) => {
      const item = getItem(equipment[slot]?.id);
      if (item?.equipmentSlot === slot) {
        result.armorPoints += item.armorPoints ?? 0;
        result.toughness += item.toughness ?? 0;
        result.knockbackResistance = Math.min(1,
          result.knockbackResistance + (item.knockbackResistance ?? 0));
      }
      return result;
    }, { armorPoints: 0, toughness: 0, knockbackResistance: 0 });
  }

  /**
   * Replace, do not stack on, Gameplay's old flat armor reduction. Host shields
   * resolve first. Fire immunity is checked BEFORE armor wear. Resistance and
   * EPF then apply after armor/toughness; pearl/fall still receive valid EPF.
   */
  incomingDamage(amount, { kind = "generic", bypassArmor = armorBypass.has(kind),
    bypassEnchantments = false, bypassResistance = false, isFire = fire.has(kind) } = {}) {
    finite(amount, "incoming damage");
    if (this.gameplay.mode === "creative") return { damage: 0, wearArmor: false };
    if (isFire && this.effects.modifiers.fireImmune) return { damage: 0, wearArmor: false };
    const equipment = this.gameplay.equipment;
    const armor = this.armorProfile(equipment);
    const reduced = bypassArmor ? amount : reduceArmorDamage(amount, armor.armorPoints, armor.toughness);
    const resisted = this.effects.modifyIncomingDamage(reduced, {
      kind, isFire, bypassResistance,
    });
    return {
      damage: reduceEnchantedDamage(resisted, equipment, {
        damageType: kind, bypassesEnchantments: bypassEnchantments, context: this.gameplay.context,
      }),
      wearArmor: !bypassArmor && amount > 0,
      armorWear: Math.max(1, Math.floor(amount / 4)),
    };
  }

  /**
   * Replacement for the parent's ordinary damage transaction, after shields
   * and hurt cooldowns. Includes health, Unbreaking-aware armor wear, RNG and
   * lethal effect clearing. Pass source/projectile retirement as peers; never
   * also call Gameplay.damage or compose a second Gameplay participant.
   * Pearl teleport+damage already owns Gameplay: use incomingDamage there.
   */
  prepareDamage(amount, {
    validate, participants = [], cause, ...classification
  } = {}) {
    if (!Number.isFinite(amount) || amount < 0 || !synchronous(validate) ||
        !Array.isArray(participants) || this.gameplay.dead ||
        this.effects.coordinator !== this.gameplay.coordinator) return null;
    cause ??= classification.kind ?? "generic";
    if (typeof cause !== "string" || !cause.length || cause.length > 80) return null;
    const effects = this.effects, revision = effects.revision;
    const coordinator = this.gameplay.coordinator, reservation = coordinator.usage(effects);
    const valid = () => this.effects === effects && effects.coordinator === coordinator &&
      coordinator.usage(effects) === reservation && reservation !== undefined &&
      effects.revision === revision && validate() === true;
    const reduction = this.incomingDamage(amount, classification);
    const damage = Math.min(this.gameplay.health, reduction.damage);
    const dead = damage >= this.gameplay.health;
    const equipment = this.gameplay.equipment;
    const uses = reduction.wearArmor ? EQUIPMENT_SLOTS.flatMap((slot, index) =>
      equipment[slot]?.durability
        ? [{ area: "equipment", index, amount: reduction.armorWear }] : []
    ) : [];
    const editGameplay = (draft) => {
      draft.health -= damage;
      if (damage > 0) draft.timers.regen = 0;
      if (dead) { draft.dead = true; draft.deathCause = cause; }
      return true;
    };
    const draws = uses.length ? wearCount(uses) : 0;
    const counted = draws === null
      ? this._prepareCountWear(uses, { validate: valid, editGameplay }) : null;
    if (draws === null && !counted) return null;
    const random = counted?.random ??
      (draws ? this.stations.prepareRandom(draws, { validate: valid }) : null);
    if (draws && !random) return null;
    const player = counted?.player ?? (draws
      ? this.prepareWearParticipant(uses, random.rolls, { editGameplay })
      : this.gameplay._prepareState(editGameplay));
    const clear = dead ? effects.prepareClear() : null;
    if (!player || (dead && !clear)) return null;
    const guarded = {
      ...player, validate: () => valid() && player.validate(),
      ...(dead ? { notify: () => {
        try { player.notify?.(); }
        finally { this.gameplay.onDeath?.(cause); }
      } } : {}),
    };
    return progressionPlan(coordinator, [
      guarded, ...(random ? [random.participant] : []),
      ...(clear ? [clear] : []), ...participants,
    ], { ok: true, damage, dead, armorWear: uses.length ? reduction.armorWear : 0 });
  }

  /**
   * Use in an owning harvest/combat transaction instead of eager wearHand.
   * One independent Unbreaking roll per point, separate from enchanting seed.
   * selfUseHands preserves an ongoing shield identity after its ordinary wear.
   */
  prepareWear(uses, {
    validate, participants = [], selfUseHands = [], editGameplay,
  } = {}) {
    const total = wearCount(uses);
    if (!synchronous(validate) || total === null || !Array.isArray(participants)) return null;
    const random = this.stations.prepareRandom(total, { validate });
    if (!random) return null;
    const player = this.prepareWearParticipant(uses, random.rolls, { selfUseHands, editGameplay });
    return player ? progressionPlan(this.gameplay.coordinator, [
      { ...player, validate: () => validate() && player.validate() },
      random.participant, ...participants,
    ], { ok: true }) : null;
  }

  /** Hit-only escape from the per-point work budget; ordinary wear stays capped. */
  prepareHitWear(uses, options = {}) {
    if (wearCount(uses) !== null) return this.prepareWear(uses, options);
    const { validate, participants = [] } = options;
    if (!Array.isArray(participants)) return null;
    const wear = this._prepareCountWear(uses, options);
    return wear ? progressionPlan(this.gameplay.coordinator, [
      { ...wear.player, validate: () => validate() && wear.player.validate() },
      ...(wear.random ? [wear.random.participant] : []), ...participants,
    ], { ok: true }) : null;
  }

  /**
   * Only oversized hits use count sampling. At most six distinct affected
   * slots, one saved draw per stochastic slot; no draws for deterministic wear.
   * Sampling/editing happens in one detached Gameplay draft, with RNG as a peer.
   */
  _prepareCountWear(uses, { validate, selfUseHands = [], editGameplay } = {}) {
    if (!synchronous(validate) || !Array.isArray(uses) || !uses.length || uses.length > 6 ||
        uses.some((use) => !use || !Number.isFinite(use.amount) ||
          !Number.isInteger(use.amount) || use.amount < 1) ||
        new Set(uses.map((use) => `${use.area}:${use.index}`)).size !== uses.length ||
        !Array.isArray(selfUseHands) ||
        (editGameplay !== undefined && !synchronous(editGameplay))) return null;
    let random = null;
    const player = this.gameplay._prepareState((draft) => {
      const entries = uses.map((use) => {
        const slot = ownedSlot(draft.owned, use.area, use.index), stack = slot?.get();
        if (!stack?.durability) return null;
        return { use, slot, stack, chance: durabilityUseChance(stack, this.gameplay.context) };
      });
      if (entries.some((entry) => !entry)) return false;
      const creative = this.gameplay.mode === "creative";
      const draws = creative ? 0 : entries.filter((entry) => entry.chance < 1).length;
      random = draws ? this.stations.prepareRandom(draws, { validate }) : null;
      if (draws && !random) return false;
      let offset = 0;
      for (const { use, slot, stack, chance } of entries) {
        const loss = creative ? 0 : boundedDurabilityWear(
          use.amount, chance, stack.durability, chance < 1 ? random.rolls[offset++] : 0
        );
        if (loss) slot.set(stack.durability <= loss ? null :
          { ...stack, durability: stack.durability - loss });
      }
      return editGameplay === undefined || editGameplay(draft) === true;
    }, { selfUseHands });
    return player ? { player, random } : null;
  }

  /**
   * Gameplay-only half for station harvesting. Pass the rolls from
   * prepareStationRemoval({randomDraws, prepareGameplay}), which owns the
   * combined removal/RNG participant. Never commit this half by itself.
   */
  prepareWearParticipant(uses, rolls, { selfUseHands = [], editGameplay } = {}) {
    const total = wearCount(uses);
    if (total === null || !Array.isArray(rolls) || rolls.length !== total ||
        !Array.isArray(selfUseHands) ||
        (editGameplay !== undefined && !synchronous(editGameplay))) return null;
    const player = this.gameplay._prepareState((draft) => {
      const { owned } = draft;
      let offset = 0;
      for (const use of uses) {
        const slot = ownedSlot(owned, use.area, use.index), stack = slot?.get();
        if (!stack?.durability) return false;
        const loss = this.gameplay.mode === "creative" ? 0 :
          durabilityLoss(stack, rolls.slice(offset, offset + use.amount), this.gameplay.context);
        offset += use.amount;
        if (loss) slot.set(stack.durability <= loss ? null :
          { ...stack, durability: stack.durability - loss });
      }
      // Optional parent vitals/attack edit shares this ONE Gameplay participant.
      // Never compose this plan with a second Gameplay-owned damage participant.
      return editGameplay === undefined || editGameplay(draft) === true;
    }, { selfUseHands });
    return player;
  }

  /** Orb/source ownership is supplied as a peer; never also award its full XP. */
  prepareMending(experience, { validate, participants = [] } = {}) {
    if (!synchronous(validate)) return null;
    const random = this.stations.prepareRandom(6, { validate });
    if (!random) return null;
    let result;
    const player = this.gameplay.prepareInventory((owned) => {
      const selected = this.gameplay.selected;
      result = planMendingExperience({
        main: owned.slots[selected], offhand: owned.offhand, ...owned.equipment,
      }, experience, random.rolls, this.gameplay.context);
      owned.slots[selected] = result.equipment.main;
      owned.offhand = result.equipment.offhand;
      for (const slot of EQUIPMENT_SLOTS) owned.equipment[slot] = result.equipment[slot];
      owned.experienceTotal += result.experienceRemaining;
      return true;
    });
    return player ? progressionPlan(this.gameplay.coordinator, [
      { ...player, validate: () => validate() && player.validate() },
      random.participant, ...participants,
    ], { ok: true, ...result, experienceCommitted: true }) : null;
  }

  enchantmentLevel(stack, name) {
    return activeEnchantmentLevel(stack, name, this.gameplay.context);
  }
}
